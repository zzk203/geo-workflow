// 各平台发布脚本的公共工具库（Linux 版）
// - Playwright 加载（本地 node_modules 优先，回退全局 @playwright/cli）
// - 浏览器/上下文启动（支持登录状态文件 + 剪贴板权限）
// - 飞书文档复制（Ctrl+A/Ctrl+C，每次粘贴前重新复制保证图片签名 URL 新鲜）
// - 剪贴板读写：使用浏览器 navigator.clipboard（Linux/WSL 无需 PowerShell/xclip）
// - 拖拽删除、等待验证等辅助函数
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// 发布工作区固定位于 DSH 工作区根目录（/home/zzk/geo/发布工作区），不在 skill 目录下。
// common.js 位于 <工作区>/.agents/skills/article-publisher/scripts/common，
// 向上 5 级回到工作区根目录；也允许用环境变量 ARTICLE_PUBLISHER_WORKSPACE 覆盖。
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const PUBLISH_WORKSPACE_DIR = process.env.ARTICLE_PUBLISHER_WORKSPACE
  || path.join(WORKSPACE_ROOT, '发布工作区');

// ---------- Playwright 加载 ----------
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* 本地没有时走 cli 依赖 */ }
  const { createRequire } = require('module');
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'cli', 'package.json') : '',
    path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules', '@playwright', 'cli', 'package.json'),
    path.join(process.env.HOME || '', '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@playwright', 'cli', 'package.json'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return createRequire(p)('playwright');
  }
  throw new Error('未找到 playwright 模块，请在 article-publisher 目录执行 npm install playwright');
}

// 当前浏览器是否为无头模式。无头模式下 Chromium 的剪贴板是**进程内**实现，
// 多个平台并发发布时互不干扰，因此剪贴板锁自动退化为空操作；
// 只有有头（--headed，通常用于 debug）时才会真正走系统剪贴板、需要串行化。
let IS_HEADLESS = true;

async function launch({ headless = true } = {}) {
  IS_HEADLESS = !!headless;
  const { chromium } = loadPlaywright();
  try {
    return await chromium.launch({ headless });
  } catch (e) {
    console.log('[common] 默认浏览器启动失败，改用系统 Chrome:', String(e.message).split('\n')[0]);
    return await chromium.launch({ headless, channel: 'chrome' });
  }
}

async function openPage(browser, stateFile) {
  const context = await browser.newContext({
    storageState: stateFile,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  // Linux 剪贴板读写走浏览器 API，需要 clipboard 权限
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(e => {
    console.log('[common] 授予剪贴板权限失败（忽略）:', e.message);
  });
  const page = await context.newPage();
  // 全局文件选择器兜底：任何 filechooser 都自动填入文章图片
  // （规避易车/汽车之家点击上传按钮时堆积多个 filechooser 阻塞流程的问题）
  page.on('filechooser', async fc => {
    const img = page.__articleImage;
    if (img && !page.__ignoreFileChooser) {
      console.log('[common] filechooser 出现，自动填入:', img);
      try { await fc.setFiles(img); } catch (e) { console.log('[common] setFiles 失败:', e.message); }
    } else if (page.__ignoreFileChooser) {
      console.log('[common] 忽略多余 filechooser（只保留第一张封面图）');
    }
  });
  return { context, page };
}

// ---------- 剪贴板桥接（Linux 版） ----------
// 读取当前系统剪贴板中的 HTML；优先 text/html，回退 text/plain
async function readClipboardHtml(page) {
  try {
    const html = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const blob = await item.getType('text/html');
          return await blob.text();
        }
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          return await blob.text();
        }
      }
      return '';
    });
    return html || '';
  } catch (e) {
    console.log('[common] 读取剪贴板 HTML 失败（可尝试手动复制）:', e.message);
    return '';
  }
}

