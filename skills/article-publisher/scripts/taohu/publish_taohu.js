// 淘江湖发布/前台填充审核脚本
// 用法:
//   node publish_taohu.js --title "标题" --doc-url "飞书URL" --state "登录状态-taohu.json" --review --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/01"
//   node publish_taohu.js --title "标题" --doc-url "飞书URL" --state "登录状态-taohu.json" --publish --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/01" [--board 兴趣经验] [--sub-board 实用经验] [--product-category 家居日用]
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml, setClipboard, removeAltBlockFromHtml, loadMainTitle, setClipboardFromIntermediate, waitFor, mainArgs,
  PUBLISH_WORKSPACE_DIR,
} = require('../common/common.js');

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
  const board = args.board || '兴趣经验';
  const subBoard = args['sub-board'] || '实用经验';
  const productCategory = args['product-category'] || '家居日用';
  const workdir = args.workdir || '';
  const headless = !review && !args.headed;

  // 淘江湖发布限流：每天最多 4 篇，每篇间隔至少 5 分钟
  const STATE_FILE = workdir
    ? path.resolve(workdir, '..', '..', 'taohu_publish_state.json')
    : path.join(PUBLISH_WORKSPACE_DIR, 'taohu_publish_state.json');
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  async function waitTaohuLimit() {
    if (!publish) return;
    let st = { date: '', count: 0, last: 0 };
    if (fs.existsSync(STATE_FILE)) {
      try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { st = { date: '', count: 0, last: 0 }; }
    }
    const today = todayStr();
    if (st.date !== today) st = { date: today, count: 0, last: 0 };
    if ((st.count || 0) >= 4) {
      console.error(`[淘江湖] 今日已达 4 篇上限（${today}），停止发布`);
      process.exit(1);
    }
    const waitMs = 5 * 60 * 1000 - (Date.now() - (st.last || 0));
    if (waitMs > 0) {
      console.log(`[淘江湖] 距上次发布不足5分钟，等待 ${Math.ceil(waitMs / 1000)} 秒`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  function recordTaohuPublish() {
    if (!publish) return;
    const today = todayStr();
    let st = { date: today, count: 0, last: 0 };
    if (fs.existsSync(STATE_FILE)) {
      try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { st = { date: today, count: 0, last: 0 }; }
    }
    if (st.date !== today) st = { date: today, count: 0, last: 0 };
    st.count = (st.count || 0) + 1;
    st.last = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  }

  await waitTaohuLimit();

  const browser = await launch({ headless });
  try {
    const { context, page } = await openPage(browser, args.state);
    await page.goto('https://jianghu.taobao.com/editor.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);
    if ((await page.evaluate(() => document.body.innerText)).includes('亲，请登录')) {
      console.error('未登录淘江湖');
      process.exit(1);
    }

    // 关闭可能出现的“订阅淘宝通知”等弹窗，避免遮挡编辑器
    for (const text of ['取消', '订阅']) {
      const loc = page.getByText(text, { exact: true }).first();
      if (await loc.count().catch(() => 0)) {
        try { await loc.click({ timeout: 2000 }); await page.waitForTimeout(500); } catch (e) {}
      }
    }

    // 1. 标题
    await page.locator('input.editor-title').fill(args.title);
    console.log('[淘江湖] 标题已填:', args.title);

    // 2. 正文（TinyMCE iframe）：优先使用本地中转文件，否则飞书复制 → 中转 HTML 删除备选标题 → 粘贴
    let frame = page.frame({ name: 'bbsEditor_ifr' });
    if (!frame) {
      console.log('[淘江湖] 等待 bbsEditor_ifr 出现...');
      for (let i = 0; i < 30 && !frame; i++) {
        await page.waitForTimeout(1000);
        frame = page.frame({ name: 'bbsEditor_ifr' });
      }
    }
    if (!frame) throw new Error('未找到 bbsEditor_ifr');
    let pasted = false;
    for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
      if (workdir && await setClipboardFromIntermediate(page, workdir)) {
        console.log('[淘江湖] 使用本地中转文件');
      } else {
        await copyFromFeishu(context, args['doc-url']);
        const raw = await readClipboardHtml(page);
        const cleaned = removeAltBlockFromHtml(raw, loadMainTitle(workdir));
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taohu-clip-'));
        const htmlFile = path.join(tmpDir, 'clipboard.html');
        const txtFile = path.join(tmpDir, 'clipboard.txt');
        fs.writeFileSync(htmlFile, cleaned, 'utf8');
        fs.writeFileSync(txtFile, cleaned.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''), 'utf8');
        await setClipboard(page, htmlFile, txtFile);
      }
      await frame.locator('body').click();
      await page.keyboard.press('Control+V');
      try {
        await waitFor(async () => (await frame.locator('body').innerText()).length > 2000,
          { timeout: 60000, label: `正文粘贴完成(${attempt + 1})` });
        pasted = true;
      } catch (e) {
        if (attempt === 2) throw e;
        console.log(`[淘江湖] 第${attempt + 1}次粘贴未生效，重试`);
        await page.waitForTimeout(2000);
      }
    }
    console.log('[淘江湖] 正文已粘贴');

    // 4. 选择发布板块、板块分类、商品分类（必填；审核模式也一并选好，方便直接发布）
    await page.locator('#rc_select_0').click();
    await page.waitForTimeout(1000);
    const option = page.locator('.ant-select-dropdown:visible [class*=ant-select-item-option]', { hasText: board }).first();
    if (!(await option.count())) {
      console.error('未找到板块:', board);
      process.exit(1);
    }
    await option.click();
    await page.waitForTimeout(1200);
    console.log('[淘江湖] 板块已选:', board);

    await page.locator('#rc_select_1').click();
    await page.waitForTimeout(1000);
    const subOption = page.locator('.ant-select-dropdown:visible [class*=ant-select-item-option]', { hasText: subBoard }).first();
    if (!(await subOption.count())) {
      console.error('未找到板块分类:', subBoard);
      process.exit(1);
    }
    await subOption.click();
    await page.waitForTimeout(1200);
    console.log('[淘江湖] 板块分类已选:', subBoard);

    await page.locator('#rc_select_2').click();
    await page.waitForTimeout(1000);
    const catOption = page.locator('.ant-select-dropdown:visible [class*=ant-select-item-option]', { hasText: productCategory }).first();
    if (!(await catOption.count())) {
      console.error('未找到商品分类:', productCategory);
      process.exit(1);
    }
    await catOption.click();
    await page.waitForTimeout(1000);
    console.log('[淘江湖] 商品分类已选:', productCategory);

    // 5. 通过 TinyMCE 图片上传插入本地图片（不用 base64，避免内容过大）
    if (workdir) {
      const articlePath = path.join(workdir, 'article.json');
      if (fs.existsSync(articlePath)) {
        const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
        const images = (article.images || []).map(x => x.file).filter(Boolean);
        const phs = frame.locator('div.image-uploaded.gallery');
        const cnt = await phs.count();
        const injectCount = Math.min(cnt, images.length);
        for (let i = 0; i < injectCount; i++) {
          const file = images[i];
          // 将光标放入第 i 个占位块
          await phs.nth(i).evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            el.scrollIntoView({ block: 'center' });
          });
          await page.waitForTimeout(300);
          page.__articleImage = file;
          await page.locator('button[aria-label="图片"]').first().click();
          await page.waitForTimeout(800);
          const menuitem = page.getByRole('menuitem', { name: '图片上传' }).first();
          if (!(await menuitem.count())) {
            console.error('未找到图片上传菜单项');
            process.exit(1);
          }
          await menuitem.click();
          // 等待该占位块内出现 img
          await waitFor(async () => (await phs.nth(i).locator('img').count()) > 0,
            { timeout: 30000, label: `图片${i+1}上传插入` });
          console.log(`[淘江湖] 图片${i+1}已上传插入`);
        }
        console.log(`[淘江湖] 已插入 ${injectCount} 张图片`);
      } else {
        console.log('[淘江湖] 未找到 article.json，跳过图片插入');
      }
    }

    // 同步 TinyMCE 内容到隐藏 textarea，确保发布时可读取
    await page.evaluate(() => {
      if (window.tinymce && tinymce.get('bbsEditor')) {
        tinymce.get('bbsEditor').save();
      }
    });

    if (review) {
      console.log('[淘江湖] 已在前台填充完毕，请审核。确认后可在浏览器手动发布，或告诉我继续自动发布。');
      await new Promise(() => {});
    }

    if (publish) {
      // 5. 立即发布
      await page.getByText('立即发布', { exact: true }).first().click();
      let ok = false;
      try {
        ok = await waitFor(async () => {
          const t = await page.evaluate(() => document.body.innerText);
          return t.includes('发布成功') || page.url().includes('/person/myPost') || page.url().includes('/detail/');
        }, { timeout: 15000, label: '淘江湖发布成功' });
      } catch (e) {
        const t = await page.evaluate(() => document.body.innerText);
        if (t.includes('失败') || t.includes('请选择') || t.includes('不能为空')) {
          throw new Error('淘江湖发布校验失败: ' + t.slice(-200));
        }
        ok = true;
        console.log('[淘江湖] 未检测到明确成功标志，按已提交处理（稍后在“我的发帖”确认）');
      }
      recordTaohuPublish();
      console.log('OK: 淘江湖发布成功:', args.title);
    }
  } finally {
    if (!args.review) await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
