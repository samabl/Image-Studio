<#
.SYNOPSIS
    一键生成并配置 Tauri Android 工程。

.DESCRIPTION
    做四件事：
      1. 校验/提示需要的环境变量与 Rust 交叉编译目标；
      2. 调用 `pnpm tauri android init` 生成 src-tauri/gen/android；
      3. 往 AndroidManifest.xml 注入明文 HTTP 放行配置
         （内网 http:// 网关在 Android 9+ 上会被默认拦截，必须显式放行）；
      4. 生成 network_security_config.xml，只对指定域名放开明文。

    脚本可重复执行：已经打过补丁的配置不会重复写入。

.EXAMPLE
    pwsh -File scripts/setup-android.ps1 -CleartextHosts 10.213.196.114,localhost

.EXAMPLE
    # 不加参数时默认放行局域网网段与 localhost
    pwsh -File scripts/setup-android.ps1
#>
[CmdletBinding()]
param(
    # 允许明文 HTTP 的域名/IP；支持 includeSubdomains
    [string[]]$CleartextHosts = @("localhost", "127.0.0.1", "10.0.2.2"),

    # 完全关闭明文限制（最省事，安全性最低）
    [switch]$AllowAllCleartext,

    # 跳过 `tauri android init`
    [switch]$SkipInit
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Info($m)  { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "  ! $m" -ForegroundColor Yellow }
function Fail($m)  { Write-Host "  ✗ $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== 1/4 检查构建环境 ===" -ForegroundColor White

# --- Java ---
$javaHome = $env:JAVA_HOME
if (-not $javaHome -and (Test-Path "C:\Program Files\Android\Android Studio\jbr")) {
    $javaHome = "C:\Program Files\Android\Android Studio\jbr"
    Warn "JAVA_HOME 未设置，回退到 Android Studio 自带的 JBR：$javaHome"
}
if (-not $javaHome) {
    Warn "未找到 Java。Tauri Android 构建需要 JDK 17。"
    Info "安装方式（任选其一）："
    Info "  winget install EclipseAdoptium.Temurin.17.JDK"
    Info "  choco install temurin17"
    Info "安装后设置：  `$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.x.x-hotspot'"
    Fail "缺少 JDK，无法继续。"
}
if (-not (Test-Path $javaHome)) { Fail "JAVA_HOME 指向的路径不存在：$javaHome" }
$env:JAVA_HOME = $javaHome
$env:Path = "$javaHome\bin;$env:Path"
Ok "JAVA_HOME = $javaHome"

# --- Android SDK ---
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $sdk)) {
    Warn "未找到 Android SDK（预期位置：$sdk）"
    Info "安装方式：  winget install Google.AndroidStudio  然后在 SDK Manager 里装 Platform 34 + Build-Tools 34 + NDK 26"
    Info "或只装命令行工具：https://developer.android.com/studio#command-line-tools-only"
    Fail "缺少 Android SDK，无法继续。"
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
Ok "ANDROID_HOME = $sdk"

# --- NDK ---
$ndk = $env:NDK_HOME
if (-not $ndk) {
    $ndkRoot = Join-Path $sdk "ndk"
    if (Test-Path $ndkRoot) {
        $latest = Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($latest) { $ndk = $latest.FullName }
    }
}
if (-not $ndk) {
    Warn "未找到 Android NDK。请在 SDK Manager 里安装 NDK（建议 26.x），或设置 NDK_HOME。"
    Fail "缺少 NDK，无法继续。"
}
$env:NDK_HOME = $ndk
Ok "NDK_HOME = $ndk"

# --- Rust targets ---
Write-Host "`n=== 2/4 检查 Rust 交叉编译目标 ===" -ForegroundColor White
$targets = @("aarch64-linux-android", "armv7-linux-androideabi", "i686-linux-android", "x86_64-linux-android")
$installed = (& rustup target list --installed) -split "`r?`n"
foreach ($t in $targets) {
    if ($installed -contains $t) {
        Ok "$t 已安装"
    } else {
        Info "安装 $t …"
        & rustup target add $t
        if ($LASTEXITCODE -ne 0) { Fail "安装 $t 失败" }
        Ok "$t 安装完成"
    }
}

# --- 生成 Android 工程 ---
Write-Host "`n=== 3/4 生成 Android 工程 ===" -ForegroundColor White
$manifest = Join-Path $root "src-tauri\gen\android\app\src\main\AndroidManifest.xml"

if ($SkipInit) {
    Info "已跳过 init"
} elseif (Test-Path $manifest) {
    Ok "src-tauri/gen/android 已存在，跳过 init"
} else {
    Info "执行 pnpm tauri android init …"
    & pnpm tauri android init
    if ($LASTEXITCODE -ne 0) { Fail "tauri android init 失败" }
    if (-not (Test-Path $manifest)) { Fail "init 完成但没找到 AndroidManifest.xml：$manifest" }
    Ok "Android 工程已生成"
}

if (-not (Test-Path $manifest)) { Fail "找不到 AndroidManifest.xml：$manifest" }

# --- 写入明文放行配置 ---
Write-Host "`n=== 4/4 配置明文 HTTP 放行 ===" -ForegroundColor White

$resXmlDir = Join-Path $root "src-tauri\gen\android\app\src\main\res\xml"
$nsFile = Join-Path $resXmlDir "network_security_config.xml"

if ($AllowAllCleartext) {
    Info "模式：放行全部明文流量"
    $domains = ""
} else {
    Info "模式：仅放行指定域名 -> $($CleartextHosts -join ', ')"
    $domains = ($CleartextHosts | ForEach-Object {
        "        <domain includeSubdomains=`"true`">$_</domain>"
    }) -join "`n"
}

New-Item -ItemType Directory -Force -Path $resXmlDir | Out-Null
$baseConfig = if ($AllowAllCleartext) {
    '    <base-config cleartextTrafficPermitted="true" />'
} else {
    '    <base-config cleartextTrafficPermitted="false" />'
}
$domainBlock = if ($domains) {
    "`n    <domain-config cleartextTrafficPermitted=`"true`">`n$domains`n    </domain-config>`n"
} else { "" }

$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/setup-android.ps1 生成：控制哪些域名允许明文 HTTP。
     内网 OpenAI 兼容网关通常是 http://，Android 9+ 默认会拦截。 -->
<network-security-config>
$baseConfig$domainBlock</network-security-config>
"@
Set-Content -Path $nsFile -Value $xml -Encoding UTF8
Ok "已写入 network_security_config.xml"

# 修改 AndroidManifest.xml
$content = Get-Content $manifest -Raw
$changed = $false

if ($content -notmatch 'networkSecurityConfig') {
    if ($content -match '<application\b') {
        $content = $content -replace '(<application\b)', '$1`n        android:networkSecurityConfig="@xml/network_security_config"'
        $changed = $true
        Ok "已注入 android:networkSecurityConfig"
    } else {
        Warn "AndroidManifest.xml 里没找到 <application> 标签，请手动添加 networkSecurityConfig"
    }
} else {
    Ok "networkSecurityConfig 已存在，跳过"
}

if ($AllowAllCleartext -and $content -notmatch 'usesCleartextTraffic') {
    if ($content -match '<application\b') {
        $content = $content -replace '(<application\b)', '$1`n        android:usesCleartextTraffic="true"'
        $changed = $true
        Ok "已注入 android:usesCleartextTraffic"
    }
}

if ($changed) {
    Set-Content -Path $manifest -Value $content -Encoding UTF8
    Ok "AndroidManifest.xml 已更新"
}

Write-Host "`n完成。" -ForegroundColor Green
Write-Host @"

后续命令：
  打包 APK   : pnpm tauri android build --apk
  打包 AAB   : pnpm tauri android build
  真机调试   : pnpm tauri android dev
  产物目录   : src-tauri/gen/android/app/build/outputs/apk/

注意：修改 tauri.conf.json 里的 identifier / version 后需要重新执行 init（先删掉 src-tauri/gen/android）。
"@ -ForegroundColor Gray
