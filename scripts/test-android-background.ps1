$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/android-background.ps1')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('image-studio-background-' + [Guid]::NewGuid().ToString('N'))
$main = Join-Path $fixtureRoot 'app/src/main'
$manifestPath = Join-Path $main 'AndroidManifest.xml'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri/android'
New-Item -ItemType Directory -Force -Path $main | Out-Null
function Assert-Background($condition, $message) {
    if (-not $condition) { throw $message }
    Write-Host "[PASS] $message"
}
try {
    [IO.File]::WriteAllText($manifestPath, @'
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:networkSecurityConfig="@xml/network_security_config">
    <activity android:name=".MainActivity" android:exported="true" />
    <provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider" />
  </application>
</manifest>
'@)
    Install-AndroidBackgroundTasks -AndroidRoot $fixtureRoot -SourceRoot $source
    $first = [IO.File]::ReadAllText($manifestPath)
    [xml]$doc = $first
    Assert-Background ($doc.manifest.'uses-permission'.Count -eq 6) '后台服务、电池优化和通知权限完整注入'
    Assert-Background ($doc.manifest.application.activity.name -eq '.MainActivity') '保留现有 Activity'
    Assert-Background ($doc.manifest.application.provider.authorities -eq '${applicationId}.fileprovider') '保留 FileProvider 占位符'
    Assert-Background ($doc.manifest.application.networkSecurityConfig -eq '@xml/network_security_config') '保留内网流量配置'
    Assert-Background ($doc.manifest.application.service.exported -eq 'false' -and $doc.manifest.application.service.foregroundServiceType -eq 'dataSync') '服务不对外导出，声明 Android 数据同步类型'
    foreach ($file in @('BackgroundTasksPlugin.kt', 'BackgroundTasksService.kt')) {
        Assert-Background (Test-Path (Join-Path $main "java/app/imagestudio/background/$file")) "已安装 $file"
    }
    Assert-Background (Test-Path (Join-Path $fixtureRoot 'app/background-tasks.pro')) 'Release 保留反射加载的原生插件'
    Install-AndroidBackgroundTasks -AndroidRoot $fixtureRoot -SourceRoot $source
    Assert-Background ([IO.File]::ReadAllText($manifestPath) -eq $first) '重复安装不增加权限或服务'
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedFixture -Leaf) -notlike 'image-studio-background-*') {
        throw '临时测试路径超出预期范围'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
