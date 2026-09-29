<#
.SYNOPSIS
    一键生成并配置 Tauri Android 工程（Windows / Linux / macOS 通用，CI 与本地共用）。

.DESCRIPTION
    做四件事：
      1. 校验 JAVA_HOME / ANDROID_HOME / NDK_HOME，缺什么给出具体安装命令；
      2. 补齐 Rust 交叉编译目标；
      3. 调用 `pnpm tauri android init` 生成 src-tauri/gen/android；
      4. 生成 network_security_config.xml 并注入 AndroidManifest.xml
         —— 内网 http:// 网关在 Android 9+ 上默认被拦截，这一步是必须的。

    签名**不在这里做**。Tauri 的 Gradle 模板用的是 `getByName("release") { ... }`
    这类 Kotlin DSL 写法，靠正则去改它非常脆（实测因为匹配不到 release 块而静默产出
    未签名 APK）。签名改用与模板无关的后置方案：
        pwsh -File scripts/sign-android-apk.ps1 -KeystorePath ... -KeyAlias ... -KeyPassword ...

    脚本可重复执行：已打过的补丁不会重复写入。

.EXAMPLE
    pwsh -File scripts/setup-android.ps1 -CleartextHosts 10.213.196.114
#>
[CmdletBinding()]
param(
    # 允许明文 HTTP 的域名/IP
    [string[]]$CleartextHosts = @("localhost", "127.0.0.1", "10.0.2.2"),

    # 放行全部明文流量（最省事，安全性最低）
    [switch]$AllowAllCleartext,

    # 跳过 `tauri android init`
    [switch]$SkipInit
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# AndroidManifest 的补丁逻辑单独成文件，便于单元测试
# （见 scripts/test-android-manifest.ps1）
. (Join-Path $PSScriptRoot "lib/android-manifest.ps1")

$onWindows = $IsWindows -or ($PSVersionTable.PSEdition -eq "Desktop")
# 统一以「UTF-8 无 BOM」写 XML：带 BOM 会让 Gradle 的 ManifestMerger 解析失败。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [x] $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== 1/4 检查构建环境 ===" -ForegroundColor White

# --- Java ---
$javaHome = $env:JAVA_HOME
if (-not $javaHome -and $onWindows -and (Test-Path "C:\Program Files\Android\Android Studio\jbr")) {
    $javaHome = "C:\Program Files\Android\Android Studio\jbr"
    Warn "JAVA_HOME 未设置，回退到 Android Studio 自带的 JBR：$javaHome"
}
if (-not $javaHome) {
    Warn "未找到 Java。Tauri Android 构建需要 JDK 17。"
    if ($onWindows) {
        Info "  winget install EclipseAdoptium.Temurin.17.JDK"
        Info "  choco install temurin17"
    } else {
        Info "  sudo apt install openjdk-17-jdk"
    }
    Fail "缺少 JDK，无法继续。"
}
if (-not (Test-Path $javaHome)) { Fail "JAVA_HOME 指向的路径不存在：$javaHome" }
$env:JAVA_HOME = $javaHome
$env:Path = (Join-Path $javaHome "bin") + [IO.Path]::PathSeparator + $env:Path
Ok "JAVA_HOME = $javaHome"

# --- Android SDK ---
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk -and $onWindows) { $sdk = Join-Path $env:LOCALAPPDATA "Android/Sdk" }
if (-not $sdk -or -not (Test-Path $sdk)) {
    Warn "未找到 Android SDK（当前值：$sdk）"
    Info "安装：Android Studio 的 SDK Manager，或只装命令行工具"
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
if (-not $ndk -or -not (Test-Path $ndk)) {
    Warn "未找到 Android NDK。可在 SDK Manager 安装 NDK（26.x/27.x/29.x），或设置 NDK_HOME。"
    Fail "缺少 NDK，无法继续。"
}
$env:NDK_HOME = $ndk
Ok "NDK_HOME = $ndk"

# --- Rust 交叉目标 ---
Write-Host "`n=== 2/4 检查 Rust 交叉编译目标 ===" -ForegroundColor White
$targets = @(
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "i686-linux-android",
    "x86_64-linux-android"
)
$installed = (& rustup target list --installed) -split "`r?`n"
foreach ($t in $targets) {
    if ($installed -contains $t) {
        Ok "$t"
    } else {
        Info "安装 $t …"
        & rustup target add $t
        if ($LASTEXITCODE -ne 0) { Fail "安装 $t 失败" }
        Ok "$t 安装完成"
    }
}

# --- 生成工程 ---
Write-Host "`n=== 3/4 生成 Android 工程 ===" -ForegroundColor White
$manifest = Join-Path $root "src-tauri/gen/android/app/src/main/AndroidManifest.xml"

if ($SkipInit) {
    Info "已跳过 init"
} elseif (Test-Path $manifest) {
    Ok "src-tauri/gen/android 已存在，跳过 init"
} else {
    Info "执行 pnpm tauri android init …"
    # --ci：跳过交互式提问。android build 没有这个自动行为，CI 里必须显式传，
    # 否则会一直等着输入而卡死。
    & pnpm tauri android init --ci
    if ($LASTEXITCODE -ne 0) { Fail "tauri android init 失败" }
    if (-not (Test-Path $manifest)) { Fail "init 完成但没找到 AndroidManifest.xml：$manifest" }
    Ok "Android 工程已生成"
}
if (-not (Test-Path $manifest)) { Fail "找不到 AndroidManifest.xml：$manifest" }

# --- 明文 HTTP 放行 ---
Write-Host "`n=== 4/4 配置明文 HTTP 放行 ===" -ForegroundColor White

$resXmlDir = Join-Path $root "src-tauri/gen/android/app/src/main/res/xml"
$nsFile = Join-Path $resXmlDir "network_security_config.xml"

if ($AllowAllCleartext) {
    Info "模式：放行全部明文流量"
    $domainBlock = ""
    $baseConfig = '    <base-config cleartextTrafficPermitted="true" />'
} else {
    Info "模式：仅放行指定域名 -> $($CleartextHosts -join ', ')"
    $domains = ($CleartextHosts | ForEach-Object {
        "        <domain includeSubdomains=`"true`">$_</domain>"
    }) -join "`n"
    $baseConfig = '    <base-config cleartextTrafficPermitted="false" />'
    $domainBlock = "`n    <domain-config cleartextTrafficPermitted=`"true`">`n$domains`n    </domain-config>`n"
}

New-Item -ItemType Directory -Force -Path $resXmlDir | Out-Null
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/setup-android.ps1 生成：控制哪些域名允许明文 HTTP。
     内网 OpenAI 兼容网关通常是 http://，Android 9+ 默认会拦截。 -->
<network-security-config>
$baseConfig$domainBlock</network-security-config>
"@
[IO.File]::WriteAllText($nsFile, $xml, $utf8NoBom)
Ok "已写入 network_security_config.xml"

$content = Get-Content $manifest -Raw
$changed = $false

# 1) 引用网络安全配置
$patched = Add-AndroidManifestAttribute `
    -Content $content `
    -Name "android:networkSecurityConfig" `
    -Value "@xml/network_security_config"
if ($null -eq $patched) {
    Warn "AndroidManifest.xml 里没找到 <application> 标签，请手动添加 networkSecurityConfig"
} elseif ($patched -ne $content) {
    $content = $patched
    $changed = $true
    Ok "已注入 android:networkSecurityConfig"
} else {
    Ok "networkSecurityConfig 已存在，跳过"
}

# 2) 可选：放行全部明文流量
if ($AllowAllCleartext) {
    $patched = Add-AndroidManifestAttribute `
        -Content $content `
        -Name "android:usesCleartextTraffic" `
        -Value "true"
    if ($null -ne $patched -and $patched -ne $content) {
        $content = $patched
        $changed = $true
        Ok "已注入 android:usesCleartextTraffic"
    }
}

# 写入前必须仍是合法 XML。
# 之前这里用了单引号里的 `n，把字面量「反引号+n」写进了 XML，
# 结果 Gradle 在 processUniversalReleaseMainManifest 阶段报
# "Error parsing AndroidManifest.xml" 才暴露出来 —— 现在就地拦住。
if (-not (Test-WellFormedXml $content)) {
    Fail "补丁后的 AndroidManifest.xml 不是合法 XML，已中止（不会写入坏文件）"
}
if (-not (Test-WellFormedXml $xml)) {
    Fail "生成的 network_security_config.xml 不是合法 XML，已中止"
}

if ($changed) {
    [IO.File]::WriteAllText($manifest, $content, $utf8NoBom)
    Ok "AndroidManifest.xml 已更新"
}

Write-Host "`n完成。`n" -ForegroundColor Green
Write-Host @"
后续命令：
  打包 APK   : pnpm tauri android build --apk --ci
  签名 APK   : pwsh -File scripts/sign-android-apk.ps1 -KeystorePath <jks> -KeyAlias <alias> -KeyPassword <pwd>
  打包 AAB   : pnpm tauri android build --ci
  真机调试   : pnpm tauri android dev
  产物目录   : src-tauri/gen/android/app/build/outputs/apk/

注意：
  - tauri android build 没有 --ci 的自动行为，非交互环境务必显式传，否则会卡在提问上。
  - 改了 tauri.conf.json 的 identifier / version 后需重新 init（先删掉 src-tauri/gen/android）。
"@ -ForegroundColor Gray
