// Real-Windows check of the in-game overlay: the built overlay page + preload with the app's window options, recorded by the
// real aditorrec with DDA and WGC while whatever window is in front stays in front.
// Control: the same window WITHOUT content protection must show up in the DDA frame (proves the detector works).
//
// Usage (Windows, after `npm run build` and `cargo build --release` in recorder/):
//   set FFMPEG_PNG=<an ffmpeg.exe with a PNG encoder>   (the bundled LGPL build has none)
//   node_modules\electron\dist\electron.exe scripts\verify-overlay-capture.cjs [outDir]
// Writes results.json, overlay-cards.png and frame-*.png to outDir (default: %TEMP%\overlay-capture-check).
const { app, BrowserWindow, screen } = require('electron')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('-') && !a.endsWith('.cjs')) ?? path.join(os.tmpdir(), 'overlay-capture-check'))
fs.mkdirSync(OUT, { recursive: true })
const REC = path.join(REPO, 'recorder', 'target', 'release', 'aditorrec.exe')
const FFBIN = path.join(REPO, 'build', 'ffmpeg', 'bin')
const FFMPEG_PNG = process.env.FFMPEG_PNG || 'ffmpeg' // needs a PNG encoder; the bundled LGPL build has none
const env = { ...process.env, PATH: `${FFBIN};${process.env.PATH}` }

// Copied verbatim from app/src/main/overlay/overlay-window.ts OVERLAY_WINDOW_OPTIONS.
const OVERLAY_WINDOW_OPTIONS = {
  width: 440, height: 220, show: false, transparent: true, frame: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
  resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
  backgroundColor: '#00000000', title: 'Valorant Editor overlay'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fg = (pid = 0) => JSON.parse(execFileSync(REC, ['--foreground', String(pid)], { env }).toString())

let shared = null
async function overlay(protect, display) {
  if (shared) { shared.setContentProtection(protect); shared.showInactive(); await sleep(900); return shared }
  const win = shared = new BrowserWindow({
    ...OVERLAY_WINDOW_OPTIONS,
    webPreferences: { preload: path.join(REPO, 'app', 'out', 'preload', 'overlay.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  win.setIgnoreMouseEvents(true)
  win.setContentProtection(protect)
  win.setAlwaysOnTop(true, 'floating') // OVERLAY_TOPMOST_LEVEL
  await win.loadFile(path.join(REPO, 'app', 'out', 'renderer', 'overlay', 'index.html'))
  win.setBounds({ x: display.x + display.width - 440 - 24, y: display.y + 24, width: 440, height: 220 })
  const cards = [
    { id: 'saved', tone: 'ok', icon: 'save', title: 'Saved', detail: 'Valorant 21-04.mp4', durationMs: 60000 },
    { id: 'kill', tone: 'kill', icon: 'crosshair', title: 'ACE', detail: 'Round 7', durationMs: 60000 },
    { id: 'rec', tone: 'rec', icon: 'rec', title: 'Recording', detail: 'DDA capture', durationMs: 60000 }
  ]
  for (const card of cards) {
    win.webContents.send('overlay:card', { card, position: 'topRight', opacity: 0.9 })
    await sleep(150)
  }
  win.showInactive()
  await sleep(900)
  return win
}

function record(pid, capture, dir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true })
    const p = spawn(REC, [], { env, windowsHide: true })
    let buf = ''
    const seen = []
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { seen.push(JSON.parse(line)) } catch {} }
    })
    p.on('error', reject)
    p.stdin.write(JSON.stringify({ id: 1, cmd: 'start', pid, session_dir: dir, session_id: `ov-${capture}-${Date.now()}`,
      encode: { codec: 'h264', encoder: 'auto', fps: 30, height: 0, bitrate_kbps: 30000 }, audio: null,
      frames: { banner: [220, 240, 96, 48], spec: [960, 540, 96, 48], base: [1920, 1080] }, capture, capture_cursor: false }) + '\n')
    setTimeout(() => p.stdin.write(JSON.stringify({ id: 2, cmd: 'stop' }) + '\n'), 3500)
    setTimeout(() => { p.stdin.end() }, 5500)
    p.on('exit', () => resolve(seen))
  })
}

