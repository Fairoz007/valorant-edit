// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IDLE_RECORDING_STATUS } from '../../shared/recording'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { DEFAULT_AUTO_MONTAGE, type AutoMontageSettings, type MontageJob, type MontageSkipReason, type MontageStatus } from '../../shared/montage'
import type { RecordingApi } from '../global'
import { RecordingPanel, montageLine } from './RecordingPanel'
import { useMontageStatus } from './useMontageStatus'
import { recordingI18n } from '../i18n'
import { cleanupMounted, click, flush, installDomShims, mount } from '../../../test/dom'
import { createFakeApi } from '../../../test/fakeApi'
import { formatFindings, runAxe } from '../../../test/axe'

const s = recordingI18n.autoMontage.status

const job = (patch: Partial<MontageJob> = {}): MontageJob => ({
  id: 'm_0123456789abcdef', sourcePath: 'D:\\Recordings\\2026-11-15\\match1.mp4', game: 'valorant', state: 'recorded', progress: 0,
  createdAt: 1, updatedAt: 1, attempts: 0, ...patch
})

let previousApi: Window['api']
beforeEach(() => { installDomShims(); previousApi = window.api })
afterEach(() => { cleanupMounted(); window.api = previousApi; vi.restoreAllMocks() })

function rig(montage: Partial<AutoMontageSettings> = {}, status: MontageStatus = { active: null, jobs: [] }) {
  const fake = createFakeApi({
    settings: { recording: { ...DEFAULT_SETTINGS.recording, autoMontage: { ...DEFAULT_AUTO_MONTAGE, ...montage } } }
  })
  fake.setMontage(status)
  const recording: RecordingApi = {
    getStatus: vi.fn(async () => IDLE_RECORDING_STATUS), getCapabilities: vi.fn(async () => null),
    startManual: vi.fn(async () => true), stopManual: vi.fn(async () => undefined), setPaused: vi.fn(async () => undefined),
    onStatus: () => () => undefined
  }
  window.api = { ...fake.api, recording } as unknown as Window['api']
  return { fake, api: fake.api.montage, push: (next: MontageStatus) => act(() => fake.setMontage(next)) }
}

const line = (): HTMLElement | null => document.getElementById('rec-montage-status')
const button = (text: string): HTMLButtonElement | undefined => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)

