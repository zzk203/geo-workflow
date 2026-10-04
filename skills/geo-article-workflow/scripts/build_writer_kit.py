#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为子代理生成「任务书」：一份自包含的单文件材料包。

背景：
    让子代理依次去读 规范文件 + 知识库 + 核心信息 + 问题参考 + 骨架模板，
    每个代理要多花 5-8 轮工具调用，而每一轮都要重新背一遍已经涨到 ~9 万 token 的上下文。
    实测文章生成组每个代理 42 次调用、输出 6.8 万 token，其中约 85% 不是交付物内容。

    把材料拼成一份任务书后，子代理只需要「读一个文件 → 写文件 → 回一行」。

用法：
    python build_writer_kit.py \
      --project "<项目根>" \
      --facts   "<本轮事实卡.md>" [--facts ...] \
      --tasks   "问题集/问题1/生文提示词/生文prompt9.md" [...] \
      --kind    article \
      --outdir  "任务书"

    # 只想看一份长什么样，不落盘：
    python build_writer_kit.py --project ... --facts ... \
      --tasks "问题集/问题1/生文提示词/生文prompt9.md" --kind article --print
"""
import argparse
import os
import re
import sys

CONTRACT_ARTICLE = """# 任务契约（先读这一段，再读下面的材料）

你是本项目的汽车内容作者。本轮你只做一件事：**按下文那份 prompt，写出完整的一篇文章**。

工作方式（请严格遵守。原因：每一轮回复都计费，多余的说明会显著抬高成本，
而这些成本对文章质量没有任何贡献）：

1. **只读本任务书这一个文件。** 不要 ls、不要 grep、不要读其他任何文件——下面的材料已经齐了。
2. 不要输出计划、复述、解释、总结或进度汇报；除工具调用外，每次回复不超过一行。
3. **一次性把文章写完**（一次 write）。不要先列大纲再分段追加，不要写完再回读检查。
4. 全部完成后只回一行：`文件路径 | 有效字数`。
"""

CONTRACT_PROMPT = """# 任务契约（先读这一段，再读下面的材料）

你是本项目的生文prompt撰写员。本轮你只做一件事：**按下文的变量配置与骨架模板，
写出一个 `生文prompt<N>.md` 文件**。

工作方式（请严格遵守。原因：每一轮回复都计费，多余的说明会显著抬高成本）：

