# Prompt: Detect every kill and death in every VALORANT clip

Copy everything below the line into a new Claude Code session opened at the repository root
(`/Users/informationtechnology/Downloads/abc-v`). Work through the phases in order and do not skip one.

---

You are working on **Valorant Editor**, an Electron + React + TypeScript desktop app with a Rust analysis engine
(`engine/`, binary `aditor`), forked from Aditor. The app analyzes VALORANT recordings and marks the player's kills
and deaths from the on-screen kill feed. Right now it misses some of them. Some clips get only a few random events
instead of the full list.

**Goal:** for any VALORANT clip the user imports, at any resolution or quality, find **every** kill the player makes
and **every** death the player suffers, with **no** false events. Then commit and **push to GitHub**.

Correctness comes first. Never report a number you did not measure, and never claim a test passed unless you ran it
and saw it pass. Do not fake or simulate detection.

## Work split: use subagents

Split the work into subagents (the Agent tool) so independent parts run in parallel. You, the main agent, stay the
coordinator: you own `engine/src/valorant/feed.rs`, decide every rule change, and check every subagent's result
yourself before relying on it. A subagent's report is not proof.

Give each subagent a complete brief: the goal, the files, the exact commands, and what "done" looks like. They know
nothing about this conversation. Never let two subagents edit the same file.

| Subagent | When | Task | Returns |
|---|---|---|---|
| **Labeler** (one per clip) | Phase 1, in parallel | Sample the kill-feed crop every 0.5 s, make contact sheets, and write `tools/labels/<clip>.json` by eye. Never read the detector's output. | Label file + list of uncertain moments |
| **Evaluator** | Phase 1 | Write or adapt the script that compares detector events to labels (precision, recall, misses, extras). | Script path + baseline numbers |
| **Miss investigator** (one per group of misses) | Phase 2, in parallel | Cut a 6 s clip around each miss, add temporary debug prints **in its own git worktree**, and find which check rejects the row. Do not change the shared tree. | For each miss: rejecting check, measured values, suggested rule |
| **False-positive reviewer** | Phase 3 | Make contact sheets for every event the new build adds. Mark each one real or false. | Table of event → verdict |
| **Test runner** | Phase 3 | Run `cargo test`, `cargo clippy`, `npm run typecheck`, `npm run lint`, `npm run test:fast` and compare to the baseline. | New failures only, with output |
| **Docs writer** | Phase 4 | Update `CHANGELOG.md` and `docs/VALORANT-EDITOR-AUDIT.md` from the measured numbers you give it. | Diff of the doc files |

Rules:

- Apply the rule changes in `feed.rs` and `tracker.rs` yourself, one at a time, re-running the evaluator after each.
- Re-run anything whose result decides "done" yourself: the final evaluation numbers and the test suites.
- Keep the agent count reasonable (under about 10 in total). Don't spawn an agent for a check you can run in one
  command.

## Background: what is already known

- Pipeline: FFmpeg decodes the kill-feed crop (`BANNER_REF = [1316, 84, 600, 256]` in 1080p reference coordinates;
  row k is centred at y = 112 + 40k). Then:
  - `engine/src/valorant/feed.rs` (`FeedDetector::observations`) classifies each row.
  - `engine/src/valorant/tracker.rs` de-duplicates rows into events.
  - `valorant_rounds.rs` handles rounds, and `round_highlights()` handles multikills and aces.
- How the player's own rows look:
  - **Own kill:** player name on the left, ally **teal** background, a **yellow outline**, and a yellow chevron at
    the **left** end.
  - **Own death:** enemy (red) on the left, the player on the right in teal, a yellow outline, and a yellow chevron at
    the **right** end.
  - Rows of teammates (teal, no yellow) and enemy-vs-ally rows must **not** count.
- Root cause of the misses: compressed or upscaled footage (e.g. 720p YouTube encodes) blurs the thin yellow outline,
  so the outline checks reject real own rows.
- A first fix is already in the working tree: `FeedDetector::lone_chevron()` in `feed.rs`, called from `boxes()`.
  It accepts a solid yellow chevron at the row's outer end when the player's half of the row next to it is teal. On
  the reference clip `videoplayback.mp4` (repo root, 720p, ~14 min) it raised detection from 4 kills + 1 death to
  **19 kills + 10 deaths**. All of them were checked visually as real.
- Known remaining miss: a death ("Jett → Me") at about **47.5 s**. Its chevron component is only ~15 px tall
  (w = 10, x ≈ 580, y ≈ 20 in the banner crop), but `lone_chevron` requires `h >= 18`. A death-side minimum of about 14
  is the likely fix. Test it; do not assume it works.
- The detection result is cached per video. `templates/valorant/icons/profile.json` → `templates_version`
  (currently `valorant-feed@9`) must be bumped, or old analyses are never redone.

