// 今日头条直接发布/前台填充审核脚本
// 用法:
//   node publish_toutiao.js --title "标题" --doc-url "飞书URL" --state "登录状态.json" --review --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/01"
//   node publish_toutiao.js --title "标题" --doc-url "飞书URL" --state "登录状态.json" --publish --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/01"
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, waitFor, mainArgs,
} = require('../common/common.js');

function plainTextWithoutImagePlaceholders(workdir) {
  const articlePath = path.join(workdir, 'article.json');
  if (!fs.existsSync(articlePath)) return null;
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const out = path.join(workdir, '正文_clean_noimg.txt');
  const parts = [];
  for (const b of article.body_blocks || []) {
    if (b.type === 'image') continue;
    if (b.type === 'table') {
      for (const row of (b.rows || [])) parts.push(row.join(' | '));
      continue;
    }
    const text = (b.text || '').trim();
    if (!text) continue;
    if (b.type === 'bullet') parts.push('• ' + text);
    else parts.push(text);
  }
  fs.writeFileSync(out, parts.join('\n'), 'utf8');
  return out;
}

async function insertToutiaoImages(page, workdir) {
  const articlePath = path.join(workdir, 'article.json');
  if (!fs.existsSync(articlePath)) return;
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const blocks = article.body_blocks || [];
  const imageFiles = (article.images || []).map(x => x.file).filter(Boolean);
  const editor = page.locator('.ProseMirror');
  let imgIdx = 0;
  let inserted = 0;
  let lastText = '';
  for (let i = 0; i < blocks.length && imgIdx < imageFiles.length; i++) {
    const b = blocks[i];
    if (b.type === 'image') {
      if (!lastText) { imgIdx++; continue; }
      const prefix = lastText.trim().slice(0, 20);
      const paras = editor.locator('p');
      const count = await paras.count();
      let targetIdx = -1;
      for (let j = 0; j < count; j++) {
        const text = (await paras.nth(j).innerText().catch(() => '')).trim();
        if (text.includes(prefix)) { targetIdx = j; break; }
      }
      if (targetIdx === -1) {
        console.warn('[头条] 未找到图片前文段落:', prefix);
        imgIdx++;
        continue;
      }
      await paras.nth(targetIdx).evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        el.scrollIntoView({ block: 'center' });
      });
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await page.locator('div.syl-toolbar-tool.image button.syl-toolbar-button').first().click();
      await page.waitForTimeout(1500);
      const uploadBtn = page.getByText('本地上传', { exact: true }).first();
      const fcPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await uploadBtn.click();
      const fc = await fcPromise;
      if (!fc) throw new Error('头条图片上传未触发文件选择器');
      const ttImg = imageFiles[imgIdx];
      if (ttImg && fs.statSync(ttImg).size > 5 * 1024 * 1024) {
        console.warn(`[头条] 图片${imgIdx + 1}超过5MB，跳过:`, ttImg);
        imgIdx++;
        continue;
      }
      await fc.setFiles(ttImg);
      await waitFor(async () => {
        const btn = page.getByRole('button', { name: '确定', exact: true }).first();
        return await btn.isEnabled().catch(() => false);
      }, { timeout: 60000, label: `头条图片${imgIdx + 1}上传` });
      await page.getByRole('button', { name: '确定', exact: true }).first().click();
      await waitFor(async () => (await editor.locator('img').count()) > inserted,
        { timeout: 30000, label: `头条图片${imgIdx + 1}插入` });
      console.log(`[头条] 图片${imgIdx + 1}已插入`);
      inserted++;
      imgIdx++;
    } else if (b.type === 'table') {
      const rows = b.rows || [];
      lastText = rows.map(r => r.join(' ')).join(' ');
    } else {
      const text = (b.text || '').trim();
      if (text) lastText = text;
    }
  }
  console.log(`[头条] 正文图片插入完成，共 ${inserted} 张`);
}

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state) {
    console.error('缺少参数: --title / --doc-url / --state 必填');
    process.exit(1);
  }
  const review = !!args.review;
  const publish = !!args.publish;
  if (!review && !publish) {
    console.error('请指定 --review 或 --publish');
    process.exit(1);
  }
  const workdir = args.workdir || '';
  const headless = !review && !args.headed;

  const browser = await launch({ headless });
  try {
    const { context, page } = await openPage(browser, args.state);
    await page.goto('https://mp.toutiao.com/profile_v4/graphic/publish', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);
    if (page.url().includes('/login') || page.url().includes('signin')) {
      console.error('未登录今日头条');
      process.exit(1);
    }

    // 1. 标题
    await page.locator('textarea[placeholder="请输入文章标题（2～30个字）"]').fill(args.title);
    console.log('[头条] 标题已填:', args.title);

    // 2. 正文：优先纯文本粘贴 + 本地图片插入（避免飞书图片 URL 过期导致上传失败）
    const plainTxt = workdir ? plainTextWithoutImagePlaceholders(workdir) : null;
    if (plainTxt) {
      let pasted = false;
      for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
        await setClipboard(page, null, plainTxt);
        await page.waitForTimeout(1000);
        await page.locator('.ProseMirror').click({ position: { x: 200, y: 200 } });
        await page.waitForTimeout(500);
        await page.keyboard.press('Control+V');
        try {
          await waitFor(async () => (await page.locator('.ProseMirror').innerText()).length > 2000,
            { timeout: 120000, label: `正文粘贴完成(${attempt + 1})` });
          pasted = true;
        } catch (e) {
          if (attempt === 2) throw e;
          console.log(`[头条] 第${attempt + 1}次粘贴未生效，重试`);
          await page.waitForTimeout(3000);
        }
      }
      console.log('[头条] 正文已粘贴');
      await insertToutiaoImages(page, workdir);
      // 关闭可能残留的图片上传抽屉，避免遮挡发布按钮
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      const drawerClose = page.locator('.byte-drawer-close, .byte-drawer-wrapper [class*=close], .upload-image-panel [class*=close]').first();
      if (await drawerClose.isVisible().catch(() => false)) {
        await drawerClose.click();
        await page.waitForTimeout(500);
      }
    } else {
      // 没有 workdir/article.json 时退回原来的 HTML 粘贴流程
      if (workdir && await setClipboardFromIntermediate(page, workdir)) {
        console.log('[头条] 使用本地中转文件');
      } else {
        await copyFromFeishu(context, args['doc-url']);
        const raw = await readClipboardHtml(page);
        const cleaned = removeAltBlockFromHtml(raw, loadMainTitle(workdir));
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toutiao-clip-'));
        const htmlFile = path.join(tmpDir, 'clipboard.html');
        const txtFile = path.join(tmpDir, 'clipboard.txt');
        fs.writeFileSync(htmlFile, cleaned, 'utf8');
        fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
        await setClipboard(page, htmlFile, txtFile);
      }
      await page.locator('.ProseMirror').click();
      await page.keyboard.press('Control+V');
      await waitFor(async () => (await page.locator('.ProseMirror').innerText()).length > 2000,
        { timeout: 180000, label: '正文粘贴完成' });
      console.log('[头条] 正文已粘贴');
    }

    // 4. 封面：按用户要求选“无封面”
    await page.getByText('无封面', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    console.log('[头条] 封面已设为无封面');

    if (review) {
      console.log('[头条] 已在前台填充完毕，请审核。确认后可在浏览器手动发布，或告诉我继续自动发布。');
      await new Promise(() => {}); // keep alive
    }

    if (publish) {
      await page.getByRole('button', { name: '预览并发布' }).click();
      await page.waitForTimeout(6000);
      const info = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [class*=button], [role=button], .byte-dialog, [class*=dialog], [class*=modal]')].map(el => ({tag:el.tagName, text:(el.innerText||'').trim().slice(0,120), cls:el.className, visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)})).filter(x => x.text || x.cls).slice(0,200);
        return {url: location.href, body: document.body.innerText.slice(0,3000), buttons};
      });
      console.log('DEBUG_JSON ' + JSON.stringify(info, null, 2));
    }
  } finally {
    if (!args.review) await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