function frameOf(dir, png) {
  const idx = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
  const parts = [fs.readFileSync(path.join(dir, 'init.mp4')), ...idx.map((e) => fs.readFileSync(path.join(dir, `seg_${String(e.seq).padStart(6, '0')}.m4s`)))]
  const mp4 = path.join(dir, 'joined.mp4')
  fs.writeFileSync(mp4, Buffer.concat(parts))
  execFileSync(FFMPEG_PNG, ['-v', 'error', '-y', '-sseof', '-1', '-i', mp4, '-frames:v', '1', png])
  return mp4
}

/** Count overlay stripe pixels (#ff5a1f / #ff4a1c / #14b88a) in the top-right overlay area of a decoded frame. */
function stripePixels(png, region) {
  const { nativeImage } = require('electron')
  const img = nativeImage.createFromPath(png)
  const { width, height } = img.getSize()
  const bmp = img.toBitmap() // BGRA
  let hits = 0
  const x0 = Math.max(0, Math.round(region.x)), y0 = Math.max(0, Math.round(region.y))
  for (let y = y0; y < Math.min(height, y0 + region.h); y++) {
    for (let x = x0; x < Math.min(width, x0 + region.w); x++) {
      const i = (y * width + x) * 4
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]
      const near = (R, G, B) => Math.abs(r - R) < 18 && Math.abs(g - G) < 18 && Math.abs(b - B) < 18
      if (near(255, 90, 31) || near(255, 74, 28) || near(20, 184, 138)) hits++
    }
  }
  return { hits, width, height }
}

app.whenReady().then(async () => {
  const results = { runs: [] }
  try {
    const before = fg(0)
    const target = before.foreground_pid
    const info = fg(target)
    results.target = { pid: target, monitor: info.monitor_rect }
    const dip = screen.screenToDipRect(null, { x: info.monitor_rect[0], y: info.monitor_rect[1], width: info.monitor_rect[2], height: info.monitor_rect[3] })
    const scale = info.monitor_rect[2] / dip.width
    // Overlay area in captured-frame pixels (the frame is the monitor for DDA; for WGC it is the window, same origin when maximized).
    const region = { x: (dip.width - 440 - 24) * scale, y: 24 * scale, w: 440 * scale, h: 220 * scale }
    results.region = region
    for (const [protect, capture] of [[true, 'dda'], [true, 'wgc'], [false, 'dda']]) {
      const win = await overlay(protect, dip)
      if (protect && capture === 'dda') {
        const page = await win.webContents.capturePage()
        fs.writeFileSync(path.join(OUT, 'overlay-cards.png'), page.toPNG())
      }
      const fgDuring = fg(target)
      const dir = path.join(OUT, `rec-${capture}-${protect ? 'protected' : 'control'}`)
      fs.rmSync(dir, { recursive: true, force: true })
      const seen = await record(target, capture, dir)
      const fgAfter = fg(target)
      win.hide()
      const started = seen.find((e) => e.ev === 'started')
      const png = path.join(OUT, `frame-${capture}-${protect ? 'protected' : 'control'}.png`)
      let px = null, error = null
      try { frameOf(dir, png); px = stripePixels(png, region) } catch (e) { error = String(e) }
      results.runs.push({ protect, capture, started: started ? `${started.width}x${started.height}` : null, errors: seen.filter((e) => e.ev === 'error' || e.ok === false),
        foregroundUnchanged: fgDuring.foreground_pid === target && fgAfter.foreground_pid === target, overlayStripePixels: px, error })
    }
    results.foregroundBefore = before.foreground_pid
    results.foregroundEnd = fg(0).foreground_pid
  } catch (e) {
    results.fatal = String(e && e.stack || e)
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  app.quit()
})
