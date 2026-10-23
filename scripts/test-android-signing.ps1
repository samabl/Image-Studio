# Offline fixtures; no SDK or real signing credentials are used.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/android-signing.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('image-studio-signing-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$script:certificateBytes = [Text.Encoding]::UTF8.GetBytes('offline-public-certificate-fixture')
$hash = [Security.Cryptography.SHA256]::Create()
try { $script:fp = ([BitConverter]::ToString($hash.ComputeHash($script:certificateBytes)) -replace '-', '').ToLowerInvariant() } finally { $hash.Dispose() }
$script:other = 'cd' * 32
$script:toolCalls = @()
$script:failure = ''
$script:fixturePassword = 'offline-fixture-value'
$keystore = Join-Path $fixture 'fixed [key].jks'
[IO.File]::WriteAllText($keystore, 'not a real private key')
$tools = @{ keytool = 'mock-keytool'; apksigner = 'mock-apksigner'; zipalign = 'mock-zipalign' }

function Assert-Signing($condition, $message) {
    if (-not $condition) { throw $message }
    Write-Host "[PASS] $message"
}
function Assert-Throws([scriptblock]$Action, [string]$Message, [string]$Pattern) {
    try { & $Action; throw 'fixture did not throw' } catch {
        if ($_.Exception.Message -eq 'fixture did not throw' -or ($Pattern -and $_.Exception.Message -notmatch $Pattern)) { throw "$Message : $($_.Exception.Message)" }
    }
    Write-Host "[PASS] $Message"
}
function New-ApkFixture([string]$Name, [string]$Content = 'unsigned') {
    $root = Join-Path $fixture $Name
    New-Item -ItemType Directory -Path $root | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'app [release]-unsigned.apk'), $Content)
    return $root
}
function Sign-Fixture([string]$Root, [string]$Expected = $script:fp, [switch]$Force) {
    Invoke-AndroidReleaseSigning -KeystorePath $keystore -KeyAlias fixed -KeyPassword $script:fixturePassword `
        -ApkRoot $Root -ExpectedCertificateSha256 $Expected -Tools $tools -Force:$Force
}
# Mock only the native process boundary. The orchestration is production code.
function Invoke-AndroidSigningTool {
    param([string]$Tool, [string[]]$Arguments)
    $script:toolCalls += @{ Tool = $Tool; Arguments = $Arguments }
    if ($Tool -eq 'mock-keytool') {
        $name = $Arguments[$Arguments.IndexOf('-storepass:env') + 1]
        if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne $script:fixturePassword) { throw 'keytool environment missing' }
        if ($Arguments[0] -ne '-exportcert') { throw 'Fingerprint must hash the exported alias certificate, not a locale-dependent certificate chain' }
        if ($script:failure -eq 'certificate') { return @{ ExitCode = 1; Output = 'export failed' } }
        if ($script:failure -ne 'missing-certificate') {
            $path = $Arguments[$Arguments.IndexOf('-file') + 1]
            [IO.File]::WriteAllBytes($path, $script:certificateBytes)
        }
        return @{ ExitCode = 0; Output = "Certificate fingerprints:
 SHA256: $script:fp
 SHA256: $script:other" }
    }
    if ($Tool -eq 'mock-zipalign') {
        if ($Arguments[0] -eq '-c') { return @{ ExitCode = 0; Output = '' } }
        if ($script:failure -eq 'align') { return @{ ExitCode = 1; Output = '' } }
        Copy-Item -LiteralPath $Arguments[-2] -Destination $Arguments[-1]
        return @{ ExitCode = 0; Output = '' }
    }
    if ($Arguments[0] -eq 'verify') {
        $content = [IO.File]::ReadAllText($Arguments[-1])
        if (-not $content.StartsWith('signed:')) { return @{ ExitCode = 1; Output = '' } }
        $value = $content.Substring(7)
        if ($script:failure -eq 'multi') { return @{ ExitCode = 0; Output = "Signer #1 certificate SHA-256 digest: $value`nSigner #2 certificate SHA-256 digest: $value" } }
        return @{ ExitCode = 0; Output = "Signer #1 certificate SHA-256 digest: $value" }
    }
    if ($Arguments[0] -ne 'sign') { throw 'Unexpected fixture tool call' }
    foreach ($option in @('--ks-pass', '--key-pass')) {
        $argument = $Arguments[$Arguments.IndexOf($option) + 1]
        if (-not $argument.StartsWith('env:') -or [Environment]::GetEnvironmentVariable($argument.Substring(4), 'Process') -ne $script:fixturePassword) { throw 'apksigner password must use environment' }
    }
    if ($script:failure -eq 'sign') { return @{ ExitCode = 1; Output = '' } }
    $path = $Arguments[$Arguments.IndexOf('--out') + 1]
    $value = if ($script:failure -eq 'wrong') { $script:other } else { $script:fp }
    [IO.File]::WriteAllText($path, "signed:$value")
    return @{ ExitCode = 0; Output = '' }
}

