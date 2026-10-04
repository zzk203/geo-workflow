// Linux 登录状态保存助手
// 用法: node scripts/login.js --url <平台入口URL> --state <登录状态文件.json>
// 打开 headed 浏览器，用户在窗口内完成登录后，脚本自动检测并保存 storageState。
const fs = require('fs');
const { loadPlaywright, mainArgs } = require('./common.js');

const LOGIN_MARKERS = [
  '/login', '/passport', '/sso', 'account.autohome.com.cn',
  '/theme/bjh/login', 'authenservice/login', '/login.html', '/userAuth',
];

async function main() {
  const args = mainArgs();
  if (!args.url || !args.state) {
    console.error('缺少参数: --url / --state 必填');
    process.exit(1);
  }
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: false });
  try {
    const contextOptions = {
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    };
    if (fs.existsSync(args.state)) {
      contextOptions.storageState = args.state;
      console.log('[login] 已加载已有登录状态:', args.state);
    }
    const context = await browser.newContext(contextOptions);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const page = await context.newPage();
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 等待可能的登录跳转稳定后再判断
    await page.waitForTimeout(4000);
    console.log('[login] 请在打开的浏览器窗口中登录:', args.url);

    const isLoginPage = () => LOGIN_MARKERS.some(m => page.url().includes(m));
    const t0 = Date.now();
    const TIMEOUT = 10 * 60 * 1000; // 10 分钟
    while (Date.now() - t0 < TIMEOUT) {
      if (!isLoginPage()) break;
      await page.waitForTimeout(2000);
    }
    if (isLoginPage()) {
      console.error('[login] 等待登录超时，未检测到登录成功');
      process.exit(1);
    }
    // 等页面稳定后再保存
    await page.waitForTimeout(3000);
    await context.storageState({ path: args.state });
    console.log('[login] 登录状态已保存到', args.state);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[login] 失败:', e.message); process.exit(1); });
