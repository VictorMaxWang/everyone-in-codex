[CmdletBinding()]
param(
    [string]$VsInstallPath = $env:EVERYONE_CODEX_VS_INSTALL_PATH
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $repositoryRoot '.build\upstreams\codexhost'
$nodeRoot = Join-Path $repositoryRoot '.toolchains\node\22.22.0'
$cargoHome = Join-Path $repositoryRoot '.toolchains\rust\cargo'
$rustupHome = Join-Path $repositoryRoot '.toolchains\rust\rustup'

foreach ($required in @(
    (Join-Path $sourceRoot 'package.json'),
    (Join-Path $nodeRoot 'node.exe'),
    (Join-Path $nodeRoot 'corepack.cmd'),
    (Join-Path $cargoHome 'bin\cargo.exe')
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required CodexHost build input is missing: $required"
    }
}

if (-not $VsInstallPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $VsInstallPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    }
}
if (-not $VsInstallPath -or -not (Test-Path -LiteralPath $VsInstallPath -PathType Container)) {
    throw 'MSVC Build Tools were not found; pass -VsInstallPath or set EVERYONE_CODEX_VS_INSTALL_PATH'
}
$devShellModule = Join-Path $VsInstallPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
if (-not (Test-Path -LiteralPath $devShellModule -PathType Leaf)) {
    throw "Visual Studio Developer PowerShell module is missing: $devShellModule"
}
Import-Module $devShellModule
Enter-VsDevShell -VsInstallPath $VsInstallPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'

$env:RUSTUP_HOME = $rustupHome
$env:CARGO_HOME = $cargoHome
$env:PATH = $nodeRoot + ';' + (Join-Path $cargoHome 'bin') + ';' + $env:PATH
# CARGO_ENCODED_RUSTFLAGS用单参数传递，避免带空格的仓库路径被拆开。
$env:CARGO_ENCODED_RUSTFLAGS = "--remap-path-prefix=$repositoryRoot=."

& (Join-Path $nodeRoot 'corepack.cmd') npm@11.8.0 ci --prefix $sourceRoot
if ($LASTEXITCODE -ne 0) {
    throw "CodexHost npm ci failed with exit code $LASTEXITCODE"
}
& (Join-Path $nodeRoot 'corepack.cmd') npm@11.8.0 --prefix $repositoryRoot `
    run prepare:codexhost-payload -- --root $sourceRoot
if ($LASTEXITCODE -ne 0) {
    throw "CodexHost payload build failed with exit code $LASTEXITCODE"
}
