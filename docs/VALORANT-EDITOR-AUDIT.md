# Valorant Editor — Technical Audit and Feature-Gap Report

Audit of the Aditor 0.4.6 codebase (cloned from `ShiQu1218/Aditor`) against the "Advanced AI Valorant Automatic Highlight
Editor" upgrade specification. Date: 2026-11-15.

## 1. Architecture

| Layer | Technology | Location |
|---|---|---|
| Desktop shell | Electron 45, electron-vite, electron-builder (NSIS + portable, Windows x64) | `app/` |
| UI | React 18 + TypeScript, hand-written CSS design tokens (dark theme), lucide icons | `app/src/renderer/` |
| Main process | Node/TypeScript: library, analysis queue, projects, export, recording, updater, tray | `app/src/main/` |
| Analysis engine | Rust binary `aditor` (JSON Lines IPC), own CV primitives (no OpenCV), FFmpeg decode | `engine/` |
| Recorder | Rust binary `aditorrec` (Windows Graphics Capture / DXGI Desktop Duplication / OBS graphics-hook, HW encode) | `recorder/` |
| Video | Custom LGPL FFmpeg build (decode, hwaccel, NVENC/QSV/AMF, OpenH264 download) | `ffmpeg-build/`, `scripts/fetch-ffmpeg.ps1` |
| Storage | JSON files, no database: `settings.json`, library, `projects/<id>.json`, per-video `.aditor.json` analysis caches | `%APPDATA%\Valorant Editor` |
| Tests | Vitest (~2,450 app tests), Playwright e2e, Cargo tests, Python evaluation tools | `app/`, `engine/tests`, `tools/` |

### VALORANT detection pipeline (as implemented)

1. FFmpeg decodes only two small crops per frame: the kill-feed banner and the round scoreboard (`ValorantProfile.capture_banner/spec`).
2. `valorant/feed.rs` — connected-component analysis of yellow masks on the kill feed finds the player's own rows and decides
   whether each is the player's **kill** (yellow mark on the killer side) or **death** (yellow mark at the right, victim end).
   The yellow row outline is used when it is visible but is not required (see "Own kill/death rows" below).
3. `valorant/tracker.rs` — de-duplicates rows across frames (slot movement, 1.5 s windows, 6 s death debounce) into events.
4. `valorant_rounds.rs` — glyph tracking of the scoreboard digits produces **round won/lost** with start/end times.
5. `round_highlights()` — kills inside one round become a **multikill** (2–4) or **ace** (5+) highlight event.
6. Results are cached; re-analysis merges with manual edits (`cache::merge_reanalysis`).

Detection is pixel/template based — there is no OCR engine, no ML model and no game API/injection. Audio detection exists only as
offline experiments (`docs/valorant-audio-comparison.md`, `docs/valorant-av-experiment.md`), not in the shipped pipeline.

#### Own kill/death rows

The player's own rows are marked by a thin yellow outline and a solid yellow chevron at the row's outer end. On compressed or
upscaled footage (e.g. 720p YouTube uploads) the outline blurs away or survives only in part, so a row is also accepted on the
chevron alone (`lone_chevron`): a solid yellow chevron at the row's outer end with ally teal on the player's side next to it.

- **Size.** The chevron box must be 14–26 px wide on the kill side and 10–26 px on the death side, and 18–34 px tall. A shorter
  death-side chevron (down to 14 px tall) is accepted while it stays taller than wide (h ≥ 1.3 × w). Earlier, a box-size gate
  (w ≥ 14, h ≥ 18) ran before `lone_chevron` and rejected these small death chevrons.
- **Fill.** The chevron must fill 0.35–0.80 of its box. Real chevrons measured 0.36–0.53 (0.67 when tiny); a solid yellow
  block (fill near 1) is some other mark and is rejected.
- **Death-screen tint.** The red death-screen tint desaturates the death chevron so it survives only in the pale yellow mask;
  death-side components from that mask get the same `lone_chevron` test.
