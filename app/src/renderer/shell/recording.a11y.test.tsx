// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IDLE_RECORDING_STATUS, type RecordingStatus } from '../../shared/recording'
import type { RecordingApi } from '../global'
import { Rail } from './Rail'
import { RecordingPanel, errorHint, panelState } from './RecordingPanel'
import { useRecordingStatus } from './useRecordingStatus'
import { recordingI18n as t } from '../i18n'
import { cleanupMounted, click, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'
import { Providers } from '../../../test/harness'
import { createFakeApi } from '../../../test/fakeApi'

let previousApi: Window['api']
beforeEach(() => { installDomShims(); previousApi = window.api })
afterEach(() => { cleanupMounted(); window.api = previousApi; vi.useRealTimers(); vi.restoreAllMocks() })
function rig(initial: Partial<RecordingStatus> = {}) {
  let current: RecordingStatus = { ...IDLE_RECORDING_STATUS, ...initial }
  const listeners = new Set<(s: RecordingStatus) => void>()
  const api: RecordingApi = {
    getStatus: vi.fn(async () => current), getCapabilities: vi.fn(async () => null),
    startManual: vi.fn(async () => true), stopManual: vi.fn(async () => undefined),
    setPaused: vi.fn(async (paused) => { current = { ...current, paused } }),
    onStatus: (cb) => { listeners.add(cb); return () => listeners.delete(cb) }
  }
  window.api = { ...window.api, recording: api }
  return { api, listeners, emit: (patch: Partial<RecordingStatus>) => { current = { ...current, ...patch }; act(() => listeners.forEach((cb) => cb(current))) } }
}
function button(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll('button')).find((el) => el.textContent === text)!
}

