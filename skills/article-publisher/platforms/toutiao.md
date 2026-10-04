# 今日头条发布/标题修改 playbook

> 固化脚本：[scripts/toutiao/edit_toutiao_titles.js](../scripts/toutiao/edit_toutiao_titles.js)
> 说明：今日头条文章由懂车号自动同步，不需要重新发文；只需等同步文章审核通过后，把标题改成与其它平台不同的备用标题。

- 平台入口：https://mp.toutiao.com/profile_v4/manage/content/all
- 编辑页：在内容列表点「修改」会在新标签打开 `https://mp.toutiao.com/profile_v4/graphic/publish?from=edit&pgc_id=...`
- 未登录跳转：通常跳转头条登录页。
- 表格支持：`table_support: true`（已实测：把含 `<table>` 的 `正文_clean.html` 粘贴后，编辑态 DOM 保留 table，行/列完整）
  - 如果走当前“纯文本正文 + 本地插图”脚本，为避免表格被压成 `|` 纯文本，建议先运行 `scripts/common/table_to_image.js` 生成表格图片版，再把 `--workdir` 指向 `..._tableimg`。

## 脚本用法

```bash
# 懂车号发布后，等同步文章出现，再改标题（推荐）
node scripts/toutiao/edit_toutiao_titles.js --state "/home/zzk/geo/发布工作区/平台登录状态.json" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles" --docs 1,2,3 --title-index 3 --date YYYY-MM-DD

# 直接发布/前台填充审核（一般不用，今日头条默认走懂车号同步）
node scripts/toutiao/publish_toutiao.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态.json" --review --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"

# 直接发布
node scripts/toutiao/publish_toutiao.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态.json" --publish --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"
```

## 字段与限制
- 标题：2～30 个字，输入框为 `textarea[placeholder="请输入文章标题（2～30个字）"]`
- 正文：已同步内容，不需要改
- 保存按钮：编辑页底部「发布」（修改后重新进入审核）

## 同步改标题流程

今日头条不需要重新发文：懂车号发布后会自动同步到今日头条。等同步文章审核通过后，运行 `edit_toutiao_titles.js` 按主标题+日期找到文章，打开「修改」，把标题改成备用标题，然后点「发布」。

## 操作步骤
1. 打开内容管理页。
2. 在「搜索关键词」输入框输入当前标题（即懂车号发布时的主标题），并传入 `--date YYYY-MM-DD`。
   - ⚠️ 只点搜索图标可能不生效；可靠做法：点击输入框 → 输入标题 → 点搜索图标 → 再按 Enter。
3. 在结果中找到对应文章卡片（`.article-card-bone`，**同时按标题和日期匹配**，避免同名旧文章）。
4. 点卡片上的「修改」（是 `<span>`，不是 button；若被头部浮层遮挡用 force click）。
5. 等待新标签页加载完成。
6. 清空/填入新标题（默认用备用标题4，即 `alt_titles[3]`；超长时需用更短备用标题或精简标题）。
7. 点「发布」，等待跳转到 `/graphic/articles` 或内容管理页。
8. 核对列表中标题已变化，状态为「修改审核中」。

## ⚠️ 已知坑位
- 文章可能不在第一页：必须用搜索框定位，不能只翻页。
- 搜索图标单独点击有时不触发搜索：图标点击后再按 Enter。
- 「修改」可能被页面头部浮层拦截：用 `force: true` 点击。
- 修改后文章会进入「修改审核中」，属于正常状态。
- 已发布文章“修改”有“修改篇幅过大”限制，大段补正文无法直接保存；需要删除旧作品后重新发布。

## 验证
内容列表按新标题能搜到，且标题与懂车号/汽车之家/百家号/易车已用标题不同。
