// 搜狐号已发布文章：修复正文被误删的问题（重新粘贴完整正文并只删除备用标题块）
// 用法: node scripts/edit_sohu_fix_body.js --state "登录状态.json" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles" --docs 1,2,3,4,5 [--date YYYY-MM-DD] [--headed]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPlaywright, mainArgs, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, waitFor, PUBLISH_WORKSPACE_DIR} = require('../common/common.js');

const LIST_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page';

async function fixOne(context, docUrl, currentTitle, dateFilter, log, mainTitle) {
  const page = await context.newPage();
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  // 切到「已发布」标签，避免草稿排在前面导致找不到已发布文章
  const publishedTab = page.getByText('已发布', { exact: true }).first();
  if (await publishedTab.count()) {
    await publishedTab.click();
    await page.waitForTimeout(3000);
  }
  const cards = page.locator('div').filter({ hasText: currentTitle }).filter({ hasText: '编辑' });
  const cardCount = await cards.count();
  if (!cardCount) {
    log(`未找到「${currentTitle}」`);
    await page.close();
    return false;
  }
  let card = cards.last();
  if (dateFilter) {
    const mmdd = dateFilter.slice(5);
    let found = false;
    for (let i = 0; i < cardCount; i++) {
      const txt = await cards.nth(i).innerText().catch(() => '');
      if (txt.includes(dateFilter) || txt.includes(mmdd)) {
        card = cards.nth(i);
        found = true;
        break;
      }
    }
    if (!found) {
      log(`未找到「${currentTitle}」在 ${dateFilter} 发布的文章`);
      await page.close();
      return false;
    }
  }
  await card.getByText('编辑', { exact: true }).first().click();
  await page.waitForTimeout(6000);
  if (!page.url().includes('/addarticle')) {
    log(`「${currentTitle}」未进入编辑页: ${page.url()}`);
    await page.close();
    return false;
  }
  // 清空旧正文
  await page.locator('.ql-editor').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(800);
  // 重新粘贴完整正文（中转 HTML 删除备选标题）
  await copyFromFeishu(context, docUrl);
  const raw = await readClipboardHtml(page);
  const cleaned = removeAltBlockFromHtml(raw, mainTitle);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sohu-fix-clip-'));
  const htmlFile = path.join(tmpDir, 'clipboard.html');
  const txtFile = path.join(tmpDir, 'clipboard.txt');
  fs.writeFileSync(htmlFile, cleaned, 'utf8');
  fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
  await setClipboard(page, htmlFile, txtFile);
  await page.locator('.ql-editor').click();
  await page.keyboard.press('Control+V');
  await waitFor(async () => page.locator('.ql-editor').innerText().then(t => t.length > 2000),
    { label: '正文粘贴完成', timeout: 60000 });
  log(`「${currentTitle}」正文已修复，准备重新发布`);
  // 重新发布（修改已发布文章）
  await page.getByText('发布', { exact: true }).first().click();
  try {
    await waitFor(async () => page.url().includes('/contentManagement/first/page')
      || page.url().includes('/contentManagement/'), { timeout: 60000, label: '搜狐修改后跳转' });
  } catch (e) {
    log(`「${currentTitle}」点击发布后未跳转: ${e.message}`);
  }
  await page.waitForTimeout(3000);
  log(`已重新提交「${currentTitle}」`);
  await page.close();
  return true;
}

async function main() {
  const args = mainArgs();
  const state = args.state || path.join(PUBLISH_WORKSPACE_DIR, '平台登录状态-sohu.json');
  const workdir = args.workdir || PUBLISH_WORKSPACE_DIR;
  const docs = args.docs ? args.docs.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!docs.length) { console.error('请提供 --docs 1,2,3...'); process.exit(1); }
  const dateFilter = args.date || '';
  const mapping = JSON.parse(fs.readFileSync(path.join(workdir, '..', 'title_mapping.json'), 'utf8'));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  try {
    for (const id of docs) {
      const idx = String(id).padStart(2, '0');
      const articleFile = path.join(workdir, idx, 'article.json');
      if (!fs.existsSync(articleFile)) { console.log(`跳过 ${idx}: 缺少 article.json`); continue; }
      const article = JSON.parse(fs.readFileSync(articleFile, 'utf8'));
      const docUrl = `https://<your-tenant>.feishu.cn/docx/${article.doc_token}`;
      const currentTitle = mapping[idx]?.sohu || article.main_title;
      console.log(`===== SOHU EDIT ${idx} =====`);
      await fixOne(context, docUrl, currentTitle, dateFilter, msg => console.log(`[${idx}] ${msg}`), article.main_title);
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
