#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Download all files from an IMA knowledge base into a local directory.

Credentials priority:
    1. Environment: IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY
    2. Files: ~/.config/ima/client_id and ~/.config/ima/api_key

Usage:
    python ima_download.py <知识库关键词> <目标目录> [--limit-per-page 50]

Based on: 自动化脚本/IMA知识库下载流程.md
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE_URL = "https://ima.qq.com/openapi/wiki/v1"


def load_credentials():
    client_id = os.environ.get("IMA_OPENAPI_CLIENTID")
    api_key = os.environ.get("IMA_OPENAPI_APIKEY")
    config_dir = Path.home() / ".config" / "ima"
    if not client_id and (config_dir / "client_id").exists():
        client_id = (config_dir / "client_id").read_text(encoding="utf-8").strip()
    if not api_key and (config_dir / "api_key").exists():
        api_key = (config_dir / "api_key").read_text(encoding="utf-8").strip()
    if not client_id or not api_key:
        print("错误：缺少 IMA 凭证。请设置环境变量 IMA_OPENAPI_CLIENTID/IMA_OPENAPI_APIKEY，"
              "或创建 ~/.config/ima/client_id 和 ~/.config/ima/api_key。")
        sys.exit(1)
    return client_id, api_key


def api_call(client_id, api_key, path, body, retries=3):
    url = BASE_URL + path
    data = json.dumps(body).encode("utf-8")
    headers = {
        "ima-openapi-clientid": client_id,
        "ima-openapi-apikey": api_key,
        "Content-Type": "application/json; charset=utf-8",
    }
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            if result.get("code") == 110021:  # 请求频控
                time.sleep(2 ** attempt)
                continue
            return result
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8"))
            except Exception:
                return {"code": e.code, "msg": str(e)[:300]}
        except Exception as e:
            if attempt == retries - 1:
                return {"code": -1, "msg": str(e)}
            time.sleep(1)
    return {"code": -1, "msg": "retry exhausted"}


def search_kb(client_id, api_key, query):
    result = api_call(client_id, api_key, "/search_knowledge_base", {"query": query, "cursor": "", "limit": 20})
    if result.get("code") != 0:
        raise RuntimeError(f"搜索知识库失败: {result}")
    infos = result.get("data", {}).get("info_list", [])
    if not infos:
        raise RuntimeError(f"未找到知识库: {query}")
    return infos[0]["kb_id"], infos[0]["kb_name"]


def walk_folder(client_id, api_key, kb_id, folder_id, local_dir, limit):
    """Return list of (media_id, title, local_path)."""
    files = []
    cursor = ""
    while True:
        body = {"knowledge_base_id": kb_id, "cursor": cursor, "limit": limit}
        if folder_id:
            body["folder_id"] = folder_id
        result = api_call(client_id, api_key, "/get_knowledge_list", body)
        if result.get("code") != 0:
            raise RuntimeError(f"获取知识库列表失败: {result}")
        data = result.get("data", {})
        for item in data.get("knowledge_list", []):
            media_id = item.get("media_id", "")
            title = item.get("title", "")
            if media_id.startswith("folder_"):
                sub_dir = os.path.join(local_dir, title)
                files.extend(walk_folder(client_id, api_key, kb_id, media_id, sub_dir, limit))
            else:
                files.append({"media_id": media_id, "title": title, "path": local_dir})
        if data.get("is_end"):
            break
        cursor = data.get("next_cursor", "")
        if not cursor:
            break
    return files


def download_one(client_id, api_key, media_id, out_path):
    result = api_call(client_id, api_key, "/get_media_info", {"media_id": media_id})
    if result.get("code") != 0:
        return False, f"get_media_info code={result.get('code')} msg={result.get('msg')}"
    url_info = result.get("data", {}).get("url_info", {})
    url = url_info.get("url")
    if not url:
        return False, "url_info.url 为空"
    headers = {}
    for k, v in (url_info.get("headers") or {}).items():
        headers[k] = v
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, open(out_path, "wb") as f:
            shutil_copyfileobj(resp, f)
        return True, ""
    except Exception as e:
        return False, str(e)


def shutil_copyfileobj(src, dst, length=1024 * 1024):
    import shutil
    shutil.copyfileobj(src, dst, length)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("keyword", help="知识库搜索关键词，例如 示例项目A")
    ap.add_argument("target_dir", help="下载目标目录，例如 项目/知识库")
    ap.add_argument("--limit", type=int, default=50, help="每页条数，1-50")
    args = ap.parse_args()

    client_id, api_key = load_credentials()
    kb_id, kb_name = search_kb(client_id, api_key, args.keyword)
    print(f"找到知识库: {kb_name} (kb_id={kb_id})")

    files = walk_folder(client_id, api_key, kb_id, None, args.target_dir, args.limit)
    print(f"共发现 {len(files)} 个文件，开始下载到 {args.target_dir}")

    ok = fail = 0
    for i, f in enumerate(files, 1):
        out_dir = f["path"]
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f["title"])
        print(f"[{i}/{len(files)}] {f['title']}")
        success, err = download_one(client_id, api_key, f["media_id"], out_path)
        if success:
            ok += 1
            print("  OK")
        else:
            fail += 1
            print(f"  SKIP: {err}")
            if "220021" in err:
                print("提示：资料获取次数达上限，请明天再试。")
                break
        time.sleep(0.3)

    print(f"\n下载完成: 成功 {ok}，失败 {fail}")

if __name__ == "__main__":
    main()
