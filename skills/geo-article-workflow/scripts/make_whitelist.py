#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate a Feishu import whitelist JSON from new article files.

Usage:
    python make_whitelist.py <问题目录> <文章文件...> --output whitelist.json

Example:
    python make_whitelist.py 问题1 "文章/2026年xxx.md" "文章/2026年yyy.md" --output whitelist.json
"""
import argparse
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("topic", help="问题目录名，例如 问题1")
    ap.add_argument("files", nargs="+", help="文章文件名（相对 文章/ 或相对当前目录）")
    ap.add_argument("--output", default="whitelist.json", help="输出 JSON 路径")
    args = ap.parse_args()

    entries = []
    for f in args.files:
        name = os.path.basename(f)
        entries.append([args.topic, name])

    with open(args.output, "w", encoding="utf-8") as out:
        json.dump(entries, out, ensure_ascii=False, indent=4)
    print(f"已生成白名单: {args.output} ({len(entries)} 条)")


if __name__ == "__main__":
    main()
