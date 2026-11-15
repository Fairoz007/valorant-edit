import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveLocale } from '../../shared/locale'
import { DEFAULT_OVERLAY_SETTINGS, IDLE_RECORDING_STATUS, type LiveUpdate, type OverlaySettings, type RecordingStatus } from '../../shared/recording'
import type { OverlayCard } from '../../shared/overlay'
import type { EngineEvent } from '../../shared/types'
import { createOverlayController, KILL_STREAK_GAP_MS, type OverlayControllerDeps } from './overlay-controller'
import { OVERLAY_WINDOW_OPTIONS, OverlayWindow, overlayBounds, supportsCaptureExclusion, type OverlayBrowserWindow } from './overlay-window'
import { migrateSettings, pickOverlay } from '../settings'

beforeEach(() => setActiveLocale('en'))
afterEach(() => { setActiveLocale('zh-TW'); vi.useRealTimers() })

function controller(settings: Partial<OverlaySettings> = {}, present: OverlayControllerDeps['present'] = async () => 'shown') {
  const cards: OverlayCard[] = []
  let now = 1_000_000
  const ctl = createOverlayController({
    getSettings: () => ({ ...DEFAULT_OVERLAY_SETTINGS, ...settings }),
    present: async (card) => { cards.push(card); return present(card) },
    now: () => now
  })
  return { ctl, cards, advance: (ms: number) => { now += ms } }
}

