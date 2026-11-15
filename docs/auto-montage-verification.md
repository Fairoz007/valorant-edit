# Auto montage / Auto edit verification

- Date: 2026-11-15 (iteration 2)
- Branch: `agent-verifier/work`, lead tip `feature/finish-montage-autoedit` @ `0f8e8bd` ("Auto montage: real FFmpeg montage per preset and e2e spec (agent E)").
- Sync: `git merge --ff-only` was **not possible**: `agent-verifier/work` carried the iteration-1 report commit `35b2fc3`, which is not on the lead branch. Nothing was forced or rewritten; the lead tip was merged into `agent-verifier/work` with a plain merge (`88d8cf4`, no conflicts, the report is the only verifier-only file). All results below are for the `0f8e8bd` tree.
- Env: `ADITOR_FFMPEG` / `ADITOR_FFPROBE` = `build\ffmpeg\bin\{ffmpeg,ffprobe}.exe` in this worktree. Real-FFmpeg tests ran with `h264_nvenc` (plus a libopenh264-only case).

Legend: ✅ covered by a test seen passing this iteration · ❌ test fails · ⬜ no test yet.

## Suite counts

| Command | Result | Baseline | Delta |
|---|---|---|---|
| `npm run typecheck` | exit 0 | — | — |
| `npm run lint` | exit 0 | — | — |
| `npm run test:fast` (run 2) | 3006 passed, 18 failed, 2 skipped (3026); files 242 passed / 4 failed | 2652 passed / 18 failed | +354 passed, 0 new failures |
| `npm run test:fast` (run 1) | 3000 passed, 24 failed | — | 6 extra failures, all timeouts under load; see Regressions |
| `npx vitest run src/main/montage src/shared/montage src/shared/autoEdit src/shared/highlightScore src/main/export/montage-{plan,audio,ipc}.test.ts` | 18 files, 267 passed, 0 failed (includes `montage-real.test.ts` and both `*.scenario.test.ts`, not skipped) | — | — |
| `npx vitest run src/main/export/{export-real,export-reframe-real,montage-render-real}.test.ts` | 3 files, 20 passed, 0 failed | — | — |
| `npx electron-vite build` + `playwright test e2e/montage.spec.ts` | 2 passed | — | — |

The 18 failures are exactly the baseline tests in `src/main/recording/{live-cache (10), live-session (2), match-mode (4), mp4-codec (2)}.test.ts` (missing `init-*.mp4` fixtures).

Full e2e suite: not run by the verifier this iteration (only `montage.spec.ts`). The coordinator reports 6 failures outside `montage.spec.ts` in specs that expect zh-TW text; listed as **pre-existing**, not regressions. The e2e global setup also printed `ffmpeg could not generate synthetic videos: Unrecognized option 'allow_skip_frames'` (the shell had no `ADITOR_FFMPEG` set for that step; the montage spec seeds its own data and passed).

## Scenario matrix (Auto montage)

Abbreviations: `svc` = `src/main/montage/montage-service.test.ts`, `hooks` = `src/main/montage/montage-hooks.test.ts`, `exp` = `src/main/montage/montage-export.test.ts`, `pipe` = `src/main/montage/montage-pipeline.scenario.test.ts`, `rec` = `src/main/montage/montage-recording.scenario.test.ts`, `real` = `src/main/montage/montage-real.test.ts`, `sel` = `src/shared/montage.select.test.ts`, `status` = `src/renderer/shell/montageStatus.test.tsx`, `e2e` = `app/e2e/montage.spec.ts`.

