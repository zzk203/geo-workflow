// 百家号删除已发布文章脚本（先撤回，再从已撤回中删除）
// 用法: node delete_baijiahao.js --state "登录状态.json" --title "标题"
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
    const title = args.title;

    // 第一步：在已发布列表撤回
    await page.goto('https://baijiahao.baidu.com/builder/rc/content?type=news', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);
    let item = page.locator('.client_pages_content_v2_components_articleItem', { hasText: title }).first();
    if (await item.count()) {
      let more = item.locator('.client_pages_content_v2_components_data2action_actions_withDropDown', { hasText: '更多' }).first();
      await more.click();
      await page.waitForTimeout(1200);
      const withdraw = page.locator('text=撤回').last();
      if (await withdraw.isVisible().catch(() => false)) {
        await withdraw.click();
        await page.waitForTimeout(1500);
        const confirmBtn = page.locator('.cheetah-modal-confirm-btns button:has-text("确定"), .cheetah-modal button:has-text("确定")').first();
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click();
          await page.waitForTimeout(3000);
          console.log('已撤回:', title);
        } else {
          console.log('未找到撤回确认按钮:', title);
        }
      } else {
        console.log('未找到撤回菜单（可能已撤回）:', title);
      }
    } else {
      console.log('已发布列表未找到:', title);
    }

    // 第二步：切换到“已撤回”并删除
    await page.getByText('已撤回', { exact: true }).first().click();
    await page.waitForTimeout(3000);
    item = page.locator('.client_pages_content_v2_components_articleItem', { hasText: title }).first();
    if (!(await item.count())) {
      console.log('已撤回列表未找到:', title);
      await browser.close();
      return;
    }
    let more = item.locator('.client_pages_content_v2_components_data2action_actions_withDropDown', { hasText: '更多' }).first();
    await more.click();
    await page.waitForTimeout(1200);
    const del = page.locator('text=删除').last();
    if (await del.isVisible().catch(() => false)) {
      await del.click();
      await page.waitForTimeout(1500);
      const confirmBtn = page.locator('.cheetah-modal-confirm-btns button:has-text("确定"), .cheetah-modal button:has-text("确定")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
        console.log('已删除:', title);
      } else {
        console.log('未找到删除确认按钮:', title);
      }
    } else {
      console.log('未找到删除菜单:', title);
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
