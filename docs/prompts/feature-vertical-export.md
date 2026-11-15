# Prompt: Vertical / square export, platform presets and export UI upgrade

Copy everything below the line into a new Claude Code session opened at the repository root
(`/Users/informationtechnology/Downloads/abc-v`). Work through the phases in order and do not skip a phase.

---

You are working on **Valorant Editor**, an Electron + React + TypeScript desktop app with a Rust analysis engine
(fork of Aditor). Your job has three parts, all required:

1. Add **accurate, fully working** aspect-ratio reframing (9:16 vertical, 1:1 square), platform export presets and
   H.265 export.
2. **Upgrade the UI**: redesign the export experience and do a visual polish pass across the app.
3. **Commit and push** the finished, verified work to GitHub.

Correctness comes first. A feature that looks done but exports the wrong size, the wrong crop or a broken file is a
failure. Never claim a test passed if you did not run it and see it pass.

## How to split the work (use subagents to finish faster)

You are the **lead agent**. Do the steps that everything else depends on yourself, then hand independent pieces to
subagents (Agent tool) running **in parallel**, then integrate, verify and push yourself.

| Step | Who | Runs | Owns these files (no one else edits them) |
|---|---|---|---|
| Phase 0 (prepare) and Phase 1 (read, plan) | Lead | first, alone | – |
| **Contract**: `app/src/shared/reframe.ts` (`computeReframe`, `reframeFilter`), `app/src/shared/exportPresets.ts` (preset table), the new export option types and settings fields, with their unit tests | Lead | before any subagent starts | those new shared files, `shared/settings.ts` types |
| **A. Export backend**: `plan.ts`, `encodeQuality.ts`, `encoders.ts` (HEVC), `run.ts`, `export-ipc.ts`, `ipc-guards.ts`, `main/settings.ts` migration, `tr()` messages, their unit tests | Subagent A | parallel | `app/src/main/**`, `app/src/shared/messages/**`, `shared/encodeQuality.ts` |
| **B. Export drawer UI**: preset cards, live crop preview, grouped sections, summary line, `PlayerStage` overlay, renderer i18n keys for export, `ExportDrawer.test.ts` | Subagent B | parallel | `renderer/studio/ExportDrawer*`, `exportApi.ts`, `PlayerStage.tsx`, `styles/exportDrawer.css`, `renderer/i18n/*/` export keys |
| **C. App-wide UI polish**: tokens and shared classes, Library/Studio/Settings/shell styling, a11y kept green | Subagent C | parallel | `styles/tokens.css`, `base.css`, `library*.css`, `studio.css`, `settings.css`, `shell.css`, `timeline.css` (CSS only, no behaviour) |
| **D. Real FFmpeg tests**: marker-based `export-real` tests for Shorts, Square, offsets and H.265 | Subagent D | after A finishes | `app/src/main/export/*real*.test.ts` |
| Integration, Phase 4 full verification, Phase 5 docs, commits, push, PR | Lead | last, alone | docs, git |

Rules for subagents:

- Give each subagent a complete brief: the goal, the contract (paste the signatures of `computeReframe`,
  `reframeFilter`, the preset table and option types), the files it owns, the files it must **not** touch, the tests
  it must add, and the commands to run (`npm run typecheck`, `npx vitest run <its tests>`).
- File ownership is strict: two subagents never edit the same file. If a subagent needs a change outside its files
  (e.g. B needs a new IPC field), it reports it back instead of editing; the lead makes the change.
- Run A, B and C in a single message so they run at the same time. Use `isolation: "worktree"` for each if file
  overlap is possible, then merge their branches into `feature/vertical-export` yourself.
- Subagents do **not** commit to `feature/vertical-export`, push or open PRs. Only the lead does git work.
- Each subagent's final report lists: files changed, tests added, the exact test commands it ran with pass/fail
  counts, and anything unfinished. Treat that report as a claim: review the diff and re-run the tests yourself before
  accepting it.
