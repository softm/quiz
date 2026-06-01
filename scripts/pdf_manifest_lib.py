#!/usr/bin/env python3
# SOFTM-GEN 시작: pdf 디렉토리 기반 manifest/correct 생성 공통 유틸 추가 - 2026-05-29
import json
import os
import re
import subprocess
import unicodedata
from html import unescape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PDF_ROOT = ROOT / "pdf"
JSON_ROOT = ROOT / "json"
ANSWER_DIR_NAMES = {"정답"}
QUESTION_EXTS = {".pdf"}
ANSWER_EXTS = {".pdf", ".hwp"}
ANSWER_PARSE_CACHE = {}
MULTI_ANSWER_MAP = {
    "A": [1, 2],
    "B": [1, 3],
    "C": [1, 4],
    "D": [2, 3],
    "E": [2, 4],
    "F": [3, 4],
    "G": [1, 2, 3],
    "H": [1, 2, 4],
    "I": [1, 3, 4],
    "J": [2, 3, 4],
    "K": [1, 2, 3, 4],
}


def nfc(value):
    return unicodedata.normalize("NFC", str(value or ""))


def compact(value):
    return re.sub(r"\s+", "", nfc(value))


def rel_posix(path):
    return Path(path).resolve().relative_to(ROOT).as_posix()


def manifest_path(path):
    return f"quiz/{rel_posix(path)}"


def strip_quiz_prefix(value):
    raw = str(value or "").strip()
    if raw.startswith("quiz/"):
        return raw[5:]
    return raw.lstrip("./")


def read_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return fallback


# SOFTM-FORMAT 시작: answers 배열을 10개 단위 줄바꿈으로 저장하는 공통 JSON 포맷터 추가 - 2026-05-29
def _format_answers_array(values, indent=0, per_line=10):
    lines = ["["]
    if values:
        value_indent = " " * (indent + 2)
        last = len(values) - 1
        for start in range(0, len(values), per_line):
            chunk = []
            for idx in range(start, min(start + per_line, len(values))):
                raw = json.dumps(values[idx], ensure_ascii=False, separators=(", ", ": "))
                chunk.append(f"{raw}," if idx < last else raw)
            lines.append(f"{value_indent}{' '.join(chunk)}")
    lines.append(f"{' ' * indent}]")
    return "\n".join(lines)


def _format_json_value(value, indent=0, key_name=None):
    if key_name == "answers" and isinstance(value, list):
        return _format_answers_array(value, indent)
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = ["{"]
        items = list(value.items())
        for idx, (key, child) in enumerate(items):
            rendered = _format_json_value(child, indent + 2, str(key))
            comma = "," if idx < len(items) - 1 else ""
            lines.append(f"{' ' * (indent + 2)}{json.dumps(str(key), ensure_ascii=False)}: {rendered}{comma}")
        lines.append(f"{' ' * indent}}}")
        return "\n".join(lines)
    if isinstance(value, list):
        if not value:
            return "[]"
        lines = ["["]
        for idx, child in enumerate(value):
            rendered = _format_json_value(child, indent + 2)
            comma = "," if idx < len(value) - 1 else ""
            lines.append(f"{' ' * (indent + 2)}{rendered}{comma}")
        lines.append(f"{' ' * indent}]")
        return "\n".join(lines)
    return json.dumps(value, ensure_ascii=False)
# SOFTM-FORMAT 끝


