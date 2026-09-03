[CmdletBinding()]
param(
  [string]$ProjectRoot,
  [string]$OutputRoot,
  [switch]$AllowLiveApiSnapshot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Get-EnvValue {
  param([string]$Path, [string]$Name, [string]$DefaultValue = "")
  foreach ($rawLine in [System.IO.File]::ReadAllLines($Path)) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $parts = $line.Split(@("="), 2, [System.StringSplitOptions]::None)
    if ($parts.Count -eq 2 -and $parts[0].Trim() -eq $Name) {
      $value = $parts[1].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        return $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }
  return $DefaultValue
}

function Set-EnvValue {
  param([string]$Path, [string]$Name, [string]$Value)
  $content = [System.IO.File]::ReadAllText($Path)
  $pattern = "(?m)^\s*" + [regex]::Escape($Name) + "\s*=.*$"
  $replacement = "$Name=$Value"
  if ([regex]::IsMatch($content, $pattern)) {
    $content = [regex]::Replace(
      $content,
      $pattern,
      [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement },
      1
    )
  }
  else {
    if ($content -and -not $content.EndsWith("`n")) { $content += "`r`n" }
    $content += "$replacement`r`n"
  }
  Write-Utf8NoBom $Path $content
}

function New-UrlSafePassword {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) }
  finally { $rng.Dispose() }
  try { return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_") }
  finally { [System.Array]::Clear($bytes, 0, $bytes.Length) }
}

function ConvertFrom-PostgresUrl {
  param([string]$DatabaseUrl, [string]$Name)
  if (-not $DatabaseUrl) { throw ".env 缺少 $Name。" }
  $uri = [Uri]$DatabaseUrl
  if ($uri.Scheme -notin @("postgres", "postgresql")) { throw "$Name 不是 PostgreSQL 地址。" }
  $userInfo = $uri.UserInfo.Split(@(":"), 2, [System.StringSplitOptions]::None)
  if ($userInfo.Count -lt 1 -or -not $userInfo[0]) { throw "$Name 缺少数据库用户。" }
  return [pscustomobject]@{
    Host = $uri.Host
    Port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    User = [Uri]::UnescapeDataString($userInfo[0])
    Password = if ($userInfo.Count -eq 2) { [Uri]::UnescapeDataString($userInfo[1]) } else { "" }
    Database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
  }
}

function Get-ToolPath {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $postgresRoot = Join-Path $env:ProgramFiles "PostgreSQL"
  if (Test-Path -LiteralPath $postgresRoot) {
    $candidate = Get-ChildItem -LiteralPath $postgresRoot -Directory | Sort-Object Name -Descending | ForEach-Object {
      Join-Path $_.FullName "bin\$Name"
    } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($candidate) { return $candidate }
  }
  throw "未找到 $Name；请安装 PostgreSQL 17 客户端工具。"
}

