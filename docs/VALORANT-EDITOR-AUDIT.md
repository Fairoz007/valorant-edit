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
2. `valorant/feed.rs` — connected-component and outline analysis on the grayscale kill feed finds rows and decides whether
   each row is the player's **kill** or the player's **death** (ally/enemy side by outline colour/position).
3. `valorant/tracker.rs` — de-duplicates rows across frames (slot movement, 1.5 s windows, 6 s death debounce) into events.
4. `valorant_rounds.rs` — glyph tracking of the scoreboard digits produces **round won/lost** with start/end times.
5. `round_highlights()` — kills inside one round become a **multikill** (2–4) or **ace** (5+) highlight event.
6. Results are cached; re-analysis merges with manual edits (`cache::merge_reanalysis`).

Detection is pixel/template based — there is no OCR engine, no ML model and no game API/injection. Audio detection exists only as
offline experiments (`docs/valorant-audio-comparison.md`, `docs/valorant-av-experiment.md`), not in the shipped pipeline.

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
| Single kill | ✅ | Kill-feed CV |
| Double / triple / quadra kill | ✅ | Derived per round (`multikill`, score = kill count); UI labels them as multi-kills, not by name |
| Ace | ✅ | 5+ kills in one round |
| Death | ✅ | Kill-feed CV |
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
| Customizable event priorities | ❌ | Score = kill count; no user weights |
| Duplicate avoidance / overlap merge | ✅ | Auto-clip merges overlapping windows |
| Pre/post padding, adjustable | ✅ | Clip defaults in Settings → Editing |
| Preserve quality / fps / resolution | ✅ | Lossless copy mode; precise mode keeps source fps/size when compatible |
| Timeline: markers, reorder, trim, split, undo/redo, manual correction | ✅ | Studio + project track + history |
| Per-clip speed, per-clip audio level | ❌ | |
| Effects (zoom, slow-mo, speed ramp, blur, shake, flash) | ❌ | No filter-graph effects stage in export |
| Music, beat sync, SFX, intro/outro, text overlays (ACE!, CLUTCH!…) | ❌ | |
| Audio stem control (game / voice / music / SFX) | ❌ | Recorder can capture mic separately; export mixes one track |
| Presets (Clean / Cinematic / Shorts) | ❌ | |
| One-click montage with target duration | 🟡 | Auto-compilation + concat export exist; no duration targeting or preset styling |

### 3.3 UI, processing, export, projects

| Area | Status | Notes |
|---|---|---|
| Library / import / analysis queue / studio / settings | ✅ | Dark gaming UI, progress, keyboard navigation, a11y tests |
| Dashboard with totals (videos, kills, aces, highlights) | 🟡 | Per-video counts on library cards; no aggregate dashboard |
| GPU decode (CUDA/D3D11VA) + CPU fallback | ✅ | Automatic fallback with notice |
| Background queue, cancel, resume, crash recovery, temp cleanup | ✅ | |
| Batch processing | ✅ | Watch folders and multi-file import |
| H.264 export, HW encoders | ✅ | NVENC / QSV / AMF, OpenH264 fallback |
| H.265 export | ❌ | |
| 9:16 / 1:1 reframing | ❌ | Normalize filter pads to a fixed size only |
| Platform presets (YouTube, Shorts, TikTok, Reels) | ❌ | |
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
