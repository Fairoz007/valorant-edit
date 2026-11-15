import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MontageJobStore } from './montage-job'
import { createMontageService, formatMontageDuration, type MontageServiceDeps, type MontageSettingsView } from './montage-service'
import type { MontageRenderControl, MontageRenderRequest, MontageRenderResult } from './montage-export'
import { DEFAULT_AUTO_MONTAGE, montageJobId, montageProjectId, selectMontageClips, type MontageSelection } from '../../shared/montage'
import type { CacheDoc, Clip } from '../../shared/types'
import { setActiveLocale } from '../../shared/locale'
import { dayFolderName } from '../../shared/storage'

vi.mock('../../shared/montage', async (orig) => {
  const actual = await orig<typeof import('../../shared/montage')>()
  return { ...actual, selectMontageClips: vi.fn() }
})

const NOW = new Date(2026, 10, 15, 21, 30).getTime()
const SRC = 'D:/Videos/Recordings/2026-11-15/Valorant_2026-11-15_21-08.mp4'
const SRC2 = 'D:/Videos/Recordings/2026-11-15/Valorant_2026-11-15_21-48.mp4'
const SRC3 = 'D:/Videos/Recordings/2026-11-15/Valorant_2026-11-15_22-30.mp4'
const clip = (id: string, start: number, end: number, origin: Clip['origin'] = 'ai'): Clip => ({ id, start, end, origin, event_ids: [] })
const AI = [clip('a1', 10, 20), clip('a2', 100, 110), clip('a3', 300, 310)]

function cacheDoc(): CacheDoc {
  return {
    version: 1,
    video: { path: SRC, size: 1, mtime: 1, duration: 600, width: 1920, height: 1080, codec: 'h264', start_time: 0, fps: 60 },
    analysis: { status: 'done', progress_t: 600, engine_version: 'x', templates_version: 'x', h_scale: 1 },
    events: [],
    spectating: [],
    clips: [clip('m1', 400, 405, 'manual'), { ...clip('oldai', 1, 2), status: 'suggested' }],
    keyframes: [],
    cache_path: 'x',
    game: 'valorant'
  }
}

let dir: string
const services: Array<{ shutdown(): Promise<void> }> = []

beforeEach(() => {
  setActiveLocale('en')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-svc-'))
  vi.mocked(selectMontageClips).mockReset().mockImplementation((_events, clips): MontageSelection => {
    const chosen = [...clips].sort((a, b) => a.start - b.start)
    return { clips: chosen, totalSec: chosen.reduce((s, c) => s + c.end - c.start, 0) }
  })
})
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  deps: MontageServiceDeps
  settings: MontageSettingsView
  files: Set<string>
  library: Map<string, { status: string; source?: string; montage?: { jobId: string } }>
  calls: string[]
  game: { running: boolean; recording: boolean }
  render: ReturnType<typeof vi.fn>
  store: MontageJobStore
  service: ReturnType<typeof createMontageService>
  /** Make the next renders wait for an abort (or `release`). */
  hold(): { release: () => void }
}

