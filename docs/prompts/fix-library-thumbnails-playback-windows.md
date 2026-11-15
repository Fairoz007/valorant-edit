# Prompt: Fix broken thumbnails and "Video cannot be played" on Windows

Copy everything below the line into a new Claude Code session opened at the repository root (`D:\valorant-edit`) on
Windows. Work through the phases in order.

---

You are working on **Valorant Editor**, an Electron + React + TypeScript desktop app (`app/`) with a Rust analysis
engine. The machine is **Windows 10/11**; use PowerShell syntax.

## The bug

On Windows, after importing VALORANT recordings (e.g. `VALORANT 11-13-2026 20-09-27-088.mp4`, 1920×1080, H264, 0:20):

1. **Library:** every video card shows a **broken-image icon** instead of a thumbnail. Analysis itself works: badges
   ("Kills 1", "Deaths 1"), duration, "Imported", date and "H264" all render, and the status says "Analysis complete".
2. **Studio:** opening any of those videos shows the notice **"Video cannot be played — This video file was not found
   or cannot be played. Relink the file or go back to the library."** The files do exist on disk.
3. Minor: the Studio "same day videos" list shows only kills ("Kills 1 · 0:20") even when the library card for the same
   video shows "Kills 1 Deaths 1".

**Goal:** thumbnails show and videos play on Windows (dev and packaged builds), for any path — drive letters,
spaces, `#`, `?`, `%`, non-ASCII folder or user names, UNC paths — without weakening Electron security. Then commit
and push.

Correctness comes first. Never claim something works unless you saw it work; never claim a test passed unless you
ran it.

## What is already known (verify, don't assume)

- Both thumbnails and the player build their URLs with one helper:
  `app/src/renderer/studio/seekPlan.ts` → `fileUrl(path)` returns `` `file://${encodeURI(path.replace(/\\/g, '/'))...}` ``.
  `app/src/renderer/library/cardLogic.ts` re-exports it as `thumbnailUrl`; `VideoCard.tsx` uses it for `<img src>`;
  `useStudioSourcePlayback.ts` uses it for the `<video>` src.
- **Suspected root cause #1:** for a Windows path `D:\clips\a.mp4` this produces `file://D:/clips/a.mp4`. In a
  `file://` URL the part after `//` is the **host**, so Chromium reads `D:` as a host name and the file can't be
  loaded. The correct form is `file:///D:/clips/a.mp4` (three slashes); UNC `\\server\share\a.mp4` should become
  `file://server/share/a.mp4`. This worked on macOS only because POSIX paths start with `/`.
  The unit tests lock in the wrong output: `seekPlan.test.ts` (`'file://C:/v/a.mp4'`) and
  `library/recordedTime.test.ts` (`'file://C:/...'`).
- **Suspected root cause #2 (dev mode):** under `npm run dev` the renderer is served from `http://localhost`, and
  Chromium blocks `file://` resources from an `http:` page ("Not allowed to load local resource"), even with a correct
  URL. The window uses `sandbox: true`, `contextIsolation: true` (`app/src/main/index.ts`) and
  `app/src/main/window-security.ts` — keep them.
- When the `<video>` fails, `useStudioPlayback.ts` `handleVideoError` → `setVideoMissing(true)` → the notice from
  `renderer/studio/notices.ts`. So "not found" here really means "failed to load", not a missing file.
- Minor issue: `renderer/studio/SameDayVideos.tsx` builds its summary from `entry.counts.kill` only.

## Phase 0: Prepare

1. `git status`; if there are uncommitted changes, ask me whether to commit them first.
2. `git switch -c fix/windows-media-urls`.
3. `cd app; npm ci`; record baselines: `npm run typecheck`, `npm run lint`, `npm run test:fast`. Note tests that
   already fail.

## Phase 1: Reproduce and confirm the cause

1. `npm run dev`, import a short clip from a folder whose path contains a space and a non-ASCII character
   (e.g. `D:\テスト clips\a #1.mp4`; generate it with `build\ffmpeg\bin\ffmpeg.exe -f lavfi -i testsrc2=size=1920x1080:rate=60 -t 3 ...`).
2. Open DevTools (renderer) and record: the exact `src` of the card `<img>` and the `<video>`, and the console/network
   errors (e.g. `ERR_FILE_NOT_FOUND`, `ERR_INVALID_URL`, "Not allowed to load local resource").
3. Confirm the thumbnail file exists on disk (`Test-Path`), and where thumbnails are stored (`main/thumbnail.ts`).
4. Write down which of the suspected causes are real (one, both, or something else). Do not fix before you know.

## Phase 2: Fix

Preferred approach (fixes both causes and works in dev and packaged builds):

