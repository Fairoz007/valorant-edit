# Prompt: Valorant Editor on Windows — detection + auto-edit montage + vertical export + Windows readiness

This merges `fix-full-kill-death-detection.md`, `feature-vertical-export.md`, the checklist in
`docs/windows-compatibility-review-request.md`, and a new **auto-edit** feature (detected clips → cut → one finished
full video) into one prompt for a **Windows 10/11** machine. The separate Windows thumbnail/playback bug has its own
prompt: `fix-library-thumbnails-playback-windows.md` (run that one first if the library shows broken thumbnails).

Copy everything below the line into a new Claude Code session opened at the repository root (`D:\valorant-edit`).
Work through the phases in order and do not skip one.

---

You are working on **Valorant Editor**, an Electron + React + TypeScript desktop app with a Rust analysis engine
(`engine/`, binary `aditor.exe`) and a Rust recorder (`recorder/`), forked from Aditor. The machine is **Windows**:
use PowerShell syntax (`$env:NAME = 'x'`, `;` instead of `&&` in Windows PowerShell 5.1), backslash-safe paths, and the
scripts in `scripts\*.ps1`.

Your job has five parts, all required:

1. **Detection:** for any VALORANT clip, at any resolution or quality, find **every** kill the player makes and
   **every** death the player suffers, with **no** false events.
2. **Auto-edit:** one click turns the detected events of one video — or many videos (e.g. a day of 20 s recorder
   clips) — into a finished **full montage video**: smart cuts around each kill, dead time removed, ordered, with
   transitions, text overlays, slow-mo/zoom, music with ducking, intro/outro, style presets and a target length,
   fully editable afterwards on the timeline.
3. **Export:** accurate aspect-ratio reframing (9:16, 1:1), platform presets and H.265 export, with a redesigned export
   drawer and an app-wide UI polish pass.
4. **Windows readiness:** verify the whole thing builds, runs and exports correctly on Windows 10/11.
5. **Commit and push** the finished, verified work to GitHub (`https://github.com/Fairoz007/valorant-edit`).

Correctness comes first. A feature that looks done but misses kills, exports the wrong size or crop, or produces a
broken file is a failure. Never report a number you did not measure, never claim a test passed unless you ran it and
saw it pass, and never fake or simulate detection.

## Work split: use subagents

You are the **lead agent**. Do the steps everything else depends on yourself, hand independent pieces to subagents
(Agent tool) running in parallel, then integrate, verify and push yourself. Keep the total under about 10 agents.

