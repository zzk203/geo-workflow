---
name: article-publisher
description: 多平台文章发布技能（Linux 版）。用户提供一个飞书在线文档链接和希望发布的平台列表，自动提取文章（主标题/备用标题/正文/图片）并逐平台发布。每个平台对应 platforms/ 下一个独立的 playbook，支持后续增加和拓展。
---

# 多平台文章发布（article-publisher · Linux 版）

> 本目录是从 Windows 版移植并固化的 Linux 版本。已移除 PowerShell 剪贴板依赖，改用浏览器 `navigator.clipboard`；路径统一为 Linux 风格；发布脚本直接使用本地 `playwright` 运行，不再依赖 `playwright-cli`。

## 触发条件

用户说"发布文章/发布到XX平台/把这篇文章发到XXX"，并提供：
- 飞书在线文档链接（形如 `https://xxx.feishu.cn/docx/TOKEN`）
- 希望发布的平台及顺序（如：懂车号、汽车之家、百家号、易车）

## 核心规则

1. **标题分配**：按用户给出的平台顺序依次使用「主标题、备用标题1、备用标题2…」。
   飞书文档结构：文档标题=主标题；正文开头会重复一次主标题（提取时删除），随后"备选标题："块列出备用标题1..N。
2. **正文**：发布前必须删除正文开头的重复「主标题」（文档正文第一行现在会重复主标题）和「备选标题」块。**统一在复制后的中转 HTML 中删除，不再粘贴到编辑器后删除**，避免误删正文/占位符。
3. **发布模式**：默认直接发布（用户会明确选择；不可逆操作前必须向用户确认）。
4. **封面**：默认用文章里的图片，只有一张图时重复使用；平台有"自动获取/生成封面"功能时优先使用。
5. **声明/设置**：只设置平台标记必填的项；有「含AI生成内容」声明的平台选择该项；非必填项一律不动。
6. **运行模式**：发布/改标题脚本默认后台（headless）运行；如需观察浏览器操作，加 `--headed` 前台运行。**登录**是交互操作，登录助手始终有头打开；登录状态保存在 `发布工作区/平台登录状态.json`，新会话用 `--state` 恢复。
7. **过程中不明确的地方必须向用户提问，不要猜测意图。**
8. **Debug 规则**：涉及 Playwright 的 debug 必须用 `--headed` 有头执行；同一问题 debug 超过 3 次仍未解决时，通知用户并停止 debug。
9. **发布失败策略**：同一篇文章失败 3 次，先继续执行后续文章；直到所有剩余文章都失败后，再集中 debug。
10. **汇总格式**：发布完成后按 TSV（Tab 分隔）输出 `文档链接|平台|标题名称|发布链接`；文档链接重复行留空，发布链接未取得可留空。
11. **临时文件清理**：`发布工作区/<项目名>/articles` 目录可保留，但目录内文件属于单次会话临时产物，执行完成后应清空；`发布工作区` 根目录下除 `平台登录状态*.json` 外的其他 JSON 也应删除；项目目录内产生的 `clipboard_*`、`autohome_body.txt`、`*.log`、临时 JS/JSON 等非通用中间文件，按“项目目录内自行清理”处理，避免散落到根目录。
12. **搜索文章必须带日期**：所有从平台列表按标题搜索/定位文章的场景，必须同时用 `--date YYYY-MM-DD` 按日期过滤，避免匹配到同名旧文章。
13. **脚本报 FAIL ≠ 真的没发出去**：平台侧偶发「点完发布不跳转」「发布按钮一度不可用」，但文章其实已提交。
    因此**最终状态一律以各平台「作品管理列表」按「标题 + 当天日期」核实为准**，不要只信脚本退出码。
    实测：懂车号某篇脚本报 FAIL，列表里其实已「已发布」；若据此重发会产生重复文章。
    补发前必须先查列表，只补真正缺失的篇目。
14. **并发策略**：**不同平台可并发，同一平台必须串行**。每个平台起一个 worker 进程，进程内按篇串行。
    实测 4 个平台同时跑可把总时长压到约 1/3。`--headed` 仅用于 debug：有头时系统剪贴板是共享的，
    并发会互相覆盖；无头模式下 Chromium 剪贴板是进程内的，平台之间互不影响，
    因此 `acquireClipboardLock()` 在无头时自动退化为空操作（有头才真正加锁）。
