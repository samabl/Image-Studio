# 离线安装与源代码防回归检查；不等同于安卓真机锁屏验收。
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
    $gradlePath = Join-Path $fixtureRoot 'app/build.gradle.kts'
    [IO.File]::WriteAllText($gradlePath, 'android { namespace = "app.fixture"; compileSdk = 34 }')
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
    Assert-Background ($doc.manifest.'uses-permission'.Count -eq 7) '后台服务、电池优化、通知与旧版相册权限完整注入'
    $legacy = $doc.manifest.'uses-permission' | Where-Object { $_.name -eq 'android.permission.WRITE_EXTERNAL_STORAGE' }
    Assert-Background ($legacy.maxSdkVersion -eq '28') '旧存储权限只适用于 Android 9 及以下'
    Assert-Background ($doc.manifest.application.activity.name -eq '.MainActivity') '保留现有 Activity'
    Assert-Background ($doc.manifest.application.provider.authorities -eq '${applicationId}.fileprovider') '保留 FileProvider 占位符'
    Assert-Background ($doc.manifest.application.networkSecurityConfig -eq '@xml/network_security_config') '保留内网流量配置'
    Assert-Background ($doc.manifest.application.service.exported -eq 'false' -and $doc.manifest.application.service.foregroundServiceType -eq 'dataSync') '服务不对外导出，声明 Android 数据同步类型'
    foreach ($file in @('BackgroundTasksPlugin.kt', 'BackgroundTasksService.kt', 'BackgroundTaskRuntime.kt')) {
        $installed = Join-Path $main "java/app/imagestudio/background/$file"
        Assert-Background (Test-Path -LiteralPath $installed) "已安装 $file"
        Assert-Background ([IO.File]::ReadAllText($installed) -eq [IO.File]::ReadAllText((Join-Path $source $file))) "$file 安装内容与跟踪源码一致"
    }
    Assert-Background (Test-Path (Join-Path $fixtureRoot 'app/background-tasks.pro')) 'Release 保留规则已安装'
    $firstGradle = [IO.File]::ReadAllText($gradlePath)
    Assert-Background ($firstGradle.Contains('namespace = "app.fixture"') -and $firstGradle.Contains('maxOf(compileSdk ?: 35, 35)')) '保留已有 Gradle 设置并确保系统超时回调所需的 compile SDK 35+'
    Assert-Background ($firstGradle.Contains('proguardFiles("background-tasks.pro")')) 'Release 实际接入原生插件保留规则，不只是写入未使用的文件'
    Install-AndroidBackgroundTasks -AndroidRoot $fixtureRoot -SourceRoot $source
    Assert-Background ([IO.File]::ReadAllText($manifestPath) -eq $first) '重复安装不增加权限或服务'
    Assert-Background ([IO.File]::ReadAllText($gradlePath) -eq $firstGradle) '重复安装不增加 Gradle 配置或 Release 保留规则'

    $service = [IO.File]::ReadAllText((Join-Path $source 'BackgroundTasksService.kt'))
    $plugin = [IO.File]::ReadAllText((Join-Path $source 'BackgroundTasksPlugin.kt'))
    $runtime = [IO.File]::ReadAllText((Join-Path $source 'BackgroundTaskRuntime.kt'))
    $startIndex = $service.IndexOf('intent?.action == START')
    $finishIndex = $service.IndexOf('intent?.action == FINISH')
    $start = $service.Substring($startIndex, $finishIndex - $startIndex)
    Assert-Background ($service -match 'PARTIAL_WAKE_LOCK' -and $service -match 'setReferenceCounted\(false\)') '使用不点亮屏幕的非引用计数 Wake Lock'
    Assert-Background ($service -match 'LOCK_TIMEOUT_MS = 10 \* 60 \* 1000L' -and $service -match 'lock\.acquire\(LOCK_TIMEOUT_MS\)') 'Wake Lock 具有有界的十分钟超时'
    Assert-Background ($service -match 'RENEW_INTERVAL_MS = 2 \* 60 \* 1000L' -and $service -match 'handler\.postDelayed\(renewLock, RENEW_INTERVAL_MS\)') '原生 Handler 定时续期，不依赖锁屏后的 JS 定时器'
    Assert-Background ($start.IndexOf('updateNotification()') -lt $start.IndexOf('acquireWakeLock()') -and $start.IndexOf('acquireWakeLock()') -lt $start.IndexOf('reply(intent, null)')) '先建立前台通知，再获取锁，最后确认 ready 才允许付费请求'
    Assert-Background ($service -match 'mutableSetOf<String>\(\)' -and $service -match 'tasks\.remove\(taskId\)' -and $service -match 'if \(tasks\.isEmpty\(\)\) stopProtection\(startId\) else') '并发任务独立登记，最后一个结束才释放保护'
    Assert-Background ($service -match 'return START_NOT_STICKY' -and $service -notmatch '\bSTART_STICKY\b') '系统重启不自动重放付费请求'
    Assert-Background ($service -match '(?s)private fun reply.*?runCatching.*?receiver\?\.send') '迟到或失效的启动回执不能导致服务崩溃'
    Assert-Background ($service -match '(?s)private fun releaseWakeLock.*?removeCallbacks\(renewLock\).*?it\.release\(\)' -and $service -match '(?s)override fun onTimeout.*?interrupt\(' -and $service -match '(?s)override fun onDestroy.*?releaseWakeLock\(') '超时、系统终止与异常均释放锁并通知真实中断'
    Assert-Background ($service -match '(?s)private fun interrupt.*?tasks\.clear\(\).*?releaseWakeLock\(\).*?BackgroundTaskRuntime\.interrupted\(reason\).*?stopSelf\(\)') '失效保护不伪称完成，也不尝试无限重启服务'

    $commandStart = $plugin.Substring($plugin.IndexOf('fun start(invoke:'), $plugin.IndexOf('fun finish(invoke:') - $plugin.IndexOf('fun start(invoke:'))
    Assert-Background ($commandStart -match 'postDelayed\(timeout, 10_000L\)' -and $commandStart -match 'compareAndSet\(false, true\)') '后台启动确认有界且只结算一次'
    Assert-Background ([regex]::Matches($commandStart, 'finishOrphan\(\)').Count -ge 4) '启动失败、超时及迟到成功回执都清理孤立任务'
    Assert-Background ($plugin -match '(?s)override fun onDestroy.*?BackgroundTaskRuntime\.detach\(\).*?runCatching.*?stopService') 'WebView 销毁时释放服务，不吞掉异常后留下永久锁'
    Assert-Background ($plugin -match '(?s)override fun load.*?BackgroundTaskRuntime\.attach' -and $plugin -match 'setPaused\(true\)' -and $plugin -match 'setPaused\(false\)') '原生插件监听 WebView 的真实生命周期'

    Assert-Background ($runtime -match 'WeakReference<WebView>' -and $runtime -match 'Looper\.myLooper\(\) == Looper\.getMainLooper\(\)' -and $runtime -match 'main\.post') 'WebView 弱引用不保留销毁页面，调度仅在主线程执行'
    Assert-Background ($runtime -match 'rendererRequestedPriority' -and $runtime -match 'rendererPriorityWaivedWhenNotVisible' -and $runtime -match 'setRendererPriorityPolicy\(policy\.first, policy\.second\)') '空闲后恢复实际原渲染优先级，而不是假设默认策略'
    Assert-Background ($runtime -match 'RENDERER_PRIORITY_IMPORTANT, false' -and $runtime -match 'if \(running \|\| !paused\)' -and $runtime -match 'view\.resumeTimers\(\)') '运行任务在隐藏页面保留 JS 调度与渲染优先级'
    Assert-Background ($runtime -match 'JSONObject\.quote\(reason\)' -and $runtime -match 'image-studio-background-error' -and $runtime.Contains('view.evaluateJavascript(script) { applyScheduling() }')) '安全传递中断原因，派发完成后再恢复空闲策略'
    Assert-Background ($runtime -match 'postDelayed\(\{ applyScheduling\(\) \}, 1_000L\)') '渲染进程不回调时也能收回运行优先级'

    foreach ($file in @('test-android-background.ps1', 'lib/android-background.ps1')) {
        $errors = $null; $tokens = $null
        $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$errors)
        Assert-Background ($errors.Count -eq 0) "PowerShell 语法正确：$file"
    }
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedFixture -Leaf) -notlike 'image-studio-background-*') {
        throw '临时测试路径超出预期范围'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
