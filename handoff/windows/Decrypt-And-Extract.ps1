[CmdletBinding()]
param(
  [string]$BundlePath,
  [string]$Destination = (Join-Path $PSScriptRoot "Yuxiaoman-System"),
  [string]$PasswordFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$HeaderLength = 72
$TagLength = 32
$Magic = "YXMBNDL1"
$MinIterations = 100000
$MaxIterations = 2000000

function Read-Exact {
  param(
    [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
    [Parameter(Mandatory = $true)][byte[]]$Buffer,
    [Parameter(Mandatory = $true)][int]$Offset,
    [Parameter(Mandatory = $true)][int]$Count
  )

  $total = 0
  while ($total -lt $Count) {
    $read = $Stream.Read($Buffer, $Offset + $total, $Count - $total)
    if ($read -le 0) {
      throw "加密包提前结束，文件可能未传输完整。"
    }
    $total += $read
  }
}

function Get-PasswordBytes {
  param([string]$Path)

  if ($Path) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $plain = [System.IO.File]::ReadAllText($resolved).Trim()
    if ([string]::IsNullOrWhiteSpace($plain)) {
      throw "密码文件为空。"
    }
    try {
      return ,([System.Text.Encoding]::UTF8.GetBytes($plain))
    }
    finally {
      $plain = $null
    }
  }

  $secure = Read-Host "请输入单独收到的交付密码" -AsSecureString
  $bstr = [IntPtr]::Zero
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plain)) {
      throw "密码不能为空。"
    }
    return ,([System.Text.Encoding]::UTF8.GetBytes($plain))
  }
  finally {
    $plain = $null
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Test-FixedTimeEqual {
  param(
    [byte[]]$Left,
    [byte[]]$Right
  )

  if ($null -eq $Left -or $null -eq $Right -or $Left.Length -ne $Right.Length) {
    return $false
  }
  $difference = 0
  for ($index = 0; $index -lt $Left.Length; $index += 1) {
    $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
  }
  return $difference -eq 0
}

function Test-ArchiveEntry {
  param([string]$Entry)

  $normalized = $Entry.Replace("\", "/").Trim()
  while ($normalized.StartsWith("./")) {
    $normalized = $normalized.Substring(2)
  }
  if (-not $normalized -or $normalized -eq ".") {
    return
  }
  if ($normalized.StartsWith("/") -or $normalized.StartsWith("\")) {
    throw "压缩包包含绝对路径：$Entry"
  }
  if ($normalized -match "^[A-Za-z]:" -or $normalized.Contains(":")) {
    throw "压缩包包含不安全的盘符或数据流路径：$Entry"
  }
  if ($normalized.IndexOf([char]0) -ge 0) {
    throw "压缩包包含空字符路径。"
  }
  if (@($normalized.Split("/") | Where-Object { $_ -eq ".." }).Count -gt 0) {
    throw "压缩包包含目录穿越路径：$Entry"
  }
}

if (-not $BundlePath) {
  $bundles = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.yxm" -File)
  if ($bundles.Count -ne 1) {
    throw "请使用 -BundlePath 指定 .yxm 文件；当前目录应当只有一个交付包。"
  }
  $BundlePath = $bundles[0].FullName
}

$bundle = (Resolve-Path -LiteralPath $BundlePath).Path
$bundleInfo = Get-Item -LiteralPath $bundle
if ($bundleInfo.Length -lt ($HeaderLength + 16 + $TagLength)) {
  throw "加密包长度异常。"
}

$passwordBytes = $null
$derivedBytes = $null
$encryptionKey = $null
$authenticationKey = $null
$expectedTag = $null
$actualTag = $null
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("yuxiaoman-decrypt-" + [Guid]::NewGuid().ToString("N"))
$cipherPath = Join-Path $temporaryRoot "payload.cipher"
$zipPath = Join-Path $temporaryRoot "payload.zip.partial"
$destinationCreated = $false

try {
  $header = New-Object byte[] $HeaderLength
  $stream = [System.IO.File]::Open($bundle, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    Read-Exact -Stream $stream -Buffer $header -Offset 0 -Count $HeaderLength
  }
  finally {
    $stream.Dispose()
  }

  $headerStream = [System.IO.MemoryStream]::new($header, $false)
  $reader = [System.IO.BinaryReader]::new($headerStream)
  try {
    $magicBytes = $reader.ReadBytes(8)
    $version = $reader.ReadByte()
    $kdfId = $reader.ReadByte()
    $cipherId = $reader.ReadByte()
    $macId = $reader.ReadByte()
    $iterations = $reader.ReadUInt32()
    $plainLength = $reader.ReadUInt64()
    $salt = $reader.ReadBytes(32)
    $iv = $reader.ReadBytes(16)
  }
  finally {
    $reader.Dispose()
    $headerStream.Dispose()
  }

  if ([System.Text.Encoding]::ASCII.GetString($magicBytes) -ne $Magic) {
    throw "不是驭小满交付包，或文件头已损坏。"
  }
  if ($version -ne 1 -or $kdfId -ne 1 -or $cipherId -ne 1 -or $macId -ne 1) {
    throw "暂不支持此交付包版本或加密算法。"
  }
  if ($iterations -lt $MinIterations -or $iterations -gt $MaxIterations) {
    throw "PBKDF2 参数超出安全范围，文件头可能已被篡改。"
  }

  $expectedCipherLength = ([UInt64]([Math]::Floor([decimal]$plainLength / 16) + 1)) * 16
  $cipherLength = [UInt64]($bundleInfo.Length - $HeaderLength - $TagLength)
  if ($cipherLength -ne $expectedCipherLength) {
    throw "密文长度与文件头不一致，文件可能已损坏。"
  }

  $passwordBytes = [byte[]](Get-PasswordBytes -Path $PasswordFile)
  $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
    $passwordBytes,
    $salt,
    [int]$iterations,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  try {
    $derivedBytes = $kdf.GetBytes(64)
  }
  finally {
    $kdf.Dispose()
  }
  $encryptionKey = New-Object byte[] 32
  $authenticationKey = New-Object byte[] 32
  [System.Buffer]::BlockCopy($derivedBytes, 0, $encryptionKey, 0, 32)
  [System.Buffer]::BlockCopy($derivedBytes, 32, $authenticationKey, 0, 32)

  $stream = [System.IO.File]::Open($bundle, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $stream.Position = $bundleInfo.Length - $TagLength
    $actualTag = New-Object byte[] $TagLength
    Read-Exact -Stream $stream -Buffer $actualTag -Offset 0 -Count $TagLength

    $stream.Position = 0
    $remaining = [Int64]($bundleInfo.Length - $TagLength)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($authenticationKey)
    try {
      $buffer = New-Object byte[] (1024 * 1024)
      while ($remaining -gt 0) {
        $wanted = [int][Math]::Min($buffer.Length, $remaining)
        $read = $stream.Read($buffer, 0, $wanted)
        if ($read -le 0) {
          throw "校验加密包时提前结束。"
        }
        $remaining -= $read
        if ($remaining -eq 0) {
          [void]$hmac.TransformFinalBlock($buffer, 0, $read)
        }
        else {
          [void]$hmac.TransformBlock($buffer, 0, $read, $buffer, 0)
        }
      }
      $expectedTag = $hmac.Hash
    }
    finally {
      $hmac.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }

  if (-not (Test-FixedTimeEqual -Left $expectedTag -Right $actualTag)) {
    throw "密码错误，或交付包完整性校验失败。未进行解密。"
  }

  [void](New-Item -ItemType Directory -Path $temporaryRoot)
  $input = [System.IO.File]::OpenRead($bundle)
  $cipherOutput = [System.IO.File]::Create($cipherPath)
  try {
    $input.Position = $HeaderLength
    $remaining = [Int64]$cipherLength
    $buffer = New-Object byte[] (1024 * 1024)
    while ($remaining -gt 0) {
      $wanted = [int][Math]::Min($buffer.Length, $remaining)
      $read = $input.Read($buffer, 0, $wanted)
      if ($read -le 0) {
        throw "复制密文时提前结束。"
      }
      $cipherOutput.Write($buffer, 0, $read)
      $remaining -= $read
    }
  }
  finally {
    $cipherOutput.Dispose()
    $input.Dispose()
  }

  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.KeySize = 256
  $aes.BlockSize = 128
  $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $encryptionKey
  $aes.IV = $iv
  $cipherInput = [System.IO.File]::OpenRead($cipherPath)
  $decryptor = $aes.CreateDecryptor()
  $crypto = [System.Security.Cryptography.CryptoStream]::new(
    $cipherInput,
    $decryptor,
    [System.Security.Cryptography.CryptoStreamMode]::Read
  )
  $zipOutput = [System.IO.File]::Create($zipPath)
  try {
    $buffer = New-Object byte[] (1024 * 1024)
    while (($read = $crypto.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $zipOutput.Write($buffer, 0, $read)
    }
  }
  finally {
    $zipOutput.Dispose()
    $crypto.Dispose()
    $decryptor.Dispose()
    $cipherInput.Dispose()
    $aes.Dispose()
  }

  if ((Get-Item -LiteralPath $zipPath).Length -ne [Int64]$plainLength) {
    throw "解密后的压缩包长度不一致。"
  }

  $tar = (Get-Command tar.exe -ErrorAction Stop).Source
  $entries = @(& $tar -tf $zipPath)
  if ($LASTEXITCODE -ne 0) {
    throw "无法读取压缩包目录。"
  }
  foreach ($entry in $entries) {
    Test-ArchiveEntry -Entry $entry
  }

  $destinationFull = [System.IO.Path]::GetFullPath($Destination)
  if (Test-Path -LiteralPath $destinationFull) {
    throw "目标目录已存在，为避免覆盖请更换 -Destination：$destinationFull"
  }
  $destinationRoot = [System.IO.Path]::GetPathRoot($destinationFull)
  if ($destinationFull.TrimEnd("\") -eq $destinationRoot.TrimEnd("\")) {
    throw "不能解压到磁盘根目录。"
  }
  [void](New-Item -ItemType Directory -Path $destinationFull)
  $destinationCreated = $true

  & $tar -xf $zipPath -C $destinationFull
  if ($LASTEXITCODE -ne 0) {
    throw "解压失败。"
  }

  $reparsePoints = @(Get-ChildItem -LiteralPath $destinationFull -Recurse -Force | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($reparsePoints.Count -gt 0) {
    throw "解压结果包含链接或重解析点，已拒绝。"
  }

  $manifestPath = Join-Path $destinationFull "MANIFEST.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "交付包缺少 MANIFEST.json。"
  }
  $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1) {
    throw "不支持的清单版本。"
  }

  $destinationPrefix = $destinationFull.TrimEnd("\") + "\"
  $manifestPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $manifest.files) {
    $relative = ([string]$file.path).Replace("/", "\")
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $destinationFull $relative))
    if (-not $fullPath.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "清单包含越界路径：$($file.path)"
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "缺少清单文件：$($file.path)"
    }
    $info = Get-Item -LiteralPath $fullPath
    if ($info.Length -ne [Int64]$file.length) {
      throw "文件长度不匹配：$($file.path)"
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fullPath).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$file.sha256).ToLowerInvariant()) {
      throw "文件哈希不匹配：$($file.path)"
    }
    [void]$manifestPaths.Add(([string]$file.path).Replace("\", "/"))
  }

  foreach ($file in Get-ChildItem -LiteralPath $destinationFull -Recurse -Force -File) {
    $relative = $file.FullName.Substring($destinationPrefix.Length).Replace("\", "/")
    if ($relative -ne "MANIFEST.json" -and -not $manifestPaths.Contains($relative)) {
      throw "发现未列入清单的文件：$relative"
    }
  }

  Write-Host "交付包完整性校验通过。" -ForegroundColor Green
  Write-Host "已解压到：$destinationFull"
  Write-Host "下一步请打开 handoff\windows\README-迁移说明.md。"
}
catch {
  if ($destinationCreated -and (Test-Path -LiteralPath $destinationFull)) {
    $resolvedDestination = [System.IO.Path]::GetFullPath($destinationFull)
    $root = [System.IO.Path]::GetPathRoot($resolvedDestination)
    if ($resolvedDestination.TrimEnd("\") -ne $root.TrimEnd("\")) {
      Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
    }
  }
  throw
}
finally {
  foreach ($sensitive in @($passwordBytes, $derivedBytes, $encryptionKey, $authenticationKey, $expectedTag, $actualTag)) {
    if ($null -ne $sensitive) {
      [System.Array]::Clear($sensitive, 0, $sensitive.Length)
    }
  }
  if (Test-Path -LiteralPath $temporaryRoot) {
    $resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryRoot)
    $systemTemporary = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTemporary.StartsWith($systemTemporary, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTemporary).StartsWith("yuxiaoman-decrypt-")) {
      Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
  }
}
