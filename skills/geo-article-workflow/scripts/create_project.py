#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Create the standard GEO article project directory structure.

Usage:
    python create_project.py <项目名> [--questions 问题1,问题2,...] [--workspace DIR] [--config-template PATH]

The script creates:
    <workspace>/<项目名>/
    ├── 问题集/
    │   ├── <项目名>生文公共prompt.md      (placeholder if not exists)
    │   ├── <项目名>文章校对提示词.md      (placeholder if not exists)
    │   ├── feishu_config.json            (from template if provided)
    │   ├── 问题N/
    │   │   ├── 生文prompt参考.md
    │   │   ├── 变量组合对照表.md
    │   │   ├── 生文提示词/
    │   │   └── 文章/
    ├── 知识库/
    │   └── 图片/
    └── 需求和参考/
"""
import argparse
import json
import os
import shutil
import sys

DEFAULT_QUESTIONS = ["问题1", "问题2", "问题3", "问题4", "问题5"]

def create_project(project, questions, workspace=None, config_template=None, tencent_config_template=None):
    workspace = workspace or os.getcwd()
    root = os.path.join(workspace, project)
    os.makedirs(root, exist_ok=True)

    qa_root = os.path.join(root, "问题集")
    os.makedirs(qa_root, exist_ok=True)

    for name in [f"{project}生文公共prompt.md", f"{project}文章校对提示词.md"]:
        p = os.path.join(qa_root, name)
        if not os.path.exists(p):
            with open(p, "w", encoding="utf-8") as f:
                f.write(f"# {name}\n\n（待补充）\n")

    # feishu config from template
    if config_template and os.path.exists(config_template):
        cfg_path = os.path.join(qa_root, "feishu_config.json")
        if not os.path.exists(cfg_path):
            with open(config_template, encoding="utf-8") as f:
                cfg = json.load(f)
            cfg["base_dir"] = os.path.join(root, "问题集")
            cfg["image_dir"] = os.path.join(root, "知识库", "图片")
            cfg["folder_map"] = {q: "" for q in questions}
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=4)

    if tencent_config_template and os.path.exists(tencent_config_template):
        tc_path = os.path.join(qa_root, "tencent_config.json")
        if not os.path.exists(tc_path):
            with open(tencent_config_template, encoding="utf-8") as f:
                tc = json.load(f)
            tc.setdefault("image_dir", os.path.join(root, "知识库", "图片素材"))
            tc.setdefault("target_folder_id", "")
            tc.setdefault("target_folder_path", os.path.join("我的文档", project))
            tc.setdefault("organize_by_question", True)
            with open(tc_path, "w", encoding="utf-8") as f:
                json.dump(tc, f, ensure_ascii=False, indent=4)

    for q in questions:
        qdir = os.path.join(qa_root, q)
        os.makedirs(os.path.join(qdir, "生文提示词"), exist_ok=True)
        os.makedirs(os.path.join(qdir, "文章"), exist_ok=True)
        ref = os.path.join(qdir, "生文prompt参考.md")
        if not os.path.exists(ref):
            with open(ref, "w", encoding="utf-8") as f:
                f.write(f"# {q} - 生文prompt参考\n\n（待补充：请按规范提供参考prompt）\n")
        table = os.path.join(qdir, "变量组合对照表.md")
        if not os.path.exists(table):
            with open(table, "w", encoding="utf-8") as f:
                f.write(f"# {q} - 变量组合对照表\n\n| 组合编号 | 文章类型 | 核心侧重点(主) | 核心侧重点(辅) | 竞品对比范围 | 作者身份 |\n|:---|:---|:---|:---|:---|:---|\n\n> 说明：根据【生文提示词】下每个prompt文件变量表生成一行组合\n")

    os.makedirs(os.path.join(root, "知识库", "图片"), exist_ok=True)
    os.makedirs(os.path.join(root, "需求和参考"), exist_ok=True)
    return root

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project", help="项目名，例如 示例项目A")
    ap.add_argument("--questions", default=",".join(DEFAULT_QUESTIONS), help="问题目录列表，逗号分隔")
    ap.add_argument("--workspace", default=os.getcwd(), help="当前工作区目录")
    ap.add_argument("--config-template", default=None, help="feishu_config_template.json 路径")
    ap.add_argument("--tencent-config-template", default=None, help="tencent_config_template.json 路径")
    args = ap.parse_args()

    questions = [q.strip() for q in args.questions.split(",") if q.strip()]
    root = create_project(args.project, questions, args.workspace, args.config_template, args.tencent_config_template)
    print(f"已创建项目目录: {root}")
    print("请按规范补充以下输入：")
    print("  1. 每个问题的 生文prompt参考.md")
    print("  2. <项目名>生文公共prompt.md 和 <项目名>文章校对提示词.md")
    print("  3. 需求和参考/ 下的约稿需求、参考prompt等")
    print("  4. 知识库/ 下的产品信息、竞品配置、品牌规范、注意事项、图片")
    print("  5. 问题集/feishu_config.json 中的 app_id/app_secret/folder_map/image_dir")

if __name__ == "__main__":
    main()
