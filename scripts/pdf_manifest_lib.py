#!/usr/bin/env python3
# SOFTM-GEN 시작: pdf 디렉토리 기반 manifest/correct 생성 공통 유틸 추가 - 2026-05-29
import json
import os
import re
import subprocess
import unicodedata
from collections import defaultdict
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


# SOFTM-정답매핑 시작: 문제지명/정답명에서 연도·회차·차수를 뽑아 정답 디렉토리 후보를 좁힘 - 2026-06-24
def extract_exam_round(value):
    text = nfc(value)
    match = re.search(r"제\s*(\d{1,3})\s*회", text)
    if not match:
        match = re.search(r"(?<!\d)(\d{1,3})\s*회(?!\s*(?:차|분|전|동안))", text)
    return match.group(1) if match else ""


def extract_exam_round_range(value):
    text = nfc(value)
    patterns = [
        r"제\s*(\d{1,3})\s*회\s*[~∼～\-–—]\s*제?\s*(\d{1,3})\s*회",
        r"제\s*(\d{1,3})\s*[~∼～\-–—]\s*(\d{1,3})\s*회",
        r"제\s*(\d{1,3})\s*회\s*(?:부터|에서)\s*제?\s*(\d{1,3})\s*회",
        r"(\d{1,3})\s*회\s*[~∼～\-–—]\s*(\d{1,3})\s*회",
        r"(\d{1,3})\s*[~∼～\-–—]\s*(\d{1,3})\s*회",
        r"(\d{1,3})\s*회\s*(?:부터|에서)\s*(?:제\s*)?(\d{1,3})\s*회",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        start = int(match.group(1))
        end = int(match.group(2))
        if start > end:
            start, end = end, start
        return str(start), str(end)
    single = extract_exam_round(value)
    return (single, single) if single else ("", "")


def extract_exam_phase(value):
    text = nfc(value)
    match = re.search(r"([12])\s*차", text)
    return match.group(1) if match else ""


def extract_exam_session(value):
    text = nfc(value)
    match = re.search(r"(?:제\s*)?([12])\s*교시", text)
    return match.group(1) if match else ""


def extract_exam_identity(value):
    year, semester = extract_year_semester(value)
    return {
        "year": year,
        "semester": semester,
        "exam_type": extract_exam_type(value),
        "round": extract_exam_round(value),
        "round_range": extract_exam_round_range(value),
        "phase": extract_exam_phase(value),
        "session": extract_exam_session(value),
    }


def exam_identity_match_score(question_name, answer_name):
    q = extract_exam_identity(question_name)
    a = extract_exam_identity(answer_name)
    score = 0
    comparable = False
    # SOFTM-정답매핑: 문제지 파일명에서 년도·회차·교시 같은 숫자+문자 식별 패턴을 뽑아 정답지를 구분 - 2026-06-24
    for key, weight in [("year", 35), ("round", 45), ("session", 18), ("phase", 15), ("semester", 12)]:
        q_value = q.get(key) or ""
        a_value = a.get(key) or ""
        if key == "round" and q_value:
            # SOFTM-정답매핑: 제1회~제3회처럼 통합 정답지는 문제 회차가 범위 안이면 후보로 인정 - 2026-06-24
            a_start, a_end = a.get("round_range") or ("", "")
            if a_start and a_end and a_start != a_end:
                comparable = True
                q_round = int(q_value)
                if not (int(a_start) <= q_round <= int(a_end)):
                    return None
                score += weight - 3
                continue
        if q_value and a_value:
            comparable = True
            if q_value != a_value:
                return None
            score += weight
    q_type = q.get("exam_type") or ""
    a_type = a.get("exam_type") or ""
    if q_type and a_type:
        comparable = True
        if q_type != a_type:
            return None
        score += 8
    return score if comparable and score > 0 else 0
# SOFTM-정답매핑 끝


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
        identity_score = exam_identity_match_score(q.name, item.name)
        if identity_score is None:
            continue
        score += identity_score
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
                    if (a_year and a_year != year) or (a_semester and a_semester != semester):
                        continue
                    # SOFTM-정답매핑: 정답지 파일명에 년도/학기 일부가 빠져도 회차 등 남은 식별자만 맞으면 연결 - 2026-06-24
                    identity_score = exam_identity_match_score(q.name, item.name)
                    if identity_score is None:
                        continue
                    score = 30 + identity_score + (5 if exam_type and exam_type in rel_posix(item) else 0)
                    if subject_hint and answer_file_contains_subject(item, subject_hint):
                        score += 40
                    candidates.append((score, item))
        else:
            for item in root.rglob("*"):
                if not item.is_file() or not is_answer_file(item):
                    continue
                identity_score = exam_identity_match_score(q.name, item.name)
                a_key = normalize_match_title(item.stem)
                if identity_score is None:
                    continue
                if identity_score:
                    score = identity_score
                    if q_key and a_key and (a_key.startswith(q_key) or q_key.startswith(a_key)):
                        score += 20
                    if subject_hint and compact(q.parent.name) and compact(q.parent.name) in compact(item.stem):
                        score += 10
                    candidates.append((score, item))
                    continue
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


# SOFTM-정답OCR 시작: 텍스트 추출이 표 숫자를 놓치는 이미지형 정답표를 렌더 이미지의 격자/숫자 템플릿으로 복원 - 2026-06-24
def is_answer_table_gray(pixel):
    r, g, b = pixel[:3]
    return abs(r - g) < 4 and abs(g - b) < 4 and 145 <= r <= 215


def find_gray_components(image):
    width, height = image.size
    pixels = image.load()
    mask = set()
    for y in range(height):
        for x in range(width):
            if is_answer_table_gray(pixels[x, y]):
                mask.add((x, y))
    seen = set()
    components = []
    for point in list(mask):
        if point in seen:
            continue
        stack = [point]
        seen.add(point)
        xs = []
        ys = []
        while stack:
            x, y = stack.pop()
            xs.append(x)
            ys.append(y)
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if (nx, ny) in mask and (nx, ny) not in seen:
                    seen.add((nx, ny))
                    stack.append((nx, ny))
        if len(xs) > 50000:
            components.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, len(xs)))
    return sorted(components, key=lambda item: (item[1], item[0]))


