// 临时脚本：在知乎已发布/草稿文章的编辑页中，按 article.json 位置插入本地图片并发布/更新。
const fs = require('fs');
const path = require('path');
const {
  loadPlaywright, openPage, waitFor, mainArgs,
} = require('../common/common.js');

(async () => {
  const args = mainArgs();
  if (!args.title || !args.state || !args.workdir || !args['edit-url']) {
    console.error('缺少参数: --title / --state / --workdir / --edit-url 必填');
    process.exit(1);
  }
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const { page } = await openPage(browser, args.state);
    await page.goto(args['edit-url'], { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);

    const workdir = args.workdir;
    const article = JSON.parse(fs.readFileSync(path.join(workdir, 'article.json'), 'utf8'));
    const editor = page.locator('.public-DraftEditor-content');
    const imageFiles = (article.images || []).map(x => x.file).filter(Boolean);
    const blocks = article.body_blocks || [];

    async function insertOne(file, prevText) {
      const prefix = prevText.trim().slice(0, 20);
      const block = editor.locator('[data-block=true]').filter({ hasText: prefix }).first();
      if (!(await block.count())) {
        console.warn('[知乎编辑插图] 未找到图片前文块:', prefix);
        return false;
      }
      await block.evaluate(el => {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        el.scrollIntoView({ block: 'center' });
      });
      await page.waitForTimeout(300);
      // 关闭残留弹窗/遮罩
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelector('button[aria-label="图片"]').click());
      await page.waitForTimeout(1000);
      // 直接对本地文件 input 设置文件
      const fileInput = page.locator('.Modal input[type=file][accept*="image"]').last();
      await fileInput.setInputFiles(file);
      await waitFor(async () => (await page.getByText('插入图片', { exact: true }).count()) > 0,
        { timeout: 60000, label: '知乎图片上传' });
      await page.getByRole('button', { name: '插入图片', exact: true }).click();
      await page.waitForTimeout(3000);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      return true;
    }

    let imgIdx = 0;
    let lastText = '';
    for (let i = 0; i < blocks.length && imgIdx < imageFiles.length; i++) {
      const b = blocks[i];
      if (b.type === 'image') {
        const file = imageFiles[imgIdx];
        if (file && fs.existsSync(file)) {
          const ok = await insertOne(file, lastText);
          console.log(`[知乎编辑插图] 图片${imgIdx + 1}插入${ok ? '成功' : '跳过'}`);
        }
        imgIdx++;
      } else if (b.type === 'table') {
        lastText = (b.rows || []).map(r => r.join(' ')).join(' ');
      } else {
        const text = (b.text || '').trim();
        if (text) lastText = text;
      }
    }

    // 等待自动保存稳定
    console.log('[知乎编辑插图] 等待自动保存稳定 10 秒');
    await page.waitForTimeout(10000);

    const publishBtn = page.getByRole('button', { name: '发布', exact: true });
    if (await publishBtn.count().catch(() => 0)) {
      await publishBtn.click();
      await page.waitForTimeout(6000);
      console.log('发布后 URL:', page.url());
    } else {
      console.log('[知乎编辑插图] 未找到发布按钮，可能仍在自动保存');
    }
  } finally {
    if (!args.headed) await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
