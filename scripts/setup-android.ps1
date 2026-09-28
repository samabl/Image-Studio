<#
.SYNOPSIS
    一键生成并配置 Tauri Android 工程（Windows / Linux / macOS 通用，CI 与本地共用）。

.DESCRIPTION
    做五件事：
      1. 校验 JAVA_HOME / ANDROID_HOME / NDK_HOME，缺什么给出具体安装命令；
      2. 补齐 Rust 交叉编译目标；
      3. 调用 `pnpm tauri android init` 生成 src-tauri/gen/android；
      4. 生成 network_security_config.xml 并注入 AndroidManifest.xml
         —— 内网 http:// 网关在 Android 9+ 上默认被拦截，这一步是必须的；
      5. 若提供了签名材料，写入 keystore.properties 并给 app/build.gradle.kts
         打上 release signingConfig（Tauri 模板默认没有这段）。

    脚本可重复执行：已打过的补丁不会重复写入。

.EXAMPLE
    # 本地：只放行内网网关
    pwsh -File scripts/setup-android.ps1 -CleartextHosts 10.213.196.114

.EXAMPLE
    # CI：从环境变量拿签名材料（不落盘到仓库）
    $env:ANDROID_KEY_BASE64="..."; $env:ANDROID_KEY_ALIAS="upload"; $env:ANDROID_KEY_PASSWORD="..."
    pwsh -File scripts/setup-android.ps1
#>
[CmdletBinding()]
param(
    # 允许明文 HTTP 的域名/IP
    [string[]]$CleartextHosts = @("localhost", "127.0.0.1", "10.0.2.2"),

    # 放行全部明文流量（最省事，安全性最低）
    [switch]$AllowAllCleartext,

    # 跳过 `tauri android init`
    [switch]$SkipInit,

    # 签名用的 keystore 路径；不传则读 $env:ANDROID_KEY_BASE64 解码到临时文件
    [string]$KeystorePath,
    [string]$KeyAlias = $env:ANDROID_KEY_ALIAS,
    [string]$KeyPassword = $env:ANDROID_KEY_PASSWORD
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$onWindows = $IsWindows -or ($PSVersionTable.PSEdition -eq "Desktop")

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [x] $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== 1/5 检查构建环境 ===" -ForegroundColor White

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
    Warn "未找到 Android NDK。可在 SDK Manager 安装 NDK（26.x/27.x），或设置 NDK_HOME。"
    Fail "缺少 NDK，无法继续。"
}
$env:NDK_HOME = $ndk
Ok "NDK_HOME = $ndk"

# --- Rust 交叉目标 ---
Write-Host "`n=== 2/5 检查 Rust 交叉编译目标 ===" -ForegroundColor White
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
Write-Host "`n=== 3/5 生成 Android 工程 ===" -ForegroundColor White
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
Write-Host "`n=== 4/5 配置明文 HTTP 放行 ===" -ForegroundColor White

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
Set-Content -Path $nsFile -Value $xml -Encoding UTF8
Ok "已写入 network_security_config.xml"

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

# --- 签名 ---
Write-Host "`n=== 5/5 配置 release 签名 ===" -ForegroundColor White

# 支持 CI 传 base64（不落盘到仓库）
if (-not $KeystorePath -and $env:ANDROID_KEY_BASE64) {
    $KeystorePath = Join-Path ([IO.Path]::GetTempPath()) "android-upload.jks"
    [IO.File]::WriteAllBytes($KeystorePath, [Convert]::FromBase64String($env:ANDROID_KEY_BASE64))
    Info "已从 ANDROID_KEY_BASE64 解码 keystore 到临时目录"
}

if (-not $KeystorePath) {
    Warn "未提供签名材料，release APK 会是没有签名的产物（无法直接安装）。"
    Info "要拿到可安装的 release APK，任选其一："
    Info "  a) 传入 -KeystorePath/-KeyAlias/-KeyPassword 三个参数"
    Info "  b) 设置环境变量 ANDROID_KEY_BASE64 / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD"
    Info "  c) 用 `pnpm tauri android build --apk --debug` 出一个 debug 签名的 APK"
} elseif (-not (Test-Path $KeystorePath)) {
    Fail "keystore 文件不存在：$KeystorePath"
} else {
    if (-not $KeyAlias) { Fail "缺少 -KeyAlias（或 ANDROID_KEY_ALIAS）" }
    if (-not $KeyPassword) { Fail "缺少 -KeyPassword（或 ANDROID_KEY_PASSWORD）" }

    $absKey = (Resolve-Path $KeystorePath).Path
    $gradleDir = Join-Path $root "src-tauri/gen/android"
    $propsFile = Join-Path $gradleDir "keystore.properties"

    # Tauri 模板里 storeFile 走 file(...)，Windows 路径反斜杠会被当转义，统一成正斜杠
    $storeFile = $absKey -replace '\\', '/'
    @(
        "password=$KeyPassword",
        "keyAlias=$KeyAlias",
        "storeFile=$storeFile"
    ) | Set-Content -Path $propsFile -Encoding ascii
    Ok "已写入 keystore.properties"

    # 模板默认没有 signingConfigs，需要补上并把 release buildType 指过去
    $gradleFile = Join-Path $gradleDir "app/build.gradle.kts"
    if (-not (Test-Path $gradleFile)) {
        Warn "没找到 app/build.gradle.kts，跳过 Gradle 签名配置"
    } else {
        $g = Get-Content $gradleFile -Raw
        if ($g -match 'signingConfigs\s*\{') {
            Ok "build.gradle.kts 已有 signingConfigs，跳过"
        } else {
            if ($g -notmatch 'import java\.io\.FileInputStream') {
                $g = "import java.io.FileInputStream`n" + $g
            }
            $block = @"
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            if (keystorePropertiesFile.exists()) {
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))
            }
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["password"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["password"] as String
        }
    }

"@
            if ($g -match '(?m)^\s*buildTypes\s*\{') {
                $g = $g -replace '(?m)^(\s*)buildTypes\s*\{', ($block + '$0')
                Ok "已在 buildTypes 前插入 signingConfigs"
            } else {
                Warn "build.gradle.kts 里没有 buildTypes 块，请手工添加 signingConfigs"
            }
            # release 分支指向新的签名配置
            if ($g -match 'signingConfig\s*=\s*signingConfigs\.getByName\("release"\)') {
                Ok "release 已引用 release 签名配置"
            } elseif ($g -match '(?ms)release\s*\{') {
                # 注意：必须用 Regex 实例的 Replace(input, replacement, count) 重载，
                # 静态的 [regex]::Replace(...,1) 会把 1 当成 RegexOptions 而不是次数。
                $re = [regex]'(?ms)(release\s*\{)'
                $g = $re.Replace($g, "`$1`n            signingConfig = signingConfigs.getByName(`"release`")", 1)
                Ok "已让 release buildType 使用 release 签名配置"
            } else {
                Warn "没找到 buildTypes.release 块，请手工加上 signingConfig = signingConfigs.getByName(\"release\")"
            }
            Set-Content -Path $gradleFile -Value $g -Encoding UTF8
            Ok "app/build.gradle.kts 已更新"
        }
    }
}

Write-Host "`n完成。`n" -ForegroundColor Green
Write-Host @"
后续命令：
  打包 APK   : pnpm tauri android build --apk
  打包 AAB   : pnpm tauri android build
  真机调试   : pnpm tauri android dev
  产物目录   : src-tauri/gen/android/app/build/outputs/apk/

注意：改了 tauri.conf.json 的 identifier / version 后需重新 init（先删掉 src-tauri/gen/android）。
"@ -ForegroundColor Gray