1. Register a **custom privileged scheme** in the main process, e.g. `aditor-media://`
   (`protocol.registerSchemesAsPrivileged` before `app.whenReady`, with `standard`, `secure`, `stream: true`,
   `supportFetchAPI`; then `protocol.handle`). Serve files with `net.fetch(pathToFileURL(p).href)` so **HTTP range
   requests** work (required for `<video>` seeking).
2. **Security:** only serve files the app knows about — paths in the library, thumbnail cache, proxy cache and
   project media (reuse `app/src/main/safe-path.ts` / `media-cache.ts` helpers). Reject anything else with 403/404,
   reject `..` traversal, and normalize case/separators on Windows. Do not enable `webSecurity: false`, disable the
   sandbox or allow arbitrary `file://` navigation.
3. Replace `fileUrl()` with one helper that builds the custom-scheme URL from a Windows or POSIX path, encoding
   `#`, `?`, `%`, spaces and non-ASCII correctly, and handling drive letters and UNC paths. Use it everywhere media
   is loaded: library thumbnails, Studio source video, proxy video, highlight cards, `ExportPreview.tsx`,
   `SameDayVideos.tsx`, timeline thumbnails (search for every `fileUrl` / `thumbnailUrl` / `file://` use in
   `app/src/renderer`).
4. Update the CSP (if any) to allow the new scheme for `img-src` and `media-src` only.
5. If a custom protocol is not possible for a reason you find, the minimum fix is `file:///` + drive path (and
   `file://host/share` for UNC) — but then prove playback works under `npm run dev` too, or explain why it doesn't.
6. Make the "Video cannot be played" notice distinguish **missing file** (check existence via IPC) from **cannot be
   decoded** (suggest the existing proxy generation), with translated text in every locale under
   `app/src/renderer/i18n/`.
7. Minor: show deaths in `SameDayVideos.tsx` the same way the library card does (`Kills n · Deaths n · 0:20`), with
   i18n keys.

No engine, recorder or detection changes. No new runtime dependencies.

## Phase 3: Tests

- Unit tests for the URL helper: `C:\v\a.mp4`, `D:\テスト clips\a #1?.mp4`, `\\server\share\a 100%.mp4`,
  `/Users/x/a.mp4`, lowercase drive letter. Fix the old tests in `seekPlan.test.ts` and `recordedTime.test.ts` that
  asserted the wrong `file://C:/` form.
- Unit tests for the protocol handler: allowed library file → 200; range request → 206 with correct
  `Content-Range`; unknown path → 403/404; `..` traversal → rejected; missing file → 404.
- Real test: generate a 3 s clip in a temp folder with a space and non-ASCII name, request it through the handler with a
  range header and check bytes and status.
- `notices.test.ts`: missing vs undecodable cases. `SameDayVideos.test.tsx`: deaths shown.
- If the e2e suite runs on this machine (`npm run test:e2e`), add a check that a library card's `<img>` has
  `naturalWidth > 0` and the Studio `<video>` reaches `readyState >= 2`.

## Phase 4: Verify

1. `npm run typecheck`, `npm run lint`, `npm run test:fast` — nothing that passed in the baseline may fail.
2. `npm run dev`: import clips from (a) a normal path, (b) a path with spaces/`#`/non-ASCII, (c) another drive.
   Confirm every library thumbnail renders, every video opens and plays in Studio, seeking works, and no console
   errors. Take screenshots of the library and the Studio player.
3. Packaged build: `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`, install as a normal user, repeat
   step 2. If you can't build on this machine, say so and what you verified instead.
4. Existing libraries: confirm entries imported **before** the fix now show thumbnails and play without re-import.
5. Rename a source file on disk and confirm Studio shows the "missing file" notice and Relink works.

## Phase 5: Docs, commit, push

1. Add an entry to `CHANGELOG.md` (top "Valorant Editor" section → Fixed) and a note in
   `docs/windows-readiness-results.md`.
2. Focused commits, e.g. `Serve library media through a safe custom protocol (fixes Windows thumbnails/playback)`,
   `Distinguish missing vs undecodable video in Studio notice`, `Show deaths in same-day video list`. Each message
   ends with the attribution line Claude Code uses. Don't commit `node_modules`, `build\`, videos or scratch files.
3. `git push -u origin fix/windows-media-urls` to `https://github.com/Fairoz007/valorant-edit`. Never force-push or
   push to `main`. Open a PR into `main` with `gh pr create`: root cause, fix, test results, screenshots.
4. Final report: confirmed root cause(s) with the evidence, files changed, test results with counts, what was
   verified by hand (dev / packaged), what could not be verified, branch and PR link.
