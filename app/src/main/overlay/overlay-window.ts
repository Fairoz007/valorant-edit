/**
 * The in-game overlay window. It never takes focus or the mouse and never appears in the recording:
 * focusable: false (WS_EX_NOACTIVATE), setIgnoreMouseEvents(true) (click-through), only ever showInactive() — never show()/focus() —
 * and setContentProtection(true), which is WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+ so DDA screen capture skips it.
 * Older Windows only has WDA_MONITOR (the window would be a black box in the recording), so the overlay stays off there.
 *
 * It exists only while a card is on screen (docs/recording-mouse-input-fix.md, follow-up): created for the first card, destroyed
 * after the last one, and destroyed at once when the game leaves the foreground. No hidden topmost window stays behind.
 */
import os from 'os'
import type { ForegroundInfo } from '../foreground'
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
  setAlwaysOnTop(flag: boolean, level: typeof OVERLAY_TOPMOST_LEVEL): void
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

/**
 * Topmost band for the overlay. On Windows every Electron level above 'normal' is the same HWND_TOPMOST band; 'floating' is the
 * lowest and says what is meant. It is set once when the window is created and never re-asserted per card.
 */
export const OVERLAY_TOPMOST_LEVEL = 'floating' as const

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
  /** While a card shows, how often the placement is re-checked so the window leaves as soon as the game does (default 1000 ms). */
  recheckMs?: number
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

export interface PlacementInputs {
  /** WDA_EXCLUDEFROMCAPTURE is available (else the overlay would show up in DDA recordings). */
  captureExclusion: boolean
  /** The window can really be transparent (GPU compositing on); otherwise it could be an opaque box over the game. */
  transparency: boolean
  gamePid: number | null
  /** `aditorrec --foreground` answer; null when the query failed. */
  info: ForegroundInfo | null
  /** Screen pixels to DIP for the game's monitor. */
  toDip: (rect: Rect) => Rect
}

/**
 * Where a card may appear. The overlay is shown only over the game while the game is the foreground window in Windowed
 * Fullscreen or Windowed mode. Never over the desktop or another app (the game is not in front: a toast now), and never over a
 * Fullscreen game, which can minimize when another window appears over it (a toast after the game loses focus).
 */
export function decidePlacement(inputs: PlacementInputs): OverlayPlacement {
  const { info } = inputs
  if (inputs.gamePid === null) return { kind: 'none' }
  // Not in front (alt-tabbed, minimized): the user is looking at something else, so a Windows toast reaches them now.
  if (info && !info.gameForeground) return { kind: 'none' }
  // Unknown foreground, no capture exclusion, no transparency, or a Fullscreen game: nothing is drawn over the game.
  if (!info || !inputs.captureExclusion || !inputs.transparency) return { kind: 'exclusive' }
  if (info.exclusiveFullscreen || info.displayModeChanged || !info.monitorRect) return { kind: 'exclusive' }
  const [x, y, width, height] = info.monitorRect
  return { kind: 'screen', display: inputs.toDip({ x, y, width, height }) }
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
  private recheckTimer: unknown = null
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
    if (placement.kind !== 'screen') {
      // The game left the foreground or is Fullscreen: a card still on screen must not stay over whatever is in front now.
      this.destroy()
      return placement.kind === 'exclusive' ? 'exclusive' : 'off'
    }
    const settings = this.deps.getSettings()
    const win = this.ensure()
    await this.ready
    if (win.isDestroyed() || this.win !== win) return 'shown'
    win.setBounds(overlayBounds(placement.display, settings.position))
    win.send(OVERLAY_CHANNELS.card, { card, position: settings.position, opacity: settings.opacity })
    if (!win.isVisible()) win.showInactive()
    this.scheduleHide(card.durationMs)
    // A placement passed in (the Settings test button) is not about the game, so it is not re-checked.
    if (!at) this.scheduleRecheck()
    return 'shown'
  }

  /** Whether an overlay window exists right now (it only exists while a card is showing). */
  exists(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  destroy(): void {
    if (this.hideTimer !== null) this.clearTimer(this.hideTimer)
    if (this.recheckTimer !== null) this.clearTimer(this.recheckTimer)
    this.hideTimer = null
    this.recheckTimer = null
    this.hideAt = 0
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.ready = null
  }

  private ensure(): OverlayBrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = this.deps.create()
    win.setIgnoreMouseEvents(true)
    win.setContentProtection(true)
    win.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL)
    this.win = win
    this.ready = win.ready()
    return win
  }

  private scheduleRecheck(): void {
    if (this.recheckTimer !== null) return
    const every = this.deps.recheckMs ?? 1000
    const tick = (): void => {
      this.recheckTimer = null
      if (!this.exists()) return
      void this.deps.placement().then((placement) => {
        if (!this.exists()) return
        if (placement.kind !== 'screen') this.destroy()
        else if (this.recheckTimer === null) this.recheckTimer = this.setTimer(tick, every)
      }, () => this.destroy())
    }
    this.recheckTimer = this.setTimer(tick, every)
  }

  private scheduleHide(durationMs: number): void {
    this.hideAt = Math.max(this.hideAt, this.now() + durationMs + HIDE_GRACE_MS)
    if (this.hideTimer !== null) this.clearTimer(this.hideTimer)
    const tick = (): void => {
      this.hideTimer = null
      const left = this.hideAt - this.now()
      if (left > 0) { this.hideTimer = this.setTimer(tick, left); return }
      // Destroying never activates another window; the next card creates a fresh one and shows it with showInactive().
      this.destroy()
    }
    this.hideTimer = this.setTimer(tick, Math.max(0, this.hideAt - this.now()))
  }
}