- **Kill side, faint mask.** `lone_chevron` also runs on faint-mask components at least 20 px tall. Yellow assist badges left of
  a teammate's row measured at most 19 px and are also rejected by `lone_chevron`'s own checks. An outlined kill-side box
  (≥ 40 outline columns) no longer needs w ≥ 19.

All thresholds are in 1080p reference pixels of the restored 600×256 feed crop. The decoder rescales every input resolution to
that crop, so the thresholds apply to any input resolution. `templates_version` is `valorant-feed@10`
(`templates/valorant/icons/profile.json`), so analyses cached by older builds are redone.

#### Measured accuracy

Hand labels in `tools/labels/videoplayback.json` were made by eye from 0.5 s kill-feed contact sheets without consulting
detector output, and are scored with `tools/eval_feed_labels.py` (±1.0 s tolerance, per event type, one-to-one matching).
Reference clip: `videoplayback.mp4`, a 720p 60 fps compressed YouTube upload (~16:23, edited montage) with 19 own kills and
12 own deaths labelled.

| Build | Kills detected / true positives | Deaths detected / true positives | Precision | Recall |
|---|---|---|---|---|
| Aditor import, before `lone_chevron` (67d211e) | 4 detected (not scored) | 1 detected (not scored) | — | — |
| First `lone_chevron` fix (fa348ce) | 19 / 17 | 10 / 10 | 0.931 | 0.871 |
| Current | 19 / 19 | 12 / 12 | 1.000 | 1.000 |

fa348ce missed deaths at 47.5 s (10×15 px chevron) and 251.75 s (red death-screen tint), and confirmed kills at 290.5 s and
799.2 s 1.5 s / 1.0 s late (outside ±1 s), so each counted as a miss plus an extra detection. fa348ce also confirmed a solid
yellow square and broke the golden test `python_feed_detection_and_tracking_cases`; the fill limit fixes it. On the current
build, matched-pair timing errors are within −0.50 to +0.75 s.

In the app (macOS, `npm run dev` build, real engine) the library card and Studio show 19 kills / 12 deaths for this clip, the
cache records `valorant-feed@10`, and there are 4 round multikill highlights (rounds with 2, 2, 3 and 2 kills). AI auto-clip with
minimum kills 2 suggests 4 two-kill clips; the default (minimum 3, max gap 20 s) suggests none, because the 3-kill round has a
20.5 s gap.

Tests in `engine/tests/valorant.rs`: `own_rows_on_compressed_footage_are_confirmed`, `rows_that_are_not_the_players_are_rejected`
(teammate kill, enemy kills ally, Clove resurrect, two teammate kills with a yellow assist badge, empty feed, fade to dark,
partially faded row, yellow clothing at 1080p) and `native_1080p_player_rows_stay_detected` (the existing 1080p fixtures in
`engine/tests/fixtures/valorant`, which no test used before). Real-crop fixtures are in `engine/tests/fixtures/valorant_feed/`.

Limitations:

- Only one labelled clip (720p, compressed). There are no full-clip labels for native 1080p, 1440p or 30 fps footage yet;
  1080p coverage is single-frame fixtures only.
- Different HUD scales are untested.
- Not run on Windows (the analysis code has no Windows-only paths).
- Thresholds were tuned on this clip; the assist-badge height guard has about 1 px of margin on it.

## 2. Localization status (requirement 13) — done in this fork

The app already had a centralized i18n system: typed UI catalogs (`app/src/renderer/i18n/<locale>/`) and a `tr()` message table
for main-process/notification text (`app/src/shared/messages/<locale>.ts`) keyed by the zh-TW source string. Changes:

- Default locale and default `language` setting are now `en`; English is listed first.
- Hard-coded Chinese outside the catalogs was replaced (main-process logs, dev fixtures, a search keyword, a `zh-TW` date format).
- New test `app/src/shared/english-default.test.ts` scans every English string for untranslated text and renders all Settings
  pages in English. The existing `tr-keys` test already enforces that every `tr()` key has an English translation.
