#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Import GEO articles to Tencent Docs as native online docs.

Usage:
    python scripts/tencent_import.py \
        -c tencent_config.json \
        --articles "问题1/文章" "问题2/文章" ... \
        [--image-dir "项目/知识库/图片素材"] \
        [--docx-dir "项目/文章_docx"] \
        [--no-move]

Config file fields:
    client_id, access_token, open_id,
    target_folder_id, target_folder_path, permission,
    image_dir, docx_dir, organize_by_question,
    results_md, results_json

The script converts .md articles to .docx (with images embedded), imports them
as native Tencent online docs (NOT drive files), sets publicWrite permission,
and optionally moves them into `target_folder_id/问题N/` subfolders.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
import time

try:
    import requests
except ImportError:
    print("错误：需要 requests 库。请执行 pip install requests")
    sys.exit(1)

try:
    import docx
    from docx.shared import Pt, Inches, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml.ns import qn
except ImportError:
    print("错误：需要 python-docx 库。请执行 pip install python-docx")
    sys.exit(1)

BASE_URL = "https://docs.qq.com"


# ---------------- md -> docx ----------------

def _set_run_font(run, size=None, bold=None, name="微软雅黑", black=True):
    """设置 run 的中英文字体、字号、加粗和纯黑颜色。"""
    if name:
        run.font.name = name
        rpr = run._element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = rpr.makeelement(qn("w:rFonts"), {})
            rpr.append(rfonts)
        rfonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if black:
        run.font.color.rgb = RGBColor(0, 0, 0)


def _set_base_font(doc):
    style = doc.styles["Normal"]
    style.font.name = "微软雅黑"
    style.font.size = Pt(12)
    style.font.color.rgb = RGBColor(0, 0, 0)
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), "微软雅黑")
    # 内置标题样式默认带蓝色主题色，统一改成纯黑，避免多级标题导入后显示蓝色
    for style_name in ("Title", "Heading 1", "Heading 2", "Heading 3"):
        try:
            doc.styles[style_name].font.color.rgb = RGBColor(0, 0, 0)
        except KeyError:
            pass


def _iter_inline_bold(text):
    """把段落中的 **加粗** 拆成 (文本, 是否加粗) 片段，去除 md 星号。"""
    for seg in re.split(r"(\*\*.+?\*\*)", text):
        if not seg:
            continue
        if seg.startswith("**") and seg.endswith("**") and len(seg) > 4:
            yield seg[2:-2], True
        else:
            yield seg, False


def _find_image(name, image_root):
    name = name.strip()
    if os.path.isabs(name) and os.path.exists(name):
        return name
    candidate = os.path.join(image_root, name)
    if os.path.exists(candidate):
        return candidate
    base = os.path.basename(name)
    for root, _, files in os.walk(image_root):
        if base in files:
            return os.path.join(root, base)
    return None


def _add_image(doc, path, width_inches=6.0):
    try:
        doc.add_picture(path, width=Inches(width_inches))
        doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    except Exception:
        p = doc.add_paragraph(f"[图片缺失: {os.path.basename(path)}]")
        p.runs[0].font.color.rgb = RGBColor(0xFF, 0x00, 0x00)


def _add_para(doc, text, bold=False, size=12):
    p = doc.add_paragraph()
    p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
    for seg, seg_bold in _iter_inline_bold(text):
        run = p.add_run(seg)
        _set_run_font(run, size=size, bold=bold or seg_bold)
    return p


def _add_heading(doc, text, level):
    h = doc.add_heading("", level=level)
    for seg, _seg_bold in _iter_inline_bold(text):
        run = h.add_run(seg)
        _set_run_font(run, size=16 if level == 1 else 14)
    return h


def _is_table_separator(line):
    return bool(re.match(r"^\s*\|[\s:\-|]+\|\s*$", line)) and "-" in line


def _parse_md_table(lines, i):
    header = [c.strip() for c in lines[i].strip().strip("|").split("|")]
    j = i + 2
    rows = []
    while j < len(lines) and lines[j].strip().startswith("|"):
        rows.append([c.strip() for c in lines[j].strip().strip("|").split("|")])
        j += 1
    return header, rows, j


