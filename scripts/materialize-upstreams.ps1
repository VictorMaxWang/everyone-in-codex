[CmdletBinding()]
param(
    [ValidateSet('all', 'codexhost', 'router', 'webgpt')]
    [string]$Component = 'all',
    [string]$OutputRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lockPath = Join-Path $repositoryRoot 'locks\upstream.lock.json'
$routerLockPath = Join-Path $repositoryRoot 'locks\router-v030.lock.json'
$buildRoot = if ($OutputRoot) {
    [System.IO.Path]::GetFullPath($OutputRoot)
} else {
    Join-Path $repositoryRoot '.build\upstreams'
}
$allowedBuildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot '.build')) +
    [System.IO.Path]::DirectorySeparatorChar
if (-not ([System.IO.Path]::GetFullPath($buildRoot) + [System.IO.Path]::DirectorySeparatorChar).StartsWith(
    $allowedBuildRoot,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'Materialized upstream output must stay under the repository .build directory'
}
$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json -Depth 100
$routerLock = Get-Content -LiteralPath $routerLockPath -Raw -Encoding utf8 | ConvertFrom-Json -Depth 100

function Invoke-Git {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $output = if ($WorkingDirectory) {
        & git -C $WorkingDirectory @Arguments 2>&1
    }
    else {
        & git @Arguments 2>&1
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $detail = ($output | Out-String).Trim()
        throw "git failed with exit code ${exitCode}: $detail"
    }
    return ($output | Out-String).Trim()
}

function Assert-PatchSeries {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [object[]]$Series
    )

    $patchRoot = Join-Path $repositoryRoot "patches\$Name"
    $paths = @(
        foreach ($entry in $Series) {
            $file = [string]$entry.file
            if ([System.IO.Path]::GetFileName($file) -ne $file -or -not $file.EndsWith('.patch')) {
                throw "Invalid patch filename in ${Name}: $file"
            }
            $path = Join-Path $patchRoot $file
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                throw "Missing ${Name} patch: $file"
            }
            $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            $expected = ([string]$entry.sha256).ToLowerInvariant()
            if ($actual -ne $expected) {
                throw "Patch digest mismatch for ${Name}/$file"
            }
            [System.IO.Path]::GetFullPath($path)
        }
    )
    if ($paths.Count -eq 0) {
        throw "Patch series is empty for $Name"
    }
    return @($paths)
}

