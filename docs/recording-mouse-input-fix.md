# Mouse stops working after recording starts — findings and fix

Date: 2026-11-15. Machine used for measurements: Windows 11 Pro build 26300, RTX 2060 (driver 621.24), 2560×1440 display,
Node 24.13.0 (libuv 1.51.0), Electron 45.0.0. VALORANT and Vanguard (`vgc`) are installed but were **not running**: no match
was played for this investigation (see "What is still unverified").

## Symptoms

Reported: once a recording starts, the mouse stops working in VALORANT and/or on the desktop. The report gives no capture
method, display mode or Windows build.

## What was checked, and how

Each hypothesis from the task was tested in order. "Measured" means a command was run on this machine and its output read;
"read" means source inspection only.

### 1. Focus theft (app windows, toasts, dialogs) — no direct cause found, two latent paths fixed

- **Read:** every `show()`, `focus()`, `moveTop()`, `flashFrame()`, dialog and `new BrowserWindow()` in `app/src/main`.
  - `showMainWindow()` (show + focus) is called by the tray, a second launch, macOS `activate`, the quit-blocked handler and
    `onGameExit`. `onGameExit` only fires after two consecutive polls see no game process (`GameWatcher` debounce), and
    the process is matched by its exact image name, so it does not fire while the game runs.
  - **Latent path 1:** the main window used `win.on('ready-to-show', () => { show(); focus() })`. Electron 45 emits
    `ready-to-show` from `WebContents::OnFirstNonEmptyLayout`, i.e. on *every* new document. Reloading a window hidden in the
    tray (a language change reloads the renderer) would therefore show and focus it over the game.
  - **Latent path 2:** the quit-blocked handler opens a modal `dialog.showErrorBox`, which takes the foreground.
  - The Auto-montage caption renderer creates a hidden offscreen `BrowserWindow` (`show: false`) while the game may be in front;
    it never shows, but it was focusable.
- **Measured:** every child process the app spawns (`aditorrec`, the live engine, FFmpeg cuts, `tasklist`, PowerShell storage probe)
  uses `windowsHide: true` (checked call by call), so no console window flashes.
- Windows toasts (`notify.ts`) are shown by the shell without activation. They do not take focus.

### 2. Cursor composition side effects — ruled out (measured)

- **Read:** `grep` over the whole `recorder/` tree found no `SetCursor`, `ShowCursor`, `ClipCursor`, `SetCapture`,
  `SetCursorPos`, `SetWindowsHookEx`, `RegisterRawInputDevices`, `BlockInput`, `SendInput`, `SetForegroundWindow` or
  `AttachThreadInput`. Cursor capture only reads (`GetCursorInfo`, `GetIconInfo`, DDA pointer shapes) and draws the icon into
  the recorder's own texture (`DrawIconEx` on a private surface DC).
- **Measured:** new test `recorder/tests/e2e_recording.rs` → `wgc_recording_never_touches_focus_or_cursor` and
  `dda_recording_never_touches_focus_or_cursor` (ignored by default: they need an interactive desktop). The test clips
  the cursor to a window, as a game holding the mouse does. It then records with `capture_cursor: true` and samples the
  foreground window, the cursor clip rectangle and the cursor visibility every 20 ms before, during and after the recording:

  ```
  dda: 272 samples, recorder CPU 8.1% of one core (0.51% of machine), clip (0, 0, 2560, 1440), cursor_flags 1
  wgc: 272 samples, recorder CPU 6.9% of one core (0.43% of machine), clip (0, 0, 1280, 720), cursor_flags 1
  test result: ok. 2 passed
  ```

  Foreground, clip and cursor never changed. Windows' foreground lock would not let the test process activate its own
  window, so the window that stayed in front was the user's terminal. The assertion is the same either way: the recorder
  never moved the focus.

### 3. CPU/GPU starvation — ruled out for the recorder (measured), priorities tightened

