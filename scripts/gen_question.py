#!/usr/bin/env python3
# SOFTM-GEN 시작: pdf 문제 파일과 정답 파일 매핑으로 question manifest 생성 - 2026-05-29
import argparse
import re
import subprocess
from pathlib import Path

from pdf_manifest_lib import (
    JSON_ROOT,
    PDF_ROOT,
    ROOT,
    build_category_rows,
    extract_exam_type,
    extract_year_semester,
    find_answer_file,
    is_question_file,
    manifest_path,
    nfc,
    read_json,
    strip_quiz_prefix,
    write_json,
)


# SOFTM-KNOU 시작: 방통대처럼 PDF 문항 번호가 1이 아닌 회차의 인쇄 번호 범위 추론 - 2026-05-29
def infer_question_range(file_path):
    if file_path.suffix.lower() != ".pdf":
        return "", ""
    try:
        text = subprocess.check_output(["pdftotext", "-layout", str(file_path), "-"], text=True, timeout=8)
    except Exception:
        return "", ""
    match = re.search(r"(\d{1,3})\s*[～~\-]\s*(\d{1,3})\s*번", text)
    if not match:
        return "", ""
    start_no = int(match.group(1))
    end_no = int(match.group(2))
    if start_no < 1 or end_no < start_no:
        return "", ""
    return start_no, end_no
# SOFTM-KNOU 끝


def existing_correct_index():
    index = {}
    for correct_path in PDF_ROOT.rglob("correct.json"):
        payload = read_json(correct_path, {})
        items = payload.get("items") if isinstance(payload, dict) else []
        for item in items or []:
            key = strip_quiz_prefix(item.get("questionPdf"))
            if key:
                index[key] = manifest_path(correct_path)
    return index


def resolve_category_path(value):
    raw = strip_quiz_prefix(value)
    if not raw:
        return None
    path = (ROOT / raw).resolve()
    try:
        path.relative_to(PDF_ROOT.resolve())
    except ValueError as exc:
        raise SystemExit("[ERR] --category-path must point under pdf/") from exc
    return path


def is_same_or_inside(path, base):
    try:
        Path(path).resolve().relative_to(Path(base).resolve())
        return True
    except ValueError:
        return False


def existing_dir_to_cat(categories):
    rows = {}
    for row in categories:
        rel = strip_quiz_prefix(row.get("catPath"))
        if not rel:
            continue
        directory = (ROOT / rel).resolve()
        if directory.exists() and directory.is_dir():
            rows[directory] = row.get("catNo", "")
    return rows


def next_question_no(existing_questions):
    numbers = []
    for row in existing_questions or []:
        try:
            numbers.append(int(row.get("questionNo") or 0))
        except Exception:
            continue
    return max(numbers or [0]) + 1


def merge_partial_questions(existing_questions, new_rows, target_cat_nos):
    target_cat_nos = {str(value) for value in target_cat_nos if str(value)}
    remaining = [row for row in existing_questions if str(row.get("catNo", "")) not in target_cat_nos]
    merged = remaining + new_rows

    def sort_key(row):
        try:
            return int(row.get("questionNo") or 0)
        except Exception:
            return 999999

    return sorted(merged, key=sort_key)
# SOFTM-GEN: 선택 카테고리만 question manifest를 갱신할 수 있도록 경로/병합 유틸 추가 - 2026-05-30


def scan_questions(categories, dir_to_cat, existing_questions=None):
    cat_by_no = {row["catNo"]: row for row in categories}
    correct_index = existing_correct_index()
    existing_by_pdf = {
        strip_quiz_prefix(row.get("questionPdf")): row
        for row in (existing_questions or [])
        if strip_quiz_prefix(row.get("questionPdf"))
    }
    next_no = next_question_no(existing_questions or [])
    rows = []
    per_dir = {directory: [] for directory in dir_to_cat}
    per_cat_seq = {}

    for directory in sorted(dir_to_cat, key=lambda path: [nfc(part) for part in path.relative_to(PDF_ROOT).parts]):
        cat_no = dir_to_cat[directory]
        cat = cat_by_no[cat_no]
        if not directory.exists():
            continue
        files = sorted([item for item in directory.iterdir() if item.is_file() and is_question_file(item)], key=lambda path: nfc(path.name))
        for file_path in files:
            year, semester = extract_year_semester(file_path.name)
            exam_type = extract_exam_type(file_path.name)
            answer_path = find_answer_file(file_path)
            question_start_no, question_end_no = infer_question_range(file_path)
            per_cat_seq[cat_no] = per_cat_seq.get(cat_no, 0) + 1
            question_manifest_path = manifest_path(file_path)
            existing = existing_by_pdf.get(strip_quiz_prefix(question_manifest_path), {})
            if existing.get("questionNo"):
                question_no = existing.get("questionNo")
            else:
                question_no = f"{next_no:04d}"
                next_no += 1
            correct_json = correct_index.get(strip_quiz_prefix(question_manifest_path), "")
            row = {
                "gNo": cat.get("gNo", ""),
                "gNm": cat.get("gNm", ""),
                "catNm": cat.get("catNm", ""),
                "catNo": cat_no,
                "parentCatNo": cat.get("parentCatNo", ""),
                "questionNm": nfc(file_path.stem),
                "questionNo": question_no,
                "questionPdf": question_manifest_path,
                "answerPdf": manifest_path(answer_path) if answer_path else "",
                "correctJson": correct_json,
                "published": True,
                "year": year,
                "semester": semester,
                "examType": exam_type,
                "seq": per_cat_seq[cat_no],
            }
            if question_start_no and question_end_no:
                row["questionStartNo"] = question_start_no
                row["questionEndNo"] = question_end_no
                row["questionCount"] = question_end_no - question_start_no + 1
            rows.append(row)
            per_dir[directory].append(row)
    return rows, per_dir


def main():
    parser = argparse.ArgumentParser(description="pdf 문제 파일 기준 question.json을 생성합니다.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--category-path", default="", help="기존 category.json의 특정 pdf 카테고리 경로만 갱신")
    args = parser.parse_args()

    existing_questions = read_json(JSON_ROOT / "question.json", [])
    if args.category_path:
        categories = read_json(JSON_ROOT / "category.json", [])
        if not isinstance(categories, list):
            raise SystemExit("[ERR] json/category.json must be an array")
        target_path = resolve_category_path(args.category_path)
        dir_to_cat = {
            directory: cat_no
            for directory, cat_no in existing_dir_to_cat(categories).items()
            if is_same_or_inside(directory, target_path)
        }
        if not dir_to_cat:
            raise SystemExit("[ERR] category path not found in json/category.json. 새 카테고리는 전체 JSON 재생성을 먼저 실행하세요.")
        rows, per_dir = scan_questions(categories, dir_to_cat, existing_questions)
        merged_rows = merge_partial_questions(existing_questions, rows, set(dir_to_cat.values()))
        write_json(JSON_ROOT / "question.json", merged_rows, args.dry_run)
    else:
        _groups, categories, dir_to_cat = build_category_rows()
        rows, per_dir = scan_questions(categories, dir_to_cat)
        write_json(JSON_ROOT / "question.json", rows, args.dry_run)
    for directory, items in per_dir.items():
        write_json(Path(directory) / "question.json", items, args.dry_run)
    scope = f" category={args.category_path}" if args.category_path else ""
    print(f"[OK] questions={len(rows)} dirs={len(per_dir)}{scope}")


if __name__ == "__main__":
    main()
# SOFTM-GEN 끝
