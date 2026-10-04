#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布前图片压缩脚本。

用法:
  python3 scripts/common/compress_images.py <workdir>

作用:
  读取 <workdir>/article.json 中引用的图片文件，将超过 5MB 的图片压缩到 5MB 以内，
  原地覆盖图片文件；如果原始格式为 PNG/WebP，会转存为 JPEG 并更新 article.json 中
  对应的 file 路径为 .jpg，保证发布脚本读取的是压缩后的文件。

目标上限:
  MAX_BYTES = 5 * 1024 * 1024，实际会略低于 5MB 留安全余量。
"""
import os
import sys
import json
from PIL import Image

MAX_BYTES = 5 * 1024 * 1024
SAFE_BYTES = MAX_BYTES - 200 * 1024  # 留 200KB 余量
MAX_SIDE = 4096


def compress_to_jpeg(path):
    """压缩单张图片到目标大小以内，返回 (new_path, changed)。"""
    size = os.path.getsize(path)
    if size <= SAFE_BYTES:
        return path, False

    img = Image.open(path)
    if img.mode in ('RGBA', 'P', 'LA'):
        # 白底合成，避免透明 PNG 转 JPEG 出现黑底
        rgba = img.convert('RGBA')
        background = Image.new('RGB', rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        img = background
    else:
        img = img.convert('RGB')

    # 限制最长边，避免超大原图
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)

    new_ext = '.jpg'
    new_path = os.path.splitext(path)[0] + new_ext

    quality = 92
    while quality >= 30:
        img.save(new_path, 'JPEG', quality=quality, optimize=True)
        if os.path.getsize(new_path) <= SAFE_BYTES:
            if new_path != path:
                os.replace(new_path, path)
                return path, True
            return path, True
        quality -= 10

    # 质量降到 30 仍超限：继续缩小尺寸
    scale = 0.9
    while scale > 0.3:
        w = max(1, int(img.width * scale))
        h = max(1, int(img.height * scale))
        tmp = img.resize((w, h), Image.LANCZOS)
        tmp.save(new_path, 'JPEG', quality=80, optimize=True)
        if os.path.getsize(new_path) <= SAFE_BYTES:
            if new_path != path:
                os.replace(new_path, path)
            return path, True
        scale -= 0.1

    raise RuntimeError(f'图片无法压缩到 5MB 以内: {path} ({os.path.getsize(path)} bytes)')


def main():
    if len(sys.argv) < 2:
        print('用法: python3 compress_images.py <workdir>')
        sys.exit(1)
    workdir = sys.argv[1]
    article_path = os.path.join(workdir, 'article.json')
    if not os.path.exists(article_path):
        print(f'未找到 article.json: {article_path}')
        sys.exit(1)

    with open(article_path, 'r', encoding='utf-8') as f:
        article = json.load(f)

    image_paths = []
    for img in article.get('images', []):
        if img.get('file'):
            image_paths.append(img['file'])
    for block in article.get('body_blocks', []):
        if block.get('type') == 'image' and block.get('file'):
            image_paths.append(block['file'])
    # 去重且仅保留存在的文件
    seen = set()
    targets = []
    for p in image_paths:
        rp = os.path.abspath(p)
        if rp not in seen and os.path.exists(rp):
            seen.add(rp)
            targets.append(rp)

    changed = []
    for p in targets:
        try:
            final_path, ok = compress_to_jpeg(p)
            if ok:
                changed.append((p, final_path, os.path.getsize(final_path)))
        except Exception as e:
            print(f'[压缩失败] {p}: {e}', file=sys.stderr)
            sys.exit(1)

    # 若路径发生变化（例如 .png -> 覆盖为 .jpg 内容但文件名未变，上面统一覆盖原路径），
    # compress_to_jpeg 总是 os.replace 到原 path，因此 article.json 无需改路径。
    # 这里仅重新读取文件大小用于日志。
    for p in targets:
        if os.path.getsize(p) > SAFE_BYTES:
            print(f'[警告] 压缩后仍接近/超过限制: {p} {os.path.getsize(p)} bytes', file=sys.stderr)

    if changed:
        print(f'压缩完成: {len(changed)} 张图片')
        for old, new, size in changed:
            print(f'  {old} -> {size} bytes')
    else:
        print('无需压缩（所有图片均 <=5MB）')


if __name__ == '__main__':
    main()
