# 淘江湖发布 playbook

> 固化脚本：[scripts/taohu/publish_taohu.js](../scripts/taohu/publish_taohu.js)（首选执行方式；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://jianghu.taobao.com/editor.html
- 未登录会提示“亲，请登录”。
- 表格支持：`table_support: true`（支持富文本表格粘贴）

## 脚本用法

```bash
# 前台填充审核
node scripts/taohu/publish_taohu.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-taohu.json" --review --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"

# 直接发布
node scripts/taohu/publish_taohu.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-taohu.json" --publish --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" [--board 兴趣经验] [--sub-board 实用经验] [--product-category 家居日用]
```

## 字段与限制
- 标题：`input.editor-title`
- 正文：TinyMCE iframe（`bbsEditor_ifr`）
- 必填：发布板块、板块分类、商品分类（脚本自动选择默认值）

## ⚠️ 平台特殊规则
- 淘江湖每天最多发布 4 篇。
- 连续发布每篇间隔至少 5 分钟（脚本内置等待）。

## 验证
- 发布后可在淘江湖内容/前台看到文章。