def gray_projection_bands(image, bbox, axis):
    x0, y0, x1, y1 = bbox[:4]
    pixels = image.load()
    values = []
    if axis == "y":
        for y in range(y0, y1):
            count = sum(1 for x in range(x0, x1) if is_answer_table_gray(pixels[x, y]))
            if count > 100:
                values.append(y)
    else:
        for x in range(x0, x1):
            count = sum(1 for y in range(y0, y1) if is_answer_table_gray(pixels[x, y]))
            if count > 100:
                values.append(x)
    bands = []
    for value in values:
        if not bands or value > bands[-1][1] + 1:
            bands.append([value, value])
        else:
            bands[-1][1] = value
    return bands


def dark_components(crop, threshold=120):
    image = crop.convert("L")
    width, height = image.size
    pixels = image.load()
    mask = set()
    for y in range(height):
        for x in range(width):
            if pixels[x, y] < threshold:
                mask.add((x, y))
    seen = set()
    components = []
    for point in list(mask):
        if point in seen:
            continue
        stack = [point]
        seen.add(point)
        xs = []
        ys = []
        while stack:
            x, y = stack.pop()
            xs.append(x)
            ys.append(y)
            for nx in (x - 1, x, x + 1):
                for ny in (y - 1, y, y + 1):
                    if (nx, ny) in mask and (nx, ny) not in seen:
                        seen.add((nx, ny))
                        stack.append((nx, ny))
        if len(xs) >= 8:
            components.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, len(xs)))
    return sorted(
        [item for item in components if item[3] - item[1] > 10 and item[2] - item[0] > 2],
        key=lambda item: item[0],
    )


def normalized_digit_bitmap(crop, bbox):
    from PIL import ImageOps

    image = ImageOps.autocontrast(crop.convert("L").crop(bbox[:4])).resize((16, 24))
    return [1 if value < 140 else 0 for value in image.getdata()]


def digit_bitmap_distance(left, right):
    return sum(1 for a, b in zip(left, right) if a != b)


def classify_answer_digit(crop, templates):
    components = dark_components(crop, 160)
    if not components:
        return None
    value = normalized_digit_bitmap(crop, components[0])
    best = None
    for digit, bitmaps in ((digit, templates.get(digit) or []) for digit in "12345"):
        if not bitmaps:
            continue
        distance = min(digit_bitmap_distance(value, item) for item in bitmaps)
        if best is None or distance < best[0]:
            best = (distance, digit)
    return int(best[1]) if best else None


