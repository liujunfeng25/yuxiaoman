[CmdletBinding()]
param(
  [switch]$KeepDatabase
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$StateFile = Join-Path $RuntimeDir "handoff-processes.json"
$ComposeFile = Join-Path $PSScriptRoot "docker-compose.yml"
$TransferEnv = Join-Path $PSScriptRoot "transfer.env"

function Stop-RecordedProcess($Entry, [string]$Name) {
  if (-not $Entry -or -not $Entry.Pid) { return }
  $process = Get-Process -Id ([int]$Entry.Pid) -ErrorAction SilentlyContinue
  if (-not $process) {
    Write-Host "$Name 已停止。"
    return
  }

  $recordedStart = [DateTime]::Parse([string]$Entry.StartTimeUtc).ToUniversalTime()
  $actualStart = $process.StartTime.ToUniversalTime()
  if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 3) {
    Write-Warning "$Name 的 PID 已被其他程序复用，为安全起见未终止该进程。"
    return
  }

  & taskkill.exe /PID $process.Id /T /F *> $null
  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    throw "无法停止 $Name（PID $($process.Id)）。"
  }
  Write-Host "已停止 $Name。"
}

if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
  $State = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  Stop-RecordedProcess $State.Admin "运营后台"
  Stop-RecordedProcess $State.Api "API"

  $ResolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir).TrimEnd('\') + '\'
  $ResolvedState = [System.IO.Path]::GetFullPath($StateFile)
  if (-not $ResolvedState.StartsWith($ResolvedRuntime, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "进程状态文件不在预期目录，拒绝删除。"
  }
  Remove-Item -LiteralPath $ResolvedState -Force
} else {
  Write-Host "未发现由 Start-All.ps1 记录的 API/后台进程。"
}

if (-not $KeepDatabase) {
  if ((Test-Path -LiteralPath $ComposeFile) -and (Test-Path -LiteralPath $TransferEnv) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
    & docker compose --project-name yuxiaoman-transfer --env-file $TransferEnv -f $ComposeFile stop db
    if ($LASTEXITCODE -ne 0) { throw "停止 PostgreSQL 容器失败。" }
    Write-Host "已停止 PostgreSQL；数据仍保存在 Docker 卷中。"
  }
} else {
  Write-Host "按 -KeepDatabase 参数保留 PostgreSQL 运行。"
}