let killSeq = 0
function kill(id = `k${++killSeq}`): EngineEvent {
  return { id, t: killSeq, type: 'kill', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto' }
}
const live = (events: EngineEvent[], sessionId = 's1'): LiveUpdate => ({ sessionId, events })
const status = (patch: Partial<RecordingStatus>): RecordingStatus => ({ ...IDLE_RECORDING_STATUS, ...patch })

describe('Overlay card mapping', () => {
  it('maps every recorder notice kind to a card (match notices come from match activity instead)', async () => {
    const { ctl, cards } = controller()
    for (const kind of ['finalized', 'diskWarn', 'warning', 'error', 'montage'] as const) {
      expect(await ctl.handle({ type: 'notice', kind, message: `msg ${kind}` })).toBe('shown')
    }
    expect(cards.map((c) => [c.title, c.tone])).toEqual([
      ['Saved', 'ok'], ['Low disk space', 'warn'], ['Warning', 'warn'], ['Error', 'error'], ['Montage', 'ok']
    ])
    for (const kind of ['matchStart', 'matchEnd', 'matchCancel'] as const) {
      expect(await ctl.handle({ type: 'notice', kind, message: 'x' })).toBe('shown')
    }
    expect(cards).toHaveLength(5)
  })

  it('shows the saved file names without the "Saved:" prefix', async () => {
    const { ctl, cards } = controller()
    await ctl.handle({ type: 'notice', kind: 'finalized', message: 'Saved: C:\\Videos\\a.mp4, C:\\Videos\\b.mp4' })
    expect(cards[0].detail).toBe('a.mp4, b.mp4')
  })

  it('errors stay twice as long', async () => {
    const { ctl, cards } = controller({ durationSec: 4 })
    await ctl.handle({ type: 'notice', kind: 'warning', message: 'w' })
    await ctl.handle({ type: 'notice', kind: 'error', message: 'e' })
    expect(cards.map((c) => c.durationMs)).toEqual([4000, 8000])
  })

  it('status changes: recording started (with capture method), paused, resumed, stopped', async () => {
    const { ctl, cards } = controller()
    await ctl.handle({ type: 'status', status: status({}) })
    await ctl.handle({ type: 'status', status: status({ phase: 'starting' }) })
    await ctl.handle({ type: 'status', status: status({ phase: 'recording', capture: 'dda' }) })
    await ctl.handle({ type: 'status', status: status({ phase: 'recording', capture: 'dda', paused: true }) })
    await ctl.handle({ type: 'status', status: status({ phase: 'recording', capture: 'dda', paused: false }) })
    await ctl.handle({ type: 'status', status: status({ phase: 'finalizing' }) })
    expect(cards.map((c) => `${c.title} | ${c.detail}`)).toEqual([
      'Recording | DDA capture', 'Paused | Auto recording paused', 'Resumed | Auto recording resumed', 'Stopped | Saving recording…'
    ])
  })

  it('game detected, match countdown, start, cancel, end, rounds and capture fallback', async () => {
    const { ctl, cards } = controller()
    await ctl.handle({ type: 'activity', activity: { type: 'game', running: true } })
    await ctl.handle({ type: 'activity', activity: { type: 'match', ev: 'pending', index: 1, kills: 0 } })
    await ctl.handle({ type: 'activity', activity: { type: 'match', ev: 'cancel', index: 1, kills: 0 } })
    await ctl.handle({ type: 'activity', activity: { type: 'match', ev: 'start', index: 1, kills: 0 } })
    await ctl.handle({ type: 'activity', activity: { type: 'round', winner: 'ally', ally: 1, enemy: 0 } })
    await ctl.handle({ type: 'activity', activity: { type: 'round', winner: 'enemy', ally: 1, enemy: 1 } })
    await ctl.handle({ type: 'activity', activity: { type: 'match', ev: 'end', index: 1, kills: 17 } })
    await ctl.handle({ type: 'activity', activity: { type: 'fallback', from: 'dda', to: 'wgc' } })
    await ctl.handle({ type: 'analysis', kills: 17 })
    expect(cards.map((c) => `${c.title} | ${c.detail}`)).toEqual([
      'VALORANT | Recorder ready', 'Match found | Countdown…', 'Match cancelled | No match after the countdown', 'Match 1 | Started',
      'Round won | 1 – 0', 'Round lost | 1 – 1', 'Match over | 17 kills', 'Capture | DDA → WGC', 'Analysis done | 17 kills'
    ])
  })
})

describe('Kill throttling', () => {
  it('a five-kill round is one card that ends as ACE', async () => {
    const { ctl, cards } = controller()
    await ctl.handle({ type: 'activity', activity: { type: 'match', ev: 'start', index: 1, kills: 0 } })
    cards.length = 0
    const events: EngineEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(kill())
      await ctl.handle({ type: 'live', update: live([...events]) })
    }
    expect(new Set(cards.map((c) => c.id)).size).toBe(1)
    expect(cards.map((c) => c.title)).toEqual(['KILL', 'DOUBLE KILL', 'TRIPLE KILL', 'QUADRA KILL', 'ACE'])
    expect(cards.at(-1)?.detail).toBe('Round 1')
  })

  it('kills that arrive in one snapshot count together, and repeated snapshots are not recounted', async () => {
    const { ctl, cards } = controller()
    const events = [kill(), kill(), kill()]
    await ctl.handle({ type: 'live', update: live(events) })
    await ctl.handle({ type: 'live', update: live(events) })
    expect(cards.map((c) => c.title)).toEqual(['TRIPLE KILL'])
  })

  it('a round end starts a new card', async () => {
    const { ctl, cards } = controller()
    await ctl.handle({ type: 'activity', activity: { type: 'match', ev: 'start', index: 1, kills: 0 } })
    const events = [kill(), kill()]
    await ctl.handle({ type: 'live', update: live(events) })
    await ctl.handle({ type: 'activity', activity: { type: 'round', winner: 'ally', ally: 1, enemy: 0 } })
    events.push(kill())
    await ctl.handle({ type: 'live', update: live(events) })
    const killCards = cards.filter((c) => c.icon === 'crosshair')
    expect(killCards.map((c) => `${c.title} ${c.detail}`)).toEqual(['DOUBLE KILL Round 1', 'KILL Round 2'])
    expect(new Set(killCards.map((c) => c.id)).size).toBe(2)
  })

  it('without round information, kills far apart start a new card', async () => {
    const { ctl, cards, advance } = controller()
    const events = [kill()]
    await ctl.handle({ type: 'live', update: live(events) })
    advance(KILL_STREAK_GAP_MS + 1)
    events.push(kill())
    await ctl.handle({ type: 'live', update: live(events) })
    expect(cards.map((c) => c.title)).toEqual(['KILL', 'KILL'])
    expect(cards[1].detail).toBe('2 kills this match')
  })

  it('deleted and uncounted events and deaths are ignored; a new session resets', async () => {
    const { ctl, cards } = controller()
    await ctl.handle({ type: 'live', update: live([{ ...kill(), deleted: true }, { ...kill(), counted: false }, { ...kill(), type: 'death' }]) })
    expect(cards).toEqual([])
    const k = kill('same-id')
    await ctl.handle({ type: 'live', update: live([k], 's1') })
    await ctl.handle({ type: 'live', update: live([k], 's2') })
    expect(cards).toHaveLength(2)
  })
})