try {
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('fixture-keystore'))
    foreach ($missing in @('key', 'alias', 'password')) {
        Assert-Throws {
            $key = if ($missing -eq 'key') { '' } else { $base64 }
            $alias = if ($missing -eq 'alias') { '' } else { 'fixed' }
            $password = if ($missing -eq 'password') { '' } else { $script:fixturePassword }
            Assert-AndroidSigningSecrets $key $alias $password
        } "Missing $missing fails without generating a key" '缺少 Secrets'
    }
    Assert-Throws { Assert-AndroidSigningSecrets 'not base64!' fixed $script:fixturePassword } 'Invalid base64 fails clearly' 'base64'
    Assert-Signing ((ConvertTo-AndroidCertificateFingerprint (('AB:' * 31) + 'AB')) -eq ('ab' * 32)) 'Certificate fingerprint normalization'
    Assert-Throws { ConvertTo-AndroidCertificateFingerprint 'bad' } 'Invalid certificate fingerprint rejected' '64'

    $actual = Get-AndroidKeystoreFingerprint 'mock-keytool' $keystore fixed $script:fixturePassword
    Assert-Signing ($actual -eq $script:fp) 'Fingerprint is the exported alias DER hash even when tool output contains a certificate chain'
    foreach ($failure in @('certificate', 'missing-certificate')) {
        $script:failure = $failure
        Assert-Throws { Get-AndroidKeystoreFingerprint 'mock-keytool' $keystore fixed $script:fixturePassword } "$failure fails before signing" '无法读取'
    }
    $script:failure = ''

    $root = New-ApkFixture 'success [literal]'
    Sign-Fixture $root
    $signed = Join-Path $root 'app [release]-signed.apk'
    Assert-Signing ((Test-Path -LiteralPath $signed) -and -not (Test-Path -LiteralPath (Join-Path $root 'app [release]-unsigned.apk'))) 'Only verified APK replaces original; literal paths preserved'
    Assert-Signing ([IO.File]::ReadAllText((Join-Path $root 'android-signing-cert.sha256')).Trim() -eq $script:fp) 'Public certificate fingerprint artifact generated'
    $count = @($script:toolCalls | Where-Object { $_.Arguments[0] -eq 'sign' }).Count
    Sign-Fixture $root
    Assert-Signing (@($script:toolCalls | Where-Object { $_.Arguments[0] -eq 'sign' }).Count -eq $count) 'Idempotent signing still verifies certificate identity'
    Assert-Signing (@($script:toolCalls | Where-Object { ($_.Arguments -join ' ') -like "*$script:fixturePassword*" }).Count -eq 0) 'Passwords never appear in native command arguments'

    $root = New-ApkFixture 'wrong-presigned' "signed:$script:other"
    Assert-Throws { Sign-Fixture $root } 'Wrong pre-signed identity cannot be skipped' '不同证书'
    Assert-Throws { Sign-Fixture $root -Force } 'Force cannot bypass fixed identity check' '不同证书'
    Assert-Signing ([IO.File]::ReadAllText((Join-Path $root 'app [release]-unsigned.apk')) -eq "signed:$script:other") 'Wrong pre-signed APK preserved'
    $root = New-ApkFixture 'pin-mismatch'
    Assert-Throws { Sign-Fixture $root $script:other } 'Changed keystore rejected by pinned certificate' '不一致'
    foreach ($failure in @('align', 'sign', 'wrong')) {
        $root = New-ApkFixture "failure-$failure"
        $script:failure = $failure
        Assert-Throws { Sign-Fixture $root } "$failure failure cannot be reported as signed" '失败'
        Assert-Signing ((Test-Path -LiteralPath (Join-Path $root 'app [release]-unsigned.apk')) -and -not (Test-Path -LiteralPath (Join-Path $root 'app [release]-signed.apk'))) "$failure failure preserves original without publishing APK"
        Assert-Signing (@(Get-ChildItem -LiteralPath $root -Force -Directory).Count -eq 0) "$failure failure removes temporary artifacts"
    }
    $script:failure = 'multi'
    $root = New-ApkFixture 'multi' "signed:$script:fp"
    Assert-Throws { Sign-Fixture $root } 'Ambiguous multiple signing identities rejected' '唯一'
    $script:failure = ''
    $names = @($script:toolCalls | ForEach-Object { $_.Arguments } | Where-Object { $_ -like 'IMAGE_STUDIO_*PASSWORD_*' -or $_ -like 'env:IMAGE_STUDIO_*PASSWORD_*' } | ForEach-Object { $_ -replace '^env:', '' })
    Assert-Signing (@($names | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }).Count -eq 0) 'Temporary password environment cleared on success and failure'
    $exports = @($script:toolCalls | Where-Object { $_.Tool -eq 'mock-keytool' } | ForEach-Object { $_.Arguments[$_.Arguments.IndexOf('-file') + 1] })
    Assert-Signing (@($exports | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0) 'Public certificate export files cleaned on success and failure'

    $repo = Split-Path $PSScriptRoot -Parent
    $workflow = [IO.File]::ReadAllText((Join-Path $repo '.github/workflows/build.yml'))
    Assert-Signing ($workflow -notmatch 'genkeypair|ci-upload|SECRET_KEY_PASSWORD|ANDROID_KS_PASSWORD') 'CI has no ephemeral signing or default password fallback'
    Assert-Signing ($workflow.IndexOf('prepare-android-signing.ps1 -ValidateOnly') -lt $workflow.IndexOf('name: 构建 APK')) 'Signing secrets are checked before APK compilation'
    Assert-Signing ($workflow -match "if: github.event_name != 'pull_request'" -and $workflow -match 'outputs/apk/\*\*/\*-signed.apk') 'PR never signs; Release only uploads verified signed APKs'
    $ignore = [IO.File]::ReadAllText((Join-Path $repo '.gitignore'))
    foreach ($pattern in @('*.jks', '*.keystore', '*.p12', '*.pfx')) {
        Assert-Signing ($ignore.Contains($pattern)) "Private key ignore rule: $pattern"
    }
    foreach ($file in @('sign-android-apk.ps1', 'prepare-android-signing.ps1', 'lib/android-signing.ps1')) {
        $errors = $null
        $tokens = $null
        $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$errors)
        Assert-Signing ($errors.Count -eq 0) "PowerShell syntax: $file"
    }
} finally {
    $absolute = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $absolute.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $absolute -Leaf) -notlike 'image-studio-signing-*') { throw 'Signing fixture outside intended temporary directory' }
    Remove-Item -LiteralPath $absolute -Recurse -Force
}
