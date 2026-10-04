# -*- coding: utf-8 -*-
"""飞书文档文章提取器（发布流程用）
====================================
从飞书在线文档提取：主标题、备用标题列表、正文块（含图片位置）、图片文件。

用法：
  python extract_feishu.py <文档URL或docx_token> <输出目录>
  python extract_feishu.py --auth     # 重新获取 OAuth token（授权链接交给用户点）

输出（输出目录下）：
  article.json        主标题/备用标题/正文块/图片清单
  正文_纯文本.txt     发布用纯文本（图片处为 [图片] 占位，已删除主标题/备选标题块）
  正文_markdown.md    带格式版本
  图片<N>.png         按文档顺序下载的图片
"""
import urllib.request, urllib.error, urllib.parse, json, os, sys, time, threading, re, argparse, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = os.path.join(SKILL_DIR, 'feishu_tokens.json')

# 发布工作区固定位于 DSH 工作区根目录（geo 根目录），不在 skill 目录下。
# 本文件位于 <工作区>/.agents/skills/article-publisher/scripts/common，向上 5 级回到工作区根目录。
WORKSPACE_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '..'))
DEFAULT_WORKSPACE = os.path.join(WORKSPACE_ROOT, '发布工作区')

APP_ID = "<YOUR_APP_ID>"
APP_SECRET = "<YOUR_APP_SECRET>"
SCOPE = "drive:drive docx:document docs:document:import"
PORT = 8080


# ============================================================
# API 调用
# ============================================================

def api_call(url, token=None, method=None, body=None, params=None, timeout=60):
    if method is None:
        method = 'POST' if body is not None else 'GET'
    if params:
        url += '?' + '&'.join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json; charset=utf-8')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {'code': e.code, 'msg': str(e)[:300]}


# ============================================================
# OAuth 授权
# ============================================================

