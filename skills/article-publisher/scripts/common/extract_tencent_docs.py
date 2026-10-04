# -*- coding: utf-8 -*-
"""腾讯文档文章提取器（发布流程用）
====================================
从腾讯文档在线链接提取：主标题、备用标题列表、正文块（含图片位置）、图片文件。

用法：
  python extract_tencent_docs.py <腾讯文档URL> <输出目录>

输出（输出目录下）：
  article.json        主标题/备用标题/正文块/图片清单
  正文_纯文本.txt     发布用纯文本（图片处为 [图片] 占位，已删除备选标题块）
  正文_markdown.md    带格式版本
  正文_clean.html     已删除备选标题块的中转 HTML（供各平台直接粘贴）
  正文_clean.txt      已删除备选标题块的中转纯文本
  图片<N>.png         按文档顺序下载的图片
"""
import subprocess, json, os, sys, re, urllib.request, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# 转换 encodedID -> fileID 用（OpenAPI 凭证，来源为用户提供）
CONVERTER_URL = 'https://docs.qq.com/openapi/drive/v2/util/converter'
OPENAPI_HEADERS = {
    'Access-Token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiI1ZjIwMmY3MWRiMmQ0Mzg4OTQwZTI2MTY1NGQ5YTJlNiIsInR5cCI6MSwiZXhwIjoxNzkwMjQ2Mzg1LjY1NDc2NywiaWF0IjoxNzg3NjU0Mzg1LjY1NDc2Nywic3ViIjoiYjViZjMyN2M5YTJlNDYzMGEzOWMwNmJjNTY4MGNlNjIifQ.2tmvCqkac6huEqTKkIrCEee5_VP3KCW-yVZ7LC6DAXc',
    'Client-Id': '5f202f71db2d4388940e261654d9a2e6',
    'Open-Id': 'b5bf327c9a2e4630a39c06bc5680ce62',
}

def mcporter_call(service, tool, args):
    cmd = ['mcporter', 'call', service, tool, '--args', json.dumps(args, ensure_ascii=False)]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', timeout=120)
    if p.returncode != 0:
        raise RuntimeError(f'mcporter {service}.{tool} failed: {p.stderr or p.stdout}')
    try:
        return json.loads(p.stdout)
    except Exception:
        # mcporter 可能输出日志后跟 JSON，尝试取最后一个 JSON
        text = p.stdout.strip()
        idx = text.find('{')
        if idx >= 0:
            return json.loads(text[idx:])
        raise RuntimeError(f'无法解析 mcporter 输出: {text[:500]}')

def convert_to_file_id(doc_url):
    encoded = doc_url.rstrip('/').rsplit('/', 1)[-1]
    params = 'type=2&value=' + urllib.parse.quote(encoded)
    req = urllib.request.Request(f'{CONVERTER_URL}?{params}', headers=OPENAPI_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode())
    if data.get('ret') != 0:
        raise RuntimeError(f'转换 fileID 失败: {data}')
    return data['data']['fileID']

def download_image(url, path, referer='https://docs.qq.com/'):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        'Referer': referer,
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        with open(path, 'wb') as f:
            f.write(r.read())

def parse_content(content):
    lines = content.split('\n')
    main_title = ''
    alt_titles = []
    body_lines = []
    # 主标题 = 第一个非空行
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines):
        main_title = lines[i].strip()
        i += 1
    # 兼容“文档第一行就是备选标题”的情况：取第一条编号标题作为主标题
    if main_title.startswith('备选标题'):
        numbered = []
        k = i
        while k < len(lines):
            line = lines[k].strip()
            if re.match(r'^\d+[.、]', line):
                numbered.append(re.sub(r'^\d+[.、]\s*', '', line).strip())
                k += 1
            elif not line:
                k += 1
            else:
                break
        if numbered:
            main_title = numbered.pop(0)
            alt_titles = numbered
            body_lines = [ln.strip() for ln in lines[k:] if ln.strip()]
            return main_title, alt_titles, body_lines
    # 查找备选标题块
    alt_start = -1
    for j in range(i, len(lines)):
        if lines[j].strip().startswith('备选标题'):
            alt_start = j
            break
    if alt_start >= 0:
        k = alt_start + 1
        # 兼容“备选标题：1、xxx”在同一行
        head = lines[alt_start].strip()
        m = re.match(r'^备选标题[:：]\s*(\d+[.、]\s*.+)$', head)
        if m:
            alt_titles.append(re.sub(r'^\d+[.、]\s*', '', m.group(1)).strip())
        while k < len(lines):
            line = lines[k].strip()
            if not line:
                k += 1
                continue
            if re.match(r'^\d+[.、]', line):
                alt_titles.append(re.sub(r'^\d+[.、]\s*', '', line).strip())
                k += 1
                continue
            # 遇到正式正文（如“一、”）即结束
            break
        body_lines = [ln.strip() for ln in lines[k:] if ln.strip()]
    else:
        body_lines = [ln.strip() for ln in lines[i:] if ln.strip()]
    return main_title, alt_titles, body_lines

