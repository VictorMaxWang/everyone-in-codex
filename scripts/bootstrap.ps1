[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$NodeRoot,
    [switch]$InitializeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExternalCommandSucceeded {
    param([Parameter(Mandatory)][int]$ExitCode, [Parameter(Mandatory)][string]$Operation)

    if ($ExitCode -ne 0) {
        throw "$Operation failed with exit code $ExitCode"
    }
}

function Get-NodeVersion {
    param([Parameter(Mandatory)][string]$NodeExecutable)

    $version = & $NodeExecutable -p 'process.versions.node'
    $exitCode = $LASTEXITCODE
    Assert-ExternalCommandSucceeded -ExitCode $exitCode -Operation 'Node version check'
    return $version.Trim()
}

if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    throw "Repository root does not exist: $RepoRoot"
}
$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$lockPath = Join-Path $resolvedRepoRoot 'locks\toolchains.lock.json'
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "Toolchain lock is missing: $lockPath"
}
$toolchains = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($required in @('node', 'npm', 'rust', 'bun')) {
    if (-not $toolchains.PSObject.Properties.Name.Contains($required) -or -not $toolchains.$required) {
        throw "Toolchain lock does not define $required"
    }
}

$toolchainRoot = Join-Path $resolvedRepoRoot '.toolchains'
foreach ($tool in @('node', 'npm', 'rust', 'bun')) {
    New-Item -ItemType Directory -Path (Join-Path $toolchainRoot $tool) -Force | Out-Null
}

$nodeTarget = Join-Path $toolchainRoot "node\$($toolchains.node)"
$nodeReady = $false
if (Test-Path -LiteralPath (Join-Path $nodeTarget 'node.exe') -PathType Leaf) {
    $existingVersion = Get-NodeVersion -NodeExecutable (Join-Path $nodeTarget 'node.exe')
    if ($existingVersion -ne [string]$toolchains.node) {
        throw "Repo-local Node version mismatch: expected $($toolchains.node), got $existingVersion"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $nodeTarget 'LICENSE') -PathType Leaf)) {
        throw "Repo-local Node license is missing: $nodeTarget\LICENSE"
    }
    $nodeReady = $true
} elseif ($NodeRoot -and -not $InitializeOnly) {
    if (-not (Test-Path -LiteralPath $NodeRoot -PathType Container)) {
        throw "Node source root does not exist: $NodeRoot"
    }
    $resolvedNodeRoot = (Resolve-Path -LiteralPath $NodeRoot).Path
    $sourceNode = Join-Path $resolvedNodeRoot 'node.exe'
    $sourceLicense = Join-Path $resolvedNodeRoot 'LICENSE'
    if (-not (Test-Path -LiteralPath $sourceNode -PathType Leaf)) {
        throw "Node source executable is missing: $sourceNode"
    }
    if (-not (Test-Path -LiteralPath $sourceLicense -PathType Leaf)) {
        throw "Node source license is missing: $sourceLicense"
    }
    $sourceVersion = Get-NodeVersion -NodeExecutable $sourceNode
    if ($sourceVersion -ne [string]$toolchains.node) {
        throw "Node source version mismatch: expected $($toolchains.node), got $sourceVersion"
    }

    # 先复制到同一父目录下的临时目录，再原子切换，避免中断后留下半套 runtime。
    $partialTarget = "$nodeTarget.partial-$([Guid]::NewGuid().ToString('N'))"
    try {
        New-Item -ItemType Directory -Path $partialTarget -Force | Out-Null
        Copy-Item -LiteralPath $sourceNode -Destination (Join-Path $partialTarget 'node.exe') -Force
        Copy-Item -LiteralPath $sourceLicense -Destination (Join-Path $partialTarget 'LICENSE') -Force
        $copiedVersion = Get-NodeVersion -NodeExecutable (Join-Path $partialTarget 'node.exe')
        if ($copiedVersion -ne [string]$toolchains.node) {
            throw "Copied Node version mismatch: expected $($toolchains.node), got $copiedVersion"
        }
        Move-Item -LiteralPath $partialTarget -Destination $nodeTarget
        $nodeReady = $true
    } finally {
        if (Test-Path -LiteralPath $partialTarget) {
            Remove-Item -LiteralPath $partialTarget -Recurse -Force
        }
    }
}

[ordered]@{
    ok = $true
    root = '.toolchains'
    node = [ordered]@{
        version = [string]$toolchains.node
        ready = $nodeReady
    }
    npm = [ordered]@{ version = [string]$toolchains.npm; ready = $false }
    rust = [ordered]@{ version = [string]$toolchains.rust; ready = $false }
    bun = [ordered]@{ version = [string]$toolchains.bun; ready = $false }
} | ConvertTo-Json -Depth 4 -Compress | Write-Output
