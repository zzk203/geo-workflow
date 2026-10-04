# 汽车之家发布 playbook

> 固化脚本：[scripts/autohome/publish_autohome.js](../scripts/autohome/publish_autohome.js)（首选执行方式；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://creator.autohome.com.cn/web/content
- 发布页：悬停侧边「发布作品」→ 点「发布帖子」（下拉项 `a[href="/web/publish/bbs"]`，或直接 goto https://creator.autohome.com.cn/web/publish/bbs）
- 未登录会跳转 account.autohome.com.cn 登录页。
- 表格支持：`table_support: false`（不支持富文本表格；发布含表格文章时先运行 scripts/common/table_to_image.js 生成表格图片版，--workdir 指向 ..._tableimg）

## 脚本用法

```bash
node scripts/autohome/publish_autohome.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"
```

## 字段与限制
- 标题：6～30 个汉字（textbox，placeholder「请输入文章标题（6-30个汉字）」）
- 正文：自定义 contenteditable 编辑器（`.editor-input`）
- ⚠️ **段落标题（正文内 h1-h6）字数限制为 2～30 字**，超过会导致发布按钮不可用/发布失败。固化脚本会在粘贴前自动检测并尽量不修改原意地缩短到 30 字以内。
- ⚠️ **粘贴富文本会吞掉换行符**：汽车之家编辑器粘贴飞书 HTML 时 div 块换行可能丢失。固化脚本已把飞书顶层 div 规范成 `<p>`/保留标题/列表等块级结构，并在文本块内将换行转 `<br>`，避免段落挤在一起。
- 必填：作品声明（选「必选声明」→ 勾选「含AI生成内容」→ 确定）、条款 checkbox。
- 论坛/话题为非必填，脚本不选择论坛、不处理“选择论坛”弹窗（发布和存草稿都不处理）。

## ⚠️ 特殊处理（本平台独有）
为避免粘贴图片上传失败/误删，汽车之家采用：
1. 默认读取本地中转文件 `正文_clean.html`（不存在时回退到飞书复制）；
2. 把 `<img>` 替换为 `【图N】` 占位符，并再次用 `removeAltBlockFromHtml` 删除备选标题；
3. 自动检查并缩短正文 h1-h6 段落标题到 30 字以内；将飞书 div 块规范成 `<p>`/保留标题等结构，修复换行被吞；
4. 把清理后的 HTML 写回剪贴板并粘贴（保留格式，不粘贴图片）；
5. 按占位符位置逐张上传图片：定位 `【图N】` → 删除占位符 → 点「添加图片」→ 上传本地图片 → 等待「已上传图片」→ 点「确定」→ 重复。

> ⚠️ 上传成功后的图片域名是 `autoimg.cn`，不要再用旧的“清理非 autohome.com.cn 图片”逻辑，否则会误删已上传图片。

### 声明与发布
1. 作品声明 combobox（`#rc_select_0`）→ 下拉中勾选「含AI生成内容」→ 「确定」
2. 勾选「我已阅读并已同意遵守《汽车之家内容上传服务条款》」
3. 点「发布」→ 成功跳转 club.autohome.com.cn 帖子页

## 验证
URL 变为 `club.autohome.com.cn/bbs/thread/<tid>/...`，页面含标题、正文首尾、图片。
