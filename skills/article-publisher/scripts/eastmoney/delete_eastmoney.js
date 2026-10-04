// 东方财富删除已发布长文脚本
// 用法: node delete_eastmoney.js --state "登录状态-eastmoney.json" --title "标题1" --title "标题2" ...
const { chromium } = require('/home/zzk/geo/.agents/skills/article-publisher/node_modules/playwright');
const path = require('path');
const { mainArgs } = require('../common/common.js');

(async () => {
  const args = mainArgs();
  if (!args.state || !args.title) {
    console.error('缺少参数: --state / --title 必填（可多个 --title）');
    process.exit(1);
  }
  const titles = Array.isArray(args.title) ? args.title : [args.title];
  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const ctx = await browser.newContext({ storageState: args.state, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto('https://mp.eastmoney.com/#/content', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    const viewAll = page.getByText('查看所有发文', { exact: true }).first();
    if (await viewAll.count()) { await viewAll.click(); await page.waitForTimeout(4000); }

    const pending = [...titles];
    for (let pageNo = 1; pageNo <= 10 && pending.length; pageNo++) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      for (let i = pending.length - 1; i >= 0; i--) {
        const title = pending[i];
        if (!bodyText.includes(title)) continue;
        const card = page.locator('article.card_info', { hasText: title }).first();
        if (!(await card.count())) continue;
        const moreBtn = card.locator('.func_btn.morebtn').last();
        if (!(await moreBtn.count())) continue;
        await moreBtn.click();
        await page.waitForTimeout(1000);
        const delItem = card.locator('li.more_delete.more').first();
        if (!(await delItem.isVisible().catch(() => false))) { await page.keyboard.press('Escape'); continue; }
        await delItem.click();
        await page.waitForTimeout(1500);
        const confirmBtn = page.locator('.dialog_content .dialog_btn_confirm').filter({ hasText: '确认' }).first();
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click();
          await page.waitForTimeout(2000);
          console.log('已删除:', title);
          pending.splice(i, 1);
        } else {
          console.log('未找到确认按钮，取消删除:', title);
          const cancel = page.locator('.dialog_content .dialog_btn_cancel').first();
          if (await cancel.isVisible().catch(() => false)) await cancel.click();
        }
        await page.waitForTimeout(1000);
      }
      if (!pending.length) break;
      // 下一页
      const nextBtn = page.locator('.pagination .btn-next, .el-pagination .btn-next, [class*=next]').first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(3000);
      } else {
        break;
      }
    }
    if (pending.length) console.log('未找到并删除:', pending.join(', '));
    else console.log('全部删除完成');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