| Step | Who | When | Owns (no one else edits these) |
|---|---|---|---|
| Phase 0 prepare, Phase 1 read + plan | Lead | first, alone | – |
| Detection rules in `engine/src/valorant/feed.rs`, `tracker.rs`, `profile.json` version | Lead | Phase 2 | those files |
| **Labeler** (one per clip) | Subagent | Phase 2, parallel | `tools\labels\<clip>.json` |
| **Miss investigator** (one per group of misses) | Subagent | Phase 2, parallel, **own worktree** | nothing in the shared tree |
| Export **contract**: `app/src/shared/reframe.ts` (`computeReframe`, `reframeFilter`), `app/src/shared/exportPresets.ts`, new option types in `shared/settings.ts`, with unit tests | Lead | before A/B/C start | those shared files |
| **A. Export backend**: `plan.ts`, `encodeQuality.ts`, `encoders.ts` (HEVC), `run.ts`, `export-ipc.ts`, `ipc-guards.ts`, `main/settings.ts` migration, `tr()` messages + tests | Subagent | parallel | `app/src/main/**`, `app/src/shared/messages/**`, `shared/encodeQuality.ts` |
| **B. Export drawer UI**: preset cards, live crop preview, sections, summary line, `PlayerStage` overlay, export i18n keys, `ExportDrawer.test.ts` | Subagent | parallel | `renderer/studio/ExportDrawer*`, `exportApi.ts`, `PlayerStage.tsx`, `styles/exportDrawer.css`, `renderer/i18n/*/` export keys |
| **C. App-wide UI polish** (CSS only, no behaviour) | Subagent | parallel | `styles/tokens.css`, `base.css`, `library*.css`, `studio.css`, `settings.css`, `shell.css`, `timeline.css` |
| **D. Real FFmpeg export tests** | Subagent | after A | `app/src/main/export/*real*.test.ts` |
| Auto-edit **contract**: `app/src/shared/montage.ts` (`MontagePlan`, `MontageClip`, `MontageStyle`, `planMontage()`), style preset table, project-file schema version bump, with unit tests | Lead | after A's `plan.ts` changes land | those shared files |
| **E. Auto-edit planner + render**: `planMontage()` implementation, `engine/src/autoclip.rs` / `mixtape.rs` scoring hooks, montage effects filter-graph stage in `plan.ts` (after A), music/ducking, overlays, real FFmpeg montage tests | Subagent | after contract | `app/src/main/export/montage*.ts`, `engine/src/autoclip*.rs`, `engine/src/mixtape.rs`, `templates/montage/**` |
| **F. Auto-edit UI**: "Auto edit" button/dialog in Library (multi-select) and Studio, style cards, target length, music picker, preview, timeline effect badges, i18n | Subagent | after contract, parallel with E | `renderer/studio/AutoEdit*`, `AutoClipPopover.tsx`, `renderer/library/` selection bar, `styles/autoEdit.css`, `renderer/i18n/*/` auto-edit keys |
| **False-positive reviewer** | Subagent | Phase 4 | – (returns a table) |
| **Windows reviewer** (read-only) | Subagent | Phase 4 | – (returns findings) |
| Integration, full verification, docs, commits, push, PR | Lead | last, alone | docs, git |

Rules for subagents:

- Give each one a complete brief: goal, contract (paste signatures of `computeReframe`, `reframeFilter`, the preset
  table and option types where relevant), files it owns, files it must **not** touch, tests to add, and exact
  PowerShell commands to run. They know nothing about this conversation.
- File ownership is strict. If a subagent needs a change outside its files, it reports it back; the lead makes it.
- Launch parallel subagents in a single message. Use `isolation: "worktree"` where files could overlap, then merge
  their branches yourself.
- Subagents never commit to the feature branch, push or open PRs. Only the lead does git work.
- A subagent's report (files changed, tests added, exact commands with pass/fail counts, anything unfinished) is a
  claim, not proof: review the diff and re-run the tests yourself. If it fails review, send it back to the same
  subagent (SendMessage) with the specific problem.

## Phase 0: Prepare (Windows)

1. `git status` and `git log --oneline -10`. **Some of this work may already be on `main`** (earlier PRs added
   `lone_chevron` detection, `tools\labels\videoplayback.json`, `tools\evaluate_valorant.py`, reframing, presets and
   H.265). For every requirement below, first check whether it already exists and passes; only implement or fix what
   is missing or wrong. If the tree has uncommitted changes, ask me whether to commit them first as their own commit.
2. Create a branch: `git switch -c feature/windows-detection-export`.
3. Toolchain check, and tell me what is missing instead of silently skipping:
   - Node 22 (`node -v`), Rust (`cargo -V`), Git, `gh` (`gh auth status`).
   - FFmpeg: `powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg.ps1`, then confirm
     `build\ffmpeg\bin\ffmpeg.exe -version` and `ffprobe.exe -version`.
   - Engine: `powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -EngineOnly`
     (produces `engine\target\release\aditor.exe` and `build\engine\aditor\aditor.exe`).
