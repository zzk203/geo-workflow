# IMA 知识库文档下载流程

## 一、凭证配置

### 1.1 获取凭证

访问 https://ima.qq.com/agent-interface 获取 **Client ID** 和 **API Key**。

### 1.2 存储凭证（Windows）

凭证文件存放在 `~/.config/ima/` 目录下：

```
C:\Users\<用户名>\.config\ima\
├── client_id    (纯文本，无换行)
└── api_key      (纯文本，无换行)
```

`ima_api.cjs` 脚本的加载优先级：环境变量 `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY` → 配置文件。

### 1.3 PowerShell 中读取凭证

```powershell
$clientId = (Get-Content "$env:USERPROFILE\.config\ima\client_id" -Raw).Trim()
$apiKey   = (Get-Content "$env:USERPROFILE\.config\ima\api_key" -Raw).Trim()
```

---

## 二、API 基础信息

| 项目 | 值 |
|------|-----|
| Base URL | `https://ima.qq.com` |
| 知识库 API 路径前缀 | `/openapi/wiki/v1/` |
| 请求方式 | HTTP POST + JSON Body |
| 环境要求 | PowerShell 7+（PS 5.1 需额外 UTF-8 字节数组处理） |

### 2.1 认证 Headers（每次请求必须携带）

```powershell
$headers = @{
    "ima-openapi-clientid" = $clientId
    "ima-openapi-apikey"   = $apiKey
    "Content-Type"         = "application/json"
}
```

### 2.2 响应格式

```json
{
  "code": 0,       // 0=成功, 非0=失败
  "msg": "success",
  "data": { ... }
}
```

### 2.3 关键错误码

| 错误码 | 含义 | 处理 |
|--------|------|------|
| 0 | 成功 | — |
| 110001 | 参数非法 | 检查参数 |
| 110021 | 请求频控 | 降低频率重试 |
| 110030 | 无权限 | 确认权限 |
| 220021 | 资料获取次数达上限 | 等明天重试 |

---

## 三、核心流程（4 步）

```
Step 1: search_knowledge_base  →  按名称搜索知识库，获取 kb_id
Step 2: get_knowledge_list     →  遍历知识库目录树，获取所有文件的 media_id
Step 3: get_media_info         →  根据 media_id 获取文件下载 URL
Step 4: Invoke-WebRequest      →  下载文件到本地
```

---

## 四、API 详解

### 4.1 搜索知识库 — `search_knowledge_base`

**接口**：`POST /openapi/wiki/v1/search_knowledge_base`

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词，传 `""` 列出所有知识库 |
| cursor | string | 是 | 首次传 `""`，翻页用 `next_cursor` |
| limit | uint64 | 是 | 1-20 |

**返回字段** (`data.info_list[]`)：

| 字段 | 说明 |
|------|------|
| kb_id | 知识库 ID（后续所有操作都依赖此 ID）|
| kb_name | 知识库名称 |
| content_count | 文件总数 |
| base_type | "共享知识库" / "个人知识库" |

**PowerShell 示例**：

```powershell
$body = @{ query = "示例项目B"; cursor = ""; limit = 20 } | ConvertTo-Json
$result = Invoke-RestMethod -Uri "https://ima.qq.com/openapi/wiki/v1/search_knowledge_base" `
    -Method Post -Body $body -ContentType "application/json; charset=utf-8" -Headers $headers
$kbId = $result.data.info_list[0].kb_id
```

---

### 4.2 浏览知识库内容 — `get_knowledge_list`

**接口**：`POST /openapi/wiki/v1/get_knowledge_list`

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| knowledge_base_id | string | 是 | 知识库 ID |
| cursor | string | 是 | 首次传 `""` |
| limit | uint64 | 是 | 1-50 |
| folder_id | string | 否 | 省略=根目录；传 `"folder_xxx"` 进入子文件夹 |

**返回字段** (`data.knowledge_list[]`)：

| 字段 | 说明 |
|------|------|
| media_id | 媒体 ID（文件以下载类型前缀开头如 `pdf_`，文件夹以 `folder_` 开头）|
| title | 文件/文件夹名称 |
| media_type | 类型枚举（见下表） |
| parent_folder_id | 父文件夹 ID |

**media_type 常见值**：

| 值 | 类型 | 值 | 类型 |
|----|------|----|------|
| 1 | PDF | 7 | Markdown |
| 2 | 网页 | 9 | 图片 |
| 3 | Word | 13 | TXT |
| 4 | PPT | 14 | Xmind |
| 5 | Excel | 15 | 录音 |
| 99 | 文件夹 | — | — |

**PowerShell 示例**：

```powershell
$body = @{
    knowledge_base_id = $kbId
    cursor = ""
    limit = 50
    # folder_id = "folder_xxx"   # 浏览子文件夹时传入
} | ConvertTo-Json
$result = Invoke-RestMethod -Uri "https://ima.qq.com/openapi/wiki/v1/get_knowledge_list" `
    -Method Post -Body $body -ContentType "application/json; charset=utf-8" -Headers $headers

# 遍历结果：media_id 以 "folder_" 开头的是文件夹，需递归进入
foreach ($item in $result.data.knowledge_list) {
    if ($item.media_id -match '^folder_') {
        # 递归调用 get_knowledge_list，传入 folder_id = $item.media_id
    } else {
        # 是文件，记录 media_id 和 title 用于后续下载
    }
}
```

**分页**：`is_end=false` 时，用 `next_cursor` 作为下次请求的 `cursor`。

---

### 4.3 获取下载链接 — `get_media_info`

