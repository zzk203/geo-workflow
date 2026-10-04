# 企鹅号发布 playbook

> 固化脚本：[scripts/qiehao/publish_qiehao.js](../scripts/qiehao/publish_qiehao.js)（首选执行方式；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://om.qq.com/main
- 发布页：https://om.qq.com/main/creation/article
- 内容管理：https://om.qq.com/main/management/articleManage
- 未登录跳转：https://om.qq.com/userAuth/index（QQ/微信扫码或账密登录）
- 表格支持：`table_support: true`（支持富文本表格粘贴）

## 脚本用法

```bash
# 直接发布
node scripts/qiehao/publish_qiehao.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-qiehao.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"

# 存草稿
node scripts/qiehao/publish_qiehao.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-qiehao.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" --draft

# 如需在验证时按日期过滤同名文章，加 --date YYYY-MM-DD
```

> 说明：脚本会先清空上次自动保存内容，再读取 `正文_clean.html`，去掉图片块/根容器后直接写入 ProseMirror；图片按 `article.json` 位置逐张本地上传。若不存在中转文件则回退到飞书复制。

## 字段与限制
- 标题：5～64 字。输入区是 `#omEditorTitle` 内的 contenteditable SPAN（`span[data-placeholder="请输入标题（5-64个字）"]`），不是普通 input。
- 正文：ProseMirror 编辑器（`div.ProseMirror[contenteditable="true"]`，页面内非 iframe）。
- 必填项：标题、正文。
- 可选项（均不设置）：封面（单图/三图）、分类、标签、活动投稿。
- 自主声明：可选；按技能规范脚本默认选择「该文章由AI生成」。
- ⚠️ **每日限发 5 篇**：超过平台配额后应停止自动发布，避免失败或触发风控。

## 操作步骤
1. 打开发布页 `https://om.qq.com/main/creation/article`，等待编辑器加载。
2. **先清空上次自动保存的标题/正文**（发布页会载入上次未保存内容）；标题输入是 contenteditable SPAN，脚本使用 `execCommand('insertText') + input/change 事件` 填写，避免“看起来有字但组件未更新”导致保存时提示没填标题。
3. 正文写入：
   - 默认使用本地中转文件去掉图片块后的 HTML（`clipboard_qq_noimg.html/txt`），脚本会**去掉飞书根容器后直接写入 ProseMirror**（不是剪贴板粘贴），避免飞书远程图片在企鹅号中一直显示加载中；
   - 写入后按 `article.json` 中图片位置，定位前一段落 → 点正文工具栏「插入图片」→ 弹窗「本地上传」→ `setInputFiles` 本地图片 → 等上传完成 → 点「确认」。
   - 验证标准：ProseMirror 中出现 `img.index_module_img__cffb2914`，src 为 `inews.gtimg.com`，正文文字完整。
4. 自主声明：点「添加内容自主声明」→ 选「该文章由AI生成」→ 点「确认」。**保存草稿前必须完成自主声明**，否则会提示“请选择自主声明”。
5. 发布/存草稿：
   - 直接发布：点「发布」；若出现二次确认弹窗则点「确认」。
   - 存草稿：**如果正文没有图片**，点一次「存草稿」等“保存成功”即可。
   - 存草稿（正文含图片）：第一次点「存草稿」→ 弹「AI生成声明」→ 点「提交」→ **再点一次「存草稿」**，等待“保存成功”提示；草稿才会真正创建。
   - 发布时若也出现「AI生成声明」弹窗，同样点「提交」后继续。
6. 验证：打开内容管理列表，确认新文章出现；若同名较多，用 `--date YYYY-MM-DD` 过滤。

## ⚠️ 已知坑位
- 飞书远程图片不能直接依赖粘贴上传：企鹅号会把图片块渲染成加载占位（`index_module_loadingLoader`）但不会真正转存成本地 CDN 图片。必须先去掉 HTML 中的图片块，再用本地上传插入。
- 标题输入是 contenteditable SPAN，单纯 `fill`/`type` 可能只改视觉、组件状态未更新；需要用 `execCommand('insertText')` + `input/change` 事件，并确认保存时没有“请填写标题”错误。
- 企鹅号发布页会载入上次自动保存内容；不先清空会把旧草稿拼进新正文。脚本已先清空标题和正文。
- 封面/分类/标签均标「选填」，不要为了“看起来完整”去设置，避免引入不必要的平台校验。
- **保存草稿/发布前必须完成自主声明**，否则表单下方会提示“请选择自主声明”，草稿不会保存。
- 正文含图片时，第一次点「存草稿」会先弹「AI生成声明」；点「提交」后还需要**再点一次「存草稿」**才会真正保存草稿。
- 存草稿后不一定会立即出现在内容管理「全部」列表，人工确认时切到「草稿」状态。
- 发布页加载偶发空白（body 很短）：多等几秒或重新打开发布页即可，不是脚本卡死。

## 验证
- 发布成功客观判据：内容管理列表出现刚发布的标题，状态为「审核中/已发布」；正文图片 src 均为 `inews.gtimg.com` 企鹅号 CDN。
