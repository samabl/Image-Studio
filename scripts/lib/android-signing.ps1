# 固定 Release 签名共用逻辑。密码只通过子进程环境传递，不写入命令行或构建产物。
function ConvertTo-AndroidCertificateFingerprint {
    param([string]$Value)
    $normalized = ($Value -replace '[:\s]', '').ToLowerInvariant()
    if ($normalized -notmatch '^[a-f0-9]{64}$') { throw 'Android 签名证书 SHA-256 必须是 64 位十六进制指纹' }
    return $normalized
}

function Assert-AndroidSigningSecrets {
    param([string]$KeyBase64, [string]$KeyAlias, [string]$KeyPassword, [string]$ExpectedCertificateSha256)
    $missing = @()
    if ([string]::IsNullOrWhiteSpace($KeyBase64)) { $missing += 'ANDROID_KEY_BASE64' }
    if ([string]::IsNullOrWhiteSpace($KeyAlias)) { $missing += 'ANDROID_KEY_ALIAS' }
    if ([string]::IsNullOrWhiteSpace($KeyPassword)) { $missing += 'ANDROID_KEY_PASSWORD' }
    if ($missing.Count) { throw "固定 Release 签名缺少 Secrets：$($missing -join ', ')；禁止生成临时密钥或使用 debug 签名" }
    try { $bytes = [Convert]::FromBase64String($KeyBase64) } catch { throw 'ANDROID_KEY_BASE64 不是有效的 keystore base64' }
    if ($bytes.Length -eq 0) { throw 'ANDROID_KEY_BASE64 为空' }
    if ($ExpectedCertificateSha256) { $null = ConvertTo-AndroidCertificateFingerprint $ExpectedCertificateSha256 }
}

function Invoke-AndroidSigningTool {
    param([string]$Tool, [string[]]$Arguments)
    # 捕获输出，避免把原生工具的错误内容（可能含敏感参数）直接写入 CI 日志。
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $Tool @Arguments 2>&1
        $code = $LASTEXITCODE
        return @{ ExitCode = $code; Output = ($output -join "`n") }
    } finally { $ErrorActionPreference = $previous }
}

function Get-AndroidSigningTools {
    $windows = $IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop'
    $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
    if (-not $sdk -or -not (Test-Path -LiteralPath $sdk -PathType Container)) { throw 'ANDROID_HOME / ANDROID_SDK_ROOT 未设置或 SDK 不存在' }
    $buildToolsRoot = Join-Path $sdk 'build-tools'
    $buildTools = Get-ChildItem -LiteralPath $buildToolsRoot -Directory | Where-Object { $_.Name -match '^\d+(\.\d+){1,2}$' } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $buildTools) { throw '找不到已安装的 Android SDK build-tools' }
    $result = @{}
    foreach ($name in @('zipalign', 'apksigner')) {
        $candidates = if ($windows) { @("$name.exe", "$name.bat", $name) } else { @($name) }
        foreach ($file in $candidates) {
            $path = Join-Path $buildTools.FullName $file
            if (Test-Path -LiteralPath $path -PathType Leaf) { $result[$name] = $path; break }
        }
        if (-not $result[$name]) { throw "SDK build-tools 缺少 $name" }
    }
    $result.keytool = Get-AndroidKeytool
    return $result
}

