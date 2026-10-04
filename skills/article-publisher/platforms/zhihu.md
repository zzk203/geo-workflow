# 知乎发布 playbook

> 固化脚本：[scripts/zhihu/publish_zhihu.js](../scripts/zhihu/publish_zhihu.js) + [scripts/zhihu/publish_zhihu_from_draft.js](../scripts/zhihu/publish_zhihu_from_draft.js)（默认组合流程；本文件为脚本失败时的人工兜底说明与坑位记录）

- 平台入口：https://zhuanlan.zhihu.com/write
- 未登录跳转：知乎登录页（`signin`）。
- 表格支持：`table_support: true`（支持富文本表格粘贴）

## 脚本用法

```bash
# 默认流程（推荐）：存草稿 -> 从草稿中发布，降低知乎风控概率
node scripts/zhihu/publish_zhihu.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-zhihu.json" --draft --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"
node scripts/zhihu/publish_zhihu_from_draft.js --title "<标题>" --state "/home/zzk/geo/发布工作区/平台登录状态-zhihu.json"

# 前台填充审核（有头，保持浏览器打开）
node scripts/zhihu/publish_zhihu.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-zhihu.json" --review --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"

# 直接发布（不推荐；仅在用户明确要求时使用）
node scripts/zhihu/publish_zhihu.js --title "<标题>" --doc-url "<飞书URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-zhihu.json" --publish --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18"
```

## 字段与限制
- 标题：最多 100 字（`textarea[placeholder="请输入标题（最多 100 个字）"]`）
- 正文：Draft.js 编辑器（`.public-DraftEditor-content`）
- 图片：通过文章内“图片”按钮本地上传（脚本按 `article.json` 图片位置插入）
- 声明：可选，按需求处理

## ⚠️ 平台特殊规则
- 知乎虽无直接发布间隔限制，但发布过快可能禁发一天，**连续发布间隔至少 10 分钟**。
- 知乎有风控：直接从 `write` 页自动点“发布”可能返回 `40362 请求存在异常`，但内容会先自动保存为草稿。
- **默认发布流程固定为“存草稿 → 从草稿中发布”**：先用 `--draft` 生成草稿，再调用 `publish_zhihu_from_draft.js` 进入创作中心“文章草稿”的 `/edit` 页点“发布”。实测从草稿编辑页发布更稳，能降低风控概率。
- 只有用户明确要求直接发布时，才使用 `--publish` 直接发布；若 `--publish` 未检测到成功，不要直接判失败：先到创作中心确认是“草稿”还是“已发布”；若是草稿则改用默认的“草稿→编辑→发布”流程。

## 验证
- 发布成功后可在知乎文章页看到标题、正文和图片。
- 草稿模式可在创作中心草稿箱看到。
- 若发布后访问文章页仍遇 403，通常是知乎风控对当前网络/无头浏览器拦截，不代表未发布；以创作中心状态为准。