**接口**：`POST /openapi/wiki/v1/get_media_info`

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| media_id | string | 是 | 从 get_knowledge_list 获取的文件 media_id |

**返回字段** (`data`)：

| 字段 | 说明 |
|------|------|
| media_type | 媒体类型 |
| url_info.url | 文件下载 URL（核心字段） |
| url_info.headers | 下载时需附加的请求头（可能为空） |

**注意**：图片类文件每次调用 `get_media_info` 都会消耗额度，返回的 URL 通常是一次性的。

**PowerShell 示例**：

```powershell
$body = @{ media_id = "pdf_xxxx" } | ConvertTo-Json
$info = Invoke-RestMethod -Uri "https://ima.qq.com/openapi/wiki/v1/get_media_info" `
    -Method Post -Body $body -ContentType "application/json; charset=utf-8" -Headers $headers

if ($info.code -eq 0 -and $info.data.url_info.url) {
    $downloadUrl = $info.data.url_info.url
    # 下载时可能需要携带 url_info.headers
}
```

---

### 4.4 下载文件

```powershell
$dlHeaders = @{}
if ($info.data.url_info.headers) {
    $info.data.url_info.headers.PSObject.Properties | ForEach-Object {
        $dlHeaders[$_.Name] = $_.Value
    }
}
Invoke-WebRequest -Uri $downloadUrl -Headers $dlHeaders -OutFile "本地路径\文件名.pdf"
```

---

## 五、完整脚本模板

```powershell
# ============================================
# IMA 知识库文件批量下载脚本
# ============================================

# 1. 加载凭证
$clientId = (Get-Content "$env:USERPROFILE\.config\ima\client_id" -Raw).Trim()
$apiKey   = (Get-Content "$env:USERPROFILE\.config\ima\api_key" -Raw).Trim()
$headers  = @{
    "ima-openapi-clientid" = $clientId
    "ima-openapi-apikey"   = $apiKey
    "Content-Type"         = "application/json"
}

# 2. 搜索知识库
$keyword = "示例项目B"   # 修改为你要搜索的知识库名称
$body = @{ query = $keyword; cursor = ""; limit = 20 } | ConvertTo-Json
$result = Invoke-RestMethod -Uri "https://ima.qq.com/openapi/wiki/v1/search_knowledge_base" `
    -Method Post -Body $body -ContentType "application/json; charset=utf-8" -Headers $headers
# 从结果中选取目标知识库的 kb_id
$kbId = $result.data.info_list[0].kb_id

# 3. 递归收集所有文件（media_id → local_path 映射）
$allFiles = [System.Collections.ArrayList]::new()

function Explore-Folder($folderId, $localPath) {
    param($folderId, $localPath)
    $body = @{
        knowledge_base_id = $kbId
        cursor = ""
        limit = 50
    }
    if ($folderId) { $body.folder_id = $folderId }
    $body = $body | ConvertTo-Json

    $result = Invoke-RestMethod -Uri "https://ima.qq.com/openapi/wiki/v1/get_knowledge_list" `
        -Method Post -Body $body -ContentType "application/json; charset=utf-8" -Headers $headers

    foreach ($item in $result.data.knowledge_list) {
        if ($item.media_id -match '^folder_') {
            # 递归进入子文件夹
            $subPath = Join-Path $localPath $item.title
            Explore-Folder $item.media_id $subPath
        } else {
            # 记录文件
            $global:allFiles.Add(@{
                media_id = $item.media_id
                title    = $item.title
                path     = $localPath
            }) | Out-Null
        }
    }

    # 处理分页
    if (-not $result.data.is_end) {
        Explore-Folder $folderId $localPath $result.data.next_cursor
    }
}

# 4. 下载所有文件
$baseDir = "C:\目标目录"
foreach ($f in $allFiles) {
    $outDir = Join-Path $baseDir $f.path
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    $body = @{ media_id = $f.media_id } | ConvertTo-Json
    $info = Invoke-RestMethod -Uri "https://ima.qq.com/openapi/wiki/v1/get_media_info" `
        -Method Post -Body $body -ContentType "application/json; charset=utf-8" -Headers $headers

    if ($info.code -eq 0 -and $info.data.url_info.url) {
        $dlHeaders = @{}
        if ($info.data.url_info.headers) {
            $info.data.url_info.headers.PSObject.Properties | ForEach-Object {
                $dlHeaders[$_.Name] = $_.Value
            }
        }
        $outPath = Join-Path $outDir $f.title
        Invoke-WebRequest -Uri $info.data.url_info.url -Headers $dlHeaders -OutFile $outPath
        Write-Host "OK: $($f.title)"
    } else {
        Write-Host "SKIP: $($f.title) — code=$($info.code) msg=$($info.msg)"
    }
}
```

---

## 六、注意事项

1. **频率限制**：`get_media_info` 有调用次数上限（错误码 220021），达到上限后需等第二天重试。大量文件建议分批下载。

2. **文件夹识别**：`media_id` 以 `folder_` 开头的是文件夹，需递归调用 `get_knowledge_list` 传入 `folder_id` 进入子目录。

3. **文件命名**：文件标题（`title`）即原始文件名，直接用作本地文件名即可。

4. **根目录 folder_id**：浏览根目录时不传 `folder_id` 参数。注意 `import_urls` 接口要求 `folder_id` 必填，此时根目录传 `knowledge_base_id` 的值。

5. **游标分页**：`get_knowledge_list` 每页最多 50 条，需通过 `is_end` 和 `next_cursor` 循环翻页。

6. **PowerShell 版本**：PS 7+ 直接使用 `Invoke-RestMethod`；PS 5.1 必须将 Body 转为 UTF-8 字节数组再发送。