function Get-AndroidKeytool {
    if ($env:JAVA_HOME) {
        $name = if ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') { 'keytool.exe' } else { 'keytool' }
        $path = Join-Path $env:JAVA_HOME "bin/$name"
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    $command = Get-Command keytool -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw '找不到 keytool，请安装 JDK 并设置 JAVA_HOME'
}

function Get-AndroidKeystoreFingerprint {
    param([string]$Keytool, [string]$KeystorePath, [string]$KeyAlias, [string]$StorePassword)
    $name = 'IMAGE_STUDIO_STORE_PASSWORD_' + [Guid]::NewGuid().ToString('N')
    $certificate = Join-Path ([IO.Path]::GetTempPath()) ('image-studio-certificate-' + [Guid]::NewGuid().ToString('N') + '.der')
    try {
        [Environment]::SetEnvironmentVariable($name, $StorePassword, 'Process')
        # exportcert 仅导出指定 alias 的叶证书（DER），不会把证书链中其他指纹误当成签名身份。
        # 直接计算 DER 的 SHA-256，不依赖 keytool 的语言、缩进或文本格式。
        $result = Invoke-AndroidSigningTool $Keytool @('-exportcert', '-keystore', $KeystorePath, '-alias', $KeyAlias, '-storepass:env', $name, '-file', $certificate)
        if ($result.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $certificate -PathType Leaf) -or (Get-Item -LiteralPath $certificate).Length -eq 0) {
            throw '无法读取固定签名证书，请检查 keystore、alias 和密码'
        }
        return ConvertTo-AndroidCertificateFingerprint (Get-FileHash -LiteralPath $certificate -Algorithm SHA256).Hash
    } finally {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        Remove-Item -LiteralPath $certificate -Force -ErrorAction SilentlyContinue
    }
}

function Get-AndroidApkSignature {
    param([string]$Apksigner, [string]$ApkPath)
    $result = Invoke-AndroidSigningTool $Apksigner @('verify', '--print-certs', $ApkPath)
    if ($result.ExitCode -ne 0) { return @{ Signed = $false; Fingerprint = $null } }
    $fingerprintMatches = [regex]::Matches($result.Output, '(?mi)^signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9:]+)\s*$')
    if ($fingerprintMatches.Count -eq 0) { throw 'Release APK 必须由唯一的固定签名证书签名' }
    # 新版 Build Tools 可能按签名方案重复报告同一个 signer；只拒绝不同的证书身份。
    $fingerprints = @($fingerprintMatches | ForEach-Object {
        ConvertTo-AndroidCertificateFingerprint $_.Groups[1].Value
    } | Sort-Object -Unique)
    if ($fingerprints.Count -ne 1) { throw 'Release APK 必须由唯一的固定签名证书签名' }
    return @{ Signed = $true; Fingerprint = $fingerprints[0] }
}