- **Measured:** the recorder used 7–8 % of one core (≈0.5 % of the machine) while recording, see above.
- **Read:** `aditorrec` lowers its own process to `BELOW_NORMAL_PRIORITY_CLASS`. The only boost is the WGC frame callback thread
  set to `THREAD_PRIORITY_HIGHEST`, which inside a below-normal process is base 8, i.e. normal priority, not above the game.
  If `SetPriorityClass` had failed, that same call would have put the thread at base 10, above the game. It now
  only raises the thread when the process really is below normal (`recorder/src/session.rs`). The live engine runs at
  `PRIORITY_BELOW_NORMAL` (`live-engine.ts`). No `timeBeginPeriod`, MMCSS or GPU scheduling-priority calls exist.
- Not measured: the live engine's CPU while a real VALORANT match is on screen.

### 4. Anti-cheat reaction — **the app opened a terminate-rights handle to VALORANT every 3 seconds** (proven)

- **Read:** `createGameProcessFinder()` (`app/src/main/recording/game-watcher.ts`) checked whether the game was still running
  with `process.kill(pid, 0)` on 9 of every 10 polls, i.e. every 3 s from the moment the game was detected (recording starts
  at the same time) until it closed.
- **Read:** libuv 1.51.0 (the version in this Node), `src/win/process.c`:

  ```c
  int uv_kill(int pid, int signum) {
    ...
    process_handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, pid);
  ```

  So "signal 0" is not a harmless probe on Windows: it opens the game with **terminate** rights.
- **Measured:** `process.kill(pid, 0)` on this machine returns `EPERM` for protected processes (MsMpEng, csrss) and succeeds for
  a normal one, while `tasklist` lists the same protected PIDs fine. The call really requests rights that a protected
  process refuses. The old code treated `EPERM` as "alive" and kept repeating it.
- Opening a Vanguard-protected game process with `PROCESS_TERMINATE` every 3 s is exactly the "handle opens against the game
  process" pattern anti-cheat watches. Nothing else in the app or recorder opens the game process. The recorder finds the
  window with `EnumWindows`/`GetWindowThreadProcessId` and captures through WGC/DDA without a process handle. The OBS hook
  is already disabled for VALORANT, and game-only audio uses process loopback through the audio service.
- No input hooks exist anywhere (`grep` over `app/src`, `recorder/src`, `engine/src` for `SetWindowsHookEx`,
  `globalShortcut`, `uiohook`, raw input).

## Root cause

Of the four hypotheses, the only behaviour found that touches the game and starts with recording is #4. The app opened
`VALORANT-Win64-Shipping.exe` with `PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE` every 3 seconds through
`process.kill(pid, 0)`. Focus theft, cursor writes and CPU starvation were measured or read and ruled out for normal
operation. The two latent focus paths (a reload of a tray-hidden window, the quit-blocked error box) do not fire during a
normal recording, but they would cause exactly this symptom when they do.

**What is still unverified:** that Vanguard reacts to that handle by blocking mouse input. Confirming it needs a real
VALORANT match on Windows with the old and new build, which was not done here. Riot does not document Vanguard's
reactions.

## Fix

1. **No handle to the game, ever.** `createGameProcessFinder()` now asks `tasklist` (image name, system process list) on
   every poll and never calls `process.kill`. Cost measured: 163 ms wall / ~16 ms CPU per query, ≈0.5 % of one core at the
   3 s poll. `game-watcher.test.ts` fails if `process.kill` is called.
2. **No focus while the game is in front** (`app/src/main/focus-guard.ts`). Anything that can take the foreground goes through
   `focusGuard.run()`: showing or focusing the main window, the startup `ready-to-show` and the quit-blocked error box.
   When the game is the foreground window, the action waits and is retried every 2 s, and runs as soon as the game
   loses focus or exits.
   - The foreground comes from `aditorrec --foreground <pid>` (`recorder/src/foreground.rs`): `GetForegroundWindow`,
     `GetWindowThreadProcessId`, `IsIconic`, `GetWindowRect`, `MonitorFromWindow` and `SHQueryUserNotificationState`.
     These are window-manager queries only, with no process handle. It takes ~26 ms per query.
   - An unknown foreground (query failed) blocks automatic actions but not a direct user request such as a tray click.
