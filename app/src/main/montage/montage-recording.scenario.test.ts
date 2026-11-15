/**
 * Auto montage failure and edge scenarios on the recording side (agent D): cancelled matches and remakes, a game crash
 * mid-match, and OBS reconnects. The real finalizers (`finalize.ts`, `obs-finalize.ts`) drive a real montage service
 * (real job store on disk, real `selectMontageClips`); only the renderer and the remux ffmpeg are fakes.
 * Scenario matrix: `docs/prompts/feature-auto-record-montage.md`, plan: `docs/superpowers/plans/auto-montage.md`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import { cutMatches, finalizeSession } from '../recording/finalize'
import { finalizeObsMatches } from '../recording/obs-finalize'
import { recoverSessions } from '../recording/recovery'
import { applyMatchEvent } from '../recording/live-session'
import type { LiveMatchEvent } from '../recording/live-engine'
import { makeDeps, sessionDir, tempRoot } from '../recording/test-support'
import type { RecordingDeps } from '../recording/index'
import { MontageJobStore } from './montage-job'
import { createMontageService, type MontageService, type MontageSettingsView } from './montage-service'
import type { MontageRenderControl, MontageRenderRequest, MontageRenderResult } from './montage-export'
import { DEFAULT_AUTO_MONTAGE, montageJobId } from '../../shared/montage'
import type { CacheDoc, EngineEvent } from '../../shared/types'
import type { LiveMatch } from '../../shared/recording'
import { setActiveLocale } from '../../shared/locale'

// Remux runs through a fake ffmpeg (same technique as match-mode.test.ts): it writes its stdin to the output file.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: string[], options: unknown) => {
      if (command !== 'fake-ffmpeg') return actual.spawn(command, args, options as never)
      const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: () => void }
      if (args.includes('concat')) {
        // Jump cut (finalize.ts remuxJumpCut): join the listed parts.
        const list = args[args.indexOf('-i') + 1]
        const parts = fs.readFileSync(list, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('file ')).map((l) => l.slice(6, -1))
        fs.writeFileSync(args.at(-1)!, parts.map((p) => fs.readFileSync(path.join(path.dirname(list), p))).join(''))
        proc.stderr = new PassThrough()
        setImmediate(() => proc.emit('close', 0))
        return proc
      }
      const chunks: Buffer[] = []
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => {}
      proc.stdin = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk))
          done()
        },
        final(done) {
          fs.writeFileSync(args.at(-1)!, Buffer.concat(chunks))
          done()
          setImmediate(() => proc.emit('close', 0))
        }
      })
      return proc
    }
  }
})
vi.mock('../thumbnail', () => ({ generateThumbnail: vi.fn(async () => undefined) }))

const roots: string[] = []
const services: MontageService[] = []
beforeEach(() => setActiveLocale('en'))
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5 })
})
function root(): string {
  const r = tempRoot()
  roots.push(r)
  return r
}

const kill = (id: string, t: number): EngineEvent => ({
  id, t, type: 'kill', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto'
})
/** A 3k, a 2k and a single: three montage clips with the default settings. */
const MATCH_EVENTS = [kill('k1', 100), kill('k2', 102), kill('k3', 104), kill('k4', 200), kill('k5', 203), kill('k6', 300)]

function cacheFor(videoPath: string, events: EngineEvent[], duration = 600): CacheDoc {
  return {
    version: 1,
    video: { path: videoPath, size: 1, mtime: 1, duration, width: 1920, height: 1080, codec: 'h264', start_time: 0, fps: 60 },
    analysis: { status: 'done', progress_t: duration, engine_version: 'x', templates_version: 'x', h_scale: 1 },
    events,
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: videoPath + '.aditor.json',
    game: 'valorant'
  }
}

