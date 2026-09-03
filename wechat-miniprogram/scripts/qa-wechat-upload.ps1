param(
  [Parameter(Mandatory = $true)]
  [string]$MsgId,

  [Parameter(Mandatory = $true)]
  [string]$Selector,

  [string]$DownloadsDirectory = 'C:\Users\Administrator\Downloads',
  [string]$Project = 'E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram',
  [string]$Client = 'yuxiaoman-qa',
  [string]$WechatIde = 'D:\微信web开发者工具\wechatide.cmd',
  [int]$PhotoServerPort = 9008
)

$ErrorActionPreference = 'Stop'

$photo = Get-ChildItem -LiteralPath $DownloadsDirectory -File |
  Where-Object { $_.Name -like "*MsgID=$MsgId*" } |
  Select-Object -First 1

if (-not $photo) {
  throw "No downloaded photo contains MsgID=$MsgId"
}

$encodedName = [Uri]::EscapeDataString($photo.Name)
$photoUrl = "http://127.0.0.1:$PhotoServerPort/$encodedName"
$functionDeclaration = "(options) => new Promise((resolve,reject) => wx.downloadFile({url:'$photoUrl',success:r => resolve({tempFiles:[{tempFilePath:r.tempFilePath,size:$($photo.Length),fileType:'image'}],type:'image',errMsg:'chooseMedia:ok'}),fail:reject}))"

& $WechatIde -c $Client automation_wx_api `
  --project $Project `
  --action mock `
  --method chooseMedia `
  --function-declaration $functionDeclaration
if ($LASTEXITCODE -ne 0) { throw "Failed to mock chooseMedia for MsgID=$MsgId" }

& $WechatIde -c $Client automation_element_action `
  --project $Project `
  --action tap `
  --selector $Selector
if ($LASTEXITCODE -ne 0) { throw "Failed to tap selector $Selector" }

Start-Sleep -Seconds 2

& $WechatIde -c $Client automation_wx_api `
  --project $Project `
  --action restore `
  --method chooseMedia
if ($LASTEXITCODE -ne 0) { throw 'Failed to restore chooseMedia' }

Write-Output "Uploaded MsgID=$MsgId through $Selector"