1. **只读本任务书这一个文件。** 不要 ls、不要 grep、不要读其他任何文件——下面的材料已经齐了。
2. 不要输出计划、复述、解释、总结或进度汇报；除工具调用外，每次回复不超过一行。
3. **一次性把文件写完**（一次 write）。不要先列提纲再分段追加，不要写完再回读检查。
4. 骨架、章节顺序、字段名一律沿用模板；只替换变量值与问题相关内容。
5. 全部完成后只回一行：`文件路径 | 行数`。
"""


def parse_prompt_no(path):
    m = re.search(r"生文prompt(\d+)", os.path.basename(path))
    return m.group(1) if m else None


def question_of(prompt_path):
    """从 .../问题集/<问题>/生文提示词/生文promptN.md 反推问题名。"""
    d = os.path.dirname(os.path.abspath(prompt_path))
    if os.path.basename(d) in ("生文提示词", "生文提示词/"):
        return os.path.basename(os.path.dirname(d))
    return os.path.basename(os.path.dirname(d))


def build_kit(project, facts, prompt_path, kind):
    q = question_of(prompt_path)
    no = parse_prompt_no(prompt_path)
    prompt_text = open(prompt_path, encoding="utf-8").read().strip()

    parts = []
    parts.append(CONTRACT_ARTICLE if kind == "article" else CONTRACT_PROMPT)

    parts.append("\n---\n\n# 材料 A：本轮事实卡（最高优先级的口径与红线）\n")
    for i, f in enumerate(facts, 1):
        parts.append(f"## A{i}. {os.path.basename(f)}\n")
        parts.append(open(f, encoding="utf-8").read().strip())
        parts.append("")

    parts.append(f"\n---\n\n# 材料 B：本篇 prompt（逐字执行，不得改动其中的口径）\n")
    parts.append(f"来源：`{os.path.abspath(prompt_path)}`\n")
    parts.append(prompt_text)

    if kind == "article":
        out_dir = os.path.join(project, "问题集", q, "文章")
        parts.append("\n---\n\n# 输出要求\n")
        parts.append(f"- 优化问题：{q}")
        parts.append(f"- 本篇 prompt：生文prompt{no}")
        parts.append(f"- 输出目录：`{out_dir}`（该目录已存在，不要创建新目录）")
        existing = sorted(f for f in os.listdir(out_dir) if f.endswith(".md")) if os.path.isdir(out_dir) else []
        parts.append(f"- 文件名 = **主标题 + `.md`**，不得与下列已有文件重名（已替你列好，无需再 ls）：")
        if existing:
            parts.extend(f"  - {name}" for name in existing)
        else:
            parts.append("  - （目录当前为空）")
        parts.append("- 写完后只回一行：`文件路径 | 有效字数`（有效字数＝去掉图片语法、`#`、`**`、列表符号后的字符数）。")
    else:
        out_dir = os.path.join(project, "问题集", q, "生文提示词")
        parts.append("\n---\n\n# 输出要求\n")
        parts.append(f"- 优化问题：{q}")
        parts.append(f"- 输出文件：`{os.path.join(out_dir, f'生文prompt{no}.md')}`")
        existing = sorted(f for f in os.listdir(out_dir) if f.endswith(".md")) if os.path.isdir(out_dir) else []
        parts.append("- **不要**覆盖同目录下任何已有文件（已替你列好，无需再 ls）：")
        if existing:
            parts.extend(f"  - {name}" for name in existing)
        else:
            parts.append("  - （目录当前为空）")
        parts.append("- **不要**修改 `变量组合对照表.md`。")
        parts.append("- 写完后只回一行：`文件路径 | 行数`。")

    return "\n".join(parts).rstrip() + "\n", q, no


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="项目根目录（绝对路径最佳）")
    ap.add_argument("--facts", action="append", default=[], help="事实卡文件，可重复传入")
    ap.add_argument("--tasks", nargs="+", required=True, help="要处理的生文prompt文件")
    ap.add_argument("--kind", choices=["article", "prompt"], default="article")
    ap.add_argument("--outdir", default="任务书", help="任务书输出目录（相对 --project）")
    ap.add_argument("--print", action="store_true", help="打印到标准输出，不落盘（仅支持单个 --tasks）")
    args = ap.parse_args()

    project = os.path.abspath(args.project)
    facts = [os.path.abspath(f) for f in args.facts]

    missing = [f for f in facts if not os.path.exists(f)]
    if missing:
        print(f"[错误] 事实卡不存在：{missing}", file=sys.stderr)
        return 2

    if args.print and len(args.tasks) == 1:
        kit, q, no = build_kit(project, facts, args.tasks[0], args.kind)
        sys.stdout.write(kit)
        return 0

    outdir = os.path.join(project, args.outdir)
    os.makedirs(outdir, exist_ok=True)

    written = []
    for t in args.tasks:
        if not os.path.exists(t):
            print(f"[跳过] 不存在：{t}", file=sys.stderr)
            continue
        kit, q, no = build_kit(project, facts, t, args.kind)
        ext = ".md"
        out = os.path.join(outdir, f"{q}_prompt{no}{ext}")
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(kit)
        written.append((out, len(kit.encode("utf-8"))))

    if not written:
        print("[错误] 没有生成任何任务书", file=sys.stderr)
        return 1

    total = sum(sz for _, sz in written)
    print(f"已生成 {len(written)} 份任务书 → {outdir}")
    for out, sz in written:
        print(f"  {os.path.basename(out):<44} {sz/1024:6.1f} KB")
    print(f"  合计 {total/1024:.1f} KB，平均 {total/len(written)/1024:.1f} KB/份")
    print()
    print("下发子代理时，任务书只需一句话：")
    print('  读 "<任务书绝对路径>"，严格照它执行。只读这一个文件，不要 ls/grep/读其他文件；')
    print("  不要输出计划或总结。写完只回一行：文件路径 | 关键指标。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
