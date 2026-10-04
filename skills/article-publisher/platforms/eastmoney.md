# 东方财富（财富号/创作平台）

- 管理首页：https://mp.eastmoney.com/#/home
- 长文发布页：https://mp.eastmoney.com/collect/pc_article/index.html#/
- 登录态文件：`/home/zzk/geo/发布工作区/平台登录状态-eastmoney.json`
- 发布脚本：`scripts/eastmoney/publish_eastmoney.js`
- 表格支持：`table_support: false`（不支持富文本表格；发布含表格文章时先运行 scripts/common/table_to_image.js 生成表格图片版，--workdir 指向 ..._tableimg）

## 用法

```bash
node scripts/eastmoney/publish_eastmoney.js \
  --title "标题" \
  --doc-url "腾讯文档URL" \
  --state "/home/zzk/geo/发布工作区/平台登录状态-eastmoney.json" \
  --image "/home/zzk/geo/发布工作区/<项目名>/articles/td_publish/01/图片1.png" \
  --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/td_publish/01" \
  --publish
```

- `--publish`：直接发布
- `--draft`：只依赖自动保存草稿，不点击发布
- 正文从 `workdir/article.json` 读取，图片按位置插入；单张超过 5MB 的图片会自动跳过
- 封面从 `--image` 上传；若超过 5MB 会自动改用 workdir 内较小的图片
- 信息来源固定选择“AI生成”
- 发布时若出现确认弹窗会自动点确认

## 注意事项

- 单张图片最大 5MB，超限会上传失败，脚本会自动跳过或换图
- 编辑器为 ProseMirror，正文使用纯文本粘贴 + 本地图片插入
- 自动保存草稿，`--draft` 模式等待数秒后退出即可
