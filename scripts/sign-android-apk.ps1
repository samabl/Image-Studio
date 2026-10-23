<#
.SYNOPSIS
    使用固定 keystore 为 Release APK 对齐、签名并核验证书。密码推荐通过环境变量传递。
.EXAMPLE
    $env:ANDROID_KEY_PASSWORD = '<本地私有密码>'
    pwsh -File scripts/sign-android-apk.ps1 -KeystorePath ./release.jks -KeyAlias release
#>
[CmdletBinding()]
param(
    [string]$KeystorePath = $env:ANDROID_KS_PATH,
    [string]$KeyAlias = $env:ANDROID_KEY_ALIAS,
    [string]$KeyPassword = $env:ANDROID_KEY_PASSWORD,
    [string]$StorePassword = $env:ANDROID_KEY_STORE_PASSWORD,
    [string]$ExpectedCertificateSha256 = $env:ANDROID_SIGNING_CERT_SHA256,
    [string]$ApkRoot = 'src-tauri/gen/android/app/build/outputs/apk',
    [string]$CertificateOutput,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/android-signing.ps1')
Invoke-AndroidReleaseSigning -KeystorePath $KeystorePath -KeyAlias $KeyAlias -KeyPassword $KeyPassword `
    -StorePassword $StorePassword -ExpectedCertificateSha256 $ExpectedCertificateSha256 `
    -ApkRoot $ApkRoot -CertificateOutput $CertificateOutput -Force:$Force
