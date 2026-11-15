# Plan: Auto montage after each match + Auto edit styled montages

Branch `feature/finish-montage-autoedit`. Specs: `docs/prompts/feature-auto-record-montage.md` (Auto montage, Phases 3–6)
and `docs/prompts/windows-all-in-one.md` Phase 2B (Auto edit). Contract: `app/src/shared/montage.ts`,
`app/src/shared/montageProject.ts`, and (new) `app/src/shared/autoEdit.ts`.

## 1. Auto montage job state machine (one job per recorded match)

```
recorded ──► analyzing ──► selecting ──► exporting ──► done
   │             │             │             │
   │             └─────────────┴─────────────┴──► skipped(reason) | failed(code)
   └──► deferred (timing afterGameExit, GPU budget, or a new match started during export) ──► selecting
any non-terminal ──► cancelled (user cancel, Auto montage turned off, quit)
```

- `recorded`: `onMatchRecorded(path, game)` after the per-match file is finalized and in the library.
- `analyzing`: waiting for analysis results. Leaves on `onMatchAnalyzed` (trusted live cache, no full analysis) or the
  new `AnalysisQueue` `'analyzed'` event (full analysis finished, not cancelled).
- `selecting`: read the cache, run engine `autoclip` (`hl.ts`) with `settings.autoclip`, then `selectMontageClips()`.
  `skipped('tooFew' | 'empty' | 'lowDisk' | 'notValorant' | 'sourceMissing')` ends here.
- `exporting`: `buildMontageProject()` → `ProjectStore` → `buildJobs()` (concat, precise, preset format) → `runExport()`
  writing `.partial.mp4` then publishing. The encoder runs at below-normal priority while VALORANT runs.
- `done`: the output is verified (ffprobe duration within ±0.5 s of the plan, video + audio streams), the library
  entry is added (`source: 'montage'`, `montage: { sourcePath, projectId, jobId }`), and the user is notified. Only after
  that, and only when `keepSourceRecording === false`, the source recording is deleted.
- Terminal states (`done | skipped | failed | cancelled`) are never re-entered automatically. Only `montage:retry`
  moves `skipped | failed | cancelled` back to `selecting`.

## 2. Persistence and idempotency

- `<appData>/montage/jobs.json` (atomic tmp + fsync + rename, the same pattern as `projects.ts`). Job id =
  `montageJobId(sourcePath)`, so the same match never gets two jobs, even when `addRecorded` re-runs on retry or recovery.
- On startup: jobs in `selecting` or `exporting` go back to `selecting`, `attempts + 1`, and a leftover
  `.partial.mp4` is deleted. `recorded` / `analyzing` jobs are checked against the library status: done → `selecting`.
- A match from `recoverSessions()` fires `onMatchRecorded` again; the existing job is kept.

## 3. Hook call sites (agent A)

| Hook | Where |
|---|---|
| `onMatchRecorded` | `finalize.ts` `completeCut` after `addRecorded` (~:342), `finalizeSession` (~:605); `obs-finalize.ts` `finalizeObsSession` (~:186), `finalizeObsMatches` (~:260) |
| `onMatchAnalyzed` | the same functions, only when the live cache is trusted and no full analysis was queued |
| `AnalysisQueue` `'analyzed'` | `queue.ts` after the library update for a finished run (~:255); not for cancelled runs |
| `onGameClosed` | `session.ts` next to the `onGameExit` call (~:189), on every running→closed change |
| quit | `quit-guard.ts` early task `cancelMontage` (cancel and wait for the export, which kills the ffmpeg tree) |
| wiring | `main/index.ts` `initEngineAndServices`: create the montage service, pass the hooks to `createRecordingService`, `registerMontageIpc` |

## 4. Rules

- `postAnalysis === 'none'` + Auto montage on → stored as `perMatch` (`postAnalysisForMontage`); the UI says so before
  saving, and main enforces it on every settings write.
- Recording wins: a match starting while a montage exports moves the export to below-normal priority (or `deferred`
  when the GPU budget says so); recording is never delayed. One export at a time, separate from the UI export slot.
- Low disk: skipped with `lowDisk` before exporting; recording is never touched.
- Nothing leaves the machine.

## 5. Auto edit (manual, styled montage)

`app/src/shared/autoEdit.ts` (lead contract):

- `MontageStyle = 'clean' | 'cinematic' | 'hype' | 'shorts'` and `STYLE_PRESETS` (data: transitions, duration,
  overlays, slow-mo, zoom punch, flash, music/ducking, beat sync, letterbox, intro/outro, preset id, max length).
- `AutoEditOptions` (sources in recording order, `targetSec | 'all'`, `order: 'chronological' | 'buildUp'`,
  `includeDeaths`, `musicPath`, `presetId`, `style`, `weights`).
- `AutoEditPlan` / `AutoEditClip` (source, in/out, speed, audio gain, effects, overlay text, score).
- `planAutoEdit(sources, options) → AutoEditPlan`. It shares one scoring core (`scoreHighlight`, `highlightWindows`) with
  `selectMontageClips()`, so there is one ranker.
- Project schema v2: `ProjectItem` gains optional `speed`, `gain`, `effects`, `overlay`; `Project` gains optional `style`
  and `music`. `projectShapeError` accepts v1 and v2; `migrateProject` turns v1 into v2 without changing items.

Renderer: Auto edit dialog in Studio and on the Library selection bar (agent G). Render: a montage filter-graph stage
after the reframe stage in `export/plan.ts` (agent F): `xfade` transitions, `drawtext` overlays (bundled open-licence
font), `setpts` / `atempo` slow-mo, zoom punch, `sidechaincompress` ducking, simple onset beat sync, intro/outro.

Library: a montage entry (`source: 'montage'`) gets its own badge and filter and opens its project in Studio. It
must not count as "Imported", and deleting it must not ask the imported-source question (agent G:
`VideoCard.tsx`, `lib/libraryFilter.ts`, `LibraryScreen.tsx`).

## 6. Tests

- Contract: `coerceAutoMontage`, `postAnalysisForMontage`, `montageJobId`, `sanitizeMontageJobId`, `autoEdit` planner
  core, project v1→v2 migration.
- C: selection ranking, merge, cap, edge cases (0 kills, only deaths, below `minClips`, 25-kill stomp, second 0 / last
  second, overtime).
- A: service state machine, persistence/resume, IPC. D: `*.scenario.test.ts` per failure scenario. E: real FFmpeg per
  preset + Playwright. F: filter-graph strings and real Clean/Hype renders. G: dialog/component tests.
- Scenario matrix: `docs/auto-montage-verification.md` (verifier).