4. Install app dependencies: `cd app; npm ci`.
5. Record baselines and write down tests that already fail, so you neither blame nor hide them:
   - `cd engine; cargo test; cargo clippy`
   - `cd app; npm run typecheck; npm run lint; npm run test:fast`
   - Detection baseline on the reference clip:
     ```powershell
     $env:ADITOR_FFMPEG = "$PWD\build\ffmpeg\bin\ffmpeg.exe"
     .\engine\target\release\aditor.exe debug-valorant-feed videoplayback.mp4 --profile-dir templates\valorant\icons > $env:TEMP\baseline.jsonl
     ```
     The last line holds `events`; save kill/death counts and timestamps.

## Phase 1: Read and plan

Read before planning (send one Explore subagent to the engine + export pipeline and one to the renderer/styles, and
keep only their conclusions):

- `docs\VALORANT-EDITOR-AUDIT.md` (architecture, constraints, feature gaps, Phase 6 "Formats").
- Detection: `engine\src\valorant\feed.rs` (`FeedDetector::observations`, `boxes()`, `outline()`, `team()`,
  `chevrons()`, `lone_chevron()`), `tracker.rs`, `valorant_rounds.rs`, `round_highlights()`,
  `templates\valorant\icons\profile.json`, `tools\evaluate_valorant.py`.
- Export: `app\src\main\export\plan.ts` (`buildJobs()`, `resolveQuality()`, `buildPreciseConcat()`,
  `normalizeFilter()`), `app\src\shared\encodeQuality.ts`, `encoders.ts` (`pickEncoder()`, `testEncoder()`), `run.ts`,
  `export-ipc.ts`, `export-real.test.ts`, `app\src\main\ipc-guards.ts`.
- UI: `ExportDrawer.tsx`, `ExportDrawer.test.ts`, `exportApi.ts`, `PlayerStage.tsx`, `styles\exportDrawer.css`,
  `tokens.css`, `studio.css`.
- Auto-edit: `engine\src\autoclip.rs`, `autoclip_tests.rs`, `mixtape.rs`, `docs\accuracy-report-mixtape.md`,
  `renderer\studio\AutoClipPopover.tsx`, `HighlightsTab.tsx`, `HighlightCard.tsx`, `ProjectTrack.tsx`,
  `autoclipEstimate.ts`, `app\src\main\projects.ts` (project schema), audit section 3.2.
- Settings: `app\src\shared\settings.ts`, `app\src\main\settings.ts`. i18n: `app\src\renderer\i18n\<locale>\*.ts` and
  `tr()` with `app\src\shared\messages\<locale>.ts`; `english-default.test.ts` and `tr-keys.test.ts` must stay green.
- Windows: `docs\windows-compatibility-review-request.md`, `docs\windows-readiness-results.md`,
  `app\src\main\safe-path.ts`, `export\killTree.ts`, `quit-guard.ts`, `app\electron-builder.yml`.

Then show me a short plan (what already exists, files to change, new functions, test list, subagent ownership)
before implementing.

## Phase 2: Detection — every kill and death

### Background

- FFmpeg decodes the kill-feed crop (`BANNER_REF = [1316, 84, 600, 256]` in 1080p reference coordinates; row k is
  centred at y = 112 + 40k). `feed.rs` classifies rows, `tracker.rs` de-duplicates rows into events,
  `valorant_rounds.rs` handles rounds, `round_highlights()` makes multikills and aces.
- **Own kill:** player name left, ally **teal** background, **yellow outline**, yellow chevron at the **left** end.
- **Own death:** enemy (red) left, player right in teal, yellow outline, yellow chevron at the **right** end.
- Teammate rows (teal, no yellow) and enemy-vs-ally rows must **not** count.
- Root cause of misses: compressed/upscaled footage (e.g. 720p YouTube) blurs the thin yellow outline.
  `lone_chevron()` accepts a solid yellow chevron at the row's outer end when the player's half is teal; on the
  reference clip `videoplayback.mp4` (repo root, 720p, ~14 min) it gave 19 kills + 10 deaths, all verified real.
- Known hard case: a death ("Jett → Me") at ~**47.5 s** with a chevron only ~15 px tall (w = 10, x ≈ 580, y ≈ 20 in
  the banner crop). Check it is detected; if not, test a shorter death-side minimum (~14) — do not assume it works.
