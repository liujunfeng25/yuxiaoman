[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$SkipRestore,
  [switch]$SkipLanConfigure,
  [switch]$ForceRestore,
  [string]$LanIp
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RepositoryEnv = Join-Path $ProjectRoot ".env"
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$LogDir = Join-Path $RuntimeDir "handoff-logs"
$StateFile = Join-Path $RuntimeDir "handoff-processes.json"
$RestoreScript = Join-Path $PSScriptRoot "Restore-Database.ps1"
$ConfigureScript = Join-Path $PSScriptRoot "Configure-Target.ps1"

function Get-RepositorySetting([string]$Name, [string]$DefaultValue = "") {
  foreach ($rawLine in [System.IO.File]::ReadAllLines($RepositoryEnv)) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $parts = $line.Split(@("="), 2, [System.StringSplitOptions]::None)
    if ($parts.Count -eq 2 -and $parts[0].Trim() -eq $Name) {
      $value = $parts[1].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        return $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }
  return $DefaultValue
}

function Invoke-Npm([string[]]$Arguments) {
  & $script:NpmPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm 命令失败（退出码 $LASTEXITCODE）。"
  }
}

function Wait-Http([string]$Url, [int]$Seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) { return $true }
    } catch {
      Start-Sleep -Milliseconds 750
    }
  }
  return $false
}

function Stop-Tree([System.Diagnostics.Process]$Process) {
  if ($Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F *> $null
  }
}

if (-not (Test-Path -LiteralPath $RepositoryEnv -PathType Leaf)) {
  throw "缺少项目 .env；迁移包不完整，请重新复制加密包。"
}

$NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$DockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $NodeCommand) { throw "未找到 Node.js。请安装 Node.js 24 x64。" }
if (-not $NpmCommand) { throw "未找到 npm.cmd。请重新安装 Node.js 24 x64。" }
if (-not $DockerCommand) { throw "未找到 Docker。请安装并启动 Docker Desktop。" }
$script:NpmPath = $NpmCommand.Source

$NodeVersionText = (& $NodeCommand.Source --version).Trim()
if ($NodeVersionText -notmatch '^v(?<major>\d+)\.') { throw "无法识别 Node.js 版本：$NodeVersionText" }
$NodeMajor = [int]$Matches.major
if ($NodeMajor -lt 24) { throw "当前是 $NodeVersionText；本迁移包要求 Node.js 24 或更高版本。" }
if ($NodeMajor -gt 24) { Write-Warning "当前是 $NodeVersionText；项目已按 Node.js 24 验证。若安装依赖失败，请切换到 Node.js 24 LTS。" }

& $DockerCommand.Source info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker Desktop 尚未启动，或当前用户无法连接 Docker。" }

if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
  try {
    $oldState = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $live = @($oldState.Api.Pid, $oldState.Admin.Pid) | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    if ($live.Count -gt 0) {
      throw "API/后台似乎已经启动。请先运行 .\Stop-All.ps1，再重新启动。"
    }
  } catch [System.Management.Automation.RuntimeException] {
    throw
  } catch {
    Write-Warning "旧的进程状态文件不可读，将重新生成。"
  }
}

if (-not $SkipLanConfigure) {
  if ($LanIp) {
    & $ConfigureScript -LanIp $LanIp
  } else {
    & $ConfigureScript
  }
}

if (-not $SkipRestore) {
  if ($ForceRestore) {
    & $RestoreScript -Force
  } else {
    & $RestoreScript
  }
}

if (-not $SkipInstall) {
  Write-Host "正在按锁文件安装项目依赖..."
  Push-Location $ProjectRoot
  try {
    Invoke-Npm @("ci", "--no-audit", "--no-fund")
    $MiniPackage = Join-Path $ProjectRoot "wechat-miniprogram\package.json"
    $MiniLock = Join-Path $ProjectRoot "wechat-miniprogram\package-lock.json"
    if ((Test-Path -LiteralPath $MiniPackage) -and (Test-Path -LiteralPath $MiniLock)) {
      Invoke-Npm @("--prefix", "wechat-miniprogram", "ci", "--no-audit", "--no-fund")
    }
  } finally {
    Pop-Location
  }
}

$ApiPortText = Get-RepositorySetting "PORT" "8792"
if ($ApiPortText -notmatch '^\d{2,5}$' -or [int]$ApiPortText -gt 65535) {
  throw ".env 中 PORT 无效。"
}
$ApiPort = [int]$ApiPortText
if ($ApiPort -ne 8792) {
  throw "小程序当前固定访问 8792，但 .env 中 PORT=$ApiPort。请把两者统一后再启动。"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ApiOut = Join-Path $LogDir "api-$Timestamp.out.log"
$ApiErr = Join-Path $LogDir "api-$Timestamp.err.log"
$AdminOut = Join-Path $LogDir "admin-$Timestamp.out.log"
$AdminErr = Join-Path $LogDir "admin-$Timestamp.err.log"

$ApiProcess = $null
$AdminProcess = $null
try {
  Write-Host "正在后台启动 API..."
  $ApiProcess = Start-Process -FilePath $script:NpmPath -ArgumentList @("run", "api:mini") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $ApiOut -RedirectStandardError $ApiErr -PassThru
  if (-not (Wait-Http "http://127.0.0.1:$ApiPort/api/health" 45)) {
    throw "API 未在 45 秒内就绪。请查看 $ApiErr"
  }

  Write-Host "正在后台启动运营后台..."
  $PreviousApiTarget = [Environment]::GetEnvironmentVariable("YUXIAOMAN_API_TARGET", "Process")
  [Environment]::SetEnvironmentVariable("YUXIAOMAN_API_TARGET", "http://127.0.0.1:$ApiPort", "Process")
  try {
    $AdminProcess = Start-Process -FilePath $script:NpmPath -ArgumentList @("run", "admin:dev") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $AdminOut -RedirectStandardError $AdminErr -PassThru
  } finally {
    [Environment]::SetEnvironmentVariable("YUXIAOMAN_API_TARGET", $PreviousApiTarget, "Process")
  }
  if (-not (Wait-Http "http://127.0.0.1:5174" 45)) {
    throw "运营后台未在 45 秒内就绪。请查看 $AdminErr"
  }

  $State = [ordered]@{
    StartedAtUtc = [DateTime]::UtcNow.ToString("o")
    ProjectRoot = $ProjectRoot
    Api = [ordered]@{
      Pid = $ApiProcess.Id
      StartTimeUtc = $ApiProcess.StartTime.ToUniversalTime().ToString("o")
      Stdout = $ApiOut
      Stderr = $ApiErr
    }
    Admin = [ordered]@{
      Pid = $AdminProcess.Id
      StartTimeUtc = $AdminProcess.StartTime.ToUniversalTime().ToString("o")
      Stdout = $AdminOut
      Stderr = $AdminErr
    }
  }
  $State | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
} catch {
  if ($AdminProcess) { Stop-Tree $AdminProcess }
  if ($ApiProcess) { Stop-Tree $ApiProcess }
  throw
}

Write-Host ""
Write-Host "启动完成："
Write-Host "  API 健康检查：http://127.0.0.1:$ApiPort/api/health"
Write-Host "  运营后台：http://127.0.0.1:5174"
Write-Host "  小程序目录：$ProjectRoot\wechat-miniprogram"
Write-Host "日志目录：$LogDir"
Write-Host "停止服务：在本目录运行 .\Stop-All.ps1"
