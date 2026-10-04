// 企鹅号文章发布脚本
// 注意：企鹅号每日限发 5 篇文章，批量发布时需自行控制数量，超过配额会失败/触发风控。
// 用法:
//   node scripts/qiehao/publish_qiehao.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-qiehao.json" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" [--headed] [--draft]
// 说明:
//   - 发布页: https://om.qq.com/main/creation/article
//   - 内容管理: https://om.qq.com/main/management/articleManage
//   - 标题为 contenteditable span（#omEditorTitle 内，5~64 字）
//   - 正文为 ProseMirror（div.ProseMirror[contenteditable=true]）
//   - 封面/分类/标签均为“选填”，脚本不填；自主声明选择“该文章由AI生成”
//   - 正文优先使用去掉图片块后的本地中转 HTML 直接写入 ProseMirror，再按 article.json 位置逐张本地上传图片
//   - 正文含图片时，存草稿需要：第一次存草稿 → AI生成声明弹窗点提交 → 再点一次存草稿
const fs = require('fs');
const path = require('path');
const {
  launch, openPage, copyFromFeishu, readClipboardHtml,
  removeAltBlockFromHtml, loadMainTitle, waitFor, mainArgs,
} = require('../common/common.js');

const PUBLISH_URL = 'https://om.qq.com/main/creation/article';
const MANAGE_URL = 'https://om.qq.com/main/management/articleManage';
const TITLE_SELECTOR = '#omEditorTitle span[data-placeholder="请输入标题（5-64个字）"]';
const EDITOR_SELECTOR = 'div.ProseMirror[contenteditable="true"]';
const IMG_BUTTON = '[data-toolbar-item-of="imagePlugin"]';

function stripImageBlocksFromHtml(html) {
  let result = html;
  let prev;
  do {
    prev = result;
    result = result.replace(/<div\b[^>]*data-type="image"[^>]*>[\s\S]*?<\/div>/gi, '');
  } while (result !== prev);
  result = result.replace(/<img\b[^>]*>/gi, '');
  // 清理可能残留的空图片包装/空段落（保留正文结构）
  result = result.replace(/<p>\s*<\/p>/gi, '');
  return result;
}

// 去掉飞书剪贴板的外层根容器，只保留里面的正文块，便于粘贴进 ProseMirror 空编辑器。
function unwrapFeishuRoot(html) {
  const m = html.match(/^<div\b[^>]*(?:data-page-id=|data-lark-html-role="root")[^>]*>([\s\S]*)<\/div>\s*$/i);
  return m ? m[1] : html;
}

function createNoImgIntermediate(workdir) {
  const src = path.join(workdir, '正文_clean.html');
  if (!fs.existsSync(src)) return null;
  const html = unwrapFeishuRoot(stripImageBlocksFromHtml(fs.readFileSync(src, 'utf8')));
  const txt = html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '');
  const htmlFile = path.join(workdir, 'clipboard_qq_noimg.html');
  const txtFile = path.join(workdir, 'clipboard_qq_noimg.txt');
  fs.writeFileSync(htmlFile, html, 'utf8');
  fs.writeFileSync(txtFile, txt, 'utf8');
  return [htmlFile, txtFile];
}

