"""Every tool that imports a sibling module must start under `python -I` (isolated mode drops the script folder from sys.path)."""
from pathlib import Path
import re
import subprocess
import sys

import pytest

TOOLS = Path(__file__).resolve().parents[1]
SIBLINGS = {p.stem for p in TOOLS.glob("*.py")}


def _imports_sibling(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    return any(m.group(1) in SIBLINGS for m in re.finditer(r"^(?:from|import) (\w+)", text, re.MULTILINE))


SCRIPTS = sorted(p for p in TOOLS.glob("*.py") if _imports_sibling(p))


def test_found_the_scripts_that_import_siblings():
    names = {p.name for p in SCRIPTS}
    assert {"evaluate_valorant.py", "eval_feed_labels.py", "icon_accept.py"} <= names


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_help_runs_in_isolated_mode(script, tmp_path):
    # Run from an unrelated folder so the working directory cannot supply the import either.
    result = subprocess.run([sys.executable, "-I", str(script), "--help"], cwd=tmp_path, capture_output=True, text=True, timeout=60)
    assert "ModuleNotFoundError" not in result.stderr, result.stderr
    assert result.returncode == 0, result.stderr
