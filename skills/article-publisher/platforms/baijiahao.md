# 百家号发布 playbook

> 固化脚本：[scripts/baijiahao/publish_baijiahao.js](../scripts/baijiahao/publish_baijiahao.js)（首选执行方式；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://baijiahao.baidu.com/builder/rc/content（发布列表）
- 发布页：列表页点「发布作品」按钮（`#home-publish-btn`）→ 跳转 https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1
- 未登录会跳转 builder/theme/bjh/login。
- 表格支持：`table_support: true`（支持富文本表格粘贴）

## 脚本用法

```bash
# 发布
node scripts/baijiahao/publish_baijiahao.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"

# 存草稿（每日发布超限/需要人工确认时）
node scripts/baijiahao/publish_baijiahao.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" --draft
```

## 字段与限制
- 标题：2～64 字。输入区是 contenteditable DIV（不是 input），先 click 再 `type` 输入。
- 正文：UEditor，位于 iframe `#ueditor_0` 内（Playwright 可直接用 iframe 内 ref；eval 需 `document.querySelector('#ueditor_0').contentDocument`）。
- 必填：封面（`* 设置封面`，**模式必须保持「单图」**——选成三图会导致无法发布）。
- 必填：创作声明 → **「采用AI生成内容」** 必须勾选，否则发布按钮禁用。
- 必填：创作声明 → **「来源说明」** 勾选后必须选择地点（如“北京市”），否则发布按钮仍禁用。
- ⚠️ **每日发布上限 15 篇**：超出后发布按钮会被平台限制，只能使用 `--draft` 存草稿，次日再发布。
- 话题/打赏为可选，不动。

## 操作步骤
1. 标题：click 标题编辑器（`[contenteditable=true]`，class 含 `-editor`）→ `type` 标题。
2. 正文粘贴：
   - 默认使用本地中转文件 `正文_clean.html`；若不存在则回退到飞书复制
   - 点 iframe 内正文段落 → `Control+V`
   - 验证：iframe body innerText 完整（约 3650 字）；img src 已变为 `baijiahao.baidu.com/bjh/picproxy`（自动上传）
3. 删除开头「备选标题」块：已在脚本的中转 HTML 中通过 `removeAltBlockFromHtml` 删除，不再粘贴后删除。
4. 封面（必填）：
   - 点「选择封面」→ 弹出封面弹窗（cheetah-modal，可能被透明 canvas 拦截鼠标事件，导致 playwright click 超时；用 eval `el.click()` 兜底，或检测 `.cheetah-modal-wrap` 的 getBoundingClientRect）
   - 在弹窗「正文/本地上传」tab：点击上传按钮触发文件选择器 → `在文件选择框中选择 <工作目录>/图片1.png`；或对弹窗内 `input[type=file]` 用 `或用 Playwright 对弹窗内 input[type=file] setInputFiles("<图片路径>")`
   - 上传后弹窗列表出现图片项 → 点击图片项 → 点「确定 (1)」关闭
   - 验证：封面区出现「编辑/更换」按钮；⚠️ 若封面区仍显示两个「选择封面」，说明模式是三图——点回「单图」radio
5. 发布/存草稿：
   - 发布：点底部「发布」（`[data-testid=publish-btn]`）→ 成功会跳转到 builder/rc/clue 引导页。
   - 存草稿：脚本传入 `--draft` 时点「存草稿」，即使发布按钮因每日限额/来源地点未选而禁用，也可保存草稿。

## 验证
回内容列表，第一条为该标题，状态「已发布/审核中」，时间正确。
