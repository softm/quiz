#!/usr/bin/env python3
# SOFTM-OCR 시작: 렌더 이미지 위에 정리된 OCR 텍스트 레이어를 얹어 검색 가능한 PDF 생성 - 2026-05-30
import argparse
import contextlib
import io
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from fpdf import FPDF
from fpdf.enums import TextMode
from PIL import Image


DEFAULT_FONT_CANDIDATES = [
    "~/Library/Fonts/NanumGothic.ttf",
    "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
]
CHOICE_MARKS = ["①", "②", "③", "④"]


def nfc_text(value):
    return str(value or "")


def collapse_hangul_syllable_spaces(line):
    pattern = re.compile(r"(?<![가-힣])((?:[가-힣]\s+){3,}[가-힣])(?![가-힣])")

    def repl(match):
        return re.sub(r"\s+", "", match.group(1))

    previous = None
    current = line
    while previous != current:
        previous = current
        current = pattern.sub(repl, current)
    return current


def normalize_choice_markers(text):
    return "\n".join(normalize_choice_marker_lines(text.splitlines()))


def normalize_choice_marker_lines(raw_lines, collapse=True):
    lines = []
    choice_index = 0
    marker_re = re.compile(r"(?:(?<=^)|(?<=\s))(?:Qa:?|Q@|Qo|QO|DO|OD|00|0Q|Q0|(?:[2349]0)\s*:|[O0Q@©®]\s*[).:]?|[089]\s*[).:]|4\s*[).:]|4(?=\s))(?=\s*\S)")
    # SOFTM-OCR: 90:/20:/8)/4)처럼 깨지는 선택지 표식을 순서형 원문 기호로 복구 - 2026-05-30

    for raw_line in raw_lines:
        line = raw_line.rstrip()
        if collapse:
            line = collapse_hangul_syllable_spaces(line)
        if re.match(r"^\s*\d{1,3}\s*(?:[.]|번)", line):
            choice_index = 0
            # SOFTM-OCR: OCR 선택지의 8)/4) 변형을 문항번호로 오판해 선택지 순서가 초기화되지 않게 보정 - 2026-05-30
            lines.append(line)
            continue

        def repl(_match):
            nonlocal choice_index
            if choice_index >= len(CHOICE_MARKS):
                return _match.group(0)
            mark = CHOICE_MARKS[choice_index]
            choice_index += 1
            return f"{mark} "

        lines.append(marker_re.sub(repl, line))
    return lines


def class_names(element):
    return set((element.attrib.get("class") or "").split())


def parse_bbox(title):
    match = re.search(r"\bbbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)", title or "")
    if not match:
        return None
    return tuple(int(value) for value in match.groups())


def hocr_line_text(words, line_bbox):
    # SOFTM-OCR: hOCR 음절 토큰은 가까운 bbox만 붙이고 실제 단어 간격은 보존 - 2026-05-30
    if not words:
        return ""
    _, y0, _, y1 = line_bbox
    line_h = max(1, y1 - y0)
    space_threshold = max(14, line_h * 0.62)
    parts = []
    previous = None
    no_space_before = set(".,:;!?)]}〉》」』ㆍ")
    no_space_after = set("([{〈《「『")
    for item in words:
        text = item["text"]
        if previous:
            gap = item["bbox"][0] - previous["bbox"][2]
            needs_space = gap >= space_threshold
            if text[:1] in no_space_before or previous["text"][-1:] in no_space_after:
                needs_space = False
            if needs_space:
                parts.append(" ")
        parts.append(text)
        previous = item
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def hocr_line_rows(hocr_path):
    if not hocr_path.exists() or hocr_path.stat().st_size <= 600:
        return []
    root = ET.parse(hocr_path).getroot()
    rows = []
    for line in root.iter():
        if "ocr_line" not in class_names(line):
            continue
        line_bbox = parse_bbox(line.attrib.get("title"))
        if not line_bbox:
            continue
        words = []
        for word in line.iter():
            if "ocrx_word" not in class_names(word):
                continue
            text = "".join(word.itertext()).strip()
            word_bbox = parse_bbox(word.attrib.get("title"))
            if text and word_bbox:
                words.append({"text": text, "bbox": word_bbox})
        if words:
            rows.append({"bbox": line_bbox, "text": hocr_line_text(words, line_bbox)})
    normalized = normalize_choice_marker_lines([row["text"] for row in rows], collapse=False)
    for row, text in zip(rows, normalized):
        row["text"] = text
    return [row for row in rows if row["text"].strip()]


