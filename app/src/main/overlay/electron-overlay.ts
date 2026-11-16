import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { applyWindowSecurity } from '../window-security'
import { decidePlacement, OVERLAY_WINDOW_OPTIONS, supportsCaptureExclusion, type OverlayBrowserWindow, type OverlayPlacement } from './overlay-window'
import type { ForegroundInfo } from '../foreground'

/** Creates the real overlay BrowserWindow (options in OVERLAY_WINDOW_OPTIONS) and loads the overlay page. */
export function createElectronOverlayWindow(): OverlayBrowserWindow {
  const win = new BrowserWindow({
    ...OVERLAY_WINDOW_OPTIONS,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  applyWindowSecurity(win.webContents)
  const loaded = process.env.ELECTRON_RENDERER_URL
    ? win.loadURL(new URL('overlay/index.html', process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '/')).toString())
    : win.loadFile(join(__dirname, '../renderer/overlay/index.html'))
  const ready = loaded.then(() => undefined, (error) => { console.error('[overlay] Failed to load the overlay page:', error) })
  return {
    setIgnoreMouseEvents: (ignore) => win.setIgnoreMouseEvents(ignore),
    setContentProtection: (enable) => win.setContentProtection(enable),
    setAlwaysOnTop: (flag, level) => win.setAlwaysOnTop(flag, level),
    setBounds: (bounds) => win.setBounds(bounds),
    showInactive: () => win.showInactive(),
    hide: () => win.hide(),
    isVisible: () => win.isVisible(),
    isDestroyed: () => win.isDestroyed(),
    destroy: () => win.destroy(),
    send: (channel, frame) => { if (!win.webContents.isDestroyed()) win.webContents.send(channel, frame) },
    ready: () => ready
  }
}

/** Real transparency needs GPU compositing; without it a "transparent" window can render as an opaque box over the game. */
export function transparencyAvailable(): boolean {
  try {
    if (!app.isHardwareAccelerationEnabled()) return false
    return String(app.getGPUFeatureStatus().gpu_compositing ?? '').startsWith('enabled')
  } catch {
    return false
  }
}

/** Placement from the game's window (rules in decidePlacement): only its own monitor, only while it is in front and not Fullscreen. */
export function createOverlayPlacement(deps: { gamePid: () => number | null; queryForeground: (pid: number) => Promise<ForegroundInfo | null> }): () => Promise<OverlayPlacement> {
  return async () => {
    const gamePid = deps.gamePid()
    const info = gamePid === null ? null : await deps.queryForeground(gamePid)
    return decidePlacement({
      captureExclusion: supportsCaptureExclusion(),
      transparency: transparencyAvailable(),
      gamePid,
      info,
      toDip: (rect) => screen.screenToDipRect(null, rect)
    })
  }
}

/** Placement for the Settings test button: the display the main window is on. */
export function displayNear(win: BrowserWindow | null): OverlayPlacement {
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  return { kind: 'screen', display: display.bounds }
}
