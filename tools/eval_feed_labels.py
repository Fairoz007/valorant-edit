"""Score `aditor debug-valorant-feed` output against hand-made kill-feed labels.

Usage:
  python3 tools/eval_feed_labels.py --labels tools/labels/videoplayback.json --detections out.jsonl
  python3 tools/eval_feed_labels.py --labels tools/labels/videoplayback.json --run videoplayback.mp4

Events are matched per type (kill<->kill, death<->death) one-to-one within
+/- tolerance seconds. Detector events with deleted=true are ignored.
Exit code is 0 unless an input cannot be read or the engine run fails.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from evaluate_valorant import match_events  # noqa: E402  (definitions only, no side effects)

TYPES = ("kill", "death")
EXE = ".exe" if os.name == "nt" else ""


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def load_labels(path: Path) -> list[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return [{"t": float(e["t"]), "type": e["type"]} for e in doc["events"]]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        fail(f"cannot read labels {path}: {exc}")


def parse_detections(text: str, source: str) -> list[dict]:
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        fail(f"no JSON lines in {source}")
    try:
        last = json.loads(lines[-1])
        events = last["events"]
        return [{"t": float(e["t"]), "type": e["type"]} for e in events if not e.get("deleted", False)]
    except (ValueError, KeyError, TypeError) as exc:
        fail(f"cannot parse last line of {source}: {exc}")


def run_detector(video: Path) -> str:
    ffmpeg = os.environ.get("ADITOR_FFMPEG") or str(ROOT / "build" / "ffmpeg" / "bin" / f"ffmpeg{EXE}")
    engine = ROOT / "engine" / "target" / "release" / f"aditor{EXE}"
    profile = ROOT / "templates" / "valorant" / "icons"
    if not engine.is_file():
        fail(f"engine binary not found: {engine}")
    if not video.is_file():
        fail(f"video not found: {video}")
    cmd = [str(engine), "debug-valorant-feed", str(video), "--profile-dir", str(profile)]
    env = {**os.environ, "ADITOR_FFMPEG": ffmpeg}
    print("running: " + " ".join(cmd), file=sys.stderr)
    proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, text=True, encoding="utf-8")
    if proc.returncode:
        fail(f"engine exited with code {proc.returncode}")
    return proc.stdout


def ratio(num: int, den: int) -> tuple[float, bool]:
    """Return (value, was_zero_over_zero)."""
    return (1.0, True) if den == 0 else (num / den, False)


def score(labels: list[dict], detections: list[dict], tolerance: float) -> dict:
    per_type = {}
    missed, extra, pairs = [], [], []
    for kind in TYPES:
        truth = [e["t"] for e in labels if e["type"] == kind]
        found = [e["t"] for e in detections if e["type"] == kind]
        result = match_events(truth, found, tolerance)
        matched_truth = sorted(p["truth"] for p in result["pairs"])
        matched_found = sorted(p["predicted"] for p in result["pairs"])
        for t in sorted(truth):
            if t in matched_truth:
                matched_truth.remove(t)
            else:
                missed.append({"t": t, "type": kind})
        for t in sorted(found):
            if t in matched_found:
                matched_found.remove(t)
            else:
                extra.append({"t": t, "type": kind})
        pairs += [{"type": kind, "label": p["truth"], "detected": p["predicted"], "error": p["error"]}
                  for p in result["pairs"]]
        per_type[kind] = summarize(result["truth"], result["predicted"], result["tp"])
    tp = sum(s["tp"] for s in per_type.values())
    overall = summarize(len(labels_of(labels)), len(labels_of(detections)), tp)
    key = lambda e: (e["t"], e["type"])
    return {"tolerance": tolerance, "per_type": per_type, "overall": overall,
            "missed": sorted(missed, key=key), "extra": sorted(extra, key=key),
            "pairs": sorted(pairs, key=lambda p: (p["label"], p["type"]))}


def labels_of(events: list[dict]) -> list[dict]:
    return [e for e in events if e["type"] in TYPES]


def summarize(n_labels: int, n_detected: int, tp: int) -> dict:
    precision, p00 = ratio(tp, n_detected)
    recall, r00 = ratio(tp, n_labels)
    return {"labels": n_labels, "detected": n_detected, "tp": tp,
            "fp": n_detected - tp, "fn": n_labels - tp,
            "precision": round(precision, 4), "recall": round(recall, 4),
            "precision_zero_over_zero": p00, "recall_zero_over_zero": r00}


def print_report(report: dict, ignored: dict) -> None:
    print(f"tolerance: +/-{report['tolerance']} s")
    if ignored["labels"] or ignored["detections"]:
        print(f"ignored events with unknown type: labels={ignored['labels']} detections={ignored['detections']}")
    header = f"{'type':<8}{'labels':>7}{'detected':>9}{'TP':>5}{'FP':>5}{'FN':>5}{'precision':>11}{'recall':>9}"
    print(header)
    notes = []
    rows = [*report["per_type"].items(), ("overall", report["overall"])]
    for name, s in rows:
        p = f"{s['precision']:.3f}" + ("*" if s["precision_zero_over_zero"] else "")
        r = f"{s['recall']:.3f}" + ("*" if s["recall_zero_over_zero"] else "")
        print(f"{name:<8}{s['labels']:>7}{s['detected']:>9}{s['tp']:>5}{s['fp']:>5}{s['fn']:>5}{p:>11}{r:>9}")
        if s["precision_zero_over_zero"] or s["recall_zero_over_zero"]:
            notes.append(name)
    if notes:
        print(f"* 0/0 reported as 1.0 ({', '.join(notes)})")
    print(f"\nmissed labels (FN, {len(report['missed'])}):")
    for e in report["missed"]:
        print(f"  {e['t']:9.2f}  {e['type']}")
    print(f"\nextra detections (FP, {len(report['extra'])}):")
    for e in report["extra"]:
        print(f"  {e['t']:9.2f}  {e['type']}")
    print(f"\nmatched pairs (TP, {len(report['pairs'])}):")
    for p in report["pairs"]:
        print(f"  label {p['label']:9.2f} -> detected {p['detected']:9.2f}  {p['type']:<5}  error {p['error']:+.2f} s")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--labels", required=True, type=Path)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--detections", type=Path, help="JSON-lines output of debug-valorant-feed")
    source.add_argument("--run", type=Path, metavar="VIDEO", help="run debug-valorant-feed on VIDEO")
    parser.add_argument("--tolerance", type=float, default=1.0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    labels = load_labels(args.labels)
    if args.run is not None:
        detections = parse_detections(run_detector(args.run.resolve()), str(args.run))
    else:
        try:
            text = args.detections.read_text(encoding="utf-8")
        except OSError as exc:
            fail(f"cannot read detections {args.detections}: {exc}")
        detections = parse_detections(text, str(args.detections))

    ignored = {"labels": len(labels) - len(labels_of(labels)),
               "detections": len(detections) - len(labels_of(detections))}
    report = score(labels, detections, args.tolerance)
    if args.json:
        print(json.dumps({**report, "ignored_unknown_type": ignored}, indent=2))
    else:
        print_report(report, ignored)


if __name__ == "__main__":
    main()