/** A real montage service (real job store, real selection) with a fake renderer that writes a small file. */
function montageRig(base: string, montage: Partial<MontageSettingsView['montage']> = {}) {
  const settings: MontageSettingsView = {
    montage: { ...DEFAULT_AUTO_MONTAGE, include: { ...DEFAULT_AUTO_MONTAGE.include }, enabled: true, ...montage },
    autoclip: { gap: 10, n: 5, before: 3, after: 2, max_len: 60 },
    diskWarnGb: 10,
    diskStopGb: 2,
    storageRoot: path.join(base, 'storage')
  }
  const caches = new Map<string, CacheDoc>()
  const library = new Map<string, { status: string; source?: string; montage?: { jobId: string } }>()
  fs.mkdirSync(path.join(base, 'montage'), { recursive: true })
  const store = new MontageJobStore(path.join(base, 'montage', 'jobs.json'))
  const render = vi.fn(async (req: MontageRenderRequest, control: MontageRenderControl): Promise<MontageRenderResult> => {
    const out = path.join(req.outDir, `${req.baseName}.mp4`)
    control.onPlanned?.(out)
    fs.writeFileSync(out, 'montage')
    return { ok: true, outputPath: out, encoder: 'libopenh264' }
  })
  const notify = vi.fn()
  const service = createMontageService({
    store,
    getSettings: () => settings,
    library: {
      get: (p) => library.get(p),
      hasMontage: (id) => [...library.values()].some((e) => e.source === 'montage' && e.montage?.jobId === id),
      addMontage: (out, info) => {
        library.set(out, { status: 'pending', source: 'montage', montage: info })
      }
    },
    saveProject: async () => {},
    loadProject: async () => null,
    readCache: (p) => caches.get(p) ?? null,
    autoclip: async () => [],
    render,
    probeOutput: async (file) => ({ duration: store.list().find((j) => j.outputPath === file)?.totalSec ?? 0, hasVideo: true, hasAudio: true }),
    diskFree: async () => 500 * 1024 ** 3,
    fileExists: (f) => fs.existsSync(f),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    cleanupOutput: () => {},
    removeSource: async () => {},
    notify,
    now: () => Date.now(),
    isGameRunning: () => false,
    isRecording: () => false
  })
  services.push(service)
  service.start()
  /** Recording deps hooks wired like `main/index.ts`, plus the library add. */
  const wire = (deps: RecordingDeps): void => {
    deps.addToLibrary = vi.fn((paths: string[]) => {
      for (const p of paths) if (!library.has(p)) library.set(p, { status: 'pending', source: 'recording' })
    })
    deps.onMatchRecorded = vi.fn((p: string, g) => service.onMatchRecorded(p, g))
    deps.onMatchAnalyzed = vi.fn((p: string, g) => service.onMatchAnalyzed(p, g))
  }
  const montageFiles = (): string[] => {
    const dir = path.join(settings.storageRoot, 'Montages')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  }
  return { settings, caches, library, store, render, notify, service, wire, montageFiles }
}

/** A per-match session with text segments (remuxed by the fake ffmpeg), like the match-mode test rig. */
const ENTRIES = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
function matchSession(base: string, live: { matches: LiveMatch[] } & Record<string, unknown>, postAnalysis: 'none' | 'afterExit' | 'perMatch' = 'perMatch') {
  const deps = makeDeps(base)
  const dir = sessionDir(base)
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: new Date(2026, 10, 15, 21, 8).getTime(), postAnalysis, mode: 'match', game: 'valorant' }))
  fs.writeFileSync(path.join(dir, 'init.mp4'), 'init|')
  for (const e of ENTRIES) fs.writeFileSync(path.join(dir, `seg_${String(e.seq).padStart(6, '0')}.m4s`), `${e.pts}|`)
  fs.writeFileSync(path.join(dir, 'index.jsonl'), ENTRIES.map((e) => JSON.stringify(e) + '\n').join(''))
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ engine_version: '0.3.0', events: [], spectating: [], quality: { complete: false }, width: 1920, height: 1080, ...live }))
  deps.ffmpegPath = 'fake-ffmpeg'
  deps.enqueueAnalysis = vi.fn()
  deps.onLiveAnalysis = vi.fn()
  deps.liveCachePath = (output) => output + '.aditor.json'
  deps.getSettings = () => ({ ...makeDeps(base).getSettings(), postAnalysis })
  return { deps, dir }
}

// ---------------------------------------------------------------------------------------------------------------------