def classify_answer_value(crop, templates):
    values = []
    for component in dark_components(crop, 160):
        value = normalized_digit_bitmap(crop, component)
        best = None
        for digit, bitmaps in ((digit, templates.get(digit) or []) for digit in "12345"):
            if not bitmaps:
                continue
            distance = min(digit_bitmap_distance(value, item) for item in bitmaps)
            if best is None or distance < best[0]:
                best = (distance, digit)
        if best:
            values.append(int(best[1]))
    if not values:
        return None
    return values[0] if len(values) == 1 else values


def parse_answer_cells_from_image(image):
    templates = defaultdict(list)
    cells = []
    next_no = 1
    for bbox in find_gray_components(image):
        row_bands = [band for band in gray_projection_bands(image, bbox, "y") if band[1] - band[0] > 10]
        question_bands = [band for band in gray_projection_bands(image, bbox, "x") if band[1] - band[0] > 50]
        if len(row_bands) < 2 or len(question_bands) < 2:
            continue
        for y_band in row_bands:
            for col_index, x_band in enumerate(question_bands):
                question_crop = image.crop((x_band[0] + 5, y_band[0] + 3, x_band[1] - 5, y_band[1] - 3))
                question_components = dark_components(question_crop)
                expected_label = str(next_no)
                if len(question_components) != len(expected_label):
                    continue
                for digit, component in zip(expected_label, question_components):
                    templates[digit].append(normalized_digit_bitmap(question_crop, component))
                if col_index < len(question_bands) - 1:
                    answer_x0 = x_band[1] + 5
                    answer_x1 = question_bands[col_index + 1][0] - 5
                else:
                    answer_x0 = x_band[1] + 5
                    answer_x1 = bbox[2] - 5
                answer_crop = image.crop((answer_x0, y_band[0] + 3, answer_x1, y_band[1] - 3))
                cells.append((next_no, answer_crop))
                next_no += 1
    if not templates:
        return []
    answers = []
    for question_no, answer_crop in cells:
        answer = classify_answer_digit(answer_crop, templates)
        if answer is None:
            continue
        while len(answers) < question_no:
            answers.append(None)
        answers[question_no - 1] = answer
    while answers and answers[-1] is None:
        answers.pop()
    return answers


def projection_line_bands(image, bbox, axis, threshold_ratio=0.28):
    gray = image.convert("L")
    width, height = gray.size
    pixels = gray.load()
    x0, y0, x1, y1 = bbox
    values = []
    if axis == "y":
        threshold = max(20, int((x1 - x0) * threshold_ratio))
        for y in range(y0, y1):
            count = sum(1 for x in range(x0, x1) if pixels[x, y] < 90)
            if count >= threshold:
                values.append(y)
    else:
        threshold = max(20, int((y1 - y0) * threshold_ratio))
        for x in range(x0, x1):
            count = sum(1 for y in range(y0, y1) if pixels[x, y] < 90)
            if count >= threshold:
                values.append(x)
    bands = []
    for value in values:
        if not bands or value > bands[-1][1] + 1:
            bands.append([value, value])
        else:
            bands[-1][1] = value
    return bands


def center_of_band(band):
    return int(round((band[0] + band[1]) / 2))


def select_regular_grid_lines(row_bands):
    lines = [center_of_band(band) for band in row_bands]
    if len(lines) < 3:
        return lines
    runs = []
    current = [lines[0]]
    for value in lines[1:]:
        gap = value - current[-1]
        if 18 <= gap <= 90:
            current.append(value)
        else:
            if len(current) >= 3:
                runs.append(current)
            current = [value]
    if len(current) >= 3:
        runs.append(current)
    if not runs:
        return lines
    return max(runs, key=lambda item: (len(item), item[-1] - item[0]))