// 写剪贴板：htmlFile=HTML片段文件（或 null），txtFile=纯文本文件
async function setClipboard(page, htmlFile, txtFile) {
  if (htmlFile) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const txt = txtFile ? fs.readFileSync(txtFile, 'utf8') : html.replace(/<[^>]+>/g, '');
    await page.evaluate(async ({ html, txt }) => {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([txt], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
    }, { html, txt });
  } else {
    const txt = fs.readFileSync(txtFile, 'utf8');
    await page.evaluate(async (txt) => {
      await navigator.clipboard.writeText(txt);
    }, txt);
  }
  console.log('[common] 剪贴板已写入');
}

// 飞书剪贴板 HTML → p 结构（修复换行丢失），返回 [htmlFile, txtFile]
function transformFeishuClipboard(workDir, feishuRaw) {
  fs.mkdirSync(workDir, { recursive: true });
  const rawFile = path.join(workDir, 'clipboard_raw.html');
  const htmlFile = path.join(workDir, 'clipboard_fixed.html');
  const txtFile = path.join(workDir, 'clipboard_fixed.txt');
  fs.writeFileSync(rawFile, feishuRaw, 'utf8');
  execSync(`python3 "${path.join(__dirname, 'transform_clipboard.py')}" "${rawFile}" "${htmlFile}" "${txtFile}"`, { encoding: 'utf8' });
  return [htmlFile, txtFile];
}

// 从本地中转文件写入剪贴板；文件不存在时返回 false
async function setClipboardFromIntermediate(page, workdir) {
  const htmlFile = path.join(workdir, '正文_clean.html');
  const txtFile = path.join(workdir, '正文_clean.txt');
  if (!fs.existsSync(htmlFile) || !fs.existsSync(txtFile)) return false;
  await setClipboard(page, htmlFile, txtFile);
  return true;
}

// ---------- 正文图片"转存完成"判定 ----------
// 平台编辑器都是异步把粘贴进来的图片转存到自家 CDN：刚粘贴时 src 还是
// data:/blob:（本地内嵌图）或飞书签名 URL，转存完成后才换成平台 CDN 地址。
// 这里按**状态**等待（不再用固定长延时）：
//   所有正文图片的 src 都已不是 data:/blob:/飞书，且图片真正加载完成。
// 转存快就立刻返回；真的失败则明确超时报错，而不是靠拉长时间掩盖。
async function waitForImagesUploaded(page, {
  selector = 'img', frameSelector = null, ignoreSrc = null,
  timeout = 180000, interval = 3000, minCount = 1, label = '正文图片转存完成',
} = {}) {
  const collect = async () => {
    const fn = (imgs, ignore) => imgs
      .map(i => ({ src: i.src || '', loaded: !!(i.complete && i.naturalWidth > 0) }))
      .filter(o => !(ignore && o.src.includes(ignore)));
    if (frameSelector) {
      return await page.frameLocator(frameSelector).locator(selector).evaluateAll(fn, ignoreSrc);
    }
    return await page.locator(selector).evaluateAll(fn, ignoreSrc);
  };

  let last = [];
  await waitFor(async () => {
    last = await collect();
    if (last.length < minCount) return false;
    return last.every(o => o.src
      && !o.src.startsWith('data:')
      && !o.src.startsWith('blob:')
      && !o.src.includes('feishu.cn')
      && o.loaded);
  }, { timeout, interval, label });

  const pending = last.filter(o => !o.src || o.src.startsWith('data:') || o.src.startsWith('blob:'));
  console.log(`[common] ${label}: ${last.length} 张图片全部转存完成`);
  return { count: last.length, pending: pending.length, srcs: last.map(o => o.src) };
}

// ---------- 剪贴板跨进程互斥锁 ----------
// 多个平台并发发布时，系统剪贴板是**共享资源**：A 写入后若 B 抢先写入，
// A 的 Ctrl+V 就会贴到 B 的正文。这里用 mkdir 原子性做跨进程锁，
// 把「写剪贴板 → 粘贴 → 确认粘贴成功」整段作为临界区串行化。
const CLIPBOARD_LOCK_DIR = path.join(os.tmpdir(), 'article-publisher-clipboard.lock');

