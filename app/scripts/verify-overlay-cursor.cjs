// Real-Windows check that the in-game overlay never changes the mouse pointer or the foreground window.
// A borderless test window stands in for the game (focused, its own CSS cursor, under the pointer). The real overlay window
// (app options, built overlay page, click-through, capture-excluded) then shows three cards and is destroyed, as in the app.
// A sampler reads GetCursorInfo (flags, handle), WindowFromPoint, GetForegroundWindow and GetClipCursor every 50 ms
// before, during and after, and the run fails if any of them changes while the overlay comes and goes.
//
// Usage (Windows, after `npm run build`):
//   node_modules\electron\dist\electron.exe scripts\verify-overlay-cursor.cjs [outDir]
// The pointer is moved into the overlay's corner for the run and put back afterwards. Writes results.json to outDir
// (default: %TEMP%\overlay-cursor-check). Exit code 0 = pass, 1 = fail, 2 = could not run (e.g. the test window never came to the front).
const { app, BrowserWindow, screen } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('-') && !a.endsWith('.cjs')) ?? path.join(os.tmpdir(), 'overlay-cursor-check'))
fs.mkdirSync(OUT, { recursive: true })

// Copied verbatim from app/src/main/overlay/overlay-window.ts (OVERLAY_WINDOW_OPTIONS, OVERLAY_TOPMOST_LEVEL, size and margin).
const OVERLAY_WINDOW_OPTIONS = {
  width: 440, height: 220, show: false, transparent: true, frame: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
  resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
  backgroundColor: '#00000000', title: 'Valorant Editor overlay'
}
const OVERLAY_TOPMOST_LEVEL = 'floating'
const MARGIN = 24

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Read-only sampler; the only write is SetCursorPos for the test setup (never done by the app or the recorder).
const SAMPLER = String.raw`
param([int]$X, [int]$Y, [string]$Stop)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class S {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CI { public int cb; public int flags; public IntPtr h; public POINT pt; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CI c);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, int f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
}
"@
[void][S]::SetProcessDpiAwarenessContext([IntPtr](-4))
$orig = New-Object S+POINT; [void][S]::GetCursorPos([ref]$orig)
[Console]::Out.WriteLine('{"orig":[' + $orig.X + ',' + $orig.Y + ']}')
[void][S]::SetCursorPos($X, $Y)
try {
  while ($true) {
    if (Test-Path -LiteralPath $Stop) { break }
    $c = New-Object S+CI; $c.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][S+CI]); [void][S]::GetCursorInfo([ref]$c)
    $w = [S]::GetAncestor([S]::WindowFromPoint($c.pt), 2); $r = New-Object S+RECT; [void][S]::GetClipCursor([ref]$r)
    [Console]::Out.WriteLine('{"t":' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + ',"flags":' + $c.flags + ',"cursor":' + $c.h.ToInt64() + ',"pt":[' + $c.pt.X + ',' + $c.pt.Y + '],"under":' + $w.ToInt64() + ',"fg":' + [S]::GetForegroundWindow().ToInt64() + ',"clip":[' + $r.L + ',' + $r.T + ',' + $r.R + ',' + $r.B + ']}')
    Start-Sleep -Milliseconds 50
  }
} finally { [void][S]::SetCursorPos($orig.X, $orig.Y) }
`

function startSampler(x, y) {
  const file = path.join(OUT, 'sampler.ps1')
  fs.writeFileSync(file, SAMPLER)
  const stopFile = path.join(OUT, 'sampler.stop')
  fs.rmSync(stopFile, { force: true })
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-X', String(x), '-Y', String(y), '-Stop', stopFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const samples = []
  let phase = 'setup'
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('{')) continue
      try { const v = JSON.parse(line); if (v.t) samples.push({ ...v, phase }) } catch { /* partial line */ }
    }
  })
  return {
    samples,
    setPhase: (p) => { phase = p },
    stop: () => new Promise((resolve) => { child.on('exit', resolve); fs.writeFileSync(stopFile, ''); setTimeout(() => child.kill(), 3000) })
  }
}

