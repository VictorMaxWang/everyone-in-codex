[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PlanBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PlanBase64))
$plan = $json | ConvertFrom-Json -Depth 20
if (-not $plan.command -or ([string]$plan.command) -match '[\r\n]') {
    throw 'Interactive login command is invalid.'
}
$arguments = @($plan.args)
if ($arguments.Count -gt 32 -or @($arguments | Where-Object { ([string]$_) -match '[\r\n]' }).Count) {
    throw 'Interactive login arguments are invalid.'
}
$argumentLine = @(
    foreach ($argument in $arguments) {
        $value = [string]$argument
        if ($value -match '[\s"]') {
            '"' + $value.Replace('"', '\"') + '"'
        } else {
            $value
        }
    }
) -join ' '
$start = @{
    FilePath = [string]$plan.command
    ArgumentList = $argumentLine
    Wait = $true
}
if ($plan.cwd) {
    $start.WorkingDirectory = [string]$plan.cwd
}
if ($plan.environment) {
    $environment = @{}
    foreach ($property in $plan.environment.PSObject.Properties) {
        $environment[[string]$property.Name] = [string]$property.Value
    }
    $start.Environment = $environment
}

# 该子进程就是用户需要交互的官方登录入口，因此必须保留可见窗口。
$process = Start-Process @start -PassThru
exit $process.ExitCode
