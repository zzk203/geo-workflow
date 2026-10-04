// 知乎“草稿→编辑→发布”脚本
// 适用：知乎直接 --publish 被风控拦截时，先用 --draft 存草稿，再用本脚本从创作中心草稿箱进入编辑页点“发布”。
// 用法:
//   node scripts/zhihu/publish_zhihu_from_draft.js --title "标题" --state "/home/zzk/geo/发布工作区/平台登录状态-zhihu.json"
const path = require('path');
const {
  loadPlaywright, openPage, mainArgs,
} = require('../common/common.js');

(async () => {
  const args = mainArgs();
  if (!args.title || !args.state) {
    console.error('缺少参数: --title / --state 必填');
    process.exit(1);
  }
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const { page } = await openPage(browser, args.state);
    await page.goto('https://www.zhihu.com/creator/manage/creation/draft?type=article', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    // 找出所有匹配标题的草稿编辑链接
    const editHrefs = await page.evaluate((title) => {
      return [...document.querySelectorAll('a')]
        .filter(x => x.href && x.href.includes('/edit') && (x.innerText || '').includes(title))
        .map(x => x.href);
    }, args.title);
    if (!editHrefs.length) {
      console.error(`未在知乎文章草稿中找到标题: ${args.title}`);
      process.exit(1);
    }
    console.log(`找到 ${editHrefs.length} 个匹配草稿:`, editHrefs);

    // 逐个打开草稿，优先选择正文中有图片的草稿（避免发布到无图的旧草稿）
    let publishedUrl = '';
    for (const href of editHrefs) {
      console.log('检查草稿:', href);
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(8000);
      const imgCount = await page.evaluate(() =>
        document.querySelectorAll('.public-DraftEditor-content img').length
      ).catch(() => 0);
      console.log(`  该草稿正文图片数: ${imgCount}`);
      const publishBtn = page.getByRole('button', { name: '发布', exact: true });
      if (!(await publishBtn.count().catch(() => 0))) {
        console.log('  该草稿没有发布按钮，跳过');
        continue;
      }
      // 优先选有图片的草稿；如果只剩最后一个，则无论有无图片都发布
      const hasImages = imgCount > 0;
      const isLast = href === editHrefs[editHrefs.length - 1];
      if (!hasImages && !isLast) {
        console.log('  该草稿无图且不是最后一个，继续找有图草稿');
        continue;
      }
      await publishBtn.click();
      await page.waitForTimeout(6000);
      publishedUrl = page.url();
      console.log('发布后 URL:', publishedUrl);
      console.log('注意：如页面显示 403 风控，请到创作中心确认文章是否已变为“已发布”；未发布则需人工再点一次发布。');
      break;
    }
    if (!publishedUrl) {
      console.error('所有匹配草稿均未能发布');
      process.exit(1);
    }
  } finally {
    if (!args.headed) await browser.close();
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
