// 懂车号已发布文章：删除正文开头的备用标题列表（重新发布进入审核）
// 用法: node scripts/edit_dongchedi_remove_alt.js --state "登录状态.json" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles" --docs 1,2,3 [--date YYYY-MM-DD] [--headed]
const fs = require('fs');
const path = require('path');
const { loadPlaywright, mainArgs, waitFor, PUBLISH_WORKSPACE_DIR} = require('../common/common.js');

const MANAGE_URL = 'https://mp.dcdapp.com/profile_v2/manage/content/article';

async function editOne(context, mainTitle, altTitle0, dateFilter, log) {
  const page = await context.newPage();
  await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const cards = page.locator('.content-card__CardWrapper-dwjOlj').filter({ hasText: mainTitle });
  const cardCount = await cards.count();
  if (!cardCount) {
    log(`未找到「${mainTitle}」`);
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
      log(`未找到「${mainTitle}」在 ${dateFilter} 发布的文章`);
      await page.close();
      return false;
    }
  }
  await card.getByText('更多', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.getByText('修改', { exact: true }).first().click();
  await page.waitForTimeout(6000);
  if (!page.url().includes('/publish/article')) {
    log(`「${mainTitle}」未进入编辑页: ${page.url()}`);
    await page.close();
    return false;
  }
  // 删除备用标题列表（第一个空P + OL）
  await page.locator('.ProseMirror').evaluate((el) => {
    const children = [...el.children];
    const first = children[0];
    const ol = children.find(c => c.tagName === 'OL');
    const last = ol || children[Math.min(6, children.length - 1)];
    if (first && last) {
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  // 删除可能残留的空首段
  await page.locator('.ProseMirror').evaluate((el) => {
    const p = el.querySelector('p');
    if (p && !(p.innerText || '').trim()) {
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  await page.waitForTimeout(200);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  const text = await page.locator('.ProseMirror').innerText();
  if (text.includes('备选标题') || (altTitle0 && text.includes(altTitle0))) {
    log(`「${mainTitle}」备选标题删除不彻底`);
    await page.close();
    return false;
  }
  log(`「${mainTitle}」备选标题已删除，准备重新发布`);
  // 重新发布
  const publishBtn = page.getByRole('button', { name: '发布', exact: true }).first();
  await publishBtn.click();
  try {
    await waitFor(async () => page.url().includes('/manage/content/article'), {
      timeout: 60000, label: '懂车号修改后跳转'
    });
  } catch (e) {
    log(`「${mainTitle}」点击发布后未跳转: ${e.message}`);
  }
  await page.waitForTimeout(3000);
  log(`已重新提交「${mainTitle}」`);
  await page.close();
  return true;
}

async function main() {
  const args = mainArgs();
  const state = args.state || path.join(PUBLISH_WORKSPACE_DIR, '平台登录状态-dongchedi.json');
  const workdir = args.workdir || PUBLISH_WORKSPACE_DIR;
  const docs = args.docs ? args.docs.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!docs.length) {
    console.error('请提供 --docs 1,2,3...');
    process.exit(1);
  }
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
      const alt0 = article.alt_titles[0] || '';
      console.log(`===== DONGCHEDI EDIT ${idx} =====`);
      await editOne(context, article.main_title, alt0, dateFilter, msg => console.log(`[${idx}] ${msg}`));
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