- Results are cached per video: bump `templates_version` in `profile.json` by one from its current value whenever
  detection output changes, and update code/tests that reference the old value.

### Steps

1. **Ground truth (no guessing).** For `videoplayback.mp4` and every other VALORANT clip I give you, a Labeler
   subagent writes `tools\labels\<clip>.json` (time ± 1 s, type) by sampling the kill-feed crop every 0.5 s with
   ffmpeg, making contact sheets and reading them — never from detector output. Ask me for 1080p native, 1440p,
   720p compressed, 60/30 fps and different HUD-scale clips if I haven't provided them. Do not invent footage.
2. **Evaluate.** Use `tools\evaluate_valorant.py` (run Python with `py -3 -I`) to print precision, recall, misses
   and extras per clip.
3. **Fix misses.** For each miss, a Miss investigator (own worktree) cuts a 6 s clip (`ffmpeg -ss T-3 -t 6`), adds
   temporary debug prints and finds the rejecting check (`boxes()`, `outline()`, `team()`, `chevrons()`, or a
   `tracker.rs` dedupe window). You apply the smallest rule change yourself, one at a time, re-running the evaluator
   after each.
4. Thresholds must scale with the banner crop (resolution-independent), not assume 1080p pixels.
5. Add a unit test that each new rule rejects: teammate rows, enemy-kills-ally rows, "Clove resurrect"-style ability
   rows, empty or partially faded rows.
6. Remove all debug prints. Bump `templates_version` if output changed.

## Phase 2B: Auto-edit — detected clips → one full montage video

Today: highlights and dense-kill auto-compilation exist (`engine/src/autoclip.rs`, `mixtape.rs`,
`renderer/studio/AutoClipPopover.tsx`, `HighlightsTab.tsx`) and concat export works. Missing (see the audit table
"3.2 Highlights, clips and editing"): event weights, per-clip speed/audio, effects, music, overlays, intro/outro,
presets, target duration. Build on what exists; don't duplicate it.

### 2B.1 Smart cutting

- For every detected event, build a clip window with **pre-roll / post-roll** (defaults from Settings → Editing,
  e.g. 3 s before the first kill, 1.5 s after the last). Kills closer than a merge gap (default 4 s) join into one
  clip so a multikill is never cut in the middle.
- Snap cuts to keyframes only in copy mode; in precise mode cut frame-accurately.
- Remove dead time: never include long stretches with no event (buy phase, walking) unless it is inside a merged
  window. Skip or shorten clips that end in the player's own death unless the user enables "include deaths"
  (option: keep deaths as funny/fail moments in a separate "Fails" montage).
- **Scoring** with user-editable weights (Settings → Auto edit): ace > 4k > 3k > 2k > single kill; bonus for kills in
  quick succession; penalty for duplicate-looking clips. Show the score on each highlight card.
- **Target length** (e.g. 30 s, 60 s, 3 min, "all"): pick the highest-scoring clips that fit, then order them
  (chronological by default, or "build-up": weaker first, ace last). Exact total ±1 s.
- **Multiple videos:** the user multi-selects cards in the Library (or "All videos from this day") and gets one
  project/montage across all of them, in recording order. Short recorder clips (the 20 s files) must work.

### 2B.2 Montage styling (FFmpeg filter-graph stage, LGPL-only, no new runtime deps)

- **Transitions** between clips: cut, crossfade (`xfade`), dip to black/white, quick zoom-blur; duration 0.2–0.6 s.
- **Text overlays** on events: "DOUBLE KILL", "TRIPLE KILL", "QUADRA KILL", "ACE" (and later CLUTCH when detected),
  plus optional player name / match info. Use bundled open-licence fonts (record licence in `THIRD_PARTY_NOTICES.md`),
  `drawtext` with proper escaping for Windows font paths.
