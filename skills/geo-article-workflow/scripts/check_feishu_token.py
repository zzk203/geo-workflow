#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Check whether a Feishu user_access_token exists and is valid before import.

Usage:
    python check_feishu_token.py [-c feishu_config.json]

Exit codes:
    0  token exists and is valid (drive API returns code 0)
    1  token missing, expired, invalid, or API check failed
"""
import argparse
import json
import os
import sys
import urllib.request


def load_config(config_path):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for base in [script_dir, os.getcwd()]:
        path = os.path.join(base, config_path)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f), os.path.dirname(path)
    raise FileNotFoundError(f"Config file '{config_path}' not found in script dir or cwd.")


def check_token(token):
    req = urllib.request.Request("https://open.feishu.cn/open-apis/drive/v1/files?page_size=1")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
        return data.get("code") == 0, data.get("code"), data.get("msg")
    except urllib.error.HTTPError as e:
        return False, e.code, str(e)[:200]
    except Exception as e:
        return False, None, str(e)[:200]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", "-c", default="feishu_config.json", help="配置文件路径")
    args = ap.parse_args()

    cfg, config_dir = load_config(args.config)
    token_file = cfg.get("token_file", "feishu_tokens.json")
    token_path = os.path.join(config_dir, token_file)

    if not os.path.exists(token_path):
        print(f"[MISSING] 飞书 token 文件不存在: {token_path}")
        print("请先完成飞书 OAuth 授权，生成 user_access_token 后再导入。")
        sys.exit(1)

    with open(token_path, encoding="utf-8") as f:
        token_data = json.load(f)
    token = token_data.get("user_token", "")
    if not token:
        print(f"[INVALID] {token_path} 中未找到 user_token 字段")
        sys.exit(1)

    ok, code, msg = check_token(token)
    if ok:
        print(f"[VALID] 飞书 user_access_token 有效，可执行导入。token 文件: {token_path}")
        sys.exit(0)
    else:
        print(f"[INVALID] 飞书 token 已失效或不可用 (code={code}, msg={msg})")
        print("请重新完成飞书 OAuth 授权后再导入。")
        sys.exit(1)


if __name__ == "__main__":
    main()