15. **图片不要依赖飞书签名 URL**：飞书剪贴板里的 `<img src>` 是**签名地址，有效期约 1 小时**
    （URL 内含 `_<起始ts>:<结束ts>_`）。按中转文件离线发布时跨小时会失效。
16. **等待要用状态判定，不要靠拉长超时**：判定「图片上传完成」应检查**编辑器里的图片是否已不再是
    `data:`/`blob:` 且已加载**（`waitForImagesUploaded`），不要写死平台 CDN 域名——实测 headless 下懂车帝
    转存到 `byteimg.com`、headed 下是 `dcdapp.com`，写死域名会永远等不到。

## 中转文件与图片（重要）

`generate_intermediate.js` 产出的 `正文_clean.html` 是后续所有平台粘贴的来源，处理时注意：

- **删除「备选标题」块要按块删，不能按区间删**：旧实现是「从『备选标题』删到下一个 `<h1-6>` 或『一、』」，
  当文档结构是 `[备选标题块][开头段落][一、xxx]` 时会把**开头段落一起删掉**。现已改为按顶层块删除
  （`removeAltBlockFromHtmlCore`）。生成中转文件后**务必校验开头段落还在**。
- **图片建议 base64 内嵌**：把图片压到 ~300KB（最长边 1600、JPEG q85）后内嵌 `正文_clean.html`，
  既避开签名 URL 过期，又满足平台单图体积限制。参考项目内 `prepare_articles.py` 的做法。
  `compress_images.py` 只压到 5MB 上限，用于**本地上传**的平台（汽车之家）足够，但不适合内嵌。
- 各平台对 `<img>` 的处理不同：汽车之家换成 `【图N】` 占位符再本地上传；
  懂车号同样走占位符 + **编辑器自带图片上传**（见 platforms/dongchedi.md，不要依赖粘贴内嵌图）；
  百家号/易车由编辑器自行转存。

## 快速执行骨架（多平台并发）

```bash
# 1) 提取 + 生成中转文件
python3 scripts/common/extract_feishu.py <URL> "…/articles/<编号>"
node   scripts/common/generate_intermediate.js --doc-url <URL> --workdir "…/articles/<编号>"
# 2) 压缩图片 + base64 内嵌（参考项目内 prepare_articles.py）
# 3) 含表格的文章生成表格图片版（不支持表格的平台用 _tableimg 目录）
node scripts/common/table_to_image.js --workdir "…/articles/<编号>"
# 4) 每个平台一个 worker 并发，平台内串行
bash run_platform.sh dongchedi 1 2 3 4 5 6 7 8 &
bash run_platform.sh autohome  1 2 3 4 5 6 7 8 &
bash run_platform.sh baijiahao 1 2 3 4 5 6 7 8 &
bash run_platform.sh yiche     1 2 3 4 5 6 7 8 &
wait
# 5) 回各平台列表按「标题+当天日期」核实，再产出 TSV 汇总
```


## 环境准备（Linux）

- 依赖安装（一次性）：
  ```bash
  cd article-publisher
  npm install playwright
  npx playwright install chromium
  ```
- 浏览器：脚本直接调用本地 Playwright，默认后台（headless）启动 Chromium；加 `--headed` 可前台显示浏览器（需要图形环境/WSLg；`DISPLAY` 已设置时可用）。
- 飞书 token：`python3 scripts/common/extract_feishu.py --auth` 触发 OAuth 授权（授权链接给用户点），token 保存到本 skill 目录。
  - token 有效期约 2 小时，过期后 `extract_feishu.py` 会提示「Token 已过期」并自动走授权流程。
  - ⚠️ **回调可能收不到**：本机浏览器授权后若一直卡在「等待授权」，说明 `http://localhost:8080/callback`
    的回调没打到达（实测会遇到）。此时**让用户把浏览器地址栏里的 `code=` 值贴出来**，然后手工换取 token：
    `app_access_token`（`/open-apis/auth/v3/app_access_token/internal`）→
    `oidc/access_token`（`/open-apis/authen/v1/oidc/access_token`，body `{grant_type:'authorization_code', code}`），
    把返回的 `data.access_token` 写进 `scripts/feishu_tokens.json` 的 `user_token` 即可。
    注意 code **只能用一次且有时效**，拿到就立刻换。
  - 端口冲突：上一次授权进程没退干净会占着 8080，导致新的授权流程 `Address already in use`；
    先 `ss -ltnp | grep 8080` 找到 PID 杀掉再重试。

