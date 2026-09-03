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

function Get-ChildFullPath {
  param([string]$Parent, [string]$Child)
  return [System.IO.Path]::GetFullPath((Join-Path $Parent $Child))
}

function Assert-PathInside {
  param([string]$Parent, [string]$Child)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd("\") + "\"
  $childFull = [System.IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "路径不在预期目录内：$childFull"
  }
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
  Write-Utf8NoBom -Path $Path -Content $content
}

function Get-ToolPath {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $postgresRoot = Join-Path $env:ProgramFiles "PostgreSQL"
  if (Test-Path -LiteralPath $postgresRoot) {
    $candidates = @(Get-ChildItem -LiteralPath $postgresRoot -Directory | Sort-Object Name -Descending | ForEach-Object {
      Join-Path $_.FullName "bin\$Name"
    } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($candidates.Count -gt 0) { return $candidates[0] }
  }
  throw "未找到 $Name；请安装 PostgreSQL 17 客户端工具。"
}

function ConvertFrom-PostgresUrl {
  param([string]$DatabaseUrl)
  if (-not $DatabaseUrl) { throw ".env 缺少 DATABASE_URL。" }
  $uri = [Uri]$DatabaseUrl
  if ($uri.Scheme -notin @("postgres", "postgresql")) {
    throw "DATABASE_URL 不是 PostgreSQL 地址。"
  }
  $userInfo = $uri.UserInfo.Split(@(":"), 2, [System.StringSplitOptions]::None)
  if ($userInfo.Count -lt 1 -or -not $userInfo[0]) {
    throw "DATABASE_URL 缺少数据库用户。"
  }
  $password = if ($userInfo.Count -eq 2) { [Uri]::UnescapeDataString($userInfo[1]) } else { "" }
  return [pscustomobject]@{
    Host = $uri.Host
    Port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    User = [Uri]::UnescapeDataString($userInfo[0])
    Password = $password
    Database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
  }
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

function Copy-Tree {
  param([string]$Source, [string]$Destination, [string[]]$ExtraExcludedDirectories = @())
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return }
  [void](New-Item -ItemType Directory -Path $Destination -Force)
  $excludedDirectories = @(
    "node_modules", "dist", ".runtime", "artifacts", "test-results",
    "playwright-report", ".asset-preview", ".vite", "coverage", ".git",
    ".codex", ".agents", "test-debug"
  ) + $ExtraExcludedDirectories
  $arguments = @(
    $Source, $Destination, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1",
    "/XJ", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XF",
    "project.private.config.json", "*.log", "*.tmp", "/XD"
  ) + $excludedDirectories
  & robocopy.exe @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "复制目录失败：$Source（robocopy 退出码 $LASTEXITCODE）"
  }
}

function Invoke-PsqlScalar {
  param(
    [string]$PsqlPath,
    $Connection,
    [string]$Database,
    [string]$Sql
  )
  $result = Use-PgPassword $Connection.Password {
    & $PsqlPath --no-password --host=$($Connection.Host) --port=$($Connection.Port) `
      --username=$($Connection.User) --dbname=$Database --tuples-only --no-align `
      --set=ON_ERROR_STOP=1 --command=$Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "PostgreSQL 校验查询失败。"
    }
  }
  return (($result | Out-String).Trim())
}

function Get-DatabaseSnapshot {
  param([string]$PsqlPath, $Connection, [string]$Database)
  $tables = @("users", "vehicles", "bookings", "booking_media", "wash_orders", "service_leads", "used_car_listings", "used_car_listing_images")
  $counts = [ordered]@{}
  foreach ($table in $tables) {
    $value = Invoke-PsqlScalar -PsqlPath $PsqlPath -Connection $Connection -Database $Database -Sql "SELECT count(*) FROM public.$table;"
    $counts[$table] = [int64]$value
  }
  $schemaVersion = Invoke-PsqlScalar -PsqlPath $PsqlPath -Connection $Connection -Database $Database -Sql "SELECT value FROM public.app_metadata WHERE key = 'schema-version';"
  $tableCount = Invoke-PsqlScalar -PsqlPath $PsqlPath -Connection $Connection -Database $Database -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
  return [ordered]@{
    schemaVersion = $schemaVersion
    tableCount = [int64]$tableCount
    counts = $counts
  }
}

