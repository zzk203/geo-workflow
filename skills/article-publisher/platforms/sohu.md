# 搜狐号发布 playbook

> 固化脚本：[scripts/sohu/publish_sohu.js](../scripts/sohu/publish_sohu.js)（首选执行方式；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://mp.sohu.com/mpfe/v4/contentManagement/first/page
- 发布页：从内容管理页点「发布内容」进入 https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1
  - ⚠️ 直接 `goto` addarticle 会被重定向回内容管理列表，必须先从列表页点击「发布内容」。
- 未登录跳转：https://mp.sohu.com/mpfe/v4/login（账号/手机/第三方登录）。
- 表格支持：`table_support: true`（支持富文本表格粘贴）

## 脚本用法

```bash
# 普通发布/存草稿
node scripts/sohu/publish_sohu.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-sohu.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" [--draft]

# 定时发布
node scripts/sohu/publish_sohu_schedule.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-sohu.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" [--date 8月25日] [--hour 0] [--minute 0]
```

## 字段与限制
- 标题：5～72 字（input placeholder「请输入标题（5-72字）」）
- 正文：Quill 编辑器（`.ql-editor`，页面内非 iframe）
- 必填：创作声明（`*必选声明`，选「含有AI生成内容」）
- 封面：建议上传（封面图片尺寸应大于 450*300，最大 10M，jpg/jpeg/png）
- 摘要/话题/属性/栏目/可见范围：可选，非必填不动。
- 每日发布上限：页面显示「您今天还能发 N 篇文章」（默认 5 篇/天），超出需次日或定时发布。

## 操作步骤
1. 打开内容管理列表 → 点「发布内容」进入发布页。
2. 标题 `fill` 到 `input[placeholder="请输入标题（5-72字）"]`。
3. 正文粘贴：
   - 默认使用本地中转文件 `正文_clean.html`；若不存在则回退到飞书复制
   - 点 `.ql-editor` → `Control+V`
   - 验证：`.ql-editor` innerText 完整、img 数量≥1
4. 删除「备选标题」块：已在脚本的中转 HTML 中通过 `removeAltBlockFromHtml` 删除，不再粘贴后删除。
5. 封面：
   - 点「上传图片」打开弹窗
   - 点「本地上传」标签页
   - 直接对弹窗内 `#new-file` 执行 `setInputFiles(图片路径)`
   - 等待 `.select-dialog .button.positive-button`（确定）可点后点击
   - 验证封面区「上传图片」文字消失
6. 创作声明：在 `*必选声明` 单选组中点「含有AI生成内容」。
7. 点「发布」或「存草稿」→ 跳回内容管理列表，列表出现该标题。

## ⚠️ 已知坑位
- 直接访问 addarticle URL 会重定向到列表，必须从「发布内容」按钮进入。
- 封面弹窗有多个「确定」按钮，必须点 `.select-dialog .button.positive-button`（本地上传面板里可用的那个）。
- 每日最多 5 篇，批量发布时需注意剩余配额。

## 验证
内容管理列表按标题可搜到，状态为「审核中」/「已发布」（草稿时为「草稿」）。
