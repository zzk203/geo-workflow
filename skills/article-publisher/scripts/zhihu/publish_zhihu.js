// 知乎文章发布/前台填充审核脚本
// 用法:
//   node publish_zhihu.js --title "标题" --doc-url "飞书URL" --state "登录状态-zhihu.json" --review --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/01"
//   node publish_zhihu.js --title "标题" --doc-url "飞书URL" --state "登录状态-zhihu.json" --publish --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/01"
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, waitFor, mainArgs,
} = require('../common/common.js');

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state) {
    console.error('缺少参数: --title / --doc-url / --state 必填');
    process.exit(1);
  }
  const review = !!args.review;
  const publish = !!args.publish;
  const draft = !!args.draft;
  if (!review && !publish && !draft) {
    console.error('请指定 --review / --publish / --draft');
    process.exit(1);
  }
  const workdir = args.workdir || '';
  const local = !!args.local;
  const headless = !review && !args.headed;

  // 使用本地 article.json 生成剪贴板 HTML，避免飞书在线复制超时
  function generateLocalClipboard(workdir) {
    const article = JSON.parse(fs.readFileSync(path.join(workdir, 'article.json'), 'utf8'));
    const blocks = article.body_blocks || [];
    const htmlParts = [];
    const txtParts = [];
    for (const b of blocks) {
      if (b.type === 'image') continue;
      if (b.type === 'table') {
        const rows = b.rows || [];
        const tableHtml = '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%">' +
          rows.map(row => '<tr>' + row.map(cell => `<td>${cell}</td>`).join('') + '</tr>').join('') + '</table>';
        htmlParts.push(tableHtml);
        txtParts.push(rows.map(row => row.join(' | ')).join('\n'));
        continue;
      }
      const text = b.text || '';
      if (b.type === 'heading') {
        htmlParts.push(`<h2>${text}</h2>`);
      } else if (b.type === 'bullet') {
        htmlParts.push(`<ul><li>${text}</li></ul>`);
      } else {
        htmlParts.push(`<p>${text}</p>`);
      }
      txtParts.push(text);
    }
    const html = removeAltBlockFromHtml(htmlParts.join('\n'), loadMainTitle(workdir));
    const txt = txtParts.join('\n\n');
    const htmlFile = path.join(workdir, 'clipboard_local.html');
    const txtFile = path.join(workdir, 'clipboard_local.txt');
    fs.writeFileSync(htmlFile, html, 'utf8');
    fs.writeFileSync(txtFile, txt, 'utf8');
    return [htmlFile, txtFile];
  }

  // 知乎图片插入：根据 article.json 的图片位置，在前一段落后插入本地图片
  async function insertZhihuImages(page, editor, workdir) {
    const articlePath = path.join(workdir, 'article.json');
    if (!fs.existsSync(articlePath)) {
      console.log('[知乎] 未找到 article.json，跳过图片插入');
      return;
    }
    const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
    const blocks = article.body_blocks || [];
    const imageFiles = (article.images || []).map(x => x.file).filter(Boolean);
    let imgIdx = 0;
    for (let i = 0; i < blocks.length && imgIdx < imageFiles.length; i++) {
      if (blocks[i].type !== 'image') continue;
      let prevText = '';
      for (let j = i - 1; j >= 0; j--) {
        if (blocks[j].type === 'text' || blocks[j].type === 'heading' || blocks[j].type === 'bullet') {
          prevText = blocks[j].text || '';
          break;
        }
      }
      if (!prevText) { imgIdx++; continue; }
      const prefix = prevText.trim().slice(0, 20);
      const block = editor.locator('[data-block=true]').filter({ hasText: prefix }).first();
      if (!(await block.count())) {
        console.warn('[知乎] 未找到图片前文块:', prefix);
        imgIdx++;
        continue;
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
      const file = imageFiles[imgIdx];
      if (file && fs.statSync(file).size > 5 * 1024 * 1024) {
        console.warn(`[知乎] 图片${imgIdx + 1}超过5MB，跳过:`, file);
        imgIdx++;
        continue;
      }
      // 关闭可能残留的弹窗/遮罩，避免 Modal-backdrop 拦截后续点击
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelector('button[aria-label="图片"]').click());
      await page.waitForTimeout(1000);
      await page.getByText('本地图片上传', { exact: true }).first().click();
      await page.waitForTimeout(800);
      const input = page.locator('.Modal input[type=file][accept*="image"]').last();
      await input.setInputFiles(file);
      await waitFor(async () => (await page.getByText('插入图片', { exact: true }).count()) > 0,
        { timeout: 30000, label: `知乎图片${imgIdx+1}上传` });
      await page.getByText('插入图片', { exact: true }).first().click();
      await page.waitForTimeout(2000);
      console.log(`[知乎] 图片${imgIdx+1}已插入`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      imgIdx++;
    }
    console.log(`[知乎] 图片插入完成，共 ${imgIdx} 张`);
  }

  const browser = await launch({ headless });
  try {
    const { context, page } = await openPage(browser, args.state);
    await page.goto('https://zhuanlan.zhihu.com/write', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    if (page.url().includes('signin')) {
      console.error('未登录知乎');
      process.exit(1);
    }

    // 1. 标题
    await page.locator('textarea[placeholder="请输入标题（最多 100 个字）"]').fill(args.title);
    console.log('[知乎] 标题已填:', args.title);

    // 2. 正文
    const editor = page.locator('.public-DraftEditor-content');
    if (workdir && await setClipboardFromIntermediate(page, workdir)) {
      console.log('[知乎] 使用本地中转文件');
    } else if (local && workdir) {
      const [htmlFile, txtFile] = generateLocalClipboard(workdir);
      await setClipboard(page, htmlFile, txtFile);
    } else {
      await copyFromFeishu(context, args['doc-url']);
      const raw = await readClipboardHtml(page);
      const cleaned = removeAltBlockFromHtml(raw, loadMainTitle(workdir));
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-clip-'));
      const htmlFile = path.join(tmpDir, 'clipboard.html');
      const txtFile = path.join(tmpDir, 'clipboard.txt');
      fs.writeFileSync(htmlFile, cleaned, 'utf8');
      fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
      await setClipboard(page, htmlFile, txtFile);
    }
    await editor.click();
    await page.keyboard.press('Control+V');
    await waitFor(async () => (await editor.innerText()).length > 500,
      { timeout: 180000, label: '正文粘贴完成' });
    console.log('[知乎] 正文已粘贴');

    // 按用户要求：知乎不插入正文图片（平台图片不可见问题）
    console.log('[知乎] 不插入正文图片，仅发布富文本正文');

    if (review) {
      console.log('[知乎] 已在前台填充完毕，请审核。确认后可在浏览器手动发布，或告诉我继续自动发布。');
      await new Promise(() => {});
    }

    if (draft) {
      // 只保存草稿，不发布（知乎自动发布当前被风控限制）
      await page.waitForTimeout(5000);
      console.log('[知乎] 草稿已保存（未发布）:', args.title);
    }

    if (publish) {
      // 4. 发布；若平台风控/校验导致发布失败，则保留为草稿（知乎编辑器会自动保存）
      try {
        await page.getByRole('button', { name: '发布', exact: true }).click();
        await waitFor(async () => {
          const t = await page.evaluate(() => document.body.innerText);
          return t.includes('发布成功') || page.url().includes('/p/') || page.url().includes('/creator');
        }, { timeout: 60000, label: '知乎发布成功' });
        console.log('OK: 知乎发布成功:', args.title);
      } catch (e) {
        console.log('[知乎] 自动发布失败，已保留为草稿:', args.title, '->', e.message);
        await page.waitForTimeout(3000);
      }
    }
  } finally {
    if (!args.review) await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