describe('Overlay settings filters', () => {
  it('disabled: nothing is shown and the notice falls back to a toast', async () => {
    const { ctl, cards } = controller({ enabled: false })
    expect(await ctl.handle({ type: 'notice', kind: 'error', message: 'x' })).toBe('off')
    expect(await ctl.handle({ type: 'live', update: live([kill()]) })).toBe('off')
    expect(cards).toEqual([])
  })

  it('showKills / showRounds hide those cards only', async () => {
    const { ctl, cards } = controller({ showKills: false, showRounds: false })
    await ctl.handle({ type: 'live', update: live([kill()]) })
    await ctl.handle({ type: 'activity', activity: { type: 'round', winner: 'ally', ally: 1, enemy: 0 } })
    await ctl.handle({ type: 'notice', kind: 'finalized', message: 'Saved: a.mp4' })
    expect(cards.map((c) => c.title)).toEqual(['Saved'])
  })

  it('reports exclusive fullscreen and no-game placements so the caller can use a toast', async () => {
    expect(await controller({}, async () => 'exclusive').ctl.handle({ type: 'notice', kind: 'error', message: 'x' })).toBe('exclusive')
    expect(await controller({}, async () => 'off').ctl.handle({ type: 'notice', kind: 'error', message: 'x' })).toBe('off')
  })

  it('the Settings test cards exist regardless of settings', () => {
    expect(controller({ enabled: false }).ctl.test().map((c) => c.title)).toEqual(['Recording', 'ACE', 'Saved'])
  })
})

describe('Overlay settings validation and migration', () => {
  it('clamps ranges, rejects bad values field by field', () => {
    expect(pickOverlay({ enabled: 'yes', position: 'middle', durationSec: 99, showKills: false, showRounds: 1, opacity: 0.05 }, DEFAULT_OVERLAY_SETTINGS))
      .toEqual({ ...DEFAULT_OVERLAY_SETTINGS, durationSec: 10, showKills: false, opacity: 0.3 })
    expect(pickOverlay({ durationSec: 0, opacity: 3, position: 'bottomLeft' }, DEFAULT_OVERLAY_SETTINGS))
      .toEqual({ ...DEFAULT_OVERLAY_SETTINGS, durationSec: 1, opacity: 1, position: 'bottomLeft' })
    expect(pickOverlay(null, DEFAULT_OVERLAY_SETTINGS)).toEqual(DEFAULT_OVERLAY_SETTINGS)
  })

  it('settings saved before the overlay existed get the defaults (on, top right, 3 s)', () => {
    expect(migrateSettings({ version: 2, recording: { autoRecord: true } }).recording.overlay).toEqual(DEFAULT_OVERLAY_SETTINGS)
    expect(DEFAULT_OVERLAY_SETTINGS).toEqual({ enabled: true, position: 'topRight', durationSec: 3, showKills: true, showRounds: true, opacity: 0.9 })
  })

  it('keeps saved overlay choices', () => {
    const overlay = { enabled: false, position: 'bottomRight', durationSec: 6, showKills: false, showRounds: true, opacity: 0.5 }
    expect(migrateSettings({ version: 3, recording: { overlay } }).recording.overlay).toEqual(overlay)
  })
})

/** A BrowserWindow double that records every call; only the narrow OverlayBrowserWindow surface exists, and show/focus are traps. */
function windowDouble() {
  const calls: string[] = []
  let visible = false
  const win: OverlayBrowserWindow & { show: () => void; focus: () => void; moveTop: () => void } = {
    setIgnoreMouseEvents: (v) => calls.push(`ignoreMouse:${v}`),
    setContentProtection: (v) => calls.push(`contentProtection:${v}`),
    setAlwaysOnTop: (v, level) => calls.push(`alwaysOnTop:${v}:${level}`),
    setBounds: (b) => calls.push(`bounds:${b.x},${b.y}`),
    showInactive: () => { visible = true; calls.push('showInactive') },
    hide: () => { visible = false; calls.push('hide') },
    isVisible: () => visible,
    isDestroyed: () => false,
    destroy: () => calls.push('destroy'),
    send: (_channel, frame) => calls.push(`send:${frame.card.id}`),
    ready: async () => {},
    show: () => calls.push('SHOW'),
    focus: () => calls.push('FOCUS'),
    moveTop: () => calls.push('MOVETOP')
  }
  return { win, calls }
}

