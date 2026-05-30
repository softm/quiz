#!/usr/bin/env python3
# SOFTM-GEN 시작: pdf 디렉토리명 기준 category/group manifest 생성 - 2026-05-29
import argparse

from pdf_manifest_lib import JSON_ROOT, build_category_rows, write_json


def main():
    parser = argparse.ArgumentParser(description="pdf 디렉토리 구조로 category.json을 생성합니다.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    groups, categories, _dir_to_cat = build_category_rows()
    write_json(JSON_ROOT / "group.json", groups, args.dry_run)
    write_json(JSON_ROOT / "category.json", categories, args.dry_run)
    print(f"[OK] groups={len(groups)} categories={len(categories)}")


if __name__ == "__main__":
    main()
# SOFTM-GEN 끝
