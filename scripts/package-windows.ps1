[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory,
    [string]$NodeRoot,
    [string]$CodexHostPayload,
    [switch]$KeepStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RequiredDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label does not exist or is not a directory: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Copy-RequiredFile {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required package input is missing: $Source"
    }
    $parent = Split-Path -Parent $Destination
    if ($parent) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Required package directory is missing: $Source"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
    }
}

function Assert-ExternalCommandSucceeded {
    param([Parameter(Mandatory)][int]$ExitCode, [Parameter(Mandatory)][string]$Operation)

    if ($ExitCode -ne 0) {
        throw "$Operation failed with exit code $ExitCode"
    }
}

$resolvedRepoRoot = Resolve-RequiredDirectory -Path $RepoRoot -Label 'Repository root'
$packagePath = Join-Path $resolvedRepoRoot 'package.json'
$toolchainLockPath = Join-Path $resolvedRepoRoot 'locks\toolchains.lock.json'

$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$toolchainLock = Get-Content -LiteralPath $toolchainLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $package.version -or $package.version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
    throw 'package.json contains an invalid release version'
}
if (-not $toolchainLock.node) {
    throw 'locks/toolchains.lock.json does not define node'
}

$releaseName = "everyone-codex-$($package.version)-windows-x64"
$packageBuildRoot = [IO.Path]::GetFullPath((Join-Path $resolvedRepoRoot '.build\package'))
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $packageBuildRoot $releaseName))
$expectedPrefix = $packageBuildRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $stagingRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a staging directory outside $packageBuildRoot"
}

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $resolvedRepoRoot 'artifacts'
}
$resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $packageBuildRoot -Force | Out-Null
if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

$cleanupStaging = -not $KeepStaging
try {
    foreach ($fileName in @('README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json')) {
        Copy-RequiredFile `
            -Source (Join-Path $resolvedRepoRoot $fileName) `
            -Destination (Join-Path $stagingRoot $fileName)
    }
    Copy-DirectoryContents `
        -Source (Join-Path $resolvedRepoRoot 'src') `
        -Destination (Join-Path $stagingRoot 'src')
    Copy-DirectoryContents `
        -Source (Join-Path $resolvedRepoRoot 'locks') `
        -Destination (Join-Path $stagingRoot 'locks')
    Copy-DirectoryContents `
        -Source (Join-Path $resolvedRepoRoot 'config') `
        -Destination (Join-Path $stagingRoot 'config')

    if (-not $NodeRoot) {
        if ($env:EVERYONE_CODEX_NODE_ROOT) {
            $NodeRoot = $env:EVERYONE_CODEX_NODE_ROOT
        } else {
            $NodeRoot = Join-Path $resolvedRepoRoot ".toolchains\node\$($toolchainLock.node)"
        }
    }
    $resolvedNodeRoot = Resolve-RequiredDirectory -Path $NodeRoot -Label 'Pinned Node root'
    $nodeExecutable = Join-Path $resolvedNodeRoot 'node.exe'
    $nodeLicense = Join-Path $resolvedNodeRoot 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
        throw "Pinned Node executable is missing: $nodeExecutable"
    }
    if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) {
        throw "Pinned Node license is missing: $nodeLicense"
    }

    $actualNodeVersion = & $nodeExecutable -p 'process.versions.node'
    $nodeVersionExitCode = $LASTEXITCODE
    Assert-ExternalCommandSucceeded -ExitCode $nodeVersionExitCode -Operation 'Pinned Node version check'
    if ($actualNodeVersion.Trim() -ne [string]$toolchainLock.node) {
        throw "Pinned Node version mismatch: expected $($toolchainLock.node), got $($actualNodeVersion.Trim())"
    }

    $nodeDestination = Join-Path $stagingRoot 'runtime\node'
    New-Item -ItemType Directory -Path $nodeDestination -Force | Out-Null
    Copy-RequiredFile -Source $nodeExecutable -Destination (Join-Path $nodeDestination 'node.exe')
    Copy-RequiredFile -Source $nodeLicense -Destination (Join-Path $nodeDestination 'LICENSE')

    if (-not $CodexHostPayload) {
        $defaultPayload = Join-Path $resolvedRepoRoot '.build\codexhost\payload'
        if (Test-Path -LiteralPath $defaultPayload -PathType Container) {
            $CodexHostPayload = $defaultPayload
        }
    }
    $hasCodexHostPayload = $false
    if ($CodexHostPayload) {
        $resolvedCodexHostPayload = Resolve-RequiredDirectory -Path $CodexHostPayload -Label 'CodexHost payload'
        Copy-DirectoryContents `
            -Source $resolvedCodexHostPayload `
            -Destination (Join-Path $stagingRoot 'runtime\codexhost')
        $hasCodexHostPayload = $true
    }

    $binRoot = Join-Path $stagingRoot 'bin'
    New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
    $launcher = @'
