<#
.SYNOPSIS
    把本快照还原到一台新设备的 DSH profile。

.DESCRIPTION
    - 备份现有 profile 文件
    - 写入快照的 package.json / pnpm-lock.yaml / pnpm-workspace.yaml
    - 处理所有 link: 依赖（本地私有包），逐个改写为本机实际路径或移除
    - 执行 pnpm install，失败自动回滚

.PARAMETER ProfileDir
    目标 profile 目录。通常等于 $env:DSH_PROFILE_DIR。
    未提供时从环境变量读取。

.PARAMETER WorkspaceDir
    本地私有包所在的 workspace 根目录（其下应有 bundles/ 与 pet-src/）。
    默认取当前目录向上查找的 default-workspace。
    找不到时不影响还原，只会跳过对应的私有包。

.PARAMETER RepoDir
    DSH 仓库根目录，用于仓库内的 link: 依赖（packages/、plugins/）。
    默认取本脚本所在目录向上两级。

.PARAMETER SkipLocalPackages
    跳过所有本地私有包的 link，直接从清单里移除。

.PARAMETER ForceUnfrozen
    不使用 --frozen-lockfile。清单被改写导致与 lock 不一致时，
    脚本会自动退化为非 frozen 模式；也可用本参数强制。

.EXAMPLE
    .\restore.ps1
.EXAMPLE
    .\restore.ps1 -ProfileDir "D:\deepseek-harness\apps\desktop\.desktop-build\development\home\profiles\desktop" -SkipLocalPackages
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = $env:DSH_PROFILE_DIR,
    [string]$WorkspaceDir,
    [string]$RepoDir,
    [switch]$SkipLocalPackages,
    [switch]$ForceUnfrozen
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 仓库根：docs/profile-snapshot/ -> 上两级。
if (-not $RepoDir) {
    $candidate = Split-Path (Split-Path $here -Parent) -Parent
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'packages'))) { $RepoDir = $candidate }
}
if (-not $RepoDir) { $RepoDir = '' }

# 未显式指定时，尝试从当前目录向上找一个含 default-workspace 的位置；
# 找不到就留空，后续按「私有包缺失」处理。
if (-not $WorkspaceDir) {
    $cursor = (Get-Location).Path
    for ($i = 0; $i -lt 12 -and $cursor; $i++) {
        $candidate = Join-Path $cursor 'default-workspace'
        if (Test-Path -LiteralPath $candidate) { $WorkspaceDir = $candidate; break }
        $parent = Split-Path $cursor -Parent
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    # 常见布局兜底：<用户>\Documents\deepseek-harness\default-workspace
    if (-not $WorkspaceDir) {
        $fallback = Join-Path $HOME 'Documents\deepseek-harness\default-workspace'
        if (Test-Path -LiteralPath $fallback) { $WorkspaceDir = $fallback }
    }
}
if (-not $WorkspaceDir) { $WorkspaceDir = '' }

function Write-Step($msg) { Write-Host "`n[+] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !!  $msg" -ForegroundColor Yellow }

# ---------- 前置检查 ----------
if (-not $ProfileDir) {
    throw "未指定 ProfileDir，且环境变量 DSH_PROFILE_DIR 为空。请用 -ProfileDir 指定。"
}
if (-not (Test-Path -LiteralPath $ProfileDir)) {
    throw "ProfileDir 不存在：$ProfileDir"
}
Write-Step "目标 profile: $ProfileDir"
Write-Host "    workspace: $(if ($WorkspaceDir) { $WorkspaceDir } else { '<未定位>' })" -ForegroundColor Gray
Write-Host "    仓库根   : $(if ($RepoDir) { $RepoDir } else { '<未定位>' })" -ForegroundColor Gray

foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $here $f))) { throw "快照缺少文件：$f" }
}

# ---------- 1. 备份 ----------
Write-Step "备份现有 profile 文件"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) {
    $src = Join-Path $ProfileDir $f
    if (Test-Path -LiteralPath $src) {
        $bak = "$src.bak-$stamp"
        Copy-Item -LiteralPath $src -Destination $bak -Force
        Write-Ok "$f -> $(Split-Path $bak -Leaf)"
    } else {
        Write-Warn2 "$f 不存在，跳过备份"
    }
}

# ---------- 2. 解析本地私有包 ----------
Write-Step "处理本地私有包（link: 依赖）"
# 关键：只改写内存中的副本，绝不修改快照源文件，
# 否则重复运行会把 link: 依赖永久从快照里删掉。
$srcPkgPath = Join-Path $here 'package.json'
$pkg = Get-Content $srcPkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

