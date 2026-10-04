#!/usr/bin/env node
// 表格转图片工具（article-publisher）
//
// 用途：
//   当目标平台编辑器不支持表格，或不想把表格降级成 "|" 分隔纯文本时，
//   先把 article.json 中的 table 块渲染成图片，生成一个“表格图片版”工作目录，
//   再把发布脚本的 --workdir 指向该目录。
//
// 用法：
//   node scripts/common/table_to_image.js \
//     --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/<编号>" \
//     [--output-dir "/home/zzk/geo/发布工作区/<项目名>/articles/<编号>_tableimg"] \
//     [--max-width 900]
//
// 输出：
//   <output-dir>/表格N.png         每张表格渲染后的图片
//   <output-dir>/article.json      表格块已被替换为 image 块的版本，images 顺序同步重建
const fs = require('fs');
const path = require('path');
const { loadPlaywright, mainArgs } = require('./common.js');

function escCell(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function buildTableHtml(rows) {
  const head = (rows[0] || []).map(c => `<th>${escCell(c)}</th>`).join('');
  const body = rows.slice(1).map(row =>
    `<tr>${row.map(c => `<td>${escCell(c)}</td>`).join('')}</tr>`
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { padding: 24px; background: #fff; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d0d0d0; padding: 10px 12px; font-size: 14px; line-height: 1.5; text-align: left; vertical-align: top; word-break: break-word; }
    tr:first-child th, tr:first-child td { background: #f2f3f5; font-weight: 600; }
  </style></head><body><table>${head ? `<tr>${head}</tr>` : ''}${body}</table></body></html>`;
}

async function renderTableImage(html, outPath, maxWidth) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: maxWidth + 80, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.setContent(html, { waitUntil: 'load' });
    const table = page.locator('table');
    const box = await table.boundingBox();
    if (!box) throw new Error('无法获取表格渲染区域');
    await page.screenshot({
      path: outPath,
      clip: {
        x: Math.floor(box.x),
        y: Math.floor(box.y),
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      },
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = mainArgs();
  const workdir = args.workdir;
  if (!workdir) {
    console.error('缺少参数: --workdir 必填');
    process.exit(1);
  }
  const articlePath = path.join(workdir, 'article.json');
  if (!fs.existsSync(articlePath)) {
    console.error('不存在 article.json:', articlePath);
    process.exit(1);
  }
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const blocks = article.body_blocks || [];
  const tables = blocks.filter(b => b.type === 'table');
  if (!tables.length) {
    console.log('未发现 table 块，无需转换:', workdir);
    return;
  }

  const outputDir = args['output-dir']
    || path.join(path.dirname(workdir), `${path.basename(workdir)}_tableimg`);
  const maxWidth = args['max-width'] ? Number(args['max-width']) : 900;
  const absWorkdir = path.resolve(workdir);
  const absOutputDir = path.resolve(outputDir);
  if (absOutputDir === absWorkdir) {
    console.error('--output-dir 不能与 --workdir 相同；请使用新的目录');
    process.exit(1);
  }

  // 复制原工作目录到表格图片版目录，避免影响原 article.json / 图片
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(workdir, outputDir, { recursive: true });

  // 原 article.json 里的图片路径可能是旧路径；复制后统一修正到新目录内实际存在的文件。
  // 注意：飞书 image 块可能没有 file 字段，需要通过原 article.images 的 token 映射找回本地文件。
  const originalImageByToken = new Map((article.images || []).map(img => [img.token, img.file]));

  const newBlocks = [];
  let tableNo = 0;
  for (const b of blocks) {
    if (b.type === 'image') {
      // 修正原正文图片：优先用 b.file 的 basename 找复制后的文件；没有 file 时按 token 找回。
      let localFile = b.file || '';
      if (localFile && !fs.existsSync(localFile)) {
        const candidate = path.join(outputDir, path.basename(localFile));
        if (fs.existsSync(candidate)) localFile = candidate;
      }
      if (!localFile || !fs.existsSync(localFile)) {
        const srcFile = originalImageByToken.get(b.token);
        if (srcFile) {
          const candidate = path.join(outputDir, path.basename(srcFile));
          if (fs.existsSync(candidate)) localFile = candidate;
        }
      }
      b.file = localFile || '';
      newBlocks.push(b);
    } else if (b.type === 'table') {
      tableNo += 1;
      const imgName = `表格${tableNo}.png`;
      const imgPath = path.join(outputDir, imgName);
      console.log(`渲染表格${tableNo} -> ${imgPath}`);
      await renderTableImage(buildTableHtml(b.rows || []), imgPath, maxWidth);
      newBlocks.push({
        type: 'image',
        token: `table_image_${tableNo}`,
        file: imgPath,
        table_image: true,
        table_index: tableNo,
      });
    } else {
      newBlocks.push(b);
    }
  }

  article.body_blocks = newBlocks;
  article.images = newBlocks
    .filter(b => b.type === 'image')
    .map(b => ({ token: b.token || '', file: b.file || '' }));
  article.table_as_images = true;
  article.original_table_count = tables.length;

  fs.writeFileSync(path.join(outputDir, 'article.json'), JSON.stringify(article, null, 2), 'utf8');

  // 表格图片版必须同步重写正文 HTML/TXT：把 <table> 替换成 base64 <img>，
  // 否则多数发布脚本（懂车帝/汽车之家/易车）直接粘贴 HTML 时仍会贴到原表格。
  const htmlPath = path.join(outputDir, '正文_clean.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    let replacedCount = 0;
    html = html.replace(
      /<div>\s*<table[\s\S]*?<\/table>\s*<\/div>|<table[\s\S]*?<\/table>/gi,
      (match) => {
        replacedCount += 1;
        const imgPath = path.join(outputDir, `表格${replacedCount}.png`);
        const data = fs.readFileSync(imgPath).toString('base64');
        return `<div><img src="data:image/png;base64,${data}" data-table-image="${replacedCount}"></div>`;
      }
    );
    if (replacedCount !== tables.length) {
      console.warn(`[table_to_image] 警告：HTML 中实际替换 ${replacedCount} 个表格，article.json 中有 ${tables.length} 个表格`);
    }
    fs.writeFileSync(htmlPath, html, 'utf8');

    const txt = html
      .replace(/<\/(div|p|h[1-6]|li|blockquote|table)>/gi, '\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(path.join(outputDir, '正文_clean.txt'), txt, 'utf8');
    console.log(`表格图片版 HTML/TXT 已重写: ${htmlPath}`);
  }

  console.log(`表格图片版已生成: ${outputDir}`);
  console.log(`发布时 --workdir 请使用: ${outputDir}`);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
