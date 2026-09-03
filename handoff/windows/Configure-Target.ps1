[CmdletBinding()]
param(
  [string]$LanIp,
  [switch]$OpenFirewall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$MiniEnvFile = Join-Path $ProjectRoot "wechat-miniprogram\miniprogram\config\env.ts"

function Test-PrivateIpv4([string]$Address) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
  if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  $octets = $parsed.GetAddressBytes()
  return (
    $octets[0] -eq 10 -or
    ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
    ($octets[0] -eq 192 -and $octets[1] -eq 168)
  )
}

function Find-LanIpv4 {
  $candidates = foreach ($configuration in Get-NetIPConfiguration -ErrorAction Stop) {
    if (-not $configuration.NetAdapter -or $configuration.NetAdapter.Status -ne "Up") { continue }
    if (-not $configuration.IPv4DefaultGateway) { continue }
    if ($configuration.InterfaceAlias -match 'vEthernet|Hyper-V|WSL|Docker|Loopback|VirtualBox|VMware') { continue }
    foreach ($address in $configuration.IPv4Address) {
      if (Test-PrivateIpv4 $address.IPAddress) {
        $metric = (Get-NetIPInterface -InterfaceIndex $configuration.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).InterfaceMetric
        [pscustomobject]@{
          Address = $address.IPAddress
          Metric = if ($null -eq $metric) { 9999 } else { [int]$metric }
          Hardware = [bool]$configuration.NetAdapter.HardwareInterface
          Alias = $configuration.InterfaceAlias
        }
      }
    }
  }

  $selected = $candidates | Sort-Object @{ Expression = "Hardware"; Descending = $true }, Metric | Select-Object -First 1
  if (-not $selected) {
    throw "未找到带默认网关的局域网 IPv4。请连接 Wi-Fi/网线后重试，或用 -LanIp 192.168.x.x 指定。"
  }
  return $selected
}

if (-not (Test-Path -LiteralPath $MiniEnvFile -PathType Leaf)) {
  throw "找不到小程序配置文件：$MiniEnvFile"
}

if ($LanIp) {
  if (-not (Test-PrivateIpv4 $LanIp)) {
    throw "-LanIp 必须是 RFC1918 局域网 IPv4（10.x、172.16-31.x 或 192.168.x）。"
  }
  $SelectedIp = $LanIp
  $SelectedAlias = "手动指定"
} else {
  $Detected = Find-LanIpv4
  $SelectedIp = $Detected.Address
  $SelectedAlias = $Detected.Alias
}

$Source = [System.IO.File]::ReadAllText($MiniEnvFile)
$Pattern = '(?m)^const DEVICE_LAN_HOST = "[^"]+";$'
$Matches = [regex]::Matches($Source, $Pattern)
if ($Matches.Count -ne 1) {
  throw "DEVICE_LAN_HOST 声明数量不是 1；为避免误改，脚本已停止。"
}
$Updated = [regex]::Replace($Source, $Pattern, "const DEVICE_LAN_HOST = `"$SelectedIp`";")
[System.IO.File]::WriteAllText($MiniEnvFile, $Updated, [System.Text.UTF8Encoding]::new($false))

Write-Host "小程序真机 API 地址已配置为 ${SelectedIp}:8792（网卡：$SelectedAlias）。"

if ($OpenFirewall) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "-OpenFirewall 需要管理员 PowerShell。配置文件已更新，但防火墙规则尚未创建。"
  }
  $ruleName = "Yuxiaoman Mini API 8792"
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8792 -Profile Private | Out-Null
    Write-Host "已创建仅适用于专用网络的 TCP 8792 入站规则。"
  } else {
    Write-Host "防火墙规则已存在：$ruleName"
  }
}