def oauth_flow():
    """启动本地回调服务器，打印授权链接，等待用户浏览器授权。"""
    oauth_code, event = None, threading.Event()

    import http.server
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal oauth_code
            code = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('code', [None])[0]
            if code:
                oauth_code = code
                event.set()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'<h1>OK</h1><p>Token saved. You can close this tab.</p>')
            else:
                self.send_response(400)
                self.end_headers()
        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(('localhost', PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    auth_url = (
        f"https://open.feishu.cn/open-apis/authen/v1/authorize"
        f"?app_id={APP_ID}&redirect_uri={urllib.parse.quote(f'http://localhost:{PORT}/callback')}"
        f"&scope={urllib.parse.quote(SCOPE)}"
    )
    print(f"\n请在浏览器中打开以下链接并点击授权（5分钟内）：\n\n    {auth_url}\n")
    print("等待授权...", flush=True)
    if not event.wait(timeout=300):
        print("授权超时！")
        sys.exit(1)
    server.shutdown()
    time.sleep(0.3)

    app_token = ''
    for attempt in range(6):
        app_data = api_call('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
                            body={'app_id': APP_ID, 'app_secret': APP_SECRET})
        if app_data.get('code') == 0 and (app_data.get('app_access_token') or app_data.get('tenant_access_token')):
            app_token = app_data.get('app_access_token') or app_data.get('tenant_access_token')
            break
        print(f"获取 app_access_token 失败（第{attempt + 1}次）: {app_data}", flush=True)
        time.sleep(5)
    if not app_token:
        print("无法获取 app_access_token，请检查 APP_ID/APP_SECRET 或网络。")
        sys.exit(1)

    user_data = api_call('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
                         token=app_token, method='POST',
                         body={'grant_type': 'authorization_code', 'code': oauth_code})
    if user_data.get('code') != 0:
        print(f"OAuth 失败: {user_data}")
        sys.exit(1)
    token = user_data['data']['access_token']
    with open(TOKEN_FILE, 'w') as f:
        json.dump({'user_token': token}, f)
    print("Token 已保存到", TOKEN_FILE)
    return token


def load_token():
    if os.path.exists(TOKEN_FILE):
        token = json.load(open(TOKEN_FILE)).get('user_token', '')
        if token and api_call('https://open.feishu.cn/open-apis/drive/v1/files', token,
                              params={'page_size': 1}).get('code') == 0:
            return token
        print("Token 已过期，需要重新授权。")
    return oauth_flow()


# ============================================================
# 文档提取
# ============================================================

DOC_TOKEN_RE = re.compile(r'(?:docx/)?([A-Za-z0-9]{20,30})')

def extract(doc_token, token, out_dir):
    blocks = api_call(f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_token}/blocks',
                      token, params={'page_size': 500})
    if blocks.get('code') != 0:
        raise RuntimeError(f"获取文档块失败: {blocks.get('msg')}")
    items = blocks['data']['items']

    root = items[0]
    by_id = {b['block_id']: b for b in items[1:]}

    # 主标题 = 页面块文本
    main_title = ''.join(el.get('text_run', {}).get('content', '')
                         for el in root.get('page', {}).get('elements', [])).strip()

    # 备用标题块 = 第一个以"备选标题"开头的文本块
    # 飞书文档中「备选标题：」后通常跟随多个 callout(block_type=13) 块，每个块是一条备用标题
    alt_titles = []
    alt_section = False

    def block_text(b):
        # 递归提取所有 text_run.content（兼容 text/ordered/bullet/callout 等结构）
        out = []
        def walk(obj):
            if isinstance(obj, dict):
                if obj.get('text_run') and obj['text_run'].get('content'):
                    out.append(obj['text_run']['content'])
                for v in obj.values():
                    walk(v)
            elif isinstance(obj, list):
                for v in obj:
                    walk(v)
        walk(b)
        return ''.join(out)

    def cell_text(cell_id):
        # 递归提取表格单元格内文本（单元格块本身无文本，文本在其 children 中）
        cell = by_id.get(cell_id)
        if not cell:
            return ''
        parts = []
        def walk(b):
            t = block_text(b).strip()
            if t:
                parts.append(t)
            for child_id in b.get('children', []):
                if child_id in by_id:
                    walk(by_id[child_id])
        walk(cell)
        return '\n'.join(parts).strip()

    # 正文块（跳过备选标题块）
    body_blocks = []
    images = []
    for bid in root.get('children', []):
        b = by_id.get(bid)
        if not b:
            continue
        bt = b.get('block_type')
        if bt == 2:
            text = block_text(b)
            if text.startswith('备选标题'):
                alt_section = True
                # 兼容“备选标题：1、xxx”写在同一个文本块的情况
                for line in text.splitlines():
                    m = re.match(r'^\s*\d+[.、]\s*(.+)$', line.strip())
                    if m:
                        alt_titles.append(m.group(1).strip())
                continue
            # 遇到第一个正式正文文本块，退出备用标题区
            alt_section = False
            body_blocks.append({'type': 'text', 'text': text,
                                'bold': any(el.get('text_run', {}).get('text_element_style', {}).get('bold')
                                            for el in b.get('text', {}).get('elements', []))})
        elif bt == 13:
            text = block_text(b).strip()
            if alt_section and text:
                alt_titles.append(text)
                continue
            body_blocks.append({'type': 'other', 'block_type': bt, 'text': text})
        elif bt in (3, 4, 5, 6, 7, 8):
            alt_section = False
            heading_key = f'heading{bt - 2}'
            text = ''.join(el.get('text_run', {}).get('content', '')
                           for el in b.get(heading_key, {}).get('elements', []))
            body_blocks.append({'type': 'heading', 'level': bt - 2, 'text': text})
        elif bt == 12:
            alt_section = False
            text = ''.join(el.get('text_run', {}).get('content', '')
                           for el in b.get('bullet', {}).get('elements', []))
            body_blocks.append({'type': 'bullet', 'text': text})
        elif bt == 31:
            # 表格块：从 table.cells 按行优先读取单元格
            table_data = b.get('table', {}) or {}
            cells = table_data.get('cells', []) or []
            prop = table_data.get('property', {}) or {}
            row_size = int(prop.get('row_size') or 0)
            col_size = int(prop.get('column_size') or 0)
            rows = []
            for r in range(row_size):
                row = []
                for c in range(col_size):
                    idx = r * col_size + c
                    if idx < len(cells):
                        row.append(cell_text(cells[idx]).replace('\n', ' ').strip())
                    else:
                        row.append('')
                rows.append(row)
            body_blocks.append({'type': 'table', 'rows': rows, 'row_count': row_size, 'col_count': col_size})
        elif bt == 27:
            body_blocks.append({'type': 'image', 'token': b['image']['token']})
            images.append(b['image']['token'])
        else:
            body_blocks.append({'type': 'other', 'block_type': bt})

    # 新文档规范：正文第一行会重复主标题；提取正文时需把这一行也删除，避免发布后正文顶部重复
    if main_title:
        def _norm_title(s):
            return re.sub(r'\s+', '', s or '')
        target = _norm_title(main_title)
        while body_blocks and body_blocks[0]['type'] in ('text', 'heading', 'bullet'):
            if _norm_title(body_blocks[0].get('text', '')) == target:
                body_blocks.pop(0)
            else:
                break

    # 下载图片
    image_files = []
    os.makedirs(out_dir, exist_ok=True)
    for i, tok in enumerate(images, 1):
        path = os.path.join(out_dir, f'图片{i}.png')
        req = urllib.request.Request(
            f'https://open.feishu.cn/open-apis/drive/v1/medias/{tok}/download')
        req.add_header('Authorization', f'Bearer {token}')
        with urllib.request.urlopen(req, timeout=120) as r:
            with open(path, 'wb') as f:
                f.write(r.read())
        image_files.append(path)
        print(f"  图片{i}: {tok} -> {path}")

    # 生成发布用文本
    plain, md, html_parts, txt_parts = [], [], [], []
    for blk in body_blocks:
        if blk['type'] == 'image':
            plain.append('[图片]')
            md.append('![图片](' + blk.get('token', '') + ')')
            continue
        if blk['type'] == 'table':
            rows = blk.get('rows') or []
            table_txt = '\n'.join(' | '.join(cell for cell in row) for row in rows)
            plain.append(table_txt)
            if rows:
                md_lines = []
                header = rows[0]
                md_lines.append('| ' + ' | '.join(header) + ' |')
                md_lines.append('| ' + ' | '.join(['---'] * len(header)) + ' |')
                for row in rows[1:]:
                    md_lines.append('| ' + ' | '.join(row) + ' |')
                md.append('\n'.join(md_lines))
            html = '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%">'
            for row in rows:
                html += '<tr>' + ''.join(f'<td>{cell}</td>' for cell in row) + '</tr>'
            html += '</table>'
            html_parts.append(html)
            txt_parts.append(table_txt)
            continue
        text = blk.get('text') or ''
        if blk['type'] == 'heading':
            plain.append(text)
            md.append('## ' + text)
            html_parts.append(f'<h2>{text}</h2>')
        elif blk['type'] == 'bullet':
            plain.append('• ' + text)
            md.append('- ' + text)
            html_parts.append(f'<ul><li>{text}</li></ul>')
        elif blk['type'] == 'text':
            plain.append(text)
            md.append('**' + text + '**' if blk.get('bold') else text)
            html_parts.append(f'<p>{text}</p>')
        else:
            plain.append(text)
            md.append(text)
            html_parts.append(f'<p>{text}</p>')
        txt_parts.append(text)

    with open(os.path.join(out_dir, '正文_纯文本.txt'), 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(plain))
    with open(os.path.join(out_dir, '正文_markdown.md'), 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(md))
    with open(os.path.join(out_dir, '正文_clean.html'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(html_parts))
    with open(os.path.join(out_dir, '正文_clean.txt'), 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(txt_parts))

    article = {
        'doc_token': doc_token,
        'main_title': main_title,
        'alt_titles': alt_titles,
        'body_blocks': body_blocks,
        'images': [{'token': t, 'file': f} for t, f in zip(images, image_files)],
    }
    with open(os.path.join(out_dir, 'article.json'), 'w', encoding='utf-8') as f:
        json.dump(article, f, ensure_ascii=False, indent=2)

    # 校验：比对提取正文与原始文档块文本，防止截断/丢表格
    def _norm(s):
        return re.sub(r'\s+', '', s or '')
    source_parts = []
    for blk in body_blocks:
        if blk['type'] == 'table':
            for row in blk.get('rows', []):
                source_parts.append(' '.join(row))
        elif blk['type'] != 'image':
            source_parts.append(blk.get('text') or '')
    source_body = '\n'.join(source_parts)
    extracted_body = '\n'.join(txt_parts)
    src_len = len(_norm(source_body))
    ext_len = len(_norm(extracted_body))
    ratio = ext_len / src_len if src_len else 1.0
    validation = {
        'source_length': src_len,
        'extracted_length': ext_len,
        'ratio': round(ratio, 4),
        'status': 'ok' if ratio >= 0.95 else 'incomplete',
    }
    with open(os.path.join(out_dir, 'validation.json'), 'w', encoding='utf-8') as f:
        json.dump(validation, f, ensure_ascii=False, indent=2)
    if validation['status'] != 'ok':
        print(f"[校验警告] 提取内容可能不完整: source={src_len} extracted={ext_len} ratio={ratio:.2%}")
    else:
        print(f"[校验] 内容完整: source={src_len} extracted={ext_len} ratio={ratio:.2%}")

    print(f"\n主标题: {main_title}")
    for i, t in enumerate(alt_titles, 1):
        print(f"备用标题{i}: {t}")
    print(f"正文块: {len(body_blocks)} 个, 图片: {len(images)} 张")
    return article


def main():
    parser = argparse.ArgumentParser(description='飞书文档文章提取器')
    parser.add_argument('doc', nargs='?', help='飞书文档URL或docx token')
    parser.add_argument('out_dir', nargs='?', default=DEFAULT_WORKSPACE, help='输出目录（默认发布工作区根目录）')
    parser.add_argument('--auth', action='store_true', help='仅执行 OAuth 授权')
    args = parser.parse_args()

    if args.auth:
        load_token()
        return

    if not args.doc:
        parser.print_help()
        sys.exit(1)

    m = DOC_TOKEN_RE.search(args.doc)
    doc_token = m.group(1) if m else args.doc

    token = load_token()
    extract(doc_token, token, args.out_dir)


if __name__ == '__main__':
    main()
