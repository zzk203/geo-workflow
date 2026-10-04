# <平台名> 发布 playbook

> 复制本模板创建新平台。先手工在浏览器里走一遍发布流程（用 Playwright 脚本/浏览器 DevTools 探索 UI），
> 把每个字段的选择器、点击顺序、坑位记录进来，再实测发布一篇验证。

- 平台入口：<管理列表 URL>
- 发布页：<发布页 URL 或入口操作（如"悬停XX→点XX"，记录下拉项 href）>
- 未登录跳转：<登录页 URL>（登录方式备注）
- 表格支持：`table_support: true / false / 未实测`
  - `true`：粘贴 `<table>` 可保留，直接走富文本表格。
  - `false`：不要降级成 `|` 纯文本，先运行 `scripts/common/table_to_image.js` 生成表格图片版，再把 `--workdir` 指向 `..._tableimg`。
  - `未实测`：不要假设，先按 SKILL.md「表格处理」的实测方法确认。

## 脚本用法

```bash
node scripts/<平台>/publish_<平台>.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-<平台>.json" --image "/home/zzk/geo/发布工作区/<项目名>/articles/18/图片1.png" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"
```

> 说明：脚本优先读取 `正文_clean.html` 本地中转文件；若不存在则回退到飞书复制。

## 字段与限制
- 标题：<字数限制、输入框选择器/placeholder>
- 正文：<编辑器类型（Quill/ProseMirror/UEditor/自定义）、是否 iframe、选择器>
- 必填项：<列出所有带 * 的项>
- 可选项：<明确"不动"的项>

## 操作步骤
1. 标题：<填写方法>
2. 正文粘贴：
   - 默认方式：读取本地中转文件 `正文_clean.html` → 点入编辑器 → `Control+V`
   - 验证标准：全文长度、以第一个章节标题开头（主标题/备用标题已删除）、图片数量 1 且已上传到本平台 CDN
3. 必填项逐个处理：<封面弹窗流程、声明选择、坑位（遮挡、弹窗堆积、模式要求）>
4. 点发布按钮 → 成功标志：<跳转 URL / 弹窗 / 提示>
5. 验证：<管理列表位置与状态>

## ⚠️ 已知坑位
- <坑位 1 及规避方法>
- <坑位 2 及规避方法>

## 验证
<发布成功的客观判据>
