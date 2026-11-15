# Prompt: Valorant Editor — find and fix every remaining issue, finish the missing features, test everything

Copy everything below the line into a new Claude Code session opened at the repository root on Windows.
Work through the phases in order. Do not skip a phase.

---

You are working on **Valorant Editor**: an Electron + React + TypeScript desktop app (`app\`), a Rust analysis engine
(`engine\`, `aditor.exe`), a Rust recorder (`recorder\`, `aditorrec.exe`), a pinned LGPL FFmpeg (`build\ffmpeg`) and the
OBS graphics hook. The machine is Windows 10/11. Use PowerShell syntax (`;` not `&&` in PowerShell 5.1,
`$env:NAME = 'x'`), the scripts in `scripts\*.ps1`, and Python as `py -3 -I`.

**Correctness comes first.**
- Never report a number you did not measure.
- Never claim a test passed unless you ran it and saw it pass.
- Never fake or simulate detection.
- Never skip a verification step or pass a flag that disables one.
- If something cannot be verified, say so and why.

## 1. Known state (measured on 2026-11-15, re-check every line — do not trust it blindly)

### 1.1 Branches and work in flight

| Item | Where | State |
|---|---|---|
| Contracts | `feature/finish-montage-autoedit` (worktree `C:\valorant-edit-montage`) | `0b2b7ca` auto-montage contract tests + main-side `postAnalysis` rule; `8277f51` auto-edit contract, shared ranker `shared/highlightScore.ts`, project schema v2 with v1 migration; `60604de` transitions limited to cut / dip to black / dip to white |
| C. Montage clip selection | merged (`e041150`) | `selectMontageClips` implemented, 57 tests |
| A. Montage pipeline service | agent worktree branch `worktree-agent-a-montage` (or `worktree-agent-aa6fb94bb9101808c`) | in progress or done — find it with `git worktree list` / `git branch --list "*agent*"` |
| B. Recording settings + panel UI | `agent-b/work` (`C:\valorant-edit-wt\agent-b`) | in progress or done |
| F. Auto-edit planner + render stage | `worktree-agent-f-autoedit` (or `worktree-agent-af31d3b045a82bf8c`) | planner first, then the render stage |
| G. Auto-edit dialog + Library montage entries | `agent-g/work` (`C:\valorant-edit-wt\agent-g`) | in progress or done |
| D. Failure scenarios, E. real end-to-end, Verifier | — | not started |
| `C:\valorant-edit` | branch `docs/windows-build-install-prompt` (PR #4) | another session's uncommitted work: `windowsHide` on engine/encoder spawns, `app-identity.ts`, `spawn-windows-hide.test.ts`, `app/scripts/make-init-fixtures.cjs`. Do not touch it; ask the user whether it should be merged |

For every agent branch: `git log --oneline <base>..<branch>` and `git diff --stat <base> <branch>`. Treat each report as a claim: review the diff and re-run its tests before merging. Never merge a branch you have not reviewed.

### 1.2 Issues found (each needs a fix or an explicit "won't fix" with the reason)

| # | Issue | Evidence | Expected fix |
|---|---|---|---|
| I1 | 18 tests fail in `src/main/recording/{live-cache,live-session,match-mode,mp4-codec}.test.ts` | `ENOENT … __fixtures__\init-h264.mp4` / `init-hevc.mp4`; the files were never committed because `.gitignore` has `*.mp4` | Regenerate them reproducibly (script, e.g. `app/scripts/make-init-fixtures.cjs`, using `build\ffmpeg` with `*_nvenc` + AAC, `frag_keyframe+empty_moov+default_base_moof`, truncated before `moof`). Add a `.gitignore` exception for `app/src/main/recording/__fixtures__/init-*.mp4` and commit them. Ask the user first. Use the HEVC/AV1 variants only if this GPU has NVENC for them; otherwise say which fixture could not be produced |
| I2 | Engine `tests\aspect.rs` fails unless FFmpeg is on `PATH` | `tests\common\mod.rs:129` spawns `ffmpeg` from PATH | Resolve `ADITOR_FFMPEG` → `build\ffmpeg\bin` → PATH in the test helper, or skip with a printed reason; never silently pass |
| I3 | No MSVC linker on PATH; `vswhere` lists no instance | `vswhere -all` prints nothing, but `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\link.exe` and VS 18 Community exist; a fresh `cargo build` fails with ``linker `link.exe` not found`` | Build through `vcvars64.bat` (a `cmd /c "call …\vcvars64.bat && cargo …"` wrapper). Make `scripts\build.ps1` / `test.ps1` find vcvars when vswhere returns nothing (fallback search of the standard paths) and print which one they used |
| I4 | Node is v24.13.0; the docs ask for 22 | `node -v` | Ask the user. If 24 stays, document it in the README and build docs |
| I5 | `py -3 -I tools\evaluate_valorant.py` crashes | `ModuleNotFoundError: No module named 'engine_cli'` (isolated mode drops the script folder from `sys.path`) | Add the same `sys.path` insert that `tools\eval_feed_labels.py` has, and a test or check that both tools start under `-I` |
| I6 | Reference clip `videoplayback.mp4` is missing | not in the repo root or anywhere searched | Ask the user for it. Without it the 19-kill / 12-death baseline (`CHANGELOG.md`) cannot be re-measured. Say so in the final report |
| I7 | Only one labelled clip | `tools\labels\videoplayback.json` only | Ask the user for more VALORANT clips (1080p native, 1440p, 720p compressed, 30 and 60 fps, different HUD scale). The user's Outplayed library (`%USERPROFILE%\Videos\Overwolf\Outplayed\Valorant`) has many; use it only after the user says yes |
| I8 | Pinned FFmpeg is a minimal LGPL build | `ffmpeg -filters` lists 33 filters: aformat anull aresample atrim volume anullsrc sine crop drawbox format fps hflip hwdownload null overlay pad rotate scale select setpts split transpose trim vflip vstack color testsrc2 | No `xfade`, `fade`, `drawtext`, `amix`, `sidechaincompress`, `atempo`, `zoompan` or `boxblur`. The user chose to work within this build. Dips use stepped `drawbox`. Captions are PNGs (Montserrat Black from a hidden Electron window) placed with `overlay`. Slow-mo has silent game audio. Music, ducking and beat sync are mixed in Node on PCM. Never add a filter that is not in the list |
| I9 | `npm run lint` only checks `src/renderer/**` | ESLint ignores `src/main`, `src/shared` | Ask the user whether to widen the lint scope; if yes, fix what it finds in separate commits |
| I10 | Library shows montage entries as "Imported" and asks the imported-source question on delete | `VideoCard.tsx:287`, `lib/libraryFilter.ts:39-44`, `LibraryScreen.tsx:186-210` | Agent G's scope. Verify it was fixed |
| I11 | Auto-montage hooks are declared but never called; `AnalysisQueue` emits no `'analyzed'` event; export has no process priority | `recording/index.ts:86-96`, `queue.ts:243-255`, `export/run.ts` | Agent A's scope. Verify |
| I12 | Console windows can flash for `aditor.exe` / `ffmpeg -encoders` spawns | missing `windowsHide: true` in `main/engine.ts`, `export/encoders.ts` (fix exists uncommitted in the other session) | Check whether PR #4 / the other session lands it; if not, apply it with a test |
| I13 | `ExportPresetCards` hard-codes `name="xd-preset"` and always shows the Source card | `renderer/studio/ExportFormatControls.tsx` | Agent B may add backward-compatible props. Verify the export drawer is unchanged |
| I14 | Agent worktrees were auto-deleted when an agent stopped without changes | happened to agents B and G | Create agent worktrees yourself (`git worktree add -b agent-x/work C:\valorant-edit-wt\agent-x <base>`, plus an `app\node_modules` junction to the main worktree). Verify `git log -1` before briefing |

### 1.3 Feature status

| Feature | Status |
|---|---|
| Kill/death detection on compressed footage (`valorant-feed@10`) | ✅ on main; measured only on one clip |
| Export: reframe, presets, H.265, export drawer, Windows media protocol | ✅ on main |
| Auto montage contract | ✅ |
| Auto montage selection (C) | ✅ merged |
| Auto montage pipeline, IPC, notification, library entry (A) | in flight |
| Auto montage settings + panel (B) | in flight |
| Auto montage failure scenarios (D), real e2e (E) | ❌ not started |
| Auto edit contract, shared ranker, schema v2 | ✅ |
| Auto edit planner (F) | in flight |
| Auto edit render stage within the pinned FFmpeg (F) | in flight |
| Auto edit dialog, effect badges, Library montage entries (G) | in flight |
| Detection on more clips | ❌ blocked on clips from the user |
| Docs (CHANGELOG, README, audit rows, `docs\windows-readiness-results.md`), PR, Windows build + install | ❌ |
| Audit roadmap items: headshot, wallbang, clutch 1vN from HUD, team wipe, spike plant/defuse, match result/MVP, confidence display, dashboard | ❌. Out of scope unless the user asks. Each needs labelled footage before any detector is enabled |

### 1.4 Test snapshot (measured on `feature/finish-montage-autoedit` at `e041150`, FFmpeg on PATH, MSVC via vcvars)

| Suite | Result |
|---|---|
| `npx vitest run` (all, incl. real FFmpeg) | 229 files: 225 passed, 4 failed. 2758 tests: 2738 passed, 18 failed, 2 skipped. The 18 failures are exactly issue I1 |
| `npm run test:fast` (at `8277f51`) | 2686 passed, 18 failed (I1), 2 skipped |
| `npm run typecheck` | pass |
| `npm run lint` | pass (renderer only, see I9) |
| `cargo test --no-fail-fast` | 215 passed, 0 failed, 14 ignored |
| `cargo clippy --all-targets` | pass, no warnings |
| Playwright e2e | not run yet |
| Detection evaluator | not run: reference clip missing (I6) |

## 2. Phase 0: Prepare

1. Run `git status`, `git worktree list`, `git branch -a --list "*agent*"` and `git log --oneline -10` on `feature/finish-montage-autoedit`. List any dirty files and ask before going on.
2. Check the toolchain:
   - `node -v`
   - `cargo -V`
   - `gh auth status`
   - the linker via vcvars (I3)
   - `powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg.ps1`
   - an engine build through vcvars
   - `cd app; npm ci` (only in a worktree without a node_modules junction)
3. Record a baseline and write it down:
   - engine: `cargo test --no-fail-fast` with FFmpeg on PATH, `cargo clippy --all-targets`
   - app: `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npx vitest run` (includes the real-FFmpeg tests)
   - e2e: `npx playwright test -c e2e\playwright.config.ts`
   - detection evaluator: `.\engine\target\release\aditor.exe debug-valorant-feed <clip> --profile-dir templates\valorant\icons` with `$env:ADITOR_FFMPEG` set, scored with `py -3 -I tools\eval_feed_labels.py --labels tools\labels\<clip>.json --detections <out.jsonl>`. Use it for every labelled clip that exists on disk.

## 3. Phase 1: Integrate the in-flight work (lead)

For A, B, F, G, in that order, once each reports:
1. Review the diff against the brief and the contract. No exported signature in `shared/montage.ts`, `shared/autoEdit.ts`, `shared/highlightScore.ts`, `shared/autoEditProject.ts` or `renderer/editor/project.ts` may change, and no agent may have edited a file it does not own.
2. Merge with `--no-ff` into `feature/finish-montage-autoedit`.
3. Run `npm run typecheck` and the agent's tests, then `npm run test:fast`.
4. Send failed work back to the same agent with the exact failure.

Then launch:
- **D** (failure scenarios, `app\src\main\montage\*.scenario.test.ts`) after A is merged.
- **E** (real FFmpeg montage per preset 1920×1080 / 1080×1920 / 1080×1080, ffprobe duration ±0.5 s, audio present, decodes fully; Playwright toggle + panel status) after A and C are merged.
- **Verifier** (read-only, loops after each merge, writes `docs\auto-montage-verification.md` with the 18-row matrix from `docs\prompts\feature-auto-record-montage.md` Phase 4).

Fixes D finds go back to the lead; apply them yourself.

## 4. Phase 2: Fix the issues

Fix I1–I14 in focused commits, asking first where the table says so. For each fix:
- add a test that fails before the fix and passes after it, or say why no test is possible;
- run that test and the suite it belongs to.

## 5. Phase 3: Detection (only with clips the user provides or approves)

For each clip:
1. A Labeler subagent writes `tools\labels\<clip>.json` (time ±1 s, type). It samples the kill-feed crop every 0.5 s with ffmpeg, makes contact sheets and reads them — never from detector output.
2. Evaluate the clip: precision, recall, misses and extras.
3. For each group of misses, a miss investigator (own worktree, edits nothing shared) cuts a 6 s clip and finds the rejecting check in `feed.rs` / `tracker.rs`.
4. The lead applies the smallest rule change, with thresholds scaled to the banner crop.
5. Add rejection tests: teammate rows, enemy-kills-ally, ability rows, faded rows.
6. Re-run the evaluator on every labelled clip after each change.
7. Bump `templates_version` to `valorant-feed@11` only if the output changed.

Target: 100 % precision on every clip, a recall table per clip, and zero false positives on contact sheets of every newly added event.

## 6. Phase 4: Test everything (required)

- **Suites.** Nothing that passed in the baseline may fail:
  - `powershell -ExecutionPolicy Bypass -File scripts\test.ps1`, or separately:
  - engine: `cargo test --no-fail-fast; cargo clippy --all-targets`
  - app: `npm run typecheck; npm run lint; npm run test:fast; npx vitest run export-real montage`
  - e2e: `npx playwright test -c e2e\playwright.config.ts`
  - Report exact pass/fail counts against the baseline.
- **Scenario matrix.** Each of the 18 rows is ✅ with a named test you saw pass, or listed as not verified with the reason.
- **Auto edit:**
  - unit tests from `docs\prompts\windows-all-in-one.md` Phase 4 "Auto-edit";
  - real FFmpeg Clean and Hype montages from two `testsrc2` sources, checked with ffprobe: duration within ±1 frame of the plan, size, fps, audio stream;
  - frames extracted to confirm a dip and a caption at the planned times;
  - music level lower under game audio, measured.
- **Windows:**
  - paths with spaces, non-ASCII user names and OneDrive folders;
  - no orphan `ffmpeg.exe` / `aditor.exe` after cancel and quit (`Get-Process`);
  - recording never delayed by montage work;
  - sources deleted only after a verified export.
- **In the app** (`cd app; npm run dev`):
  - Simulate a match with the fake engine fixture if VALORANT is not available.
  - Confirm the auto montage appears in the library, opens in Studio and re-exports.
  - Run Auto edit once per style on the reference clip and on at least 5 short recorder clips (`%USERPROFILE%\Videos\Valorant Editor\Recordings\…`). Watch each result.
  - Take screenshots of the Recording settings section, the panel status, the Auto edit dialog and the resulting timeline.

## 7. Phase 5: Docs, commits, PR

1. Update:
   - `CHANGELOG.md`: Unreleased → Added: Auto montage, Auto edit styles; Fixed: the issues above.
   - the README feature table;
   - the audit's feature-gap rows: event priorities, per-clip speed/audio, effects, music/overlays/intro-outro, presets, one-click montage, auto montage after each match;
   - `docs\windows-readiness-results.md`.
2. Write the FFmpeg limits (I8) in the README and the audit.
3. Use focused commits. Each message ends with the attribution line Claude Code uses.
4. Run `git status` and `git diff --stat` before every commit. Never commit `node_modules`, `build\`, `dist\`, videos (except the approved I1 fixtures), secrets, worktrees, debug prints or scratch files.
5. Ask the user before pushing. Then `git push -u origin feature/finish-montage-autoedit` (never force, never main) and `gh pr create --base main` with: what changed, the scenario matrix, the detection table, test commands and counts, screenshots, and known limitations.

## 8. Phase 6: Build and install on this machine

1. Follow `docs\prompts\windows-build-and-install.md` steps 2–4 (on branch `docs/windows-build-install-prompt` if it is not merged yet) on the finished branch: a full `scripts\build.ps1` run through vcvars.
2. Confirm both artifacts are in `dist\`.
3. Do a silent per-user install.
4. Check the bundled engine, FFmpeg, recorder and OBS hook, and the uninstall entry.
5. Run a launch smoke test.
6. Do not tag or publish a release.

## 9. Final report

- Per feature: done / partly done / not done.
- Test counts vs the baseline.
- The scenario matrix.
- Detection precision/recall per clip.
- Auto-edit planned vs real length per style.
- Each issue I1–I14: fixed (commit), won't fix (why), or blocked (on what).
- Windows findings: fixed / to verify.
- What was checked by hand, and what could not be verified and why.
- Branch, PR link, installed version and path.

## Constraints

- Everything stays local: no uploads, no game memory reading or injection — only the Riot Client local API and on-screen pixels.
- No new runtime dependencies. No libx265 or other GPL FFmpeg parts. No new FFmpeg build unless the user provides one.
- No recorder changes unless a scenario test proves one is needed; then ask first.
- `autoMontage` stays off by default, and no other recording default changes. GPL-3.0 notices stay.
- `english-default.test.ts`, `tr-keys.test.ts` and `i18n\catalog.test.ts` stay green. Every new string is in the English catalog.
- Subagents work in their own worktrees, own their files strictly, never commit to the feature branch, never push and never open PRs. Keep the total around 10 agents.