- 工作目录：`发布工作区/` 固定位于 **DSH 工作区根目录**（本机为 `/home/zzk/geo/发布工作区`），**不是 skill 文件根目录**。目录按项目隔离，推荐结构如下：
  ```text
  发布工作区/
  ├── 平台登录状态*.json            # 通用登录态，跨项目复用，放在根目录
  └── <项目名>/                     # 项目目录：本次发布的所有非通用中间文件都放这里
      ├── title_mapping.json        # 可选：本次多平台标题分配/映射
      ├── 发布汇总.tsv / .md        # 本次发布结果汇总
      └── articles/                 # 单次会话文章临时目录
          └── <编号>/
              ├── article.json
              ├── 正文_clean.html
              ├── 正文_clean.txt
              ├── 正文_纯文本.txt
              ├── 正文_markdown.md
              ├── 图片N.png
              └── validation.json
  ```

> 路径约定：上述 `发布工作区` 始终指 DSH 工作区根目录下的 `/home/zzk/geo/发布工作区`。脚本默认路径已按该根目录计算；如果从 skill 目录手动运行脚本，不要用相对 `发布工作区` 直接在 skill 目录下创建文件，应使用 `../../../发布工作区` 或绝对路径。

## 文档来源

- 飞书：`python3 scripts/common/extract_feishu.py <飞书URL> "/home/zzk/geo/发布工作区/<项目名>/articles/<编号>"`
- 腾讯文档：`python3 scripts/common/extract_tencent_docs.py <腾讯文档URL> "/home/zzk/geo/发布工作区/<项目名>/articles/<编号>"`
  - 输出结构与飞书提取器一致（article.json / 正文_clean.html / 正文_clean.txt / 图片N），后续平台发布流程相同。
  - 两个提取器均支持表格提取：`article.json` 中保存为 `type: "table"`，`正文_clean.html` 输出通用 `<table>`，`正文_clean.txt` 输出 `|` 分隔纯文本。
  - 提取完成后均生成 `validation.json`，比对提取正文与原始文档内容，防止截断。

## 执行流程

### 第 1 步：创建项目目录 → 提取文章并生成中转文件

先确定本次发布所属的“项目名/任务名”（例如 `示例项目B`、`示例项目C-约稿`、`示例项目B`）。用户未明确给出时，**必须询问用户，不要猜测**。

确认项目名后，先创建项目目录：

```bash
mkdir -p "/home/zzk/geo/发布工作区/<项目名>/articles/<编号>"
```

本次发布的所有非通用中间文件都放在 `发布工作区/<项目名>/` 下；平台登录状态 `平台登录状态*.json` 属于可复用通用文件，仍放在 `发布工作区/` 根目录。

然后提取文章并生成中转文件（注意 `--workdir` 要带 `<项目名>`）：

```bash
python3 scripts/common/extract_feishu.py <飞书文档URL或token> "/home/zzk/geo/发布工作区/<项目名>/articles/18"
node scripts/common/generate_intermediate.js --doc-url "<飞书文档URL>" --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/18" [--state "/home/zzk/geo/发布工作区/平台登录状态.json"]
```

- `extract_feishu.py` 产出 `article.json`、`正文_纯文本.txt`、`正文_markdown.md`、`正文_clean.html/.txt`（初版）、`图片N.png`、`validation.json`。
- `generate_intermediate.js` 用浏览器剪贴板重新生成/覆盖 `正文_clean.html` / `正文_clean.txt`（更贴近飞书实际富文本，并删除正文第一行重复主标题与备选标题），后续所有平台发布都从这里读取，不再逐平台打开飞书。
- `articles/<编号>/` 是单篇/单次会话临时目录，会话结束后清空该目录内文件；项目目录可保留标题映射、汇总等需要留档的文件。