| # | Scenario | Status | Evidence |
|---|---|---|---|
| 1 | Builtin recorder, Auto montage on | ✅ | real "youtube: recorded -> analyzed -> selecting -> exporting -> done, 1920x1080" (real FFmpeg, ffprobe-verified); hooks "built-in finalization > finalizeSession: full analysis queued"; svc full-analysis happy path (library entry and notice); svc "open > …"; e2e "recording panel: seeded montage jobs show \"Montage ready\" with Open…" |
| 2 | OBS backend | ✅ | hooks "OBS finalization > finalizeObsMatches: …" (2 tests); rec "scenario 11: OBS backend reconnect > finalizing again after a reconnect … yields one job and one montage per file" |
| 3 | Live-trusted analysis | ✅ | hooks "finalizeSession: trusted live cache, no full analysis", "per-match cut (completeCut): afterExit with a trusted live cache"; svc "live-trusted path: …" |
| 4 | Full analysis (`perMatch`) | ✅ | hooks "AnalysisQueue 'analyzed' event > is emitted once after a successful run…"; svc full-analysis happy path; pipe "scenario 6 > an analysis interrupted by quit (engine_stopped) or cancelled keeps the job waiting; a later successful run builds the montage" |
| 5 | `afterGameExit`, 3 matches | ✅ | svc "afterGameExit > three matches wait while the game runs, then export one at a time after it closes" |
| 6 | Auto montage off | ✅ | svc "Auto montage off > creates no job and changes nothing"; pipe "scenario 9: Auto montage turned off mid-job > …" (2 tests); e2e "settings: Auto montage card turns on …, persists, and turns off" |
| 7 | 0–1 kills | ✅ | sel "is empty with 0 kills…", "is tooFew for 1 kill…"; svc "selection tooFew/empty → skipped"; status "skipped tooFew/empty"; e2e skipped-job line |
| 8 | Over `maxDurationSec` | ✅ | sel "duration cap > keeps the highest-value windows, whole, under the cap", "windows and merging > never splits a multikill…" |
| 9 | Remake / match cancelled | ✅ (new) | rec "scenario 1: match cancelled (matchCancel) or remake > a countdown that is cancelled (match_pending → match_cancel) creates no match, no job and no file", "a match index recorded as skipped in matches.json is never reported to the montage service", "OBS: a cancelled or unconfirmed per-match recording is never reported…", "a remake with one kill → skipped(…), no render and no file", "a remake with no kills → skipped(), no render and no file" |
| 10 | Crash during export, restart | ✅ | pipe "scenario 3: app crash mid-export, then restart > the job resumes once: attempts + 1, no .partial or segment left, one montage file, one library entry"; svc "resume after restart > an interrupted export removes its leftovers and runs again exactly once" |
| 11 | Next match starts during export | ✅ | pipe "scenario 8 > finalizing the next match is never awaited behind the export, and its job waits its turn", "a running export drops to idle priority when recording starts (below normal while the game runs)"; `run-priority.test.ts` "really lowers a child process priority (no mock)" |
| 12 | Low disk | ✅ | pipe "scenario 4: low disk > below diskWarnGb → skipped(lowDisk)…; the recording, its cache and library entry are untouched", "below the estimate plus diskStopGb → …", "(defect) the user gets a notice that the montage was skipped for low disk space" |
| 13 | No hardware encoder | ✅ | pipe "scenario 5: no hardware encoder > …" (4 tests); real "shorts-sw: … 1080x1920 (libopenh264 only)" |
| 14 | Format presets 16:9 / 9:16 / 1:1 | ✅ (new) | real "youtube: … 1920x1080", "shorts: … 1080x1920", "square: … 1080x1080" (ffprobe size, audio, duration within 0.5 s of the plan) |
| 15 | `keepSourceRecording: false` | ✅ | pipe "scenario 12: keepSourceRecording false > …" (6 tests: verified-only deletion; failed export, unreadable output, length mismatch, library write failure and cancel keep the source) |
| 16 | Quit during export | ✅ | pipe "scenario 15: quit during export > the quit guard waits for the cancel…; it resumes once on the next start", "(defect) a quit blocked by a failed library flush leaves Auto montage working…"; hooks "quit guard > …" |
| 17 | Re-analysis with a montage | ✅ (new) | pipe "scenario 13: re-analysis of a match that already has a montage > a forced re-analysis merges clips per mergeOnReanalyze and its 'analyzed' event builds no second montage" |
| 18 | Settings migration | ✅ | pipe "scenario 14: settings migration from an old settings file > an old file gets the Auto montage defaults (off), nothing else changes, the file is not rewritten and no job is made"; `src/main/settings.test.ts` "auto montage settings > old files get the off-by-default settings and nothing else changes" |

## Auto edit

| Check | Status | Evidence |
|---|---|---|
| Planner target length ±1 s | ✅ (new) | `src/shared/autoEditPlan.test.ts` "target length > long match: {30,60,180} s {clean,cinematic,hype,shorts} lands within ±1 s" and "short sources: …" (24 cases) |
| Multikill never split | ✅ (new) | `src/shared/autoEditPlan.test.ts` "windows > never splits a multikill, even when the target is short" |
| Schema v1→v2 migration | ✅ | `src/shared/autoEdit.contract.test.ts` "project schema v2 > new projects are v2, v1 migrates and stays valid, newer is unsupported" |
| Clean / Hype real FFmpeg renders within ±1 frame | ✅ (new) | `src/main/export/montage-render-real.test.ts` "Clean: plain cuts at the planned length", "Hype with music: …" (each asserts ffprobe video length within 1/60 s + 1 ms of `planTotalSec`, 60 fps); also `montage-plan.test.ts` "segment layout > {clean,hype,…}: segment lengths sum to the planned total and frames land within half a frame" |
| Dip and caption at planned times | ✅ (new) | `montage-render-real.test.ts` "Hype with music: white dip at the cut, green caption in its window, …" (frame brightness before the cut, caption colour inside its window and absent before it); `montage-plan.test.ts` "places dips across the cut…" |
| Music ducking measured | ✅ (new) | `montage-render-real.test.ts` "Hype with music: … music ducked under game audio" (1 kHz Goertzel power, quiet section > 4× loud section); `montage-audio.test.ts` "mixer > ducks the music to about 30 % while the game is loud and recovers after the release" |
| Shorts 1080×1920 | ✅ (new) | `montage-render-real.test.ts` "Shorts renders 1080×1920" |

