# CI 在编译前验证固定签名材料，不生成或回退到任何临时签名。
[CmdletBinding()]
param(
    [string]$KeyBase64 = $env:ANDROID_KEY_BASE64,
    [string]$KeyAlias = $env:ANDROID_KEY_ALIAS,
    [string]$KeyPassword = $env:ANDROID_KEY_PASSWORD,
    [string]$StorePassword = $env:ANDROID_KEY_STORE_PASSWORD,
    [string]$ExpectedCertificateSha256 = $env:ANDROID_SIGNING_CERT_SHA256,
    [string]$OutputDirectory = $env:RUNNER_TEMP,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/android-signing.ps1')
Assert-AndroidSigningSecrets $KeyBase64 $KeyAlias $KeyPassword $ExpectedCertificateSha256
if ($ValidateOnly) { Write-Host '[ok] 固定 Release 签名 Secrets 已配置'; return }
if (-not $OutputDirectory -or -not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { throw '签名准备目录不存在' }
$keystore = Join-Path (Resolve-Path -LiteralPath $OutputDirectory).Path ('image-studio-release-' + [Guid]::NewGuid().ToString('N') + '.jks')
try {
    [IO.File]::WriteAllBytes($keystore, [Convert]::FromBase64String($KeyBase64))
    if (-not ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop')) { & chmod 600 $keystore; if ($LASTEXITCODE -ne 0) { throw '无法限制 keystore 文件权限' } }
    if (-not $StorePassword) { $StorePassword = $KeyPassword }
    $fingerprint = Get-AndroidKeystoreFingerprint (Get-AndroidKeytool) $keystore $KeyAlias $StorePassword
    if ($ExpectedCertificateSha256 -and $fingerprint -ne (ConvertTo-AndroidCertificateFingerprint $ExpectedCertificateSha256)) { throw 'keystore 与固定 ANDROID_SIGNING_CERT_SHA256 不一致' }
    if ($env:GITHUB_OUTPUT) {
        [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "keystore_path=$keystore`ncertificate_sha256=$fingerprint`n", [Text.UTF8Encoding]::new($false))
    }
    Write-Host "[ok] 固定签名材料校验通过；证书 SHA-256：$fingerprint"
} catch {
    Remove-Item -LiteralPath $keystore -Force -ErrorAction SilentlyContinue
    throw
}