3. `ready-to-show` is handled once, so a reload of a hidden window never shows it again.
4. The caption renderer window is `focusable: false` and `skipTaskbar: true`.
5. `focus-rule.test.ts` scans `app/src/main` and fails when a new `show`/`focus`/`moveTop`/`flashFrame`/dialog/`new BrowserWindow`
   call appears outside the reviewed list.
6. Diagnostics: the main window's focus and blur events are written to `recording.log` with the game PID. A future report
   can then show whether our window ever took focus during a match.
7. The recorder only raises its frame-callback thread when its process is below normal (see 3 above).

## Rules that keep it fixed

- While a supported game is the foreground window, the app never calls `show()`, `focus()`, `moveTop()`, `flashFrame()`, opens a
  dialog or creates a focusable window; the in-game overlay uses `showInactive()` on a `focusable: false` window only.
- The recorder never changes cursor state, never installs input hooks and never opens the game process.
- Priority boosts stay limited to restoring normal priority for short callbacks inside the below-normal recorder.

## Still to check on a gaming PC

Start VALORANT (Windowed Fullscreen) with the old build, confirm the mouse stops, then install this build and confirm it
does not. `recording.log` should show no `main window focus` line during the match.

---

# Follow-up (2026-11-16): pointer missing in VALORANT menus, overlay on top of the game

Measured on the same machine as above: Windows 11 Pro build 26300, RTX 2060, one 2560×1440 monitor at 100 %, Electron 45.
This time VALORANT was running. The user was asked about the symptoms and took part in two live tests; the tests are reported
below exactly as far as they went.

## Exact symptom (from the user and recording.log)

| Question | Answer |
| --- | --- |
| Where is the pointer missing? | On screen in VALORANT menus / agent select. Not "only in the video", not the desktop. |
| When does it come back? | First answer: "when recording stops". Asked again against a clean baseline: **fine at first; once the app has recorded, it stays gone until VALORANT is restarted.** |
| Capture method | WGC (`recording.log`: `capture=wgc` for every session; "Record mouse cursor" on). |
| What does "overlay on top" look like? | **The game minimizes / alt-tabs when a card appears**, and **the overlay stays visible**. No complaint about a box, the size or the position. |
| VALORANT display mode | **Fullscreen** with a stretched 4:3 resolution (`recording.log`: `game aspect 1920x1440` on a 2560×1440 monitor). |
| Monitors / scale | One monitor, 2560×1440, 100 % (measured). |

`recording.log` also shows `focus-guard: running deferred main-window` and `main window focus (game pid 38404)` during the
03:05–03:10 sessions, while the game was still running. The guard let the main window show because the game was no longer the
foreground window, which fits the game having been minimized first.

Side finding (fixed, see "Fix" item 7): two sessions were encoded at `6170x1080`, and a test recording at `4114x720`. A minimized
window's rect is `-32000,-32000 160x28` (measured), and 160/28 × 1080 = 6171. So a recording that starts while the game is minimized
takes its output aspect from the minimized window.

## What was measured

Tools (scratch, not committed): a read-only probe logging `GetCursorInfo` (flags, handle), `WindowFromPoint`, `GetForegroundWindow`,
`GetClipCursor`, `SHQueryUserNotificationState` and our windows' styles every 50–100 ms. Plus a driver that records VALORANT with
the standalone `aditorrec` (WGC with and without the cursor, DDA) and shows overlay-style cards, with beeps marking each phase.
`recorder/tools/rec-cli.ps1` got a `-NoCursor` switch for the same comparison.

1. **The overlay window as the app leaves it:** `Valorant Editor overlay`, `ex=0x08280028` (NOACTIVATE | LAYERED |
   NOREDIRECTIONBITMAP | TRANSPARENT | TOPMOST), display affinity 17 (WDA_EXCLUDEFROMCAPTURE), 440×220 in the top-right corner, and
   **kept alive, hidden and topmost** after the last card. The overlay page set `cursor: default`. With the window click-through
   this does not reach the game, but it broke the rule that the overlay page never sets a CSS cursor.
