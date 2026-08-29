[CmdletBinding()]
param(
    [switch]$SkipRust
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lock = Get-Content -LiteralPath (Join-Path $repositoryRoot 'locks\toolchains.lock.json') -Raw -Encoding utf8 |
    ConvertFrom-Json
$toolchainRoot = Join-Path $repositoryRoot '.toolchains'
$downloadRoot = Join-Path $toolchainRoot 'downloads'
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

function Remove-OwnedPartialDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $allowedRoot = [System.IO.Path]::GetFullPath($toolchainRoot) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($fullPath)).Contains('.partial-')) {
        throw "Refusing to remove an unowned toolchain path: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$ChecksumUri,
        [Parameter(Mandatory)][string]$Destination
    )

    $checksumPath = "$Destination.sha256"
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        Invoke-WebRequest -Uri $Uri -OutFile $Destination
    }
    if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
        Invoke-WebRequest -Uri $ChecksumUri -OutFile $checksumPath
    }
    $expected = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "Downloaded artifact digest mismatch: $Destination"
    }
    return $actual
}

$nodeVersion = [string]$lock.node
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchive = Join-Path $downloadRoot $nodeArchiveName
$nodeSums = Join-Path $downloadRoot "node-v$nodeVersion-SHASUMS256.txt"
if (-not (Test-Path -LiteralPath $nodeArchive -PathType Leaf)) {
    Invoke-WebRequest -Uri ([string]$lock.artifacts.nodeWindowsX64.url) -OutFile $nodeArchive
}
if (-not (Test-Path -LiteralPath $nodeSums -PathType Leaf)) {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $nodeSums
}
$nodeExpectedLine = Get-Content -LiteralPath $nodeSums | Where-Object { $_ -match "  $([regex]::Escape($nodeArchiveName))$" }
if (-not $nodeExpectedLine) {
    throw "Node checksum manifest does not contain $nodeArchiveName"
}
$nodeExpected = ($nodeExpectedLine -split '\s+')[0].ToLowerInvariant()
$nodeActual = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeActual -ne $nodeExpected) {
    throw 'Node archive digest mismatch'
}
if ($nodeActual -ne ([string]$lock.artifacts.nodeWindowsX64.sha256).ToLowerInvariant()) {
    throw 'Node archive does not match locks/toolchains.lock.json'
}

$nodeTarget = Join-Path $toolchainRoot "node\$nodeVersion"
if (-not (Test-Path -LiteralPath (Join-Path $nodeTarget 'node.exe') -PathType Leaf)) {
    $partial = "$nodeTarget.partial-$([guid]::NewGuid().ToString('N'))"
    try {
        New-Item -ItemType Directory -Path $partial -Force | Out-Null
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $partial -Force
        $extracted = Join-Path $partial "node-v$nodeVersion-win-x64"
        if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe') -PathType Leaf)) {
            throw 'Node extraction is incomplete'
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $nodeTarget) -Force | Out-Null
        Move-Item -LiteralPath $extracted -Destination $nodeTarget
    }
    finally {
        Remove-OwnedPartialDirectory -Path $partial
    }
}
$installedNode = & (Join-Path $nodeTarget 'node.exe') -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $installedNode.Trim() -ne $nodeVersion) {
    throw "Unexpected repo-local Node version: $installedNode"
}

$rustReady = $false
if (-not $SkipRust) {
    $rustupVersion = '1.29.0'
    $rustupName = 'rustup-init.exe'
    # rustup 通过 argv[0] 区分 installer 与 cargo/rustc proxy；文件名不能加版本前缀。
    $rustupDownloadRoot = Join-Path $downloadRoot "rustup-$rustupVersion"
    New-Item -ItemType Directory -Path $rustupDownloadRoot -Force | Out-Null
    $rustupArchive = Join-Path $rustupDownloadRoot $rustupName
    $rustupUrl = [string]$lock.artifacts.rustupWindowsX64.url
    $rustupActual = Get-VerifiedDownload `
        -Uri $rustupUrl `
        -ChecksumUri "$rustupUrl.sha256" `
        -Destination $rustupArchive
    if ($rustupActual -ne ([string]$lock.artifacts.rustupWindowsX64.sha256).ToLowerInvariant()) {
        throw 'rustup-init does not match locks/toolchains.lock.json'
    }

    $rustRoot = Join-Path $toolchainRoot 'rust'
    $env:RUSTUP_HOME = Join-Path $rustRoot 'rustup'
    $env:CARGO_HOME = Join-Path $rustRoot 'cargo'
    New-Item -ItemType Directory -Path $env:RUSTUP_HOME,$env:CARGO_HOME -Force | Out-Null
    & $rustupArchive -y --no-modify-path --profile minimal --default-toolchain ([string]$lock.rust)
    if ($LASTEXITCODE -ne 0) {
        throw "rustup-init failed with exit code $LASTEXITCODE"
    }
    $cargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
    $rustc = Join-Path $env:CARGO_HOME 'bin\rustc.exe'
    $rustVersion = & $rustc --version
    if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch "rustc $([regex]::Escape([string]$lock.rust))") {
        throw "Unexpected repo-local Rust version: $rustVersion"
    }
    if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) {
        throw 'Repo-local Cargo executable is missing'
    }
    $rustReady = $true
}

[ordered]@{
    ok = $true
    node = [ordered]@{ version = $nodeVersion; sha256 = $nodeActual; path = $nodeTarget }
    rust = [ordered]@{ version = [string]$lock.rust; ready = $rustReady }
} | ConvertTo-Json -Depth 4 -Compress | Write-Output
