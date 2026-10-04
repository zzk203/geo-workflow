// 生成发布用中转文件
// 用法:
//   node scripts/generate_intermediate.js --doc-url "飞书文档URL" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" [--state "平台登录状态.json"] [--headed]
// 说明:
//   打开飞书文档一次，复制完整正文 HTML，删除「主标题（若正文第一行重复）」「备选标题」块后写入：
//     - 正文_clean.html
//     - 正文_clean.txt
//   后续各平台发布脚本直接读取这两个文件，不再逐平台打开飞书。
const fs = require('fs');
const path = require('path');
const {
  loadPlaywright, openPage, readClipboardHtml, removeAltBlockFromHtml, loadMainTitle, mainArgs,
  PUBLISH_WORKSPACE_DIR,
} = require('./common.js');

// 飞书富文本中 Q&A 等段落会用 white-space:pre 保留换行，但粘贴到部分平台后换行会丢失。
// 这里把这类可见块内的换行转成 <br>，确保 Q 和 A 在不同平台都分行显示。
function fixQaNewlines(html) {
  return html.replace(
    /(<div[^>]*white-space:\s*pre[^>]*>)([\s\S]*?)(<\/div>)/gi,
    (m, open, inner, close) => open + inner.replace(/\n/g, '<br>') + close
  );
}

(async () => {
  const args = mainArgs();
  if (!args['doc-url'] || !args.workdir) {
    console.error('缺少参数: --doc-url / --workdir 必填');
    process.exit(1);
  }
  const state = args.state || path.join(PUBLISH_WORKSPACE_DIR, '平台登录状态.json');
  const workdir = args.workdir;
  fs.mkdirSync(workdir, { recursive: true });

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const { context, page } = await openPage(browser, state);
    // 打开飞书文档并复制全文
    await page.goto(args['doc-url'], { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 飞书编辑器加载较慢：先等待页面稳定，再点进正文容器，避免复制到空/纯文本
    await page.waitForTimeout(10000);
    await page.locator('.page-block.root-block').first()
      .click({ position: { x: 400, y: 600 }, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    const clicked = await page.getByText(/^[一二三四五六七八九十]、/).first()
      .click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await page.locator('text=备选标题').first().click({ timeout: 5000 }).catch(() => {});
      await page.locator('.bear-web-x-container').click({ position: { x: 400, y: 300 } }).catch(() => {});
    }
    await page.waitForTimeout(800);
    // 先清空剪贴板，避免 Feishu 在已有剪贴板内容时只写入纯文本
    await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(2000);
    const raw = await readClipboardHtml(page);
    if (!raw) {
      console.error('未读取到飞书剪贴板 HTML，请检查登录态或文档权限');
      process.exit(1);
    }
    const mainTitle = loadMainTitle(workdir);
    const cleaned = fixQaNewlines(removeAltBlockFromHtml(raw, mainTitle));
    const htmlFile = path.join(workdir, '正文_clean.html');
    const txtFile = path.join(workdir, '正文_clean.txt');
    fs.writeFileSync(htmlFile, cleaned, 'utf8');
    fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
    console.log(`已生成中转文件:`);
    console.log(`  ${htmlFile}`);
    console.log(`  ${txtFile}`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