function Use-PgPassword {
  param([string]$Password, [scriptblock]$Action)
  $hadPrevious = Test-Path Env:PGPASSWORD
  $previous = if ($hadPrevious) { $env:PGPASSWORD } else { $null }
  try {
    $env:PGPASSWORD = $Password
    & $Action
  }
  finally {
    if ($hadPrevious) { $env:PGPASSWORD = $previous }
    else { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  }
}

function Invoke-PsqlScalar {
  param([string]$PsqlPath, $Connection, [string]$Database, [string]$Sql)
  $value = Use-PgPassword $Connection.Password {
    & $PsqlPath --no-password --host=$($Connection.Host) --port=$($Connection.Port) `
      --username=$($Connection.User) --dbname=$Database --tuples-only --no-align `
      --set=ON_ERROR_STOP=1 --command=$Sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL 查询失败。" }
  }
  return (($value | Out-String).Trim())
}

function Get-DatabaseSnapshot {
  param([string]$PsqlPath, $Connection, [string]$Database)
  $tableCount = Invoke-PsqlScalar $PsqlPath $Connection $Database `
    "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE';"
  $schemaCount = Invoke-PsqlScalar $PsqlPath $Connection $Database `
    "SELECT count(DISTINCT table_schema) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE';"
  return [ordered]@{ database = $Database; tableCount = [int64]$tableCount; schemaCount = [int64]$schemaCount }
}

function Assert-SnapshotsEqual {
  param($Expected, $Actual)
  if ($Expected.tableCount -ne $Actual.tableCount -or $Expected.schemaCount -ne $Actual.schemaCount) {
    throw "临时恢复数据库的表或 schema 数量与源数据库不一致。"
  }
}

function Assert-PathInside {
  param([string]$Parent, [string]$Child)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd("\") + "\"
  $childFull = [System.IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "路径不在预期目录内：$childFull"
  }
}

function Copy-Tree {
  param([string]$Source, [string]$Destination, [string[]]$ExtraExcludedDirectories = @())
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return }
  [void](New-Item -ItemType Directory -Path $Destination -Force)
  $excludedDirectories = @(
    "node_modules", "dist", ".runtime", ".git", ".agents", "test-results",
    "playwright-report", "coverage", ".vite", ".asset-preview", "test-debug",
    "output", "output-*", "rendered", "rendered-*"
  ) + $ExtraExcludedDirectories
  $arguments = @(
    $Source, $Destination, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1",
    "/XJ", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
    "/XF", "project.private.config.json", "transfer.env", "*.log", "*.tmp",
    "yuxiaoman.sqlite", "yuxiaoman.sqlite-shm", "yuxiaoman.sqlite-wal",
    "/XD"
  ) + $excludedDirectories
  & robocopy.exe @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制目录失败：$Source（robocopy 退出码 $LASTEXITCODE）" }
}

if (-not $ProjectRoot) { $ProjectRoot = Split-Path $PSScriptRoot -Parent }
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "AGENTS.md") -PathType Leaf)) {
  throw "ProjectRoot 不是驭小满项目目录：$ProjectRoot"
}
if (-not $OutputRoot) { $OutputRoot = Split-Path $ProjectRoot -Parent }
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
[void](New-Item -ItemType Directory -Path $OutputRoot -Force)

$sourceEnv = Join-Path $ProjectRoot ".env"
if (-not (Test-Path -LiteralPath $sourceEnv -PathType Leaf)) { throw "根目录缺少 .env。" }
$apiPort = Get-EnvValue $sourceEnv "PORT" "8792"
if (-not $AllowLiveApiSnapshot) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.BeginConnect("127.0.0.1", [int]$apiPort, $null, $null)
    $isListening = $connect.AsyncWaitHandle.WaitOne(500)
    if ($isListening) { try { $client.EndConnect($connect) } catch { $isListening = $false } }
  }
  finally { $client.Dispose() }
  if ($isListening) { throw "API 正在监听 $apiPort；如当前无上传操作，请加 -AllowLiveApiSnapshot。" }
}

$runtimeConnection = ConvertFrom-PostgresUrl (Get-EnvValue $sourceEnv "DATABASE_URL") "DATABASE_URL"
$testConnection = ConvertFrom-PostgresUrl (Get-EnvValue $sourceEnv "TEST_DATABASE_URL") "TEST_DATABASE_URL"
$pgDump = Get-ToolPath "pg_dump.exe"
$pgRestore = Get-ToolPath "pg_restore.exe"
$psql = Get-ToolPath "psql.exe"
$createdb = Get-ToolPath "createdb.exe"
$dropdb = Get-ToolPath "dropdb.exe"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "Yuxiaoman-Mac-Handoff-$stamp.zip"
$archivePath = Join-Path $OutputRoot $archiveName
$archiveHashPath = "$archivePath.sha256"
$temporaryRoot = Join-Path (Join-Path $ProjectRoot ".runtime") ("mac-transfer-build-" + [Guid]::NewGuid().ToString("N"))
$stagingRoot = Join-Path $temporaryRoot "staging"
$verificationRoot = Join-Path $temporaryRoot "verification"
$completed = $false
Assert-PathInside (Join-Path $ProjectRoot ".runtime") $temporaryRoot