- **Slow-mo / speed ramp** on the kill moment (e.g. 0.5× for 0.6 s around the final kill of a multikill) using
  `setpts`/`atempo`; **zoom punch** (`zoompan`/`crop`+`scale`) on the kill; optional flash.
- **Per-clip speed and audio level**; **music bed** from a user-chosen file with fade in/out and **ducking** under
  game audio peaks (`sidechaincompress`), and an optional **beat-sync** mode that snaps cuts to detected beats (simple
  onset detection is fine; document limits).
- **Intro/outro**: optional title card (text + colour/blur of the first frame) and end card.
- **Style presets** as data: `Clean` (cuts only), `Cinematic` (crossfades, slow-mo, music, letterbox),
  `Hype` (zoom punches, flashes, fast cuts, beat-sync), `Shorts` (9:16 crop from Phase 3, ≤60 s, big captions).
- Everything the auto-edit creates is a normal **editable project**: clips on the project track, effects shown as
  badges, user can reorder, trim, delete, change style and re-render; undo/redo works. Bump the project schema
  version and migrate old project files safely.
- Rendering uses the Phase 3 export pipeline (presets, reframing, H.264/H.265), shows progress and can be cancelled
  without leaving orphan FFmpeg processes or partial files.

### 2B.3 UI

- "Auto edit" button in Studio and on the Library selection bar → dialog: source videos, target length, style cards
  with a short animated preview, music file, include deaths, aspect/preset, then "Create". Result opens in Studio.
- Show an estimate (clip count, final length, size) before creating, reusing `autoclipEstimate.ts`/`exportEstimate.ts`.
- Clear empty state if no events were detected ("No kills found in the selected videos").

## Phase 3: Export — reframing, presets, H.265, UI

### 3.1 Reframing (must be exact)

