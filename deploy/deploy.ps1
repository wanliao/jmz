<#
.SYNOPSIS
  一键部署到 Linux 服务器（Windows 原生 PowerShell 版）。

.EXAMPLE
  pwsh deploy/deploy.ps1 -Target root@1.2.3.4 -Domain like.example.com -Nginx
  pwsh deploy/deploy.ps1 -Target root@1.2.3.4 -Port 8787

  升级时重复执行即可：只替换代码，data/ 与 .env 会保留，并自动备份数据。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Target,
  [int]$SshPort = 22,
  [int]$Port = 8787,
  [string]$AppDir = '/opt/kimuzhi',
  [string]$Domain = '',
  [ValidateSet('auto', 'yes', 'no')][string]$Nginx = 'auto'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

foreach ($cmd in @('ssh', 'scp', 'tar')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "本机缺少 $cmd 命令（Windows 10+ 自带 tar / OpenSSH 客户端）"
  }
}

$package = Join-Path $env:TEMP ("kimuzhi-release-{0}.tgz" -f $PID)
$setup = Join-Path $env:TEMP ("kimuzhi-remote-setup-{0}.sh" -f $PID)
$remotePackage = '/tmp/kimuzhi-release.tgz'
$remoteSetup = '/tmp/kimuzhi-remote-setup.sh'

try {
  Write-Host '==> 打包代码（不含 data/、.git、node_modules）'
  $excludes = @(
    '--exclude=./.git', '--exclude=./data', '--exclude=./node_modules',
    '--exclude=./backups', '--exclude=./.tmp-shots', '--exclude=*.log',
    '--exclude=./.env'
  )
  & tar -czf $package @excludes -C $root .
  if ($LASTEXITCODE -ne 0) { throw 'tar 打包失败' }
  Copy-Item (Join-Path $root 'deploy/remote-setup.sh') $setup -Force

  Write-Host "==> 上传到 $Target"
  & scp -P $SshPort -q $package "${Target}:$remotePackage"
  if ($LASTEXITCODE -ne 0) { throw 'scp 上传失败' }
  & scp -P $SshPort -q $setup "${Target}:$remoteSetup"
  if ($LASTEXITCODE -ne 0) { throw 'scp 上传失败' }

  Write-Host '==> 在服务器上安装 / 升级'
  $remoteArgs = @(
    "sudo bash $remoteSetup",
    "--tarball $remotePackage",
    "--port $Port",
    "--app-dir $AppDir"
  )
  if ($Domain) { $remoteArgs += "--domain $Domain" }
  switch ($Nginx) {
    'yes' { $remoteArgs += '--nginx' }
    'no' { $remoteArgs += '--no-nginx' }
  }
  & ssh -p $SshPort $Target ($remoteArgs -join ' ')
  if ($LASTEXITCODE -ne 0) { throw '服务器端安装失败' }
}
finally {
  Remove-Item $package, $setup -Force -ErrorAction SilentlyContinue
}
