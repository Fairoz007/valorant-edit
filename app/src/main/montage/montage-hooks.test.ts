/**
 * Auto montage call sites outside the montage service: finalization (built-in and OBS), the analysis queue's 'analyzed' event,
 * the game-closed hook and the quit guard. No FFmpeg: finalization runs on already-published outputs (the recovery paths).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { cutMatches, finalizeSession } from '../recording/finalize'
import { finalizeObsMatches } from '../recording/obs-finalize'
import { makeDeps, tempRoot, waitFor } from '../recording/test-support'
import { RecordingSessionService } from '../recording/session'
import { AnalysisQueue } from '../queue'
import { Library } from '../library'
import type { EngineClient } from '../engine'
import { createAppQuitGuard } from '../quit-guard'

vi.mock('../thumbnail', () => ({ generateThumbnail: vi.fn(async () => undefined) }))

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
function root(): string {
  const r = tempRoot()
  roots.push(r)
  return r
}
function session(base: string, recording: Record<string, unknown>): string {
  const dir = path.join(base, 'videos', '.sessions', '20261115-210800-abcd')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: new Date(2026, 10, 15, 21, 8).getTime(), ...recording }))
  return dir
}
function hooks(base: string) {
  const deps = makeDeps(base)
  const calls: string[] = []
  deps.addToLibrary = vi.fn(() => calls.push('add'))
  deps.enqueueAnalysis = vi.fn(() => calls.push('enqueue'))
  deps.onMatchRecorded = vi.fn((p: string, g: string) => calls.push(`recorded:${path.basename(p)}:${g}`))
  deps.onMatchAnalyzed = vi.fn((p: string, g: string) => calls.push(`analyzed:${path.basename(p)}:${g}`))
  return { deps, calls }
}

describe('built-in finalization', () => {
  it.each([
    ['full analysis queued', { liveCached: true, postAnalysis: 'perMatch', analysisQueued: false }, ['add', 'recorded:Valorant_x.mp4:valorant', 'enqueue']],
    ['trusted live cache, no full analysis', { liveCached: true, liveTrusted: true, postAnalysis: 'afterExit', analysisQueued: false }, ['add', 'recorded:Valorant_x.mp4:valorant', 'analyzed:Valorant_x.mp4:valorant']]
  ])('finalizeSession: %s', async (_label, marker, expected) => {
    const base = root()
    const { deps, calls } = hooks(base)
    const dir = session(base, { postAnalysis: 'perMatch', game: 'valorant' })
    const outputPath = path.join(base, 'videos', 'Valorant_x.mp4')
    fs.writeFileSync(outputPath, 'video')
    fs.writeFileSync(path.join(dir, 'finalized.json'), JSON.stringify({ outputPath, ...marker }))
    expect(await finalizeSession(dir, deps)).toEqual([outputPath])
    expect(calls).toEqual(expected)
  })

  it.each([
    ['perMatch (full analysis)', 'perMatch', false, ['add', 'recorded:Valorant_m1.mp4:valorant', 'enqueue']],
    ['afterExit with a trusted live cache', 'afterExit', true, ['add', 'recorded:Valorant_m1.mp4:valorant', 'analyzed:Valorant_m1.mp4:valorant']]
  ])('per-match cut (completeCut): %s', async (_label, postAnalysis, liveTrusted, expected) => {
    const base = root()
    const { deps, calls } = hooks(base)
    const dir = session(base, { postAnalysis, game: 'valorant', mode: 'match' })
    const outputPath = path.join(base, 'videos', 'Valorant_m1.mp4')
    fs.writeFileSync(outputPath, 'video')
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ matches: [{ start: 0, end: 10 }] }))
    fs.writeFileSync(path.join(dir, 'matches.json'), JSON.stringify({ cuts: [{ index: 0, start: 0, end: 10, firstSeq: 1, lastSeq: 1, outputPath, analysisQueued: false, liveCached: true, liveTrusted }] }))
    await cutMatches(dir, deps, { finishing: true })
    expect(calls).toEqual(expected)
  })

  it('a throwing montage hook never breaks finalization', async () => {
    const base = root()
    const { deps } = hooks(base)
    deps.onMatchRecorded = () => { throw new Error('boom') }
    const dir = session(base, { postAnalysis: 'perMatch', game: 'valorant' })
    const outputPath = path.join(base, 'videos', 'Valorant_x.mp4')
    fs.writeFileSync(outputPath, 'video')
    fs.writeFileSync(path.join(dir, 'finalized.json'), JSON.stringify({ outputPath, liveCached: true, postAnalysis: 'perMatch' }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await finalizeSession(dir, deps)).toEqual([outputPath])
    expect(deps.enqueueAnalysis).toHaveBeenCalledWith(outputPath)
    err.mockRestore()
  })
})

describe('OBS finalization', () => {
  function obs(base: string, postAnalysis: string, match: Record<string, unknown>) {
    const { deps, calls } = hooks(base)
    deps.probeVideo = async () => ({ duration: 2 })
    deps.obsFileSettleMs = 1
    deps.getSettings = () => ({ ...makeDeps(base).getSettings(), postAnalysis: postAnalysis as 'perMatch' })
    const dir = session(base, { postAnalysis, game: 'valorant', backend: 'obs', mode: 'match' })
    fs.mkdirSync(path.join(base, 'obs'))
    const file = path.join(base, 'obs', 'OBS_1.mkv')
    fs.writeFileSync(file, 'obs video')
    fs.writeFileSync(path.join(dir, 'obs.json'), JSON.stringify({ captureStartedAt: 0, recordStartedAt: 0 }))
    const matches = [{ index: 1, recordStartedAt: 0, stopped: true, outputPath: file, ...match }]
    return { deps, calls, dir, matches, config: { startedAt: 0, postAnalysis: postAnalysis as 'perMatch', mode: 'match' as const, game: 'valorant' as const } }
  }

  it('finalizeObsMatches: recorded after the library add, then the full analysis is queued', async () => {
    const base = root()
    const r = obs(base, 'perMatch', {})
    await finalizeObsMatches(r.dir, r.deps, r.config, r.matches as never, false)
    expect(r.calls).toEqual(['add', 'recorded:OBS_1.mkv:valorant', 'enqueue'])
  })

  it('finalizeObsMatches: a trusted live cache with no full analysis reports analyzed', async () => {
    const base = root()
    const r = obs(base, 'afterExit', { added: true, liveCached: true, liveTrusted: true, analysisQueued: false })
    await finalizeObsMatches(r.dir, r.deps, r.config, r.matches as never, false)
    expect(r.calls).toEqual(['analyzed:OBS_1.mkv:valorant'])
  })
})

describe("AnalysisQueue 'analyzed' event", () => {
  function rig(base: string) {
    const library = new Library(path.join(base, 'library.json'))
    const video = path.join(base, 'Valorant_x.mp4')
    library.add([video], 'recording', 'valorant')
    const runs: Array<{ resolve: (doc: unknown) => void; reject: (err: Error) => void }> = []
    const engine = {
      request: vi.fn(() => {
        const promise = new Promise((resolve, reject) => runs.push({ resolve, reject }))
        return { id: String(runs.length), promise }
      }),
      cancel: vi.fn()
    }
    const queue = new AnalysisQueue(engine as unknown as EngineClient, library, { profileDir: base, cacheDir: base })
    const analyzed = vi.fn()
    queue.on('analyzed', analyzed)
    return { queue, runs, analyzed, video, library }
  }
  const doc = { video: { duration: 10 }, events: [], game: 'valorant' }

  it('is emitted once after a successful run, after the library is updated', async () => {
    const base = root()
    const r = rig(base)
    r.analyzed.mockImplementation(() => expect(r.library.get(r.video)?.status).toBe('done'))
    r.queue.enqueue(r.video)
    r.runs[0].resolve(doc)
    await vi.waitFor(() => expect(r.analyzed).toHaveBeenCalledWith(r.video, 'valorant'))
    expect(r.analyzed).toHaveBeenCalledOnce()
  })

  it('is not emitted for a cancelled or failed run', async () => {
    const base = root()
    const r = rig(base)
    r.queue.enqueue(r.video)
    r.queue.cancel(r.video)
    r.runs[0].resolve(doc)
    await vi.waitFor(() => expect(r.queue.snapshot().analyzing).toBeNull())
    await new Promise((res) => setTimeout(res, 20))
    r.queue.enqueue(r.video)
    await vi.waitFor(() => expect(r.runs).toHaveLength(2))
    r.runs[1].reject(new Error('engine crashed'))
    await vi.waitFor(() => expect(r.library.get(r.video)?.status).toBe('error'))
    expect(r.analyzed).not.toHaveBeenCalled()
  })

  it('a throwing listener does not break the queue', async () => {
    const base = root()
    const r = rig(base)
    r.analyzed.mockImplementation(() => { throw new Error('listener') })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    r.queue.enqueue(r.video)
    r.runs[0].resolve(doc)
    await vi.waitFor(() => expect(r.analyzed).toHaveBeenCalled())
    expect(r.library.get(r.video)?.status).toBe('done')
    err.mockRestore()
  })
})

describe('game closed hook', () => {
  it('fires on every running → closed change, regardless of openOnGameExit', async () => {
    const base = root()
    const deps = makeDeps(base)
    let pid: number | null = 4321
    deps.findApexPid = undefined
    deps.findGame = async () => (pid ? { game: 'valorant', pid } : null)
    deps.getSettings = () => ({ ...makeDeps(base).getSettings(), autoRecord: false, openOnGameExit: false })
    deps.onGameClosed = vi.fn()
    deps.onGameExit = vi.fn()
    const service = new RecordingSessionService(deps)
    service.start()
    try {
      await new Promise((r) => setTimeout(r, 80))
      expect(deps.onGameClosed).not.toHaveBeenCalled()
      pid = null
      await waitFor(() => vi.mocked(deps.onGameClosed!).mock.calls.length === 1)
      pid = 4322
      await new Promise((r) => setTimeout(r, 80))
      pid = null
      await waitFor(() => vi.mocked(deps.onGameClosed!).mock.calls.length === 2)
      expect(deps.onGameExit).not.toHaveBeenCalled()
    } finally {
      await service.stop()
    }
  })
})

describe('quit guard', () => {
  it('cancels the montage export early and waits for it before quitting', async () => {
    let finished = false
    const quit = vi.fn()
    const guard = createAppQuitGuard({
      stopRecording: () => undefined,
      flushLibrary: () => true,
      stopEngine: () => undefined,
      cancelExport: () => undefined,
      cancelProxies: () => undefined,
      cancelMontage: () => new Promise<void>((r) => setTimeout(() => { finished = true; r() }, 30)),
      stopWatcher: () => undefined,
      quit,
      timeoutMs: 5000
    })
    guard.onBeforeQuit({ preventDefault: () => undefined })
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(finished).toBe(true)
  })
})
