// 懂车号发布脚本
// 用法: node publish_dongchedi.js --title "标题" --doc-url "飞书文档URL" --state "登录状态.json" [--image 文章图片] [--headed]
// 流程: 打开发布页 → 填标题 → 飞书复制粘贴 → 删备选标题块 → 等平台自动生成双封面 → 发布 → 验证
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, dragDelete, waitFor, mainArgs,
  waitForImagesUploaded, acquireClipboardLock, releaseClipboardLock,
} = require('../common/common.js');

const PUBLISH_URL = 'https://mp.dcdapp.com/profile_v2/publish/article';
const SUCCESS_URL = 'https://mp.dcdapp.com/profile_v2/manage/content/article';

// 把正文里的 <img> 换成【图N】占位符。
// 懂车帝编辑器对「粘贴进来的 data: 内嵌图」转存到 CDN 是异步且经常失败的；
// 失败后正文图缺失，平台也就无法据此自动生成封面。改为先贴占位符文本，
// 再用编辑器自带的图片上传功能逐张插入本地图，链路稳定得多。
function toPlaceholderHtml(html) {
  let n = 0;
  return html.replace(/<img\b[^>]*>/gi, () => `【图${++n}】`);
}

// 用 DOM Range 选中编辑器里的【图N】占位符文本（ProseMirror 会跟随 DOM selection）
async function selectPlaceholder(page, label) {
  return page.evaluate((lb) => {
    const ed = document.querySelector('.ProseMirror');
    if (!ed) return false;
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = (node.textContent || '').indexOf(lb);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + lb.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        if (node.parentElement) node.parentElement.scrollIntoView({ block: 'center' });
        return true;
      }
    }
    return false;
  }, label);
}