function Remove-PartialCheckout {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $allowedRoot = [System.IO.Path]::GetFullPath($buildRoot) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($fullPath)).Contains('.partial-')) {
        throw "Refusing to remove an unowned materialization path: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

function Test-ReusableCheckout {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$BaseCommit,
        [Parameter(Mandatory)][string]$ExpectedTree
    )

    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Container)) {
        return $false
    }
    $head = Invoke-Git -WorkingDirectory $Path -Arguments @('rev-parse', 'HEAD')
    if (-not $head.StartsWith($BaseCommit, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    $tree = Invoke-Git -WorkingDirectory $Path -Arguments @('write-tree')
    if ($tree -ne $ExpectedTree) {
        return $false
    }
    & git -C $Path diff --quiet
    if ($LASTEXITCODE -ne 0) {
        return $false
    }
    $untracked = Invoke-Git -WorkingDirectory $Path -Arguments @(
        'ls-files', '--others', '--exclude-standard'
    )
    return [string]::IsNullOrWhiteSpace($untracked)
}

function Materialize-Component {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][string]$BaseCommit,
        [Parameter(Mandatory)][string]$BaseTree,
        [Parameter(Mandatory)][string]$ExpectedTree,
        [Parameter(Mandatory)][object[]]$PatchSeries
    )

    $patchPaths = @(Assert-PatchSeries -Name $Name -Series $PatchSeries)
    $destination = Join-Path $buildRoot $Name
    if (Test-Path -LiteralPath $destination) {
        if (Test-ReusableCheckout -Path $destination -BaseCommit $BaseCommit -ExpectedTree $ExpectedTree) {
            return [pscustomobject]@{
                component = $Name
                path = $destination
                tree = $ExpectedTree
                reused = $true
            }
        }
        throw "Materialized checkout already exists but does not match the lock: $destination"
    }

    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
    $staging = "$destination.partial-$PID-$([guid]::NewGuid().ToString('N'))"
    try {
        Invoke-Git -Arguments @(
            'clone', '-c', 'core.longpaths=true', '--no-tags', '--no-checkout',
            $Repository, $staging
        ) | Out-Null
        Invoke-Git -WorkingDirectory $staging -Arguments @('checkout', '--detach', $BaseCommit) | Out-Null

        $head = Invoke-Git -WorkingDirectory $staging -Arguments @('rev-parse', 'HEAD')
        if (-not $head.StartsWith($BaseCommit, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "${Name} checkout resolved to an unexpected commit"
        }
        $actualBaseTree = Invoke-Git -WorkingDirectory $staging -Arguments @('rev-parse', 'HEAD^{tree}')
        if ($actualBaseTree -ne $BaseTree) {
            throw "${Name} base tree does not match locks/upstream.lock.json"
        }

        # format-patch 中每片都基于前一提交，必须按序 check/apply。整个过程只发生在
        # partial checkout；任何一片失败都会删除 staging，绝不会发布半成品目录。
        foreach ($patchPath in $patchPaths) {
            Invoke-Git -WorkingDirectory $staging -Arguments @(
                'apply', '--check', '--index', '--whitespace=error-all', '--', $patchPath
            ) | Out-Null
            Invoke-Git -WorkingDirectory $staging -Arguments @(
                'apply', '--index', '--whitespace=error-all', '--', $patchPath
            ) | Out-Null
        }

        $actualTree = Invoke-Git -WorkingDirectory $staging -Arguments @('write-tree')
        if ($actualTree -ne $ExpectedTree) {
            throw "${Name} patched tree mismatch: expected $ExpectedTree, got $actualTree"
        }
        Move-Item -LiteralPath $staging -Destination $destination
    }
    catch {
        Remove-PartialCheckout -Path $staging
        throw
    }

    return [pscustomobject]@{
        component = $Name
        path = $destination
        tree = $ExpectedTree
        reused = $false
    }
}

$results = @()
if ($Component -in @('all', 'codexhost')) {
    $results += Materialize-Component `
        -Name 'codexhost' `
        -Repository ([string]$lock.codexhost.repository) `
        -BaseCommit ([string]$lock.codexhost.commit) `
        -BaseTree ([string]$lock.codexhost.baseTree) `
        -ExpectedTree ([string]$lock.codexhost.patchedTree) `
        -PatchSeries @($lock.codexhost.patchSeries)
}
if ($Component -in @('all', 'webgpt')) {
    $results += Materialize-Component `
        -Name 'webgpt' `
        -Repository ([string]$lock.webgpt.repository) `
        -BaseCommit ([string]$lock.webgpt.baseCommit) `
        -BaseTree ([string]$lock.webgpt.baseTree) `
        -ExpectedTree ([string]$lock.webgpt.integrationTree) `
        -PatchSeries @($lock.webgpt.patchSeries)
}
if ($Component -in @('all', 'router')) {
    if ($routerLock.schemaVersion -ne 2) {
        throw 'Router materialization requires locks/router-v030.lock.json schemaVersion 2'
    }
    $results += Materialize-Component `
        -Name 'router' `
        -Repository ([string]$routerLock.repository) `
        -BaseCommit ([string]$routerLock.upstreamCommit) `
        -BaseTree ([string]$routerLock.baselineTree) `
        -ExpectedTree ([string]$routerLock.patchedTree) `
        -PatchSeries @($routerLock.patchSeries)
}

$results | ConvertTo-Json -Depth 5
