// 汽车之家发布脚本
// 用法: node publish_autohome.js --title "标题" --doc-url "飞书文档URL" --state "登录状态.json" --image 图片路径 [--workdir 工作目录] [--headed]
// 特殊流程（本平台独有）: 剪贴板 HTML 转 <p> 结构修复换行丢失；图片粘贴失败时改用编辑器本地上传
const path = require('path');
const fs = require('fs');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml,
  setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, dragDelete, waitFor, mainArgs,
  getTopLevelBlockSlices,
  waitForImagesUploaded, acquireClipboardLock, releaseClipboardLock,
  PUBLISH_WORKSPACE_DIR,
} = require('../common/common.js');

const PUBLISH_URL = 'https://creator.autohome.com.cn/web/publish/bbs';
const WORKDIR_DEFAULT = PUBLISH_WORKSPACE_DIR;

// 汽车之家“段落标题”限制为 2～30 字（实测超过 30 字会导致发布按钮不可用/发布失败）。
// 这里在粘贴前自动检测 h1-h6，并尽量保留原意地缩短到 30 字以内。
const AUTOHOME_HEADING_MAX = 30;
const AUTOHOME_WEAK_HEADING_WORDS = [
  '需求', '推荐', '指南', '参考', '清单', '决策', '攻略', '建议', '工具', '体验',
  '怎么选', '怎么样', '怎么办', '如何', '详细', '完整', '实用', '选购', '选择',
  '解析', '评测', '导购', '对比', '比较',
];

function headingVisibleLength(text) {
  // 与平台字数统计保持一致：按用户可见字符数计（中文/数字/字母/符号均算 1 个）。
  return Array.from(text.replace(/\s/g, '')).length;
}

function shortenHeadingText(text, max = AUTOHOME_HEADING_MAX) {
  let t = (text || '').trim();
  if (headingVisibleLength(t) <= max) return t;

  let prefix = '';
  let suffix = t;
  const colonIdx = t.indexOf('：');
  if (colonIdx !== -1) {
    prefix = t.slice(0, colonIdx + 1);
    suffix = t.slice(colonIdx + 1);
  }

  // 优先删除“：”后半句里的弱信息词，尽量不动主标题/前缀。
  for (const word of AUTOHOME_WEAK_HEADING_WORDS) {
    while (headingVisibleLength(prefix + suffix) > max) {
      const idx = suffix.lastIndexOf(word);
      if (idx === -1) break;
      suffix = suffix.slice(0, idx) + suffix.slice(idx + word.length);
    }
    if (headingVisibleLength(prefix + suffix) <= max) break;
  }

  suffix = suffix.replace(/[，,、；;：:\s]+$/g, '');
  if (headingVisibleLength(prefix + suffix) <= max) return prefix + suffix;

  // 仍超长：优先在标点/分隔符处截断，避免从词中间硬切。
  const full = prefix + suffix;
  const chars = Array.from(full);
  let cut = max;
  for (let i = max; i > Math.floor(max * 0.5); i--) {
    if (/[，,、；;：: ]/.test(chars[i - 1] || '')) {
      cut = i - 1;
      break;
    }
  }
  let result = chars.slice(0, cut).join('').replace(/[，,、；;：:\s]+$/g, '');
  if (headingVisibleLength(result) > max) result = chars.slice(0, max).join('');
  return result;
}

function shortenAutohomeHeadings(html) {
  return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, level, attrs, inner) => {
    const plain = inner.replace(/<[^>]+>/g, '').trim();
    const shortened = shortenHeadingText(plain, AUTOHOME_HEADING_MAX);
    if (shortened === plain) return match;
    console.log(`[汽车之家] 段落标题超过 ${AUTOHOME_HEADING_MAX} 字，自动缩短：${plain} -> ${shortened}`);
    return `<h${level}${attrs}>${shortened}</h${level}>`;
  });
}

