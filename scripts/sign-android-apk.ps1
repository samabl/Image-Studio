<#
.SYNOPSIS
    给 Tauri 产出的未签名 release APK 做 zipalign + apksigner 签名。

.DESCRIPTION
    为什么不直接改 app/build.gradle.kts 让 Gradle 签名：
    Tauri 生成的 Gradle 模板用的是 `getByName("release") { ... }` 这种 Kotlin DSL 写法，
    版本之间还会变；靠正则去猜模板结构非常脆（实测就因为匹配不到 release 块而静默产出
    `app-universal-release-unsigned.apk`）。用 apksigner 做后置签名只依赖 Android SDK
    自带的稳定命令行工具，和模板长什么样完全无关。

    流程：找 APK -> 未签名则 zipalign -> apksigner sign -> apksigner verify -> 删掉未签名原件。

.EXAMPLE
    pwsh -File scripts/sign-android-apk.ps1 `
        -KeystorePath $env:RUNNER_TEMP/ci-upload.jks `
        -KeyAlias ci-upload -KeyPassword android
#>
[CmdletBinding()]
param(
    # keystore 文件路径（.jks / .keystore 均可）
    [Parameter(Mandatory = $true)][string]$KeystorePath,
    [Parameter(Mandatory = $true)][string]$KeyAlias,
    [Parameter(Mandatory = $true)][string]$KeyPassword,
    # 不传则与 KeyPassword 相同（PKCS12 要求两者一致）
    [string]$StorePassword,

    # APK 搜索根目录
    [string]$ApkRoot = "src-tauri/gen/android/app/build/outputs/apk",

    # 已签名的产物就不再动
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [x] $m" -ForegroundColor Red; exit 1 }

if (-not $StorePassword) { $StorePassword = $KeyPassword }

$onWindows = $IsWindows -or ($PSVersionTable.PSEdition -eq "Desktop")
$exeSuffix = if ($onWindows) { ".exe" } else { "" }
$script:failures = 0

Write-Host "`n=== 校验输入 ===" -ForegroundColor White

if (-not (Test-Path $KeystorePath)) { Fail "keystore 不存在：$KeystorePath" }
$keystoreAbs = (Resolve-Path $KeystorePath).Path
Ok "keystore: $keystoreAbs"

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk -or -not (Test-Path $sdk)) { Fail "ANDROID_HOME 未设置或不存在：$sdk" }
Ok "ANDROID_HOME: $sdk"

$buildToolsDir = Join-Path $sdk "build-tools"
if (-not (Test-Path $buildToolsDir)) { Fail "找不到 build-tools 目录：$buildToolsDir" }
$buildTools = Get-ChildItem $buildToolsDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
Ok "build-tools: $($buildTools.Name)"

$zipalign = Join-Path $buildTools.FullName "zipalign$exeSuffix"
$apksigner = Join-Path $buildTools.FullName "apksigner$exeSuffix"
foreach ($tool in @($zipalign, $apksigner)) {
    if (-not (Test-Path $tool)) { Fail "缺少工具：$tool" }
    Ok (Split-Path $tool -Leaf)
}

Write-Host "`n=== 查找 APK ===" -ForegroundColor White
if (-not (Test-Path $ApkRoot)) { Fail "APK 目录不存在：$ApkRoot" }
$apks = @(Get-ChildItem $ApkRoot -Recurse -Filter "*.apk" | Where-Object { $_.Name -notlike "*-signed*" })
if ($apks.Count -eq 0) { Fail "在 $ApkRoot 下没有找到 APK" }
$apks | ForEach-Object { Info "$($_.FullName)  ($([math]::Round($_.Length/1MB,2)) MB)" }

Write-Host "`n=== 签名 ===" -ForegroundColor White

foreach ($apk in $apks) {
    Write-Host "`n--- $($apk.Name) ---"

    # 已经签过名的就不重复处理
    if (-not $Force) {
        & $apksigner verify --print-certs $apk.FullName *> $null
        if ($LASTEXITCODE -eq 0) {
            Ok "已签名，跳过"
            continue
        }
    }

    $aligned = Join-Path $apk.DirectoryName ($apk.BaseName + "-aligned.apk")
    $signed = Join-Path $apk.DirectoryName ($apk.BaseName + "-signed.apk")
    Remove-Item $aligned, $signed -Force -ErrorAction SilentlyContinue

    # 1) zipalign：AGP 产出的未签名 APK 没有做 4 字节对齐，必须先对齐再签
    Info "zipalign …"
    & $zipalign -p -f 4 $apk.FullName $aligned
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $aligned)) { Warn "zipalign 失败"; $script:failures++; continue }

    # 2) 签名（v1 + v2 + v3 都打开，兼容各版本 Android）
    Info "apksigner sign …"
    & $apksigner sign `
        --ks $keystoreAbs `
        --ks-key-alias $KeyAlias `
        --ks-pass "pass:$StorePassword" `
        --key-pass "pass:$KeyPassword" `
        --v1-signing-enabled true `
        --v2-signing-enabled true `
        --v3-signing-enabled true `
        --out $signed `
        $aligned
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $signed)) { Warn "apksigner 签名失败"; $script:failures++; continue }

    # 3) 校验
    Info "apksigner verify …"
    & $apksigner verify --verbose --print-certs $signed
    if ($LASTEXITCODE -ne 0) { Warn "签名校验未通过"; $script:failures++; continue }

    # 4) 校验通过才删原件，避免把唯一的产物弄丢
    Remove-Item $aligned -Force -ErrorAction SilentlyContinue
    Remove-Item $apk.FullName -Force -ErrorAction SilentlyContinue
    Ok "已产出可安装的签名包：$(Split-Path $signed -Leaf)"
    $script:cfg = $signed
}

Write-Host ""
if ($script:failures -gt 0) { Fail "有 $($script:failures) 个 APK 签名失败" }
Ok "全部 APK 签名完成"