- The inherited behavioral test suite asserts the zh-TW source catalog, so it is pinned to that locale (`app/test/sourceLocale.ts`).
- Not translated: internal design docs under `docs/` (developer history, mostly Traditional Chinese) and Rust test fixtures
  that use Chinese text deliberately to test Unicode paths.

## 3. Feature-gap report

Legend: ✅ exists · 🟡 partial · ❌ missing

### 3.1 Event detection

| Event | Status | Notes |
|---|---|---|
| Single kill | ✅ | Kill-feed CV; 19/19 on the one labelled 720p clip (see "Measured accuracy" above) |
| Double / triple / quadra kill | ✅ | Derived per round (`multikill`, score = kill count); UI labels them as multi-kills, not by name |
| Ace | ✅ | 5+ kills in one round |
| Death | ✅ | Kill-feed CV; 12/12 on the same clip |
| Round won / lost | ✅ | Scoreboard glyph tracker |
| Match victory | 🟡 | Rounds are known; the final score / match result is not emitted as an event |
| Headshot | ❌ | Needs headshot-icon template in kill-feed rows |
| Wallbang | ❌ | Needs wallbang-icon template in kill-feed rows |
| Clutch 1vN | ❌ | Needs alive-player counts (top HUD portraits) at the moment of the last ally death |
| Team wipe | ❌ | Same signal as clutch (all enemy portraits dead) |
| Spike plant / defuse | ❌ | Needs spike HUD/banner templates |
| Match MVP | ❌ | Needs end-of-match screen detection |
| OCR kill-feed text | ❌ | Engine uses glyph/contrast matching, not OCR |
| Audio events | 🟡 | Offline experiments only |
| ML classification | ❌ | None |

### 3.2 Highlights, clips and editing

| Area | Status | Notes |
|---|---|---|
| Highlight suggestions | ✅ | Multi-kill/ace highlights, dense-kill auto-compilation (`engine/src/autoclip.rs`) |
| Customizable event priorities | ✅ | `shared/highlightScore.ts`: ace > 4k > 3k > clutch > 2k > single with user-editable weights, quick-succession bonus, duplicate penalty; shared by Auto montage and Auto edit. Clutch is a heuristic (won round closed out without dying), not HUD-based |
| Duplicate avoidance / overlap merge | ✅ | Auto-clip merges overlapping windows |
| Pre/post padding, adjustable | ✅ | Clip defaults in Settings → Editing |
| Preserve quality / fps / resolution | ✅ | Lossless copy mode; precise mode keeps source fps/size when compatible |
| Timeline: markers, reorder, trim, split, undo/redo, manual correction | ✅ | Studio + project track + history |
| Per-clip speed, per-clip audio level | ✅ | Project schema v2 (`speed`, `gain`); changed-speed parts have silent game audio (no `atempo` in the pinned FFmpeg) |
| Effects (zoom, slow-mo, speed ramp, blur, shake, flash) | 🟡 | Slow-mo (`setpts`), zoom punch (`crop`+`scale`), flash and letterbox (`drawbox`) in `main/export/montage-plan.ts`; no blur/shake/speed ramp |
| Music, beat sync, SFX, intro/outro, text overlays (ACE!, CLUTCH!…) | 🟡 | Music with fades and ducking mixed in Node (`montage-audio.ts`), onset-based beat sync, intro/outro cards, PNG captions overlaid (no `drawtext`); no SFX |
| Audio stem control (game / voice / music / SFX) | 🟡 | Game gain per clip + music bed; recorder mic track is still mixed into one game track |
| Presets (Clean / Cinematic / Shorts) | ✅ | Clean, Cinematic, Hype, Shorts as data (`shared/autoEdit.ts`); transitions are cuts or dips (no `xfade`) |
| One-click montage with target duration | ✅ | Auto edit dialog in Studio and the Library selection bar; target fit ±1 s; multi-video in recording order |
| Auto montage after each match | ✅ | `main/montage/**`: job store with resume, live-trusted and full-analysis paths, built-in and OBS backends, verified export, library entry, notification; Recording settings section and panel status |