function harness(over: Partial<MontageServiceDeps> = {}, montage: Partial<MontageSettingsView['montage']> = {}, store?: MontageJobStore): Harness {
  const settings: MontageSettingsView = {
    montage: { ...DEFAULT_AUTO_MONTAGE, include: { ...DEFAULT_AUTO_MONTAGE.include }, enabled: true, ...montage },
    autoclip: { gap: 10, n: 5, before: 3, after: 2, max_len: 60 },
    diskWarnGb: 10,
    diskStopGb: 2,
    storageRoot: 'D:/Root'
  }
  const files = new Set([SRC, SRC2, SRC3])
  const library = new Map<string, { status: string; source?: string; montage?: { jobId: string } }>()
  for (const f of files) library.set(f, { status: 'pending', source: 'recording' })
  const calls: string[] = []
  const game = { running: false, recording: false }
  let gate: Promise<void> | null = null
  let releaseGate = (): void => {}
  const render = vi.fn(async (req: MontageRenderRequest, control: MontageRenderControl): Promise<MontageRenderResult> => {
    const out = path.join(req.outDir, `${req.baseName}.mp4`).replace(/\\/g, '/')
    calls.push(`render:${req.baseName}`)
    control.onPlanned?.(out)
    control.onProgress?.(0.5)
    if (gate) {
      const g = gate
      const aborted = new Promise<'abort'>((r) => control.signal.addEventListener('abort', () => r('abort'), { once: true }))
      if ((await Promise.race([g.then(() => 'go' as const), aborted])) === 'abort') return { ok: false, cancelled: true }
    }
    files.add(out)
    return { ok: true, outputPath: out, encoder: 'h264_nvenc' }
  })
  const st = store ?? new MontageJobStore(path.join(dir, 'jobs.json'), { now: () => NOW })
  const deps: MontageServiceDeps = {
    store: st,
    getSettings: () => settings,
    library: {
      get: (p) => library.get(p),
      hasMontage: (id) => [...library.values()].some((e) => e.source === 'montage' && e.montage?.jobId === id),
      addMontage: (out, info) => {
        calls.push(`addMontage:${path.basename(out)}`)
        library.set(out, { status: 'pending', source: 'montage', montage: info })
      }
    },
    saveProject: vi.fn(async () => {
      calls.push('saveProject')
    }),
    loadProject: vi.fn(async () => null),
    readCache: vi.fn(() => cacheDoc()),
    autoclip: vi.fn(async () => AI),
    render,
    probeOutput: vi.fn(async () => ({ duration: 35, hasVideo: true, hasAudio: true })),
    diskFree: vi.fn(async () => 500 * 1024 ** 3),
    fileExists: (f) => files.has(f),
    ensureDir: vi.fn(),
    cleanupOutput: vi.fn((out: string, opts: { removeOutput?: boolean }) => {
      calls.push(`cleanup:${path.basename(out)}:${opts.removeOutput ? 'rm' : 'keep'}`)
      if (opts.removeOutput) files.delete(out)
    }),
    removeSource: vi.fn(async (p: string) => {
      calls.push(`removeSource:${path.basename(p)}`)
      files.delete(p)
      library.delete(p)
    }),
    notify: vi.fn(),
    now: () => NOW,
    isGameRunning: () => game.running,
    isRecording: () => game.recording,
    onStatus: vi.fn(),
    ...over
  }
  const service = createMontageService(deps)
  services.push(service)
  return {
    deps, settings, files, library, calls, game, render, store: st, service,
    hold() {
      gate = new Promise<void>((r) => (releaseGate = r))
      return { release: () => { const r = releaseGate; gate = null; r() } }
    }
  }
}

const id = montageJobId(SRC)

async function recordAndAnalyze(h: Harness, src = SRC): Promise<void> {
  h.service.onMatchRecorded(src, 'valorant')
  h.service.onMatchAnalyzed(src, 'valorant')
  await h.service.idle()
}

describe('cache clips follow the re-analysis merge rules', () => {
  it('keeps accepted AI clips (stale), drops old suggestions, and passes skipped clips so selection can leave them out', async () => {
    const doc = cacheDoc()
    doc.clips = [
      clip('m1', 400, 405, 'manual'),
      { ...clip('acc', 200, 210), status: 'accepted' },
      { ...clip('sug', 1, 2), status: 'suggested' },
      { ...clip('skip', 100, 110), status: 'skipped' }
    ]
    const h = harness({ readCache: vi.fn(() => doc), probeOutput: vi.fn(async () => ({ duration: 55, hasVideo: true, hasAudio: true })) })
    h.service.start()
    await recordAndAnalyze(h)
    const passed = vi.mocked(selectMontageClips).mock.calls[0][1]
    expect(passed.map((c) => c.id).sort()).toEqual(['a1', 'a2', 'a3', 'acc', 'm1', 'skip'])
    expect(passed.find((c) => c.id === 'acc')).toMatchObject({ status: 'accepted', stale: true })
    expect(passed.find((c) => c.id === 'skip')).toMatchObject({ status: 'skipped' })
    expect(passed.some((c) => c.id === 'sug')).toBe(false)
  })
})

