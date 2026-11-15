# scripts/msvc-env.ps1
# Dot-source this, then call Enter-MsvcEnvironment before any cargo build.
# Cargo's MSVC target needs link.exe from Visual Studio. A plain PowerShell has no such PATH, and on some machines
# vswhere lists no instance even though Build Tools are installed, so fall back to searching the standard folders.
# Order: $env:ADITOR_VCVARS, then vswhere, then the standard folders, highest MSVC toolset first.

function Find-Vcvars64 {
    [OutputType([string[]])]
    param([string[]]$SearchRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}))

    if ($env:ADITOR_VCVARS) {
        if (-not (Test-Path -LiteralPath $env:ADITOR_VCVARS)) { throw "ADITOR_VCVARS points to a missing file: $env:ADITOR_VCVARS" }
        return @($env:ADITOR_VCVARS)
    }

    $found = New-Object System.Collections.Generic.List[string]
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere) {
        $paths = & $vswhere -all -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        foreach ($p in @($paths)) {
            if ($p) {
                $candidate = Join-Path $p "VC\Auxiliary\Build\vcvars64.bat"
                if (Test-Path -LiteralPath $candidate) { $found.Add($candidate) }
            }
        }
    }

    # <root>\Microsoft Visual Studio\<version>\<edition>\VC\Auxiliary\Build\vcvars64.bat, kept only when it has an x64 linker.
    $fallback = foreach ($root in $SearchRoots) {
        if (-not $root) { continue }
        Get-ChildItem -Path (Join-Path $root "Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat") -ErrorAction SilentlyContinue | ForEach-Object {
            $vc = $_.Directory.Parent.Parent.FullName
            $toolsets = Get-ChildItem -Path (Join-Path $vc "Tools\MSVC\*\bin\Hostx64\x64\link.exe") -ErrorAction SilentlyContinue |
                ForEach-Object { $_.Directory.Parent.Parent.Parent.Name }
            $best = $toolsets | Sort-Object { [version]$_ } -Descending | Select-Object -First 1
            if ($best) { [pscustomobject]@{ Path = $_.FullName; Toolset = [version]$best } }
        }
    }
    foreach ($f in ($fallback | Sort-Object Toolset -Descending)) {
        if (-not $found.Contains($f.Path)) { $found.Add($f.Path) }
    }
    return $found.ToArray()
}

function Test-MsvcLinker {
    $link = Get-Command link.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    # Git for Windows ships a coreutils link.exe; only the one under VC\Tools\MSVC is the linker cargo needs.
    return [bool]($link -and $link.Source -match '\\VC\\Tools\\MSVC\\')
}

function Enter-MsvcEnvironment {
    if (Test-MsvcLinker) {
        Write-Host "MSVC: using the linker already on PATH ($((Get-Command link.exe).Source))"
        return
    }
    $candidates = @(Find-Vcvars64)
    if ($candidates.Count -eq 0) {
        throw "No MSVC x64 toolset found (vswhere and the standard Visual Studio folders). Install Visual Studio Build Tools with 'Desktop development with C++', or set ADITOR_VCVARS to vcvars64.bat."
    }
    $vcvars = $candidates[0]
    # Import the environment vcvars64 leaves behind into this PowerShell process.
    # `call "<path>"` survives Windows PowerShell 5.1's native-argument quoting; a /s double-quoted line does not.
    $lines = & cmd.exe /d /c "call `"$vcvars`" >nul 2>&1 && set"
    if ($LASTEXITCODE -ne 0) { throw "vcvars64.bat failed: $vcvars" }
    foreach ($line in $lines) {
        $i = $line.IndexOf('=')
        if ($i -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $i), $line.Substring($i + 1), 'Process') }
    }
    if (-not (Test-MsvcLinker)) { throw "vcvars64.bat ran but no MSVC link.exe is on PATH: $vcvars" }
    Write-Host "MSVC: $vcvars (link.exe: $((Get-Command link.exe).Source))"
}
