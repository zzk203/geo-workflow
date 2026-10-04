// 搜狐号发布脚本
// 用法: node publish_sohu.js --title "标题" --doc-url "飞书文档URL" --state "登录状态.json" --image 图片路径 [--workdir 工作目录] [--draft] [--headed]
// 流程: 打开内容管理 → 点「发布内容」→ 填标题 → 飞书复制粘贴 → 删备选标题块 → 上传封面 → 选AI声明 → 发布/存草稿
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, waitFor, mainArgs,
  PUBLISH_WORKSPACE_DIR,
} = require('../common/common.js');

const LIST_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page';
const WORKDIR_DEFAULT = PUBLISH_WORKSPACE_DIR;

function plainTextWithoutImagePlaceholders(workdir) {
  const articlePath = path.join(workdir, 'article.json');
  if (!fs.existsSync(articlePath)) return null;
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const out = path.join(workdir, '正文_clean_noimg.txt');
  const parts = [];
  for (const b of article.body_blocks || []) {
    if (b.type === 'image') continue;
    if (b.type === 'table') {
      for (const row of (b.rows || [])) parts.push(row.join(' | '));
      continue;
    }
    const text = (b.text || '').trim();
    if (!text) continue;
    if (b.type === 'bullet') parts.push('• ' + text);
    else parts.push(text);
  }
  fs.writeFileSync(out, parts.join('\n'), 'utf8');
  return out;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 搜狐号编辑器（Quill）没有可靠的本地正文插图脚本，这里在富文本 HTML 中直接带远程图片 URL，
// 确保正文图片能随富文本一起进入编辑器；发布时平台是否转存由搜狐端处理。
function buildRichHtmlWithRemoteImages(workdir) {
  const article = JSON.parse(fs.readFileSync(path.join(workdir, 'article.json'), 'utf8'));
  const parts = [];
  for (const b of article.body_blocks || []) {
    if (b.type === 'image') {
      const url = b.url || '';
      if (url) parts.push(`<p><img src="${escapeHtml(url)}"></p>`);
    } else if (b.type === 'table') {
      const rows = b.rows || [];
      if (rows.length) {
        let html = '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%">';
        for (const row of rows) {
          html += '<tr>' + row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('') + '</tr>';
        }
        html += '</table>';
        parts.push(html);
      }
    } else if (b.type === 'heading') {
      parts.push(`<h2>${escapeHtml(b.text || '')}</h2>`);
    } else if (b.type === 'bullet') {
      parts.push(`<ul><li>${escapeHtml(b.text || '')}</li></ul>`);
    } else {
      const text = (b.text || '').trim();
      if (text) parts.push(`<p>${escapeHtml(text)}</p>`);
    }
  }
  return parts.join('\n');
}

async function closeSohuModal(page) {
  for (let i = 0; i < 5; i++) {
    const btn = page.locator('.win-mask button.sure-btn, .alert-dialog button.sure-btn, button.sure-btn').first();
    if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) {
      try {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(1000);
      } catch (e) { break; }
    } else {
      break;
    }
  }
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
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    if (page.url().includes('/login')) {
      console.error('未登录搜狐号，请先手动登录并 state-save 后再运行');
      process.exit(1);
    }

    // 0. 进入发布页（必须从内容管理页点击「发布内容」，直接 goto addarticle 会被重定向回列表）
    await page.getByRole('button', { name: '发布内容', exact: true }).first().click();
    await page.waitForTimeout(5000);
    if (!page.url().includes('/addarticle')) {
      console.error('未能进入搜狐发布页:', page.url());
      process.exit(1);
    }

    // 1. 标题
    await page.locator('input[placeholder="请输入标题（5-72字）"]').fill(args.title);
    console.log('[搜狐] 标题已填:', args.title);

    // 2. 正文：使用本地中转 HTML（富文本），不插入正文图片（用户确认搜狐正文图片不可见）
    if (args.workdir && await setClipboardFromIntermediate(page, args.workdir)) {
      console.log('[搜狐] 使用本地中转 HTML 富文本');
    } else {
      await copyFromFeishu(context, args['doc-url']);
      const raw = await readClipboardHtml(page);
      const cleaned = removeAltBlockFromHtml(raw, loadMainTitle(workDir));
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sohu-clip-'));
      const htmlFile = path.join(tmpDir, 'clipboard.html');
      const txtFile = path.join(tmpDir, 'clipboard.txt');
      fs.writeFileSync(htmlFile, cleaned, 'utf8');
      fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
      await setClipboard(page, htmlFile, txtFile);
    }
    await page.waitForTimeout(2000);
    await page.locator('.ql-editor').click({ position: { x: 200, y: 200 } });
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+V');
    await waitFor(async () => (await page.locator('.ql-editor').innerText()).length > 2000,
      { timeout: 180000, label: '正文粘贴完成' });
    console.log('[搜狐] 正文已粘贴（富文本，不含正文图片）');

    // 4. 封面：打开上传弹窗 → 本地上传 → 选择文章图片 → 确定
    await page.getByText('上传图片', { exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.getByText('本地上传', { exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.locator('#new-file').setInputFiles(args.image);
    // 等待本地上传完成（正文图片可能仍在后台上传，需等封面“确定”按钮真正可见）
    await waitFor(async () => {
      const btn = page.locator('.select-dialog .button.positive-button', { hasText: '确定' }).first();
      return await btn.isVisible().catch(() => false);
    }, { timeout: 120000, label: '搜狐封面上传确定按钮可见' });
    await page.waitForTimeout(500);
    const confirm = page.locator('.select-dialog .button.positive-button', { hasText: '确定' }).first();
    await confirm.click();
    await page.waitForTimeout(3000);
    console.log('[搜狐] 封面已上传');

    // 5. 创作声明：必选声明 → 含AI生成内容
    await page.getByText('含有AI生成内容', { exact: true }).first().click();
    await page.waitForTimeout(500);
    console.log('[搜狐] 创作声明已选');

    // 6. 发布 / 存草稿
    await closeSohuModal(page);
    if (args.draft) {
      await page.getByText('存草稿', { exact: true }).first().click();
      console.log('[搜狐] 已点击存草稿');
    } else {
      await page.getByText('发布', { exact: true }).first().click();
      console.log('[搜狐] 已点击发布');
      // 发布后可能出现确认弹窗，自动点“确定”
      await page.waitForTimeout(1000);
      await closeSohuModal(page);
    }

    // 7. 等待返回内容管理列表
    await waitFor(async () => {
      return page.url().includes('/contentManagement/first/page')
        || page.url().includes('/contentManagement/');
    }, { timeout: 60000, label: '发布/存草稿后跳转' });

    // 8. 验证：列表中出现刚提交的标题（草稿/审核中/已发布）
    await waitFor(async () => {
      const first = await page.locator('.article-content, [class*=article-content], .content-list').first().innerText().catch(() => '');
      return first.includes(args.title);
    }, { timeout: 30000, label: '列表出现新文章' });
    console.log(`OK: 搜狐${args.draft ? '存草稿' : '发布'}成功:`, args.title);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