token 失效时运行 `python3 scripts/common/extract_feishu.py --auth` 重新授权。

### 第 2 步：确认发布计划

向用户确认（本会话已验证的默认值，可沿用但首次必须确认）：
1. 平台及顺序（决定标题分配：平台1=主标题，平台2=备用标题1，…）
2. 直接发布 or 存草稿
3. 封面策略：默认复用文章图片
4. 检查登录状态：逐平台打开管理页确认免登录；未登录→让用户手动登录→保存 state

### 第 3 步：登录平台（Linux）

每个平台首次使用前，用登录助手打开浏览器并保存登录状态。各平台登录入口、state 文件名见对应 playbook。

```bash
node scripts/common/login.js --url "<平台管理页URL>" --state "/home/zzk/geo/发布工作区/平台登录状态-<平台>.json"
```

用户在打开的浏览器窗口中手动登录；脚本检测到登录成功后自动保存 state。

### 第 4 步：逐平台发布

**优先使用固化脚本**（`scripts/<平台>/publish_<平台>.js`）。通用参数：

- `--title`：该平台使用的标题
- `--doc-url`：飞书文档 URL（保留用于兜底/记录）
- `--state`：该平台登录状态文件
- `--image`：文章图片路径
- `--workdir`：`发布工作区/<项目名>/articles/<编号>`（存在 `正文_clean.html` 时脚本会直接使用本地中转文件，不再打开飞书）

> ⚠️ 不要直接复制 `正文_clean.html` 的**源码文本**到平台编辑器，那样剪贴板里只有 `text/plain`，平台会把 `<p>`、`<h2>` 等标签当纯文本显示。必须通过脚本的 `setClipboardFromIntermediate` 写入剪贴板：它会把 HTML 写入 `text/html`、纯文本写入 `text/plain`，富文本编辑器才能按富文本粘贴。

### 表格处理

文章里的表格可能遇到两种情况：平台编辑器支持富文本表格，或只支持图片/纯文本。

**通用判断平台是否支持表格：**

1. 优先看对应 `platforms/<平台>.md` 中记录的 `table_support` 字段；未记录时不要默认支持。
2. 界面判断：编辑器工具栏有没有“插入表格”入口；如果编辑器内核是 Quill / ProseMirror / UEditor / Draft.js 等，还要确认它是否启用了表格插件。
3. 实测判断（最可靠）：
   - 把含 `<table>` 的 `正文_clean.html` 用脚本粘贴到编辑器；
   - 在编辑态检查 DOM 是否仍存在 `table` 元素；
   - 保存草稿/预览后重新打开，确认表格没有被转成纯文本或丢失。
4. 发布端为准：编辑态支持不等于发布端一定保留，最终以草稿/预览/已发布页面为准。

**平台不支持表格，或不想降级成 `|` 纯文本时：**

先生成“表格图片版”工作目录，再发布时把 `--workdir` 指向它：

```bash
node scripts/common/table_to_image.js \
  --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/<编号>"

# 输出目录默认为 <编号>_tableimg，发布时使用：
node scripts/<平台>/publish_<平台>.js \
  --title "<标题>" \
  --doc-url "<文档URL>" \
  --state "/home/zzk/geo/发布工作区/平台登录状态.json" \
  --workdir "/home/zzk/geo/发布工作区/<项目名>/articles/<编号>_tableimg"
```

`table_to_image.js` 会：

- 把每个 `table` 块渲染成 `表格N.png`；
- 生成新的 `article.json`，将原表格块替换为图片块；
- 保持图片在正文中的插入顺序；
- 不改动原 workdir。

> 说明：今日头条经实测**支持富文本表格粘贴**；但如果你选择走“纯文本正文 + 本地插图”的发布管线，也应使用表格图片版，避免表格被压成 `|` 纯文本。

每个平台的精确命令、字段限制、必填项和坑位见对应 playbook。

**脚本失败时的兜底**：按 `platforms/<平台名>.md` playbook 人工执行。

### 第 5 步：验证与汇报