describe('happy path', () => {
  it('full analysis: recorded → analyzing → (analyzed event) → selecting → exporting → done, with library entry and notice', async () => {
    const h = harness()
    h.service.start()
    h.service.onMatchRecorded(SRC, 'valorant')
    expect(h.store.get(id)?.state).toBe('analyzing')
    expect(h.render).not.toHaveBeenCalled()
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await h.service.idle()
    const job = h.store.get(id)!
    expect(job).toMatchObject({ state: 'done', clipCount: 4, totalSec: 35, projectId: montageProjectId(id), formatPreset: 'youtube', progress: 1 })
    expect(job.outputPath).toBe(`D:/Root/Montages/${dayFolderName(NOW)}/Montage_Valorant_2026-11-15_21-08.mp4`)
    // mergeOnReanalyze: manual clips stay, old AI suggestions are replaced by the fresh autoclip output.
    expect(vi.mocked(selectMontageClips).mock.calls[0][1].map((c) => c.id)).toEqual(['a1', 'a2', 'a3', 'm1'])
    expect(vi.mocked(selectMontageClips).mock.calls[0][2]).toMatchObject({ videoDurationSec: 600, montage: { minClips: 2 } })
    const req = h.render.mock.calls[0][0] as MontageRenderRequest
    expect(req.format).toMatchObject({ preset: 'youtube', frame: '16:9', codec: 'h264' })
    expect(req.items.map((i) => i.clipId)).toEqual(['a1', 'a2', 'a3', 'm1'])
    expect(h.deps.saveProject).toHaveBeenCalledWith(expect.objectContaining({ id: montageProjectId(id), name: 'Montage – Valorant_2026-11-15_21-08' }))
    expect(h.calls).toEqual(['saveProject', 'render:Montage_Valorant_2026-11-15_21-08', 'addMontage:Montage_Valorant_2026-11-15_21-08.mp4'])
    expect(h.library.get(job.outputPath!)).toMatchObject({ source: 'montage', montage: { sourcePath: SRC, projectId: montageProjectId(id), jobId: id } })
    expect(h.deps.notify).toHaveBeenCalledWith('montage', 'Montage ready — 4 clips, 0:35')
    expect(h.deps.removeSource).not.toHaveBeenCalled()
    expect(h.files.has(SRC)).toBe(true)
  })

  it('live-trusted path: onMatchAnalyzed right after onMatchRecorded builds the montage', async () => {
    const h = harness()
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)?.state).toBe('done')
    expect(h.render).toHaveBeenCalledOnce()
  })

  it('status pushes include progress and the active job; jobs are listed most recent first', async () => {
    const h = harness()
    h.service.start()
    const g = h.hold()
    h.service.onMatchRecorded(SRC, 'valorant')
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await vi.waitFor(() => expect(h.service.status().active?.progress).toBe(0.5))
    expect(h.service.status().active?.state).toBe('exporting')
    g.release()
    await h.service.idle()
    expect(h.service.status().active).toBeNull()
    expect(h.deps.onStatus).toHaveBeenCalled()
    h.service.onMatchRecorded(SRC2, 'valorant')
    expect(h.service.status().jobs.map((j) => j.sourcePath)).toEqual([SRC2, SRC])
  })

  it('exports at idle priority while recording, below normal while the game runs, normal otherwise', async () => {
    const h = harness()
    h.service.start()
    await recordAndAnalyze(h)
    const control = h.render.mock.calls[0][1] as MontageRenderControl
    h.game.recording = true
    h.game.running = true
    expect(control.priority?.()).toBe('idle')
    h.game.recording = false
    expect(control.priority?.()).toBe('belowNormal')
    h.game.running = false
    expect(control.priority?.()).toBe('normal')
  })

  it('formatMontageDuration', () => {
    expect(formatMontageDuration(0)).toBe('0:00')
    expect(formatMontageDuration(65.4)).toBe('1:05')
    expect(formatMontageDuration(600)).toBe('10:00')
  })
})

