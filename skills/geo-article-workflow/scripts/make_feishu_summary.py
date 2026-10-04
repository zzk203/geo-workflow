#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate a Feishu import summary markdown table from a JSON list.

Input JSON format:
    [
      {"优化问题": "大型纯电豪华SUV推荐", "文章链接": "https://..."},
      ...
    ]

Usage:
    python make_feishu_summary.py links.json --output 飞书导入汇总.md
"""
import argparse
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json", help="JSON 文件，元素包含 优化问题 和 文章链接")
    ap.add_argument("--output", default="飞书导入汇总.md", help="输出 markdown 路径")
    args = ap.parse_args()

    with open(args.json, encoding="utf-8") as f:
        rows = json.load(f)

    lines = ["| 优化问题 | 文章链接 |", "|---|---|"]
    for row in rows:
        lines.append(f"| {row['优化问题']} | {row['文章链接']} |")

    with open(args.output, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"已生成: {args.output} ({len(rows)} 行)")


if __name__ == "__main__":
    main()