function Assert-SnapshotsEqual {
  param($Expected, $Actual)
  if ($Expected.schemaVersion -ne $Actual.schemaVersion -or $Expected.tableCount -ne $Actual.tableCount) {
    throw "临时恢复数据库的结构版本或表数量与源数据库不一致。"
  }
  foreach ($name in $Expected.counts.Keys) {
    if ([int64]$Expected.counts[$name] -ne [int64]$Actual.counts[$name]) {
      throw "临时恢复数据库的 $name 记录数与源数据库不一致。"
    }
  }
}

function New-UrlSafePassword {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) }
  finally { $rng.Dispose() }
  try {
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  }
  finally {
    [System.Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Protect-Payload {
  param(
    [string]$InputPath,
    [string]$OutputPath,
    [byte[]]$PasswordBytes
  )

  $iterations = 600000
  $salt = New-Object byte[] 32
  $iv = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($salt)
    $rng.GetBytes($iv)
  }
  finally {
    $rng.Dispose()
  }

  $derived = $null
  $encryptionKey = $null
  $authenticationKey = $null
  $partialPath = "$OutputPath.partial"
  try {
    $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
      $PasswordBytes,
      $salt,
      $iterations,
      [System.Security.Cryptography.HashAlgorithmName]::SHA256
    )
    try { $derived = $kdf.GetBytes(64) }
    finally { $kdf.Dispose() }
    $encryptionKey = New-Object byte[] 32
    $authenticationKey = New-Object byte[] 32
    [System.Buffer]::BlockCopy($derived, 0, $encryptionKey, 0, 32)
    [System.Buffer]::BlockCopy($derived, 32, $authenticationKey, 0, 32)

    $plainLength = [UInt64](Get-Item -LiteralPath $InputPath).Length
    $headerStream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($headerStream)
    try {
      $writer.Write([System.Text.Encoding]::ASCII.GetBytes("YXMBNDL1"))
      $writer.Write([byte]1)
      $writer.Write([byte]1)
      $writer.Write([byte]1)
      $writer.Write([byte]1)
      $writer.Write([UInt32]$iterations)
      $writer.Write([UInt64]$plainLength)
      $writer.Write($salt)
      $writer.Write($iv)
      $writer.Flush()
      $header = $headerStream.ToArray()
    }
    finally {
      $writer.Dispose()
      $headerStream.Dispose()
    }
    if ($header.Length -ne 72) { throw "内部加密文件头长度异常。" }

    $output = [System.IO.File]::Open($partialPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $input = [System.IO.File]::OpenRead($InputPath)
    $aes = [System.Security.Cryptography.Aes]::Create()
    $aes.KeySize = 256
    $aes.BlockSize = 128
    $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $aes.Key = $encryptionKey
    $aes.IV = $iv
    $encryptor = $aes.CreateEncryptor()
    $crypto = $null
    try {
      $output.Write($header, 0, $header.Length)
      $crypto = [System.Security.Cryptography.CryptoStream]::new(
        $output,
        $encryptor,
        [System.Security.Cryptography.CryptoStreamMode]::Write,
        $true
      )
      $input.CopyTo($crypto, 1024 * 1024)
      $crypto.FlushFinalBlock()
      $crypto.Dispose()
      $crypto = $null
      $output.Flush($true)
    }
    finally {
      if ($crypto) { $crypto.Dispose() }
      $encryptor.Dispose()
      $aes.Dispose()
      $input.Dispose()
      $output.Dispose()
    }

    $hmac = [System.Security.Cryptography.HMACSHA256]::new($authenticationKey)
    $authenticatedInput = [System.IO.File]::OpenRead($partialPath)
    try { $tag = $hmac.ComputeHash($authenticatedInput) }
    finally {
      $authenticatedInput.Dispose()
      $hmac.Dispose()
    }
    $append = [System.IO.File]::Open($partialPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $append.Write($tag, 0, $tag.Length)
      $append.Flush($true)
    }
    finally {
      $append.Dispose()
      [System.Array]::Clear($tag, 0, $tag.Length)
    }
    Move-Item -LiteralPath $partialPath -Destination $OutputPath
  }
  finally {
    foreach ($sensitive in @($derived, $encryptionKey, $authenticationKey, $salt, $iv)) {
      if ($null -ne $sensitive) { [System.Array]::Clear($sensitive, 0, $sensitive.Length) }
    }
    if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
  }
}

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path $PSScriptRoot -Parent
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "AGENTS.md") -PathType Leaf)) {
  throw "ProjectRoot 不是驭小满项目目录：$ProjectRoot"
}
if (-not $OutputRoot) {
  $OutputRoot = Join-Path (Split-Path $ProjectRoot -Parent) "deliverables"
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
[void](New-Item -ItemType Directory -Path $OutputRoot -Force)

$sourceEnv = Join-Path $ProjectRoot ".env"
if (-not (Test-Path -LiteralPath $sourceEnv -PathType Leaf)) {
  throw "根目录缺少 .env，无法制作包含当前配置的交付包。"
}

$apiPort = Get-EnvValue -Path $sourceEnv -Name "PORT" -DefaultValue "8792"
if (-not $AllowLiveApiSnapshot) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.BeginConnect("127.0.0.1", [int]$apiPort, $null, $null)
    $isListening = $connect.AsyncWaitHandle.WaitOne(500)
    if ($isListening) {
      try { $client.EndConnect($connect) } catch { $isListening = $false }
    }
  }
  finally {
    $client.Dispose()
  }
  if ($isListening) {
    throw "API 仍在监听 $apiPort。请先停止 API，确保数据库与上传附件来自同一静默快照；确有需要可使用 -AllowLiveApiSnapshot。"
  }
}

