$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/android-activity.ps1')

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('image-studio-insets-' + [Guid]::NewGuid().ToString('N'))
$javaRoot = Join-Path $fixtureRoot 'java'
$packageDir = Join-Path $javaRoot 'com/example/renamed'
$activityPath = Join-Path $packageDir 'MainActivity.kt'
$template = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri/android/MainActivity.kt'
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null

function Assert-Activity($condition, $message) {
    if (-not $condition) { throw $message }
    Write-Host "[PASS] $message"
}

try {
    [IO.File]::WriteAllText($activityPath, "package com.example.renamed`n`nclass MainActivity : TauriActivity() {}`n")
    Install-AndroidActivityInsets -JavaRoot $javaRoot -TemplatePath $template
    $installed = [IO.File]::ReadAllText($activityPath)
    Assert-Activity ($installed.StartsWith('package com.example.renamed')) '保留生成工程的 package，支持 identifier 改名'
    Assert-Activity (-not $installed.Contains('__APP_PACKAGE__')) '模板占位符已完全替换'
    Assert-Activity ($installed.Contains('onBackPressedDispatcher.addCallback') -and $installed.Contains('window.__imageStudioBack') -and $installed.Contains('moveTaskToBack(true)')) '返回键进入前端分层处理，仅明确返回桌面时移到后台'
    $bytes = [IO.File]::ReadAllBytes($activityPath)
    Assert-Activity (-not ($bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf)) 'Kotlin 文件使用无 BOM 的 UTF-8'
    Install-AndroidActivityInsets -JavaRoot $javaRoot -TemplatePath $template
    Assert-Activity ([IO.File]::ReadAllText($activityPath) -eq $installed) '重复安装幂等，不重复添加 Activity 代码'
    [IO.File]::WriteAllText($activityPath, 'invalid activity')
    $rejected = $false
    try { Install-AndroidActivityInsets -JavaRoot $javaRoot -TemplatePath $template } catch { $rejected = $true }
    Assert-Activity $rejected '生成文件缺少 package 时中止，不写坏文件'
    Assert-Activity ([IO.File]::ReadAllText($activityPath) -eq 'invalid activity') '失败后保留原文件'
    $duplicate = Join-Path $javaRoot 'MainActivity.kt'
    [IO.File]::WriteAllText($duplicate, 'package duplicate')
    $rejected = $false
    try { Install-AndroidActivityInsets -JavaRoot $javaRoot -TemplatePath $template } catch { $rejected = $true }
    Assert-Activity $rejected '多个 Activity 时中止，避免改错工程'
} finally {
    # 只删除本测试创建且经过路径校验的临时目录。
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedFixture -Leaf) -notlike 'image-studio-insets-*') {
        throw '临时测试路径超出预期范围'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
