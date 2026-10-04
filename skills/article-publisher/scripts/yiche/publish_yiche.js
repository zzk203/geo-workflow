// 易车发布脚本
// 用法: node publish_yiche.js --title "标题" --doc-url "飞书文档URL" --state "登录状态.json" --image 图片路径 [--headed]
// 要点: Quill 编辑器；横版封面自动取正文图；竖版封面走「自动获取」向导；点击上传区会堆积 filechooser（已用全局兜底规避）
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, dragDelete, waitFor, mainArgs,
  waitForImagesUploaded, acquireClipboardLock, releaseClipboardLock,
} = require('../common/common.js');

const INDEX_URL = 'https://mp.yiche.com/article/index-new/';

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
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    if (page.url().includes('authenservice/login')) {
      console.error('未登录易车，请先手动登录并 state-save 后再运行');
      process.exit(1);
    }

    // 1. 标题
    await page.locator('input[placeholder="请输入文章标题"]').fill(args.title);
    console.log('[易车] 标题已填');

    // 1.5 竖版封面上传：在复制正文之前本地上传，避免自动获取默认两张图叠加
    const verticalCover = page.locator('.article-cover').filter({ hasText: '*竖版封面图' }).first();
    const isVerticalSet = async () => {
      const text = await verticalCover.innerText().catch(() => '');
      const maskVisible = await verticalCover.locator('.cover-mask').first().evaluate(el => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      }).catch(() => false);
      const imgCount = await verticalCover.locator('img').count().catch(() => 0);
      const hasBg = await verticalCover.evaluate(el => {
        const boxes = el.querySelectorAll('.cover-box [class*=upload-image], .cover-box .avatar-uploader');
        for (const b of boxes) {
          const bg = getComputedStyle(b).backgroundImage;
          if (bg && bg !== 'none') return true;
        }
        return false;
      }).catch(() => false);
      return text.includes('更换') || text.includes('删除') || maskVisible || imgCount > 0 || hasBg;
    };
    const imageDir = path.dirname(args.image);
    const fallbackStoreFile = path.join(path.resolve(imageDir, '..', '..'), '平台备选图片.json');
    const readFallback = () => {
      try { return JSON.parse(fs.readFileSync(fallbackStoreFile, 'utf8')); } catch (e) { return {}; }
    };
    const saveFallback = (img) => {
      try {
        const store = readFallback();
        store.yiche = img;
        fs.writeFileSync(fallbackStoreFile, JSON.stringify(store, null, 2), 'utf8');
        console.log('[易车] 已保存备选封面图片:', img);
      } catch (e) {
        console.log('[易车] 保存备选封面图片失败:', e.message);
      }
    };
    const getImageSize = (file) => {
      try {
        const buf = fs.readFileSync(file);
        if (buf.length >= 24 && buf[0] === 0xFF && buf[1] === 0xD8) {
          let i = 2;
          while (i < buf.length) {
            if (buf[i] !== 0xFF) { i++; continue; }
            const marker = buf[i + 1];
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
              return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
            }
            const len = buf.readUInt16BE(i + 2);
            i += 2 + len;
          }
        } else if (buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
          return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
      } catch (e) {}
      return null;
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
    pushImage((readFallback() || {}).yiche);
    // 易车限制：单张不超过 10M，宽度不超过 5000 像素
    const validCandidates = candidateImages.filter(img => {
      try {
        if (fs.statSync(img).size > 10 * 1024 * 1024) return false;
        const size = getImageSize(img);
        return size && size.width <= 5000;
      } catch (e) { return false; }
    });
    if (validCandidates.length) candidateImages.length = 0, candidateImages.push(...validCandidates);

    let verticalOk = false;
    for (const img of candidateImages) {
      console.log(`[易车] 尝试竖版封面图片: ${img}`);
      // 先关闭可能残留的弹窗，避免上一次失败影响下一次
      await page.keyboard.press('Escape').catch(() => {});
      await page.getByRole('button', { name: '取消' }).click().catch(() => {});
      await page.waitForTimeout(500);
      await verticalCover.locator('input[type=file]').first().setInputFiles(img);
      try {
        await waitFor(async () => {
          const finish = page.getByRole('button', { name: '完成裁剪' }).first();
          if (await finish.count()) return true;
          const dialogs = await page.locator('[role=dialog], .el-dialog').evaluateAll(els =>
            els.filter(e => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && /封面|裁剪|图片/.test(e.innerText || '');
            }).length);
          return dialogs > 0;
        }, { timeout: 15000, label: '竖版封面上传弹窗' });
      } catch (e) {
        console.log(`[易车] 竖版封面上传 ${img} 后未出现弹窗，尝试下一张`);
        continue;
      }
      const finishBtn = page.getByRole('button', { name: '完成裁剪' }).first();
      if (await finishBtn.count()) {
        await page.waitForTimeout(2000);
        await finishBtn.click();
        await page.waitForTimeout(2000);
        // 按用户确认：完成裁剪后直接点“确定”
        const confirmBtn = page.locator('.el-dialog:visible, [role=dialog]:visible').locator('button.el-button--danger', { hasText: '确定' }).last();
        console.log(`[易车] 准备点击竖版封面确定按钮: ${await confirmBtn.count()}`);
        if (await confirmBtn.count()) {
          await confirmBtn.click();
          console.log('[易车] 已点击竖版封面确定，等待上传成功...');
          try {
            await waitFor(isVerticalSet, { timeout: 30000, interval: 1000, label: '竖版封面上传成功' });
          } catch (e) {
            console.log('[易车] 等待竖版封面上传成功超时');
          }
        } else {
          console.log(`[易车] 竖版封面上传 ${img} 后完成裁剪但未找到确定按钮`);
        }
      } else {
        const vModal = page.locator('[role=dialog]:visible, .el-dialog:visible').filter({ hasText: /封面|裁剪|图片/ }).first();
        if (await vModal.count()) {
          const confirmBtn = vModal.getByRole('button', { name: '确定' }).last();
          if (await confirmBtn.count()) await confirmBtn.click();
          await page.waitForTimeout(2000);
        } else {
          continue;
        }
      }
      if (await isVerticalSet()) {
        verticalOk = true;
        if (img !== args.image) saveFallback(img);
        console.log(`[易车] 竖版封面设置成功: ${img}`);
        break;
      }
    }
    if (!verticalOk) {
      console.error('[易车] 竖版封面所有候选图片均设置失败');
      process.exit(1);
    }
    console.log('[易车] 竖版封面已设置');

    // 2. 正文：飞书复制 → 读回剪贴板并重新写入（提高粘贴稳定性）→ 粘贴 Quill 编辑器（带重试）
    //    剪贴板是跨平台共享资源：并发发布时用锁把「写剪贴板 → 粘贴 → 确认」整段串行化。
    let pasted = false;
    for (let pasteAttempt = 0; pasteAttempt < 3 && !pasted; pasteAttempt++) {
      await acquireClipboardLock();
      try {
        if (args.workdir && await setClipboardFromIntermediate(page, args.workdir)) {
          console.log('[易车] 使用本地中转文件');
        } else {
          await copyFromFeishu(context, args['doc-url']);
          // 读回剪贴板 HTML 并显式写回，避免偶发剪贴板内容未就绪导致粘贴为空
          const raw = await readClipboardHtml(page);
          if (raw) {
            const cleaned = removeAltBlockFromHtml(raw, loadMainTitle(args.workdir));
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yiche-clip-'));
            const htmlFile = path.join(tmpDir, 'clipboard.html');
            const txtFile = path.join(tmpDir, 'clipboard.txt');
            fs.writeFileSync(htmlFile, cleaned, 'utf8');
            fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
            await setClipboard(page, htmlFile, txtFile);
            console.log('[易车] 剪贴板已重新写入（备选标题已在中转 HTML 删除）');
          }
        }
        // 关闭可能残留的弹窗，确保编辑器可点击
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        await page.locator('.ql-editor').click();
        await page.keyboard.press('Control+V');
        try {
          await waitFor(async () => page.locator('.ql-editor').innerText().then(t => t.length > 2000),
            { timeout: 60000, label: `正文粘贴完成(${pasteAttempt + 1})` });
          pasted = true;
        } catch (e) {
          if (pasteAttempt === 2) throw e;
          console.log(`[易车] 第${pasteAttempt + 1}次粘贴未生效，重试`);
          await page.waitForTimeout(2000);
        }
      } finally {
        releaseClipboardLock();
      }
    }
    console.log('[易车] 正文已粘贴');

    // 备选标题已在中转 HTML 中删除，这里不再做粘贴后删除

    // 3.5 等待全屏“正在转存图片...” loading 消失，避免遮挡封面上传点击
    await waitFor(async () => {
      const n = await page.locator('.el-loading-mask:visible').count();
      return n === 0;
    }, { timeout: 120000, label: '图片转存 loading 消失' });
    await page.waitForTimeout(1000);

    // 4. 横版封面：优先等待自动填充；若未出现则手动上传并完成裁剪模板
    const horizontalCover = page.locator('.article-cover').filter({ hasText: '*封面图' }).first();
    const isHorizontalSet = async () => (await horizontalCover.innerText().catch(() => '')).includes('更换');
    try {
      await waitFor(isHorizontalSet, { timeout: 30000, label: '横版封面自动填充' });
    } catch (e) {
      console.log('[易车] 横版封面未自动填充，手动上传');
      await horizontalCover.locator('.el-upload').first().click();
      await page.waitForTimeout(3000);
      await page.getByRole('button', { name: '完成裁剪' }).first().click();
      await page.waitForTimeout(2000);
      const modal = page.locator('[role=dialog], .el-dialog').filter({ hasText: '封面编辑' }).first();
      const imgs = modal.locator('img');
      if (await imgs.count()) await imgs.first().click();
      await page.waitForTimeout(500);
      await modal.getByRole('button', { name: '确定' }).first().click();
      await page.waitForTimeout(2000);
    }
    await waitFor(isHorizontalSet, { timeout: 30000, label: '横版封面设置确认' });
    console.log('[易车] 横版封面已设置');

    // 6. 内容声明（可选）：含AI生成内容（el-radio 可能被遮挡，用 JS 点击，声明组索引 7）
    await page.evaluate(() => {
      const radios = [...document.querySelectorAll('input[type=radio]')];
      if (radios[7] && !radios[7].checked) radios[7].click();
    });
    await page.waitForTimeout(500);
    console.log('[易车] 声明已处理');

    // 7. 提交 / 存草稿
    if (args.draft) {
      await page.getByText('保存草稿', { exact: true }).first().click();
      await waitFor(async () => {
        const t = await page.evaluate(() => document.body.innerText);
        return page.url().includes('/detailManage') || t.includes('保存成功') || t.includes('草稿');
      }, { timeout: 60000, label: '存草稿成功' });
      console.log('OK: 易车存草稿成功');
    } else {
      await page.getByRole('button', { name: '提交', exact: true }).click();
      await page.waitForTimeout(2000);
      // 若提交后出现确认/提示弹窗，自动点击确定/确认
      for (const name of ['确定', '确认', '确认发布', '知道了', '完成']) {
        const btn = page.locator('[role=dialog]:visible, .el-dialog:visible, .el-message-box:visible').getByRole('button', { name, exact: true }).first();
        if (await btn.count().catch(() => 0)) {
          console.log(`[易车] 提交后点击弹窗按钮: ${name}`);
          await btn.click().catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
      try {
        await waitFor(async () => {
          const t = await page.evaluate(() => document.body.innerText);
          return page.url().includes('/detailManage') || t.includes('提交成功') || t.includes('发布成功');
        }, { timeout: 90000, label: '提交成功' });
      } catch (e) {
        const body = await page.evaluate(() => document.body.innerText).catch(() => '');
        const url = page.url();
        console.log('[易车] 提交失败，当前URL:', url);
        console.log('[易车] 提交失败，页面文本:', body.slice(0, 1000).replace(/\n/g, ' '));
        console.log('[易车] 提交失败，页面尾部:', body.slice(-1200).replace(/\n/g, ' '));
        throw e;
      }
      console.log('OK: 易车发布成功');
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
