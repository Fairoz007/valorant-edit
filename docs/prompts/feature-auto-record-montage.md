# Prompt: Auto-record → auto-analyze → auto-montage after every VALORANT match

Copy everything below the line into a new Claude Code session opened at the repository root (`D:\valorant-edit`).
Work through the phases in order and do not skip a phase.

---

You are working on **Valorant Editor**, an Electron + React + TypeScript desktop app with a Rust analysis engine
(`engine/`) and a Rust recorder (`recorder/`, `aditorrec.exe`). It is a fork of Aditor. Windows 10/11 only for
recording.

## The feature

When a VALORANT match starts, the app records it automatically. When the match ends, the app analyzes the
recording and **automatically builds and exports a highlight montage** of that match — no user action needed.
The montage is controlled by a new **"Auto montage"** option that lives **in the Recording settings** (and is
visible in the recording panel), not in Studio.

End-to-end flow that must work:

1. VALORANT launches → recorder starts (`recording.autoRecord`, already exists).
2. A match starts → match boundary detected (Riot Client local API in `recording/valorant-client.ts`, live engine
   scene detection in `recording/live-session.ts`).
3. The match ends → the per-match file is finalized to MP4 (`recording/finalize.ts`) and added to the library.
4. The match is analyzed: either the **trusted live cache** is used (`LiveAnalysisSummary.trusted`) or a full
   analysis is enqueued (`AnalysisQueue` in `main/queue.ts`).
5. **New:** once analysis results exist for that match, if Auto montage is on, run the engine's `autoclip`
   command (see `main/hl.ts` for how it is called) with the montage parameters, pick and order the clips, and
   export one montage file via the existing export pipeline (`main/export/plan.ts` `buildJobs()`,
   `main/export/run.ts` `runExport()`), using the chosen format preset (16:9, 9:16 Shorts/TikTok/Reels, 1:1 —
   `shared/exportPresets.ts`, `shared/reframe.ts`).
6. **New:** the user gets a notification ("Montage ready — 6 clips, 0:48") through `notify` / tray, the montage
   appears in the library linked to its source match, and clicking it opens the montage project in Studio so it
   can be edited and re-exported. The AI clips stay normal `suggested`/`accepted` clips (`shared/clips.ts`), so
   re-analysis keeps working (`mergeOnReanalyze`).

Correctness comes first. A montage that cuts the wrong moments, exports a broken file, blocks the next match's
recording, or eats the disk is a failure. **Never claim a test passed unless you ran it and saw it pass.**

## Settings to add (in `RecordingSettings`, `app/src/shared/recording.ts`)

Add one nested object, validated in main (`main/settings.ts`, `ipc-guards.ts`) with a migration for old settings:

```ts
autoMontage: {
  enabled: boolean            // default false (opt-in; it uses GPU/CPU after each match)
  formatPreset: ExportPresetId // reuse shared/exportPresets.ts ids; default the 16:9 YouTube preset
  minClips: number            // don't export a montage with fewer clips (default 2, range 1..10)
  maxDurationSec: number      // cap total length (default 90, range 15..300)
  include: { multiKills: boolean; aces: boolean; clutches: boolean; singleKills: boolean } // what counts as a highlight
  timing: 'afterEachMatch' | 'afterGameExit' // default afterEachMatch; afterGameExit queues and runs when VALORANT closes
  keepSourceRecording: boolean // default true; if false, delete the per-match source after a successful export (ask: confirm dialog on first enable)
  outputDir: string | null    // null = `<storageRoot>/Montages/<date>/` (see shared/storage.ts)
}
```

Interaction rules:
- Auto montage requires analysis. If `postAnalysis === 'none'`, enabling Auto montage must either switch it to
  `perMatch` (after telling the user) or be disabled with an explanation. Pick one, document it, test it.
- While the game is running and recording, montage work must not hurt the recording: encode at low priority, prefer
  the hardware encoder **not** in use by the recorder, or defer to `afterGameExit` when the live complexity / GPU
  budget says so (see `docs/recording-gpu-cost.md`, `recording/live-complexity.test.ts`).
- One montage per match. Idempotent: crash/restart recovery (`recording/recovery.ts`, `finalized.json` markers in
  `finalize.ts`) must not produce duplicates and must resume a montage that was queued but not exported.

## Phase 0: Prepare

