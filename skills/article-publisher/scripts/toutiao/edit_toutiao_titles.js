// 今日头条标题修改脚本
// 用法: node scripts/edit_toutiao_titles.js --state "<登录状态.json>" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles" [--docs "1,2,3"] [--title-index 3] [--date YYYY-MM-DD] [--headed]
// 说明: 懂车号发布会自动同步到今日头条；本脚本等待同步文章处于已发布后，
//       按原标题（主标题）+ 日期找到对应文章，打开修改页，把标题改成备用标题（默认第4个，即 alt_titles[3]）。
const fs = require('fs');
const path = require('path');
const { loadPlaywright, mainArgs, waitFor, PUBLISH_WORKSPACE_DIR} = require('../common/common.js');

const CONTENT_URL = 'https://mp.toutiao.com/profile_v4/manage/content/all';

async function editOne(context, mainTitle, newTitle, dateFilter, log) {
  const page = await context.newPage();
  const newPagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // 用搜索框锁定标题，避免文章在后续分页中找不到
  const searchInput = page.locator('input[placeholder="搜索关键词"]').first();
  if (await searchInput.count()) {
    await searchInput.click();
    await searchInput.fill(mainTitle);
    await page.waitForTimeout(500);
    await page.locator('.search-icon-wrap').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await searchInput.press('Enter');
    await page.waitForTimeout(5000);
  }
  const cards = page.locator('.article-card-bone').filter({ hasText: mainTitle });
  const cardCount = await cards.count();
  if (!cardCount) {
    const firstCardText = await page.locator('.article-card-bone').first().innerText().catch(() => '');
    log(`未找到「${mainTitle}」，可能已修改或尚未同步；当前首条: ${firstCardText.slice(0, 80)}`);
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
  const mod = card.getByText('修改', { exact: true }).first();
  if (!(await mod.count())) {
    log(`「${mainTitle}」没有修改入口`);
    await page.close();
    return false;
  }
  await mod.click({ force: true });
  const editPage = await newPagePromise;
  if (!editPage) {
    log(`「${mainTitle}」修改页未打开`);
    await page.close();
    return false;
  }
  await editPage.waitForTimeout(5000);
  const titleInput = editPage.locator('textarea[placeholder="请输入文章标题（2～30个字）"]').first();
  if (!(await titleInput.count())) {
    log(`「${mainTitle}」编辑页未找到标题输入框`);
    await editPage.close();
    await page.close();
    return false;
  }
  await titleInput.fill(newTitle);
  await editPage.waitForTimeout(500);
  const publishBtn = editPage.getByRole('button', { name: '发布' }).first();
  if (!(await publishBtn.count())) {
    log(`「${mainTitle}」编辑页未找到发布按钮`);
    await editPage.close();
    await page.close();
    return false;
  }
  await publishBtn.click();
  // 等待回到文章列表页
  try {
    await waitFor(async () => editPage.url().includes('/graphic/articles') || editPage.url().includes('/manage/content/all'), {
      timeout: 30000, label: '今日头条修改保存跳转'
    });
  } catch (e) {
    log(`「${mainTitle}」点击发布后未跳转: ${e.message}`);
  }
  await editPage.waitForTimeout(2000);
  log(`已修改「${mainTitle}」 -> 「${newTitle}」`);
  await editPage.close();
  await page.close();
  return true;
}

async function main() {
  const args = mainArgs();
  const state = args.state || path.join(PUBLISH_WORKSPACE_DIR, '平台登录状态.json');
  const workdir = args.workdir || PUBLISH_WORKSPACE_DIR;
  const titleIndex = args['title-index'] ? parseInt(args['title-index'], 10) : 3;
  const docs = args.docs ? args.docs.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean) : Array.from({length: 15}, (_, i) => i + 1);
  const dateFilter = args.date || '';
  const mappingFile = args.mapping ? path.resolve(args.mapping) : null;
  const mapping = mappingFile && fs.existsSync(mappingFile) ? JSON.parse(fs.readFileSync(mappingFile, 'utf8')) : null;

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  try {
    for (const i of docs) {
      const idx = String(i).padStart(2, '0');
      const articleFile = path.join(workdir, idx, 'article.json');
      if (!fs.existsSync(articleFile)) {
        console.log(`跳过 ${idx}: 缺少 article.json`);
        continue;
      }
      const article = JSON.parse(fs.readFileSync(articleFile, 'utf8'));
      const mainTitle = article.main_title;
      const newTitle = mapping && mapping[idx]?.toutiao ? mapping[idx].toutiao : article.alt_titles[titleIndex];
      if (!mainTitle || !newTitle) {
        console.log(`跳过 ${idx}: 缺少主标题或备用标题${titleIndex + 1}`);
        continue;
      }
      console.log(`===== TOUTIAO doc ${idx} =====`);
      await editOne(context, mainTitle, newTitle, dateFilter, msg => console.log(`[${idx}] ${msg}`));
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