describe('scenario 1: match cancelled (matchCancel) or remake', () => {
  it('a countdown that is cancelled (match_pending → match_cancel) creates no match, no job and no file', async () => {
    const base = root()
    const m = montageRig(base)
    const events: LiveMatchEvent[] = [{ ev: 'match_pending', t: 5, reason: 'countdown' }, { ev: 'match_cancel', t: 20, reason: 'countdown' }]
    const matches = events.reduce<LiveMatch[]>((acc, e) => applyMatchEvent(acc, e), [])
    expect(matches).toEqual([])
    const { deps, dir } = matchSession(base, { matches })
    m.wire(deps)
    fs.writeFileSync(path.join(dir, 'live-complete.json'), '{"version":1}')
    expect(await finalizeSession(dir, deps)).toEqual([])
    expect(deps.onMatchRecorded).not.toHaveBeenCalled()
    expect(m.store.list()).toEqual([])
    expect(m.render).not.toHaveBeenCalled()
    expect(m.montageFiles()).toEqual([])
  })

  it('a match index recorded as skipped in matches.json is never reported to the montage service', async () => {
    const base = root()
    const m = montageRig(base)
    const { deps, dir } = matchSession(base, { matches: [{ start: 10, end: 18 }] })
    m.wire(deps)
    fs.writeFileSync(path.join(dir, 'matches.json'), JSON.stringify({ cuts: [], skipped: [0] }))
    expect(await cutMatches(dir, deps, { finishing: true })).toEqual([])
    expect(deps.onMatchRecorded).not.toHaveBeenCalled()
    expect(m.store.list()).toEqual([])
    expect(m.montageFiles()).toEqual([])
  })

  it('OBS: a cancelled or unconfirmed per-match recording is never reported to the montage service', async () => {
    const base = root()
    const m = montageRig(base)
    const deps = makeDeps(base)
    m.wire(deps)
    deps.probeVideo = async () => ({ duration: 2 }) as never
    deps.obsFileSettleMs = 1
    const dir = sessionDir(base)
    fs.mkdirSync(path.join(base, 'obs'))
    const file = path.join(base, 'obs', 'OBS_1.mkv')
    fs.writeFileSync(file, 'obs video')
    fs.writeFileSync(path.join(dir, 'obs.json'), JSON.stringify({ captureStartedAt: 0, recordStartedAt: 0 }))
    const matches = [
      { index: 1, recordStartedAt: 0, stopped: true, confirmed: false, outputPath: file },
      { index: 2, recordStartedAt: 0, stopped: true, cancelled: true }
    ]
    const config = { startedAt: 0, postAnalysis: 'perMatch' as const, mode: 'match' as const, game: 'valorant' as const }
    expect(await finalizeObsMatches(dir, deps, config, matches as never, false)).toEqual([])
    expect(deps.onMatchRecorded).not.toHaveBeenCalled()
    expect(m.store.list()).toEqual([])
  })

  it.each([
    ['a remake with one kill', 'tooFew', [kill('k1', 30)]],
    ['a remake with no kills', 'empty', []]
  ] as const)('%s → skipped(%s), no render and no file', async (_label, reason, events) => {
    const base = root()
    const m = montageRig(base)
    const { deps, dir } = matchSession(base, { matches: [{ start: 10, end: 40 }] })
    m.wire(deps)
    // Healthy detection: a remake is not a detection failure, so the footage outside the match is not kept as a remainder.
    fs.writeFileSync(path.join(dir, 'live-complete.json'), '{"version":1}')
    const outputs = await finalizeSession(dir, deps)
    expect(outputs).toHaveLength(1)
    m.caches.set(outputs[0], cacheFor(outputs[0], [...events], 40))
    m.service.onMatchAnalyzed(outputs[0], 'valorant')
    await m.service.idle()
    expect(m.store.getBySource(outputs[0])).toMatchObject({ state: 'skipped', skipReason: reason })
    expect(m.render).not.toHaveBeenCalled()
    expect(m.montageFiles()).toEqual([])
  })
})

describe('scenario 2: game crash mid-match', () => {
  it('a match without match_end is cut at the last segment and gets exactly one job, even when finalization is retried', async () => {
    const base = root()
    const m = montageRig(base)
    // The game crashed: the last match never got its match_end.
    const { deps, dir } = matchSession(base, { matches: [{ start: 10, end: null }] })
    m.wire(deps)
    // The app dies right after the montage hook (enqueue throws), so startup recovery finalizes the session again.
    let crashes = 1
    deps.enqueueAnalysis = vi.fn(() => {
      if (crashes-- > 0) throw new Error('crash during finalization')
    })
    await expect(finalizeSession(dir, deps)).rejects.toThrow('crash during finalization')
    const failed = vi.fn()
    await recoverSessions(deps, vi.fn(), failed)
    expect(failed).not.toHaveBeenCalled()
    expect(fs.existsSync(dir)).toBe(false)

    const recorded = vi.mocked(deps.onMatchRecorded!).mock.calls.map((c) => c[0])
    expect(recorded.length).toBeGreaterThanOrEqual(2)
    expect(new Set(recorded).size).toBe(1)
    expect(m.store.list()).toHaveLength(1)
    const output = recorded[0]
    expect(m.store.getBySource(output)?.state).toBe('analyzing')

    // Analysis of the truncated recording finishes: one montage.
    m.caches.set(output, cacheFor(output, MATCH_EVENTS.map((e) => ({ ...e, t: e.t / 4 })), 98))
    m.service.onMatchAnalyzed(output, 'valorant')
    m.service.onMatchAnalyzed(output, 'valorant')
    await m.service.idle()
    expect(m.store.getBySource(output)?.state).toBe('done')
    expect(m.render).toHaveBeenCalledOnce()
    expect(m.montageFiles()).toHaveLength(1)
  })

  it('a crashed match whose analysis is missing or has no duration fails cleanly (failed(analysis)), without throwing', async () => {
    const base = root()
    const m = montageRig(base)
    const { deps, dir } = matchSession(base, { matches: [{ start: 10, end: null }] })
    m.wire(deps)
    const [output] = await finalizeSession(dir, deps)
    m.caches.set(output, { ...cacheFor(output, MATCH_EVENTS), video: { ...cacheFor(output, []).video, duration: 0 } })
    m.service.onMatchAnalyzed(output, 'valorant')
    await m.service.idle()
    expect(m.store.getBySource(output)).toMatchObject({ state: 'failed', failCode: 'analysis' })
    expect(m.render).not.toHaveBeenCalled()
    // The service is still alive for the next match.
    expect(m.service.status().active).toBeNull()
  })
})

