# Prompt: Build the Windows app and install it locally

Copy everything below the line into a new Claude Code session opened at the repository root
(`C:\valorant-edit`). Work through the steps in order and do not skip a step.

---

You are working on **Valorant Editor**, an Electron + React + TypeScript desktop app with a Rust analysis engine
(`engine/`), a Rust recorder (`recorder/`), a pinned LGPL FFmpeg and the OBS graphics hook. Your job is to produce a
fresh Windows build and install it on this machine, then confirm the installed app starts.

Never claim a step succeeded unless you ran it and saw it succeed. If a step fails, stop, show the relevant error
lines and fix the cause; do not skip verification steps or pass flags that disable them.

## 1. Check the toolchain

Run and report versions: `cargo --version`, `node --version`, `npm --version`. Rust needs the MSVC linker: check `vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64`; if missing, ask the user before installing Build Tools with `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` (needs an admin prompt). If `app/node_modules` is missing, run
`npm ci` in `app/`. Make sure `git status` is clean, or tell the user which files are modified before building.

## 2. Build

From the repo root, run the full build (it takes several minutes; run it in the background and wait for it):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

This does, in order: Rust engine (`build/engine/aditor/aditor.exe`), pinned FFmpeg fetch with SHA256 check, OBS
hook fetch with SHA256 + Authenticode check, Rust recorder, `verify-live-engine.ps1`, `electron-vite build`, and
`electron-builder --win`. Only use `-SkipEngine` / `-SkipFfmpeg` / `-SkipObsHook` if the user asks.

When it finishes, list `dist\` and confirm both artifacts exist with their sizes:

- `dist\ValorantEditor-Setup-<version>.exe` (NSIS installer)
- `dist\ValorantEditor-<version>-Portable.exe`

`<version>` comes from `app/package.json`.

## 3. Install

1. If Valorant Editor is running, quit it (`Get-Process "Valorant Editor" -ErrorAction SilentlyContinue | Stop-Process`).
2. Run the installer silently for the current user:

   ```powershell
   Start-Process -FilePath "dist\ValorantEditor-Setup-<version>.exe" -ArgumentList "/S" -Wait
   ```

   The installer is per-user by default and lands in `%LOCALAPPDATA%\Programs\Valorant Editor\`.
3. Confirm `Valorant Editor.exe` exists there and that `resources\engine\aditor\aditor.exe`,
   `resources\ffmpeg\bin\ffmpeg.exe`, `resources\ffmpeg\bin\aditorrec.exe` and `resources\obs-hook\` are present.
4. Confirm the uninstall entry exists under `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\` with the
   expected `DisplayVersion`.

## 4. Smoke test

Launch the installed exe, wait ~10 seconds, and confirm the process is still running and has a main window
(`(Get-Process "Valorant Editor").MainWindowTitle`). Then close it. Report anything unexpected in the app's log
folder (`%APPDATA%\valorant-editor\logs` if present).

## 5. Report

Tell the user: the version built, artifact paths and sizes, the install path, the smoke-test result, and anything
that failed or was skipped. Do not commit, tag or publish a release unless the user asks.