describe('idempotency', () => {
  it('duplicate hooks never build a second montage', async () => {
    const h = harness()
    h.service.start()
    h.service.onMatchRecorded(SRC, 'valorant')
    h.service.onMatchRecorded(SRC, 'valorant')
    h.service.onMatchAnalyzed(SRC, 'valorant')
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await h.service.idle()
    h.service.onMatchRecorded(SRC, 'valorant')
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await h.service.idle()
    expect(h.render).toHaveBeenCalledOnce()
    expect(h.store.list()).toHaveLength(1)
  })

  it('analyzed for an unknown match does nothing', async () => {
    const h = harness()
    h.service.start()
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await h.service.idle()
    expect(h.store.list()).toEqual([])
    expect(h.render).not.toHaveBeenCalled()
  })

  it('a match whose montage is already in the library (job pruned) gets no new job', async () => {
    const h = harness()
    h.library.set('D:/Root/Montages/x.mp4', { status: 'pending', source: 'montage', montage: { jobId: id } })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.list()).toEqual([])
  })
})

describe('Auto montage off', () => {
  it('creates no job and changes nothing', async () => {
    const h = harness({}, { enabled: false })
    h.service.start()
    await recordAndAnalyze(h)
    h.service.onGameClosed()
    expect(h.store.list()).toEqual([])
    expect(h.render).not.toHaveBeenCalled()
    expect(h.deps.readCache).not.toHaveBeenCalled()
    expect(h.deps.notify).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dir, 'jobs.json'))).toBe(false)
  })

  it('turning it off cancels the running and the queued jobs', async () => {
    const h = harness()
    h.service.start()
    const g = h.hold()
    h.service.onMatchRecorded(SRC, 'valorant')
    h.service.onMatchRecorded(SRC2, 'valorant')
    h.service.onMatchAnalyzed(SRC, 'valorant')
    h.service.onMatchAnalyzed(SRC2, 'valorant')
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('exporting'))
    h.settings.montage = { ...h.settings.montage, enabled: false }
    h.service.onSettingsChanged()
    await h.service.idle()
    g.release()
    expect(h.store.get(id)?.state).toBe('cancelled')
    expect(h.store.get(montageJobId(SRC2))?.state).toBe('cancelled')
    expect(h.render).toHaveBeenCalledOnce()
    expect(h.calls.some((c) => c.startsWith('addMontage'))).toBe(false)
  })
})