## Phase 0: Prepare

1. Run `git status`. The working tree holds uncommitted earlier work: the VALORANT-only product changes, macOS path
   and import fixes, and the `lone_chevron` detection. Ask me whether to commit that first as its own commit. If I say
   yes, run the tests, then commit.
2. Create a branch: `git switch -c fix/full-kill-death-detection`.
3. Build the engine (`cd engine && cargo build --release`). Then record a baseline on the reference clip:
   ```bash
   ADITOR_FFMPEG=$PWD/build/ffmpeg/bin/ffmpeg engine/target/release/aditor debug-valorant-feed videoplayback.mp4 --profile-dir templates/valorant/icons > /tmp/baseline.jsonl
   ```
   The last line holds `events`. Save the kill and death counts and timestamps.
4. Record the test baselines: `cd engine && cargo test` and `cd app && npm run test:fast` (use Node 22). Note which
   tests already fail before your change, so you neither blame nor hide them.

## Phase 1: Build a labelled ground truth (no guessing)

1. For `videoplayback.mp4`, and for every other VALORANT recording I give you, make a label file
   `tools/labels/<clip>.json` with every own kill and own death (time ± 1 s, type).
2. Build the labels by looking at the frames, not from the detector's output. Sample the kill-feed crop every
   0.5 s with ffmpeg, make contact sheets, and read them. Count a row only if it is the player's own row (as defined
   above).
3. If the repo's evaluator `tools/evaluate_valorant.py` fits, use it. Otherwise write a small script that compares
   detector events to labels and prints precision, recall, missed events and extra events.
4. Cover several kinds of footage if available: 1080p native, 1440p, 720p compressed upload, 60 fps and 30 fps,
   different HUD scales. If I have not given you such clips, ask me for them. Do not invent footage.

## Phase 2: Fix detection

1. Fix the 47.5 s death first (shorter chevron on the death side), then rerun the evaluation.
2. For each remaining miss, find the exact rejecting check in `boxes()`, `outline()`, `team()` or `chevrons()`, or a
   dedupe window in `tracker.rs`. Find it with temporary debug prints on a short clip cut around the event
   (`ffmpeg -ss T-3 -t 6`). Change the smallest rule that fixes it.
3. Make the rules resolution-independent. Thresholds must scale with the banner crop, not assume 1080p pixels.
4. Check that every new rule rejects the following; add a unit test for each:
   - teammate rows (teal, no yellow)
   - enemy-kills-ally rows
   - the "Clove resurrect" style ability rows
   - empty or partially faded rows
5. Remove all debug prints before finishing.
6. Bump `templates_version` in `templates/valorant/icons/profile.json` (e.g. to `valorant-feed@10`), and update any
   test or code that references the old value.

## Phase 3: Verify

1. Every labelled clip must reach **100 % precision** and as close to **100 % recall** as possible.
   - List any remaining miss with its timestamp and the reason it can't be fixed safely.
   - The reference clip must have at least 19 kills and 10 deaths, plus the 47.5 s death.
2. Check every new event visually on a contact sheet. Zero false positives.
3. Run `cargo test` and `cargo clippy` in `engine/`, and `npm run typecheck`, `npm run lint` and `npm run test:fast`
   in `app/`. Nothing may fail that passed in the baseline.
4. End-to-end check in the real app (`cd app && npm run dev`):
   - Re-import or re-analyze `videoplayback.mp4`.
   - Confirm the library card and Studio timeline show all kills and deaths.
   - Confirm that kills inside one round form multikill highlights.
   - Take a screenshot as proof.
5. Make sure it works the same on Windows and macOS: engine paths, `ADITOR_FFMPEG`, and no `cfg(windows)`-only code
   in the analysis path.

## Phase 4: Document, commit and push to Git

1. Update `CHANGELOG.md` (top "Valorant Editor" section) and the detection section of
   `docs/VALORANT-EDITOR-AUDIT.md`. Include the measured precision and recall per clip.
2. Commit with a clear message, for example
   `Detect own kill-feed rows on compressed footage; full kill/death recall on reference clips`.
3. **Push to GitHub** once the work is finished and verified:
   - Run `git push -u origin fix/full-kill-death-detection` (remote: `https://github.com/Fairoz007/valorant-edit.git`).
   - If I ask for it, open a pull request into `main` with the evaluation table in the description.
   - Do not force-push, and do not push to `main` directly unless I say so.
4. Before pushing, make sure no subagent worktree, debug print or scratch file was left in the commit (`git status`,
   `git diff --stat`).
5. Finish with a short report:
   - before/after counts per clip
   - precision and recall
   - files changed
   - test results
   - the pushed branch and PR link
   - anything left unverified