describe('scenario 11: OBS backend reconnect', () => {
  function obsRig(base: string) {
    const m = montageRig(base)
    const deps = makeDeps(base)
    m.wire(deps)
    // The full analysis finishes right away (the queue's 'analyzed' event).
    const analyzed: string[] = []
    deps.enqueueAnalysis = vi.fn((p: string) => analyzed.push(p))
    deps.probeVideo = async () => ({ duration: 600 }) as never
    deps.obsFileSettleMs = 1
    deps.getSettings = () => ({ ...makeDeps(base).getSettings(), postAnalysis: 'perMatch' })
    const dir = sessionDir(base)
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: 0, postAnalysis: 'perMatch', game: 'valorant', backend: 'obs', mode: 'match' }))
    fs.mkdirSync(path.join(base, 'obs'))
    const files = ['OBS_1.mkv', 'OBS_2.mkv'].map((f) => path.join(base, 'obs', f))
    for (const f of files) {
      fs.writeFileSync(f, 'obs video')
      m.caches.set(f, cacheFor(f, MATCH_EVENTS))
    }
    fs.writeFileSync(path.join(dir, 'obs.json'), JSON.stringify({ captureStartedAt: 0, recordStartedAt: 0 }))
    const config = { startedAt: 0, postAnalysis: 'perMatch' as const, mode: 'match' as const, game: 'valorant' as const }
    const flushAnalyzed = async (): Promise<void> => {
      for (const p of analyzed.splice(0)) m.service.onMatchAnalyzed(p, 'valorant')
      await m.service.idle()
    }
    return { m, deps, dir, files, config, flushAnalyzed }
  }

  it('finalizing again after a reconnect (same and stale match state, duplicate entry) yields one job and one montage per file', async () => {
    const base = root()
    const r = obsRig(base)
    const matches = r.files.map((f, i) => ({ index: i + 1, recordStartedAt: 0, stopped: true, outputPath: f }))
    // Snapshot taken before the first finalize, as if the obs-matches.json save was lost when OBS dropped.
    const stale = JSON.parse(JSON.stringify(matches))
    await finalizeObsMatches(r.dir, r.deps, r.config, matches as never, false)
    await r.flushAnalyzed()
    // Reconnect: the per-match finalization runs again with the persisted state…
    await finalizeObsMatches(r.dir, r.deps, r.config, matches as never, false)
    await r.flushAnalyzed()
    // …and with the stale state (added: false), plus a duplicate entry for the first file.
    const replay = [...stale, { ...stale[0], index: 3 }]
    await finalizeObsMatches(r.dir, r.deps, r.config, replay as never, true)
    await r.flushAnalyzed()

    expect(vi.mocked(r.deps.onMatchRecorded!).mock.calls.length).toBeGreaterThan(2)
    expect(r.m.store.list().map((j) => j.sourcePath).sort()).toEqual([...r.files].sort())
    expect(r.files.map((f) => r.m.store.getBySource(f)?.state)).toEqual(['done', 'done'])
    expect(r.m.store.list().map((j) => j.id).sort()).toEqual(r.files.map(montageJobId).sort())
    expect(r.m.render).toHaveBeenCalledTimes(2)
    expect(r.m.montageFiles()).toHaveLength(2)
    expect([...r.m.library.values()].filter((e) => e.source === 'montage')).toHaveLength(2)
  })
})
