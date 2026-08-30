[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-JsonAtomic {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)

    $temporary = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Resolve-VersionRoot {
    param([Parameter(Mandatory)]$Record, [Parameter(Mandatory)][string]$VersionsRoot)

    if (-not $Record.directory -or $Record.directory -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
        throw 'Active product version directory is invalid'
    }
    $candidate = [IO.Path]::GetFullPath((Join-Path $VersionsRoot ([string]$Record.directory)))
    $prefix = [IO.Path]::GetFullPath($VersionsRoot).TrimEnd('\') + '\'
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Active product version escaped the versions root'
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw 'Active product version is missing'
    }
    return $candidate
}

function Set-ProductUpdateStatus {
    param([Parameter(Mandatory)][string]$Phase, [AllowNull()][string]$ErrorMessage)

    $statusPath = Join-Path $productRoot 'updates\status-v1.json'
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return }
    try {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $status.phase = $Phase
        $status.updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $status.error = $ErrorMessage
        Write-JsonAtomic -Path $statusPath -Value $status
    }
    catch {
        # Status reporting is non-authoritative; active-version.json remains the source of truth.
    }
}

$productRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$pointerPath = Join-Path $productRoot 'active-version.json'
$versionsRoot = Join-Path $productRoot 'versions'
$configPath = Join-Path $productRoot 'fusion.local.json'
if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
    throw 'Everyone in Codex active-version.json is missing'
}

$pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pointer.schemaVersion -ne 1 -or -not $pointer.active) {
    throw 'Everyone in Codex active-version.json is invalid'
}
$versionRoot = Resolve-VersionRoot -Record $pointer.active -VersionsRoot $versionsRoot
$node = Join-Path $versionRoot 'runtime\node\node.exe'
$cli = Join-Path $versionRoot 'src\cli.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'Everyone in Codex active runtime is incomplete'
}

$env:EVERYONE_CODEX_ROOT = $versionRoot
$env:EVERYONE_CODEX_CONFIG = $configPath
& $node $cli @CommandArgs
$exitCode = $LASTEXITCODE

if ([string]$pointer.state -eq 'pending-first-launch') {
    if ($exitCode -eq 0) {
        $pointer.state = 'active'
        Write-JsonAtomic -Path $pointerPath -Value $pointer
        Set-ProductUpdateStatus -Phase 'succeeded' -ErrorMessage $null
    } elseif ($pointer.previous) {
        # The new CLI/Host failed its readiness gate. Swap only the pointer and retain both trees.
        $failed = $pointer.active
        $pointer.active = $pointer.previous
        $pointer.previous = $null
        $pointer.state = 'active'
        $pointer.failed = [ordered]@{
            version = $failed.version
            directory = $failed.directory
            digest = $failed.digest
            sourceCommit = $failed.sourceCommit
            reason = 'startup_failed'
        }
        Write-JsonAtomic -Path $pointerPath -Value $pointer
        Set-ProductUpdateStatus -Phase 'failed' -ErrorMessage 'startup_failed_rolled_back'
        $fallbackRoot = Resolve-VersionRoot -Record $pointer.active -VersionsRoot $versionsRoot
        $fallbackNode = Join-Path $fallbackRoot 'runtime\node\node.exe'
        $fallbackCli = Join-Path $fallbackRoot 'src\cli.mjs'
        $env:EVERYONE_CODEX_ROOT = $fallbackRoot
        & $fallbackNode $fallbackCli @CommandArgs
        $exitCode = $LASTEXITCODE
    }
}

exit $exitCode