// 用编辑器工具栏的图片工具插入一张本地图（替换掉对应的【图N】占位符）
// 关键点：setInputFiles 只完成"上传"，还要在抽屉底部点「确定」才会真正插入正文。
async function insertImageByEditor(page, imagePath, label) {
  // 1) 选中并删除占位符，把光标留在该段落上
  if (!await selectPlaceholder(page, label)) {
    console.log(`[懂车号] 未找到占位符 ${label}，跳过`);
    return false;
  }
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);

  // 2) 打开图片抽屉 → 切到「上传图片」→ 选本地文件
  await page.locator('.syl-toolbar-tool.image').first().click({ timeout: 15000 });
  await page.waitForTimeout(3000);
  const tab = page.getByText('上传图片', { exact: true }).first();
  if (await tab.count().catch(() => 0)) {
    await tab.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  page.__articleImage = imagePath; // filechooser 全局兜底也用这个路径
  const fileInput = page.locator('input[type=file]').first();
  if (await fileInput.count().catch(() => 0)) {
    await fileInput.setInputFiles(imagePath, { timeout: 30000 });
  } else {
    await page.getByText(/点击上传|选择文件|上传图片/).first().click({ timeout: 8000 }).catch(() => {});
  }

  // 3) 等上传完成，再点「确定」把它插入正文（缺这一步占位符不会被替换）
  let uploaded = false;
  try {
    await waitFor(async () => page.getByText(/上传完成/).first().isVisible().catch(() => false),
      { timeout: 90000, interval: 2000, label: `${label} 上传完成` });
    uploaded = true;
  } catch (e) {
    console.log(`[懂车号] ${label} 未等到"上传完成"，仍尝试点确定`);
  }
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '确定', exact: true }).first()
    .click({ timeout: 15000 })
    .catch(async () => {
      // 抽屉底部按钮可能是非 button 元素
      await page.locator('.arco-drawer button, .arco-drawer [role=button]')
        .filter({ hasText: '确定' }).first().click({ timeout: 10000 }).catch(() => {});
    });
  await page.waitForTimeout(4000);

  // 4) 确认占位符已消失、正文出现图片
  const gone = !await selectPlaceholder(page, label);
  const imgCnt = await page.locator('.ProseMirror img').count().catch(() => 0);
  console.log(`[懂车号] ${label} 插入完成=${gone}（上传完成=${uploaded}，正文图片数=${imgCnt}）`);
  // 抽屉若仍开着，点关闭，避免遮挡后续操作
  await page.locator('.arco-drawer-close-icon').first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return gone;
}

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state) {
    console.error('缺少参数: --title / --doc-url / --state 必填');
    process.exit(1);
  }

  // 懂车帝不支持富文本表格：如果本地中转 HTML 里还残留 <table>，直接提示先转表格图片版。
  if (args.workdir) {
    const htmlPath = path.join(args.workdir, '正文_clean.html');
    if (fs.existsSync(htmlPath) && /<table[\s>]/i.test(fs.readFileSync(htmlPath, 'utf8'))) {
      console.error('检测到正文包含 <table>，懂车帝不支持富文本表格。请先运行:');
      console.error('  node scripts/common/table_to_image.js --workdir "<workdir>"');
      console.error('然后把 --workdir 指向生成的 <编号>_tableimg 目录后重试。');
      process.exit(1);
    }
  }

  const browser = await launch({ headless: !args.headed });
  try {
    const { context, page } = await openPage(browser, args.state);
    page.__articleImage = args.image;
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // 未登录会跳转登录页，直接报错让用户先登录
    if (page.url().includes('/login')) {
      console.error('未登录懂车号，请先手动登录并 state-save 后再运行');
      process.exit(1);
    }

    // 1. 标题
    await page.locator('[placeholder*="请输入文章标题"]').fill(args.title);
    console.log('[懂车号] 标题已填:', args.title);

    // 2. 正文：贴「占位符版」HTML（图片换成【图N】），图片随后用编辑器自带上传功能插入。
    //    剪贴板是跨平台共享资源，并发发布时用锁把「写剪贴板 → 粘贴 → 确认」串行化。
    let pasted = false;
    for (let pasteAttempt = 0; pasteAttempt < 3 && !pasted; pasteAttempt++) {
      await acquireClipboardLock();
      try {
        const srcHtml = args.workdir ? path.join(args.workdir, '正文_clean.html') : null;
        if (srcHtml && fs.existsSync(srcHtml)) {
          const ph = toPlaceholderHtml(fs.readFileSync(srcHtml, 'utf8'));
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-ph-'));
          const htmlFile = path.join(tmpDir, 'clipboard.html');
          const txtFile = path.join(tmpDir, 'clipboard.txt');
          fs.writeFileSync(htmlFile, ph, 'utf8');
          fs.writeFileSync(txtFile, ph.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
          await setClipboard(page, htmlFile, txtFile);
          console.log('[懂车号] 使用本地中转文件（图片转为【图N】占位符）');
        } else {
          await copyFromFeishu(context, args['doc-url']);
          const raw = await readClipboardHtml(page);
          const cleaned = toPlaceholderHtml(removeAltBlockFromHtml(raw, loadMainTitle(args.workdir)));
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-clip-'));
          const htmlFile = path.join(tmpDir, 'clipboard.html');
          const txtFile = path.join(tmpDir, 'clipboard.txt');
          fs.writeFileSync(htmlFile, cleaned, 'utf8');
          fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
          await setClipboard(page, htmlFile, txtFile);
        }
        await page.locator('.ProseMirror').click();
        await page.keyboard.press('Control+V');
        try {
          await waitFor(async () => page.locator('.ProseMirror').innerText().then(t => t.length > 2000),
            { timeout: 60000, label: `正文粘贴完成(${pasteAttempt + 1})` });
          pasted = true;
        } catch (e) {
          if (pasteAttempt === 2) throw e;
          console.log(`[懂车号] 第${pasteAttempt + 1}次粘贴未生效，重试`);
          await page.waitForTimeout(2000);
        }
      } finally {
        releaseClipboardLock();
      }
    }
    console.log('[懂车号] 正文已粘贴');

    // 3. 图片：用编辑器自带的图片上传功能逐张插入本地图（替换【图N】占位符）。
    //    不走「平台自动转存 data: 内嵌图」——那条路异步且实测会失败，失败后
    //    正文缺图，平台也就无法自动生成封面。
    const localImages = [];
    if (args.workdir) {
      const aj = path.join(args.workdir, 'article.json');
      if (fs.existsSync(aj)) {
        try {
          const art = JSON.parse(fs.readFileSync(aj, 'utf8'));
          for (const im of (art.images || [])) {
            const f = im.file || '';
            // 只保留实际存在的本地文件（跳过飞书图床 token 之类无本地文件的项）
            if (f && fs.existsSync(f)) localImages.push(f);
          }
        } catch (e) { console.log('[懂车号] 读取 article.json 失败:', e.message); }
      }
      if (!localImages.length && args.image && fs.existsSync(args.image)) localImages.push(args.image);
    }
    console.log(`[懂车号] 待插入本地图片 ${localImages.length} 张: ${localImages.map(f => path.basename(f)).join(', ')}`);
    for (let i = 0; i < localImages.length; i++) {
      await insertImageByEditor(page, localImages[i], `【图${i + 1}】`);
    }

    // 校验：正文里不应再残留占位符（残留说明图片没插进去，宁可不发也不要发半成品）
    const leftover = await page.locator('.ProseMirror').innerText().then(t => (t.match(/【图\d+】/g) || []));
    if (leftover.length) {
      console.error(`[懂车号] 仍有占位符未替换: ${leftover.join(',')}，中止发布避免发出缺图文章`);
      process.exit(1);
    }
    await waitForImagesUploaded(page, {
      selector: '.ProseMirror img', timeout: 180000, label: '正文图片就绪',
    }).catch(e => console.log('[懂车号] 正文图片校验未通过（继续尝试发布）:', e.message));
    console.log('[懂车号] 正文图片已就绪');

    // 4. 等平台自动把正文图设为封面。
    // ⚠️ 实测自动封面不稳定：部分文章封面槽一直停在「上传封面」占位文案，
    //    正文图也可能长时间停在 data: 没被转存（平台侧转存是异步且会失败）。
    //    因此这里先等自动封面，超时就改用**编辑器自带的封面上传**兜底：
    //    点击「上传封面」槽 → 触发文件选择器 → 由 openPage 的全局 filechooser
    //    兜底自动填入 --image 指定的本地图片。
    const coverReady = async () => page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').trim() === '发布');
      const emptySlots = (document.body.innerText.match(/上传封面/g) || []).length;
      return { enabled: !!btn && !btn.disabled, emptySlots };
    });

    let ready = false;
    try {
      await waitFor(async () => {
        const st = await coverReady();
        return st.enabled && st.emptySlots === 0;
      }, { timeout: 90000, interval: 3000, label: '封面自动生成' });
      ready = true;
      console.log('[懂车号] 双封面已自动生成');
    } catch (e) {
      console.log('[懂车号] 自动封面未就绪，改用编辑器封面上传兜底（本地上传）');
    }

    if (!ready) {
      for (let round = 0; round < 3; round++) {
        const st = await coverReady();
        if (st.emptySlots === 0) break;
        console.log(`[懂车号] 第${round + 1}轮封面上传兜底，剩余空封面槽 ${st.emptySlots}`);
        const slots = page.getByText('上传封面', { exact: true });
        const n = await slots.count();
        for (let i = 0; i < n; i++) {
          await slots.nth(i).click({ force: true, timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(6000);
        }
        await page.waitForTimeout(8000);
      }
      const st = await coverReady();
      console.log(`[懂车号] 封面上传兜底结束：空槽 ${st.emptySlots}，发布按钮可用=${st.enabled}`);
    }

    // 发布前最后确认：发布按钮可用（封面槽可能仍显示占位文案，但按钮可用即可提交）
    await waitFor(async () => (await coverReady()).enabled,
      { timeout: 120000, interval: 3000, label: '发布按钮可用' });

    // 5. 发布（带重试：偶尔点完不跳转）
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      await page.getByRole('button', { name: '发布', exact: true }).click({ timeout: 30000 }).catch(async (e) => {
        console.log(`[懂车号] 第${i + 1}次点击发布异常(${String(e.message).split('\n')[0]})，改用力点击重试`);
        await page.getByRole('button', { name: '发布', exact: true }).click({ force: true, timeout: 15000 }).catch(() => {});
      });
      await page.waitForTimeout(8000);
      ok = page.url().includes('/manage/content/article');
      if (!ok) { console.log(`[懂车号] 第${i + 1}次发布未跳转，等待后重试`); await page.waitForTimeout(20000); }
    }
    // 注意：即使这里没跳转成功，文章也可能已经提交（实测文章5 就是脚本报失败但实际已发布）。
    // 因此不直接判失败，改为回到作品管理页按标题+日期核实。
    if (ok) console.log('[懂车号] 已发布，跳转到作品管理页');
    else console.log('[懂车号] 未观察到跳转，回作品管理页核实是否已提交');

    // 6. 验证：作品管理列表按「标题 + 当天日期」确认文章存在（避免同名旧文章）
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    if (!page.url().includes('/manage/content/article')) {
      await page.goto(SUCCESS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(6000);
    }
    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      found = await page.evaluate(({ title, dateStr }) => {
        const txt = document.body.innerText || '';
        return txt.includes(title) && txt.includes(dateStr);
      }, { title: args.title, dateStr }).catch(() => false);
      if (!found) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(4000); }
    }
    if (found) {
      console.log(`OK: 懂车号已确认发布成功（列表存在「${args.title}」${dateStr}）`);
    } else {
      console.error(`发布失败：作品管理列表未找到「${args.title}」${dateStr}`);
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