function Invoke-AndroidReleaseSigning {
    param(
        [string]$KeystorePath, [string]$KeyAlias, [string]$KeyPassword, [string]$StorePassword,
        [string]$ApkRoot, [string]$ExpectedCertificateSha256, [string]$CertificateOutput,
        [switch]$Force, [hashtable]$Tools
    )
    if ([string]::IsNullOrWhiteSpace($KeyAlias) -or [string]::IsNullOrWhiteSpace($KeyPassword)) { throw '固定 Release 签名必须提供 alias 和密码；不能回退到 debug 签名' }
    if (-not $KeystorePath -or -not (Test-Path -LiteralPath $KeystorePath -PathType Leaf)) { throw '固定 Release keystore 不存在' }
    if (-not $StorePassword) { $StorePassword = $KeyPassword }
    if (-not (Test-Path -LiteralPath $ApkRoot -PathType Container)) { throw "APK 目录不存在：$ApkRoot" }
    if (-not $Tools) { $Tools = Get-AndroidSigningTools }
    $keystoreAbs = (Resolve-Path -LiteralPath $KeystorePath).Path
    $root = (Resolve-Path -LiteralPath $ApkRoot).Path
    $fingerprint = Get-AndroidKeystoreFingerprint $Tools.keytool $keystoreAbs $KeyAlias $StorePassword
    if ($ExpectedCertificateSha256 -and $fingerprint -ne (ConvertTo-AndroidCertificateFingerprint $ExpectedCertificateSha256)) {
        throw 'keystore 与固定 ANDROID_SIGNING_CERT_SHA256 不一致，拒绝更换 Release 签名'
    }
    $apks = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.apk' | Where-Object { $_.BaseName -notlike '*-aligned' })
    if ($apks.Count -eq 0) { throw "没有找到 APK：$root" }
    $storeEnv = 'IMAGE_STUDIO_STORE_PASSWORD_' + [Guid]::NewGuid().ToString('N')
    $keyEnv = 'IMAGE_STUDIO_KEY_PASSWORD_' + [Guid]::NewGuid().ToString('N')
    try {
        [Environment]::SetEnvironmentVariable($storeEnv, $StorePassword, 'Process')
        [Environment]::SetEnvironmentVariable($keyEnv, $KeyPassword, 'Process')
        foreach ($apk in $apks) {
            $signature = Get-AndroidApkSignature $Tools.apksigner $apk.FullName
            if ($signature.Signed -and $signature.Fingerprint -ne $fingerprint) { throw "APK 已使用不同证书签名，拒绝发布：$($apk.Name)" }
            $base = $apk.BaseName -replace '(-unsigned|-signed)$', ''
            $destination = Join-Path $apk.DirectoryName ($base + '-signed.apk')
            if ($destination -ne $apk.FullName -and (Test-Path -LiteralPath $destination)) { throw "签名输出已存在，拒绝覆盖：$(Split-Path $destination -Leaf)" }
            if ($signature.Signed -and -not $Force) {
                $check = Invoke-AndroidSigningTool $Tools.zipalign @('-c', '4', $apk.FullName)
                if ($check.ExitCode -ne 0) { throw "已签名 APK 未对齐，请使用 -Force 重新处理：$($apk.Name)" }
                if ($destination -ne $apk.FullName) { Move-Item -LiteralPath $apk.FullName -Destination $destination }
                Write-Host "[ok] $($apk.Name)：固定证书签名已校验"
                continue
            }
            $temporary = Join-Path $apk.DirectoryName ('.image-studio-signing-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $temporary | Out-Null
            try {
                $aligned = Join-Path $temporary 'aligned.apk'
                $signed = Join-Path $temporary 'signed.apk'
                $align = Invoke-AndroidSigningTool $Tools.zipalign @('-p', '-f', '4', $apk.FullName, $aligned)
                if ($align.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $aligned)) { throw "zipalign 失败：$($apk.Name)" }
                $sign = Invoke-AndroidSigningTool $Tools.apksigner @('sign', '--ks', $keystoreAbs, '--ks-key-alias', $KeyAlias,
                    '--ks-pass', "env:$storeEnv", '--key-pass', "env:$keyEnv", '--v1-signing-enabled', 'true',
                    '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--out', $signed, $aligned)
                if ($sign.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $signed)) { throw "apksigner 签名失败：$($apk.Name)" }
                $verified = Get-AndroidApkSignature $Tools.apksigner $signed
                if (-not $verified.Signed -or $verified.Fingerprint -ne $fingerprint) { throw "签名证书校验失败：$($apk.Name)" }
                $check = Invoke-AndroidSigningTool $Tools.zipalign @('-c', '4', $signed)
                if ($check.ExitCode -ne 0) { throw "签名后 APK 对齐校验失败：$($apk.Name)" }
                Move-Item -LiteralPath $signed -Destination $destination -Force:$Force
                if ($destination -ne $apk.FullName) { Remove-Item -LiteralPath $apk.FullName -Force }
                Write-Host "[ok] $($apk.Name)：固定签名完成"
            } finally {
                $absolute = [IO.Path]::GetFullPath($temporary)
                $parent = [IO.Path]::GetFullPath($apk.DirectoryName) + [IO.Path]::DirectorySeparatorChar
                if (-not $absolute.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $absolute -Leaf) -notlike '.image-studio-signing-*') { throw '签名临时目录超出预期范围' }
                Remove-Item -LiteralPath $absolute -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } finally {
        [Environment]::SetEnvironmentVariable($storeEnv, $null, 'Process')
        [Environment]::SetEnvironmentVariable($keyEnv, $null, 'Process')
    }
    if (-not $CertificateOutput) { $CertificateOutput = Join-Path $root 'android-signing-cert.sha256' }
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($CertificateOutput), "$fingerprint`n", [Text.UTF8Encoding]::new($false))
    Write-Host "[ok] 全部 APK 固定签名证书 SHA-256：$fingerprint"
}