describe('skip and fail reasons', () => {
  it('not VALORANT → skipped(notValorant) at record time', () => {
    const h = harness()
    h.service.start()
    h.service.onMatchRecorded(SRC, 'apex')
    expect(h.store.get(id)).toMatchObject({ state: 'skipped', skipReason: 'notValorant' })
  })

  it.each(['tooFew', 'empty'] as const)('selection %s → skipped', async (reason) => {
    const h = harness()
    vi.mocked(selectMontageClips).mockReturnValue({ clips: [], totalSec: 0, skipped: reason })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)).toMatchObject({ state: 'skipped', skipReason: reason })
    expect(h.render).not.toHaveBeenCalled()
  })

  it('source removed before selection → skipped(sourceMissing)', async () => {
    const h = harness()
    h.files.delete(SRC)
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)).toMatchObject({ state: 'skipped', skipReason: 'sourceMissing' })
  })

  it.each([
    ['below diskWarnGb', 9 * 1024 ** 3, 10],
    // 300 s at ≥25 Mbps, twice for the intermediate segments ≈ 1.8 GB, plus diskStopGb 2 GB > 3 GB free.
    ['below estimate + diskStopGb', 3 * 1024 ** 3, 1]
  ])('low disk (%s) → skipped(lowDisk) before exporting', async (_label, free, warn) => {
    const h = harness({ diskFree: async () => free })
    h.settings.diskWarnGb = warn
    vi.mocked(selectMontageClips).mockReturnValue({ clips: [clip('long', 0, 300)], totalSec: 300 })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)).toMatchObject({ state: 'skipped', skipReason: 'lowDisk' })
    expect(h.render).not.toHaveBeenCalled()
    expect(h.deps.saveProject).not.toHaveBeenCalled()
  })

  it('missing analysis → failed(analysis); engine error → failed(engine)', async () => {
    const h = harness({ readCache: () => null })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)).toMatchObject({ state: 'failed', failCode: 'analysis' })
    expect(h.deps.notify).toHaveBeenCalledWith('montage', expect.stringContaining('The montage could not be made'))

    const h2 = harness({ autoclip: async () => { throw new Error('engine down') } }, {}, new MontageJobStore(path.join(dir, 'b.json'), { now: () => NOW }))
    h2.service.start()
    await recordAndAnalyze(h2)
    expect(h2.store.get(id)).toMatchObject({ state: 'failed', failCode: 'engine' })
    expect(h2.store.get(id)?.error).toContain('engine down')
  })

  it('encoder / export failures keep their code', async () => {
    const h = harness({ render: async () => ({ ok: false, code: 'encoder', error: 'no encoder' }) })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)).toMatchObject({ state: 'failed', failCode: 'encoder', error: 'no encoder' })
  })

  it('verify failure → failed(verify), bad output deleted, nothing added, source kept even with keepSourceRecording off', async () => {
    const h = harness({ probeOutput: async () => ({ duration: 20, hasVideo: true, hasAudio: true }) }, { keepSourceRecording: false })
    h.service.start()
    await recordAndAnalyze(h)
    const job = h.store.get(id)!
    expect(job).toMatchObject({ state: 'failed', failCode: 'verify' })
    expect(job.error).toMatch(/20\.0 s, expected 35\.0 s/)
    expect(job.outputPath).toBeUndefined()
    expect(h.calls).toContain(`cleanup:Montage_Valorant_2026-11-15_21-08.mp4:rm`)
    expect(h.calls.some((c) => c.startsWith('addMontage'))).toBe(false)
    expect(h.deps.removeSource).not.toHaveBeenCalled()
    expect(h.files.has(SRC)).toBe(true)
  })

  it.each([
    ['no audio', { duration: 35, hasVideo: true, hasAudio: false }],
    ['unreadable', null]
  ])('verify fails when the output is %s', async (_label, probe) => {
    const h = harness({ probeOutput: async () => probe })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)).toMatchObject({ state: 'failed', failCode: 'verify' })
  })
})

describe('keepSourceRecording', () => {
  it('false deletes the source only after the verified montage is in the library', async () => {
    const h = harness({}, { keepSourceRecording: false })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)?.state).toBe('done')
    expect(h.calls.slice(-2)).toEqual(['addMontage:Montage_Valorant_2026-11-15_21-08.mp4', 'removeSource:Valorant_2026-11-15_21-08.mp4'])
    expect(h.files.has(SRC)).toBe(false)
  })

  it('false never deletes on a failed export or a cancel', async () => {
    const h = harness({ render: async () => ({ ok: false, code: 'export', error: 'exit 1' }) }, { keepSourceRecording: false })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)?.state).toBe('failed')
    expect(h.deps.removeSource).not.toHaveBeenCalled()
  })
})

