# -*- coding: utf-8 -*-
"""飞书剪贴板 HTML → 通用 <p> 结构转换器
====================================
用于解决部分平台编辑器（如汽车之家）粘贴飞书 HTML 时丢失换行的问题：
- 以根 div 的直接子元素为块
- 删除备选标题块；顶层 div → <p>（内部换行转 <br>）
- h2/h3/p 保留、ul/ol 保留（li 内 div → 文本）、纯图片块保留 <img>
输出: 转换后 HTML 片段 + 纯文本（供剪贴板 UnicodeText 格式）

用法: python transform_clipboard.py <输入html文件> <输出html文件> <输出txt文件>
输入文件为 CF_HTML（PowerShell Clipboard.GetText(TextDataFormat::Html) 的原始输出）。
"""
import re, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

VOID = {'img', 'br', 'hr', 'meta', 'link', 'input'}
TAG_RE = re.compile(r'<(/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)>')

def get_blocks(src):
    """返回根元素直接子块的原文切片 [(start, end)]"""
    blocks = []
    depth = 0
    root_started = False
    block_start = None
    for m in TAG_RE.finditer(src):
        closing, tag = m.group(1) == '/', m.group(2).lower()
        if tag in VOID and not closing:
            if depth == 1:
                blocks.append((m.start(), m.end()))
            continue
        if not closing:
            if not root_started:
                root_started = True
                depth = 1
                continue
            if depth == 1:
                block_start = m.start()
            depth += 1
        else:
            depth -= 1
            if depth == 1 and block_start is not None:
                blocks.append((block_start, m.end()))
                block_start = None
    return blocks


def main():
    in_path, out_html, out_txt = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(in_path, encoding='utf-8') as f:
        raw = f.read()

    m = re.search(r'<!--StartFragment-->(.*?)<!--EndFragment-->', raw, re.S)
    src = m.group(1) if m else raw
    src = re.sub(r'<meta[^>]*>', '', src)

    def strip_tags(s):
        s = re.sub(r'<br\s*/?>', '\n', s)
        return re.sub(r'<[^>]+>', '', s)

    def inline_fix(h):
        return h.replace('\n', '<br>')

    out_blocks, text_lines = [], []
    for s, e in get_blocks(src):
        full = src[s:e]
        if not full.strip():
            continue
        tag_m = re.match(r'<([a-zA-Z][a-zA-Z0-9]*)', full)
        tag = tag_m.group(1).lower() if tag_m else 'text'
        # 去掉最外层标签得到内部内容
        inner = re.sub(r'^<[^>]+>', '', full, count=1)
        inner = re.sub(r'<[^>]+>\s*$', '', inner)
        if tag == 'img':
            out_blocks.append(full)
            text_lines.append('[图片]')
        elif tag == 'div':
            if '<img' in inner and not strip_tags(inner).strip():
                out_blocks.append(inner)
                text_lines.append('[图片]')
            else:
                out_blocks.append('<p>' + inline_fix(inner) + '</p>')
                text_lines.append(strip_tags(inner))
        elif tag in ('h2', 'h3', 'h4', 'p'):
            out_blocks.append('<' + tag + '>' + inline_fix(inner) + '</' + tag + '>')
            text_lines.append(strip_tags(inner))
        elif tag in ('ul', 'ol'):
            li_inner = re.sub(r'<div[^>]*>(.*?)</div>',
                              lambda mm: inline_fix(mm.group(1)), inner, flags=re.S)
            out_blocks.append('<' + tag + '>' + li_inner + '</' + tag + '>')
            lis = [strip_tags(li).strip() for li in re.findall(r'<li[^>]*>(.*?)</li>', li_inner, re.S)]
            text_lines.append('• ' + '\n• '.join(lis))
        else:
            out_blocks.append('<p>' + inline_fix(inner) + '</p>')
            text_lines.append(strip_tags(inner))

    final_html_blocks, final_text = [], []
    for h, t in zip(out_blocks, text_lines):
        if '备选标题' in t:
            continue
        final_html_blocks.append(h)
        final_text.append(t)

    with open(out_html, 'w', encoding='utf-8') as f:
        f.write('\n'.join(final_html_blocks))
    with open(out_txt, 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(final_text))
    print('blocks:', len(final_html_blocks), '| text chars:', sum(len(t) for t in final_text))


if __name__ == '__main__':
    main()
