"""scripts/msvc-env.ps1 finds vcvars64.bat without vswhere and imports its environment (cargo needs MSVC link.exe)."""
from pathlib import Path
import os
import shutil
import subprocess
import sys

import pytest

HELPER = Path(__file__).resolve().parents[2] / "scripts" / "msvc-env.ps1"
SHELL = shutil.which("pwsh") or shutil.which("powershell")
pytestmark = pytest.mark.skipif(sys.platform != "win32" or SHELL is None, reason="needs Windows PowerShell")


def _ps(script: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    full = f". '{HELPER}'\n$ErrorActionPreference = 'Stop'\n{script}"
    return subprocess.run([SHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", full],
                          capture_output=True, text=True, timeout=60, env=env)


def _fake_vs(root: Path, version: str, edition: str, toolset: str | None) -> Path:
    vc = root / "Microsoft Visual Studio" / version / edition / "VC"
    vcvars = vc / "Auxiliary" / "Build" / "vcvars64.bat"
    vcvars.parent.mkdir(parents=True)
    vcvars.write_text("@echo off\r\n", encoding="ascii")
    if toolset:
        link = vc / "Tools" / "MSVC" / toolset / "bin" / "Hostx64" / "x64" / "link.exe"
        link.parent.mkdir(parents=True)
        link.write_bytes(b"")
    return vcvars


def test_fallback_orders_by_toolset_and_drops_installs_without_a_linker(tmp_path):
    old = _fake_vs(tmp_path, "2022", "BuildTools", "14.44.35207")
    new = _fake_vs(tmp_path, "18", "Community", "14.51.36231")
    _fake_vs(tmp_path, "2019", "Community", None)
    env = {k: v for k, v in os.environ.items() if k != "ADITOR_VCVARS"}
    result = _ps(f"Find-Vcvars64 -SearchRoots '{tmp_path}' | ForEach-Object {{ $_ }}", env)
    assert result.returncode == 0, result.stderr
    ours = [line for line in result.stdout.splitlines() if line.startswith(str(tmp_path))]
    assert ours == [str(new), str(old)]


def test_enter_imports_the_vcvars_environment_and_reports_it(tmp_path):
    bindir = tmp_path / "VS" / "VC" / "Tools" / "MSVC" / "14.44.1" / "bin" / "Hostx64" / "x64"
    bindir.mkdir(parents=True)
    shutil.copyfile(os.path.join(os.environ["SystemRoot"], "System32", "whoami.exe"), bindir / "link.exe")
    vcvars = tmp_path / "vcvars 64.bat"  # a space in the path, like "Program Files (x86)"
    vcvars.write_text(f'@echo off\r\nset "PATH={bindir};%PATH%"\r\nset "VCToolsInstallDir=fake"\r\n', encoding="ascii")
    env = dict(os.environ, ADITOR_VCVARS=str(vcvars))
    env["PATH"] = os.pathsep.join(p for p in env["PATH"].split(os.pathsep) if "\\VC\\Tools\\MSVC\\" not in p)
    result = _ps("Enter-MsvcEnvironment; $env:VCToolsInstallDir", env)
    assert result.returncode == 0, result.stderr
    assert f"MSVC: {vcvars}" in result.stdout
    assert str(bindir / "link.exe") in result.stdout
    assert result.stdout.strip().endswith("fake")


def test_missing_override_fails_loudly(tmp_path):
    env = dict(os.environ, ADITOR_VCVARS=str(tmp_path / "missing.bat"))
    result = _ps("Find-Vcvars64", env)
    assert result.returncode != 0
    assert "ADITOR_VCVARS points to a missing file" in result.stderr
