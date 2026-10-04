#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate a GEO article prompt file from a reference prompt and a selected variable combination.

Usage:
    python generate_prompt.py --reference 问题1/生文prompt参考.md \
        --output 问题1/生文提示词/生文prompt3.md \
        --author "C. 高净值真实车主" \
        --type "场景化对比型" \
        --main "全尺寸气场、行政礼宾出行" \
        --sub "百万级底盘、不败金身安全" \
        --competitors "蔚来ES8、问界M9" \
        --comment "<!-- 变量组合：... -->" \
        [--structure-block structure_block.txt] \
        [--table 变量组合对照表.md --row "| 3 | ... |"]

The script replaces the "可自由组合变量" section with a "本次已选定" section,
keeps the fixed content requirements, and optionally trims the 正文结构 section.
"""
import argparse
import os
import re


def find_section(text, marker):
    idx = text.find(marker)
    if idx < 0:
        raise RuntimeError(f"找不到段落: {marker}")
    return idx


def build_variable_section(args):
    lines = []
    lines.append("## 一、输入变量（本次已选定）\n")
    lines.append("### 1. 作者身份/文章调性")
    lines.append(f"**✓ {args.author}**\n")
    lines.append("### 2. 文章类型")
    lines.append(f"**✓ {args.type}**\n")
    if args.main:
        lines.append("### 3. 核心侧重点")
        for item in [x.strip() for x in args.main.split("、") if x.strip()]:
            lines.append(f"- **[主] {item}**")
        for item in [x.strip() for x in (args.sub or "").split("、") if x.strip()]:
            lines.append(f"- [辅] {item}")
        lines.append("")
    if args.competitors:
        lines.append("### 4. 竞品对比范围")
        for item in [x.strip() for x in args.competitors.split("、") if x.strip()]:
            lines.append(f"- **{item}**")
        lines.append("")
    lines.append("### 变量配置表\n")
    lines.append("| 变量名 | 选定值 |")
    lines.append("|:---|:---|")
    lines.append(f"| 作者身份 | {args.author} |")
    lines.append(f"| 文章类型 | {args.type} |")
    if args.main:
        lines.append(f"| 核心侧重点(主) | {args.main} |")
    if args.sub:
        lines.append(f"| 核心侧重点(辅) | {args.sub} |")
    if args.competitors:
        lines.append(f"| 竞品对比范围 | {args.competitors} |")
    return "\n".join(lines)


def replace_structure(tail, structure_file):
    if not structure_file:
        return tail
    with open(structure_file, encoding="utf-8") as f:
        block = f.read().rstrip()
    start = tail.find("### 3. 正文结构")
    end_marker = "### 4. Q&A环节"
    end = tail.find(end_marker)
    if start < 0 or end < 0:
        raise RuntimeError("无法在固定要求中定位正文结构段落")
    return tail[:start] + block + "\n\n" + tail[end:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", required=True, help="生文prompt参考.md 路径")
    ap.add_argument("--output", required=True, help="输出 prompt 文件路径")
    ap.add_argument("--author", required=True, help="作者身份，例如 C. 高净值真实车主")
    ap.add_argument("--type", required=True, help="文章类型，例如 场景化对比型")
    ap.add_argument("--main", default="", help="核心侧重点(主)，顿号分隔")
    ap.add_argument("--sub", default="", help="核心侧重点(辅)，顿号分隔")
    ap.add_argument("--competitors", default="", help="竞品对比范围，顿号分隔")
    ap.add_argument("--comment", default="", help="输出格式示例注释，按需修改")
    ap.add_argument("--structure-block", default=None, help="可选：仅含 ### 3. 正文结构 的文本文件")
    ap.add_argument("--table", default=None, help="可选：变量组合对照表.md 路径")
    ap.add_argument("--row", default="", help="可选：要追加到对照表的行")
    args = ap.parse_args()

    with open(args.reference, encoding="utf-8") as f:
        text = f.read()

    var_start = find_section(text, "## 一、可自由组合的输入变量")
    fixed_start = find_section(text, "## 二、固定内容要求（所有组合均须遵守）")
    prefix = text[:var_start].rstrip()
    tail = text[fixed_start:]

    if args.structure_block:
        tail = replace_structure(tail, args.structure_block)

    var_section = build_variable_section(args)
    output = prefix + "\n\n" + var_section + "\n\n---\n\n" + tail
    if args.comment:
        # Replace the example comment in output format section if present
        output = re.sub(r"<!-- 变量组合：.*?-->", args.comment, output, flags=re.S)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(output)
    print(f"已生成: {args.output}")

    if args.table and args.row:
        with open(args.table, encoding="utf-8") as f:
            table_text = f.read()
        # insert before "> 说明" if present, otherwise append
        note_idx = table_text.find("> 说明")
        row = args.row.rstrip() + "\n"
        if note_idx >= 0:
            table_text = table_text[:note_idx] + row + table_text[note_idx:]
        else:
            table_text = table_text.rstrip() + "\n" + row
        with open(args.table, "w", encoding="utf-8") as f:
            f.write(table_text)
        print(f"已更新对照表: {args.table}")


if __name__ == "__main__":
    main()