// 汽车之家编辑器粘贴飞书 HTML 时会把 div 块之间的换行“吞掉”，导致段落挤在一起。
// 这里把飞书根容器下的顶层 div 规范成 <p>/保留标题/列表等块级结构，并在文本块内把换行转 <br>。
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 更稳妥的方式：直接从 article.json 的结构化 body_blocks 生成 Autohome 可粘贴的干净 HTML。
// 每个 text/other 块输出一个 <p>，内部 \n 转 <br>；heading 输出 <h2>；bullet 输出带 • 的段落；
// image 块输出【图N】占位符，后续由脚本按原顺序上传本地图片。
// 这样不依赖飞书剪贴板 HTML 的根节点闭合情况，段落换行不会丢失。
function buildAutohomeHtmlFromArticle(workdir) {
  const articlePath = path.join(workdir, 'article.json');
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const blocks = article.body_blocks || [];
  const parts = [];
  let imgNo = 0;
  for (const b of blocks) {
    const type = b.type || '';
    if (type === 'image') {
      imgNo += 1;
      parts.push(`<p>【图${imgNo}】</p>`);
      continue;
    }
    if (type === 'table') {
      // 若走到了这里说明没有使用 _tableimg 目录；汽车之家不支持富文本表格。
      throw new Error('汽车之家不支持富文本表格，请先运行 table_to_image.js 并把 --workdir 指向 _tableimg 目录');
    }
    const text = (b.text || '').trim();
    if (!text) continue;
    if (type === 'heading') {
      const shortened = shortenHeadingText(text, AUTOHOME_HEADING_MAX);
      if (shortened !== text) {
        console.log(`[汽车之家] 段落标题超过 ${AUTOHOME_HEADING_MAX} 字，自动缩短：${text} -> ${shortened}`);
      }
      parts.push(`<h2>${escapeHtml(shortened)}</h2>`);
    } else {
      const escaped = escapeHtml(text).replace(/\n/g, '<br>');
      if (type === 'bullet') {
        parts.push(`<p>• ${escaped}</p>`);
      } else {
        parts.push(`<p>${escaped}</p>`);
      }
    }
  }
  return parts.join('\n');
}