def md_to_docx(md_path, docx_path, image_root):
    with open(md_path, encoding="utf-8") as f:
        raw = f.read()
    raw = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    lines = raw.split("\n")
    doc = docx.Document()
    _set_base_font(doc)
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            i += 1
            continue
        if line.lstrip().startswith("|") and i + 1 < len(lines) and _is_table_separator(lines[i + 1]):
            header, rows, next_i = _parse_md_table(lines, i)
            table = doc.add_table(rows=1, cols=len(header))
            table.style = "Light Grid Accent 1"
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            for ci, htext in enumerate(header):
                cell = table.rows[0].cells[ci]
                cell.text = ""
                for seg, _seg_bold in _iter_inline_bold(htext):
                    run = cell.paragraphs[0].add_run(seg)
                    _set_run_font(run, size=10, bold=True)
            for row in rows:
                cells = table.add_row().cells
                for ci, val in enumerate(row):
                    if ci < len(cells):
                        cells[ci].text = ""
                        for seg, seg_bold in _iter_inline_bold(val):
                            run = cells[ci].paragraphs[0].add_run(seg)
                            _set_run_font(run, size=10, bold=seg_bold)
            doc.add_paragraph()
            i = next_i
            continue
        m = re.match(r"^\s*\[([^\]]+\.(?:png|jpe?g|gif|bmp|webp|JPG|JPEG|PNG|GIF|BMP|WEBP))\]\s*$", line)
        if m:
            path = _find_image(m.group(1), image_root)
            if path:
                _add_image(doc, path)
            else:
                _add_para(doc, f"[图片缺失: {m.group(1)}]")
            i += 1
            continue
        if line.startswith("### "):
            _add_heading(doc, line[4:].strip(), level=2)
            i += 1
            continue
        if line.startswith("## "):
            _add_heading(doc, line[3:].strip(), level=1)
            i += 1
            continue
        if line.startswith("# "):
            i += 1
            continue
        if line.startswith("备选标题："):
            _add_para(doc, line, bold=True)
            i += 1
            continue
        if re.match(r"^\d+\.\s", line):
            _add_para(doc, line)
            i += 1
            continue
        _add_para(doc, line)
        i += 1
    os.makedirs(os.path.dirname(os.path.abspath(docx_path)), exist_ok=True)
    doc.save(docx_path)


# ---------------- Tencent API ----------------

def _api(headers, method, path, **kwargs):
    r = requests.request(method, BASE_URL + path, headers=headers, timeout=90, **kwargs)
    r.raise_for_status()
    j = r.json()
    if j.get("ret") != 0:
        raise RuntimeError(f"{method} {path} failed: {j}")
    return j


