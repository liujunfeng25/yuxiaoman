[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$ComposeFile = Join-Path $PSScriptRoot "docker-compose.yml"
$TransferEnv = Join-Path $PSScriptRoot "transfer.env"
$DumpFile = Join-Path $ProjectRoot "database\yuxiaoman_dev.pgdump"
$ContainerDump = "/tmp/yuxiaoman_dev.pgdump"

function Assert-File([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "缺少$Description：$Path"
  }
}

function Get-TransferSetting([string]$Name, [string]$DefaultValue = "") {
  foreach ($rawLine in [System.IO.File]::ReadAllLines($TransferEnv)) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $parts = $line.Split(@("="), 2, [System.StringSplitOptions]::None)
    if ($parts.Count -eq 2 -and $parts[0].Trim() -eq $Name) {
      return $parts[1].Trim()
    }
  }
  return $DefaultValue
}

function Assert-SafeIdentifier([string]$Value, [string]$Name) {
  if ($Value -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "$Name 不是安全的 PostgreSQL 标识符。请重新生成迁移包。"
  }
}

function Invoke-Docker([string[]]$Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Docker 命令执行失败（退出码 $LASTEXITCODE）。"
  }
}

Assert-File $ComposeFile "Docker Compose 配置"
Assert-File $TransferEnv "迁移数据库配置"
Assert-File $DumpFile "PostgreSQL 备份"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "未找到 Docker。请先安装并启动 Docker Desktop。"
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop 尚未启动，或当前用户无法连接 Docker。"
}

$DatabaseUser = Get-TransferSetting "POSTGRES_USER"
$DatabaseName = Get-TransferSetting "POSTGRES_DB"
$TestDatabaseName = "yuxiaoman_test"
$DatabasePort = Get-TransferSetting "POSTGRES_PORT" "55432"

Assert-SafeIdentifier $DatabaseUser "POSTGRES_USER"
Assert-SafeIdentifier $DatabaseName "POSTGRES_DB"
Assert-SafeIdentifier $TestDatabaseName "测试数据库名"
if ($DatabasePort -notmatch '^\d{2,5}$' -or [int]$DatabasePort -gt 65535) {
  throw "POSTGRES_PORT 无效。请重新生成迁移包。"
}

$Compose = @(
  "compose",
  "--project-name", "yuxiaoman-transfer",
  "--env-file", $TransferEnv,
  "-f", $ComposeFile
)

Write-Host "正在启动 PostgreSQL 17.9..."
Invoke-Docker (@($Compose) + @("up", "-d", "db"))

$Ready = $false
for ($attempt = 1; $attempt -le 45; $attempt++) {
  & docker @Compose exec -T db pg_isready -U $DatabaseUser -d $DatabaseName *> $null
  if ($LASTEXITCODE -eq 0) {
    $Ready = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $Ready) {
  throw "PostgreSQL 在 90 秒内未就绪。请运行 docker compose logs db 查看原因。"
}

$TableCountText = & docker @Compose exec -T db psql -X -U $DatabaseUser -d $DatabaseName -tAc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';"
if ($LASTEXITCODE -ne 0) { throw "无法检查目标数据库。" }
$TableCount = [int](($TableCountText | Out-String).Trim())

if ($TableCount -gt 0 -and -not $Force) {
  Write-Host "目标数据库已有 $TableCount 张业务表；为避免覆盖，已跳过恢复。"
  Write-Host "若确认要用迁移包覆盖目标数据，请单独运行：.\Restore-Database.ps1 -Force"
} else {
  if ($Force -and $TableCount -gt 0) {
    Write-Warning "-Force 将删除目标机数据库中的现有内容，并改用迁移备份。"
    $TerminateSql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DatabaseName' AND pid <> pg_backend_pid();"
    Invoke-Docker (@($Compose) + @("exec", "-T", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", $DatabaseUser, "-d", "postgres", "-c", $TerminateSql))
    Invoke-Docker (@($Compose) + @("exec", "-T", "db", "dropdb", "--if-exists", "-U", $DatabaseUser, $DatabaseName))
    Invoke-Docker (@($Compose) + @("exec", "-T", "db", "createdb", "-U", $DatabaseUser, $DatabaseName))
  }

  Write-Host "正在校验并恢复 PostgreSQL 备份..."
  Invoke-Docker (@($Compose) + @("cp", $DumpFile, "db:$ContainerDump"))
  Invoke-Docker (@($Compose) + @("exec", "-T", "db", "pg_restore", "--list", $ContainerDump))
  Invoke-Docker (@($Compose) + @(
    "exec", "-T", "db", "pg_restore",
    "--exit-on-error",
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "-U", $DatabaseUser,
    "-d", $DatabaseName,
    $ContainerDump
  ))
  Invoke-Docker (@($Compose) + @("exec", "-T", "db", "rm", "-f", $ContainerDump))

  $RestoredCountText = & docker @Compose exec -T db psql -X -U $DatabaseUser -d $DatabaseName -tAc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';"
  if ($LASTEXITCODE -ne 0) { throw "数据库已恢复，但最终校验失败。" }
  $RestoredCount = [int](($RestoredCountText | Out-String).Trim())
  if ($RestoredCount -le 0) { throw "恢复后未发现业务表，请勿启动应用。" }
  Write-Host "数据库恢复完成：已识别 $RestoredCount 张业务表。"
}

$TestExistsText = & docker @Compose exec -T db psql -X -U $DatabaseUser -d postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = '$TestDatabaseName';"
if ($LASTEXITCODE -ne 0) { throw "无法检查测试数据库。" }
if ([int](($TestExistsText | Out-String).Trim()) -eq 0) {
  Invoke-Docker (@($Compose) + @("exec", "-T", "db", "createdb", "-U", $DatabaseUser, $TestDatabaseName))
  Write-Host "已创建隔离的测试数据库 $TestDatabaseName。"
}

Write-Host "PostgreSQL 可用：127.0.0.1:$DatabasePort（仅本机访问）。"
