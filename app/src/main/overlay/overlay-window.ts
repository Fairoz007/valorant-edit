/**
 * The in-game overlay window. It never takes focus or the mouse and never appears in the recording:
 * focusable: false (WS_EX_NOACTIVATE), setIgnoreMouseEvents(true) (click-through), only ever showInactive() — never show()/focus() —
 * and setContentProtection(true), which is WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+ so DDA screen capture skips it.
 * Older Windows only has WDA_MONITOR (the window would be a black box in the recording), so the overlay stays off there.
 */
import os from 'os'
import { OVERLAY_CHANNELS, OVERLAY_MARGIN, OVERLAY_WINDOW_SIZE, type OverlayCard, type OverlayFrame } from '../../shared/overlay'
import type { OverlayPosition, OverlaySettings } from '../../shared/recording'

export interface Rect { x: number; y: number; width: number; height: number }

/** Where the overlay may appear right now. */
export type OverlayPlacement =
  | { kind: 'screen'; display: Rect }
  /** The game holds exclusive fullscreen (or this Windows cannot exclude the window from capture): no overlay. */
  | { kind: 'exclusive' }
  /** No game is running: recorder news goes to a Windows toast instead. */
  | { kind: 'none' }

/** The BrowserWindow surface the overlay uses (a narrow type so tests can assert nothing else is ever called). */
export interface OverlayBrowserWindow {
  setIgnoreMouseEvents(ignore: boolean): void
  setContentProtection(enable: boolean): void
  setAlwaysOnTop(flag: boolean, level: 'screen-saver'): void
  setBounds(bounds: Rect): void
  showInactive(): void
  hide(): void
  isVisible(): boolean
  isDestroyed(): boolean
  destroy(): void
  send(channel: string, frame: OverlayFrame): void
  /** Resolves once the page can receive cards. */
  ready(): Promise<void>
}

/** Options every overlay window is created with (exported for the test that pins them). */
export const OVERLAY_WINDOW_OPTIONS = {
  width: OVERLAY_WINDOW_SIZE.width,
  height: OVERLAY_WINDOW_SIZE.height,
  show: false,
  transparent: true,
  frame: false,
  focusable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  hasShadow: false,
  backgroundColor: '#00000000',
  title: 'Valorant Editor overlay'
} as const

export interface OverlayWindowDeps {
  create: () => OverlayBrowserWindow
  getSettings: () => OverlaySettings
  placement: () => Promise<OverlayPlacement>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** WDA_EXCLUDEFROMCAPTURE exists from Windows 10 2004 (build 19041). */
export function supportsCaptureExclusion(release: string = os.release(), platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return true
  const build = Number(release.split('.')[2])
  return Number.isFinite(build) && build >= 19041
}

/** Top-left corner of the overlay window inside `display` for a corner setting. */
export function overlayBounds(display: Rect, position: OverlayPosition): Rect {
  const { width, height } = OVERLAY_WINDOW_SIZE
  const left = position === 'topLeft' || position === 'bottomLeft'
  const top = position === 'topLeft' || position === 'topRight'
  return {
    x: Math.round(left ? display.x + OVERLAY_MARGIN : display.x + display.width - width - OVERLAY_MARGIN),
    y: Math.round(top ? display.y + OVERLAY_MARGIN : display.y + display.height - height - OVERLAY_MARGIN),
    width,
    height
  }
}

/** A short pause after the last card leaves (its fade-out) before the window hides. */
const HIDE_GRACE_MS = 600

export class OverlayWindow {
  private win: OverlayBrowserWindow | null = null
  private ready: Promise<void> | null = null
  private hideAt = 0
  private hideTimer: unknown = null
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(private deps: OverlayWindowDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  /** Show or update one card without activating anything. */
  async present(card: OverlayCard, at?: OverlayPlacement): Promise<'shown' | 'exclusive' | 'off'> {
    const placement = at ?? await this.deps.placement()
    if (placement.kind === 'exclusive') return 'exclusive'
    if (placement.kind === 'none') return 'off'
    const settings = this.deps.getSettings()
    const win = this.ensure()
    await this.ready
    if (win.isDestroyed()) return 'shown'
    win.setBounds(overlayBounds(placement.display, settings.position))
    // Re-assert on every card: some fullscreen transitions drop a window's topmost band.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.send(OVERLAY_CHANNELS.card, { card, position: settings.position, opacity: settings.opacity })
    if (!win.isVisible()) win.showInactive()
    this.scheduleHide(card.durationMs)
    return 'shown'
  }

  destroy(): void {
    if (this.hideTimer !== null) this.clearTimer(this.hideTimer)
    this.hideTimer = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.ready = null
  }

  private ensure(): OverlayBrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = this.deps.create()
    win.setIgnoreMouseEvents(true)
    win.setContentProtection(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    this.win = win
    this.ready = win.ready()
    return win
  }

  private scheduleHide(durationMs: number): void {
    this.hideAt = Math.max(this.hideAt, this.now() + durationMs + HIDE_GRACE_MS)
    if (this.hideTimer !== null) this.clearTimer(this.hideTimer)
    const tick = (): void => {
      this.hideTimer = null
      const left = this.hideAt - this.now()
      if (left > 0) { this.hideTimer = this.setTimer(tick, left); return }
      // hide() never activates another window; the next card shows the window again with showInactive().
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide()
    }
    this.hideTimer = this.setTimer(tick, Math.max(0, this.hideAt - this.now()))
  }
}