def _md5_file(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _import_online_doc(headers, path, parent_folder_id=None):
    name = os.path.basename(path)
    md5 = _md5_file(path)
    size = os.path.getsize(path)
    # 不传 uploadType=drive，导入为原生在线文档
    j = _api(headers, "POST", "/openapi/drive/v2/files/upload",
             data={"fileMD5": md5, "fileName": name, "fileSize": str(size)})
    d = j["data"]
    with open(path, "rb") as f:
        r = requests.put(d["COSPutURL"], data=f, headers=dict(d.get("CustomHeader", {})), timeout=300)
        r.raise_for_status()
    data = {"fileMD5": md5, "fileName": name, "COSFileKey": d["COSFileKey"]}
    if parent_folder_id:
        data["parent"] = parent_folder_id
    j2 = _api(headers, "POST", "/openapi/drive/v2/files/async-import", data=data)
    pqid = j2["data"]["progressQueryID"]
    deadline = time.time() + 240
    while time.time() < deadline:
        time.sleep(3)
        j3 = _api(headers, "GET", "/openapi/drive/v2/files/import-progress",
                  params={"progressQueryID": pqid})
        info = j3.get("data", {})
        if info.get("progress") == 100:
            return info
    raise TimeoutError(f"导入超时: {name}")


def _set_permission(headers, file_id, policy="publicWrite"):
    _api(headers, "PATCH", f"/openapi/drive/v2/files/{file_id}/permission",
         data={"policy": policy, "copyEnabled": "true",
               "readerCommentEnabled": "true", "writerCommentEnabled": "true"})


def _list_folder(headers, folder_id):
    j = _api(headers, "GET", f"/openapi/drive/v2/folders/{folder_id}?limit=50")
    return j.get("data", {}).get("list", [])


def _create_folder(headers, title, parent_id=None):
    data = {"title": title}
    if parent_id:
        data["parentFolderID"] = parent_id
    j = _api(headers, "POST", "/openapi/drive/v2/folders", data=data)
    return j["data"]["ID"]


def _move_file(headers, file_id, target_folder_id):
    _api(headers, "PATCH", f"/openapi/drive/v2/files/{file_id}/move",
         data={"targetFolderID": target_folder_id, "parentFolderID": "/"})


def _move_folder(headers, folder_id, target_folder_id):
    _api(headers, "POST", f"/openapi/drive/v2/folders/{folder_id}/move",
         data={"parentFolderID": "/", "targetFolderID": target_folder_id})


def _ensure_subfolder(headers, parent_folder_id, title):
    for it in _list_folder(headers, parent_folder_id):
        if it.get("type") == "folder" and it.get("title") == title:
            return it["ID"]
    fid = _create_folder(headers, title, parent_id=parent_folder_id)
    # 某些情况下 create 会创建到根目录，需要再移动一次确保在目标目录下
    meta = _api(headers, "GET", f"/openapi/drive/v2/folders/{fid}/metadata")
    if meta.get("data", {}).get("folderInfo", {}).get("parentID", "") != parent_folder_id:
        _move_folder(headers, fid, parent_folder_id)
    return fid


# ---------------- main ----------------

def main():
    ap = argparse.ArgumentParser(description="导入 GEO 文章到腾讯文档（原生在线文档）")
    ap.add_argument("-c", "--config", default="tencent_config.json", help="腾讯文档配置文件路径")
    ap.add_argument("--articles", nargs="+", required=True, help="文章目录列表，例如 问题1/文章 问题2/文章")
    ap.add_argument("--image-dir", default=None, help="图片素材目录，默认读取 config.image_dir")
    ap.add_argument("--docx-dir", default=None, help="docx 输出目录，默认在各问题目录下生成 文章_docx")
    ap.add_argument("--no-move", action="store_true", help="不移动到子目录，导入后保留在目标文件夹根目录")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    headers = {
        "Access-Token": cfg["access_token"],
        "Client-Id": cfg["client_id"],
        "Open-Id": cfg["open_id"],
    }
    image_root = args.image_dir or cfg.get("image_dir", "")
    target_folder = cfg.get("target_folder_id") or ""
    organize = cfg.get("organize_by_question", True) and not args.no_move

    results = []
    for article_dir in args.articles:
        q = os.path.basename(os.path.dirname(article_dir.rstrip("/")))
        if not q:
            q = os.path.basename(article_dir.rstrip("/"))
        md_files = sorted(glob.glob(os.path.join(article_dir, "*.md")))
        if not md_files:
            print(f"跳过（无 md）: {article_dir}", flush=True)
            continue
        docx_dir = args.docx_dir or os.path.join(os.path.dirname(article_dir.rstrip("/")), "文章_docx")
        os.makedirs(docx_dir, exist_ok=True)
        for md_path in md_files:
            name = os.path.splitext(os.path.basename(md_path))[0]
            docx_path = os.path.join(docx_dir, name + ".docx")
            print(f"转换: {md_path} -> {docx_path}", flush=True)
            md_to_docx(md_path, docx_path, image_root)

            target_sub = ""
            if target_folder and organize:
                target_sub = _ensure_subfolder(headers, target_folder, q)

            print(f"导入: {docx_path}", flush=True)
            info = _import_online_doc(headers, docx_path, parent_folder_id=target_sub or None)
            _set_permission(headers, info["ID"], cfg.get("permission", "publicWrite"))

            # 若 async-import 未进入子目录，移动一次
            if target_sub:
                _move_file(headers, info["ID"], target_sub)

            results.append({
                "question": q,
                "file": os.path.basename(docx_path),
                "url": info["url"],
                "id": info["ID"],
                "folder": f"我的文档/{target_folder}/{q}" if target_folder else "",
                "type": info.get("type", "doc"),
            })
            print(f"完成: {info['url']}", flush=True)

    results_md = cfg.get("results_md", "腾讯文档导入结果.md")
    results_json = cfg.get("results_json", "tencent_import_results.json")
    with open(results_json, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    lines = ["# 腾讯文档导入结果", "", "> 文档类型：在线文档（可协作编辑）", "> 文档权限：互联网上获得链接的人可编辑", ""]
    lines.append("| 问题 | 文章 | 腾讯文档链接 |")
    lines.append("|:---|:---|:---|")
    for r in results:
        lines.append(f"| {r['question']} | {r['file'][:-5]} | {r['url']} |")
    lines.append("")
    with open(results_md, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"结果已写入: {results_json} / {results_md}", flush=True)


if __name__ == "__main__":
    main()