@echo off
setlocal
set "EVERYONE_CODEX_ROOT=%~dp0.."
"%EVERYONE_CODEX_ROOT%\runtime\node\node.exe" "%EVERYONE_CODEX_ROOT%\src\cli.mjs" %*
exit /b %ERRORLEVEL%
'@
    Set-Content -LiteralPath (Join-Path $binRoot 'everyone-codex.cmd') -Value $launcher -Encoding ascii -NoNewline

    $manifest = [ordered]@{
        schemaVersion = 1
        product = 'Everyone in Codex'
        version = [string]$package.version
        platform = 'windows'
        arch = 'x64'
        bundledNode = [string]$toolchainLock.node
        codexHostPayload = $hasCodexHostPayload
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content `
        -LiteralPath (Join-Path $stagingRoot 'release-manifest.json') `
        -Encoding utf8

    # Smoke 只做语法检查，不触发 Gateway、Router、WebGPT 或任何 Harness。
    & (Join-Path $nodeDestination 'node.exe') --check (Join-Path $stagingRoot 'src\cli.mjs') | Out-Null
    $portableSmokeExitCode = $LASTEXITCODE
    Assert-ExternalCommandSucceeded -ExitCode $portableSmokeExitCode -Operation 'Portable CLI syntax smoke'

    $auditScript = Join-Path $PSScriptRoot 'release-audit.mjs'
    if (-not (Test-Path -LiteralPath $auditScript -PathType Leaf)) {
        throw "Release audit script is missing: $auditScript"
    }
    $auditReport = & (Join-Path $nodeDestination 'node.exe') $auditScript --root $stagingRoot --kind portable
    $auditExitCode = $LASTEXITCODE
    Assert-ExternalCommandSucceeded -ExitCode $auditExitCode -Operation 'Portable release audit'
    if (-not $auditReport) {
        throw 'Portable release audit returned no report'
    }

    $zipName = "$releaseName.zip"
    $zipPath = Join-Path $resolvedOutputDirectory $zipName
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Compress-Archive -LiteralPath $stagingRoot -DestinationPath $zipPath -CompressionLevel Optimal

    # 源码包只来自已提交 Git tree；这既排除本机配置，也保证 patch/lock 可重放。
    & git -C $resolvedRepoRoot diff --quiet --
    Assert-ExternalCommandSucceeded -ExitCode $LASTEXITCODE -Operation 'Source tree cleanliness check'
    & git -C $resolvedRepoRoot diff --cached --quiet --
    Assert-ExternalCommandSucceeded -ExitCode $LASTEXITCODE -Operation 'Source index cleanliness check'
    $sourceName = "everyone-codex-$($package.version)-source"
    $sourceZipName = "$sourceName.zip"
    $sourceZipPath = Join-Path $resolvedOutputDirectory $sourceZipName
    if (Test-Path -LiteralPath $sourceZipPath) {
        Remove-Item -LiteralPath $sourceZipPath -Force
    }
    & git -C $resolvedRepoRoot archive `
        --format=zip `
        "--prefix=$sourceName/" `
        "--output=$sourceZipPath" `
        HEAD
    Assert-ExternalCommandSucceeded -ExitCode $LASTEXITCODE -Operation 'Source archive build'

    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceHash = (Get-FileHash -LiteralPath $sourceZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumPath = Join-Path $resolvedOutputDirectory 'SHA256SUMS.txt'
    Set-Content -LiteralPath $checksumPath `
        -Value "$hash  $zipName`n$sourceHash  $sourceZipName`n" `
        -Encoding utf8 `
        -NoNewline

    [ordered]@{
        ok = $true
        artifact = $zipPath
        sourceArtifact = $sourceZipPath
        checksums = $checksumPath
        version = [string]$package.version
    } | ConvertTo-Json -Compress | Write-Output
} finally {
    if ($cleanupStaging -and (Test-Path -LiteralPath $stagingRoot)) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
