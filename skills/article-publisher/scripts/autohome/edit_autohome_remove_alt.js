// 汽车之家已发布文章：删除正文开头的备用标题列表（重新发布进入审核）
// 用法: node scripts/edit_autohome_remove_alt.js --state "登录状态.json" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles" --docs 1,5,9 [--date YYYY-MM-DD] [--headed]
const fs = require('fs');
const path = require('path');
const { loadPlaywright, mainArgs, waitFor, PUBLISH_WORKSPACE_DIR} = require('../common/common.js');

const CONTENT_URL = 'https://creator.autohome.com.cn/web/content';

async function editOne(context, currentTitle, altTitles, dateFilter, log) {
  const page = await context.newPage();
  await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const cards = page.locator('li.ant-list-item').filter({ hasText: currentTitle });
  const cardCount = await cards.count();
  if (!cardCount) {
    log(`未找到「${currentTitle}」`);
    await page.close();
    return false;
  }
  let card = cards.first();
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
  if (!page.url().includes('/web/publish/bbs')) {
    log(`「${currentTitle}」未进入编辑页: ${page.url()}`);
    await page.close();
    return false;
  }
  // 删除第一段备用标题列表（原始粘贴时所有备用标题合并为第一段）
  await page.locator('.editor-input').evaluate((el) => {
    const p = el.querySelector('p');
    if (p) {
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(800);
  const text = await page.locator('.editor-input').innerText();
  const stillHasAlt = altTitles.some(t => t && text.includes(t.slice(0, 12)));
  if (stillHasAlt) {
    log(`「${currentTitle}」备选标题删除不彻底`);
    await page.close();
    return false;
  }
  log(`「${currentTitle}」备选标题已删除，准备重新发布`);
  // 重新发布
  const publishBtn = page.getByRole('button', { name: '发布', exact: true }).first();
  await publishBtn.click();
  try {
    await waitFor(async () => {
      const t = await page.evaluate(() => document.body.innerText);
      return page.url().includes('club.autohome.com.cn/bbs/thread') || t.includes('发布成功');
    }, { timeout: 60000, label: '汽车之家修改后发布' });
  } catch (e) {
    log(`「${currentTitle}」点击发布后未确认成功: ${e.message}`);
  }
  await page.waitForTimeout(3000);
  log(`已重新提交「${currentTitle}」`);
  await page.close();
  return true;
}

async function main() {
  const args = mainArgs();
  const state = args.state || path.join(PUBLISH_WORKSPACE_DIR, '平台登录状态.json');
  const workdir = args.workdir || PUBLISH_WORKSPACE_DIR;
  const docs = args.docs ? args.docs.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!docs.length) { console.error('请提供 --docs 1,5,9...'); process.exit(1); }
  const dateFilter = args.date || '';
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  try {
    for (const id of docs) {
      const idx = String(id).padStart(2, '0');
      const articleFile = path.join(workdir, idx, 'article.json');
      if (!fs.existsSync(articleFile)) { console.log(`跳过 ${idx}: 缺少 article.json`); continue; }
      const article = JSON.parse(fs.readFileSync(articleFile, 'utf8'));
      // 已发布文章当前标题 = 汽车之家映射标题（01/05/09 为 alt2）
      const mapping = JSON.parse(fs.readFileSync(path.join(workdir, '..', 'title_mapping.json'), 'utf8'));
      const currentTitle = mapping[idx]?.autohome || article.alt_titles[1];
      console.log(`===== AUTOHOME EDIT ${idx} =====`);
      await editOne(context, currentTitle, article.alt_titles, dateFilter, msg => console.log(`[${idx}] ${msg}`));
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