def write_json(path, data, dry_run=False):
    path = Path(path)
    content = _format_json_value(data) + "\n"
    if dry_run:
        print(f"[DRY] write {rel_posix(path)}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            if path.read_text(encoding="utf-8") == content:
                print(f"[SKIP] unchanged {rel_posix(path)}")
                return
        except Exception:
            pass
    path.write_text(content, encoding="utf-8")


def is_answer_dir(path):
    return nfc(Path(path).name) in ANSWER_DIR_NAMES


def is_inside_answer_dir(path):
    try:
        rel = Path(path).resolve().relative_to(PDF_ROOT)
    except ValueError:
        return False
    return any(nfc(part) in ANSWER_DIR_NAMES for part in rel.parts)


def is_answer_file(path):
    p = Path(path)
    if p.suffix.lower() not in ANSWER_EXTS or is_generated_pdf_file(p):
        return False
    tail = compact(p.stem)[-24:]
    return "정답" in tail or "최종정답" in tail


def is_generated_pdf_file(path):
    p = Path(path)
    stem = compact(p.stem)
    if p.name.startswith("."):
        return True
    # SOFTM-OCR: 실패/거절 OCR 산출물이 새 문제 회차로 등록되지 않도록 제외 패턴 확장 - 2026-05-30
    return re.search(r"_(?:ocr_failed(?:_\d{14})?|ocr_rejected(?:_\d{14})?|ocrfixed|ocr|fixed|original(?:_\d{14}|\d{14})?)$", stem, re.I) is not None


def is_question_file(path):
    p = Path(path)
    return p.suffix.lower() in QUESTION_EXTS and not is_generated_pdf_file(p) and not is_answer_file(p) and not is_inside_answer_dir(p)


# SOFTM-OCR: OCR 결과/백업 PDF가 새 문제 회차로 등록되지 않도록 공통 파일 판정에서 제외 - 2026-05-30


def extract_year_semester(value):
    text = nfc(value)
    patterns = [
        r"(20\d{2})\s*(?:학년도)?\s*[-.]?\s*([12])\s*학기",
        r"(20\d{2})\s*[.]\s*([12])\s*학기",
        r"(20\d{2}).*?([12])\s*학기",
    ]
    for pattern in patterns:
        m = re.search(pattern, text)
        if m:
            return m.group(1), m.group(2)
    year = re.search(r"(20\d{2})", text)
    semester = re.search(r"([12])\s*학기", text)
    return (year.group(1) if year else "", semester.group(1) if semester else "")


def extract_exam_type(value):
    text = nfc(value)
    if "대체" in text or "출석" in text:
        return "대체시험"
    if "기말" in text:
        return "기말시험"
    if "중간" in text:
        return "중간시험"
    if "계절" in text:
        return "계절시험"
    return ""


def normalize_match_title(value):
    stem = nfc(Path(value).stem if Path(str(value)).suffix else value)
    stem = re.sub(r"\[[^\]]*\]", " ", stem)
    stem = re.sub(r"\([^)]*\)", " ", stem)
    for token in ["시험문제지", "최종정답", "정답표", "정답", "기출문제", "문제지"]:
        stem = stem.replace(token, " ")
    return re.sub(r"[^0-9A-Za-z가-힣]+", "", stem)


def scan_category_dirs():
    if not PDF_ROOT.exists():
        return []
    dirs = []
    for current, dir_names, _file_names in os.walk(PDF_ROOT):
        current_path = Path(current)
        dir_names[:] = sorted(
            [name for name in dir_names if not name.startswith(".") and nfc(name) not in ANSWER_DIR_NAMES],
            key=lambda item: nfc(item),
        )
        if current_path == PDF_ROOT or is_inside_answer_dir(current_path):
            continue
        dirs.append(current_path)
    return sorted(dirs, key=lambda path: [nfc(part) for part in path.relative_to(PDF_ROOT).parts])


def build_category_rows():
    dirs = scan_category_dirs()
    dir_to_cat = {}
    root_to_group = {}
    groups = []
    categories = []

    for idx, directory in enumerate(dirs, start=1):
        rel = directory.relative_to(PDF_ROOT)
        root_name = nfc(rel.parts[0])
        if root_name not in root_to_group:
            g_no = f"{len(root_to_group) + 1:02d}"
            root_to_group[root_name] = g_no
            groups.append({"gNo": g_no, "gNm": root_name, "seq": len(groups) + 1})
        cat_no = f"{idx:04d}"
        parent_dir = directory.parent
        parent_cat_no = dir_to_cat.get(parent_dir, "")
        row = {
            "gNo": root_to_group[root_name],
            "gNm": root_name,
            "catNm": nfc(directory.name),
            "catNo": cat_no,
            "parentCatNo": parent_cat_no,
            "catPath": manifest_path(directory),
            "depth": len(rel.parts),
            "seq": idx,
        }
        dir_to_cat[directory] = cat_no
        categories.append(row)

    return groups, categories, dir_to_cat


def answer_roots_for(question_dir):
    roots = []
    current = Path(question_dir).resolve()
    while current != PDF_ROOT.parent and current != current.parent:
        candidate = current / "정답"
        if candidate.exists() and candidate.is_dir():
            roots.append(candidate)
        if current == PDF_ROOT:
            break
        current = current.parent
    global_root = PDF_ROOT / "정답"
    if global_root.exists() and global_root not in roots:
        roots.append(global_root)
    return roots


def find_same_dir_answer(question_file):
    q = Path(question_file)
    q_key = normalize_match_title(q.stem)
    candidates = []
    for item in sorted(q.parent.iterdir(), key=lambda p: nfc(p.name)):
        if not item.is_file() or not is_answer_file(item):
            continue
        a_key = normalize_match_title(item.stem)
        score = 0
        if q_key and a_key and (a_key.startswith(q_key) or q_key.startswith(a_key)):
            score += 50
        if q_key and q_key[:8] and q_key[:8] in a_key:
            score += 10
        if "최종" in nfc(item.stem):
            score += 2
        if score > 0:
            candidates.append((score, item))
    return sorted(candidates, key=lambda row: (-row[0], nfc(row[1].name)))[0][1] if candidates else None


def find_answer_from_roots(question_file):
    q = Path(question_file)
    year, semester = extract_year_semester(q.name)
    exam_type = extract_exam_type(q.name)
    q_key = normalize_match_title(q.stem)
    subject_hint = compact(q.parent.name)
    candidates = []

    for root in answer_roots_for(q.parent):
        if year and semester:
            search_dirs = []
            if exam_type and (root / exam_type / year).exists():
                search_dirs.append(root / exam_type / year)
            if not search_dirs:
                search_dirs.extend([p for p in root.rglob(year) if p.is_dir()])
            for search_dir in search_dirs:
                for item in search_dir.rglob("*"):
                    if not item.is_file() or not is_answer_file(item):
                        continue
                    a_year, a_semester = extract_year_semester(item.name)
                    if a_year == year and a_semester == semester:
                        score = 30 + (5 if exam_type and exam_type in rel_posix(item) else 0)
                        if subject_hint and answer_file_contains_subject(item, subject_hint):
                            score += 40
                        candidates.append((score, item))
        else:
            for item in root.rglob("*"):
                if not item.is_file() or not is_answer_file(item):
                    continue
                a_key = normalize_match_title(item.stem)
                if q_key and a_key.startswith(q_key):
                    candidates.append((20, item))

    return sorted(candidates, key=lambda row: (-row[0], nfc(row[1].name)))[0][1] if candidates else None


def find_answer_file(question_file):
    return find_same_dir_answer(question_file) or find_answer_from_roots(question_file)


def answer_file_contains_subject(path, subject_hint):
    if not subject_hint:
        return False
    try:
        key = str(Path(path).resolve())
        if key not in ANSWER_PARSE_CACHE:
            ANSWER_PARSE_CACHE[key] = parse_answer_file(path)
        parsed = ANSWER_PARSE_CACHE.get(key) or {}
        for row in parsed.get("subjects") or []:
            subject = subject_key(row.get("subject"))
            if subject and (subject == subject_hint or subject in subject_hint or subject_hint in subject):
                return True
    except Exception:
        return False
    return False


def run_text_command(command):
    try:
        return subprocess.check_output(command, cwd=ROOT, text=True, stderr=subprocess.DEVNULL, timeout=45)
    except Exception:
        return ""


def parse_answer_sequence(raw):
    out = []
    compacted = re.sub(r"[^1-5A-K]", "", nfc(raw).upper())
    for ch in compacted:
        if ch in "12345":
            out.append(int(ch))
        elif ch in MULTI_ANSWER_MAP:
            out.append(MULTI_ANSWER_MAP[ch])
    return out


def parse_pairs_from_text(text, max_questions=999):
    normalized = nfc(text).translate(str.maketrans({"①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5"}))
    pairs = []
    for line in normalized.splitlines():
        digits_only = re.sub(r"[^\d]+", " ", line).strip()
        if not digits_only:
            continue
        nums = [int(v) for v in digits_only.split() if v.isdigit()]
        if len(nums) >= 6 and len(nums) % 2 == 0:
            for i in range(0, len(nums) - 1, 2):
                q_no, answer = nums[i], nums[i + 1]
                if 1 <= q_no <= max_questions and 1 <= answer <= 5:
                    pairs.append((q_no, answer))
    if len(pairs) < 5:
        nums = [int(v) for v in re.sub(r"[^\d]+", " ", normalized).split() if v.isdigit()]
        prev_q = 0
        i = 0
        while i < len(nums) - 1:
            q_no, answer = nums[i], nums[i + 1]
            if 1 <= q_no <= max_questions and 1 <= answer <= 5 and (q_no > prev_q or prev_q == 0):
                pairs.append((q_no, answer))
                prev_q = q_no
                i += 2
            else:
                i += 1
    return pairs


def answers_from_pairs(pairs, max_questions=100):
    answers = [None] * max_questions
    for q_no, answer in pairs:
        if 1 <= q_no <= max_questions:
            answers[q_no - 1] = answer
    return answers


def question_start_no(question):
    try:
        value = int(question.get("questionStartNo") or 0)
    except Exception:
        value = 0
    return value if value > 0 else 1


def question_count(question, fallback=0):
    try:
        start = int(question.get("questionStartNo") or 0)
        end = int(question.get("questionEndNo") or 0)
        if start > 0 and end >= start:
            return end - start + 1
    except Exception:
        pass
    for key in ("questionCount", "answerCount"):
        try:
            value = int(question.get(key) or 0)
        except Exception:
            value = 0
        if value > 0:
            return value
    return fallback


def printed_no_map(start_no, count):
    return [None] + [start_no + idx for idx in range(count)]


def answer_payload(answers, start_no=1, source="sequence"):
    values = list(answers or [])
    count = answer_count(values)
    if count <= 0:
        return None
    return {
        "answers": values,
        "answerStartNo": start_no,
        "answerEndNo": start_no + len(values) - 1,
        "printedAnswerNoMap": printed_no_map(start_no, len(values)),
        "answerIndexMode": source,
    }


def answers_from_printed_pairs(pairs, question):
    if not pairs:
        return None
    labels = sorted({q_no for q_no, _ in pairs if isinstance(q_no, int) and q_no > 0})
    if not labels:
        return None
    expected_count = question_count(question, 0)
    configured_start = question_start_no(question)
    candidates = {configured_start, min(labels)}
    candidates.update(labels)
    pair_map = {}
    for q_no, answer in pairs:
        if q_no not in pair_map:
            pair_map[q_no] = answer
    best = None
    for start in sorted(value for value in candidates if value > 0):
        count = expected_count or max(0, max(labels) - start + 1)
        if count <= 0:
            continue
        values = [pair_map.get(start + idx) for idx in range(count)]
        known = answer_count(values)
        score = known + (0.05 if start == configured_start else 0)
        if best is None or score > best["score"]:
            best = {"start": start, "answers": values, "score": score}
    if not best or answer_count(best["answers"]) == 0:
        return None
    return answer_payload(best["answers"], best["start"], "printed-pairs")
# SOFTM-정답: 정답표 번호가 1이 아닌 경우를 위해 인쇄 번호와 앱 내부 정답 순서를 분리 - 2026-05-30


def parse_subject_rows_from_cells(rows):
    subjects = {}
    for cells in rows:
        if len(cells) < 3:
            continue
        grade = re.sub(r"\D+", "", cells[0])[:1]
        if grade not in {"1", "2", "3", "4"}:
            continue
        subject = re.sub(r"\s+", " ", nfc(cells[1])).strip()
        if not subject or "교과목명" in subject:
            continue
        answers = parse_answer_sequence("".join(cells[2:]))
        if len(answers) < 5:
            continue
        subjects[(subject, int(grade))] = {
            "subject": subject,
            "grade": int(grade),
            "questionCount": len(answers),
            "answers": answers,
        }
    return sorted(subjects.values(), key=lambda row: (row["grade"], row["subject"]))


def parse_subject_rows_from_text(text):
    rows = []
    for line in nfc(text).splitlines():
        tokens = re.sub(r"\s+", " ", line).strip().split(" ")
        if len(tokens) < 3 or tokens[0] not in {"1", "2", "3", "4"}:
            continue
        idx = len(tokens) - 1
        answer_tokens = []
        while idx >= 2 and re.fullmatch(r"[1-5A-K]+", tokens[idx].upper() or ""):
            answer_tokens.insert(0, tokens[idx])
            idx -= 1
        subject = " ".join(tokens[1:idx + 1]).strip()
        if subject and answer_tokens:
            rows.append([tokens[0], subject, *answer_tokens])
    return parse_subject_rows_from_cells(rows)


def parse_hwp_subjects(path):
    html = run_text_command(["hwp5html", "--html", str(path)])
    if not html:
        return []
    rows = []
    for tr in re.findall(r"<tr\b[\s\S]*?</tr>", html, flags=re.I):
        cells = []
        for td in re.findall(r"<td\b[\s\S]*?</td>", tr, flags=re.I):
            text = re.sub(r"<br\s*/?>", " ", td, flags=re.I)
            text = re.sub(r"<[^>]+>", " ", text)
            cells.append(re.sub(r"\s+", " ", unescape(text)).strip())
        if cells:
            rows.append(cells)
    subjects = parse_subject_rows_from_cells(rows)
    return subjects or parse_subject_rows_from_text(re.sub(r"<[^>]+>", " ", html))


def parse_answer_file(path):
    path = Path(path)
    adjacent_json = path.with_suffix(".json")
    existing = read_json(adjacent_json, None) if adjacent_json.exists() else None
    if isinstance(existing, dict) and isinstance(existing.get("answers"), list):
        return {
            "kind": "answers",
            "answers": existing["answers"],
            "answerStartNo": existing.get("answerStartNo") or existing.get("questionStartNo"),
            "answerIndexMode": existing.get("answerIndexMode") or "sequence",
            "source": manifest_path(adjacent_json),
        }

    if path.suffix.lower() == ".hwp":
        subjects = parse_hwp_subjects(path)
        return {"kind": "subjects", "subjects": subjects} if subjects else {"kind": "empty"}

    text = run_text_command(["pdftotext", "-layout", str(path), "-"])
    subjects = parse_subject_rows_from_text(text)
    if subjects:
        return {"kind": "subjects", "subjects": subjects}
    pairs = parse_pairs_from_text(text)
    return {"kind": "answer_pairs", "pairs": pairs} if pairs else {"kind": "empty"}


def subject_key(value):
    return re.sub(r"\s+", "", nfc(value))


def choose_answer_payload(parsed, question):
    if parsed.get("kind") == "answers":
        answers = parsed.get("answers") or []
        if not any(answer is not None for answer in answers):
            return None
        start_no = int(parsed.get("answerStartNo") or parsed.get("questionStartNo") or question_start_no(question))
        return answer_payload(answers, start_no, parsed.get("answerIndexMode") or "sequence")

    if parsed.get("kind") == "answer_pairs":
        return answers_from_printed_pairs(parsed.get("pairs") or [], question)

    subjects = parsed.get("subjects") or []
    if not subjects:
        return None
    cat_key = subject_key(question.get("catNm"))
    title_key = subject_key(question.get("questionNm"))
    picked = None
    for row in subjects:
        key = subject_key(row.get("subject"))
        if key and (key == cat_key or key in title_key or cat_key in key):
            picked = row
            break
    if picked is None and len(subjects) == 1:
        picked = subjects[0]
    if not picked:
        return None
    start_no = question_start_no(question)
    return answer_payload(picked.get("answers") or [], start_no, "subject-sequence")


def choose_answers(parsed, question):
    payload = choose_answer_payload(parsed, question)
    return payload.get("answers") if payload else None


def answer_count(answers):
    return sum(1 for value in (answers or []) if value is not None)


def clean_generated_in_pdf():
    for name in ("question.json", "correct.json"):
        for item in PDF_ROOT.rglob(name):
            if item.is_file():
                item.unlink()
# SOFTM-GEN 끝