describe('afterGameExit', () => {
  it('three matches wait while the game runs, then export one at a time after it closes', async () => {
    const h = harness({}, { timing: 'afterGameExit' })
    let running = 0
    let maxRunning = 0
    const inner = h.render.getMockImplementation() as (req: MontageRenderRequest, control: MontageRenderControl) => Promise<MontageRenderResult>
    h.render.mockImplementation(async (req: MontageRenderRequest, control: MontageRenderControl) => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((r) => setTimeout(r, 5))
      try {
        return await inner(req, control)
      } finally {
        running--
      }
    })
    h.game.running = true
    h.service.start()
    for (const src of [SRC, SRC2, SRC3]) {
      h.service.onMatchRecorded(src, 'valorant')
      h.service.onMatchAnalyzed(src, 'valorant')
    }
    await h.service.idle()
    expect([SRC, SRC2, SRC3].map((s) => h.store.getBySource(s)?.state)).toEqual(['deferred', 'deferred', 'deferred'])
    expect(h.render).not.toHaveBeenCalled()
    h.game.running = false
    h.service.onGameClosed()
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledTimes(3))
    await h.service.idle()
    expect([SRC, SRC2, SRC3].map((s) => h.store.getBySource(s)?.state)).toEqual(['done', 'done', 'done'])
    expect(maxRunning).toBe(1)
    expect(h.calls.filter((c) => c.startsWith('render:'))).toEqual([
      'render:Montage_Valorant_2026-11-15_21-08', 'render:Montage_Valorant_2026-11-15_21-48', 'render:Montage_Valorant_2026-11-15_22-30'
    ])
  })

  it('deferred jobs are also released by a "game not running" poll (e.g. after a restart)', async () => {
    const h = harness({}, { timing: 'afterGameExit' })
    h.game.running = true
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)?.state).toBe('deferred')
    h.service.setGameRunning(true)
    expect(h.render).not.toHaveBeenCalled()
    h.game.running = false
    h.service.setGameRunning(false)
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('done'))
  })

  it('afterEachMatch runs while the game is running (at lower priority)', async () => {
    const h = harness()
    h.game.running = true
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)?.state).toBe('done')
  })
})

describe('cancel, retry, quit', () => {
  it('cancel() stops the running export and marks it cancelled', async () => {
    const h = harness()
    h.service.start()
    h.hold()
    h.service.onMatchRecorded(SRC, 'valorant')
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('exporting'))
    const control = h.render.mock.calls[0][1] as MontageRenderControl
    expect(await h.service.cancel(id)).toBe(true)
    expect(control.signal.aborted).toBe(true)
    expect(h.store.get(id)).toMatchObject({ state: 'cancelled' })
    expect(h.store.get(id)?.outputPath).toBeUndefined()
    expect(await h.service.cancel(id)).toBe(false)
    expect(h.calls.some((c) => c.startsWith('addMontage'))).toBe(false)
  })

  it('cancel() of a queued job and retry() of a cancelled one', async () => {
    const h = harness({}, { timing: 'afterGameExit' })
    h.game.running = true
    h.service.start()
    await recordAndAnalyze(h)
    expect(await h.service.cancel(id)).toBe(true)
    expect(h.store.get(id)?.state).toBe('cancelled')
    h.service.onGameClosed()
    await h.service.idle()
    expect(h.render).not.toHaveBeenCalled()
    expect(h.service.retry(id)).toBe(true)
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('done'))
    expect(h.store.get(id)?.attempts).toBe(1)
    expect(h.service.retry(id)).toBe(false)
  })

  it('retry() of a failed job re-runs it', async () => {
    let fail = true
    const h = harness({ probeOutput: async () => (fail ? null : { duration: 35, hasVideo: true, hasAudio: true }) })
    h.service.start()
    await recordAndAnalyze(h)
    expect(h.store.get(id)?.state).toBe('failed')
    fail = false
    expect(h.service.retry(id)).toBe(true)
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('done'))
  })

  it('quit stops the export and the job resumes once on the next start (partial cleanup, attempts + 1)', async () => {
    const storeFile = path.join(dir, 'jobs.json')
    const h = harness({}, {}, new MontageJobStore(storeFile, { now: () => NOW }))
    h.service.start()
    h.hold()
    h.service.onMatchRecorded(SRC, 'valorant')
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('exporting'))
    await h.service.shutdown()
    expect((h.render.mock.calls[0][1] as MontageRenderControl).signal.aborted).toBe(true)
    expect(h.store.get(id)?.state).toBe('selecting')
    // Finalization during quit still records new matches (they run next time).
    h.service.onMatchRecorded(SRC2, 'valorant')
    h.service.onMatchAnalyzed(SRC2, 'valorant')
    expect(h.render).toHaveBeenCalledOnce()

    const next = harness({}, {}, new MontageJobStore(storeFile, { now: () => NOW }))
    next.service.start()
    await vi.waitFor(() => expect(next.store.get(id)?.state).toBe('done'))
    await vi.waitFor(() => expect(next.store.get(montageJobId(SRC2))?.state).toBe('done'))
    expect(next.store.get(id)?.attempts).toBe(1)
    expect(next.render).toHaveBeenCalledTimes(2)
    expect(next.calls.filter((c) => c.startsWith('addMontage'))).toHaveLength(2)
  })
})

