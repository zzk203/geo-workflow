// 搜狐号定时发布脚本
// 用法:
//   node publish_sohu_schedule.js --title "标题" --doc-url "飞书URL" --state "登录状态-sohu.json" --image 图片 [--workdir 工作目录] [--date 8月25日] [--hour 0] [--minute 0]
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, waitFor, mainArgs,
  PUBLISH_WORKSPACE_DIR,
} = require('../common/common.js');

const LIST_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page';
const WORKDIR_DEFAULT = PUBLISH_WORKSPACE_DIR;

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state || !args.image) {
    console.error('缺少参数: --title / --doc-url / --state / --image 必填');
    process.exit(1);
  }
  const workDir = args.workdir || WORKDIR_DEFAULT;
  const dateLabel = args.date || '8月25日';
  const hour = args.hour || '0';
  const minute = args.minute || '0';

  const browser = await launch({ headless: !args.headed });
  try {
    const { context, page } = await openPage(browser, args.state);
    page.__articleImage = args.image;
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (page.url().includes('/login')) {
      console.error('未登录搜狐号');
      process.exit(1);
    }

    // 进入发布页
    await page.getByRole('button', { name: '发布内容', exact: true }).first().click();
    await page.waitForTimeout(5000);
    if (!page.url().includes('/addarticle')) {
      console.error('未能进入搜狐发布页:', page.url());
      process.exit(1);
    }

    // 标题
    await page.locator('input[placeholder="请输入标题（5-72字）"]').fill(args.title);
    console.log('[搜狐定时] 标题已填:', args.title);

    // 正文：优先使用本地中转文件，否则飞书复制 → 中转 HTML 删除备选标题 → 粘贴
    if (workDir && await setClipboardFromIntermediate(page, workDir)) {
      console.log('[搜狐定时] 使用本地中转文件');
    } else {
      await copyFromFeishu(context, args['doc-url']);
      const raw = await readClipboardHtml(page);
      const cleaned = removeAltBlockFromHtml(raw, loadMainTitle(workDir));
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sohu-sched-clip-'));
      const htmlFile = path.join(tmpDir, 'clipboard.html');
      const txtFile = path.join(tmpDir, 'clipboard.txt');
      fs.writeFileSync(htmlFile, cleaned, 'utf8');
      fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
      await setClipboard(page, htmlFile, txtFile);
    }
    await page.locator('.ql-editor').click();
    await page.keyboard.press('Control+V');
    await waitFor(async () => page.locator('.ql-editor').innerText().then(t => t.length > 2000),
      { timeout: 180000, label: '正文粘贴完成' });
    console.log('[搜狐定时] 正文已粘贴');

    // 封面
    await page.getByText('上传图片', { exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.getByText('本地上传', { exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.locator('#new-file').setInputFiles(args.image);
    await waitFor(async () => {
      const btn = page.locator('.select-dialog .button.positive-button', { hasText: '确定' }).first();
      return await btn.isVisible().catch(() => false);
    }, { timeout: 120000, label: '搜狐定时封面上传确定按钮可见' });
    await page.waitForTimeout(500);
    const confirm = page.locator('.select-dialog .button.positive-button', { hasText: '确定' }).first();
    await confirm.click();
    await page.waitForTimeout(3000);
    console.log('[搜狐定时] 封面已上传');

    // 创作声明
    await page.getByText('含有AI生成内容', { exact: true }).first().click();
    await page.waitForTimeout(500);
    console.log('[搜狐定时] 创作声明已选');

    // 定时发布
    await page.getByText('定时发布', { exact: true }).first().click();
    await waitFor(async () => (await page.locator('.pushtimeout-dialog').count()) > 0,
      { label: '定时发布弹窗出现' });
    console.log('[搜狐定时] 定时弹窗已出现');

    // 选择日期
    const dialog = page.locator('.pushtimeout-dialog');
    const dateSelect = dialog.locator('.select').nth(0);
    await dateSelect.click();
    await page.waitForTimeout(500);
    const dateOpt = dialog.locator('.select').nth(0).locator('li', { hasText: dateLabel }).first();
    if (!(await dateOpt.count())) {
      console.error('未找到日期选项:', dateLabel);
      process.exit(1);
    }
    await dateOpt.click();
    await page.waitForTimeout(500);

    // 选择小时
    const hourSelect = dialog.locator('.select').nth(1);
    await hourSelect.click();
    await page.waitForTimeout(500);
    const hourOpt = dialog.locator('.select').nth(1).locator('li', { hasText: hour }).first();
    if (!(await hourOpt.count())) {
      console.error('未找到小时选项:', hour);
      process.exit(1);
    }
    await hourOpt.click();
    await page.waitForTimeout(500);

    // 选择分钟
    const minSelect = dialog.locator('.select').nth(2);
    await minSelect.click();
    await page.waitForTimeout(500);
    const minOpt = dialog.locator('.select').nth(2).locator('li', { hasText: minute }).first();
    if (!(await minOpt.count())) {
      console.error('未找到分钟选项:', minute);
      process.exit(1);
    }
    await minOpt.click();
    await page.waitForTimeout(500);

    // 点击弹窗中的发布
    await dialog.getByText('发布', { exact: true }).first().click();
    await waitFor(async () => {
      return (await page.locator('.pushtimeout-dialog').count()) === 0
        || page.url().includes('/contentManagement/');
    }, { timeout: 30000, label: '定时发布提交' });
    console.log(`OK: 搜狐定时发布成功: ${args.title} @ ${dateLabel} ${hour}:${minute}`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
