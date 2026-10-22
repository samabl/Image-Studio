# 将受版本控制的安全区域实现安装到 Tauri 生成的 MainActivity。
function Install-AndroidActivityInsets {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$JavaRoot,
        [Parameter(Mandatory = $true)][string]$TemplatePath
    )
    $activities = @(Get-ChildItem -LiteralPath $JavaRoot -Recurse -File -Filter MainActivity.kt)
    if ($activities.Count -ne 1) { throw "预期一个生成的 MainActivity.kt，实际找到 $($activities.Count) 个" }
    $activityPath = $activities[0].FullName
    $original = [IO.File]::ReadAllText($activityPath)
    $package = [regex]::Match($original, '(?m)^\s*package\s+([A-Za-z_][\w.]*)\s*$')
    if (-not $package.Success) { throw 'MainActivity.kt 缺少合法的 package 声明' }
    $template = [IO.File]::ReadAllText($TemplatePath)
    if (-not $template.Contains('__APP_PACKAGE__')) { throw 'MainActivity 模板缺少 package 占位符' }
    $patched = $template.Replace('__APP_PACKAGE__', $package.Groups[1].Value)
    if ($patched -ne $original) {
        [IO.File]::WriteAllText($activityPath, $patched, (New-Object System.Text.UTF8Encoding($false)))
    }
}