def parse_black_grid_answers_from_image(image, printed_start_no=1):
    row_bands = projection_line_bands(image, (0, 0, image.size[0], image.size[1]), "y", 0.18)
    if len(row_bands) < 3:
        return []
    row_lines = select_regular_grid_lines(row_bands)
    if len(row_lines) < 3:
        return []
    table_y0 = max(0, row_lines[0] - 2)
    table_y1 = min(image.size[1], row_lines[-1] + 3)
    col_bands = projection_line_bands(image, (0, table_y0, image.size[0], table_y1), "x", 0.35)
    if len(col_bands) < 2:
        return []
    col_lines = [center_of_band(band) for band in col_bands]
    col_lines = [value for idx, value in enumerate(col_lines) if idx == 0 or value - col_lines[idx - 1] > 12]
    templates = defaultdict(list)
    answer_cells = []
    expected_no = int(printed_start_no or 1)
    for row_idx in range(0, len(row_lines) - 1, 2):
        if row_idx + 1 >= len(row_lines) - 1:
            break
        q_y0, q_y1 = row_lines[row_idx], row_lines[row_idx + 1]
        a_y0, a_y1 = row_lines[row_idx + 1], row_lines[row_idx + 2]
        for col_idx in range(len(col_lines) - 1):
            x0, x1 = col_lines[col_idx], col_lines[col_idx + 1]
            if x1 - x0 <= 12 or q_y1 - q_y0 <= 6 or a_y1 - a_y0 <= 6:
                continue
            q_crop = image.crop((x0 + 4, q_y0 + 3, x1 - 4, q_y1 - 3))
            components = dark_components(q_crop)
            if not components:
                continue
            expected_label = str(expected_no)
            if len(components) == len(expected_label):
                for digit, component in zip(expected_label, components):
                    templates[digit].append(normalized_digit_bitmap(q_crop, component))
            answer_cells.append(image.crop((x0 + 4, a_y0 + 3, x1 - 4, a_y1 - 3)))
            expected_no += 1
    if not templates:
        return []
    answers = []
    for answer_crop in answer_cells:
        value = classify_answer_value(answer_crop, templates)
        if value is not None:
            answers.append(value)
    return answers
# SOFTM-정답OCR: 검은 격자 이미지 정답표도 셀 분할과 숫자 템플릿으로 읽도록 보강 - 2026-06-24


def parse_image_answer_sections(path, text):
    try:
        import pypdfium2 as pdfium
    except Exception:
        return []
    try:
        document = pdfium.PdfDocument(str(path))
    except Exception:
        return []
    text_pages = nfc(text).split("\f")
    sections = []
    rendered_pages = []
    for page_index in range(len(document)):
        try:
            image = document[page_index].render(scale=200 / 72).to_pil().convert("RGB")
        except Exception:
            continue
        rendered_pages.append((page_index, image))
        answers = parse_answer_cells_from_image(image)
        if answer_count(answers) < 5:
            continue
        page_text = text_pages[page_index] if page_index < len(text_pages) else ""
        match = re.search(r"(\d{1,2})\s*교시", page_text)
        fallback_session_no = page_index + 1 if "교시" in page_text else None
        sections.append({
            "sessionNo": int(match.group(1)) if match else fallback_session_no,
            "answers": answers,
            "questionCount": len(answers),
        })
    if sections:
        return sections
    round_start, round_end = extract_exam_round_range(path.name)
    if round_start and round_end:
        round_count = int(round_end) - int(round_start) + 1
        if round_count > 0 and len(rendered_pages) == round_count * 3:
            for offset in range(round_count):
                round_no = int(round_start) + offset
                first_page = rendered_pages[offset * 3][1]
                second_page = rendered_pages[offset * 3 + 1][1]
                third_page = rendered_pages[offset * 3 + 2][1]
                first_answers = parse_black_grid_answers_from_image(first_page, 1)
                if answer_count(first_answers) >= 5:
                    sections.append({
                        "roundNo": round_no,
                        "sessionNo": 1,
                        "answers": first_answers,
                        "questionCount": len(first_answers),
                    })
                second_answers = parse_black_grid_answers_from_image(second_page, 1)
                third_answers = parse_black_grid_answers_from_image(third_page, len(second_answers) + 1)
                combined = second_answers + third_answers
                if answer_count(combined) >= 5:
                    sections.append({
                        "roundNo": round_no,
                        "sessionNo": 2,
                        "answers": combined,
                        "questionCount": len(combined),
                    })
    return sections
# SOFTM-정답OCR 끝


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
    if len(pairs) >= 5:
        return {"kind": "answer_pairs", "pairs": pairs}
    image_sections = parse_image_answer_sections(path, text)
    if image_sections:
        return {"kind": "answer_sections", "sections": image_sections}
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

    if parsed.get("kind") == "answer_sections":
        sections = parsed.get("sections") or []
        title = nfc(question.get("questionNm"))
        session_match = re.search(r"(\d{1,2})\s*교시", title)
        session_no = int(session_match.group(1)) if session_match else None
        round_no = int(extract_exam_round(title) or 0)
        picked = None
        if session_no is not None:
            for section in sections:
                if section.get("sessionNo") == session_no and (not section.get("roundNo") or not round_no or section.get("roundNo") == round_no):
                    picked = section
                    break
        if picked is None and len(sections) == 1:
            picked = sections[0]
        if not picked:
            return None
        return answer_payload(picked.get("answers") or [], 1, "image-table-section")

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