const display = { x: 0, y: 0, width: 1920, height: 1080 }
const card = (id: string, durationMs = 3000): OverlayCard => ({ id, tone: 'rec', icon: 'rec', title: 't', detail: 'd', durationMs })

describe('Overlay window is never focused', () => {
  it('is click-through, excluded from capture, topmost, and only ever shown inactive', async () => {
    vi.useFakeTimers()
    const { win, calls } = windowDouble()
    const ow = new OverlayWindow({ create: () => win, getSettings: () => DEFAULT_OVERLAY_SETTINGS, placement: async () => ({ kind: 'screen', display }) })
    expect(await ow.present(card('a'))).toBe('shown')
    expect(await ow.present(card('b'))).toBe('shown')
    expect(calls.slice(0, 3)).toEqual(['ignoreMouse:true', 'contentProtection:true', 'alwaysOnTop:true:screen-saver'])
    expect(calls.filter((c) => c === 'showInactive')).toHaveLength(1)
    expect(calls).not.toContain('SHOW')
    expect(calls).not.toContain('FOCUS')
    expect(calls).not.toContain('MOVETOP')
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.at(-1)).toBe('hide')
    await ow.present(card('c'))
    expect(calls.filter((c) => c === 'showInactive')).toHaveLength(2)
    expect(calls).not.toContain('SHOW')
    expect(calls).not.toContain('FOCUS')
  })

  it('window options: transparent, frameless, never focusable, no taskbar, no shadow, not resizable', () => {
    expect(OVERLAY_WINDOW_OPTIONS).toMatchObject({ show: false, transparent: true, frame: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, hasShadow: false })
  })

  it('exclusive fullscreen or no game: no window is created at all', async () => {
    const create = vi.fn()
    for (const kind of ['exclusive', 'none'] as const) {
      const ow = new OverlayWindow({ create, getSettings: () => DEFAULT_OVERLAY_SETTINGS, placement: async () => ({ kind }) })
      expect(await ow.present(card('a'))).toBe(kind === 'none' ? 'off' : 'exclusive')
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('a later card keeps the window up until it expires', async () => {
    vi.useFakeTimers()
    const { win, calls } = windowDouble()
    const ow = new OverlayWindow({ create: () => win, getSettings: () => DEFAULT_OVERLAY_SETTINGS, placement: async () => ({ kind: 'screen', display }) })
    await ow.present(card('a', 1000))
    await vi.advanceTimersByTimeAsync(800)
    await ow.present(card('b', 3000))
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls).not.toContain('hide')
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.at(-1)).toBe('hide')
  })

  it('corner placement inside the game monitor', () => {
    const d = { x: 1920, y: 0, width: 2560, height: 1440 }
    expect(overlayBounds(d, 'topRight')).toMatchObject({ x: 1920 + 2560 - 440 - 24, y: 24 })
    expect(overlayBounds(d, 'topLeft')).toMatchObject({ x: 1920 + 24, y: 24 })
    expect(overlayBounds(d, 'bottomLeft')).toMatchObject({ x: 1920 + 24, y: 1440 - 220 - 24 })
    expect(overlayBounds(d, 'bottomRight')).toMatchObject({ x: 1920 + 2560 - 440 - 24, y: 1440 - 220 - 24 })
  })

  it('capture exclusion needs Windows 10 2004 (build 19041) or later', () => {
    expect(supportsCaptureExclusion('10.0.18363', 'win32')).toBe(false)
    expect(supportsCaptureExclusion('10.0.19041', 'win32')).toBe(true)
    expect(supportsCaptureExclusion('10.0.26300', 'win32')).toBe(true)
  })
})