## Contract

- Exported signatures since `8277f51`:
  - `shared/montage.ts`: no exported signature changed; `selectMontageClips` body changed again in `c3d01b5` (skipped-clip rejection; allowed exception).
  - `shared/autoEdit.ts`: only the `60604de` changes (allowed) plus the additive `AUDIO_SILENT_WHEN_SPEED_CHANGED` from the same commit.
  - `shared/highlightScore.ts`, `shared/autoEditProject.ts` (exports): unchanged.
  - **`renderer/editor/project.ts`: changed.** `bd32d23` added an optional field `presetId?: PresetId | 'source'` to the exported `ProjectStyle` interface (`app/src/renderer/editor/project.ts:41-42`). The change only adds a field and type-checks, but it is not one of the listed exceptions. Needs the lead's sign-off.
  - `shared/autoEditPlan.ts`: `planAutoEdit` signature unchanged; new exports `AUTO_EDIT_WARNING_SHORT` / `AUTO_EDIT_WARNING_LONG` (additive; file is not on the frozen list).
- IPC: `MONTAGE_CHANNELS` and `montage-ipc.ts` unchanged since iteration 1; `open`/`retry`/`cancel` still guarded by `sanitizeMontageJobId` (`ipc-guards.ts:95`). New channel `autoEdit:selectMusic` (`ipc-handlers.ts:452`) takes no renderer arguments (native dialog). The styled `export:start` path validates v2 fields with `validProjectItemStyle`/`validProjectStyle`, copies only known fields, and checks the music path with `isSafeLocalDirPath` + extension whitelist + `stat().isFile()` (`export-ipc.ts`, `validateProjectStyle`); covered by `montage-ipc.test.ts` "rejects invalid v2 fields and unsafe or missing music".
- i18n: `tr-keys.test.ts`, `english-default.test.ts`, `i18n/catalog.test.ts` pass in the `test:fast` run (no failures outside the 4 baseline files).

## Invariants

| Invariant | Result |
|---|---|
| Recording never paused/awaited/delayed | Holds. Iteration-1 finding 1 fixed in `c3d01b5`: `pump()` now yields with `setImmediate` before `processJob` (`montage-service.ts:192-193`), so the cache read no longer runs inside finalization; pipe scenario 8 tests this. Remaining (negligible): `onMatchRecorded` still writes `jobs.json` synchronously (`montage-job.ts:182`). |
| One montage per match | Holds (`montageJobId`, idempotent `store.create`, `library.hasMontage`); rec scenario 2/11, pipe scenario 13. |
| Source deleted only after verified export | Holds (`montage-service.ts`, removal after verify + `addMontage` + `done`); pipe scenario 12. |
| No network | Holds: no fetch/http/WebSocket/`net` in added main/preload lines. The caption renderer (`export/montage-text.ts:126-157`) is a hidden, sandboxed offscreen window loading a `data:` page with the font inlined and the text HTML-escaped. |
| `autoMontage.enabled` defaults to false | Holds (`shared/montage.ts:54`). |
| FFmpeg filters within the allowed list | Holds. `export/montage-plan.ts:18-22` `ALLOWED_FILTERS` equals the spec list exactly; graphs in `montage-plan.ts:358-469` use setpts/fps/crop/scale/drawbox/overlay/format/atrim/aresample/aformat/volume/anullsrc/color + the reframe filters; `concat` is the demuxer (`-f concat`), not the filter. `montage-plan.test.ts` "uses only filters of the pinned FFmpeg build in every job" passes. `plan.ts:89` `noise` remains a pre-existing bitstream filter. |

## Findings

Iteration-1 findings 1 (sync cache read in finalization), 2 (`mergeOnReanalyze` unused) and 3 (no low-disk notice) are fixed in `c3d01b5` and covered by passing tests (pipe scenarios 4, 8, 13).

1. Contract: `ProjectStyle.presetId?` added in `bd32d23` (`renderer/editor/project.ts:41-42`). It only adds a field, but it is outside the listed exceptions.
2. Low (tests, cosmetic): `montage-recording.scenario.test.ts` titles render as "a remake with one kill → skipped([object Object])" and "a remake with no kills → skipped()"; the `it.each` title placeholder does not print the skip reason.
3. Low (test stability): under full-suite load, run 1 of `test:fast` had 6 extra timeouts: `engine.test.ts` (3), `queue.test.ts` (1), `obs-session.test.ts` (1), `live-session.test.ts` "does not duplicate a match start after the engine restarts mid-match…" (13.6 s, "Timed out waiting for test condition"). All passed in isolation and in run 2. Machine was shared with other agents.

## Regressions

None. `test:fast` run 2 failures are exactly the 18 baseline tests; the 6 run-1 timeouts did not reproduce (finding 3). The coordinator-reported 6 e2e failures (zh-TW text expectations, outside `montage.spec.ts`) are pre-existing.
