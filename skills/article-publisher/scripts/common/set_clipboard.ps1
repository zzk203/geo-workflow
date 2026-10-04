# 将转换后的 HTML + 纯文本写入系统剪贴板（CF_HTML 格式，UTF-8 字节偏移）
# 用法: pwsh -File set_clipboard.ps1 -HtmlFile <html片段文件> -TxtFile <txt文件>
param(
    [Parameter(Mandatory=$true)][string]$HtmlFile,
    [Parameter(Mandatory=$true)][string]$TxtFile
)
$frag = [System.IO.File]::ReadAllText($HtmlFile)
$plain = [System.IO.File]::ReadAllText($TxtFile)

$headerTemplate = "Version:0.9`r`nStartHTML:0000000000`r`nEndHTML:0000000000`r`nStartFragment:0000000000`r`nEndFragment:0000000000`r`n"
$enc = [System.Text.Encoding]::UTF8
$headerLen = $enc.GetByteCount($headerTemplate)
$prefix = "<html><body><!--StartFragment-->"
$suffix = "<!--EndFragment--></body></html>"
$doc = $prefix + $frag + $suffix

$startHTML = $headerLen
$startFrag = $headerLen + $enc.GetByteCount($prefix)
$endFrag = $startFrag + $enc.GetByteCount($frag)
$endHTML = $headerLen + $enc.GetByteCount($doc)

$header = "Version:0.9`r`nStartHTML:{0:D10}`r`nEndHTML:{1:D10}`r`nStartFragment:{2:D10}`r`nEndFragment:{3:D10}`r`n" -f $startHTML, $endHTML, $startFrag, $endFrag
$cfhtml = $header + $doc

Add-Type -AssemblyName System.Windows.Forms
$obj = New-Object System.Windows.Forms.DataObject
$obj.SetText($cfhtml, [System.Windows.Forms.TextDataFormat]::Html)
$obj.SetText($plain, [System.Windows.Forms.TextDataFormat]::UnicodeText)
[System.Windows.Forms.Clipboard]::SetDataObject($obj, $true)
Write-Output "clipboard set: html=$($cfhtml.Length) chars, text=$($plain.Length) chars"
