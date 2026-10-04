# 易车发布 playbook

> 固化脚本：[scripts/yiche/publish_yiche.js](../scripts/yiche/publish_yiche.js)（首选执行方式；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://mp.yiche.com/article/index-new/（列表页内嵌发布编辑器）
- 未登录会跳转 i.yiche.com/authenservice/login.html。
- 表格支持：`table_support: false`（不支持富文本表格；发布含表格文章时先运行 scripts/common/table_to_image.js 生成表格图片版，--workdir 指向 ..._tableimg）

## 脚本用法

```bash
node scripts/yiche/publish_yiche.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"
```

## 字段与限制
- 标题：≤28 字（textbox，placeholder「请输入文章标题」）
- 正文：Quill 编辑器（`.ql-editor`，页面内非 iframe）
- 必填：`*竖版封面图`、`*封面图`（单图模式）
- 关联车型/话题为可选（有「自动获取」按钮，不动）；同意转发/同意生成摘要默认「是」；内容声明为可选（无星号），按需求可勾「含AI生成内容」。

## 操作步骤
1. 标题 `fill`。
2. 正文粘贴：
   - 默认使用本地中转文件 `正文_clean.html`；若不存在则回退到飞书复制
   - 点 `.ql-editor` → `Control+V`
   - 验证：`.ql-editor` innerText 完整；img 为 `data:image/jpeg;base64`（编辑器本地转换，提交时上传）
3. 删除「备选标题」块：已在脚本的中转 HTML 中通过 `removeAltBlockFromHtml` 删除，不再粘贴后删除。
4. 封面：
   - **横版封面图**：正文粘贴后平台会自动把正文图设为封面（封面区出现「更换/删除」即完成），单图模式保持勾选
   - **竖版封面图**（必填）：点「自动获取」→「生成封面」向导 →「下一步」→ 模板页点第一个模板图 →「保存/确定」
     - 或者：点竖版封面上传区（「建议图片比例为3:4」处）触发文件选择器 → `在文件选择框中选择 <工作目录>/图片1.png` → 「封面编辑」弹窗选比例 `3:4` →「完成裁剪」→ 模板页点模板 →「确定」
   - ⚠️ 坑位：该页点击某些按钮会连续弹出多个文件选择器（modal state 堆积，阻塞一切命令）。出现 `[File chooser]` modal state 时用脚本的全局 filechooser 自动填入，或手动在文件选择框选择；若堆积过多直接刷新页面重做（标题/正文需重贴）
   - 验证：两个封面槽位均出现「更换 | 删除」按钮
5. 声明（可选）：勾选「含AI生成内容」时注意 el-radio 可能被遮挡，用 eval `input[type=radio]` 按索引 click（声明组索引 6～11，含AI=第 7 个）。
6. 点底部「提交」→ 成功跳转 https://mp.yiche.com/detailManage（内容管理）。

## 验证
内容管理列表第一条为该标题，状态「已发布」，时间正确。