1. `git status`. There is an untracked `package-lock.json` at the repo root; leave it alone and ask me about it.
   Do not mix unrelated changes into this feature.
2. Branch from `main`: `git switch -c feature/auto-montage`.
3. `cd app && npm ci`, then record a **baseline**: `npm run typecheck`, `npm run lint`, `npm run test:fast`.
   Write down tests that already fail so you neither blame nor hide them.
4. Make sure the engine is built (`../scripts/build.ps1 -EngineOnly`) and FFmpeg is available
   (`scripts/fetch-ffmpeg.ps1`). If either is missing, say so at the end — never skip real tests silently.

## Phase 1: Read and understand (lead only)

- `docs/VALORANT-EDITOR-AUDIT.md`, `docs/superpowers/specs/2026-10-18-live-recording-design.md`,
  `docs/prompts/feature-vertical-export.md` (how the last feature was split).
- Recording: `main/recording/index.ts` (`RecordingDeps` — `enqueueAnalysis`, `onLiveAnalysis`, `notify`,
  `onGameExit`), `session.ts`, `finalize.ts`, `live-session.ts`, `live-cache.ts`, `valorant-client.ts`,
  `obs-session.ts` / `obs-finalize.ts` (OBS backend must also trigger montages), `recovery.ts`, `disk.ts`.
- Analysis: `main/queue.ts` (`AnalysisQueue` events), `engine.ts`, `hl.ts` (`autoclip` request),
  `reanalysis.ts`, `cache-io.ts`.
- Export: `main/export/plan.ts`, `run.ts`, `export-ipc.ts`, `encoders.ts`, `killTree.ts`, `shared/exportPresets.ts`,
  `shared/reframe.ts`, `shared/exportEstimate.ts`.
- Projects/library: `main/projects.ts`, `project-ipc.ts`, `library.ts`, `renderer/editor/project.ts`.
- UI: `renderer/settings/RecordingControl.tsx`, `recordingOptions.ts`, `rows.ts`, `renderer/shell/RecordingPanel.tsx`,
  `useRecordingStatus.ts`, i18n in `renderer/i18n/<locale>/recording.ts` and `shared/messages/`.
  `english-default.test.ts` and `tr-keys.test.ts` must stay green.
- `main/index.ts`: where the recording service, queue and export are wired together; `quit-guard.ts` (quitting during
  a montage export).

Then write a short plan into `docs/superpowers/plans/auto-montage.md`: the state machine for one match
(`recorded → analyzing → selecting → exporting → done | skipped(reason) | failed(reason)`), where it is persisted,
and the exact public contract below.

## Phase 2: Contract (lead, before any subagent starts)

Create and unit-test these yourself so every subagent codes against the same API:

- `app/src/shared/montage.ts`
  - `AutoMontageSettings` type, defaults, `MONTAGE_RANGES`.
  - `MontageJobState` (the state machine above) and `MontageStatus` for IPC.
  - Pure function `selectMontageClips(events, clips, settings): { clips: Clip[]; totalSec: number; skipped?: 'tooFew' | 'empty' }`
    — signature only plus trivial tests; subagent C implements the real logic.
- New IPC channel names (`montage:status`, `montage:open`, `montage:retry`, `montage:cancel`) in the preload contract
  (`preload/index.ts`, `renderer/global.d.ts`) with guards in `ipc-guards.ts`.
- New `RecordingDeps` hook: `onMatchAnalyzed?(videoPath: string, game: GameId)` fired exactly once per match when
  analysis results (live-trusted or full) are on disk.

Commit the contract on the branch before spawning subagents.

## Phase 3: Subagents — each owns a different scenario

You are the **lead agent**. Spawn the subagents below with the Agent tool. A, B and C run **in parallel in one
message**, each with `isolation: "worktree"`. D starts when A is merged; E starts when A + C are merged. File
ownership is strict: no two subagents edit the same file. If one needs a change outside its files, it reports it
back and the lead makes it.

