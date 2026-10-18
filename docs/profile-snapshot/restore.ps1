<#
.SYNOPSIS
    把本快照还原到一台新设备的 DSH profile。

.DESCRIPTION
    - 备份现有 profile 文件
    - 写入快照的 package.json / pnpm-lock.yaml / pnpm-workspace.yaml
    - 处理两个本地私有包（link: 依赖）
    - 执行 pnpm install，失败自动回滚

.PARAMETER ProfileDir
    目标 profile 目录。通常等于 $env:DSH_PROFILE_DIR。
    未提供时从环境变量读取。

.PARAMETER WorkspaceDir
    本地私有包所在的 workspace 根目录（bundles/ 与 pet-src/ 的父目录）。
    默认：C:\Users\zzn19\Documents\deepseek-harness\default-workspace

.PARAMETER SkipLocalPackages
    跳过两个本地私有包的 link，直接从清单里移除。

.EXAMPLE
    .\restore.ps1
.EXAMPLE
    .\restore.ps1 -ProfileDir "D:\deepseek-harness\apps\desktop\.desktop-build\development\home\profiles\desktop" -SkipLocalPackages
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = $env:DSH_PROFILE_DIR,
    [string]$WorkspaceDir = "C:\Users\zzn19\Documents\deepseek-harness\default-workspace",
    [switch]$SkipLocalPackages
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) { Write-Host "`n[+] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !!  $msg" -ForegroundColor Yellow }

# ---------- 前置检查 ----------
if (-not $ProfileDir) {
    throw "未指定 ProfileDir，且环境变量 DSH_PROFILE_DIR 为空。请用 -ProfileDir 指定。"
}
if (-not (Test-Path $ProfileDir)) {
    throw "ProfileDir 不存在：$ProfileDir"
}
Write-Step "目标 profile: $ProfileDir"

foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) {
    if (-not (Test-Path (Join-Path $here $f))) { throw "快照缺少文件：$f" }
}

# ---------- 1. 备份 ----------
Write-Step "备份现有 profile 文件"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) {
    $src = Join-Path $ProfileDir $f
    if (Test-Path $src) {
        $bak = "$src.bak-$stamp"
        Copy-Item $src $bak -Force
        Write-Ok "$f -> $(Split-Path $bak -Leaf)"
    } else {
        Write-Warn2 "$f 不存在，跳过备份"
    }
}

# ---------- 2. 解析本地私有包 ----------
Write-Step "处理本地私有包"
# 关键：只改写内存中的副本，绝不修改快照源文件，
# 否则重复运行会把 link: 依赖永久从快照里删掉。
$srcPkgPath = Join-Path $here 'package.json'
$pkg = Get-Content $srcPkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

$localPackages = @{
    '@local/dsh-desktop-extras' = Join-Path $WorkspaceDir 'bundles\desktop-extras'
    '@dsh-pet/bridge'           = Join-Path $WorkspaceDir 'pet-src\integrations\dsh-pet-bridge'
}

$missing = @()
foreach ($name in $localPackages.Keys) {
    if (-not ($pkg.dependencies.PSObject.Properties.Name -contains $name)) { continue }
    $dir = $localPackages[$name]
    if ($SkipLocalPackages) {
        $pkg.dependencies.PSObject.Properties.Remove($name)
        $b = $pkg.dsh.profile.bundles
        if ($b -contains $name) {
            $idx = [array]::IndexOf([object[]]$b, $name)
            if ($idx -ge 0) { $b = @($b | Where-Object { $_ -ne $name }); $pkg.dsh.profile.bundles = $b }
        }
        Write-Warn2 "$name 已按 -SkipLocalPackages 跳过"
    }
    elseif (Test-Path $dir) {
        $pkg.dependencies.$name = "link:$($dir -replace '\\','/')"
        Write-Ok "$name -> $dir"
    }
    else {
        $missing += "$name (期望路径: $dir)"
        $pkg.dependencies.PSObject.Properties.Remove($name)
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $name })
        Write-Warn2 "$name 本地目录不存在，已从清单移除"
    }
}

if ($missing.Count -gt 0) {
    Write-Host "`n以下本地私有包在这台设备上找不到，已从清单移除：" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "  如需保留，请先把对应目录放到上述路径，然后重跑本脚本。" -ForegroundColor Yellow
}

# ---------- 3. 写入 profile ----------
Write-Step "写入 profile"
# package.json 用改写后的内存对象直接写目标，源文件保持不动
$pkg | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ProfileDir 'package.json') -Encoding UTF8
Write-Ok "package.json（已按本机路径改写）"
foreach ($f in @('pnpm-lock.yaml','pnpm-workspace.yaml')) {
    Copy-Item (Join-Path $here $f) (Join-Path $ProfileDir $f) -Force
    Write-Ok $f
}

# ---------- 4. pnpm install ----------
Write-Step "执行 pnpm install"
Push-Location $ProfileDir
try {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Write-Warn2 "未找到 pnpm，请先安装（npm i -g pnpm），然后手动执行：pnpm install"
        Pop-Location
        exit 2
    }
    & pnpm install --frozen-lockfile 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "pnpm install 失败（退出码 $LASTEXITCODE），开始回滚"
        foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) {
            $bak = Join-Path $ProfileDir "$f.bak-$stamp"
            if (Test-Path $bak) { Copy-Item $bak (Join-Path $ProfileDir $f) -Force }
        }
        Write-Ok "已回滚到还原前状态"
        Pop-Location
        exit 1
    }
    Write-Ok "pnpm install 完成"
} finally {
    if ((Get-Location).Path -eq $ProfileDir) { Pop-Location }
}

Write-Step "完成"
Write-Host "    重启 DSH 使插件生效。" -ForegroundColor Green
Write-Host "    注意：cordis.patch.yml（模型/主题/语言等私人配置）不在此快照内，需要的话单独拷贝。" -ForegroundColor Green