2. **Live test 1 (contaminated):** Valorant Editor was still running, and VALORANT had been open since the app's earlier
   recordings. The user reported the pointer missing in every phase and "cursor not even working in menu", so it was already
   gone before the test started. In the probe, VALORANT also hides the OS cursor itself (`flags=0`) in the gaps with no recorder
   running, so `GetCursorInfo` alone cannot tell the game's own hiding from a fault. **No conclusion about WGC vs DDA could be drawn.**
3. **Live test 2 (clean baseline):** VALORANT freshly started with Valorant Editor closed, pointer confirmed working. A 30 s WGC
   recording ran, but the probe shows Chrome was the foreground window for the whole run (the user was not at the game), so it
   says nothing about the pointer. A further 4-minute passive probe never saw VALORANT in front either.
4. **Electron-side cursor check** (`app/scripts/verify-overlay-cursor.cjs`, new). It puts the real overlay window and page over a
   focused, borderless test window with its own crosshair cursor, with the pointer inside the card area. 140 samples at 50 ms
   before, during and after three cards:

   ```
   gameWasForeground: true, pointerInOverlayArea: true
   flags ["1"], cursors ["65545"] (0x10009, the test window's crosshair), foreground [one hwnd], clip ["[0,0,2560,1440]"]
   underWhileOverlay: the test window only
   PASS: pointer, foreground and clip unchanged while the overlay came and went
   ```

   The overlay window never takes the cursor, hit-testing or the foreground from the window below it. That was a desktop window,
   not a Fullscreen D3D game.
5. **Read:** the recorder still has no call that writes window, focus or cursor state. A `grep` for ShowWindow, SetWindowPos,
   SendMessage/PostMessage, SetForegroundWindow, SetFocus, AttachThreadInput, SetCursor, ShowCursor, ClipCursor, SetCapture,
   SetWindowDisplayAffinity, hooks and OpenProcess finds only `GetDC`/`ReleaseDC` on the recorder's own surface. Every poll still
   spawns with `windowsHide: true`.
6. **Read:** `createOverlayPlacement` returned `screen` whenever a game PID existed, even when the game was **not** in front.
   It fell back to the last monitor, then the primary display, so cards appeared over the desktop or other apps after the game
   minimized. The only Fullscreen test was `SHQueryUserNotificationState() == QUNS_RUNNING_D3D_FULL_SCREEN`. Windows 11 runs
   "Fullscreen" games with fullscreen optimizations, which normally do not report that state. So on every card, a Fullscreen
   VALORANT got a topmost window placed over it (re-asserted with `setAlwaysOnTop(true, 'screen-saver')`).
7. Public reports (OBS forum) describe the pointer disappearing from the real display while a WGC capture of a fullscreen game
   runs, VALORANT included. They give no cause or fix, and nothing here reproduced it. The app's own capture-method help already
   says that WGC "adds mouse latency in the lobby", so WGC is known to affect the pointer in VALORANT menus in some way.

## Root cause (best supported, not proven in a match)

- **Overlay on top, game minimizes, overlay stays visible:** proven in code. The overlay was shown over a Fullscreen game, because
  Fullscreen was not detected, and also when the game was not in front, through the fallback monitor. The user's Fullscreen +
  stretched setup is exactly the case the old check missed. The game minimizing when a topmost window appears over it is the
  user's report; it was not reproduced here.
- **Pointer gone until VALORANT restarts:** most likely a consequence of the above. The pointer was fine with no app running and
  broken after the app had recorded. The recording session is when the overlay showed its cards (status, match, kills) over the
  Fullscreen game, which then minimized. That an unrequested minimize leaves VALORANT's menu pointer hidden until a restart is
  inferred from the user's sequence and was **not measured**. The WGC capture itself is still a second suspect that was not ruled out (item 7).

## Fix

