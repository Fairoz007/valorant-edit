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