const hwnd = (win) => { const b = win.getNativeWindowHandle(); return Number(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0)) }

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay()
  const b = display.bounds
  // Stand-in for the game: borderless, covering the primary display, its own distinctive cursor.
  const game = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, show: false, backgroundColor: '#203040', title: 'Overlay cursor test (game)' })
  await game.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#203040;cursor:crosshair;height:100vh"></body>'))
  game.show()
  game.focus()
  await sleep(1200)

  // The pointer goes into the middle of the top-right card area, where the overlay will be.
  const ox = b.x + b.width - OVERLAY_WINDOW_OPTIONS.width - MARGIN
  const oy = b.y + MARGIN
  const px = Math.round((ox + OVERLAY_WINDOW_OPTIONS.width / 2) * display.scaleFactor)
  const py = Math.round((oy + 30) * display.scaleFactor)
  const sampler = startSampler(px, py)
  await sleep(1500)
  sampler.setPhase('before')
  await sleep(2000)

  sampler.setPhase('overlay')
  const overlay = new BrowserWindow({
    ...OVERLAY_WINDOW_OPTIONS,
    webPreferences: { preload: path.join(REPO, 'app', 'out', 'preload', 'overlay.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  overlay.setIgnoreMouseEvents(true)
  overlay.setContentProtection(true)
  overlay.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL)
  await overlay.loadFile(path.join(REPO, 'app', 'out', 'renderer', 'overlay', 'index.html'))
  overlay.setBounds({ x: ox, y: oy, width: OVERLAY_WINDOW_OPTIONS.width, height: OVERLAY_WINDOW_OPTIONS.height })
  const overlayHwnd = hwnd(overlay)
  for (const [i, card] of [
    { id: 'rec', tone: 'rec', icon: 'rec', title: 'Recording', detail: 'WGC capture', durationMs: 4000 },
    { id: 'kill', tone: 'kill', icon: 'crosshair', title: 'ACE', detail: 'Round 7', durationMs: 4000 },
    { id: 'saved', tone: 'ok', icon: 'save', title: 'Saved', detail: 'Valorant 21-04.mp4', durationMs: 4000 }
  ].entries()) {
    overlay.webContents.send('overlay:card', { card, position: 'topRight', opacity: 0.9 })
    if (i === 0) overlay.showInactive()
    await sleep(700)
  }
  await sleep(2500)
  overlay.destroy()
  sampler.setPhase('after')
  await sleep(2000)
  await sampler.stop()

  const gameHwnd = hwnd(game)
  const by = (p) => sampler.samples.filter((s) => s.phase === p)
  const set = (list, key) => [...new Set(list.map((s) => JSON.stringify(s[key])))]
  const all = [...by('before'), ...by('overlay'), ...by('after')]
  const before = by('before')
  const result = {
    samples: { before: before.length, overlay: by('overlay').length, after: by('after').length },
    gameHwnd, overlayHwnd,
    gameWasForeground: before.length > 0 && before.every((s) => s.fg === gameHwnd),
    pointerInOverlayArea: by('overlay').every((s) => s.pt[0] === px && s.pt[1] === py),
    flags: set(all, 'flags'), cursors: set(all, 'cursor'), foreground: set(all, 'fg'), clip: set(all, 'clip'),
    underWhileOverlay: set(by('overlay'), 'under')
  }
  const failures = []
  if (!result.gameWasForeground) failures.push('setup: the test window was not the foreground window (Windows foreground lock); run from an interactive desktop')
  if (result.flags.length !== 1 || result.flags[0] !== '1') failures.push(`cursor flags changed or not CURSOR_SHOWING: ${result.flags}`)
  if (result.cursors.length !== 1) failures.push(`cursor handle changed: ${result.cursors}`)
  if (result.foreground.length !== 1) failures.push(`foreground window changed: ${result.foreground}`)
  if (result.clip.length !== 1) failures.push(`cursor clip changed: ${result.clip}`)
  if (result.underWhileOverlay.includes(String(overlayHwnd))) failures.push('the overlay window was hit-tested under the pointer (not click-through)')
  result.failures = failures
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  console.log(failures.length ? `FAIL (${failures.length})` : 'PASS: pointer, foreground and clip unchanged while the overlay came and went')
  game.destroy()
  app.exit(!result.gameWasForeground ? 2 : failures.length ? 1 : 0)
})
