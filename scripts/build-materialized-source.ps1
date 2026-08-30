[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory,
    [switch]$KeepStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-archive.ps1')

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$WorkingDirectory)
    $output = & git -C $WorkingDirectory @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git failed: $($Arguments -join ' ')" }
    return ($output | Out-String).Trim()
}

function Export-Index {
    param([Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][string]$Destination)
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $prefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    Invoke-Git -WorkingDirectory $Repository -Arguments @(
        'checkout-index', '--all', '--force', "--prefix=$prefix"
    ) | Out-Null
}

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$package = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$upstream = Get-Content -LiteralPath (Join-Path $repo 'locks\upstream.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
$router = Get-Content -LiteralPath (Join-Path $repo 'locks\router-v030.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
$sourceCommit = Invoke-Git -WorkingDirectory $repo -Arguments @('rev-parse', 'HEAD')
if ((Invoke-Git -WorkingDirectory $repo -Arguments @('status', '--porcelain')).Length -ne 0) {
    throw 'Materialized source requires a clean Git tree'
}

if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$name = "everyone-codex-$($package.version)-materialized-source"
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repo '.build\materialized-source'))
$staging = Join-Path $buildRoot $name
$allowed = $buildRoot.TrimEnd('\') + '\'
if (-not $staging.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Materialized source staging escaped .build/materialized-source'
}
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$cleanup = -not $KeepStaging
try {
    $upstreamRoot = Join-Path $repo ".build\materialized-upstreams-$($package.version)"
    & (Join-Path $PSScriptRoot 'materialize-upstreams.ps1') -Component all -OutputRoot $upstreamRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Upstream materialization failed' }

    Export-Index -Repository $repo -Destination (Join-Path $staging 'product')
    $localAgents = Join-Path $staging 'product\AGENTS.md'
    if (Test-Path -LiteralPath $localAgents -PathType Leaf) {
        Remove-Item -LiteralPath $localAgents -Force
    }
    foreach ($component in @('codexhost', 'router', 'webgpt')) {
        Export-Index `
            -Repository (Join-Path $upstreamRoot $component) `
            -Destination (Join-Path $staging "upstreams\$component")
    }
    $sourceManifest = [ordered]@{
        schemaVersion = 1
        product = 'everyone-in-codex'
        version = [string]$package.version
        sourceCommit = $sourceCommit
        upstreams = [ordered]@{
            codexhost = [ordered]@{
                commit = [string]$upstream.codexhost.commit
                tree = [string]$upstream.codexhost.patchedTree
                patches = @($upstream.codexhost.patchSeries.file)
            }
            router = [ordered]@{
                commit = [string]$router.upstreamCommit
                tree = [string]$router.patchedTree
                patches = @($router.patchSeries.file)
            }
            webgpt = [ordered]@{
                commit = [string]$upstream.webgpt.integrationCommit
                tree = [string]$upstream.webgpt.integrationTree
                patches = @($upstream.webgpt.patchSeries.file)
            }
        }
    }
    [IO.File]::WriteAllText(
        (Join-Path $staging 'SOURCE-MANIFEST.json'),
        (($sourceManifest | ConvertTo-Json -Depth 10) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )

    $node = Join-Path $repo ".toolchains\node\$((Get-Content -LiteralPath (Join-Path $repo 'locks\toolchains.lock.json') -Raw | ConvertFrom-Json).node)\node.exe"
    $audit = & $node (Join-Path $PSScriptRoot 'release-audit.mjs') --root $staging --kind materialized
    if ($LASTEXITCODE -ne 0 -or -not $audit) { throw 'Materialized source audit failed' }

    $zip = Join-Path $output "$name.zip"
    New-DeterministicZip -SourceRoot $staging -RootName $name -Destination $zip
    [ordered]@{
        ok = $true
        artifact = $zip
        version = [string]$package.version
        sourceCommit = $sourceCommit
    } | ConvertTo-Json -Compress
}
finally {
    if ($cleanup -and (Test-Path -LiteralPath $staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
