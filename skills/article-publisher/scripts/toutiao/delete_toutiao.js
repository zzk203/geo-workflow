// 今日头条删除作品脚本
// 用法: node delete_toutiao.js --state "登录状态.json" --title "标题"
const { chromium } = require('/home/zzk/geo/.agents/skills/article-publisher/node_modules/playwright');
const { mainArgs } = require('../common/common.js');

(async () => {
  const args = mainArgs();
  if (!args.state || !args.title) {
    console.error('缺少参数: --state / --title 必填');
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const ctx = await browser.newContext({ storageState: args.state, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto('https://mp.toutiao.com/profile_v4/graphic/articles', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);
    const title = args.title;
    const titleEl = page.locator('text=' + title).first();
    if (!(await titleEl.count())) { console.log('未找到:', title); await browser.close(); return; }
    const row = titleEl.locator('xpath=ancestor::div[contains(@class,"article")][1]');
    const more = row.locator('text=更多').first();
    await more.click();
    await page.waitForTimeout(1500);
    const deleteItem = page.locator('text=删除作品').last();
    if (!(await deleteItem.isVisible().catch(() => false))) {
      console.log('未找到删除作品菜单:', title);
      await page.keyboard.press('Escape');
      await browser.close();
      return;
    }
    await deleteItem.click();
    await page.waitForTimeout(2000);
    // 确认弹窗
    const confirmBtn = page.locator('button:has-text("确定"), .byte-btn:has-text("确定"), [class*=confirm]:has-text("确定")').first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(2000);
      console.log('已删除:', title);
    } else {
      const okBtn = page.locator('button:has-text("删除"), .byte-btn:has-text("删除")').first();
      if (await okBtn.isVisible().catch(() => false)) {
        await okBtn.click();
        await page.waitForTimeout(2000);
        console.log('已删除:', title);
      } else {
        console.log('未找到确认按钮:', title);
        await page.keyboard.press('Escape');
      }
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