$databaseUrl = Get-EnvValue -Path $sourceEnv -Name "DATABASE_URL"
$connection = ConvertFrom-PostgresUrl -DatabaseUrl $databaseUrl
$pgDump = Get-ToolPath "pg_dump.exe"
$pgRestore = Get-ToolPath "pg_restore.exe"
$psql = Get-ToolPath "psql.exe"
$createdb = Get-ToolPath "createdb.exe"
$dropdb = Get-ToolPath "dropdb.exe"
$tar = (Get-Command tar.exe -ErrorAction Stop).Source

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$deliveryName = "Yuxiaoman-Transfer-$stamp"
$deliveryDirectory = Join-Path $OutputRoot $deliveryName
$passwordFile = Join-Path $OutputRoot "$deliveryName-PASSWORD.txt"
$temporaryRoot = Join-Path (Join-Path $ProjectRoot ".runtime") ("transfer-build-" + [Guid]::NewGuid().ToString("N"))
$stagingRoot = Join-Path $temporaryRoot "staging"
$payloadZip = Join-Path $temporaryRoot "payload.zip"
$verificationDestination = Join-Path $temporaryRoot "verification"
$completed = $false

if ((Test-Path -LiteralPath $deliveryDirectory) -or (Test-Path -LiteralPath $passwordFile)) {
  throw "输出文件已存在，请稍后重试以生成新的时间戳。"
}

