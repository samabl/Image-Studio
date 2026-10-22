$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot

pnpm exec tauri icon src-tauri/icons/icon-manifest.json --output src-tauri/icons
if ($LASTEXITCODE -ne 0) { throw '平台图标生成失败' }

# Tauri 检测到已初始化的 Android 工程时，把 PNG 写到生成工程而不是 --output。
# 必须收回版本控制目录，CI 新建工程才能使用同一组新图标。
$androidResources = Join-Path $projectRoot 'src-tauri/gen/android/app/src/main/res'
if (Test-Path (Join-Path $androidResources 'mipmap-xxxhdpi/ic_launcher_background.png')) {
    foreach ($density in @('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi')) {
        $destination = Join-Path $projectRoot "src-tauri/icons/android/mipmap-$density"
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        foreach ($name in @('ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png', 'ic_launcher_background.png')) {
            Copy-Item -LiteralPath (Join-Path $androidResources "mipmap-$density/$name") -Destination (Join-Path $destination $name) -Force
        }
    }
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$adaptive = @'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <background android:drawable="@mipmap/ic_launcher_background"/>
</adaptive-icon>
'@
[IO.File]::WriteAllText((Join-Path $projectRoot 'src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml'), $adaptive, $utf8)
[IO.File]::WriteAllText((Join-Path $projectRoot 'src-tauri/icons/android/values/ic_launcher_background.xml'), "<?xml version=`"1.0`" encoding=`"utf-8`"?>`n<resources><color name=`"ic_launcher_background`">#F6FCFC</color></resources>`n", $utf8)
New-Item -ItemType Directory -Force -Path public | Out-Null
Copy-Item -LiteralPath src-tauri/icons/128x128.png -Destination public/app-icon.png -Force
Write-Host '已更新 Windows / Android / iOS 图标与应用内标识'