# base: 'workspace' = default-workspace 根；'repo' = DSH 仓库根。
# 顺序无关；只处理确实出现在 dependencies 里的条目。
$localPackages = [ordered]@{
    '@local/dsh-desktop-extras'              = @{ base = 'workspace'; rel = 'bundles\desktop-extras' }
    '@dsh-pet/bridge'                        = @{ base = 'workspace'; rel = 'pet-src\integrations\dsh-pet-bridge' }
    '@dsh-pet/lifecycle'                     = @{ base = 'workspace'; rel = 'dsh-kit\plugins\dsh-pet-lifecycle' }
    'dsh-connect-grok'                       = @{ base = 'workspace'; rel = 'dsh-connect-grok' }
    'dsh-connect-workbuddy'                  = @{ base = 'workspace'; rel = 'bundles\dsh-connect-workbuddy' }
    'dsh-harness-eval'                       = @{ base = 'repo';      rel = 'plugins\harness-eval' }
    '@deepseek-ai/dsh-subagent-claude-code'  = @{ base = 'repo';      rel = 'packages\subagent\subagent-claude-code' }
}

$missing = @()
$rewritten = 0
foreach ($name in $localPackages.Keys) {
    if (-not ($pkg.dependencies.PSObject.Properties.Name -contains $name)) { continue }
    $spec = $localPackages[$name]
    $root = if ($spec.base -eq 'repo') { $RepoDir } else { $WorkspaceDir }
    $dir = if ($root) { Join-Path $root $spec.rel } else { '' }
    if ($SkipLocalPackages) {
        $pkg.dependencies.PSObject.Properties.Remove($name)
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $name })
        Write-Warn2 "$name 已按 -SkipLocalPackages 跳过"
    }
    elseif ($dir -and (Test-Path -LiteralPath $dir)) {
        $pkg.dependencies.$name = "link:$($dir -replace '\\','/')"
        $rewritten++
        Write-Ok "$name -> $dir"
    }
    else {
        $hint = if ($dir) { $dir } else { "<未定位到 $($spec.base) 根目录，请用 -WorkspaceDir / -RepoDir 指定>" }
        $missing += "$name (期望路径: $hint)"
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
# package.json 用改写后的内存对象直接写目标，源文件保持不动。
# 必须写成无 BOM 的 UTF-8：Windows PowerShell 5.1 的 Set-Content -Encoding UTF8
# 会写入 BOM，而 node / pnpm 解析带 BOM 的 package.json 会失败。
$json = $pkg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText(
    (Join-Path $ProfileDir 'package.json'),
    $json,
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Ok "package.json（已按本机路径改写）"
foreach ($f in @('pnpm-lock.yaml','pnpm-workspace.yaml')) {
    Copy-Item -LiteralPath (Join-Path $here $f) -Destination (Join-Path $ProfileDir $f) -Force
    Write-Ok $f
}

# ---------- 4. pnpm install ----------
Write-Step "执行 pnpm install"
$exitCode = 0
Push-Location $ProfileDir
try {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Write-Warn2 "未找到 pnpm，请先安装（npm i -g pnpm），然后手动执行：pnpm install"
        Write-Warn2 "配置文件已就位，仅依赖未安装。"
        $exitCode = 2
    }
    else {
        # 清单被改写（link 路径重写 / 跳过私有包）时，lock 与 package.json 必然不一致，
        # --frozen-lockfile 会直接失败；此时自动退化为普通安装。
        $changed = ($missing.Count -gt 0) -or ($rewritten -gt 0)
        $useFrozen = (-not $ForceUnfrozen) -and (-not $SkipLocalPackages) -and (-not $changed)
        $pnpmArgs = @('install')
        if ($useFrozen) {
            $pnpmArgs += '--frozen-lockfile'
            Write-Host "    模式：--frozen-lockfile（严格按锁文件）" -ForegroundColor Gray
        } else {
            Write-Host "    模式：普通安装（清单已改写，无法 frozen）" -ForegroundColor Gray
        }

        & pnpm @pnpmArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Warn2 "pnpm install 失败（退出码 $LASTEXITCODE），开始回滚配置"
            foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) {
                $bak = Join-Path $ProfileDir "$f.bak-$stamp"
                if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination (Join-Path $ProfileDir $f) -Force }
            }
            Write-Warn2 "配置已恢复，但 node_modules 可能处于半安装状态。"
            Write-Warn2 "请手动检查或删除 node_modules 后重试：$ProfileDir"
            $exitCode = 1
        }
        else {
            Write-Ok "pnpm install 完成"
        }
    }
} finally {
    Pop-Location
}

if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "还原未完全成功（退出码 $exitCode），请先处理上面的提示。" -ForegroundColor Red
    exit $exitCode
}

Write-Step "完成"
Write-Host "    重启 DSH 使插件生效。" -ForegroundColor Green
Write-Host "    注意：cordis.patch.yml（模型/主题/语言等私人配置）不在此快照内，需要的话单独拷贝。" -ForegroundColor Green