1. `decidePlacement()` (`app/src/main/overlay/overlay-window.ts`, pure and unit tested) shows a card **only while the game is the
   foreground window** and not in Fullscreen:
   - Game not in front: no overlay, a toast now.
   - Exclusive fullscreen, a changed display mode (Fullscreen at its own resolution), an unknown foreground, no capture
     exclusion, or no GPU compositing (no real transparency, `transparencyAvailable()`): no overlay, a toast after the game
     loses focus.
   - The last/primary monitor fallback is gone.
2. `aditorrec --foreground` now reports `display_mode_changed` (current vs registry mode of the game's monitor, from
   EnumDisplaySettingsW) and `covers_monitor`. Both are read-only queries, unit tested in `foreground.rs`.
3. The overlay window **exists only while a card is on screen**:
   - It is destroyed, not hidden, after the last card.
   - While a card shows, the placement is re-checked every second. The window is destroyed at once when the game leaves the
     foreground or goes Fullscreen, and a new card arriving in that state also removes the old one.
   - The topmost level is set once at creation, never per card. It is `'floating'`; on Windows every Electron level above
     normal is the same HWND_TOPMOST band.
   - It is still shown with `showInactive()` only.
4. The overlay is **off by default** (settings version 4). Files from before version 4 stored the old default `true`, which cannot
   be told apart from a choice, so it is turned off once. From version 4 an explicit on or off is kept. Settings and onboarding
   say that Fullscreen shows no cards.
5. Every toast goes through the focus guard, also with the overlay off: shown at once when the game is not in front, otherwise
   after it loses focus.
6. The overlay page sets no CSS cursor (tested). The "Record mouse cursor" help text says it only changes the video.
7. **Recording size when the game is minimized at start** (`recorder/src/capture/mod.rs`). WGC reports a minimized window's
   placeholder size, and the first size fixes the session's output size. A window that is minimized when recording starts now
   begins in the existing minimized fallback: a monitor capture, black until the window is restored, after which the normal
   restore check switches back to window capture. `wgc_recovers_when_minimized_and_can_restart_while_minimized` now checks
   the output size of a start while minimized. Without the fix that start failed with NVENC "Invalid argument" (a size built
   from 160×28 at native height); at the app's 1080p setting the same path gave the 6170×1080 files. With the fix it passes.

Rules kept:
- The recorder and the app never call SetCursor, ShowCursor, ClipCursor, SetCapture or SetCursorPos.
- The overlay never changes the cursor flags or the handle seen over the window below it (`verify-overlay-cursor.cjs`).
- `verify-overlay-capture.cjs` still passes: 0 overlay pixels in the DDA and WGC frames with content protection, 84 in the
  unprotected DDA control.

## What is still unverified

- **This build was not checked in a real VALORANT match or menu.** The live tests could not be completed (items 2–3). Still to do
  on the gaming PC:
  1. Fullscreen (stretched): turn the overlay on and record a match. Expect no card, no minimize, the pointer working in menus,
     and toasts after leaving the game.
  2. Windowed Fullscreen: cards appear in the corner only while the game is in front, and nothing after alt-tab. The pointer
     works in menus, agent select and the buy menu. The saved MP4 has the pointer and no overlay.
  3. Then check whether the pointer still disappears with the overlay **off**, i.e. with the WGC capture alone. If it does,
     try DDA. If DDA is clean, the WGC capture of a fullscreen window is the cause.
- Native-resolution Fullscreen does not change the display mode. Window-manager queries cannot tell it from Windowed Fullscreen,
  so it is not detected; only the default-off setting and the Settings note protect that case.
- Frame pacing with and without cards was not measured: there was no PresentMon run with the game in front.
- 125 % / 150 % scaling and a second monitor are covered by unit tests of the DIP conversion and the corner bounds, not on real
  displays.
- Recorder `cargo test`: 3 GPU encode tests fail on this machine, both on this branch and on an unmodified checkout of `68870d4`:
  `gpu_recording_and_scaling_have_independent_keyframe_segments` and the two `gpu_static_capture_*` tests. They assume an
  RTX 5080 with AV1 NVENC; this machine has an RTX 2060.
