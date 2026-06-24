#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from pdf_manifest_lib import (
    JSON_ROOT,
    ROOT,
    answer_count,
    choose_answer_payload,
    manifest_path,
    nfc,
    parse_answer_file,
    read_json,
    rel_posix,
    strip_quiz_prefix,
    write_json,
)
from gen_correct import diagnose_question_ocr


def local_path(manifest_value):
    rel = strip_quiz_prefix(manifest_value)
    return ROOT / rel if rel else None


def same_rel_path(left, right):
    return nfc(strip_quiz_prefix(left)) == nfc(strip_quiz_prefix(right))


def find_row(rows, question_no="", question_pdf=""):
    for idx, row in enumerate(rows):
        if question_no and str(row.get("questionNo") or "") == str(question_no):
            return idx, row
    for idx, row in enumerate(rows):
        if question_pdf and same_rel_path(row.get("questionPdf") or "", question_pdf):
            return idx, row
    raise SystemExit("[ERR] target question not found")


def replace_correct_item(items, item):
    question_no = str(item.get("questionNo") or "")
    question_pdf = item.get("questionPdf") or ""
    for idx, existing in enumerate(items):
        if question_no and str(existing.get("questionNo") or "") == question_no:
            items[idx] = item
            return "updated"
        if question_pdf and same_rel_path(existing.get("questionPdf") or "", question_pdf):
            items[idx] = item
            return "updated"
    items.append(item)
    return "added"


def update_local_question_manifest(row, fields):
    question_path = local_path(row.get("questionPdf"))
    if not question_path:
        return False
    local_manifest = question_path.parent / "question.json"
    local_rows = read_json(local_manifest, [])
    if not isinstance(local_rows, list):
        return False
    try:
        idx, local_row = find_row(local_rows, row.get("questionNo") or "", row.get("questionPdf") or "")
    except SystemExit:
        return False
    local_rows[idx] = {**local_row, **fields}
    write_json(local_manifest, local_rows)
    return True


def main():
    parser = argparse.ArgumentParser(description="현재 회차 하나의 정답 파일을 파싱해 correct.json에 연결합니다.")
    parser.add_argument("--manifest", default="question.json", help="json 하위 manifest 파일명")
    parser.add_argument("--question-no", default="")
    parser.add_argument("--question-pdf", default="")
    args = parser.parse_args()

    manifest_file = JSON_ROOT / Path(args.manifest).name
    rows = read_json(manifest_file, [])
    if not isinstance(rows, list):
        raise SystemExit(f"[ERR] {manifest_file} must be an array")

    idx, row = find_row(rows, args.question_no, args.question_pdf)
    question_path = local_path(row.get("questionPdf"))
    if not question_path or not question_path.exists():
        raise SystemExit("[ERR] question PDF not found")

    answer_path = local_path(row.get("answerPdf"))
    if not answer_path or not answer_path.exists():
        raise SystemExit("[ERR] answer file not found")

    parsed = parse_answer_file(answer_path)
    answer_payload = choose_answer_payload(parsed, row)
    answers = answer_payload.get("answers") if answer_payload else None
    count = answer_count(answers)
    if count == 0:
        raise SystemExit("[ERR] no answers parsed")

    correct_path = question_path.parent / "correct.json"
    correct_payload = read_json(correct_path, {})
    items = correct_payload.get("items") if isinstance(correct_payload, dict) else None
    if not isinstance(items, list):
        items = []

    item = {
        "questionNo": row.get("questionNo", ""),
        "questionNm": row.get("questionNm", ""),
        "questionPdf": row.get("questionPdf", ""),
        "answerPdf": row.get("answerPdf", ""),
        "count": count,
        "answers": answers,
    }
    for key in ("answerStartNo", "answerEndNo", "printedAnswerNoMap", "answerIndexMode"):
        if answer_payload.get(key):
            item[key] = answer_payload.get(key)

    item_action = replace_correct_item(items, item)
    next_correct_payload = {
        "version": correct_payload.get("version", 1) if isinstance(correct_payload, dict) else 1,
        "directory": manifest_path(question_path.parent),
        "items": items,
    }
    write_json(correct_path, next_correct_payload)

    fields = {
        "correctJson": manifest_path(correct_path),
        "answerCount": count,
        "questionCount": count,
    }
    try:
        question_start = int(row.get("questionStartNo") or 0)
        question_end = int(row.get("questionEndNo") or 0)
    except Exception:
        question_start = 0
        question_end = 0
    if question_start > 0 and (question_end < question_start or question_end - question_start + 1 != count):
        fields["questionEndNo"] = question_start + count - 1
    # SOFTM-정답OCR: 개별 정답 재생성에서도 오염된 questionEndNo를 count 기준으로 복구 - 2026-06-24
    if answer_payload.get("answerStartNo"):
        fields["answerStartNo"] = answer_payload.get("answerStartNo")
        fields["answerEndNo"] = answer_payload.get("answerEndNo")
        if not row.get("questionStartNo"):
            fields["questionStartNo"] = answer_payload.get("answerStartNo")
            fields["questionEndNo"] = answer_payload.get("answerEndNo")
    diagnostic_row = {**row, **fields}
    ocr_ok, ocr_status, ocr_warnings = diagnose_question_ocr(diagnostic_row, count)
    fields["ocrStatus"] = ocr_status
    fields["ocrPublished"] = ocr_ok
    fields["ocrWarnings"] = ocr_warnings

    rows[idx] = {**row, **fields}
    write_json(manifest_file, rows)
    local_manifest_updated = update_local_question_manifest(row, fields)

    print(json.dumps({
        "ok": True,
        "questionNo": row.get("questionNo", ""),
        "questionNm": row.get("questionNm", ""),
        "answerFile": rel_posix(answer_path),
        "correctJson": strip_quiz_prefix(manifest_path(correct_path)),
        "count": count,
        "itemAction": item_action,
        "localManifestUpdated": local_manifest_updated,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
