// 东方财富财富号长文发布脚本
// 用法:
//   node publish_eastmoney.js --title "标题" --doc-url "腾讯文档URL" --state "登录状态-eastmoney.json" --image 图片路径 --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/td_publish/01" --publish
//   node publish_eastmoney.js --title "标题" --doc-url "腾讯文档URL" --state "登录状态-eastmoney.json" --image 图片路径 --workdir ... --draft
const fs = require('fs');
const path = require('path');
const {
  launch, openPage, setClipboard, setClipboardFromIntermediate, waitFor, mainArgs,
} = require('../common/common.js');

const PUBLISH_URL = 'https://mp.eastmoney.com/collect/pc_article/index.html#/';

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

async function insertEastmoneyImages(page, workdir) {
  const articlePath = path.join(workdir, 'article.json');
  if (!fs.existsSync(articlePath)) return;
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const blocks = article.body_blocks || [];
  const imageFiles = (article.images || []).map(x => x.file).filter(Boolean);
  const editor = page.locator('.ProseMirror.cfh_editor_area');
  let imgIdx = 0;
  let inserted = 0;
  let lastText = '';
  for (let i = 0; i < blocks.length && imgIdx < imageFiles.length; i++) {
    const b = blocks[i];
    if (b.type === 'image') {
      if (imgIdx >= 1) {
        console.warn(`[东方财富] 为稳定性仅插入第1张图片，跳过后续图片: ${imageFiles[imgIdx]}`);
        imgIdx++;
        continue;
      }
      if (!lastText) { imgIdx++; continue; }
      const imageFile = imageFiles[imgIdx];
      if (imageFile && fs.statSync(imageFile).size > 5 * 1024 * 1024) {
        console.warn(`[东方财富] 图片${imgIdx + 1}超过5MB，跳过:`, imageFile);
        imgIdx++;
        continue;
      }
      const prefix = lastText.trim().slice(0, 20);
      const paras = editor.locator('p');
      const count = await paras.count();
      let targetIdx = -1;
      for (let j = 0; j < count; j++) {
        const text = (await paras.nth(j).innerText().catch(() => '')).trim();
        if (text.includes(prefix)) { targetIdx = j; break; }
      }
      if (targetIdx === -1) {
        console.warn('[东方财富] 未找到图片前文段落:', prefix);
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
      // 关闭可能残留的弹窗
      const oldCancel = page.locator('.dialog_content:visible .btn_cancel').filter({ hasText: '取消' }).first();
      if (await oldCancel.isVisible().catch(() => false)) {
        await oldCancel.click();
        await page.waitForTimeout(500);
      }
      // 打开图片上传弹窗
      await page.locator('button.em_icon_image').first().click();
      await page.waitForTimeout(1500);
      const dialog = page.locator('.dialog_content:visible').filter({ hasText: '上传图片' }).first();
      await dialog.waitFor({ timeout: 10000 }).catch(() => {});
      const fileInput = dialog.locator('input[type=file]').first();
      if (!(await fileInput.count())) throw new Error('东方财富图片上传弹窗未找到文件输入');
      await fileInput.setInputFiles(imageFile);
      // 等待图片上传完成（弹窗出现“已上传 N 张图片”）后再点“插入”
      // 注意：必须点当前“上传图片”标签页里的“插入”，避免命中隐藏标签页的相同按钮
      const insertBtn = page.getByLabel('上传图片').getByText('插入', { exact: true }).first();
      await waitFor(async () => {
        const text = await dialog.innerText().catch(() => '');
        return text.includes('已上传') && await insertBtn.isVisible().catch(() => false);
      }, { timeout: 60000, label: `东方财富图片${imgIdx + 1}上传` });
      await page.waitForTimeout(1000);
      await insertBtn.click();
      await waitFor(async () => (await editor.locator('img').count()) > inserted,
        { timeout: 90000, label: `东方财富图片${imgIdx + 1}插入` });
      // 插入后关闭可能残留的弹窗
      const cancelBtn = page.locator('.dialog_content:visible .btn_cancel').filter({ hasText: '取消' }).first();
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
        await page.waitForTimeout(500);
      }
      console.log(`[东方财富] 图片${imgIdx + 1}已插入`);
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
  console.log(`[东方财富] 正文图片插入完成，共 ${inserted} 张`);
}

async function uploadEastmoneyCover(page, image, workdir) {
  // 若封面超过5MB，从 workdir 中选一张 <=5MB 的图片作为封面
  if (image && fs.existsSync(image) && fs.statSync(image).size > 5 * 1024 * 1024 && workdir) {
    const candidates = (fs.readdirSync(workdir) || [])
      .filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .map(f => path.join(workdir, f))
      .filter(f => fs.statSync(f).size <= 5 * 1024 * 1024)
      .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
    if (candidates.length) {
      console.warn(`[东方财富] 封面超过5MB，改用: ${candidates[0]}`);
      image = candidates[0];
    }
  }
  const cover = page.locator('.select-cover-img').first();
  await cover.click();
  await page.waitForTimeout(1500);
  // 切到“上传图片”标签页
  const uploadTab = page.locator('#tab-upload').first();
  await uploadTab.click().catch(() => {});
  await page.waitForTimeout(500);
  const input = page.locator('#upload_input').first();
  if (!(await input.count())) throw new Error('东方财富封面上传未找到文件输入');
  await input.setInputFiles(image);
  // 上传成功后弹窗关闭，封面区域出现“编辑/替换”
  await waitFor(async () => {
    const t = await page.locator('.cover_container').innerText().catch(() => '');
    return t.includes('编辑') && t.includes('替换');
  }, { timeout: 60000, label: '东方财富封面上传' });
  console.log('[东方财富] 封面已上传');
}

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state || !args.image) {
    console.error('缺少参数: --title / --doc-url / --state / --image 必填');
    process.exit(1);
  }
  const draft = !!args.draft;
  const publish = !!args.publish;
  if (!draft && !publish) {
    console.error('请指定 --publish 或 --draft');
    process.exit(1);
  }
  const workdir = args.workdir || '';
  const browser = await launch({ headless: !args.headed });
  try {
    const { context, page } = await openPage(browser, args.state);
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    if (!(await page.locator('#publishWrapper, .publish_wrapper').count())) {
      console.error('未进入东方财富发布页，可能未登录:', page.url());
      process.exit(1);
    }

    // 清理可能存在的旧草稿内容
    const editor = page.locator('.ProseMirror.cfh_editor_area');
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    // 1. 标题
    await page.locator('input[placeholder="标题(1-64字)"]').fill(args.title);
    console.log('[东方财富] 标题已填:', args.title);

    // 2. 正文：使用本地中转 HTML（富文本），不用纯文本；再按位置插入本地图片
    const localReady = workdir && await setClipboardFromIntermediate(page, workdir);
    if (!localReady) {
      throw new Error('缺少本地中转 HTML 文件，请先运行 extract_tencent_docs.py 生成 workdir');
    }
    console.log('[东方财富] 使用本地中转 HTML 富文本');
    let pasted = false;
    for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
      await editor.click();
      await page.keyboard.press('Control+V');
      try {
        await waitFor(async () => (await editor.innerText()).length > 500,
          { timeout: 60000, label: `正文粘贴完成(${attempt + 1})` });
        pasted = true;
      } catch (e) {
        if (attempt === 2) throw e;
        console.log(`[东方财富] 第${attempt + 1}次粘贴未生效，重试`);
        await page.waitForTimeout(2000);
      }
    }
    console.log('[东方财富] 正文已粘贴（富文本）');
    // 按用户要求：东方财富不插入正文图片（平台限制导致图片不显示），仅保留封面
    console.log('[东方财富] 按用户要求不插入正文图片，仅上传封面');

    // 3. 封面
    await uploadEastmoneyCover(page, args.image, workdir);

    // 4. 信息来源：选择 AI生成
    await page.locator('.el-radio__label', { hasText: 'AI生成' }).first().click();
    await page.waitForTimeout(300);
    console.log('[东方财富] 信息来源已选 AI生成');

    if (draft) {
      // 东方财富草稿自动保存；这里点击“保存并预览”会进入预览，不适合自动草稿。
      // 直接等待自动保存后退出（发布页会自动保存草稿）。
      await page.waitForTimeout(5000);
      console.log('[东方财富] 草稿已自动保存（未发布）:', args.title);
    }

    if (publish) {
      // 勾选“已阅读并同意发文规范/社区管理规定”
      const agreeIcon = page.locator('footer.read_item i.check-icon').first();
      if (await agreeIcon.count().catch(() => 0)) {
        const iconCls = await agreeIcon.getAttribute('class').catch(() => '');
        if (!iconCls.split(/\s+/).includes('on')) {
          await agreeIcon.click();
          await page.waitForTimeout(500);
        }
      }
      await page.locator('.button_publish').first().click();
      await page.waitForTimeout(2000);
      // 若出现确认发布弹窗，点击确认
      const confirmBtn = page.getByRole('button', { name: '确认发布' }).first();
      if (await confirmBtn.count().catch(() => 0)) {
        await confirmBtn.click();
      } else {
        const confirmDiv = page.locator('.dialog_content .btn_confirm, .dialog_content [class*=confirm]').filter({ hasText: '确认' }).first();
        if (await confirmDiv.count().catch(() => 0)) {
          await confirmDiv.click();
        }
      }
      await waitFor(async () => {
        const t = await page.evaluate(() => document.body.innerText);
        return t.includes('发布文章成功') || t.includes('发布成功') || t.includes('提交成功') || page.url().includes('/content') || page.url().includes('manage');
      }, { timeout: 60000, label: '东方财富发布成功' });
      // 关闭成功提示，返回主页
      const homeBtn = page.locator('.dialog_content .dialog_btn_cancel, .dialog_content [class*=cancel]').filter({ hasText: '返回主页' }).first();
      if (await homeBtn.isVisible().catch(() => false)) {
        await homeBtn.click();
        await page.waitForTimeout(500);
      }
      console.log('OK: 东方财富发布成功:', args.title);
    }
  } finally {
    if (!args.review) await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