每个平台发布后回到其内容管理列表，确认新文章存在、状态正确（审核中/已发布），最后按固定 TSV 格式汇总：
`文档链接\t平台\t标题名称\t发布链接`（文档链接重复行留空，发布链接未取得可留空）。

### 第 6 步（可选）：Reviewbench 发布回填

> 回填时机：应在**最终汇总阶段**统一执行，不要在平台发布过程中途逐篇回填。先完成全部平台发布、收集最终发布链接，再一次性回填。

完成平台发布并准备最终汇总时，**询问用户是否需要调用 `/reviewbench-article-ops` 进行发布回填**：

1. 如果用户需要，先向用户确认对应 **项目名/任务名**（例如 `示例项目C-约稿`、`示例项目B` 等）；
2. 加载并遵循 `reviewbench-article-ops` skill；
3. 进入指定项目任务的「文章列表」，找到状态为「待发布」的文章；
4. 按该 skill 的发布回填流程，将本次已发布平台及发布链接填入；
5. 回填完成后回到 article-publisher 流程，输出最终 TSV 汇总。

> 如果用户没有发布回填需求，或没有可用的 reviewbench 项目名，则跳过该步骤。

## 平台注册表

| 平台 | playbook | 表格支持 | 说明 |
|---|---|---|---|
| 懂车号 | [platforms/dongchedi.md](./platforms/dongchedi.md) | ❌ | 直接发布 |
| 汽车之家 | [platforms/autohome.md](./platforms/autohome.md) | ❌ | 直接发布，图片走弹窗上传 |
| 百家号 | [platforms/baijiahao.md](./platforms/baijiahao.md) | ✅ | 直接发布/存草稿，每日限15篇 |
| 易车 | [platforms/yiche.md](./platforms/yiche.md) | ❌ | 直接发布 |
| 今日头条 | [platforms/toutiao.md](./platforms/toutiao.md) | ✅ | 懂车号同步后改标题，不重复发文|
| 搜狐号 | [platforms/sohu.md](./platforms/sohu.md) | ✅ | 直接发布/存草稿，有每日配额 |
| 知乎 | [platforms/zhihu.md](./platforms/zhihu.md) | ✅ | 默认“存草稿→从草稿发布”，连续发布间隔≥10分钟；直接发布仅在用户明确要求时使用 |
| 淘江湖 | [platforms/taohu.md](./platforms/taohu.md) | ✅ | 直接发布/审核，有每日上限 |
| 东方财富 | [platforms/eastmoney.md](./platforms/eastmoney.md) | ❌ | 直接发布/草稿，单图最大5MB |
| 企鹅号 | [platforms/qiehao.md](./platforms/qiehao.md) | ✅ | 直接发布/存草稿，每日限5篇，正文图片本地上传 |

## 相关文档

- 通用定位/操作技巧：[定位思路.md](./定位思路.md)
- 新增平台模板：[platforms/_template.md](./platforms/_template.md)
- 发布回填（可选）：按 `reviewbench-article-ops` skill 执行
- 平台特殊规则、脚本用法、坑位：见上表各平台 playbook

## 新增平台

1. 复制 [platforms/_template.md](./platforms/_template.md) 为 `platforms/<平台名>.md`
2. 按模板逐项填写（用 playwright snapshot/eval 探索真实 UI，记录 refs 与坑位）
3. 复制 `scripts/dongchedi/publish_dongchedi.js` 为 `scripts/<平台>/publish_<平台>.js`，按模板脚本改：
   - `PUBLISH_URL` / 成功跳转 URL
   - 标题输入选择器与填写方式
   - 正文粘贴目标（是否 iframe）
   - 必填项流程（封面/声明，含坑位规避）
   - 发布按钮与验证
4. 在本文件「平台注册表」加一行
5. 实测发布一篇验证 playbook 与脚本都有效

## Windows 旧版差异（仅记录）

- 旧版依赖 `powershell`/`set_clipboard.ps1` 做 CF_HTML 剪贴板；Linux 版改用浏览器 `navigator.clipboard`。
- 旧版依赖 `playwright-cli` 做有头浏览器与 state 管理；Linux 版用 `node scripts/common/login.js` 保存 state。
- 路径分隔符由 `\` 改为 `/`；Python 命令统一为 `python3`。