function normalizeAutohomeHtml(html) {
  const { prefix, suffix, blocks } = getTopLevelBlockSlices(html);
  if (!blocks.length) return html;

  const blockTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote', 'table']);
  const out = [];
  for (const block of blocks) {
    const raw = html.slice(block.start, block.end).trim();
    if (!raw) continue;
    const tagMatch = raw.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
    const tag = tagMatch ? tagMatch[1].toLowerCase() : '';
    const inner = raw.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>\s*$/, '');

    if (tag === 'div') {
      const child = inner.trim();
      const childMatch = child.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
      const childTag = childMatch ? childMatch[1].toLowerCase() : '';
      if (blockTags.has(childTag)) {
        // 飞书正文通常用 <div><h2>…</h2></div> 包裹，拆掉外层 div 保留真正的块标签。
        out.push(child);
      } else {
        out.push(`<p>${child.replace(/\n/g, '<br>')}</p>`);
      }
    } else if (blockTags.has(tag)) {
      out.push(raw);
    } else {
      out.push(`<p>${inner.replace(/\n/g, '<br>')}</p>`);
    }
  }
  return prefix + out.join('') + suffix;
}

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state || !args.image) {
    console.error('缺少参数: --title / --doc-url / --state / --image 必填');
    process.exit(1);
  }
  const workDir = args.workdir || WORKDIR_DEFAULT;

  const browser = await launch({ headless: !args.headed });
  try {
    const { context, page } = await openPage(browser, args.state);
    page.__articleImage = args.image;
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    if (page.url().includes('account.autohome.com.cn')) {
      console.error('未登录汽车之家，请先手动登录并 state-save 后再运行');
      process.exit(1);
    }

    // 1. 标题
    await page.locator('input[placeholder*="请输入文章标题"]').fill(args.title);
    console.log('[汽车之家] 标题已填');

    // 2. 正文：优先用 article.json 结构化生成干净 HTML；
    //    没有 article.json 时再回退到飞书剪贴板 HTML（删除 <img>、备选标题并规范化）。
    const articleJsonPath = path.join(workDir, 'article.json');
    const articleJson = args.workdir && fs.existsSync(articleJsonPath)
      ? JSON.parse(fs.readFileSync(articleJsonPath, 'utf8'))
      : null;
    const useArticleJson = !!articleJson;

    let imgCount = 0;
    let pasted = false;
    for (let pasteAttempt = 0; pasteAttempt < 3 && !pasted; pasteAttempt++) {
      let cleanedHtml;
      if (useArticleJson) {
        cleanedHtml = buildAutohomeHtmlFromArticle(workDir);
        imgCount = (articleJson.body_blocks || []).filter(b => b.type === 'image').length;
        console.log('[汽车之家] 使用 article.json 结构化正文（段落/标题/图片占位）');
      } else {
        let raw;
        if (args.workdir && fs.existsSync(path.join(args.workdir, '正文_clean.html'))) {
          raw = fs.readFileSync(path.join(args.workdir, '正文_clean.html'), 'utf8');
          console.log('[汽车之家] 使用本地中转文件');
        } else {
          await copyFromFeishu(context, args['doc-url']);
          raw = await readClipboardHtml(page);
          fs.mkdirSync(workDir, { recursive: true });
          const rawHtml = path.join(workDir, 'clipboard_raw.html');
          fs.writeFileSync(rawHtml, raw, 'utf8');
        }

        // 将 <img> 替换为占位符，后续按占位符位置逐张上传
        imgCount = 0;
        cleanedHtml = raw.replace(/<img[^>]*>/gi, () => {
          imgCount++;
          return `【图${imgCount}】`;
        });
        // 在中转 HTML 中直接删除「备选标题」块，避免粘贴后再删误删占位符
        cleanedHtml = removeAltBlockFromHtml(cleanedHtml, loadMainTitle(workDir));
        // 汽车之家特有：段落标题限 2～30 字；粘贴富文本会吞 div 换行，先统一规范化
        cleanedHtml = shortenAutohomeHeadings(cleanedHtml);
        cleanedHtml = normalizeAutohomeHtml(cleanedHtml);
      }
      const cleanHtml = path.join(workDir, 'clipboard_clean.html');
      const cleanTxt = path.join(workDir, 'clipboard_clean.txt');
      fs.writeFileSync(cleanHtml, cleanedHtml, 'utf8');
      fs.writeFileSync(cleanTxt, cleanedHtml
        .replace(/<\/(p|h[1-6]|li|blockquote|table)>/gi, '\n')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n'), 'utf8');
      // 剪贴板是跨平台共享资源：并发发布时用锁把「写剪贴板 → 粘贴 → 确认」串行化
      await acquireClipboardLock();
      try {
        await setClipboard(page, cleanHtml, cleanTxt);

        await page.locator('.editor-input').click();
        await page.keyboard.press('Control+V');
        try {
          await waitFor(async () => page.locator('.editor-input').innerText().then(t => t.length > 2000),
            { timeout: 60000, label: `正文粘贴完成(${pasteAttempt + 1})` });
          pasted = true;
        } catch (e) {
          if (pasteAttempt === 2) throw e;
          console.log(`[汽车之家] 第${pasteAttempt + 1}次粘贴未生效，重试`);
          await page.waitForTimeout(2000);
        }
      } finally {
        releaseClipboardLock();
      }
    }
    console.log('[汽车之家] 正文已粘贴（图片已移除，保留格式）');

    // 备选标题已在中转 HTML 中删除，这里不再做粘贴后删除，避免误删图片占位符

    // 4. 图片：按占位符位置逐张上传
    // 读取本地图片列表（优先 article.json，按文档顺序）
    let imageFiles = [];
    if (fs.existsSync(articleJsonPath)) {
      try {
        const art = JSON.parse(fs.readFileSync(articleJsonPath, 'utf8'));
        imageFiles = (art.images || []).map(x => x.file).filter(f => fs.existsSync(f));
      } catch (e) { /* ignore */ }
    }
    if (!imageFiles.length) imageFiles = [args.image];
    const uploadCount = Math.min(imgCount, imageFiles.length);
    console.log(`[汽车之家] 检测到 ${imgCount} 个图片占位符，准备上传 ${uploadCount} 张图片`);

    const waitUploadDone = async () => {
      await waitFor(async () => {
        const body = await page.evaluate(() => document.body.innerText);
        return body.includes('已上传图片(1张)') || body.includes('已上传图片(2张)');
      }, { timeout: 120000, interval: 5000, label: '图片上传完成' });
    };

    const insertImageAtPlaceholder = async (placeholder, imagePath) => {
      // 定位占位符文本节点并选中（带重试，等待编辑器 DOM 稳定）
      // 只匹配「图N」核心，避免粘贴后括号等前序字符丢失导致匹配失败
      const numMatch = placeholder.match(/\d+/);
      const shortKey = numMatch ? `图${numMatch[0]}` : placeholder;
      let found = false;
      for (let attempt = 0; attempt < 5 && !found; attempt++) {
        found = await page.evaluate((ph) => {
          const ed = document.querySelector('.editor-input');
          if (!ed) return false;
          const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue.includes(ph)) {
              const range = document.createRange();
              const idx = node.nodeValue.indexOf(ph);
              let start = idx;
              let end = idx + ph.length;
              while (start > 0 && /[A-Za-z_@【】]/.test(node.nodeValue[start - 1])) start--;
              while (end < node.nodeValue.length && /[A-Za-z_@【】]/.test(node.nodeValue[end])) end++;
              range.setStart(node, start);
              range.setEnd(node, end);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              return true;
            }
          }
          return false;
        }, shortKey);
        if (!found) await page.waitForTimeout(500);
      }
      if (!found) {
        console.error(`[汽车之家] 未找到图片占位符 ${placeholder}`);
        return false;
      }
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);

      // 打开添加图片弹窗
      await page.locator('button[data-title="添加图片"]').click();
      await page.waitForTimeout(1500);
      const upBtn = page.getByRole('button', { name: /upload 点击上传/ });
      // 设置本次要上传的图片（全局 filechooser 会使用该路径）
      page.__articleImage = imagePath;
      await upBtn.first().click();
      console.log(`[汽车之家] 上传 ${path.basename(imagePath)} ...`);
      try {
        await waitUploadDone();
      } catch (e) {
        console.log('[汽车之家] 首次等待图片上传超时，取消后重试一次');
        await page.getByRole('button', { name: '取消' }).click().catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('button[data-title="添加图片"]').click();
        await page.waitForTimeout(1000);
        await upBtn.first().click();
        await waitUploadDone();
      }
      // 上传完毕后点击弹窗「确定」，将图片加入正文
      const confirmBtn = page.getByRole('button', { name: '确定', exact: true }).last();
      await confirmBtn.click();
      await page.waitForTimeout(2000);
      console.log(`[汽车之家] 第 ${path.basename(imagePath)} 张图片已插入`);
      return true;
    };

    for (let i = 1; i <= uploadCount; i++) {
      const placeholder = `【图${i}】`;
      const imagePath = imageFiles[i - 1];
      console.log(`[汽车之家] 插入第 ${i}/${uploadCount} 张图片`);
      await insertImageAtPlaceholder(placeholder, imagePath);
    }

    // 验证正文图片已插入（每张图在 .editor-image 内包含 2 个 img：原图+放大镜）
    await waitFor(async () => {
      const n = await page.locator('.editor-image img').count();
      return n >= uploadCount * 2;
    }, { label: '图片插入正文' });
    await page.keyboard.press('Escape').catch(() => {});
    console.log('[汽车之家] 图片已全部本地插入');

    // 调试用：只跑到图片上传完成，后续步骤由人工操作
    if (args['stop-after-images']) {
      console.log('[汽车之家] 已按 --stop-after-images 停在图片上传完成，后续步骤请手动操作；浏览器保持打开');
      await new Promise(() => {});
    }

    // 4.5 等待图片上传 100% 提示出现后再继续，避免发布过快导致图片未就绪
    // 若页面未出现该提示（部分粘贴场景不展示），不阻塞发布流程
    console.log('[汽车之家] 等待图片上传 100% 提示...');
    try {
      await waitFor(async () => {
        const t = await page.evaluate(() => document.body.innerText);
        return t.includes('图片上传 100%');
      }, { timeout: 30000, label: '图片上传100%提示' });
      // 等提示消失，确保图片真正完成
      await waitFor(async () => {
        const t = await page.evaluate(() => document.body.innerText);
        return !t.includes('图片上传 100%');
      }, { timeout: 15000, label: '图片上传提示消失' });
    } catch (e) {
      console.log('[汽车之家] 未检测到图片上传100%提示，继续流程');
    }
    await page.waitForTimeout(1000);
    console.log('[汽车之家] 图片上传完成');

    // 已移除旧的“清理上传失败图片”逻辑：弹窗上传成功的图片域名是 autoimg.cn，
    // 旧逻辑会误删已上传图片。汽车之家现在只走弹窗上传，无需此清理。

    // 5. 作品声明：必选声明 → 含AI生成内容（带重试/JS 兜底）
    await page.locator('#rc_select_0').click();
    await page.waitForTimeout(800);
    const aiOption = page.getByText('含AI生成内容', { exact: true }).first();
    if (!(await aiOption.isVisible().catch(() => false))) {
      console.log('[汽车之家] 声明下拉未展开，重试打开');
      await page.locator('#rc_select_0').click({ force: true });
      await page.waitForTimeout(800);
    }
    try {
      await aiOption.click({ timeout: 5000 });
    } catch (e) {
      console.log('[汽车之家] 声明选项点击失败，改用 JS 点击');
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('span')].find(e => e.textContent.trim() === '含AI生成内容');
        if (el) el.click();
      });
    }
    await page.waitForTimeout(800);
    console.log('[汽车之家] 作品声明已选');

    // 6. 条款 checkbox
    await page.getByRole('checkbox', { name: /我已阅读/ }).check();
    console.log('[汽车之家] 条款已勾选');

    // 6.5 论坛不是必选项，发布与存草稿均不处理“选择论坛”。

    // 7. 存草稿 / 发布
    if (args.draft) {
      await page.getByText('存草稿', { exact: true }).first().click();
      // 汽车之家“存草稿”后通常仍停留在编辑页且没有明显跳转/成功文案，
      // 因此直接回草稿箱列表校验标题，避免误报失败。
      await page.waitForTimeout(3000);
      await page.goto('https://creator.autohome.com.cn/web/content?type=draft', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      const draftText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (!draftText.includes(args.title)) {
        console.error('[汽车之家] 草稿箱未找到刚保存的标题，可能保存失败:', args.title);
        process.exit(1);
      }
      console.log('OK: 汽车之家存草稿成功:', args.title);
    } else {
    // 7.1 发布（带重试；成功会出现「发布成功」弹窗或跳转帖子页）
    let published = false;
    for (let attempt = 0; attempt < 3 && !published; attempt++) {
      await page.getByRole('button', { name: '发布', exact: true }).click();
      // 如果弹出确认/安全验证类模态框，先记录并尝试自动确认
      await page.waitForTimeout(2000);
      const modalText = await page.evaluate(() => {
        const vis = [...document.querySelectorAll('.ant-modal-wrap:not([style*="display: none"]), [class*=modal]:not([style*="display: none"])')]
          .filter(e => (e.innerText || '').trim());
        return vis.map(e => (e.innerText || '').trim().slice(0, 300)).join(' | ');
      }).catch(() => '');
      if (modalText) {
        console.log('[汽车之家] 发布后出现弹窗:', modalText.slice(0, 200));
        for (const name of ['确定', '继续', '我知道了', '确认发布', '同意并发布']) {
          const btn = page.getByRole('button', { name, exact: true }).first();
          if (await btn.count().catch(() => 0)) {
            try { await btn.click({ timeout: 3000 }); console.log('[汽车之家] 已点击弹窗按钮:', name); } catch (e) {}
            break;
          }
        }
      }
      try {
        await waitFor(async () => {
          const t = await page.evaluate(() => document.body.innerText);
          return page.url().includes('club.autohome.com.cn/bbs/thread')
            || t.includes('发布成功')
            || (page.url().includes('/web/content') && t.includes(args.title));
        }, { timeout: 30000, label: '发布成功提示或跳转' });
        // 已成功；再等跳转帖子页（不强制）
        try {
          await waitFor(async () => page.url().includes('club.autohome.com.cn/bbs/thread'),
            { timeout: 15000, label: '跳转帖子页' });
        } catch (e) { /* 已出现发布成功弹窗即可 */ }
        published = true;
      } catch (e) {
        console.log(`[汽车之家] 第${attempt + 1}次发布未成功，重试`);
        try {
          const url = page.url();
          const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
          console.log(`[汽车之家] 失败时 URL: ${url}`);
          console.log(`[汽车之家] 失败时页面文本: ${body.replace(/\n/g, ' ').slice(0, 300)}`);
          console.log(`[汽车之家] 失败时页面尾部: ${body.replace(/\n/g, ' ').slice(-800)}`);
        } catch (e2) {}
        await page.waitForTimeout(3000);
      }
    }
    if (!published) throw new Error('发布未成功');
    console.log('OK: 汽车之家发布成功:', page.url());
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