// 企鹅号发布页会载入上次“自动保存”的内容，正式填稿前必须清空标题和正文，避免混入旧内容。
async function clearQqEditor(page) {
  const titleSpan = page.locator(TITLE_SELECTOR).first();
  const editor = page.locator(EDITOR_SELECTOR);
  await titleSpan.evaluate((el) => {
    el.focus();
    el.innerHTML = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  await editor.evaluate((el) => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  await page.waitForTimeout(800);
  console.log('[企鹅号] 已清空上次自动保存的标题/正文');
}

// 标题是 contenteditable span，直接 innerHTML + execCommand + input/change 事件确保组件状态真正写入。
async function fillQqTitle(page, title) {
  const titleSpan = page.locator(TITLE_SELECTOR).first();
  await titleSpan.evaluate((el, text) => {
    el.focus();
    el.innerHTML = '';
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, title);
  await page.waitForTimeout(600);
  const current = (await titleSpan.innerText().catch(() => '')).trim();
  if (!current.includes(title)) {
    // 兜底：execCommand 未生效时用键盘输入
    await titleSpan.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(title);
    await page.waitForTimeout(500);
  }
  console.log('[企鹅号] 标题已填:', current || title);
}

async function clickSaveDraft(page) {
  await page.getByRole('button', { name: '存草稿', exact: true }).first().click();
  await page.waitForTimeout(1500);
}

async function waitForSaveSuccess(page) {
  await waitFor(async () => {
    const text = await page.locator('body').innerText().catch(() => '');
    return text.includes('保存成功');
  }, { timeout: 30000, label: '企鹅号草稿保存成功' });
  console.log('[企鹅号] 草稿保存成功');
}

async function pasteBody(page, context, workdir, docUrl) {
  const editor = page.locator(EDITOR_SELECTOR);
  // 确保正文为空，避免上一次自动保存内容残留（用选区删除，保留 ProseMirror 空段落）
  await editor.evaluate((el) => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  await page.waitForTimeout(500);

  let html = '';
  let sourceDesc = '';
  const local = workdir ? createNoImgIntermediate(workdir) : null;
  if (local) {
    html = fs.readFileSync(local[0], 'utf8');
    sourceDesc = '本地无图 HTML';
  } else {
    await copyFromFeishu(context, docUrl);
    const raw = await readClipboardHtml(page);
    html = removeAltBlockFromHtml(raw, loadMainTitle(workdir));
    html = unwrapFeishuRoot(stripImageBlocksFromHtml(html));
    sourceDesc = '飞书复制 HTML（无图）';
  }

  let pasted = false;
  for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
    // 企鹅号 ProseMirror 可直接写入 innerHTML（Postbot 同款方式），比剪贴板粘贴更稳定
    await editor.evaluate((el, content) => {
      el.focus();
      el.innerHTML = content;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, html);
    try {
      await waitFor(async () => (await editor.innerText()).trim().length > 5,
        { timeout: 60000, label: `企鹅号正文写入完成(${attempt + 1})` });
      pasted = true;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log(`[企鹅号] 第${attempt + 1}次正文写入未生效，重试`);
      await page.waitForTimeout(2000);
    }
  }
  console.log(`[企鹅号] 正文已写入（${sourceDesc}）`);
}

async function setAiDeclaration(page) {
  let addBtn = page.getByRole('button', { name: '添加内容自主声明' }).first();
  for (let attempt = 0; attempt < 3 && !(await addBtn.count()); attempt++) {
    console.log(`[企鹅号] 自主声明入口未出现，等待重试(${attempt + 1})`);
    await page.waitForTimeout(2000);
  }
  if (!(await addBtn.count())) {
    console.warn('[企鹅号] 未找到自主声明入口，跳过；若保存草稿时提示“请选择自主声明”需人工处理');
    return;
  }
  await addBtn.click();
  await page.waitForTimeout(1200);
  const dialog = page.locator('.omui-dialog-wrapper.open').first();
  const aiOption = dialog.locator('label.omui-radio').filter({ hasText: '该文章由AI生成' }).first();
  if (await aiOption.count()) {
    await aiOption.click();
    await page.waitForTimeout(300);
  } else {
    console.warn('[企鹅号] 自主声明弹窗未找到“该文章由AI生成”，取消弹窗');
    await dialog.getByRole('button', { name: '取消' }).first().click().catch(() => {});
    return;
  }
  await dialog.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(800);
  console.log('[企鹅号] 已选择“该文章由AI生成”');
}

async function placeCursorAtEndOfParagraph(page, editor, needle) {
  const para = editor.locator('p, h2').filter({ hasText: needle }).last();
  if (!(await para.count())) return false;
  await para.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.scrollIntoView({ block: 'center' });
  });
  return true;
}

async function uploadOneQqImage(page, editor, imageFile) {
  await page.locator(IMG_BUTTON).first().click();
  await page.waitForTimeout(800);
  const fileInput = page.locator('.omui-dialog-wrapper.open input[type=file]').first();
  if (!(await fileInput.count())) {
    throw new Error('企鹅号正文图片弹窗未出现 file input');
  }
  await fileInput.setInputFiles(imageFile);
  // 等待上传完成：确认按钮从禁用变为可用
  await waitFor(async () => {
    const btn = page.locator('.omui-dialog-wrapper.open button').filter({ hasText: '确认' }).first();
    if (!(await btn.count())) return false;
    return btn.isEnabled().catch(() => false);
  }, { timeout: 120000, label: `企鹅号图片上传 ${path.basename(imageFile)}` });
  const beforeCount = await editor.locator('img.index_module_img__cffb2914').count();
  await page.locator('.omui-dialog-wrapper.open button').filter({ hasText: '确认' }).first().click();
  await waitFor(async () => (await editor.locator('img.index_module_img__cffb2914').count()) > beforeCount,
    { timeout: 60000, label: `企鹅号图片插入 ${path.basename(imageFile)}` });
  // 若弹窗没有自动关闭，点取消收尾
  const cancelBtn = page.locator('.omui-dialog-wrapper.open button').filter({ hasText: '取消' }).first();
  if (await cancelBtn.count()) {
    await cancelBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function insertQqImages(page, workdir) {
  const articlePath = path.join(workdir, 'article.json');
  if (!fs.existsSync(articlePath)) return 0;
  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
  const blocks = article.body_blocks || [];
  const imageFiles = (article.images || []).map(x => x.file).filter(Boolean);
  const editor = page.locator(EDITOR_SELECTOR);
  let imgIdx = 0;
  let lastText = '';
  let inserted = 0;
  for (let i = 0; i < blocks.length && imgIdx < imageFiles.length; i++) {
    const b = blocks[i];
    if (b.type === 'image') {
      if (!lastText) {
        console.warn(`[企鹅号] 图片${imgIdx + 1}前没有可用文本段落，跳过`);
        imgIdx++;
        continue;
      }
      const needle = lastText.trim().slice(0, 30) || lastText.trim().slice(-30);
      const placed = await placeCursorAtEndOfParagraph(page, editor, needle);
      if (!placed) {
        console.warn(`[企鹅号] 未找到图片${imgIdx + 1}前文段落，跳过:`, needle);
        imgIdx++;
        continue;
      }
      await page.waitForTimeout(300);
      await uploadOneQqImage(page, editor, imageFiles[imgIdx]);
      console.log(`[企鹅号] 图片${imgIdx + 1}已插入:`, imageFiles[imgIdx]);
      inserted++;
      imgIdx++;
    } else if (b.type === 'table') {
      const rows = b.rows || [];
      lastText = rows.map(r => r.join(' ')).join(' ');
    } else {
      const t = (b.text || '').trim();
      if (t) lastText = t;
    }
  }
  console.log(`[企鹅号] 正文图片插入完成，共 ${inserted} 张`);
  return inserted;
}

// 正文包含图片时，点击“存草稿”或“发布”后企鹅号会弹出“AI生成声明”：
// 要求确认素材是否由 AI 生成。按用户要求：不勾选具体素材，直接点击弹窗的“提交”继续。
async function handleAiMaterialDialog(page) {
  for (let i = 0; i < 5; i++) {
    const dialog = page.locator('.omui-dialog-wrapper.open').filter({ hasText: 'AI生成声明' }).first();
    if (!(await dialog.count())) return false;
    const submitBtn = dialog.getByRole('button', { name: '提交', exact: true }).first();
    if (!(await submitBtn.count())) return false;
    console.log('[企鹅号] 检测到 AI生成声明弹窗，点击提交继续');
    await submitBtn.click();
    await page.waitForTimeout(1500);
    // 弹窗关闭则结束；若还有新的同类弹窗则继续处理
  }
  return true;
}

(async () => {
  const args = mainArgs();
  if (!args.title || !args['doc-url'] || !args.state) {
    console.error('缺少参数: --title / --doc-url / --state 必填');
    process.exit(1);
  }
  const draft = !!args.draft;
  const browser = await launch({ headless: !args.headed });
  try {
    const { context, page } = await openPage(browser, args.state);
    page.__articleImage = args.image; // 保留给 filechooser 兜底（本脚本以显式 setInputFiles 为主）
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    if (page.url().includes('/userAuth')) {
      console.error('未登录企鹅号，请先运行登录脚本保存 state 后再执行');
      process.exit(1);
    }

    // 0. 清空上次自动保存的标题/正文，再正式填稿
    await clearQqEditor(page);

    // 1. 标题（contenteditable span，使用 execCommand + input 事件确保组件状态真正写入）
    await page.locator(TITLE_SELECTOR).first().waitFor({ timeout: 20000 });
    await fillQqTitle(page, args.title);

    // 2. 正文
    await page.locator(EDITOR_SELECTOR).waitFor({ timeout: 20000 });
    await pasteBody(page, context, args.workdir, args['doc-url']);

    // 3. 正文图片按 article.json 位置逐张本地上传
    if (args.workdir) {
      await insertQqImages(page, args.workdir);
    }

    // 4. AI 自主声明（企鹅号保存草稿/发布前需要选择；按技能规范选择“该文章由AI生成”）
    await setAiDeclaration(page);

    // 5. 发布/存草稿
    if (draft) {
      // 第一次点存草稿：正文含图片时会先弹“AI生成声明”
      await clickSaveDraft(page);
      await handleAiMaterialDialog(page);
      // 提交 AI 声明后需再点一次“存草稿”才能真正保存
      await clickSaveDraft(page);
      await handleAiMaterialDialog(page);
      await waitForSaveSuccess(page);
      console.log('[企鹅号] 草稿已保存，请到内容管理-草稿中确认');
    } else {
      let published = false;
      for (let attempt = 0; attempt < 3 && !published; attempt++) {
        const publishBtn = page.getByRole('button', { name: '发布', exact: true }).first();
        await publishBtn.click();
        await page.waitForTimeout(3000);
        // 正文含图片时可能先弹“AI生成声明”，直接提交
        await handleAiMaterialDialog(page);
        await page.waitForTimeout(2000);
        // 若出现二次确认弹窗（“确认发布”），点确认
        const confirmDialog = page.locator('.omui-dialog-wrapper.open').first();
        if (await confirmDialog.count()) {
          const confirmBtn = confirmDialog.getByRole('button', { name: '确认', exact: true }).first();
          if (await confirmBtn.count()) {
            await confirmBtn.click();
            await page.waitForTimeout(5000);
            // 点确认后若仍出现 AI生成声明，再次提交
            await handleAiMaterialDialog(page);
          }
        }
        published = page.url().includes('/main/management/articleManage')
          || page.url().includes('/main/management')
          || (await page.locator('body').innerText().catch(() => '')).includes(args.title)
          && (await page.locator('body').innerText().catch(() => '')).includes('已发布');
        if (!published) {
          console.log(`[企鹅号] 第${attempt + 1}次发布未确认成功，等待后重试`);
          await page.waitForTimeout(5000);
        }
      }
      if (!published) {
        console.error('发布未确认成功，请人工检查企鹅号页面');
        process.exit(1);
      }
      console.log('[企鹅号] 已发布');
    }

    // 6. 验证（草稿模式不强制校验：存草稿后不一定进入内容管理列表）
    if (!draft) {
      await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(6000);
      const dateText = args.date || '';
      const dateMMDD = dateText ? dateText.slice(5) : '';
      await waitFor(async () => {
        const bodyText = await page.locator('body').innerText().catch(() => '');
        if (!bodyText.includes(args.title)) return false;
        if (!dateText) return true;
        return bodyText.includes(dateText) || (dateMMDD && bodyText.includes(dateMMDD));
      }, { timeout: 60000, label: '企鹅号内容管理出现新文章' });
      console.log('OK: 企鹅号文章已出现在内容管理列表');
    } else {
      console.log('OK: 企鹅号草稿操作完成，请人工在内容管理-草稿中确认');
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