describe('resume after restart', () => {
  function seeded(state: 'exporting' | 'selecting' | 'analyzing' | 'recorded', tag = ''): { file: string; store: MontageJobStore } {
    const file = path.join(dir, `seed-${state}${tag}.json`)
    const store = new MontageJobStore(file, { now: () => NOW })
    const { job } = store.create(SRC, 'valorant')
    if (state !== 'recorded') store.transition(job.id, 'analyzing')
    if (state === 'selecting' || state === 'exporting') store.transition(job.id, 'selecting')
    if (state === 'exporting') {
      store.transition(job.id, 'exporting', { clipCount: 4, totalSec: 35 })
      store.patch(job.id, { outputPath: 'D:/Root/Montages/2026-11-15/Montage_Valorant_2026-11-15_21-08.mp4' })
    }
    return { file, store: new MontageJobStore(file, { now: () => NOW }) }
  }

  it('an interrupted export removes its leftovers and runs again exactly once', async () => {
    const { store } = seeded('exporting')
    const h = harness({}, {}, store)
    h.service.start()
    expect(h.calls[0]).toBe('cleanup:Montage_Valorant_2026-11-15_21-08.mp4:rm')
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('done'))
    expect(h.store.get(id)?.attempts).toBe(1)
    expect(h.render).toHaveBeenCalledOnce()
    // A late analyzed event for the same match is a no-op.
    h.service.onMatchAnalyzed(SRC, 'valorant')
    await h.service.idle()
    expect(h.render).toHaveBeenCalledOnce()
  })

  it('a queued (selecting) job resumes', async () => {
    const { store } = seeded('selecting')
    const h = harness({}, {}, store)
    h.service.start()
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('done'))
  })

  it.each(['recorded', 'analyzing'] as const)('a %s job whose library entry is analyzed moves on; one still pending waits', async (state) => {
    const { store } = seeded(state)
    const h = harness({}, {}, store)
    h.library.set(SRC, { status: 'done', source: 'recording' })
    h.service.start()
    await vi.waitFor(() => expect(h.store.get(id)?.state).toBe('done'))

    const again = seeded(state, '-pending')
    const p = harness({}, {}, again.store)
    p.service.start()
    await p.service.idle()
    expect(p.store.get(id)?.state).toBe('analyzing')
    expect(p.render).not.toHaveBeenCalled()
  })

  it('jobs left over while Auto montage was turned off are cancelled at start', async () => {
    const { store } = seeded('selecting')
    const h = harness({}, { enabled: false }, store)
    h.service.start()
    await h.service.idle()
    expect(h.store.get(id)?.state).toBe('cancelled')
    expect(h.render).not.toHaveBeenCalled()
  })
})

describe('open', () => {
  it('returns the project id when the project exists, rebuilds it when it is gone, null for unknown jobs', async () => {
    const h = harness()
    h.service.start()
    await recordAndAnalyze(h)
    vi.mocked(h.deps.loadProject).mockResolvedValueOnce({ id: montageProjectId(id) })
    expect(await h.service.open(id)).toEqual({ projectId: montageProjectId(id) })
    vi.mocked(h.deps.saveProject).mockClear()
    expect(await h.service.open(id)).toEqual({ projectId: montageProjectId(id) })
    expect(h.deps.saveProject).toHaveBeenCalledOnce()
    expect(await h.service.open('m_0123456789abcdef')).toBeNull()
  })
})