async function acquireClipboardLock({ timeout = 300000, staleMs = 120000, onWait = null } = {}) {
  // 无头模式：剪贴板是进程内的，并发平台互不影响，无需加锁
  if (IS_HEADLESS) return true;
  const t0 = Date.now();
  let waited = false;
  while (Date.now() - t0 < timeout) {
    try {
      fs.mkdirSync(CLIPBOARD_LOCK_DIR);
      fs.writeFileSync(path.join(CLIPBOARD_LOCK_DIR, 'owner'), `${process.pid}@${new Date().toISOString()}`);
      if (waited) console.log('[common] 已获得剪贴板锁');
      return true;
    } catch (e) {
      // 持有者可能已崩溃：超时未释放则强制清理
      try {
        const st = fs.statSync(CLIPBOARD_LOCK_DIR);
        if (Date.now() - st.mtimeMs > staleMs) {
          console.log('[common] 清理过期的剪贴板锁');
          fs.rmSync(CLIPBOARD_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch (_) { /* 锁刚被释放，重试即可 */ }
      if (!waited) { waited = true; console.log('[common] 等待剪贴板锁（其它平台正在粘贴）...'); if (onWait) onWait(); }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('获取剪贴板锁超时（可能有进程未释放锁）');
}

function releaseClipboardLock() {
  if (IS_HEADLESS) return;
  try { fs.rmSync(CLIPBOARD_LOCK_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

async function withClipboardLock(fn, opts) {
  await acquireClipboardLock(opts);
  try { return await fn(); } finally { releaseClipboardLock(); }
}

// 从飞书 HTML 中删除「备选标题」块，统一在粘贴前完成，避免粘贴后再删误删正文/占位符
function removeAltBlockFromHtmlCore(html) {
  const altStart = html.indexOf('备选标题');
  if (altStart === -1) return html;
  const { blocks } = getTopLevelBlockSlices(html);

  // 首选：删除「备选标题」所在的整个顶层块。
  // 旧实现是「从备选标题删到下一个 <h1-6> 或『一、』」，当文档结构为
  // [备选标题块][开头段落][一、xxx 标题] 时会把开头段落一并删掉，故改为按块删除。
  const owner = blocks.find(b => b.start <= altStart && altStart < b.end);
  if (owner) {
    const ownerText = decodeBasicEntities(html.slice(owner.start, owner.end).replace(/<[^>]+>/g, '')).trim();
    if (ownerText.startsWith('备选标题')) {
      return html.slice(0, owner.start) + html.slice(owner.end);
    }
  }

  // 兜底：只删到「备选标题」之后的下一个顶层块起点，绝不越过块边界吞掉正文。
  const next = blocks.find(b => b.start > altStart);
  if (next) return html.slice(0, altStart) + html.slice(next.start);
  return html.slice(0, altStart);
}

// 现在文档正文第一行会重复文档主标题，生成中转文件时必须一并删除，避免发布后正文顶部出现标题重复。
function decodeBasicEntities(s) {
  return (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
}

function parseTopLevelBlocks(html) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const voidTags = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
  const blocks = [];
  let depth = 0;
  let blockStart = -1;
  let m;
  while ((m = tagRe.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const start = m.index;
    const end = m.index + m[0].length;
    if (closing) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && blockStart !== -1) {
        blocks.push({ start: blockStart, end });
        blockStart = -1;
      }
    } else if (voidTags.has(tag)) {
      if (depth === 0) blocks.push({ start, end });
    } else {
      if (depth === 0) blockStart = start;
      depth++;
    }
  }
  return blocks;
}

function getTopLevelBlockSlices(html) {
  // 优先处理飞书根容器（<div data-page-id=...> 或 data-lark-html-role="root"）
  const rootMatch = html.match(/<div\b[^>]*(?:data-page-id=|data-lark-html-role="root")[^>]*>/i);
  if (rootMatch) {
    const innerStart = rootMatch.index + rootMatch[0].length;
    const rootClose = html.lastIndexOf('</div>');
    if (rootClose > innerStart) {
      const inner = html.slice(innerStart, rootClose);
      const blocks = parseTopLevelBlocks(inner).map(b => ({
        start: b.start + innerStart,
        end: b.end + innerStart,
      }));
      return {
        prefix: html.slice(0, innerStart),
        suffix: html.slice(rootClose),
        blocks,
      };
    }
  }
  return { prefix: '', suffix: '', blocks: parseTopLevelBlocks(html) };
}

function removeMainTitleBlockFromHtml(html, mainTitle) {
  if (!html || !mainTitle) return html;
  const norm = s => decodeBasicEntities(s).replace(/\s+/g, '');
  const target = norm(mainTitle);
  if (!target) return html;
  const { blocks } = getTopLevelBlockSlices(html);
  for (const block of blocks) {
    const text = norm(html.slice(block.start, block.end).replace(/<[^>]+>/g, ''));
    if (text === target) {
      return html.slice(0, block.start) + html.slice(block.end);
    }
  }
  return html;
}

// 统一清理入口：先删除正文第一行重复的主标题，再删除「备选标题」块
function removeAltBlockFromHtml(html, mainTitle) {
  const withoutMain = mainTitle ? removeMainTitleBlockFromHtml(html, mainTitle) : html;
  return removeAltBlockFromHtmlCore(withoutMain);
}

function loadMainTitle(workdir) {
  if (!workdir) return '';
  try {
    const p = path.join(workdir, 'article.json');
    if (fs.existsSync(p)) {
      const article = JSON.parse(fs.readFileSync(p, 'utf8'));
      return article.main_title || '';
    }
  } catch (e) { /* 忽略 article.json 缺失/损坏 */ }
  return '';
}

// ---------- 飞书复制 ----------
// 打开飞书文档页，点入正文，Ctrl+A/Ctrl+C（返回前等待复制完成）
async function copyFromFeishu(context, docUrl) {
  const page = await context.newPage();
  await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  // 点入文档正文（优先点第一个章节标题，避免只选中「备选标题」块）
  const clicked = await page.getByText(/^[一二三四五六七八九十]、/).first()
    .click({ timeout: 5000 }).then(() => true).catch(() => false);
  if (!clicked) {
    await page.locator('text=备选标题').first().click({ timeout: 5000 }).catch(() => {});
    await page.locator('.bear-web-x-container').click({ position: { x: 400, y: 300 } }).catch(() => {});
  }
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(1500);
  await page.close();
  console.log('[common] 已从飞书文档复制');
}

// ---------- 页面操作辅助 ----------
// 拖拽选中（页面坐标）并删除
async function dragDelete(page, x1, y1, x2, y2) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(800);
}

// 等待条件成立（轮询 evaluate）
async function waitFor(fn, { timeout = 90000, interval = 2000, label = '' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch (e) { /* 页面跳转中等异常忽略 */ }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('等待超时: ' + (label || fn.toString().slice(0, 80)));
}

// 点击按钮（按文本精确/模糊匹配，多个时取第一个）
async function clickButton(page, text, { exact = true, all = false } = {}) {
  const loc = page.getByRole('button', { name: text, exact });
  if (all) await loc.first().click();
  else await loc.click();
}

function mainArgs() {
  // 解析 --key value 参数
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
      args[k] = v;
    }
  }
  return args;
}

module.exports = {
  loadPlaywright, launch, openPage,
  readClipboardHtml, setClipboard, transformFeishuClipboard, removeAltBlockFromHtml, removeMainTitleBlockFromHtml, loadMainTitle, setClipboardFromIntermediate,
  waitForImagesUploaded, acquireClipboardLock, releaseClipboardLock, withClipboardLock,
  parseTopLevelBlocks, getTopLevelBlockSlices,
  copyFromFeishu, dragDelete, waitFor, clickButton, mainArgs,
  WORKSPACE_ROOT, PUBLISH_WORKSPACE_DIR,
};
