// 百家号发布脚本
// 用法: node publish_baijiahao.js --title "标题" --doc-url "飞书文档URL" --state "登录状态.json" --image 图片路径 [--headed]
// 要点: 标题是 contenteditable DIV；正文在 UEditor iframe 内；封面必填且必须保持"单图"模式
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, dragDelete, waitFor, mainArgs,
  waitForImagesUploaded, acquireClipboardLock, releaseClipboardLock,
} = require('../common/common.js');

const EDIT_URL = 'https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1';
const FRAME = '#ueditor_0';

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

async function insertBaijiahaoImages(page, workdir) {
  const articlePath = path.join(workdir, 'article.json');
  if (!fs.existsSync(articlePath)) return;
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const blocks = article.body_blocks || [];
  const imageFiles = (article.images || []).map(x => x.file).filter(Boolean);
  let imgIdx = 0;
  let inserted = 0;
  let lastText = '';
  for (let i = 0; i < blocks.length && imgIdx < imageFiles.length; i++) {
    const b = blocks[i];
    if (b.type === 'image') {
      if (!lastText) { imgIdx++; continue; }
      const prefix = lastText.trim().slice(0, 20);
      const frame = page.frameLocator(FRAME);
      const paras = frame.locator('body p');
      const count = await paras.count();
      let targetIdx = -1;
      for (let j = 0; j < count; j++) {
        const text = (await paras.nth(j).innerText().catch(() => '')).trim();
        if (text.includes(prefix)) { targetIdx = j; break; }
      }
      if (targetIdx === -1) {
        console.warn('[百家号] 未找到图片前文段落:', prefix);
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
      // 关闭可能残留的弹窗，再打开图片上传弹窗；若未打开则重试
      let fileInput = null;
      for (let openAttempt = 0; openAttempt < 3; openAttempt++) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.locator('.cheetah-modal-footer button').filter({ hasText: '取消' }).first().click().catch(() => {});
        await page.waitForTimeout(300);
        const insertBtn = page.locator('.edui-for-insertimage').first();
        try {
          await insertBtn.click({ timeout: 3000 });
        } catch (e) {
          try {
            await insertBtn.click({ timeout: 3000, force: true });
          } catch (e2) {
            await insertBtn.evaluate(el => el.click()).catch(() => {});
          }
        }
        await page.waitForTimeout(1500);
        fileInput = page.locator('.cheetah-modal input[type=file][accept="image/*"]').first();
        if (await fileInput.count()) break;
        if (openAttempt === 2) throw new Error('无法打开百家号图片上传弹窗');
        console.log(`[百家号] 图片弹窗未出现，重试打开(${openAttempt + 1})`);
        // range 方式未生效时，点击正文末尾重新获得编辑器焦点
        await page.frameLocator(FRAME).locator('body p').last().click({ position: { x: 5, y: 5 } }).catch(() => {});
        await page.keyboard.press('End');
        await page.waitForTimeout(300);
      }
      const bjhImg = imageFiles[imgIdx];
      if (bjhImg && fs.statSync(bjhImg).size > 5 * 1024 * 1024) {
        console.warn(`[百家号] 图片${imgIdx + 1}超过5MB，跳过:`, bjhImg);
        imgIdx++;
        continue;
      }
      await fileInput.setInputFiles(bjhImg);
      await waitFor(async () => {
        const t = await page.locator('.cheetah-modal').innerText().catch(() => '');
        return t.includes('上传成功') || (await page.locator('.cheetah-modal-footer button').filter({ hasText: '确认' }).first().isEnabled().catch(() => false));
      }, { timeout: 60000, label: `百家号图片${imgIdx + 1}上传` });
      await page.locator('.cheetah-modal-footer button').filter({ hasText: '确认' }).first().click();
      await waitFor(async () => (await frame.locator('body img').count()) > inserted,
        { timeout: 30000, label: `百家号图片${imgIdx + 1}插入` });
      // 图片插入后弹窗可能不会自动关闭，手动点“取消”关闭，避免影响下一张图片上传
      if (await page.locator('.cheetah-modal').count()) {
        await page.locator('.cheetah-modal-footer button').filter({ hasText: '取消' }).first().click().catch(() => {});
        await page.waitForTimeout(1000);
      }
      console.log(`[百家号] 图片${imgIdx + 1}已插入`);
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
  console.log(`[百家号] 正文图片插入完成，共 ${inserted} 张`);
}

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state || !args.image) {
    console.error('缺少参数: --title / --doc-url / --state / --image 必填');
    process.exit(1);
  }

  const browser = await launch({ headless: !args.headed });
  try {
    const { context, page } = await openPage(browser, args.state);
    page.__articleImage = args.image;
    await page.goto(EDIT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(10000);

    if (page.url().includes('/theme/bjh/login')) {
      console.error('未登录百家号，请先手动登录并 state-save 后再运行');
      process.exit(1);
    }

    // 关闭可能出现的平台弹窗/协议提示，避免遮挡编辑器
    for (const text of ['我知道了', '确认', '×']) {
      const loc = page.getByText(text, { exact: true }).first();
      if (await loc.count().catch(() => 0)) {
        try { await loc.click({ timeout: 2000 }); await page.waitForTimeout(500); } catch (e) {}
      }
    }

    // 1. 标题（contenteditable DIV，click 后 type）
    await page.locator('[contenteditable=true][class*=editor]').click();
    await page.keyboard.type(args.title);
    await page.waitForTimeout(500);
    console.log('[百家号] 标题已填');

    // 2. 正文：通过 UEditor setContent 直接写入本地中转 HTML（富文本），避免剪贴板被转成纯文本
    const body = page.frameLocator(FRAME).locator('body');
    await body.waitFor({ timeout: 20000 });
    const htmlPath = args.workdir ? path.join(args.workdir, '正文_clean.html') : null;
    if (htmlPath && fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      await page.evaluate((h) => {
        const iframe = document.querySelector('iframe#ueditor_0');
        const ed = iframe && iframe.contentWindow && iframe.contentWindow.editor;
        if (!ed) throw new Error('未找到百家号 UEditor editor 实例');
        ed.focus();
        ed.setContent(h || '');
      }, html);
      await page.waitForTimeout(1000);
      const textLen = (await body.innerText().catch(() => '')).length;
      if (textLen < 2000) {
        throw new Error(`百家号 UEditor setContent 后正文长度异常: ${textLen}`);
      }
      console.log('[百家号] 正文已通过 UEditor 写入富文本 HTML');
    } else {
      // 没有本地中转 HTML 时回退到剪贴板 HTML 粘贴
      const localReady = args.workdir && await setClipboardFromIntermediate(page, args.workdir);
      if (!localReady) {
        await copyFromFeishu(context, args['doc-url']);
        const raw = await readClipboardHtml(page);
        const cleaned = removeAltBlockFromHtml(raw, loadMainTitle(args.workdir));
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjh-clip-'));
        const htmlFile = path.join(tmpDir, 'clipboard.html');
        const txtFile = path.join(tmpDir, 'clipboard.txt');
        fs.writeFileSync(htmlFile, cleaned, 'utf8');
        fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
        await setClipboard(page, htmlFile, txtFile);
      }
      let pasted = false;
      for (let pasteAttempt = 0; pasteAttempt < 3 && !pasted; pasteAttempt++) {
        await body.click({ position: { x: 200, y: 200 } });
        await page.keyboard.press('Control+V');
        try {
          await waitFor(async () => (await body.innerText()).length > 2000,
            { timeout: 60000, label: `正文粘贴完成(${pasteAttempt + 1})` });
          pasted = true;
        } catch (e) {
          if (pasteAttempt === 2) throw e;
          console.log(`[百家号] 第${pasteAttempt + 1}次粘贴未生效，重试`);
          await page.waitForTimeout(2000);
        }
      }
      console.log('[百家号] 正文已粘贴（富文本回退）');
    }
    if (args.workdir) {
      const htmlPathForImgCheck = path.join(args.workdir, '正文_clean.html');
      const htmlHasRemoteImages = fs.existsSync(htmlPathForImgCheck)
        && /<img\b/i.test(fs.readFileSync(htmlPathForImgCheck, 'utf8'));
      if (!htmlHasRemoteImages) {
        await insertBaijiahaoImages(page, args.workdir);
      } else {
        console.log('[百家号] 正文 HTML 已含图片，跳过本地逐张插入（等待 UEditor 自动上传）');
      }
    }

    // 验证图片已转存到百家号 CDN：按状态判断，所有正文图片的 src 都不再是
    // data:/blob:/飞书签名 URL，且已加载完成（排除编辑器自带的加载占位 gif）。
    await waitForImagesUploaded(page, {
      selector: 'img',
      frameSelector: FRAME,
      ignoreSrc: 'df3e567d6f16d040326c7a0ea29a4f41.gif',
      timeout: 240000,
      label: '图片转存到百家号 CDN',
    });
    console.log('[百家号] 图片已上传');
    // 4. 封面（必填）：优先本地上传；若当前图片上传/保存失败，自动尝试当前项目内其他图片，成功后记为备选图片
    const imageDir = path.dirname(args.image);
    const fallbackStoreFile = path.join(path.resolve(imageDir, '..', '..'), '平台备选图片.json');
    const readFallback = () => {
      try { return JSON.parse(fs.readFileSync(fallbackStoreFile, 'utf8')); } catch (e) { return {}; }
    };
    const saveFallback = (img) => {
      try {
        const store = readFallback();
        store.baijiahao = img;
        fs.writeFileSync(fallbackStoreFile, JSON.stringify(store, null, 2), 'utf8');
        console.log('[百家号] 已保存备选封面图片:', img);
      } catch (e) {
        console.log('[百家号] 保存备选封面图片失败:', e.message);
      }
    };
    const candidateImages = [];
    const pushImage = (img) => {
      if (img && fs.existsSync(img) && !candidateImages.includes(img)) candidateImages.push(img);
    };
    pushImage(args.image);
    if (fs.existsSync(imageDir)) {
      fs.readdirSync(imageDir)
        .filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))
        .map(f => path.join(imageDir, f))
        .forEach(pushImage);
    }
    pushImage((readFallback() || {}).baijiahao);

    const isCoverSet = async () => {
      const t = await page.evaluate(() => document.body.innerText);
      return t.includes('更换') || t.includes('重新选择') || t.includes('修改封面') || t.includes('已设置封面') || t.includes('重新上传');
    };
    const openCoverModal = async () => {
      const modalOpen = await page.evaluate(() => {
        const wraps = [...document.querySelectorAll('.cheetah-modal-wrap')];
        return wraps.some(m => {
          const r = m.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        }) || wraps.some(m => (m.innerText || '').includes('本地上传') && m.offsetParent !== null);
      });
      if (!modalOpen) {
        const selectCover = page.getByText('选择封面', { exact: true }).first();
        if (await selectCover.count()) {
          await selectCover.click();
          await waitFor(async () => {
            const modals = await page.evaluate(() => {
              const wraps = [...document.querySelectorAll('.cheetah-modal-wrap')];
              return wraps.some(m => {
                const r = m.getBoundingClientRect();
                return r.width > 50 && r.height > 50;
              });
            });
            return modals;
          }, { label: '封面弹窗打开' });
          return true;
        }
        return false;
      } else {
        const localTab = page.locator('.cheetah-modal-wrap:visible').getByText('正文/本地上传', { exact: false }).first();
        if (await localTab.count()) {
          await localTab.click();
          await page.waitForTimeout(800);
        }
        return true;
      }
    };

    let coverSet = false;
    let usedFallback = null;
    for (const img of candidateImages) {
      console.log(`[百家号] 尝试封面图片: ${img}`);
      // 先关闭可能残留的弹窗，避免上一次失败影响下一次
      await page.keyboard.press('Escape').catch(() => {});
      await page.getByRole('button', { name: '取消' }).first().click().catch(() => {});
      await page.waitForTimeout(500);
      const opened = await openCoverModal();
      if (!opened && !(await isCoverSet())) {
        console.error('[百家号] 无法打开封面弹窗，且未检测到已设置封面，尝试下一张');
        continue;
      }
      page.__articleImage = img;
      await page.locator('.cheetah-modal-wrap input[type=file]').first()
        .setInputFiles(img).catch(async () => {
          await page.getByText('点击本地上传', { exact: true }).first().click().catch(() => {});
          await page.waitForTimeout(1000);
        });
      await page.waitForTimeout(5000);
      const wrapperCount = await page.locator('.cheetah-modal-wrap [class*=imgWrapper]').count();
      if (wrapperCount > 0) {
        const coverWrapper = page.locator('.cheetah-modal-wrap [class*=imgWrapper]').first();
        const cls = await coverWrapper.getAttribute('class').catch(() => '');
        if (cls.includes('selectedItem')) {
          await coverWrapper.click();
          await page.waitForTimeout(300);
        }
        await coverWrapper.click();
        await page.waitForTimeout(300);
        for (let attempt = 0; attempt < 5; attempt++) {
          const confirmBtn = page.getByRole('button', { name: /^确定/ }).first();
          if (!(await confirmBtn.count())) break;
          const t0 = Date.now();
          while (Date.now() - t0 < 15000) {
            if (await confirmBtn.isEnabled().catch(() => false)) break;
            await page.waitForTimeout(500);
          }
          if (!(await confirmBtn.isEnabled().catch(() => false))) break;
          await confirmBtn.click();
          await page.waitForTimeout(2000);
          const t1 = Date.now();
          while (Date.now() - t1 < 15000) {
            const txt = await page.evaluate(() => document.body.innerText);
            if (!txt.includes('封面裁剪处理中')) break;
            await page.waitForTimeout(1000);
          }
          const modalOpen = await page.evaluate(() =>
            [...document.querySelectorAll('.cheetah-modal-wrap')]
              .some(m => m.getBoundingClientRect().width > 100));
          if (!modalOpen) break;
        }
      }
      const single = page.locator('.cheetah-radio-input').first();
      if (await single.count() && !(await single.isChecked().catch(() => false))) {
        await page.evaluate(() => {
          const radios = document.querySelectorAll('.cheetah-radio-input');
          if (radios[0]) radios[0].click();
        });
        console.log('[百家号] 封面模式已切回单图');
      }
      let ok = await isCoverSet();
      if (!ok) {
        try {
          await waitFor(isCoverSet, { timeout: 15000, label: '封面设置生效' });
          ok = true;
        } catch (e) {
          ok = false;
        }
      }
      if (ok) {
        coverSet = true;
        usedFallback = img;
        console.log(`[百家号] 封面设置成功: ${img}`);
        break;
      }
      // 不主动关闭弹窗，下一张图片直接在同一弹窗内继续尝试
    }
    if (coverSet && usedFallback && usedFallback !== args.image) {
      saveFallback(usedFallback);
    }
    if (!coverSet) {
      console.error('[百家号] 所有候选封面图片均设置失败');
      process.exit(1);
    }
    console.log('[百家号] 封面已设置');

    // 4.5 勾选“采用AI生成内容”声明（平台必填，否则发布按钮禁用）
    const aiCheckbox = page.locator('.cheetah-checkbox-wrapper', { hasText: '采用AI生成内容' }).first();
    if (await aiCheckbox.count().catch(() => 0)) {
      const aiInput = aiCheckbox.locator('input[type=checkbox]').first();
      if (!(await aiInput.isChecked().catch(() => false))) {
        await aiCheckbox.click();
        await page.waitForTimeout(500);
        console.log('[百家号] 已勾选采用AI生成内容声明');
      }
    }

    // 4.6 勾选“来源说明”并选择地点（平台新增强制项，否则发布按钮禁用）
    const sourceCheckbox = page.locator('.cheetah-checkbox-wrapper', { hasText: '来源说明' }).first();
    if (await sourceCheckbox.count().catch(() => 0)) {
      const srcInput = sourceCheckbox.locator('input[type=checkbox]').first();
      if (!(await srcInput.isChecked().catch(() => false))) {
        await sourceCheckbox.click();
        await page.waitForTimeout(500);
        console.log('[百家号] 已勾选来源说明');
      }
      const statement = page.locator('[class*=statementSetting]').first();
      const select = statement.locator('.cheetah-select').first();
      if (await select.count().catch(() => 0)) {
        await select.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1200);
        // 来源地点是级联选择器，点“北京市”即可（发布按钮会变为可用）
        const option = page.locator('.cheetah-cascader-menu-item-content', { hasText: '北京市' }).first();
        if (await option.count().catch(() => 0)) {
          await option.click();
          await page.waitForTimeout(800);
          console.log('[百家号] 已选择来源地点：北京市');
        } else {
          console.log('[百家号] 未找到来源地点级联选项');
        }
      } else {
        console.log('[百家号] 未找到来源地点下拉框');
      }
    }

    if (args.draft) {
      // 存草稿：即使发布按钮因限额/来源地点禁用，草稿按钮通常可用
      await page.getByText('存草稿', { exact: true }).first().click();
      await page.waitForTimeout(3000);
      console.log('OK: 百家号已存草稿:', args.title);
      return;
    }

    // 5. 发布（成功会出现跳转或发布成功提示）
    await page.getByTestId('publish-btn').click();
    await waitFor(async () => {
      const t = await page.evaluate(() => document.body.innerText);
      return page.url().includes('/builder/rc/clue') || t.includes('发布成功') || t.includes('提交成功');
    }, { timeout: 30000, label: '发布成功' });
    console.log('OK: 百家号发布成功');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