def main():
    if len(sys.argv) < 3:
        print('用法: python extract_tencent_docs.py <腾讯文档URL> <输出目录>')
        sys.exit(1)
    doc_url = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    file_id = convert_to_file_id(doc_url)
    print('fileID:', file_id)

    content_resp = mcporter_call('tencent-docs', 'get_content', {'file_id': file_id})
    content = content_resp.get('content', '')
    if not content:
        raise RuntimeError('get_content 返回空内容')
    main_title, alt_titles, body_lines = parse_content(content)
    print('主标题:', main_title)
    print('备用标题:', alt_titles)

    images_resp = mcporter_call('doc-mcp', 'get_images', {'file_url': doc_url})
    images = images_resp.get('images', [])
    # 只处理 FromLink 图片；附件图片暂无法直接下载
    url_images = [img for img in images if img.get('source') == 'FromLink' and img.get('image_url')]
    print('图片数:', len(url_images))

    struct_resp = mcporter_call('doc-mcp', 'resolve_document_structure',
                                {'file_url': doc_url, 'mode': 'full', 'include_table_cells': True, 'text_preview_length': 200})
    nodes = struct_resp.get('nodes', [])

    # 按结构顺序重建 body_blocks
    body_blocks = []
    line_idx = 0
    image_idx = 0
    # 跳过开头的 Title 和备选标题区节点；备选标题区节点结束后开始正文
    started = False
    for node in nodes:
        ntype = node.get('type')
        preview = (node.get('text_preview') or '').strip()
        if ntype == 'Title':
            continue
        if not started:
            # 跳过空段落、Title、备选标题区：直到遇到正式正文
            if not preview.strip():
                continue
            if preview == '备选标题：' or re.match(r'^\d+[.、]', preview):
                continue
            if preview.startswith('备选标题'):
                continue
            started = True
        if not preview.strip() and ntype in ('Paragraph', 'Heading'):
            # 跳过空段落，避免消费正文行导致错位
            continue
        if preview == '[Image]':
            if image_idx < len(url_images):
                body_blocks.append({'type': 'image', 'url': url_images[image_idx]['image_url']})
                image_idx += 1
            continue
        if ntype in ('Paragraph', 'Heading'):
            # 取下一行正文（跳过空行）
            while line_idx < len(body_lines) and not body_lines[line_idx]:
                line_idx += 1
            if line_idx < len(body_lines):
                text = body_lines[line_idx]
                line_idx += 1
                if ntype == 'Heading':
                    body_blocks.append({'type': 'heading', 'level': node.get('heading_level') or 1, 'text': text})
                else:
                    body_blocks.append({'type': 'text', 'text': text})
            elif preview and preview != '[Image]':
                # 结构里有但正文行缺失，用预览兜底（可能截断，但至少不丢）
                body_blocks.append({'type': 'text', 'text': preview})
        elif ntype == 'Table':
            # 表格：从结构接口取完整单元格，并消费 get_content 中对应的表格行，保持后续行对齐
            rows = []
            for row in (node.get('table_rows') or []):
                cells = []
                for cell in (row.get('cells') or []):
                    cells.append((cell.get('text_preview') or '').strip())
                rows.append(cells)
            row_count = node.get('row_count') or len(rows)
            col_count = node.get('col_count') or (len(rows[0]) if rows else 0)
            # 消费 get_content 中表格占用的行数（每格一行），并用完整原文替换可能截断的 text_preview
            cell_count = row_count * col_count
            consumed_lines = []
            while line_idx < len(body_lines) and len(consumed_lines) < cell_count:
                line = body_lines[line_idx].strip()
                if line:
                    consumed_lines.append(line)
                line_idx += 1
            # 按行优先填充完整单元格文本
            full_rows = []
            idx = 0
            for r_i, row in enumerate(rows):
                new_row = []
                for c_i, cell in enumerate(row):
                    if idx < len(consumed_lines):
                        new_row.append(consumed_lines[idx])
                        idx += 1
                    else:
                        new_row.append(cell)
                full_rows.append(new_row)
            rows = full_rows
            body_blocks.append({'type': 'table', 'rows': rows, 'row_count': row_count, 'col_count': col_count})
        elif ntype in ('TextBox', 'CodeBlock', 'HighlightBlock'):
            # 简单平台不处理复杂块，尽量保留文本预览
            if preview and preview != '[Image]':
                body_blocks.append({'type': 'text', 'text': preview})

    # 下载图片
    image_files = []
    for i, img in enumerate(url_images, 1):
        ext = '.png'
        url_path = urllib.parse.urlparse(img['image_url']).path.lower()
        if url_path.endswith('.jpg') or url_path.endswith('.jpeg'):
            ext = '.jpg'
        elif url_path.endswith('.webp'):
            ext = '.webp'
        path = os.path.join(out_dir, f'图片{i}{ext}')
        download_image(img['image_url'], path, referer=doc_url)
        image_files.append(path)
        print(f'  图片{i}: {img["image_url"]} -> {path}')

    # 将 body_blocks 中的 image url 替换为文件路径
    img_iter = iter(image_files)
    for b in body_blocks:
        if b['type'] == 'image':
            b['file'] = next(img_iter, None)

    # 生成发布用文本
    plain, md, html_parts, txt_parts = [], [], [], []
    for b in body_blocks:
        if b['type'] == 'image':
            plain.append('[图片]')
            md.append('![图片](' + (b.get('file') or '') + ')')
            # 中转 HTML 不插图片占位（平台脚本会按 article.json 插入本地图片）
            continue
        if b['type'] == 'table':
            rows = b.get('rows') or []
            # 纯文本：每行用“ | ”连接
            table_txt = '\n'.join(' | '.join(cell for cell in row) for row in rows)
            plain.append(table_txt)
            # Markdown 表格
            if rows:
                md_lines = []
                header = rows[0]
                md_lines.append('| ' + ' | '.join(header) + ' |')
                md_lines.append('| ' + ' | '.join(['---'] * len(header)) + ' |')
                for row in rows[1:]:
                    md_lines.append('| ' + ' | '.join(row) + ' |')
                md.append('\n'.join(md_lines))
            # HTML 表格：通用 table 标签，多数编辑器可识别
            html = '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%">'
            for row in rows:
                html += '<tr>' + ''.join(f'<td>{cell}</td>' for cell in row) + '</tr>'
            html += '</table>'
            html_parts.append(html)
            txt_parts.append(table_txt)
            continue
        text = b.get('text') or ''
        if b['type'] == 'heading':
            plain.append(text)
            md.append('## ' + text)
            html_parts.append(f'<h2>{text}</h2>')
        elif b['type'] == 'bullet':
            plain.append('• ' + text)
            md.append('- ' + text)
            html_parts.append(f'<ul><li>{text}</li></ul>')
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
        'doc_token': doc_url,
        'main_title': main_title,
        'alt_titles': alt_titles,
        'body_blocks': body_blocks,
        'images': [{'url': img.get('image_url'), 'file': f}
                   for img, f in zip(url_images, image_files)],
    }
    with open(os.path.join(out_dir, 'article.json'), 'w', encoding='utf-8') as f:
        json.dump(article, f, ensure_ascii=False, indent=2)

    # 校验：比对提取正文与 get_content 原始正文（去掉备选标题后），防止截断/丢表格
    import re as _re
    def _norm(s):
        return _re.sub(r'\s+', '', s or '')
    source_body = '\n'.join(body_lines)
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
        print(f'[校验警告] 提取内容可能不完整: source={src_len} extracted={ext_len} ratio={ratio:.2%}')
    else:
        print(f'[校验] 内容完整: source={src_len} extracted={ext_len} ratio={ratio:.2%}')

    print(f'\n正文块: {len(body_blocks)} 个, 图片: {len(image_files)} 张')
    print('完成:', out_dir)

if __name__ == '__main__':
    main()
