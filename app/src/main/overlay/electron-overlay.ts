import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { applyWindowSecurity } from '../window-security'
import { OVERLAY_WINDOW_OPTIONS, supportsCaptureExclusion, type OverlayBrowserWindow, type OverlayPlacement, type Rect } from './overlay-window'
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

function toRect([x, y, width, height]: [number, number, number, number]): Rect {
  return { x, y, width, height }
}

/**
 * Placement from the game's window: its monitor while the game is in front (converted to DIP), else the last monitor it was on,
 * else the primary display. Exclusive fullscreen, or a Windows build without capture exclusion, keeps the overlay off.
 */
export function createOverlayPlacement(deps: { gamePid: () => number | null; queryForeground: (pid: number) => Promise<ForegroundInfo | null> }): () => Promise<OverlayPlacement> {
  let lastDisplay: Rect | null = null
  return async () => {
    if (!supportsCaptureExclusion()) return { kind: 'exclusive' }
    const pid = deps.gamePid()
    if (pid === null) return { kind: 'none' }
    const info = await deps.queryForeground(pid)
    if (info?.gameForeground && info.exclusiveFullscreen) return { kind: 'exclusive' }
    if (info?.monitorRect) lastDisplay = screen.screenToDipRect(null, toRect(info.monitorRect))
    return { kind: 'screen', display: lastDisplay ?? screen.getPrimaryDisplay().bounds }
  }
}

/** Placement for the Settings test button: the display the main window is on. */
export function displayNear(win: BrowserWindow | null): OverlayPlacement {
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  return { kind: 'screen', display: display.bounds }
}
