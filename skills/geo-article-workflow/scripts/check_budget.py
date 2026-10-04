#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下发子代理前检查账户余额与本批预估消耗。

用法：
    python check_budget.py --articles 36
    python check_budget.py --prompts 36
    python check_budget.py --articles 36 --prompts 36 --json

设计意图：
    并发上限由服务端按账户余额动态计算，写死一个并发数字并不准确。
    更可靠的做法是：开跑前把「余额 / 预估 / 风险」摆给用户看，由用户决定是否开跑。
    本脚本负责把这三个数算出来。

单位成本默认值来自 2026-09-28 示例项目B 一轮 36 篇的实测（见 references/成本模型与度量.md）：
    文章 ~0.14 元/篇，prompt ~0.045 元/篇，另加 30% 返工余量。
优化生效后可下调：--unit-article / --unit-prompt。
"""
import argparse
import datetime
import json
import os
import re
import sys
import urllib.request

CRED = os.path.expanduser("~/.dsh/.credentials.yaml")
LEDGER = os.path.expanduser("~/.dsh/storages/cost-meter/ledger.json")
DEFAULT_UNIT_ARTICLE = 0.14
DEFAULT_UNIT_PROMPT = 0.045
DEFAULT_BUFFER = 1.3
FALLBACK_RATE = 7.2


def read_api_key():
    for env in ("DEEPSEEK_API_KEY", "DSH_DEEPSEEK_API_KEY"):
        if os.environ.get(env):
            return os.environ[env].strip()
    try:
        text = open(CRED, encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"DEEPSEEK_API_KEY[:\s]+(\S+)", text)
    return m.group(1).strip() if m else None


def fetch_balance(key):
    """返回 (余额CNY, 币种, 备注) 或 (None, None, 失败原因)。"""
    if not key:
        return None, None, "未找到 DEEPSEEK_API_KEY"
    req = urllib.request.Request(
        "https://api.deepseek.com/user/balance",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as exc:  # 网络/鉴权失败都不该让脚本崩
        return None, None, f"余额接口不可用（{type(exc).__name__}: {exc}）"
    infos = data.get("balance_infos") or []
    if not infos:
        return None, None, "余额接口未返回 balance_infos"
    info = infos[0]
    try:
        return float(info.get("total_balance", 0)), info.get("currency", "CNY"), "ok"
    except (TypeError, ValueError):
        return None, None, "余额字段无法解析"


def ledger_today_spend():
    """从 cost-meter 账本估算今日花费（CNY）。注意账本 cost 字段是 USD。"""
    try:
        data = json.load(open(LEDGER, encoding="utf-8"))
    except Exception:
        return None, None
    rate = float((data.get("config") or {}).get("exchangeRate") or FALLBACK_RATE)
    today = datetime.date.today().isoformat()
    day = (data.get("days") or {}).get(today)
    if not day:
        return 0.0, rate
    usd = float(day.get("cost") or 0.0)
    return usd * rate, rate


def verdict(balance, estimate):
    if balance is None:
        return "未知", "无法取得余额，请手动确认账户余额后再决定是否开跑。"
    if estimate <= 0:
        return "无消耗", "本批没有需要下发的子代理。"
    ratio = balance / estimate
    if ratio >= 3:
        return "低", "余额充足，可正常批量下发。"
    if ratio >= 1.5:
        return "中", "余额够用但不宽裕，建议分批跑，并在每批之间确认进度。"
    if ratio >= 1.0:
        return "偏高", "余额仅略高于预估。中途若返工可能触发 429（并发被下调）或 402（余额不足）。"
    return "高", ("余额低于本批预估。开跑有较大概率中途失败：已写入磁盘的产物会保留，"
                  "但收尾（汇总/改名/导入）会丢，需要重跑。建议先充值或大幅缩减本批篇数。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--articles", type=int, default=0, help="本批要写的文章篇数")
    ap.add_argument("--prompts", type=int, default=0, help="本批要生成的 prompt 篇数")
    ap.add_argument("--unit-article", type=float, default=DEFAULT_UNIT_ARTICLE)
    ap.add_argument("--unit-prompt", type=float, default=DEFAULT_UNIT_PROMPT)
    ap.add_argument("--buffer", type=float, default=DEFAULT_BUFFER, help="返工余量倍数")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = ap.parse_args()

    estimate = (args.articles * args.unit_article + args.prompts * args.unit_prompt) * args.buffer
    balance, currency, note = fetch_balance(read_api_key())
    spent, rate = ledger_today_spend()
    level, advice = verdict(balance, estimate)

    result = {
        "balance_cny": balance,
        "currency": currency,
        "balance_note": note,
        "today_spent_cny_estimate": round(spent, 3) if spent is not None else None,
        "exchange_rate_used": rate,
        "batch": {"articles": args.articles, "prompts": args.prompts,
                  "unit_article": args.unit_article, "unit_prompt": args.unit_prompt,
                  "buffer": args.buffer},
        "estimate_cny": round(estimate, 3),
        "risk_level": level,
        "advice": advice,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print("=" * 56)
    print("子代理开跑前预算检查")
    print("=" * 56)
    if balance is None:
        print(f"账户余额   : 未知（{note}）")
    else:
        print(f"账户余额   : {balance:.2f} {currency}")
    if spent is not None:
        print(f"今日已花   : ≈{spent:.2f} CNY（按账本 cost×{rate}，仅覆盖账本已记录的会话）")
    print(f"本批规模   : 文章 {args.articles} 篇 / prompt {args.prompts} 篇")
    print(f"本批预估   : ≈{estimate:.2f} CNY"
          f"（含 {args.buffer:g}× 返工余量；单价 文章{args.unit_article} / prompt{args.unit_prompt}）")
    print(f"风险等级   : {level}")
    print(f"建议       : {advice}")
    print("=" * 56)
    print("→ 把以上结果告知用户，等用户确认后再下发子代理。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
