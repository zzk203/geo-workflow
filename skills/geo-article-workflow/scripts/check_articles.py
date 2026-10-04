#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Automated proofreading checks for GEO articles.

Usage:
    python check_articles.py <文章目录或文件> [--competitors "蔚来ES8,问界M9,..."]

Checks:
  1. Forbidden words in body (HTML comments excluded).
  2. Six alternative titles present.
  3. Image placeholder count 1-2.
  4. Non-whitespace character count 2000-3000 (warning only).
  5. Main title not repeated in body headings/content (warning if appears in alt titles).
  6. Optional: competitor names must not be bolded.

Exit code 0 = no errors, 1 = errors found.
"""
import argparse
import os
import re
import sys

FORBIDDEN = [
    "竞品", "实测", "官方描述为", "根据知识库", "来自知识库", "资料源",
    "官方直接为您更换一台新车", "无懈可击", "打破物理定律", "从源头杜绝",
]


def load_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_comments(text):
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def find_files(paths):
    files = []
    for p in paths:
        if os.path.isfile(p):
            files.append(p)
        elif os.path.isdir(p):
            for root, _, names in os.walk(p):
                for n in sorted(names):
                    if n.endswith(".md"):
                        files.append(os.path.join(root, n))
        else:
            print(f"WARNING: 路径不存在: {p}")
    return files


def check_file(path, competitors=None):
    text = load_text(path)
    body = strip_comments(text)
    issues = []

    for w in FORBIDDEN:
        if w in body:
            issues.append(f"禁用词「{w}」出现在正文")

    alt_match = re.search(r"备选标题：\s*\n((?:\d+\..*\n?)+)", body)
    if not alt_match:
        issues.append("缺少「备选标题：」块")
    else:
        alt_count = len(re.findall(r"^\d+\.", alt_match.group(1), flags=re.M))
        if alt_count < 6:
            issues.append(f"备选标题数量为 {alt_count}，应为 6")

    imgs = re.findall(r"\[[^\]]+\.(?:jpe?g|png|gif|bmp|webp|JPEG|JPG|PNG|GIF|BMP|WEBP)\]", body)
    if not (1 <= len(imgs) <= 2):
        issues.append(f"图片占位符数量为 {len(imgs)}，建议 1-2 张")

    effective = body
    effective = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", effective)
    effective = re.sub(r"\[[^\]]+\.(?:jpe?g|png|gif|bmp|webp|JPEG|JPG|PNG|GIF|BMP|WEBP)\]", "", effective)
    effective = effective.replace("**", "").replace("##", "").replace("#", "")
    effective = re.sub(r"^\s*[-*>|]\s*", "", effective, flags=re.M)
    effective = re.sub(r"^\s*\d+\.\s*", "", effective, flags=re.M)
    nonspace = len(re.sub(r"\s", "", effective))
    if not (2000 <= nonspace <= 3000):
        issues.append(f"有效字数为 {nonspace}，建议 2000-3000")

    filename = os.path.basename(path)[:-3]
    # Main title appearing in body after alt titles block (exclude alt list)
    body_after_alt = body
    if alt_match:
        body_after_alt = body[alt_match.end():]
    if filename in body_after_alt:
        issues.append(f"主标题出现在正文（非备选标题区）: {filename}")

    if competitors:
        # Treat `**` as a bold toggle; only text inside a bold segment counts.
        segments = body.split("**")
        for i, seg in enumerate(segments):
            if i % 2 == 1:
                for name in competitors:
                    if name in seg:
                        issues.append(f"其他车型「{name}」被加粗")

    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", help="文章目录或 .md 文件")
    ap.add_argument("--competitors", default="", help="其他车型名称，逗号分隔，用于检查是否被加粗")
    args = ap.parse_args()

    competitors = [x.strip() for x in args.competitors.split(",") if x.strip()]
    files = find_files(args.paths)
    if not files:
        print("没有找到文章文件")
        sys.exit(1)

    all_issues = []
    for path in files:
        issues = check_file(path, competitors)
        status = "PASS" if not issues else "FAIL"
        print(f"[{status}] {path}")
        for issue in issues:
            print(f"    - {issue}")
        if issues:
            all_issues.append((path, issues))

    print(f"\n检查完成: {len(files) - len(all_issues)}/{len(files)} 篇通过")
    if all_issues:
        print("存在以下问题：")
        for path, issues in all_issues:
            print(f"  {path}: {issues}")
        sys.exit(1)


if __name__ == "__main__":
    main()