| Agent | Scenario it owns | Files it owns |
|---|---|---|
| **A. Pipeline orchestrator** | The happy path: match end → analysis done → montage job queued → autoclip → export → library + notify. Persistence of job state next to `finalized.json`, idempotency, resume after restart, `afterEachMatch` vs `afterGameExit`, low-priority encoding while the game runs, cancel on quit (`quit-guard.ts`). Works for both builtin and OBS backends and for live-trusted and full-analysis paths. | new `app/src/main/montage/**` (`montage-service.ts`, `montage-job.ts`, `montage-ipc.ts`), the `onMatchAnalyzed` call sites in `recording/finalize.ts` / `queue.ts`, wiring in `main/index.ts`, `shared/messages/**` montage keys, their tests |
| **B. Settings & recording UI** | The user's view: Auto montage section in Recording settings (toggle, format preset picker reusing export preset cards, min clips, max length, include-types, timing, keep source, output folder), the `postAnalysis === 'none'` rule, first-enable confirmation for deleting sources, a status line in `RecordingPanel` ("Building montage… 62%", "Montage ready", "Skipped: only 1 kill"), retry/open buttons, a11y and all 5 locales (English must be real text; others may fall back to English but must exist). | `renderer/settings/RecordingControl.tsx`, `recordingOptions.ts`, `rows.ts`, `renderer/shell/RecordingPanel.tsx`, `useRecordingStatus.ts`, `renderer/i18n/*/recording.ts`, `main/settings.ts` migration + `settings.test.ts` additions, their tests |
| **C. Montage composition** | Picking *what* goes in: implement `selectMontageClips` — rank by highlight value (ace > 4k > 3k > clutch > 2k > single), merge overlapping/adjacent clips, keep chronological order, respect `maxDurationSec` by dropping lowest-value clips (never cutting a multi-kill in half), pre/post-roll from `settings.autoclip`, dedupe against existing accepted/manual clips, and build the montage `Project` (project track items) that export and Studio both accept. Edge cases: 0 kills, only deaths, 1 kill below `minClips`, a 25-kill stomp that overflows the cap, kills at second 0 / last second, overtime matches. | `app/src/shared/montage.ts` (implementation only — contract signatures fixed), new `app/src/shared/montageProject.ts`, their tests |
| **D. Failure & edge scenarios** | Everything that goes wrong, as tests plus fixes reported back to A: match cancelled/remake (`matchCancel`), game crash mid-match, app crash mid-export then restart (no duplicate, resume), disk below `diskWarnGb`/`diskStopGb` (skip montage, keep recording), no hardware encoder (OpenH264 fallback / clear error), analysis failure, engine timeout, user opens the same match in Studio while the montage exports (`editorLock`), next match starts while previous montage still exporting (recording must win), auto montage toggled off mid-job, source deleted by user, OBS backend reconnect, `keepSourceRecording: false` only deletes after a verified good export. | new `app/src/main/montage/*.scenario.test.ts`; findings and minimal fix proposals go back to the lead |
| **E. Real end-to-end** | Proof it actually works with real binaries: use `e2e/helpers/makeFixtures.ts`, the fake/live engine fixtures in `recording/__fixtures__/`, and the reference clip used for kill/death recall. Drive recorded file → finalize → analysis → montage → real FFmpeg export; `ffprobe` the output for duration (±0.5 s of the plan), resolution matching the preset (1920×1080, 1080×1920, 1080×1080), audio present, decodable start to end. One Playwright test (`app/e2e/`) for the settings toggle and the panel status. | new `app/src/main/montage/montage-real.test.ts`, new `app/e2e/montage.spec.ts` |

Subagent rules:
- Each brief is complete: the feature summary, the contract from Phase 2 (paste the signatures), its scenario, the
  files it owns, the files it must not touch, the tests it must add, and the commands to run
  (`npm run typecheck`, `npx vitest run <its tests>`, `npm run lint`).
- Subagents never commit to `feature/auto-montage`, push, or open PRs. Only the lead merges worktree branches and
  does git work.
- Each final report lists: files changed, tests added, exact commands run with pass/fail counts, and anything not
  done. A report is a claim — the lead reviews the diff and re-runs the tests before accepting it.
- If work fails review, send it back to the **same** subagent (SendMessage) with the specific problem.

## Phase 4: The looping verifier agent (optional, recommended)

In addition to A–E, run a **verifier** that keeps checking the work while it is being built. Offer me the choice
at the start of Phase 3: **(1) looping verifier on** (default) or **(2) verify once at the end**.

If on, start it with `/loop` (self-paced) or as a background Agent that re-runs on each subagent completion, with
this brief:

