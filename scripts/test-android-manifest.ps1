# 单元测试：AndroidManifest.xml 补丁工具。
#
#   pwsh -File scripts/test-android-manifest.ps1
#
# 回归背景：这段逻辑曾经把字面量「反引号+n」写进 XML（单引号字符串不做转义），
# 导致 CI 上 Gradle 的 ManifestMerger 报 "Error parsing AndroidManifest.xml"。
# 这个测试就是用来锁死那个坑的。

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib/android-manifest.ps1")

$script:failed = 0
$script:passed = 0

function Assert-That {
    param([string]$Name, [bool]$Condition, [string]$Detail = "")
    if ($Condition) {
        $script:passed++
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    } else {
        $script:failed++
        Write-Host "  [FAIL] $Name  $Detail" -ForegroundColor Red
    }
}

$sample = @'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:allowBackup="true"
        android:label="GPT Image Studio">
        <activity android:name=".MainActivity" />
    </application>
</manifest>
'@

Write-Host "`n=== Add-AndroidManifestAttribute ===" -ForegroundColor White

# 1) 注入 networkSecurityConfig
$out = Add-AndroidManifestAttribute -Content $sample -Name "android:networkSecurityConfig" -Value "@xml/network_security_config"
Assert-That "返回值非空" ($null -ne $out)
Assert-That "结果仍是格式良好的 XML" (Test-WellFormedXml $out)
Assert-That "包含目标属性" ($out -match 'android:networkSecurityConfig="@xml/network_security_config"')
Assert-That "属性落在 <application> 标签内" ($out -match '<application\s+android:networkSecurityConfig=')
Assert-That "没有把反引号写进 XML（回归点）" (-not $out.Contains('`n'))
Assert-That "没有出现字面量 n 开头（回归点）" (-not $out.Contains('`n        android'))

# 2) 幂等性
$again = Add-AndroidManifestAttribute -Content $out -Name "android:networkSecurityConfig" -Value "@xml/network_security_config"
Assert-That "重复调用不产生重复属性" ((($again -split 'networkSecurityConfig').Count - 1) -eq 1)

# 3) 再叠加 usesCleartextTraffic
$out2 = Add-AndroidManifestAttribute -Content $out -Name "android:usesCleartextTraffic" -Value "true"
Assert-That "叠加第二个属性后仍是合法 XML" (Test-WellFormedXml $out2)
Assert-That "两个属性都在" (($out2 -match 'networkSecurityConfig') -and ($out2 -match 'usesCleartextTraffic="true"'))

# 4) 找不到 <application> 时返回 $null
$noApp = '<?xml version="1.0"?><manifest><uses-permission android:name="x" /></manifest>'
$nullOut = Add-AndroidManifestAttribute -Content $noApp -Name "android:networkSecurityConfig" -Value "@xml/x"
Assert-That "没有 <application> 时返回 null" ($null -eq $nullOut)

# 5) 单行写法（<application 后面直接跟属性）也要能插进去
#    注意必须声明 xmlns:android，否则 [xml] 会因为未声明的前缀而解析失败
$inline = '<?xml version="1.0"?><manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="x"><activity /></application></manifest>'
$out3 = Add-AndroidManifestAttribute -Content $inline -Name "android:networkSecurityConfig" -Value "@xml/y"
Assert-That "单行 <application> 也能注入" ((Test-WellFormedXml $out3) -and ($out3 -match 'networkSecurityConfig="@xml/y"'))

# 6) 完整落盘流程：写出来的文件必须是「UTF-8 无 BOM 且合法 XML」
#    （带 BOM 会让 Gradle 的 ManifestMerger 解析失败，所以这里把写盘方式也测上）
$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("gis-manifest-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$tmpFile = Join-Path $tmpDir "AndroidManifest.xml"
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($tmpFile, $out2, $utf8NoBom)

    $bytes = [IO.File]::ReadAllBytes($tmpFile)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    Assert-That "写出的文件不带 UTF-8 BOM" (-not $hasBom)
    Assert-That "写出的文件可被 [xml] 重新解析" (Test-WellFormedXml ([IO.File]::ReadAllText($tmpFile)))
} finally {
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n通过 $script:passed 项，失败 $script:failed 项" -ForegroundColor $(if ($script:failed) { "Red" } else { "Green" })
exit $(if ($script:failed) { 1 } else { 0 })