describe('Auto montage status in the recording panel', () => {
  test('hidden while Auto montage is off and no job exists', async () => {
    rig({ enabled: false })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(document.querySelector('.rec-montage')).toBeNull()
  })

  test('shown for a job even when Auto montage is off', async () => {
    rig({ enabled: false }, { active: null, jobs: [job({ state: 'done', clipCount: 6, totalSec: 48 })] })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(line()?.textContent).toBe('精華影片已完成：6 個片段，0:48')
  })

  test('idle line follows the timing setting; the line is a polite live region inside a named section', async () => {
    rig({ enabled: true, timing: 'afterGameExit' })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(line()?.textContent).toBe(s.idleExit)
    expect(line()?.getAttribute('aria-live')).toBe('polite')
    expect(line()?.getAttribute('role')).toBe('status')
    const section = document.querySelector('.rec-montage')!
    expect(document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent).toBe(s.title)
    expect(montageLine(null, { timing: 'afterEachMatch' }).text).toBe(s.idleEach)
  })

  test('exporting shows progress with Cancel; pushes update the line; Cancel calls the API', async () => {
    const r = rig({ enabled: true }, { active: job({ state: 'exporting', progress: 0.62 }), jobs: [] })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(line()?.textContent).toBe('正在製作精華影片… 62%')
    r.push({ active: job({ state: 'exporting', progress: 0.8 }), jobs: [] })
    expect(line()?.textContent).toBe('正在製作精華影片… 80%')
    const cancel = button(s.cancel)!
    expect(cancel.getAttribute('aria-describedby')).toBe('rec-montage-status')
    click(cancel)
    await flush()
    expect(r.api.cancel).toHaveBeenCalledWith('m_0123456789abcdef')
  })

  test.each([
    ['recorded', s.recorded],
    ['analyzing', s.analyzing],
    ['selecting', s.selecting],
    ['deferred', s.deferred]
  ] as const)('%s shows its line with Cancel', (state, text) => {
    expect(montageLine(job({ state }), null)).toEqual({ text, action: 'cancel' })
  })

  test('deferred renders "Waiting for VALORANT to close"', async () => {
    rig({ enabled: true, timing: 'afterGameExit' }, { active: null, jobs: [job({ state: 'deferred' })] })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(line()?.textContent).toBe(s.deferred)
    expect(button(s.cancel)).toBeTruthy()
  })

  test('done: "ready" with clip count and length; Open asks main for the project and hands it to the caller', async () => {
    const r = rig({ enabled: true }, { active: null, jobs: [job({ state: 'done', clipCount: 6, totalSec: 48, outputPath: 'E:\\VE\\Montages\\2026-11-15\\m.mp4' })] })
    const onOpenMontage = vi.fn()
    mount(<RecordingPanel onClose={() => undefined} onOpenMontage={onOpenMontage} />)
    await flush()
    expect(montageLine(job({ state: 'done', clipCount: 1, totalSec: 12 }), null).text).toBe('精華影片已完成：1 個片段，0:12')
    click(button(s.open)!)
    await flush()
    expect(r.api.open).toHaveBeenCalledWith('m_0123456789abcdef')
    expect(onOpenMontage).toHaveBeenCalledWith('p_m_0123456789abcdef', expect.objectContaining({ id: 'm_0123456789abcdef' }))
  })

  test('Open without a Studio handler shows the montage folder; a missing project shows an error', async () => {
    const r = rig({ enabled: true }, { active: null, jobs: [job({ state: 'done', clipCount: 2, totalSec: 20, outputPath: 'E:\\VE\\Montages\\2026-11-15\\m.mp4' })] })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    click(button(s.open)!)
    await flush()
    expect(r.fake.api.export.openFolder).toHaveBeenCalledWith('E:\\VE\\Montages\\2026-11-15')
    r.api.open.mockResolvedValueOnce(null)
    click(button(s.open)!)
    await flush()
    expect(document.querySelector('.rec-montage [role="alert"]')?.textContent).toBe(s.openFailed)
  })

  test.each<[MontageSkipReason, number | undefined, string, boolean]>([
    ['tooFew', 1, s.skipped.tooFewOne, true],
    ['tooFew', 3, '已略過：只有 3 個精華', true],
    ['tooFew', undefined, s.skipped.tooFewNoCount, true],
    ['empty', undefined, s.skipped.empty, true],
    ['lowDisk', undefined, s.skipped.lowDisk, true],
    ['notValorant', undefined, s.skipped.notValorant, false],
    ['sourceMissing', undefined, s.skipped.sourceMissing, false]
  ])('skipped %s (%s clips)', (skipReason, clipCount, text, retry) => {
    expect(montageLine(job({ state: 'skipped', skipReason, clipCount }), null)).toEqual({ text, action: retry ? 'retry' : null })
  })

  test('failed shows the error with Retry; Retry calls the API; cancelled offers Retry too', async () => {
    const r = rig({ enabled: true }, { active: null, jobs: [job({ state: 'failed', failCode: 'encoder', error: '編碼器無法使用' })] })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(line()?.textContent).toBe('失敗：編碼器無法使用')
    click(button(s.retry)!)
    await flush()
    expect(r.api.retry).toHaveBeenCalledWith('m_0123456789abcdef')
    expect(montageLine(job({ state: 'failed' }), null)).toEqual({ text: s.failedUnknown, action: 'retry' })
    expect(montageLine(job({ state: 'cancelled' }), null)).toEqual({ text: s.cancelled, action: 'retry' })
    r.api.retry.mockResolvedValueOnce(false)
    click(button(s.retry)!)
    await flush()
    expect(document.querySelector('.rec-montage [role="alert"]')?.textContent).toBe(s.actionFailed)
  })

  test('the active job wins over the most recent finished job', async () => {
    rig({ enabled: true }, { active: job({ state: 'exporting', progress: 0.1 }), jobs: [job({ state: 'done', clipCount: 3, totalSec: 30 })] })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(line()?.textContent).toBe('正在製作精華影片… 10%')
  })

  test('an unavailable service is reported while Auto montage is on', async () => {
    const r = rig({ enabled: true })
    r.api.getStatus.mockRejectedValue(new Error('no handler'))
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(line()?.textContent).toBe(s.unavailable)
  })

  test('useMontageStatus: a delayed snapshot cannot overwrite a newer push; unmount unsubscribes', async () => {
    const r = rig({ enabled: true })
    let resolve!: (v: MontageStatus) => void
    r.api.getStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    function Probe(): JSX.Element { const st = useMontageStatus().status; return <span>{st.active?.state ?? 'none'}</span> }
    mount(<Probe />)
    r.push({ active: job({ state: 'exporting' }), jobs: [] })
    await act(async () => resolve({ active: null, jobs: [] }))
    expect(document.body.textContent).toBe('exporting')
    expect(r.api.onStatus).toHaveBeenCalledOnce()
    cleanupMounted()
    // After unmount a push reaches no listener (no React warning, no throw).
    r.push({ active: null, jobs: [] })
  })

  test('axe: panel with a montage action has no serious violations', async () => {
    rig({ enabled: true }, { active: null, jobs: [job({ state: 'failed', error: 'x' })] })
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    const findings = await runAxe(document.querySelector('.rec-panel')!)
    expect(findings, formatFindings(findings)).toEqual([])
  })
})
