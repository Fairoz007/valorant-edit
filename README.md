<p align="center"><img src="app/resources/icon.png" alt="Valorant Editor app icon" width="128" height="128"></p>

# Valorant Editor

> **Automatic VALORANT highlight detection, clip selection and editing — locally on your PC.**
>
> Record your *VALORANT* matches or drag in recordings you already have. Valorant Editor reads the kill feed and
> scoreboard from on-screen pixels (no game injection, no cloud), marks every kill, death and round result, suggests
> multi-kill and ace highlights, and lets you arrange and export them from a timeline.

Valorant Editor is a fork of [Aditor](https://github.com/ShiQu1218/Aditor) by ShiQu1218, rebranded and set to
**English by default**. Apex Legends support inherited from Aditor is kept working.

- Technical audit, feature-gap report and roadmap: [docs/VALORANT-EDITOR-AUDIT.md](docs/VALORANT-EDITOR-AUDIT.md)
- Changes made in this fork: [CHANGELOG.md](CHANGELOG.md) (see "Valorant Editor" at the top)

## What it does today

| Feature | Description |
|---|---|
| Import and analyze | Drag in recordings (MP4 / MKV / MOV / WebM) or add a watch folder; new videos are queued and analyzed one at a time in the background |
| VALORANT event detection | Kills and deaths from the kill feed (computer vision on the HUD), round wins/losses from the scoreboard |
| Highlights | Multi-kill (2–4 kills in a round) and ace (5) highlights, plus auto-compilation of dense kill sequences |
| Studio / timeline | Event markers, project track, trim and split, add or correct events manually, undo/redo |
| Built-in recorder | Starts recording when a supported game launches; live replay while the match is still recording |
| Export | Fast lossless cut or precise re-encode in H.264 or H.265 (NVENC / QSV / AMF hardware encoders, OpenH264 CPU fallback for H.264) |
| Vertical / square export | 9:16 and 1:1 reframing (crop with offset, blurred background or black bars) with a live preview, and presets for YouTube, Shorts, TikTok, Reels and square posts |
| Projects | Autosaved projects, cached analysis results, re-analysis that preserves manual edits |

## Language

English (`en`) is the default and primary language. All interface text lives in the centralized catalogs under
`app/src/renderer/i18n/` and `app/src/shared/messages/`; the other inherited locales (繁體中文, 简体中文, 日本語, 한국어)
remain selectable in **Settings → General → Language**. `app/src/shared/english-default.test.ts` fails the build if any
English string is missing or contains untranslated text.

## Requirements

- Windows 10 / 11, 64-bit (the recorder and capture paths are Windows-only)
- For building: Node.js 22, Rust (stable, MSVC toolchain), PowerShell 7
- FFmpeg is bundled by the build script (`scripts/fetch-ffmpeg.ps1`); GPU decode/encode is used when available, with CPU fallback

## Build and run

```powershell
cd app
npm ci
npm run dev            # development (needs the engine built once: ../scripts/build.ps1 -EngineOnly)
npm run test:fast      # unit tests
../scripts/build.ps1   # full installer build (engine + recorder + FFmpeg + Electron)
```

The Rust analysis engine is in `engine/` and the recorder in `recorder/`; see [engine/README.md](engine/README.md).

## Diagnostics and updates

- Crash diagnostics (Sentry) are **off by default** and the fork ships **without a Sentry DSN**. To use your own
  project, set `SENTRY_DSN` in `app/src/shared/telemetry.ts`; until then the SDK is never initialized.
- Auto-update checks GitHub Releases of `Fairoz007/valorant-edit` (`app/electron-builder.yml`, `app/src/shared/update.ts`).

## License and trademarks

GPL-3.0-or-later, inherited from Aditor — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
This fork must stay under the GPL and keep the original copyright notices.

VALORANT is a trademark of Riot Games, Inc. Apex Legends is a trademark of Electronic Arts Inc. Valorant Editor is not
affiliated with or endorsed by Riot Games or Electronic Arts.
