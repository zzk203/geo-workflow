// 易车删除指定文章
// 用法: node scripts/delete_yiche_articles.js --state "登录状态.json" --titles "标题1|标题2|..."
const { loadPlaywright, mainArgs } = require('../common/common.js');

const LIST_URL = 'https://mp.yiche.com/detailManage';

async function main() {
  const args = mainArgs();
  const state = args.state || '/home/zzk/geo/发布工作区/平台登录状态.json';
  const titles = (args.titles || '').split('|').map(s => s.trim()).filter(Boolean);
  if (!titles.length) { console.error('请提供 --titles "标题1|标题2"'); process.exit(1); }
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  try {
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    for (const title of titles) {
      console.log('===== DELETE YICHE =====', title);
      const card = page.locator('li.cf').filter({ hasText: title }).first();
      if (!(await card.count())) {
        console.log('未找到:', title);
        continue;
      }
      await card.getByText('删除', { exact: true }).first().click();
      await page.waitForTimeout(1500);
      // 确认弹窗
      const confirm = page.getByRole('button', { name: '确定', exact: true }).first();
      if (await confirm.count()) {
        await confirm.click();
      } else {
        // 可能按钮叫「确认」
        const ok = page.getByRole('button', { name: '确认', exact: true }).first();
        if (await ok.count()) await ok.click();
      }
      await page.waitForTimeout(3000);
      const text = await page.evaluate(() => document.body.innerText);
      console.log('删除后仍在?', text.includes(title));
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