### 3.3 UI, processing, export, projects

| Area | Status | Notes |
|---|---|---|
| Library / import / analysis queue / studio / settings | ✅ | Dark gaming UI, progress, keyboard navigation, a11y tests |
| Dashboard with totals (videos, kills, aces, highlights) | 🟡 | Per-video counts on library cards; no aggregate dashboard |
| GPU decode (CUDA/D3D11VA) + CPU fallback | ✅ | Automatic fallback with notice |
| Background queue, cancel, resume, crash recovery, temp cleanup | ✅ | |
| Batch processing | ✅ | Watch folders and multi-file import |
| H.264 export, HW encoders | ✅ | NVENC / QSV / AMF, OpenH264 fallback |
| H.265 export | ✅ | `hevc_nvenc` / `hevc_qsv` / `hevc_amf`, `hvc1` tag; no libx265 (LGPL build) |
| 9:16 / 1:1 reframing | ✅ | Crop with offset, blurred background (scale-only blur, no extra FFmpeg filters), black bars; `shared/reframe.ts` shared by preview and export |
| Platform presets (YouTube, Shorts, TikTok, Reels) | ✅ | Plus Square post; data table in `shared/exportPresets.ts`, length warning with trim |
| Project save / reopen / autosave / reprocess | ✅ | JSON projects |
| Multiple montages from one recording | ✅ | Multiple projects can reference the same source |
| Detection confidence + manual correction | 🟡 | Manual add/delete/override exist; per-event confidence is not shown |

## 4. Constraints that shape the roadmap

1. **Windows only.** Recorder, capture and the packaged build target Windows 10/11. Engine work must be built and validated on Windows.
2. **Detection needs labelled footage.** New detectors (headshot, wallbang, clutch, spike, MVP) need real VALORANT recordings at
   several resolutions with hand-labelled timestamps, plus HUD templates cropped from them. The repo's evaluation harness
   (`tools/evaluate_valorant.py`) is the place to measure accuracy before enabling a detector by default.
3. **No simulated results.** Every new detector should ship behind its evaluation numbers; nothing should be marked done
   without a measured precision/recall on held-out recordings.
4. **Riot policy.** Pixel-only analysis without game injection is the safe approach. The OBS graphics-hook capture path
   is a risk for Vanguard-protected VALORANT and should stay off for VALORANT.

## 5. Recommended roadmap

Ordered to follow the spec's own rule: reliable detection before visual effects.

| Phase | Scope | Main files | Exit criteria |
|---|---|---|---|
| 1. Detection extensions | Headshot + wallbang icons in kill-feed rows; named multi-kill labels (DOUBLE/TRIPLE/QUADRA KILL); match-result event | `engine/src/valorant/feed.rs`, `tracker.rs`, `valorant_rounds.rs`, templates | ≥ 95 % precision on labelled set |
| 2. Round context | Alive-player HUD tracking → clutch 1vN, team wipe; spike plant/defuse banners | new `engine/src/valorant/hud.rs` | Labelled clutch set passes |
| 3. Scoring engine | Weighted highlight score with user-editable priorities and confidence display; duplicate suppression across rounds | `app/src/renderer/studio/highlights.ts`, settings | Unit tests + UI |
| 4. Audio | Promote the audio-template experiment to an optional confirmation signal for kills | `engine/`, `docs/valorant-audio-comparison.md` | Improves F1 on labelled set |
| 5. Montage effects | FFmpeg filter-graph stage: speed/slow-mo, zoom, text overlays (ACE!, CLUTCH!…), transitions, music bed with ducking, intro/outro; presets | `app/src/main/export/plan.ts`, `run.ts` | Real-ffmpeg export tests |
| 6. Formats | H.265, 9:16 / 1:1 with crop-based reframing, platform presets | `export/plan.ts`, `encoders.ts` | Real-ffmpeg export tests |
| 7. Dashboard | Aggregate stats + recent projects/history screen | `app/src/renderer/shell/` | UI tests |