- Output frame: `Source` (default, today's behaviour), `16:9`, `9:16`, `1:1`.
- Modes when aspect differs: **Crop** (default for 9:16 and 1:1; horizontal offset -1 left … 0 centre … 1 right,
  then scale), **Blurred background fit** (`split` → bg `scale`+`crop`+`gblur`/`boxblur` → `overlay`), **Black bars**
  (`pad`).
- All geometry in one pure function in `app\src\shared\reframe.ts`:
  `computeReframe(src: {width,height}, out: VideoSpec, mode, offset)` → integer crop rect / scaled size / pad
  position, plus `reframeFilter(...)` → FFmpeg filter string. Preview and export **must** use the same function.
- All dimensions even; crop never outside source; offset clamped; handle 4:3, 16:10, 21:9 (2560×1080), 1366×768 and
  already-matching sources (scale only). End the chain with `fps=<n>,format=yuv420p`. Use it in both separate and
  concat precise paths.
- `targetBitrateKbps()` / `peakBitrateKbps()` use the **output** spec.
- Any non-`Source` frame, preset or H.265 forces `precise` quality, with the existing `resolveQuality()` notice.

### 3.2 Platform presets (data in one shared module)

| Preset | Frame | Resolution | FPS cap | Max length |
|---|---|---|---|---|
| YouTube | 16:9 | source, capped at 3840×2160 | source | none |
| YouTube Shorts | 9:16 | 1080×1920 | 60 | 60 s |
| TikTok | 9:16 | 1080×1920 | 60 | 10 min |
| Instagram Reels | 9:16 | 1080×1920 | 30 | 90 s |
| Square post | 1:1 | 1080×1080 | 60 | none |

FPS = `min(source, cap)`, never upscale. Over max length: warning (not a block) with an option to export only the
first N seconds. Editing any field after picking a preset shows "Custom".

### 3.3 H.265

- `H.264 | H.265`, H.264 default. Detect `hevc_nvenc`, `hevc_qsv`, `hevc_amf` with `testEncoder()` using the same
  rate-control args as the real export. Hide/disable H.265 with an explanation when none works. No libx265 (GPL; the
  bundled FFmpeg is LGPL-only). Tag HEVC MP4 with `-tag:v hvc1`.

### 3.4 Settings, IPC, errors

- Persist last preset, frame, mode, offset, codec with safe defaults; old `settings.json` files load unchanged.
- Validate every new field in `ipc-guards.ts` (unknown presets, out-of-range offsets, odd/oversized sizes).
- Translated error messages when an export fails. No new runtime dependencies. No recorder changes. Escape filter
  values the way `plan.ts` already does so Windows paths (spaces, non-ASCII user names, drive letters) keep working.

### 3.5 UI

- **Export drawer:** preset cards (frame-shape icon, name, resolution, max length; selected highlighted; "Custom"),
  live crop preview over the current frame via `computeReframe()` (dimmed outside area, offset slider moves it live;
  mock for blur/black bars; optional overlay in `PlayerStage.tsx`), sections **Format / Quality / Output** with an
  "Advanced" collapse, summary line above Export (e.g. "1080×1920 · 60 fps · H.264 · ~42 MB · 0:48" via
  `exportEstimate.ts`), inline reasons for disabled options.
- **Polish pass:** Library, Studio, Settings and shell at 1280×720 and 1920×1080 (also check 125 % / 150 % Windows
  display scaling) — spacing, card sizes, hover/focus/selected states, contrast, toolbars, icon alignment. Through
  tokens and shared classes, 150–200 ms motion respecting `prefers-reduced-motion` and `lowperf.css`. Keep keyboard
  nav, focus rings, labels, WCAG AA; a11y tests (`dialogs.a11y.test.tsx`, `app\src\renderer\a11y\`) must pass. No
  behaviour changes; separate commit. Keep the existing design system; no UI framework.

## Phase 4: Verify (required)

**Detection**
- Every labelled clip: **100 % precision**, recall as close to 100 % as possible; list any remaining miss with its
  timestamp and why it can't be fixed safely. Reference clip: at least 19 kills and 10 deaths, plus the 47.5 s death.
- False-positive reviewer makes contact sheets of every event the new build adds and marks each real/false. Zero
  false positives.

**Export unit tests**
- `computeReframe()`/`reframeFilter()`: 1920×1080→1080×1920 crop at offset -1, 0, 1 (exact crop x/w);
  1920×1080→1080×1080; 4:3, 16:10, 21:9, 1366×768; blur; black bars; matching aspect; clamping; even and inside source.
- Presets (fps cap, resolution cap, max-length warning, Custom); `buildJobs()` separate + concat with a preset;
  forced precise with notice; bitrate from output spec; H.265 args include `hvc1`; encoder detection with/without
  HEVC; IPC guards; settings migration; `ExportDrawer.test.ts` (cards, preview follows offset, disabled reasons,
  H.265 hidden when unavailable, summary).

**Real FFmpeg** (pattern from `export-real.test.ts`)
- 3 s `lavfi testsrc2` 1920×1080 60 fps source with a coloured marker at a known position; export Shorts (offset 0
  and 1) and Square; `ffprobe` width, height, fps, codec, duration (± 1 frame); extract a frame and check the marker
  is where `computeReframe()` says. If an HEVC encoder exists on this GPU, assert `codec_name=hevc` and
  `codec_tag_string=hvc1`.

**Auto-edit**
- Unit: clip windows, merge gap, multikill never split, death handling, scoring weights, target-length fit (±1 s),
  ordering modes, multi-video ordering, project schema migration, filter-graph strings per style (escaped Windows
  font/music paths), overlay text per multikill level.
- Real FFmpeg: from two generated `testsrc2` sources with fake events build a `Clean` and a `Hype` montage; `ffprobe`
  duration within ±1 frame of the plan, fps, size, audio stream present; extract frames to confirm a transition and an
  overlay exist at the planned timestamps; music ducking lowers music level under game audio.
- Manual: auto-edit the reference clip and at least 5 of the short recorder clips into one montage per style; watch
  each result fully; screenshots of the dialog and the resulting timeline.

**Suites** — nothing that passed in the baseline may fail:
- `cd engine; cargo test; cargo clippy`
- `cd app; npm run typecheck; npm run lint; npm run test:fast; npx vitest run export-real`
- Or all at once: `powershell -ExecutionPolicy Bypass -File scripts\test.ps1`

**Windows readiness** (Windows reviewer subagent, read-only, plus your own checks)
- Walk the categories in `docs\windows-compatibility-review-request.md` that touch this work: paths with spaces,
  non-ASCII user names, long paths, OneDrive folders; file locks (Defender/player holding the output, EPERM/EBUSY on
  rename); child-process lifetime (FFmpeg/engine killed on cancel and on quit, no orphans — check Task Manager);
  GPU encoders on NVIDIA/AMD/Intel/hybrid laptops; PowerShell 5.1 vs 7 differences in `scripts\`.
- No `cfg(windows)`-only code in the analysis path; `ADITOR_FFMPEG` and engine paths resolve in dev and packaged
  builds (`app\electron-builder.yml`).
- Each confirmed defect: severity, Windows version condition, file:line, repro steps, minimal fix. Unproven items go
  under "to verify"; never invent HRESULTs or test results, and don't treat Windows 11 results as Windows 10 proof.
  Fix confirmed defects that are in scope; list the rest.

**End-to-end in the real app** (`cd app; npm run dev`)
- Re-import or re-analyze `videoplayback.mp4`; the library card and Studio timeline show all kills and deaths;
  kills in one round form multikill highlights.
- Export to Shorts and Square; the files play in Windows Media Player / Films & TV.
- Screenshots of the timeline, the new export drawer and a few polished screens.
- Optional packaging smoke test: `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`, install the result as
  a normal (non-admin) user, launch, analyze and export once. Don't publish a release.

## Phase 5: Docs, commit and push

1. Update `CHANGELOG.md` (top "Valorant Editor" section, Added/Changed), the README feature table, and
   `docs\VALORANT-EDITOR-AUDIT.md` (detection section with measured precision/recall per clip; rows "H.265 export",
   "9:16 / 1:1 reframing", "Platform presets" → ✅, plus the auto-edit rows: event priorities, per-clip speed/audio,
   effects, music/overlays/intro-outro, presets, one-click montage with target duration). Add Windows findings to
   `docs\windows-readiness-results.md`.
2. Focused commits on `feature/windows-detection-export`, for example:
   - `Detect own kill-feed rows on compressed footage; full kill/death recall`
   - `Auto edit: smart cuts, scoring and target-length montage planning`
   - `Auto edit: transitions, overlays, slow-mo, music ducking and style presets`
   - `Auto edit dialog in Library and Studio`
   - `Add shared reframe geometry and platform export presets`
   - `Export: reframing, presets and H.265 in the FFmpeg plan`
   - `Redesign export drawer with preset cards and live crop preview`
   - `UI polish pass: spacing, states and contrast across screens`
   - `Windows fixes: <what>`
   - `Docs: changelog, README, audit and Windows results`
   Each message ends with the attribution line Claude Code uses. Never commit `node_modules`, `build\` output,
   large videos (`videoplayback.mp4`), secrets, subagent worktrees, debug prints or scratch files
   (`git status`, `git diff --stat` before every commit). Configure `git config core.autocrlf` consistently with
   `.gitattributes` so line endings don't churn.
3. Commit only after all tests pass, or after I accept the pre-existing failures you listed.
4. `git push -u origin feature/windows-detection-export`. Never force-push, never push to `main`. Open a PR into
   `main` with `gh pr create` describing what changed, the evaluation table, test commands and results, screenshots
   and known limitations.
5. Final report: before/after kill/death counts and precision/recall per clip, auto-edit results per style
   (planned vs real length, clips used), files changed, test results with
   counts, Windows findings (fixed / to verify), what was verified by hand, what could not be verified, branch and PR
   links.