if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $archiveHashPath)) {
  throw "输出文件已存在：$archivePath"
}

try {
  [void](New-Item -ItemType Directory -Path $stagingRoot -Force)
  Copy-Tree $ProjectRoot $stagingRoot
  Copy-Tree (Join-Path $ProjectRoot ".runtime\annual-demo-media") `
    (Join-Path $stagingRoot ".runtime\annual-demo-media")

  $databaseDirectory = Join-Path $stagingRoot "database"
  [void](New-Item -ItemType Directory -Path $databaseDirectory -Force)
  $databaseResults = @()
  $targets = @(
    [pscustomobject]@{ Label = "runtime"; Connection = $runtimeConnection; File = "yuxiaoman_dev.pgdump" },
    [pscustomobject]@{ Label = "test"; Connection = $testConnection; File = "yuxiaoman_test.pgdump" }
  )

  foreach ($target in $targets) {
    $connection = $target.Connection
    $dumpPath = Join-Path $databaseDirectory $target.File
    Write-Host "正在导出 $($target.Label) PostgreSQL 数据库……"
    Use-PgPassword $connection.Password {
      & $pgDump --no-password --host=$($connection.Host) --port=$($connection.Port) `
        --username=$($connection.User) --dbname=$($connection.Database) --format=custom `
        --compress=9 --no-owner --no-privileges --file=$dumpPath 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "$($target.Label) 数据库 pg_dump 失败。" }
    }
    $contents = @(& $pgRestore --list $dumpPath 2>&1)
    if ($LASTEXITCODE -ne 0 -or $contents.Count -eq 0) { throw "$($target.File) 无法被 pg_restore 读取。" }
    Write-Utf8NoBom (Join-Path $databaseDirectory ($target.File + ".contents.txt")) (($contents | Out-String).TrimEnd() + "`r`n")

    $sourceSnapshot = Get-DatabaseSnapshot $psql $connection $connection.Database
    $verificationDatabase = "yxm_mac_verify_" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
    try {
      Use-PgPassword $connection.Password {
        & $createdb --no-password --host=$($connection.Host) --port=$($connection.Port) `
          --username=$($connection.User) $verificationDatabase 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "无法创建数据库恢复校验库。" }
        & $pgRestore --no-password --host=$($connection.Host) --port=$($connection.Port) `
          --username=$($connection.User) --dbname=$verificationDatabase --exit-on-error `
          --no-owner --no-privileges $dumpPath 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "$($target.File) 无法完整恢复。" }
      }
      $restoredSnapshot = Get-DatabaseSnapshot $psql $connection $verificationDatabase
      Assert-SnapshotsEqual $sourceSnapshot $restoredSnapshot
    }
    finally {
      Use-PgPassword $connection.Password {
        & $dropdb --if-exists --force --no-password --host=$($connection.Host) --port=$($connection.Port) `
          --username=$($connection.User) $verificationDatabase 2>&1 | Out-Null
      }
    }
    $databaseResults += [ordered]@{ label = $target.Label; source = $sourceSnapshot; restored = $restoredSnapshot }
  }
  Write-Utf8NoBom (Join-Path $databaseDirectory "verification.json") `
    (([ordered]@{ verifiedAtUtc = [DateTime]::UtcNow.ToString("o"); databases = $databaseResults } | ConvertTo-Json -Depth 7) + "`r`n")

  # The source database may use local trust authentication and therefore have
  # no URL password. The Mac Docker database always receives a fresh, URL-safe
  # password. It remains plaintext inside the user-requested unencrypted ZIP.
  $targetDatabaseUser = "yuxiaoman"
  $targetDatabasePassword = New-UrlSafePassword
  $targetRuntimeUrl = "postgresql://${targetDatabaseUser}:$targetDatabasePassword@127.0.0.1:55432/yuxiaoman_dev"
  $targetTestUrl = "postgresql://${targetDatabaseUser}:$targetDatabasePassword@127.0.0.1:55432/yuxiaoman_test"
  $stagedEnv = Join-Path $stagingRoot ".env"
  Set-EnvValue $stagedEnv "DATABASE_URL" $targetRuntimeUrl
  Set-EnvValue $stagedEnv "TEST_DATABASE_URL" $targetTestUrl
  Set-EnvValue $stagedEnv "HOST" "127.0.0.1"
  Set-EnvValue $stagedEnv "PORT" "8792"
  Set-EnvValue $stagedEnv "VITE_API_BASE_URL" "http://127.0.0.1:8792/api"
  & (Get-Command node -ErrorAction Stop).Source (Join-Path $stagingRoot "handoff\macos\prepare-transfer-env.mjs") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Mac 数据库容器配置验证失败。" }
  Remove-Item -LiteralPath (Join-Path $stagingRoot "handoff\macos\transfer.env") -Force

  $reparsePoints = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($reparsePoints.Count -gt 0) { throw "暂存目录仍包含链接或重解析点，拒绝打包。" }

  $fileEntries = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($stagingRoot.TrimEnd("\").Length + 1).Replace("\", "/")
      length = $_.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    }
  })
  $manifest = [ordered]@{
    schemaVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString("o")
    target = "macOS (Apple Silicon or Intel)"
    packageType = "native WeChat mini-program + operations admin + API + PostgreSQL runtime/test snapshots + PPT"
    encrypted = $false
    includesPlaintextEnv = $true
    excludes = @(
      "Windows/macOS-incompatible node_modules", "Windows WeChat DevTools runtime",
      "build caches and logs", "legacy SQLite files", "WeChat project.private.config.json",
      "PPT intermediate render/output folders"
    )
    databases = $databaseResults
    files = $fileEntries
  }
  Write-Utf8NoBom (Join-Path $stagingRoot "MANIFEST.json") (($manifest | ConvertTo-Json -Depth 9) + "`r`n")
  $sumLines = $fileEntries | ForEach-Object { "$($_.sha256)  $($_.path)" }
  Write-Utf8NoBom (Join-Path $stagingRoot "SHA256SUMS.txt") (($sumLines -join "`n") + "`n")

  $required = @(
    ".env", "package-lock.json", "server\app.ts", "admin\package.json",
    "wechat-miniprogram\project.config.json", "database\yuxiaoman_dev.pgdump",
    "database\yuxiaoman_test.pgdump", "handoff\macos\start-all.sh",
    "deliverables\驭小满年检与维修报价业务闭环操作手册.pptx",
    ".runtime\annual-demo-media"
  )
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot $relative))) { throw "暂存包缺少：$relative" }
  }

  Write-Host "正在生成未加密 ZIP……"
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stagingRoot,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false,
    [System.Text.Encoding]::UTF8
  )
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "ZIP 生成失败。" }

  [void](New-Item -ItemType Directory -Path $verificationRoot -Force)
  [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $verificationRoot)
  foreach ($entry in $fileEntries) {
    $restoredPath = Join-Path $verificationRoot ($entry.path.Replace("/", "\"))
    if (-not (Test-Path -LiteralPath $restoredPath -PathType Leaf)) { throw "ZIP 缺少：$($entry.path)" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $restoredPath).Hash.ToLowerInvariant()
    if ($hash -ne $entry.sha256) { throw "ZIP 文件哈希不一致：$($entry.path)" }
  }

  $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  Write-Utf8NoBom $archiveHashPath "$archiveHash  $archiveName`r`n"
  $completed = $true
  Write-Host "完成：$archivePath"
  Write-Host "校验：$archiveHashPath"
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Assert-PathInside (Join-Path $ProjectRoot ".runtime") $temporaryRoot
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
  if (-not $completed) {
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    if (Test-Path -LiteralPath $archiveHashPath) { Remove-Item -LiteralPath $archiveHashPath -Force }
  }
}