describe('Recording rail and panel', () => {
  test('AppShell receives status updates and opens the panel; closing it keeps the rail subscription', async () => {
    window.api = createFakeApi() as unknown as Window['api']
    const r = rig()
    mount(<Providers><div /></Providers>)
    await flush()
    r.emit({ phase: 'recording', startedAt: Date.now() })
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="錄影中"]')!
    expect(trigger.querySelector('.rec-dot')).not.toBeNull()
    focusEl(trigger)
    click(trigger)
    await flush()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(r.listeners.size).toBe(2)
    press(document.body, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(r.listeners.size).toBe(1)
    expect(document.activeElement).toBe(trigger)
    cleanupMounted()
    expect(r.listeners.size).toBe(0)
  })

  test.each(['idle', 'recording', 'error'] as const)('sidebar name, status dot, and open action for %s', (phase) => {
    const onRecording = vi.fn()
    mount(<Rail active="library" projectCount={0} onNavigate={() => undefined} recordingPhase={phase} onRecording={onRecording} />)
    const label = phase === 'idle' ? t.title : t.phases[phase]
    const trigger = document.querySelector(`[aria-label="${label}"]`)!
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.querySelector('.app-icon-video')).not.toBeNull()
    expect(trigger.querySelector('.app-icon-film')).toBeNull()
    expect(trigger.querySelector('.rec-dot') !== null).toBe(phase !== 'idle')
    if (phase === 'error') expect(trigger.querySelector('.rec-dot.error')).not.toBeNull()
    click(trigger)
    expect(onRecording).toHaveBeenCalledOnce()
  })

  test.each([['recording', 'live'], ['starting', 'busy'], ['finalizing', 'busy'], ['error', 'error']] as const)(
    'the rail indicator shows %s from every screen as a %s dot with its state as the accessible name', (phase, tone) => {
      mount(<Rail active="settings" projectCount={0} onNavigate={() => undefined} recordingPhase={phase} onRecording={() => undefined} />)
      const trigger = document.querySelector(`[aria-label="${t.phases[phase]}"]`)!
      expect(trigger.querySelector(`.rec-dot.${tone}`)).not.toBeNull()
      expect(trigger.getAttribute('data-tip')).toBe(t.phases[phase])
    })

  test('Status, elapsed time, encoder info, segments, dropped frames, and disk space update; unmount clears subscriptions and timers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T00:01:05Z'))
    const r = rig({ phase: 'recording', startedAt: Date.now() - 65000, encoder: 'hevc_nvenc', width: 2560, height: 1440, segments: 30, droppedFrames: 4, diskFreeBytes: 10 * 1024 ** 3 })
    mount(<RecordingPanel onClose={() => undefined} />)
    await act(async () => undefined)
    expect(document.body.textContent).toContain('00:01:05')
    expect(document.body.textContent).toContain('2560 × 1440')
    expect(document.body.textContent).toContain('hevc_nvenc')
    expect(document.body.textContent).toContain('10.0 GB')
    act(() => vi.advanceTimersByTime(2000))
    expect(document.body.textContent).toContain('00:01:07')
    r.emit({ segments: 31, droppedFrames: 5 })
    expect(document.body.textContent).toContain('段落數31')
    expect(document.body.textContent).toContain('丟格數5')
    cleanupMounted()
    expect(r.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('One primary Start/Stop button, a Pause toggle, and visible failures with a fix hint', async () => {
    const r = rig()
    const openSettings = vi.fn()
    mount(<RecordingPanel onClose={() => undefined} onOpenSettings={openSettings} />)
    await flush()
    // Idle: the primary action is Start; there is no Stop button to miss-click.
    expect(Array.from(document.querySelectorAll('button')).some((el) => el.textContent === t.stop)).toBe(false)
    click(button(t.start))
    await flush()
    expect(r.api.startManual).toHaveBeenCalledOnce()
    r.emit({ phase: 'recording' })
    expect(button(t.stop).classList.contains('primary')).toBe(true)
    click(button(t.stop))
    await flush()
    expect(r.api.stopManual).toHaveBeenCalledOnce()
    const pause = button(t.panel.pause)
    expect(pause.getAttribute('aria-pressed')).toBe('false')
    click(pause)
    await flush()
    expect(r.api.setPaused).toHaveBeenCalledWith(true)
    expect(button(t.panel.resume).getAttribute('aria-pressed')).toBe('true')
    r.emit({ phase: 'idle' })
    r.api.startManual = vi.fn(async () => false)
    click(button(t.start))
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.apexNotRunning)
    r.api.startManual = vi.fn(async () => { throw new Error('錄影器無法啟動') })
    click(button(t.start))
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('錄影器無法啟動')
    cleanupMounted()
    mount(<RecordingPanel onClose={() => undefined} onOpenSettings={openSettings} />)
    await flush()
    r.emit({ phase: 'error', error: { code: 'no_hw_encoder', message: '沒有硬體編碼器' } })
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('沒有硬體編碼器')
    // Inline banner with a fix hint and a way to the settings, not only a toast.
    expect(alert.textContent).toContain(t.panel.hints.no_hw_encoder)
    click(button(t.panel.openSettings))
    expect(openSettings).toHaveBeenCalledOnce()
    expect(document.querySelector('.rec-pill')?.textContent).toBe(t.panel.states.error)
  })

  test('The state pill says Idle / Waiting for match / Recording match N / Saving / Error, with capture and overlay chips', async () => {
    rig()
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    const pill = (): string | null | undefined => document.querySelector('.rec-pill')?.textContent
    expect(pill()).toBe(t.panel.states.idle)
    expect(panelState({ ...IDLE_RECORDING_STATUS, phase: 'recording', inMatch: false }, 'match').label).toBe(t.panel.states.waiting)
    expect(panelState({ ...IDLE_RECORDING_STATUS, phase: 'recording', inMatch: true, matchIndex: 3 }, 'match').label)
      .toBe(t.panel.states.recordingMatch.replace('{n}', '3'))
    expect(panelState({ ...IDLE_RECORDING_STATUS, phase: 'recording' }, 'session').label).toBe(t.panel.states.recording)
    expect(panelState({ ...IDLE_RECORDING_STATUS, phase: 'finalizing' }).label).toBe(t.panel.states.saving)
    expect(panelState({ ...IDLE_RECORDING_STATUS, paused: true }).label).toBe(t.panel.states.paused)
    expect(errorHint('unknown_code')).toBe(t.panel.hints.default)
    expect(document.querySelector('.rec-hero')?.classList.contains('tone-idle')).toBe(true)
    expect(Array.from(document.querySelectorAll('.rec-chip')).map((el) => el.textContent)).toContain(t.panel.overlayOn)
    expect(Array.from(document.querySelectorAll('.rec-tile dt')).map((el) => el.textContent))
      .toEqual([t.panel.kills, t.panel.score, t.panel.match, t.panel.disk])
  })

  test('Named dialog traps focus and returns it to the trigger button after Esc closes it', async () => {
    rig()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    focusEl(trigger)
    const close = vi.fn()
    const view = mount(<RecordingPanel onClose={close} />)
    await flush()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(t.statusTitle)
    expect(dialog.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 8; i++) { press(document.activeElement!, 'Tab'); expect(dialog.contains(document.activeElement)).toBe(true) }
    press(document.body, 'Escape')
    expect(close).toHaveBeenCalledOnce()
    view.unmount()
    expect(document.activeElement).toBe(trigger)
  })

  test('Shows an error and disables controls when the service is not registered', async () => {
    rig().api.getStatus = async () => { throw new Error('missing handler') }
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.serviceUnavailable)
    expect(button(t.start).disabled).toBe(true)
  })

  test('A delayed initial snapshot cannot overwrite newer updates; unmount unsubscribes', async () => {
    const r = rig()
    let resolve!: (s: RecordingStatus) => void
    r.api.getStatus = () => new Promise((done) => { resolve = done })
    function Probe(): JSX.Element { return <span>{useRecordingStatus().status.phase}</span> }
    mount(<Probe />)
    r.emit({ phase: 'recording' })
    await act(async () => resolve(IDLE_RECORDING_STATUS))
    expect(document.body.textContent).toBe('recording')
    cleanupMounted()
    expect(r.listeners.size).toBe(0)
  })
})
