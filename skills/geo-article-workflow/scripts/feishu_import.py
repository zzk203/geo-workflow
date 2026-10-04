"""飞书云文档批量导入工具（通用版）
=====================================
将本地 .md 文件批量导入飞书云文档，支持同步上传文中引用的图片，并自动设置权限。
所有配置项集中在 feishu_config.json 中，修改配置即可适配不同项目。

使用方式：
  1. 修改 feishu_config.json 中的配置
  2. python feishu_import.py                        → 扫描所有目录，导入全部 .md 文件
  3. python feishu_import.py --whitelist whitelist.json  → 只导入白名单中的文件

白名单文件格式（JSON）：
  [
    ["目录名", "文件名.md"],
    ["目录名", "文件名.md"]
  ]
"""
import urllib.request, urllib.error, urllib.parse, json, os, time, sys, threading, argparse, re, tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler


# ============================================================
# 配置加载
# ============================================================

def load_config(config_path='feishu_config.json'):
    """加载配置文件。优先从脚本同目录查找，其次从当前工作目录查找。"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for base in [script_dir, os.getcwd()]:
        path = os.path.join(base, config_path)
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f), os.path.dirname(path)
    raise FileNotFoundError(f"Config file '{config_path}' not found in script dir or cwd.")


# ============================================================
# API 调用
# ============================================================

def api_call(url, token=None, method='GET', body=None, params=None, timeout=60):
    """通用飞书 API 调用。"""
    if params:
        pairs = [f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items()]
        url = f"{url}?{'&'.join(pairs)}"
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

def get_user_token(cfg):
    """OAuth 流程获取 user_access_token。"""
    oauth_code = None
    event = threading.Event()

    class OAuthHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal oauth_code
            q = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(q)
            code = params.get('code', [None])[0]
            if code:
                oauth_code = code
                event.set()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'<h1>OK</h1><p>You can close this tab.</p>')
            else:
                self.send_response(400)
                self.end_headers()

        def log_message(self, *a):
            pass

    port = cfg.get('oauth_port', 8080)
    server = HTTPServer(('localhost', port), OAuthHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    auth_url = (
        f"https://open.feishu.cn/open-apis/authen/v1/authorize"
        f"?app_id={cfg['app_id']}"
        f"&redirect_uri={urllib.parse.quote(f'http://localhost:{port}/callback')}"
        f"&scope={urllib.parse.quote(cfg['scope'])}"
    )
    print(f"\n请在浏览器中打开以下链接并点击授权：\n\n    {auth_url}\n")
    print("等待授权...", flush=True)

    if not event.wait(timeout=cfg.get('oauth_timeout', 120)):
        print("授权超时！")
        server.shutdown()
        return None

    server.shutdown()
    time.sleep(0.3)

    app_data = api_call(
        'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
        method='POST',
        body={'app_id': cfg['app_id'], 'app_secret': cfg['app_secret']}
    )
    app_token = app_data['app_access_token']

    user_data = api_call(
        'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
        token=app_token, method='POST',
        body={'grant_type': 'authorization_code', 'code': oauth_code}
    )
    if user_data.get('code') != 0:
        print(f"OAuth 失败: {user_data}")
        return None

    token = user_data['data']['access_token']
    token_path = os.path.join(cfg['_config_dir'], cfg.get('token_file', 'feishu_tokens.json'))
    with open(token_path, 'w') as f:
        json.dump({'user_token': token}, f)
    print(f"Token 已保存: {token[:30]}...")
    return token


def load_or_refresh_token(cfg):
    """加载本地 token，过期则自动重新授权。"""
    token_path = os.path.join(cfg['_config_dir'], cfg.get('token_file', 'feishu_tokens.json'))
    if os.path.exists(token_path):
        with open(token_path) as f:
            user_token = json.load(f).get('user_token', '')
        test = api_call('https://open.feishu.cn/open-apis/drive/v1/files', user_token, params={'page_size': 1})
        if test.get('code') == 0:
            return user_token
        print("Token 已过期，需要重新授权。")
    return get_user_token(cfg)


# ============================================================
# 图片解析与处理
# ============================================================

IMG_PATTERN = re.compile(r'!\[([^\]]*)\]\(([^\)]+)\)')
# 匹配 [图片名.扩展名] 格式的占位符
BRACKET_IMG_PATTERN = re.compile(r'\[([^\[\]]+\.(?:jpe?g|png|gif|bmp|webp|JPEG|JPG|PNG|GIF|BMP|WEBP))\]')

def parse_images(file_path, image_dir=None):
    """解析 .md 文件中的图片引用，返回 [(alt, image_path, line_index), ...]。
    支持两种格式：
      - Markdown: ![alt](path)  → image_path 相对于 .md 文件所在目录
      - 方括号占位: [图片名.jpg] → image_path 在 image_dir 下查找
    """
    md_dir = os.path.dirname(os.path.abspath(file_path))
    images = []
    with open(file_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    for i, line in enumerate(lines):
        # Markdown 格式
        for m in IMG_PATTERN.finditer(line):
            alt = m.group(1).strip()
            img_path = m.group(2).strip()
            abs_path = os.path.normpath(os.path.join(md_dir, img_path))
            images.append({'alt': alt, 'abs_path': abs_path, 'line': i})
        # 方括号占位格式 [图片名.扩展名]
        if image_dir:
            for m in BRACKET_IMG_PATTERN.finditer(line):
                filename = m.group(1).strip()
                abs_path = os.path.normpath(os.path.join(image_dir, filename))
                images.append({'alt': filename, 'abs_path': abs_path, 'line': i})
    return images


def preprocess_md(file_path, image_handling='placeholder', image_dir=None):
    """预处理 .md 文件内容，处理图片引用。
    支持模式：strip / placeholder / upload / keep
    支持格式：![alt](path) 和 [图片名.扩展名]
    """
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    if image_handling == 'keep':
        return content

    if image_handling == 'strip':
        lines = content.split('\n')
        cleaned = []
        for line in lines:
            if IMG_PATTERN.search(line) or (image_dir and BRACKET_IMG_PATTERN.search(line)):
                s = IMG_PATTERN.sub('', line).strip()
                if image_dir:
                    s = BRACKET_IMG_PATTERN.sub('', s).strip()
                if s:
                    cleaned.append(s)
            else:
                cleaned.append(line)
        return '\n'.join(cleaned)

    elif image_handling == 'upload':
        counter = [0]
        def md_replacer(m):
            counter[0] += 1
            return f'[IMG_{counter[0]:03d}:{m.group(1).strip()}]'
        content = IMG_PATTERN.sub(md_replacer, content)
        if image_dir:
            def bracket_replacer(m):
                counter[0] += 1
                return f'[IMG_{counter[0]:03d}:{m.group(1).strip()}]'
            content = BRACKET_IMG_PATTERN.sub(bracket_replacer, content)
        return content

    elif image_handling == 'placeholder':
        def md_replacer(m):
            a = m.group(1).strip()
            return f'[图片：{a}]' if a else '[图片]'
        content = IMG_PATTERN.sub(md_replacer, content)
        if image_dir:
            def bracket_replacer(m):
                return f'[图片：{m.group(1).strip()}]'
            content = BRACKET_IMG_PATTERN.sub(bracket_replacer, content)
        return content

    return content


# ============================================================
# 媒体上传（文档导入 + 图片上传）
# ============================================================

def upload_media(file_path, token, display_name=None):
    """上传文档文件到飞书媒体服务（用于文档导入），返回 file_token。
    display_name: 上传时使用的文件名（如原文件标题），不传则用 file_path 的 basename。
    """
    fn = display_name or os.path.basename(file_path)
    fs = os.path.getsize(file_path)
    ext = os.path.splitext(fn)[1][1:]

    boundary = '----FeishuUpload'
    parts = []
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n{fn}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nccm_import_open\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\nccm_import_open\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n{fs}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\n{json.dumps({"obj_type": "docx", "file_extension": ext})}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
    with open(file_path, 'rb') as f:
        parts.append(f.read())
    parts.append(f'\r\n--{boundary}--\r\n'.encode())

    body_bytes = b''.join(parts)

    req = urllib.request.Request(
        'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
        data=body_bytes, method='POST'
    )
    req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def upload_image_file(image_path, token, parent_node='docx_image'):
    """上传单张图片到飞书（type=image），返回 image_token。
    parent_node: 文档中已有的图片 block_id，上传后将自动关联。"""
    fn = os.path.basename(image_path)
    fs = os.path.getsize(image_path)

    boundary = '----FeishuImage'
    parts = []
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n{fn}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\ndocx_image\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n{parent_node}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n{fs}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\n{json.dumps({"obj_type": "image"})}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
    with open(image_path, 'rb') as f:
        parts.append(f.read())
    parts.append(f'\r\n--{boundary}--\r\n'.encode())

    body_bytes = b''.join(parts)
    req = urllib.request.Request(
        'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
        data=body_bytes, method='POST'
    )
    req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


# ============================================================
# 文档导入流程
# ============================================================

def import_one(file_path, title, folder_token, token, cfg):
    """导入单个 .md 文件：预处理→上传→创建导入任务→轮询。返回 (doc_token, doc_url)。"""
    image_handling = cfg.get('image_handling', 'placeholder')
    image_dir = cfg.get('image_dir', None)

    processed_content = preprocess_md(file_path, image_handling, image_dir)
    processed_path = file_path

    with open(file_path, 'r', encoding='utf-8') as f:
        original = f.read()
    if processed_content != original:
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8')
        tmp.write(processed_content)
        tmp.close()
        processed_path = tmp.name

    try:
        ud = upload_media(processed_path, token, display_name=title + '.md')
        if ud.get('code') != 0:
            print(f"  上传失败: {ud.get('msg', '')}")
            return None, None
        file_token = ud['data']['file_token']

        import_data = api_call(
            'https://open.feishu.cn/open-apis/drive/v1/import_tasks',
            token=token, method='POST',
            body={
                'name': title,
                'file_extension': 'md',
                'file_token': file_token,
                'type': 'docx',
                'point': {'mount_type': 1, 'mount_key': folder_token}
            }
        )
        if import_data.get('code') != 0:
            print(f"  创建导入任务失败: {import_data.get('msg', '')}")
            return None, None

        ticket = import_data['data']['ticket']
        interval = cfg.get('import_poll_interval', 2)
        max_attempts = cfg.get('import_poll_max_attempts', 60)
        for _ in range(max_attempts):
            time.sleep(interval)
            t = api_call(f'https://open.feishu.cn/open-apis/drive/v1/import_tasks/{ticket}', token=token)
            js = t['data']['result'].get('job_status', -1)
            if js == 0:
                return t['data']['result'].get('token', ''), t['data']['result'].get('url', '')
            elif js == 1:
                print(f"  导入任务失败: {t['data']['result'].get('message', '')}")
                return None, None
        return None, None
    finally:
        if processed_path != file_path and os.path.exists(processed_path):
            os.unlink(processed_path)


def set_permission(doc_token, token, body):
    """设置文档为链接可编辑。"""
    url = f'https://open.feishu.cn/open-apis/drive/v1/permissions/{doc_token}/public?type=docx'
    return api_call(url, token=token, method='PATCH', body=body)


# ============================================================
# 图片上传到文档（upload 模式专用）
# ============================================================

def upload_images_to_doc(file_path, doc_token, token, cfg):
    """将 .md 中的图片上传并插入到飞书文档中。
    流程：定位占位block → 创建空图片block → 上传图片关联 → 删除占位block
    """
    image_dir = cfg.get('image_dir', None)
    images = parse_images(file_path, image_dir)
    if not images:
        return 0

    print(f"  正在处理 {len(images)} 张图片...", flush=True)

    # 获取文档所有 block
    blocks = api_call(
        f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_token}/blocks',
        token=token, params={'page_size': 500}
    )
    if blocks.get('code') != 0:
        print(f"  获取文档块失败: {blocks.get('msg', '')}")
        return 0

    block_items = blocks.get('data', {}).get('items', [])
    print(f"  文档共 {len(block_items)} 个 block", flush=True)

    # 查找占位文本 block: [IMG_xxx:name] 或 [图片：name]
    placeholder_blocks = {}
    for item in block_items:
        texts = item.get('text', {}).get('elements', [])
        for el in texts:
            text_run = el.get('text_run', {})
            content = text_run.get('content', '')
            match = re.match(r'\[(IMG_\d{3}):.*?\]', content)
            if not match:
                match = re.match(r'\[图片[：:](.*?)\]', content)
            if match:
                key = match.group(1)
                placeholder_blocks[key] = {
                    'block_id': item['block_id'],
                    'parent_id': item.get('parent_id', doc_token),
                }

    inserted = 0
    for idx, img in enumerate(images):
        placeholder = f'IMG_{idx + 1:03d}'
        # Also match by filename
        filename = os.path.basename(img['abs_path'])
        pb = placeholder_blocks.get(placeholder) or placeholder_blocks.get(filename)
        if not pb:
            print(f"    未找到占位 [{placeholder}] 对应的 block，已跳过")
            continue
        if not os.path.exists(img['abs_path']):
            print(f"    图片不存在: {img['abs_path']}")
            continue

        try:
            # Step 1: 在占位 block 后创建空白图片 block
            create_body = {
                'children': [{'block_type': 27, 'image': {}}],
                'index': 0  # insert right after placeholder
            }
            # Need to find index of placeholder in children
            siblings = api_call(
                f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_token}/blocks/{pb["parent_id"]}/children',
                token=token, params={'page_size': 500}
            )
            idx_in_parent = 0
            if siblings.get('code') == 0:
                for ci, child in enumerate(siblings.get('data', {}).get('items', [])):
                    if child['block_id'] == pb['block_id']:
                        idx_in_parent = ci + 1
                        break

            create_body['index'] = idx_in_parent
            create_resp = api_call(
                f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_token}/blocks/{pb["parent_id"]}/children',
                token=token, method='POST', body=create_body
            )
            if create_resp.get('code') != 0:
                print(f"    创建图片块失败 [{placeholder}]: {create_resp.get('msg', '')}")
                continue
            image_block_id = create_resp['data']['children'][0]['block_id']

            # Step 2: 上传图片关联到该 block
            up = upload_image_file(img['abs_path'], token, parent_node=image_block_id)
            if up.get('code') != 0:
                print(f"    图片上传失败 [{placeholder}]: {up.get('msg', '')}")
                continue
            file_token = up['data']['file_token']

            # Step 3: 替换图片 block 的素材
            replace_resp = api_call(
                f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_token}/blocks/{image_block_id}',
                token=token, method='PATCH',
                body={'replace_image': {'token': file_token}}
            )
            if replace_resp.get('code') != 0:
                print(f"    替换图片失败 [{placeholder}]: {replace_resp.get('msg', '')}")

            # Step 4: 删除占位符文字 block
            del_resp = api_call(
                f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_token}/blocks/{pb["parent_id"]}/children/batch_delete',
                token=token, method='DELETE',
                body={'start_index': idx_in_parent - 1, 'end_index': idx_in_parent}
            )

            inserted += 1
            print(f"    图片已插入 [{placeholder}]: {filename}", flush=True)
            time.sleep(0.3)
        except Exception as e:
            print(f"    处理图片失败 [{placeholder}]: {e}")

    print(f"  图片处理完成: {inserted}/{len(images)} 张成功", flush=True)
    return inserted


# ============================================================
# 文件发现
# ============================================================

def discover_files(cfg, whitelist=None):
    """发现待导入文件列表。"""
    base = cfg['base_dir']
    subdir = cfg.get('article_subdir', '文章')
    folder_map = cfg.get('folder_map', {})

    articles = []

    if whitelist:
        for topic, filename in whitelist:
            if topic not in folder_map:
                print(f"WARNING: 目录 '{topic}' 不在 folder_map 中，已跳过。")
                continue
            file_path = os.path.join(base, topic, subdir, filename)
            if not os.path.exists(file_path):
                print(f"WARNING: 文件不存在: {file_path}")
                continue
            articles.append({
                'folder_token': folder_map[topic],
                'file_path': file_path,
                'title': filename.replace('.md', ''),
                'topic': topic,
            })
    else:
        for topic in sorted(folder_map.keys()):
            ad = os.path.join(base, topic, subdir)
            if not os.path.exists(ad):
                continue
            for fn in sorted(os.listdir(ad)):
                if fn.endswith('.md'):
                    articles.append({
                        'folder_token': folder_map[topic],
                        'file_path': os.path.join(ad, fn),
                        'title': fn.replace('.md', ''),
                        'topic': topic,
                    })

    return articles


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='飞书云文档批量导入工具')
    parser.add_argument('--config', '-c', default='feishu_config.json', help='配置文件路径')
    parser.add_argument('--whitelist', '-w', default=None, help='白名单 JSON 文件路径（可选）')
    args = parser.parse_args()

    cfg, config_dir = load_config(args.config)
    cfg['_config_dir'] = config_dir

    whitelist = None
    if args.whitelist:
        with open(args.whitelist, 'r', encoding='utf-8') as f:
            whitelist = json.load(f)
    elif cfg.get('files_whitelist'):
        whitelist = cfg['files_whitelist']

    image_handling = cfg.get('image_handling', 'placeholder')

    token = load_or_refresh_token(cfg)
    if not token:
        print("获取 token 失败！")
        sys.exit(1)

    articles = discover_files(cfg, whitelist)
    if not articles:
        print("没有找到待导入的文件。")
        return

    print(f"\n开始导入 {len(articles)} 个文件（图片模式: {image_handling}）...\n", flush=True)
    results = []
    doc_tokens = []

    for idx, a in enumerate(articles):
        print(f"[{idx + 1}/{len(articles)}] {a['topic']}/{a['title'][:60]}", flush=True)

        # ====== Phase 1: 导入文档文本 ======
        doc_token, doc_url = import_one(a['file_path'], a['title'], a['folder_token'], token, cfg)

        if not doc_token:
            results.append({'title': a['title'], 'status': 'FAILED'})
            continue

        domain = cfg.get('feishu_domain', '')
        url = doc_url or (f"https://{domain}/docx/{doc_token}" if domain else doc_url)
        print(f"  文本导入成功 → {url}", flush=True)

        # ====== Phase 2: 上传并插入图片（upload 模式）======
        img_count = 0
        if image_handling == 'upload':
            img_count = upload_images_to_doc(a['file_path'], doc_token, token, cfg)

        results.append({
            'title': a['title'], 'status': 'OK',
            'doc_token': doc_token, 'url': url, 'images': img_count
        })
        doc_tokens.append(doc_token)
        time.sleep(0.5)

    # 汇总
    ok_count = sum(1 for r in results if r['status'] == 'OK')
    total_images = sum(r.get('images', 0) for r in results)
    print(f"\n{'=' * 60}")
    print(f"导入完成: {ok_count}/{len(results)} 篇成功")
    if image_handling == 'upload':
        print(f"图片上传: {total_images} 张")
    print(f"{'=' * 60}")

    # 设置权限
    if cfg.get('set_permissions') and doc_tokens:
        print(f"\n{'=' * 60}")
        print("设置权限（链接可编辑）...")
        print(f"{'=' * 60}")
        perm_body = cfg.get('permission_body', {
            'security_entity': 'anyone_can_edit',
            'link_share_entity': 'anyone_editable'
        })
        for doc_id in doc_tokens:
            resp = set_permission(doc_id, token, perm_body)
            ok_str = 'OK' if resp.get('code') == 0 else f'FAIL({resp.get("code")})'
            print(f"  [{ok_str}] {doc_id}")
            time.sleep(0.15)

    print(f"\n{'=' * 60}")
    print("所有文档链接（可编辑）：")
    print(f"{'=' * 60}")
    for r in results:
        if r['status'] == 'OK':
            print(f"  {r['url']}")
            if r.get('images'):
                print(f"    ↳ 已上传 {r['images']} 张图片")

    print(f"\n{'=' * 60}")
    print("汇总 JSON：")
    print(f"{'=' * 60}")
    print(json.dumps([r for r in results if r['status'] == 'OK'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
