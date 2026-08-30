[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ProductRoot = (Join-Path $env:LOCALAPPDATA 'EveryoneCodex\product'),
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$ValidationPolicyPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedPackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$node = Join-Path $resolvedPackageRoot 'runtime\node\node.exe'
$installer = Join-Path $resolvedPackageRoot 'src\product-bootstrap-installer.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw 'Published Everyone in Codex bootstrap runtime is incomplete'
}

& $node $installer `
    --package-root $resolvedPackageRoot `
    --product-root ([IO.Path]::GetFullPath($ProductRoot)) `
    --config ([IO.Path]::GetFullPath($ConfigPath)) `
    --validation-policy ([IO.Path]::GetFullPath($ValidationPolicyPath))
if ($LASTEXITCODE -ne 0) {
    throw "Everyone in Codex product installation failed with exit code $LASTEXITCODE"
}