- If a subagent's work fails review, send it back to that same subagent (SendMessage) with the specific problem,
  rather than starting over.

## Phase 0: Prepare (before writing any code)

1. Run `git status`. The working tree already has ~27 modified files from earlier work (VALORANT-only product
   changes, kill-feed `lone_chevron` detection, path fixes). **Do not mix them into this feature.** Ask me whether to
   commit them first as their own commit ("Make Valorant the only analyzed/recorded game; detect lone kill-feed
   chevrons"); if I say yes, run the tests first, commit, then continue.
2. Create a branch: `git switch -c feature/vertical-export`.
3. Install dependencies (`cd app && npm ci`) and record a **baseline**: `npm run typecheck`, `npm run lint`,
   `npm run test:fast`. Write down which tests already fail before your change so you don't blame or hide them.
4. Make sure `ffmpeg` and `ffprobe` are available for real export tests (`which ffmpeg`; on macOS
   `brew install ffmpeg` if I approve; on Windows run `scripts/fetch-ffmpeg.ps1`). If you cannot get them, say so
   clearly at the end; do not skip the real tests silently.

## Phase 1: Read and understand

Read these before planning:

- `docs/VALORANT-EDITOR-AUDIT.md` (architecture, constraints, feature-gap tables, Phase 6 "Formats").
- `app/src/main/export/plan.ts`: `BuildJobsOptions`, `buildJobs()`, `resolveQuality()`, `buildPreciseConcat()`,
  `normalizeFilter()` (today: `scale … force_original_aspect_ratio=decrease` + `pad` to the source spec only).
- `app/src/shared/encodeQuality.ts`: `VideoSpec`, `sourceSpec()`, `timelineSpec()`, `concatRenderSpec()`,
  `targetBitrateKbps()`, `peakBitrateKbps()`.
- `app/src/main/export/encoders.ts` (`pickEncoder()`, `testEncoder()`; H.264 only today), `encodeQuality.ts`,
  `run.ts`, `export-ipc.ts`, `export-real.test.ts`.
- `app/src/main/ipc-guards.ts`: every new IPC field must be validated here.
- `app/src/renderer/studio/ExportDrawer.tsx`, `ExportDrawer.test.ts`, `exportApi.ts`, `PlayerStage.tsx`,
  `app/src/renderer/styles/exportDrawer.css`, `tokens.css`, `studio.css`.
- `app/src/shared/settings.ts`, `app/src/main/settings.ts` (persisted export defaults and migrations).
- i18n: UI text in `app/src/renderer/i18n/<locale>/*.ts`; main-process text through `tr()` with
  `app/src/shared/messages/<locale>.ts`. `english-default.test.ts` and `tr-keys.test.ts` must stay green.

Then write a short plan (files to change, new functions, test list, and which subagent owns which files) and show
it to me before implementing. Phase 1 reading can itself be split: send one Explore subagent to the export pipeline
and one to the renderer/styles, and keep only their conclusions.

## Phase 2: Build the feature

### 2.1 Reframing (the core, must be exact)

- Output frame: `Source` (default, today's behaviour), `16:9`, `9:16`, `1:1`.
- Reframe modes when the frame aspect differs from the source:
  - **Crop** (default for 9:16 and 1:1): crop the largest region of the target aspect from the source, with a
    horizontal offset from -1 (left edge) to 1 (right edge), 0 = centre. Then scale to the output size.
  - **Blurred background fit**: the whole source scaled to fit, centred over a blurred, scaled-to-fill copy of itself
    (`split` → background `scale`+`crop`+`gblur`/`boxblur` → `overlay`).
  - **Black bars**: letterbox/pillarbox (today's `pad` behaviour).
- Put all of the geometry in **one pure function in `app/src/shared/`** (e.g. `reframe.ts`):
  `computeReframe(src: {width,height}, out: VideoSpec, mode, offset)` returns the exact crop rectangle / scaled
  size / pad position in integer pixels, plus `reframeFilter(...)` that turns that into the FFmpeg filter string.
  The renderer preview (2.4) and the export **must both use this same function**, so what the user sees is what
  gets exported.
- Rules: all dimensions even; crop rectangle never outside the source; offset clamped; handle 4:3, 16:10, 21:9,
  odd sizes (e.g. 1366×768) and sources that already match the target (no crop, scale only). Always end the chain
  with `fps=<n>,format=yuv420p`. Use it in **both** the separate and the concat precise paths, replacing
  `normalizeFilter()` where reframing applies (concat still normalizes mixed sources to one spec).
- `targetBitrateKbps()` / `peakBitrateKbps()` must use the **output** spec.
- Any non-`Source` frame, preset or H.265 forces `precise` quality (stream copy cannot reframe or change codec).
  Reuse the existing `resolveQuality()` notice pattern so the user sees why.

### 2.2 Platform presets

| Preset | Frame | Resolution | FPS cap | Max length |
|---|---|---|---|---|
| YouTube | 16:9 | source, capped at 3840×2160 | source | none |
| YouTube Shorts | 9:16 | 1080×1920 | 60 | 60 s |
| TikTok | 9:16 | 1080×1920 | 60 | 10 min |
| Instagram Reels | 9:16 | 1080×1920 | 30 | 90 s |
| Square post | 1:1 | 1080×1080 | 60 | none |

- FPS cap means `min(source fps, cap)`; never upscale fps.
- Over the max length: show a warning (not a block) with an option to export only the first N seconds.
- Choosing a preset fills the fields; changing any field afterwards shows the preset as "Custom".
- Keep the preset table as data in one shared module so it is easy to edit and test.

### 2.3 H.265

- Codec choice `H.264 | H.265`; H.264 stays the default.
- Detect `hevc_nvenc`, `hevc_qsv`, `hevc_amf` with the same `testEncoder()` check as H.264, using the same
  rate-control arguments the real export will use.
- Hide/disable H.265 with an explanation when no HEVC encoder works. Do **not** add libx265 (GPL; the bundled FFmpeg
  build is LGPL-only).
- Tag HEVC MP4 output with `-tag:v hvc1` so it plays on Apple devices and web players.

### 2.4 Settings, IPC, errors

- Persist last preset, frame, reframe mode, offset and codec in settings with safe defaults; existing
  `settings.json` files without the fields must load unchanged.
- Validate every new field in `ipc-guards.ts` (reject unknown presets, out-of-range offsets, odd/oversized sizes).
- Clear, translated error messages when an export fails (e.g. the encoder rejects the size).
- No engine (`engine/`), recorder or detection changes. No new runtime dependencies. Windows paths must keep working;
  escape filter values the way `plan.ts` already does.

## Phase 3: Upgrade the UI

Keep the existing design system (`tokens.css`, dark gaming theme, lucide icons, fonts) and improve on it. Do not
swap in a UI framework.

### 3.1 Export drawer redesign (`ExportDrawer.tsx`, `exportDrawer.css`)

- **Preset cards** at the top: one card per platform with a small frame-shape icon (16:9 / 9:16 / 1:1 outline),
  name, resolution and max length; the selected card is clearly highlighted; "Custom" when edited.
- **Live crop preview**: a thumbnail of the current frame (or the first clip) with the output frame drawn over it,
  using `computeReframe()`. For Crop mode the outside area is dimmed and the offset slider moves the frame live;
  for blur/black-bar modes show a small mock of the result. Optionally show the same overlay on the main player in
  `PlayerStage.tsx` while the drawer is open.
- Group the rest into clear sections: **Format** (frame, reframe, offset), **Quality** (copy/precise, codec,
  encoder), **Output** (mode, folder, file name) with an "Advanced" collapse for rarely used options.
- A summary line above the Export button: e.g. "1080×1920 · 60 fps · H.264 · ~42 MB · 0:48", reusing
  `exportEstimate.ts`.
- Show the reason inline whenever an option is disabled (copy mode with reframing, H.265 unavailable).

### 3.2 App-wide polish pass

- Review Library, Studio, Settings and the shell at 1280×720 and 1920×1080 and fix: inconsistent spacing, uneven
  card sizes, weak hover/focus/selected states, low-contrast text, cramped toolbars, misaligned icons.
- Do it through tokens and shared classes first (spacing, radii, shadows, accent colour use, transitions) rather
  than one-off overrides. Add subtle motion (150–200 ms) and respect `prefers-reduced-motion` and the existing
  `lowperf.css` mode.
- Keep accessibility: keyboard navigation, visible focus rings, labels, WCAG AA contrast. The existing a11y tests
  (`dialogs.a11y.test.tsx`, `app/src/renderer/a11y/`) must pass.
- Don't change behaviour while polishing; keep the polish in its own commit so it can be reverted separately.

## Phase 4: Tests and verification (required)

Write tests alongside the code, then run everything.

**Unit**
- `computeReframe()` / `reframeFilter()`: 1920×1080→1080×1920 crop at offset -1, 0, 1 (assert exact crop x/w);
  1920×1080→1080×1080; 4:3, 16:10, 21:9 (2560×1080) and 1366×768 sources; blur fit; black bars; matching aspect;
  offset clamping; all outputs even and inside the source.
- Presets: fps cap, resolution cap, max-length warning, "Custom" after editing.
- `buildJobs()` args for separate and concat with a preset; quality forced to precise with a notice; bitrate from
  the output spec; H.265 args include `hvc1`.
- Encoder detection with and without HEVC encoders; IPC guards reject bad values; settings migration.
- `ExportDrawer.test.ts`: preset cards, preview updates with the offset, disabled reasons, H.265 hidden when
  unavailable, summary line.

**Real FFmpeg** (pattern from `export-real.test.ts`)
- Generate a 3 s `lavfi testsrc2` 1920×1080 60 fps source **with a coloured marker at a known position**; export to
  Shorts (offset 0 and 1) and Square; probe the output with `ffprobe` and assert width, height, fps, codec and
  duration (±1 frame); extract one frame and check the marker lands where `computeReframe()` says it should.
- If an H.265 encoder is available, export H.265 and assert `codec_name=hevc` and `codec_tag_string=hvc1`.

**Run and report**
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, and the real tests (`npx vitest run export-real`).
  Compare against the Phase 0 baseline. Fix every failure you introduced.
- Start the app (`npm run dev`; engine built once with `scripts/build.ps1 -EngineOnly` on Windows), open a project,
  export to Shorts and Square, check the output plays, and take screenshots of the new export drawer and a few
  polished screens. If the app can't run on this machine (it targets Windows), say so and say what you verified
  instead.

## Phase 5: Docs, commit and push

1. Update `CHANGELOG.md` ("Valorant Editor → Added/Changed"), the feature table in `README.md`, and the
   `docs/VALORANT-EDITOR-AUDIT.md` rows "H.265 export", "9:16 / 1:1 reframing", "Platform presets" (→ ✅) and
   "Dashboard"/UI notes if relevant.
2. Make focused commits on `feature/vertical-export`, for example:
   - `Add shared reframe geometry and platform export presets`
   - `Export: reframing, presets and H.265 in the FFmpeg plan`
   - `Redesign export drawer with preset cards and live crop preview`
   - `UI polish pass: spacing, states and contrast across screens`
   - `Docs: changelog, README and audit for vertical export`
   Each commit message ends with the attribution line Claude Code uses. Don't commit build output, `node_modules`,
   large videos (`videoplayback.mp4`) or secrets.
3. Only commit after all tests pass (or after I accept any known pre-existing failures you listed).
4. Push: `git push -u origin feature/vertical-export` to `https://github.com/Fairoz007/valorant-edit`. Never force-push
   and never push to `main` directly. Then open a pull request into `main` with `gh pr create`, with a description
   covering what changed, how it was verified (test commands and results, screenshots) and known limitations.
5. Finish with a summary: files changed, test results with counts, what was verified by hand, what could not be
   verified, and the branch and PR links.
