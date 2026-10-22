function Install-AndroidBackgroundTasks {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$AndroidRoot,
        [Parameter(Mandatory = $true)][string]$SourceRoot
    )
    $manifestPath = Join-Path $AndroidRoot 'app/src/main/AndroidManifest.xml'
    $manifest = New-Object System.Xml.XmlDocument
    $manifest.PreserveWhitespace = $true
    $manifest.Load($manifestPath)
    $androidNs = 'http://schemas.android.com/apk/res/android'
    $ns = New-Object System.Xml.XmlNamespaceManager($manifest.NameTable)
    $ns.AddNamespace('android', $androidNs)
    $application = $manifest.SelectSingleNode('/manifest/application')
    if ($null -eq $application) { throw 'AndroidManifest.xml 缺少 application' }
    foreach ($permission in @('FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC', 'WAKE_LOCK', 'POST_NOTIFICATIONS', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')) {
        $name = 'android.permission.' + $permission
        if ($null -eq $manifest.SelectSingleNode("/manifest/uses-permission[@android:name='$name']", $ns)) {
            $entry = $manifest.CreateElement('uses-permission')
            [void]$entry.SetAttribute('name', $androidNs, $name)
            [void]$manifest.DocumentElement.InsertBefore($entry, $application)
        }
    }
    $legacy = $manifest.SelectSingleNode('/manifest/uses-permission[@android:name="android.permission.WRITE_EXTERNAL_STORAGE"]', $ns)
    if ($null -eq $legacy) {
        $legacy = $manifest.CreateElement('uses-permission')
        [void]$legacy.SetAttribute('name', $androidNs, 'android.permission.WRITE_EXTERNAL_STORAGE')
        [void]$manifest.DocumentElement.InsertBefore($legacy, $application)
    }
    [void]$legacy.SetAttribute('maxSdkVersion', $androidNs, '28')
    $service = $manifest.SelectSingleNode('/manifest/application/service[@android:name="app.imagestudio.background.BackgroundTasksService"]', $ns)
    if ($null -eq $service) {
        $service = $manifest.CreateElement('service')
        [void]$application.AppendChild($service)
    }
    [void]$service.SetAttribute('name', $androidNs, 'app.imagestudio.background.BackgroundTasksService')
    [void]$service.SetAttribute('exported', $androidNs, 'false')
    [void]$service.SetAttribute('foregroundServiceType', $androidNs, 'dataSync')
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $writer = [System.Xml.XmlWriter]::Create($manifestPath, $settings)
    try { $manifest.Save($writer) } finally { $writer.Dispose() }
    $packageDir = Join-Path $AndroidRoot 'app/src/main/java/app/imagestudio/background'
    New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
    foreach ($file in @('BackgroundTasksPlugin.kt', 'BackgroundTasksService.kt')) {
        Copy-Item -LiteralPath (Join-Path $SourceRoot $file) -Destination (Join-Path $packageDir $file) -Force
    }
    [IO.File]::WriteAllText((Join-Path $AndroidRoot 'app/background-tasks.pro'), '-keep class app.imagestudio.background.** { *; }', (New-Object System.Text.UTF8Encoding($false)))
}