def add_hocr_text_layer(pdf, hocr_path, page_w, page_h, image_w, image_h):
    # SOFTM-OCR: hOCR bbox 좌표에 맞춰 invisible 텍스트 레이어를 얹어 PDF 선택 영역 어긋남 보정 - 2026-05-30
    rows = hocr_line_rows(hocr_path)
    if not rows:
        return False
    scale_x = page_w / image_w
    scale_y = page_h / image_h
    with pdf.local_context(text_mode=TextMode.INVISIBLE):
        for row in rows:
            x0, y0, x1, y1 = row["bbox"]
            text = row["text"][:240]
            x = max(0, x0 * scale_x)
            y_top = max(0, y0 * scale_y)
            y_bottom = min(page_h, y1 * scale_y)
            line_h = max(4.8, y_bottom - y_top)
            font_size = max(5.0, min(12.0, line_h * 0.68))
            baseline = min(page_h - 2, y_bottom - max(0.8, line_h * 0.16))
            pdf.set_font("KOR", "", font_size)
            pdf.text(x, baseline, text)
    return True


def add_text_layer(pdf, text, page_w, page_h):
    lines = [line for line in normalize_choice_markers(text).splitlines()]
    if not lines:
        return
    pdf.set_font("KOR", "", 7)
    line_h = max(6.2, min(9.0, (page_h - 36) / max(1, len(lines))))
    y = 18
    with pdf.local_context(text_mode=TextMode.INVISIBLE):
        for line in lines:
            if y > page_h - 8:
                break
            pdf.text(18, y, line[:220])
            y += line_h


def resolve_font(font_path):
    candidates = [font_path] if font_path else DEFAULT_FONT_CANDIDATES
    for candidate in candidates:
        path = Path(os.path.expanduser(candidate))
        if path.exists():
            return path
    raise RuntimeError("OCR 텍스트 레이어에 사용할 한글 폰트를 찾을 수 없습니다.")


def build_pdf(work_dir, output_pdf, dpi, font_path):
    work = Path(work_dir)
    images = sorted([path for path in work.glob("page-*.png") if re.fullmatch(r"page-\d+\.png", path.name)], key=lambda path: path.name)
    if not images:
        raise RuntimeError("OCR 렌더 이미지가 없습니다.")

    pdf = FPDF(unit="pt")
    pdf.set_auto_page_break(False)
    font = resolve_font(font_path)
    if font.suffix.lower() == ".ttc":
        pdf.add_font("KOR", "", font, collection_font_number=0)
    else:
        pdf.add_font("KOR", "", font)

    for image_path in images:
        stem_no = image_path.stem.split("-")[-1]
        text_path = work / f"ocr-{int(stem_no):04d}.txt"
        hocr_path = work / f"ocr-{int(stem_no):04d}.hocr"
        with Image.open(image_path) as img:
            page_w = img.width / dpi * 72
            page_h = img.height / dpi * 72
            image_w = img.width
            image_h = img.height
        pdf.add_page(format=(page_w, page_h))
        pdf.image(str(image_path), x=0, y=0, w=page_w, h=page_h)
        if not add_hocr_text_layer(pdf, hocr_path, page_w, page_h, image_w, image_h):
            text = text_path.read_text(encoding="utf-8", errors="ignore") if text_path.exists() else ""
            add_text_layer(pdf, text, page_w, page_h)

    Path(output_pdf).parent.mkdir(parents=True, exist_ok=True)
    with contextlib.redirect_stderr(io.StringIO()):
        pdf.output(output_pdf)


def main():
    parser = argparse.ArgumentParser(description="렌더 이미지와 OCR txt로 검색 가능한 PDF를 생성합니다.")
    parser.add_argument("work_dir")
    parser.add_argument("output_pdf")
    parser.add_argument("--dpi", type=float, default=300)
    parser.add_argument("--font", default=os.environ.get("QUIZ_OCR_FONT", ""))
    args = parser.parse_args()
    build_pdf(args.work_dir, args.output_pdf, args.dpi, args.font)


if __name__ == "__main__":
    main()
# SOFTM-OCR 끝
