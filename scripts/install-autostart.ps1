<#
.SYNOPSIS
  把「金拇指」设为开机（登录）自动启动，或取消自动启动。

.EXAMPLE
  # 安装：在项目根目录执行
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

.EXAMPLE
  # 取消
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

说明：实现方式是在「启动」文件夹里放一个快捷方式（最小化窗口运行 node server\index.js），
      透明可查：Win+R 输入 shell:startup 就能看到它，删掉即取消。
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$startup = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startup '金拇指-点赞统计.lnk'

if ($Remove) {
  if (Test-Path $linkPath) {
    Remove-Item $linkPath -Force
    Write-Host "已取消开机自启：$linkPath" -ForegroundColor Green
  } else {
    Write-Host '本来就没有设置开机自启。'
  }
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '没有找到 node 命令，请先安装 Node.js 20+：https://nodejs.org/'
}
if (-not (Test-Path (Join-Path $root 'server/index.js'))) {
  throw "在 $root 里找不到 server/index.js，请在项目根目录执行本脚本"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = (Get-Command node).Source
$shortcut.Arguments = 'server\index.js'
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7          # 7 = 最小化，不挡你的事
$shortcut.Description = '金拇指 · 和平精英每周点赞统计（开机自启）'
$shortcut.Save()

$port = 8787
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
}

Write-Host ''
Write-Host '✅ 已设置开机（登录）自动启动' -ForegroundColor Green
Write-Host "   快捷方式：$linkPath"
Write-Host "   访问地址：http://127.0.0.1:$port"
Write-Host '   取消方式：powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove'
Write-Host ''