> You are the verifier for the auto-montage feature on `feature/auto-montage`. You do not write feature code.
> Each iteration:
> 1. Pull in whatever the lead has merged. Run `npm run typecheck`, `npm run lint`, `npm run test:fast`, and the
>    montage tests (`npx vitest run src/main/montage src/shared/montage`). Compare to the Phase 0 baseline.
> 2. Walk the **scenario matrix** below and mark each row ✅ covered by a passing test / ❌ failing / ⬜ no test yet,
>    with the test name as evidence. A row is only ✅ if you saw that test pass this iteration.
> 3. Check the contract: no subagent changed a Phase 2 signature; no two agents edited the same file
>    (`git diff --stat` per merged branch); every new IPC field is guarded in `ipc-guards.ts`; every new string is in
>    the English catalog.
> 4. Check invariants by reading the code: recording is never paused or delayed by montage work; one montage per
>    match; source files are never deleted before a verified export; nothing is uploaded or sent off the machine.
> 5. Write the matrix and any regressions to `docs/auto-montage-verification.md` and send the lead a short message
>    naming only what changed since the last iteration (new ❌, new ✅).
> Stop looping when every row is ✅ for two iterations in a row and the full suite matches the baseline, or when the
> lead tells you to stop. Never mark something passing that you did not run.

Scenario matrix (the verifier's checklist, also the lead's definition of done):

| # | Scenario | Expected |
|---|---|---|
| 1 | Normal competitive match, builtin recorder, Auto montage on | One montage exported, notified, in library, opens in Studio |
| 2 | Same, OBS backend | Same as 1 |
| 3 | Live-trusted analysis (no full analysis queued) | Montage uses live cache, no re-analysis |
| 4 | Full analysis path (`postAnalysis: perMatch`) | Montage after the queue finishes that match |
| 5 | `timing: afterGameExit`, 3 matches in a row | 3 montages after VALORANT closes, none during play |
| 6 | Auto montage off | Recording + analysis unchanged from today, no montage |
| 7 | Match with 0–1 kills | Skipped with reason shown, no file written |
| 8 | Huge match exceeding `maxDurationSec` | Capped, highest-value clips kept, multi-kills intact |
| 9 | Remake / match cancelled | No montage |
| 10 | App crash during export, restart | Job resumes, exactly one montage, no `.partial` left behind |
| 11 | Next match starts during export | Recording starts on time; export continues at low priority or pauses |
| 12 | Low disk | Montage skipped with notice, recording protected |
| 13 | No hardware encoder | Falls back or fails with a clear message, recording unaffected |
| 14 | Each format preset (16:9, 9:16, 1:1) | ffprobe size/duration correct |
| 15 | `keepSourceRecording: false` | Source deleted only after verified export; failed export keeps it |
| 16 | Quit during export | Quit guard asks; export cancelled cleanly or finished |
| 17 | Re-analysis of a match that already has a montage | Clips merge per `mergeOnReanalyze`; montage not duplicated |
| 18 | Settings migration from an old settings file | Defaults applied, nothing else changed |

## Phase 5: Integrate and verify (lead)

1. Merge A, B, C, then D's fixes, then E, resolving conflicts yourself.
2. Run the full suite: `npm run typecheck`, `npm run lint`, `npm run test:fast`, the real tests, and the e2e test.
   Report exact pass/fail counts against the baseline.
3. Run the app (`npm run dev`) and, if VALORANT is not available, simulate a match with the fake engine fixture;
   take screenshots of the settings section, the panel status and the resulting montage in Studio.
4. Every row of the scenario matrix must be ✅ with a named test, or explicitly listed as not verified with the reason.

## Phase 6: Docs and git (lead)

- Update `README.md` (feature table: "Auto montage"), `CHANGELOG.md`, and the audit's feature-gap table.
- Commit in logical pieces (contract, pipeline, composition, UI, tests, docs). Ask me before pushing and before
  opening the PR against `main`. The PR description includes the scenario matrix and the test counts.

## Constraints

- Everything stays local: no uploads, no cloud, no game memory reading or injection — only the Riot Client local API
  and on-screen pixels, as today.
- GPL-3.0: keep existing copyright notices.
- Apex support inherited from Aditor must keep working (montage may be VALORANT-only; say so in the UI if so).
- Do not change recording defaults other than adding `autoMontage` (default off).
