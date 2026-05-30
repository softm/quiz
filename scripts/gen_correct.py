#!/usr/bin/env python3
# SOFTM-GEN 시작: 매핑된 정답 파일을 파싱해 디렉토리별 correct.json 생성 - 2026-05-29
import argparse
import re
import subprocess
from pathlib import Path

from pdf_manifest_lib import (
    JSON_ROOT,
    PDF_ROOT,
    ROOT,
    answer_count,
    choose_answer_payload,
    manifest_path,
    parse_answer_file,
    read_json,
    rel_posix,
    strip_quiz_prefix,
    write_json,
)


def local_path(manifest_value):
    rel = strip_quiz_prefix(manifest_value)
    return ROOT / rel if rel else None


def group_by_question_dir(questions):
    grouped = {}
    for row in questions:
        question_path = local_path(row.get("questionPdf"))
        if not question_path:
            continue
        grouped.setdefault(question_path.parent, []).append(row)
    return grouped


def resolve_category_path(value):
    rel = strip_quiz_prefix(value)
    if not rel:
        return None
    path = (ROOT / rel).resolve()
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
# SOFTM-GEN: 선택 카테고리의 correct/question JSON만 갱신하도록 경로 필터 유틸 추가 - 2026-05-30


# SOFTM-OCR 시작: 문제 PDF OCR 품질이 비정상이면 correctJson이 있어도 게시하지 않도록 진단 - 2026-05-30
def expected_question_count(row, answer_count_value):
    explicit = row.get("questionCount") or row.get("answerCount") or answer_count_value
    try:
        explicit = int(explicit)
    except Exception:
        explicit = 0
    start = row.get("questionStartNo")
    end = row.get("questionEndNo")
    try:
        start = int(start)
        end = int(end)
    except Exception:
        start = 0
        end = 0
    if start > 0 and end >= start:
        return end - start + 1
    return explicit


def diagnose_question_ocr(row, answer_count_value):
    question_path = local_path(row.get("questionPdf"))
    if not question_path or not question_path.exists() or question_path.suffix.lower() != ".pdf":
        return False, "문제 PDF 없음", ["문제 PDF 파일을 찾을 수 없습니다."]
    try:
        text = subprocess.check_output(["pdftotext", "-layout", str(question_path), "-"], text=True, timeout=30)
    except Exception as exc:
        return False, "OCR 확인 필요", [f"PDF 텍스트 추출 실패: {exc}"]

    compact_text = re.sub(r"\s+", "", text or "")
    labels = [
        int(match.group(1))
        for match in re.finditer(r"(?:^|\n)\s*(\d{1,3})\s*(?:[.)]|번)", text or "")
        if 1 <= int(match.group(1)) <= 300
    ]
    unique_labels = sorted(set(labels))
    choice_labels = len(re.findall(r"[①②③④⑤]", text or ""))
    expected = expected_question_count(row, answer_count_value)
    warnings = []

    if not compact_text:
        warnings.append("텍스트 레이어가 없습니다. OCR 적용이 필요합니다.")
    if expected and len(unique_labels) < max(3, int(expected * 0.75)):
        warnings.append(f"예상 문항 수({expected}) 대비 고유 문항번호 감지가 부족합니다.")
    if expected and len(labels) > expected * 1.3:
        warnings.append(f"예상 문항 수({expected})보다 문항번호가 과다 감지됩니다. OCR 오인식 가능성이 있습니다.")
    if expected and choice_labels < expected * 2:
        warnings.append(f"선택지 기호 감지가 부족합니다({choice_labels}개). OCR 품질 또는 텍스트 레이어를 확인하세요.")

    row["ocrTextChars"] = len(compact_text)
    row["ocrQuestionLabels"] = len(labels)
    row["ocrUniqueQuestionLabels"] = len(unique_labels)
    row["ocrChoiceLabels"] = choice_labels
    row["ocrWarnings"] = warnings
    if warnings:
        return False, "OCR 확인 필요", warnings
    return True, "정상", []
# SOFTM-OCR 끝


def main():
    parser = argparse.ArgumentParser(description="question.json의 정답 파일을 파싱해 correct.json을 생성합니다.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--category-path", default="", help="특정 pdf 카테고리 경로의 question/correct JSON만 갱신")
    args = parser.parse_args()

    question_path = JSON_ROOT / "question.json"
    questions = read_json(question_path, [])
    if not isinstance(questions, list):
        raise SystemExit("[ERR] json/question.json must be an array")

    parsed_cache = {}
    published = 0
    grouped = group_by_question_dir(questions)
    if args.category_path:
        target_path = resolve_category_path(args.category_path)
        grouped = {
            directory: rows
            for directory, rows in grouped.items()
            if is_same_or_inside(directory, target_path)
        }

    for directory, rows in grouped.items():
        items = []
        for row in rows:
            answer_path = local_path(row.get("answerPdf"))
            if not answer_path or not answer_path.exists():
                row["correctJson"] = ""
                row["published"] = False
                continue

            cache_key = str(answer_path.resolve())
            if cache_key not in parsed_cache:
                parsed_cache[cache_key] = parse_answer_file(answer_path)
            answer_payload = choose_answer_payload(parsed_cache[cache_key], row)
            answers = answer_payload.get("answers") if answer_payload else None
            count = answer_count(answers)
            if count == 0:
                row["correctJson"] = ""
                row["published"] = False
                continue

            correct_path = directory / "correct.json"
            ocr_ok, ocr_status, ocr_warnings = diagnose_question_ocr(row, count)
            item = {
                "questionNo": row.get("questionNo", ""),
                "questionNm": row.get("questionNm", ""),
                "questionPdf": row.get("questionPdf", ""),
                "answerPdf": row.get("answerPdf", ""),
                "count": count,
                "answers": answers,
            }
            if answer_payload:
                for key in ("answerStartNo", "answerEndNo", "printedAnswerNoMap", "answerIndexMode"):
                    if answer_payload.get(key):
                        item[key] = answer_payload.get(key)
            items.append(item)
            row["correctJson"] = manifest_path(correct_path)
            row["answerCount"] = count
            row["questionCount"] = count
            if answer_payload and answer_payload.get("answerStartNo"):
                row["answerStartNo"] = answer_payload.get("answerStartNo")
                row["answerEndNo"] = answer_payload.get("answerEndNo")
                if not row.get("questionStartNo"):
                    row["questionStartNo"] = answer_payload.get("answerStartNo")
                    row["questionEndNo"] = answer_payload.get("answerEndNo")
            row["ocrStatus"] = ocr_status
            row["ocrPublished"] = ocr_ok
            row["ocrWarnings"] = ocr_warnings
            row["published"] = True
            published += 1
            # SOFTM-OCR: 정답 JSON 생성 성공 시 게시 상태는 유지하고 OCR 품질은 보조 진단 필드로만 저장 - 2026-05-30
            # SOFTM-정답: 정답표 인쇄 시작번호가 1이 아니어도 앱 내부 순서와 별도 메타로 저장 - 2026-05-30

        correct_payload = {
            "version": 1,
            "directory": manifest_path(directory),
            "items": items,
        }
        write_json(directory / "correct.json", correct_payload, args.dry_run)

    write_json(question_path, questions, args.dry_run)
    for directory, rows in grouped.items():
        write_json(directory / "question.json", rows, args.dry_run)

    scope = f" category={args.category_path}" if args.category_path else ""
    print(f"[OK] correct_dirs={len(grouped)} published={published} answer_sources={len(parsed_cache)}{scope}")


if __name__ == "__main__":
    main()
# SOFTM-GEN 끝
