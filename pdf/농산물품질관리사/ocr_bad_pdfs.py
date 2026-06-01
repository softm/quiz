#!/usr/bin/env python3
"""Find PDFs with missing or poor text layers and OCR them.

The script uses external PDF/OCR tools:
  - pdfinfo
  - pdftotext
  - ocrmypdf

By default it writes OCR results next to the original as "<name>_ocr.pdf".
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


HANGUL_RE = re.compile(r"[\uac00-\ud7a3]")
ALNUM_RE = re.compile(r"[A-Za-z0-9\uac00-\ud7a3]")


@dataclass
class PdfMetrics:
    path: Path
    pages: int
    chars: int
    hangul: int
    alnum: int
    replacement_chars: int

    @property
    def chars_per_page(self) -> float:
        return self.chars / self.pages if self.pages else 0.0

    @property
    def hangul_per_page(self) -> float:
        return self.hangul / self.pages if self.pages else 0.0

    @property
    def hangul_ratio(self) -> float:
        return self.hangul / self.alnum if self.alnum else 0.0


def run_text(cmd: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        check=check,
    )


def require_tools(names: list[str]) -> None:
    missing = [name for name in names if shutil.which(name) is None]
    if missing:
        joined = ", ".join(missing)
        raise SystemExit(f"Missing required command(s): {joined}")


def get_page_count(pdf: Path) -> int:
    result = run_text(["pdfinfo", str(pdf)])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "pdfinfo failed")

    for line in result.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())

    raise RuntimeError("pdfinfo did not report page count")


def extract_text(pdf: Path) -> str:
    result = run_text(["pdftotext", "-q", str(pdf), "-"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "pdftotext failed")
    return result.stdout


def measure_pdf(pdf: Path) -> PdfMetrics:
    pages = get_page_count(pdf)
    text = extract_text(pdf)
    stripped = text.strip()
    return PdfMetrics(
        path=pdf,
        pages=pages,
        chars=len(stripped),
        hangul=len(HANGUL_RE.findall(stripped)),
        alnum=len(ALNUM_RE.findall(stripped)),
        replacement_chars=stripped.count("\ufffd"),
    )


def detect_bad_ocr(metrics: PdfMetrics, args: argparse.Namespace) -> list[str]:
    reasons: list[str] = []

    if metrics.pages >= args.multi_page_min_pages:
        if metrics.chars_per_page < args.min_chars_per_page:
            reasons.append(
                f"low text/page {metrics.chars_per_page:.1f} < {args.min_chars_per_page}"
            )

        if (
            metrics.chars_per_page < args.suspect_chars_per_page
            and metrics.hangul_per_page < args.min_hangul_per_page
        ):
            reasons.append(
                "low Korean text/page "
                f"{metrics.hangul_per_page:.1f} < {args.min_hangul_per_page}"
            )

        if (
            metrics.chars_per_page < args.suspect_chars_per_page
            and metrics.alnum > 0
            and metrics.hangul_ratio < args.min_hangul_ratio
        ):
            reasons.append(
                f"low Korean ratio {metrics.hangul_ratio:.2f} < {args.min_hangul_ratio}"
            )

    if metrics.replacement_chars >= args.max_replacement_chars:
        reasons.append(f"many replacement chars {metrics.replacement_chars}")

    return reasons


def iter_pdfs(root: Path, recursive: bool, suffix: str) -> list[Path]:
    pattern = "**/*.pdf" if recursive else "*.pdf"
    pdfs = sorted(root.glob(pattern), key=lambda path: str(path).casefold())
    return [pdf for pdf in pdfs if not pdf.stem.endswith(suffix)]


def output_path_for(pdf: Path, suffix: str) -> Path:
    return pdf.with_name(f"{pdf.stem}{suffix}{pdf.suffix}")


def run_ocr(src: Path, dst: Path, args: argparse.Namespace) -> None:
    cmd = [
        "ocrmypdf",
        "-l",
        args.lang,
    ]

    if args.mode == "force":
        cmd.append("--force-ocr")
    elif args.mode == "redo":
        cmd.append("--redo-ocr")
    elif args.mode == "skip":
        cmd.append("--skip-text")

    cmd.extend(
        [
            "--tesseract-pagesegmode",
            str(args.pagesegmode),
            "--rotate-pages",
            "--deskew",
            "--output-type",
            "pdf",
            "--optimize",
            str(args.optimize),
            "--jobs",
            str(args.jobs),
            str(src),
            str(dst),
        ]
    )

    print(f"OCR  {src.name} -> {dst.name}", flush=True)
    process = subprocess.Popen(cmd, text=True)
    started_at = time.monotonic()

    while process.poll() is None:
        time.sleep(15)
        elapsed = int(time.monotonic() - started_at)
        print(f"WAIT  OCR still running ({elapsed}s)", flush=True)

    if process.returncode != 0:
        raise RuntimeError(f"ocrmypdf failed with exit code {process.returncode}")


def replace_original(src: Path, ocr_pdf: Path, backup_suffix: str) -> None:
    backup = src.with_name(f"{src.name}{backup_suffix}")
    if backup.exists():
        raise RuntimeError(f"backup already exists: {backup.name}")

    src.rename(backup)
    ocr_pdf.rename(src)
    print(f"REPLACE  {src.name} (backup: {backup.name})")


def print_metrics(prefix: str, metrics: PdfMetrics, reasons: list[str] | None = None) -> None:
    reason_text = f"  reasons={'; '.join(reasons)}" if reasons else ""
    print(
        f"{prefix}  pages={metrics.pages} chars={metrics.chars} "
        f"chars/page={metrics.chars_per_page:.1f} hangul={metrics.hangul} "
        f"hangul/page={metrics.hangul_per_page:.1f} "
        f"hangul_ratio={metrics.hangul_ratio:.2f}  {metrics.path.name}{reason_text}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="OCR PDFs that have missing or poor text layers."
    )
    parser.add_argument("target", nargs="?", default=".", help="PDF file or directory to scan")
    parser.add_argument("--recursive", action="store_true", help="scan subdirectories")
    parser.add_argument("--dry-run", action="store_true", help="only report targets")
    parser.add_argument("--force-all", action="store_true", help="OCR every scanned PDF")
    parser.add_argument("--overwrite", action="store_true", help="overwrite existing output files")
    parser.add_argument(
        "--replace-original",
        action="store_true",
        help="replace original PDF after successful OCR, keeping a .bak backup",
    )
    parser.add_argument("--backup-suffix", default=".bak", help="backup suffix for --replace-original")
    parser.add_argument("--suffix", default="_ocr", help="output filename suffix")
    parser.add_argument("--lang", default="kor+eng", help="Tesseract languages")
    parser.add_argument(
        "--mode",
        choices=["force", "redo", "skip"],
        default="force",
        help="ocrmypdf OCR mode",
    )
    parser.add_argument("--jobs", type=int, default=4, help="ocrmypdf worker count")
    parser.add_argument(
        "--pagesegmode",
        type=int,
        default=6,
        help="Tesseract page segmentation mode; 6 worked well for these exam PDFs",
    )
    parser.add_argument("--optimize", type=int, default=1, choices=[0, 1, 2, 3])

    parser.add_argument("--multi-page-min-pages", type=int, default=2)
    parser.add_argument("--min-chars-per-page", type=float, default=80.0)
    parser.add_argument("--suspect-chars-per-page", type=float, default=500.0)
    parser.add_argument("--min-hangul-per-page", type=float, default=80.0)
    parser.add_argument("--min-hangul-ratio", type=float, default=0.12)
    parser.add_argument("--max-replacement-chars", type=int, default=20)
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    target = Path(args.target).expanduser().resolve()

    if not target.exists():
        print(f"Not found: {target}", file=sys.stderr)
        return 2

    require_tools(["pdfinfo", "pdftotext", "ocrmypdf"])

    if target.is_file():
        if target.suffix.lower() != ".pdf":
            print(f"Not a PDF file: {target}", file=sys.stderr)
            return 2
        pdfs = [target]
    elif target.is_dir():
        pdfs = iter_pdfs(target, args.recursive, args.suffix)
    else:
        print(f"Not a file or directory: {target}", file=sys.stderr)
        return 2
    if not pdfs:
        print("No PDFs found.")
        return 0

    targets: list[tuple[Path, PdfMetrics, list[str]]] = []
    failures = 0

    for pdf in pdfs:
        try:
            metrics = measure_pdf(pdf)
            reasons = ["forced"] if args.force_all else detect_bad_ocr(metrics, args)
            if reasons:
                print_metrics("BAD ", metrics, reasons)
                targets.append((pdf, metrics, reasons))
            else:
                print_metrics("OK  ", metrics)
        except Exception as exc:
            failures += 1
            print(f"ERROR  {pdf.name}: {exc}", file=sys.stderr)

    if not targets:
        print("No OCR targets detected.")
        return 1 if failures else 0

    if args.dry_run:
        print(f"Dry run: {len(targets)} target(s), no files written.")
        return 1 if failures else 0

    for pdf, _metrics, _reasons in targets:
        dst = output_path_for(pdf, args.suffix)
        if dst.exists() and not args.overwrite:
            print(f"SKIP  output exists: {dst.name}")
            continue

        try:
            run_ocr(pdf, dst, args)
            after = measure_pdf(dst)
            after_reasons = detect_bad_ocr(after, args)
            print_metrics("DONE", after, after_reasons)

            if args.replace_original:
                replace_original(pdf, dst, args.backup_suffix)
        except Exception as exc:
            failures += 1
            print(f"ERROR  {pdf.name}: {exc}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
