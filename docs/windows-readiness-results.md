# Windows readiness — static audit (pre-Windows pass)

- Date: 2026-11-15
- Branch: `feature/windows-readiness` (from `feature/vertical-export` @ `d5e3459`)
- Host: **macOS 27.0.1 arm64 — not Windows.** This document covers Phase 1 (read + audit) of
  `docs/prompts/windows-readiness.md` only. No code was changed, nothing was built, and no test was run.
  Every status below comes from reading the code. None of it counts toward the definition of done until it is re-checked on Windows 10/11 x64.

Legend: ✅ code looks correct for Windows · 🟡 partial / needs a decision / unverifiable statically · ❌ defect found.
"Not verified" = needs a real Windows machine (and often specific hardware); listed in the last section.

## Audit table

| # | Feature | Status | Evidence | Planned fix |
|---|---|---|---|---|
| 1 | Install / uninstall / portable | 🟡 | `app/electron-builder.yml:66-69` artifact names have no spaces; `oneClick: false` allows choosing a directory. Prior review V8 (Program Files + per-user updater write access) still open. | None in code yet; installer smoke test on Windows (spaces + Unicode + USB portable). |
| 2 | First launch | ❌ | Single-instance lock present (`app/src/main/index.ts:337`, `:352`). **But the analysis engine is spawned without `windowsHide`** (`app/src/main/engine.ts:88-91`). `aditor.exe` is a console-subsystem binary (no `windows_subsystem` attribute in `engine/src`), so a GUI parent without a console gets a visible console window for it. The live engine (`recording/live-engine.ts:151`) and recorder (`recording/aditorrec-client.ts:105`) already pass `windowsHide: true`. | Add `windowsHide: true` to `engine.ts:88`; regression test asserting the spawn options (pattern as in `engine.test.ts:36`). |
| 3 | Import and analyze | 🟡 | Paths normalized case-insensitively (`library.ts:53-55`), CRLF-safe line parsing (`engine.ts:147-150` trims before `JSON.parse`). **UNC paths are rejected on purpose** (`safe-path.ts:12-24`, enforced at `library.ts:178`, `ipc-guards.ts:7`, `export/export-ipc.ts:101`) as an NTLM-leak / SMB-hang defence. That conflicts with checklist row 3 ("UNC/network paths work"); mapped drive letters (`Z:\`) do pass. Long paths: JS allows up to 4096 chars, Node/libuv and Rust std add `\\?\` themselves, and FFmpeg's file protocol handles long paths in recent versions. Not verified. | **Decision needed from the owner** on UNC: keep it blocked (document "map a drive letter") or allow it for explicit user imports only (drag-drop / file dialog), never for paths read from project files. Long-path and OneDrive checks go to the Windows run. |
| 4 | Watch folders | ✅ (static) | chokidar `awaitWriteFinish` plus a Windows-only write-lock probe (`library.ts:318-345`); case-insensitive keys (`watch.ts:75`); existing `watch.release.test.ts` and `watch.robust.test.ts`. | None. Explorer delete/rename of a watched folder needs a Windows check. |
| 5 | VALORANT detection | 🟡 | Not auditable for Windows-specific hazards; the engine's FFmpeg children all go through `engine/src/process.rs` (job object, see #9). | Run `tools/evaluate_valorant.py` baselines on Windows. |
| 6 | Studio / timeline | 🟡 | Renderer logic is platform-neutral; Windows keys (Delete, Ctrl+Y) not audited in depth. | Playwright e2e on Windows. |
| 7 | Built-in recorder | 🟡 | Prior fixes D1–D4, D6, D7 landed (`docs/windows-recorder-fix-results.md`); compile and unit evidence only. D8 deferred. All recorder spawns use `windowsHide` / `CREATE_NO_WINDOW`. OBS graphics-hook path not touched. | Hardware matrix T01–T19 from `docs/windows-compatibility-review.md` §8.2. |
| 8 | Live replay | 🟡 | `recording/live-engine.ts:150-151` spawn OK; frame-drop behaviour needs a running capture. | Windows run. |
| 9 | Export | ❌ | Cancel uses `killTree` (`taskkill /T /F`, `export/killTree.ts:20-50`); deletes retry on EBUSY/EPERM (`export/run.ts:85-93`); output names sanitized for reserved names and trailing dots (`export/export-ipc.ts:60-61`); progress parsing tolerates `\r` (`parseInt`). **`detectEncoders` spawns `ffmpeg -encoders` without `windowsHide`** (`export/encoders.ts:71`). It runs every time the export dialog or Settings lists encoders (`ipc-handlers.ts:406`, `proxy.ts:66`), so on Windows a console window flashes. The per-encoder probes beside it (`:56-59`) already hide. | Add `windowsHide: true` at `encoders.ts:71`; regression test. |
| 10 | Vertical / square export | 🟡 | Pure geometry in `shared/reframe.ts`, platform-neutral. | Output-size check on Windows with real FFmpeg (`export-real.test.ts`). |
| 11 | Projects and cache | 🟡 | All persistent JSON goes through `writeFileAtomicSync` (projects, library, settings, cache-io, reanalysis), which retries rename on EPERM/EACCES/EBUSY (`atomic-write.ts:4-17`). The retry budget is only 50+100+200 ms ≈ 350 ms; Defender or a OneDrive client can hold a handle longer. | Consider a longer backoff (~2 s total); test with a held file handle on Windows. |
| 12 | Tray, notifications, quit | 🟡 | Quit guard D5 fixed (`docs/windows-quit-fix-results.md`). Engine grandchildren are covered: every engine FFmpeg/ffprobe spawn goes through `engine/src/process.rs:44-87` (job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), so `p.kill()` on `aditor.exe` (`engine.ts:330`) also ends its FFmpeg children. That resolves prior review V3 in code. **No `app.setAppUserModelId()` anywhere in `app/src`** (prior review V1 still open): toasts may show a generic Electron identity, and the portable build may show none. | Call `app.setAppUserModelId('com.valoranteditor.app')` (matching `appId`, `electron-builder.yml:1`) on win32 early in `index.ts`; unit test; verify toasts for the installed and portable builds. |
| 13 | Auto-update | 🟡 | Artifact names have no spaces (`electron-builder.yml:66-68`); `latest.yml` / `.blockmap` generation needs a real `build.ps1` run. | Windows build. |
| 14 | Settings | ✅ (static) | Dir inputs validated (`safe-path.ts:40-49`), case-insensitive comparisons (`settings-ipc.ts:81`, `storage-root.ts:51`). Device dropdowns need real WASAPI / DXGI enumeration. | Windows check. |
| 15 | High DPI / multi-monitor | 🟡 | DDA thread sets per-monitor DPI awareness; prior V4 (rotated monitor under DDA) and V7 (mixed DPI / HDR) still open. | Windows hardware check. |

## Hazard sweep summary

| Hazard | Result |
|---|---|
| `spawn` without `windowsHide` | **2 defects**: `engine.ts:88`, `export/encoders.ts:71`. Every other spawn in `app/src/main` hides its window. |
| `shell: true` / shell-quoted paths | None found. |
| `process.kill` on child trees | Export / proxy / thumbnail use `killTree`; the engine relies on its Rust job object (OK); `telemetry-verification.ts:61` deliberately kills an isolated helper (OK). |
| Case-sensitive path compares | None problematic: `normalizePath` lowercases; raw `===` cases compare paths built by the same function. |
| Rename/unlink without lock retry | Durable writes retry (short budget, see #11); one-off unlinks surface errors instead of retrying, which is acceptable. |
| Reserved names / trailing dots | Handled in `export-ipc.ts:60-61`. |
| CRLF / `\n`-only splitting | All parsers `trim()` or use `parseInt`/regex prefixes, so CRLF is safe. |
| `process.platform !== 'win32'` disabling a feature | None; the branches only add `detached` for POSIX or lowercase on Windows. |

## Tests run

None. The host is macOS, and the brief requires the Windows baseline (`./scripts/test.ps1 -Tier fast -KeepGoing`) first.

## Not verified (everything that needs Windows)

All of features 1–15 at runtime, in particular: installer and portable smoke test, console-window behaviour (#2, #9), toasts / AUMID, long, OneDrive and Unicode paths, the full recorder hardware matrix, NVENC/QSV/AMF and the OpenH264 fallback, no orphan `ffmpeg.exe` / `aditor.exe` / `aditorrec.exe` after cancel or quit, `latest.yml` / `.blockmap` output, and Windows 10 vs 11.

## Next steps

1. Owner decision on UNC imports (#3).
2. Fix #2, #9, #12 (AUMID), and optionally #11 (retry budget), each with a vitest regression test. All of these can be unit-tested off Windows.
3. Run Phases 0, 3 and 4 of the brief on a Windows 10/11 x64 machine.

## Fixes applied (2026-11-15, Windows 11 + RTX 2060)

- **#2 Engine console window:** `engine.ts` now spawns `aditor.exe` with `windowsHide: true`.
- **#9 Encoder listing console flash:** `export/encoders.ts` runs `ffmpeg -encoders` with `windowsHide: true`.
  Both are covered by `spawn-windows-hide.test.ts`, which fails without the fix.
- **#12 AUMID:** `app-identity.ts` sets `com.valoranteditor.app` (the `electron-builder.yml` `appId`) on win32 before ready;
  `app-identity.test.ts` checks the call and that the id matches the builder config.
- **Missing recorder fixtures:** `init-h264.mp4`, `init-hevc.mp4` and `init-av1.mp4` were never committed because of the `*.mp4`
  ignore rule, which made 19 recorder tests fail on a fresh clone. They are regenerated by `app/scripts/make-init-fixtures.cjs`
  (NVENC H.264/HEVC from the pinned FFmpeg; SVT-AV1 because the RTX 2060 has no AV1 NVENC) and un-ignored.

Fast suite on this machine after the fixes: 223 files, 2675 passed, 2 skipped, 0 failed. Still not verified at runtime: the
console windows and toast identity in the installed and portable builds.