try {
  [void](New-Item -ItemType Directory -Path $stagingRoot -Force)
  [void](New-Item -ItemType Directory -Path $deliveryDirectory)

  $rootFiles = @(
    ".env", ".env.example", ".gitignore", ".npmrc", "AGENTS.md", "README.md",
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json",
    "在新电脑安装运行.txt"
  )
  foreach ($relative in $rootFiles) {
    $source = Join-Path $ProjectRoot $relative
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $relative)
    }
  }

  Copy-Tree (Join-Path $ProjectRoot "server") (Join-Path $stagingRoot "server")
  Copy-Tree (Join-Path $ProjectRoot "scripts") (Join-Path $stagingRoot "scripts")
  Copy-Tree (Join-Path $ProjectRoot "admin") (Join-Path $stagingRoot "admin") @("data")
  Copy-Tree (Join-Path $ProjectRoot "wechat-miniprogram") (Join-Path $stagingRoot "wechat-miniprogram")
  Copy-Tree (Join-Path $ProjectRoot "public") (Join-Path $stagingRoot "public")
  Copy-Tree (Join-Path $ProjectRoot "source-assets") (Join-Path $stagingRoot "source-assets")
  Copy-Tree (Join-Path $ProjectRoot "handoff") (Join-Path $stagingRoot "handoff")
  Copy-Tree (Join-Path $ProjectRoot "src\domain") (Join-Path $stagingRoot "src\domain")

  [void](New-Item -ItemType Directory -Path (Join-Path $stagingRoot "data") -Force)
  Copy-Tree (Join-Path $ProjectRoot "data\uploads") (Join-Path $stagingRoot "data\uploads")
  Copy-Tree (Join-Path $ProjectRoot "data\private") (Join-Path $stagingRoot "data\private")
  [void](New-Item -ItemType Directory -Path (Join-Path $stagingRoot "data\private\insurance") -Force)

  $reparsePoints = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($reparsePoints.Count -gt 0) {
    throw "暂存目录包含链接或重解析点，已拒绝打包。"
  }

  $databaseDirectory = Join-Path $stagingRoot "database"
  [void](New-Item -ItemType Directory -Path $databaseDirectory)
  $dumpPath = Join-Path $databaseDirectory "yuxiaoman_dev.pgdump"
  Write-Host "正在导出 PostgreSQL 业务数据库..."
  Use-PgPassword $connection.Password {
    & $pgDump --no-password --host=$($connection.Host) --port=$($connection.Port) `
      --username=$($connection.User) --dbname=$($connection.Database) --format=custom `
      --compress=9 --no-owner --no-privileges --file=$dumpPath 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pg_dump 导出失败。" }
  }

  $dumpContents = @(& $pgRestore --list $dumpPath 2>&1)
  if ($LASTEXITCODE -ne 0 -or $dumpContents.Count -eq 0) {
    throw "pg_restore 无法读取刚生成的数据库备份。"
  }
  Write-Utf8NoBom -Path (Join-Path $databaseDirectory "yuxiaoman_dev.contents.txt") -Content (($dumpContents | Out-String).TrimEnd() + "`r`n")

  $sourceSnapshot = Get-DatabaseSnapshot -PsqlPath $psql -Connection $connection -Database $connection.Database
  $verificationDatabase = "yuxiaoman_transfer_verify_" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
  if ($verificationDatabase -notmatch '^yuxiaoman_transfer_verify_[a-f0-9]{12}$') {
    throw "临时数据库名校验失败。"
  }
  try {
    Use-PgPassword $connection.Password {
      & $createdb --no-password --host=$($connection.Host) --port=$($connection.Port) `
        --username=$($connection.User) $verificationDatabase 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "无法创建临时恢复数据库。" }

      & $pgRestore --no-password --host=$($connection.Host) --port=$($connection.Port) `
        --username=$($connection.User) --dbname=$verificationDatabase --exit-on-error `
        --no-owner --no-privileges $dumpPath 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "数据库备份无法完整恢复到临时数据库。" }
    }
    $restoredSnapshot = Get-DatabaseSnapshot -PsqlPath $psql -Connection $connection -Database $verificationDatabase
    Assert-SnapshotsEqual -Expected $sourceSnapshot -Actual $restoredSnapshot
  }
  finally {
    Use-PgPassword $connection.Password {
      & $dropdb --if-exists --force --no-password --host=$($connection.Host) --port=$($connection.Port) `
        --username=$($connection.User) $verificationDatabase 2>&1 | Out-Null
    }
  }

  $verification = [ordered]@{
    verifiedAtUtc = [DateTime]::UtcNow.ToString("o")
    method = "pg_dump custom format, pg_restore --list, full restore into a temporary PostgreSQL database"
    source = $sourceSnapshot
    restored = $restoredSnapshot
  }
  Write-Utf8NoBom -Path (Join-Path $databaseDirectory "verification.json") -Content ($verification | ConvertTo-Json -Depth 6)

  $databasePassword = New-UrlSafePassword
  $targetDatabaseUrl = "postgresql://yuxiaoman:$databasePassword@127.0.0.1:55432/yuxiaoman_dev"
  $targetTestDatabaseUrl = "postgresql://yuxiaoman:$databasePassword@127.0.0.1:55432/yuxiaoman_test"
  $stagedEnv = Join-Path $stagingRoot ".env"
  Set-EnvValue -Path $stagedEnv -Name "DATABASE_URL" -Value $targetDatabaseUrl
  Set-EnvValue -Path $stagedEnv -Name "TEST_DATABASE_URL" -Value $targetTestDatabaseUrl
  Set-EnvValue -Path $stagedEnv -Name "HOST" -Value "0.0.0.0"
  Set-EnvValue -Path $stagedEnv -Name "PORT" -Value "8792"
  Set-EnvValue -Path $stagedEnv -Name "VITE_API_BASE_URL" -Value "http://127.0.0.1:8792/api"
  Set-EnvValue -Path $stagedEnv -Name "YUXIAOMAN_UPLOAD_DIR" -Value "data/uploads"

  $transferEnv = @(
    "POSTGRES_USER=yuxiaoman",
    "POSTGRES_PASSWORD=$databasePassword",
    "POSTGRES_DB=yuxiaoman_dev",
    "POSTGRES_PORT=55432"
  ) -join "`r`n"
  Write-Utf8NoBom -Path (Join-Path $stagingRoot "handoff\windows\transfer.env") -Content ($transferEnv + "`r`n")

  $fileEntries = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($stagingRoot.TrimEnd("\").Length + 1).Replace("\", "/")
    [ordered]@{
      path = $relative
      length = $_.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    }
  })
  $manifest = [ordered]@{
    schemaVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString("o")
    packageType = "native WeChat mini-program + API + operations admin + PostgreSQL snapshot"
    excludes = @("React MVP UI", "node_modules", "build/test artifacts", "Git metadata", "PostgreSQL live data directory", "legacy SQLite files", "WeChat developer private config")
    secrets = [ordered]@{
      encrypted = $true
      included = @("staged .env", "new target PostgreSQL password")
      unavailable = @("WeChat AppSecret was not present in the source workspace")
    }
    files = $fileEntries
  }
  Write-Utf8NoBom -Path (Join-Path $stagingRoot "MANIFEST.json") -Content ($manifest | ConvertTo-Json -Depth 8)

  Write-Host "正在生成压缩载荷..."
  & $tar -a -cf $payloadZip -C $stagingRoot .
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) {
    throw "tar 无法生成压缩载荷。"
  }
  $archiveEntries = @(& $tar -tf $payloadZip | ForEach-Object {
    $entry = $_.Replace("\", "/")
    while ($entry.StartsWith("./")) { $entry = $entry.Substring(2) }
    $entry.TrimStart("/")
  })
  if ($LASTEXITCODE -ne 0) { throw "无法回读压缩载荷目录。" }
  $requiredEntries = @(
    ".env", "MANIFEST.json", "package-lock.json", "server/app.ts", "admin/package.json",
    "wechat-miniprogram/project.config.json", "database/yuxiaoman_dev.pgdump",
    "handoff/windows/Restore-Database.ps1", "handoff/windows/Decrypt-And-Extract.ps1",
    "data/uploads"
  )
  foreach ($required in $requiredEntries) {
    if (-not ($archiveEntries -contains $required) -and -not (@($archiveEntries | Where-Object { $_.StartsWith($required.TrimEnd("/") + "/") }).Count -gt 0)) {
      throw "压缩载荷缺少必需内容：$required"
    }
  }

  $bundlePath = Join-Path $deliveryDirectory "Yuxiaoman-Full-Transfer-$stamp.yxm"
  $decryptScript = Join-Path $ProjectRoot "handoff\windows\Decrypt-And-Extract.ps1"
  Copy-Item -LiteralPath $decryptScript -Destination (Join-Path $deliveryDirectory "Decrypt-And-Extract.ps1")

  $externalReadme = @"
驭小满完整迁移包（原生微信小程序 + API + 运营后台 + PostgreSQL 数据）

1. 此目录与交付密码必须分开传输。
2. 在目标电脑打开 PowerShell，运行：
   powershell -ExecutionPolicy Bypass -File .\Decrypt-And-Extract.ps1
3. 按提示输入单独收到的密码；不要把密码写进命令行。
4. 解包成功后阅读 handoff\windows\README-迁移说明.md。
5. SHA256SUMS.txt 用于传输检错；请通过独立渠道核对解密脚本 SHA-256。

注意：项目原目录没有微信 AppSecret，因此包内也没有 AppSecret。AppID 已随 project.config.json 保留；目标电脑仍需用有开发权限的微信账号登录微信开发者工具。
"@
  Write-Utf8NoBom -Path (Join-Path $deliveryDirectory "使用说明.txt") -Content $externalReadme

  $bundlePassword = New-UrlSafePassword
  Write-Utf8NoBom -Path $passwordFile -Content $bundlePassword
  $passwordBytes = [System.Text.Encoding]::UTF8.GetBytes($bundlePassword)
  try {
    Write-Host "正在加密交付包..."
    Protect-Payload -InputPath $payloadZip -OutputPath $bundlePath -PasswordBytes $passwordBytes
  }
  finally {
    [System.Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    $bundlePassword = $null
    $databasePassword = $null
    $targetDatabaseUrl = $null
    $targetTestDatabaseUrl = $null
  }

  $checksumLines = @(Get-ChildItem -LiteralPath $deliveryDirectory -File | Sort-Object Name | ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    "$hash *$($_.Name)"
  })
  Write-Utf8NoBom -Path (Join-Path $deliveryDirectory "SHA256SUMS.txt") -Content (($checksumLines -join "`r`n") + "`r`n")

  Write-Host "正在执行真实解密与文件清单校验..."
  $verifyPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  & $verifyPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $deliveryDirectory "Decrypt-And-Extract.ps1") `
    -BundlePath $bundlePath -Destination $verificationDestination -PasswordFile $passwordFile
  if ($LASTEXITCODE -ne 0) { throw "交付包自检解密失败。" }
  foreach ($required in @(".env", "database\yuxiaoman_dev.pgdump", "wechat-miniprogram\project.config.json", "handoff\windows\Start-All.ps1")) {
    if (-not (Test-Path -LiteralPath (Join-Path $verificationDestination $required))) {
      throw "解密自检缺少文件：$required"
    }
  }

  $completed = $true
  Write-Host "交付包已生成并通过验证。" -ForegroundColor Green
  Write-Host "交付目录：$deliveryDirectory"
  Write-Host "密码文件（请分开发送）：$passwordFile"
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Assert-PathInside -Parent (Join-Path $ProjectRoot ".runtime") -Child $temporaryRoot
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
  if (-not $completed) {
    if (Test-Path -LiteralPath $deliveryDirectory) {
      Assert-PathInside -Parent $OutputRoot -Child $deliveryDirectory
      Remove-Item -LiteralPath $deliveryDirectory -Recurse -Force
    }
    if (Test-Path -LiteralPath $passwordFile) {
      Assert-PathInside -Parent $OutputRoot -Child $passwordFile
      Remove-Item -LiteralPath $passwordFile -Force
    }
  }
}
