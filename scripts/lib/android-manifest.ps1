# AndroidManifest.xml 的轻量补丁工具。
#
# 单独成文件是为了能被 scripts/test-android-manifest.ps1 直接 dot-source 做单元测试
# —— 在 CI 上因为一个字符写错而让整条流水线挂掉，代价太高了。

<#
.SYNOPSIS
    往 AndroidManifest.xml 的 <application> 标签插入一个属性。

.DESCRIPTION
    已经是幂等的：属性已存在就原样返回。

    实现上刻意用字符串拼接而不是 -replace：
    PowerShell 的单引号字符串不做转义，'-replace ... , '$1`n' 会把「反引号+n」
    这两个字符原样写进 XML，直接导致 Gradle 的 ManifestMerger 解析失败。
    改用显式的 Substring 拼接，彻底避开替换串的转义坑。

.OUTPUTS
    返回新的 XML 文本；若找不到 <application> 标签则返回 $null。
#>
function Add-AndroidManifestAttribute {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content,
        # 例如 android:networkSecurityConfig
        [Parameter(Mandatory = $true)][string]$Name,
        # 例如 "@xml/network_security_config"
        [Parameter(Mandatory = $true)][string]$Value
    )

    # 已经打过这个补丁就什么都不做
    if ($Content -match [regex]::Escape($Name)) {
        return $Content
    }

    $match = [regex]::Match($Content, '<application\b')
    if (-not $match.Success) {
        return $null
    }

    $insertAt = $match.Index + $match.Length
    $attribute = '{0}="{1}"' -f $Name, $Value

    # 双引号字符串里的 `n 才是真正的换行
    return $Content.Substring(0, $insertAt) + "`n        " + $attribute + $Content.Substring($insertAt)
}

<#
.SYNOPSIS
    校验一段文本是不是格式良好的 XML。返回 $true/$false。
#>
function Test-WellFormedXml {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content)

    try {
        $null = [xml]$Content
        return $true
    } catch {
        return $false
    }
}
