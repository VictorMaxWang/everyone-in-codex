Set-StrictMode -Version Latest

function New-Sha256FileManifest {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$Destination,
        [string[]]$Exclude = @()
    )

    $root = [IO.Path]::GetFullPath($SourceRoot)
    $excluded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $Exclude) { [void]$excluded.Add($item.Replace('\', '/')) }
    $lines = @(
        foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force | Sort-Object FullName)) {
            if ($file.LinkType) { throw "Manifest input contains a link: $($file.FullName)" }
            $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
            if ($excluded.Contains($relative)) { continue }
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $relative"
        }
    )
    [IO.File]::WriteAllText(
        $Destination,
        (($lines -join "`n") + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
}

function New-DeterministicZip {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$RootName,
        [Parameter(Mandatory)][string]$Destination
    )

    Add-Type -AssemblyName System.IO.Compression
    $root = [IO.Path]::GetFullPath($SourceRoot)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "ZIP source root is missing: $root"
    }
    if ($RootName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$') {
        throw 'ZIP root name is invalid'
    }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force | Sort-Object FullName)) {
            if ($file.LinkType) { throw "ZIP input contains a link: $($file.FullName)" }
            $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
            $entry = $archive.CreateEntry(
                "$RootName/$relative",
                [IO.Compression.CompressionLevel]::Optimal
            )
            $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $input = [IO.File]::OpenRead($file.FullName)
            $output = $entry.Open()
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
        }
    }
    finally {
        $archive.Dispose()
        $stream.Dispose()
    }
}
