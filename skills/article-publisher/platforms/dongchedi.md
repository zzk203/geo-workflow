# 懂车号发布 playbook

> 固化脚本：[scripts/dongchedi/publish_dongchedi.js](../scripts/dongchedi/publish_dongchedi.js)（首选执行方式；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://mp.dcdapp.com/profile_v2/manage/content/article
- 发布页：https://mp.dcdapp.com/profile_v2/publish/article
- 未登录会跳转 https://mp.dcdapp.com/login/（验证码/账密/微信/抖音），让用户手动登录后 `state-save`。
- 表格支持：`table_support: false`（**不支持富文本表格**；发布含表格文章时先运行 scripts/common/table_to_image.js 生成表格图片版，--workdir 指向 ..._tableimg）
  - ⚠️ 不要把含 `<table>` 的 HTML 直接粘贴到懂车帝编辑器，否则表格内容会被压成纯文本或丢失。

## ⚠️ 正文图片：必须走「编辑器自带上传」，不要依赖粘贴内嵌图（2026-09 实测）

**踩坑**：把 `data:` 内嵌图（base64）随正文一起粘贴，懂车帝虽然偶尔会把它们转存到自家
CDN（headless 下域名是 `byteimg.com`，headed 下是 `dcdapp.com`），但**转存是异步且会失败**：
同一批 8 篇用同一流程，6 篇成功、2 篇图片永远停在 `data:`。正文图没上去 → 平台**无法据此
自动生成封面** → 封面槽一直停在「上传封面」占位文案 → 发布会卡住。

**现在的固化做法**（脚本已实现）：

1. 粘贴前把正文里的 `<img>` 全部替换成 `【图N】` 占位符（`toPlaceholderHtml`），先只贴文字；
2. 逐张用**编辑器工具条的图片工具**插入本地图：
   - 用 DOM Range 选中 `【图N】` 并 Delete（`selectPlaceholder`，ProseMirror 会跟随 DOM selection）；
   - 点 `.syl-toolbar-tool.image` → 弹出 `arco-drawer`；
   - 点抽屉里的「上传图片」tab → 出现 `input[type=file]`（accept 为 jpeg/png/gif）；
   - `setInputFiles(本地图)`；
   - ⚠️ **关键**：等抽屉出现「上传完成」后，**必须再点抽屉底部的「确定」**，图片才会真正插入正文——只 setInputFiles 不点确定，占位符不会被替换；
3. 插入后校验：正文不应再残留 `【图N】`，否则**直接中止发布**（避免发出缺图文章）；
4. 正文图就位后，平台通常就能正常自动生成双封面。

## 封面判定

- 不要用「『上传封面』文案消失」判定封面就绪：它是**空封面槽的占位文案**，页面初始就有 2 个；
  部分文章即使封面已生成也会一直保留该文案，死等必然超时。
- 可靠判据：**「发布」按钮变为可用**（配合正文图已就绪）。

## 发布结果判定（脚本会误报失败）

- 点「发布」后有时不跳转，甚至按钮点击报 `element is not enabled`，但**文章其实已经提交**。
  实测有文章脚本报 FAIL、作品管理列表里却已有该文章。
- 因此脚本末尾不再只看跳转，而是**回作品管理列表按「标题 + 当天日期」核实**；
  人工复核时同样以列表为准，不要只看脚本退出码。

## 脚本用法

```bash
node scripts/dongchedi/publish_dongchedi.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-dongchedi.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"
```

## 字段与限制
- 标题：2～30 个汉字（textbox，placeholder「请输入文章标题」）
- 正文：富文本编辑器（ProseMirror，页面内非 iframe），placeholder「请输入正文」
- 必填：竖版封面、横版封面（正文图经**编辑器上传**就位后，平台会自动把文章图片设为双封面）
- 广告选项：保持默认「投放广告赚收益」；话题/活动为可选，不动。

## 操作步骤
0. 若正文含表格：先运行 `node scripts/common/table_to_image.js --workdir "…/articles/<编号>"`，后续 `--workdir` 使用生成的 `<编号>_tableimg` 目录。
1. `goto` 发布页。
2. 标题：`fill` 标题 textbox。
3. 正文粘贴：
   - 默认使用本地中转文件 `正文_clean.html`（已删除备选标题）；若不存在则回退到飞书复制
   - 把 `<img>` 换成 `【图N】` 占位符后再写入剪贴板 → 点入正文编辑器 → `Control+V`
   - 验证：`.ProseMirror` innerText 长度≈全文
4. 图片：按 `【图N】` 顺序用编辑器图片工具逐张上传本地图（见上文「正文图片」小节）；
   全部替换完成后若仍有残留占位符则**中止发布**。
5. 等封面就绪：以**「发布」按钮可用**为准（不要等「上传封面」文案消失）。
6. 点「发布」→ 回作品管理页；即使未跳转也要按「标题 + 当天日期」在列表核实是否已提交。

## 验证
作品管理列表按「标题 + 当天日期」能搜到该文章，状态「审核中/已发布」，时间正确。
公开链接形如 `https://www.dongchedi.com/article/<id>`：在作品列表点标题会在新标签打开该 URL，
可用于汇总发布链接。

