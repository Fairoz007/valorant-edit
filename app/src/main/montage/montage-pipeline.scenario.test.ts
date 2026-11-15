/**
 * Auto montage failure and edge scenarios on the export side (agent D). Everything is real except the engine and ffmpeg:
 * the montage service, the job store on disk, `selectMontageClips`, the montage renderer, `runExport` spawning a fake ffmpeg
 * child process (`test/fake-ffmpeg.mjs`), `cleanupMontageOutput`, the Library, the ProjectStore, the analysis cache files,
 * the AnalysisQueue and the quit guard.
 * Tests named "(defect)" describe the expected behaviour and fail until the lead applies the fix in the report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MontageJobStore } from './montage-job'
import { createMontageService, type MontageService, type MontageServiceDeps, type MontageSettingsView } from './montage-service'
import { cleanupMontageOutput, createMontageRenderer } from './montage-export'
import { exportFailureMessage, runExport, type RunExportControl, type RunExportOptions, type RunExportResult } from '../export/run'
import { Library } from '../library'
import { ProjectStore, type StoredProject } from '../projects'
import { cacheFilePath, loadCacheDoc, resolveCacheFile, saveCacheDoc } from '../cache-io'
import { AnalysisQueue } from '../queue'
import { EngineError, type EngineClient } from '../engine'
import { createAppQuitGuard } from '../quit-guard'
import { cutMatches } from '../recording/finalize'
import { makeDeps } from '../recording/test-support'
import { loadSettings, migrateSettings } from '../settings'
import { DEFAULT_AUTO_MONTAGE, montageJobId, montageProjectId } from '../../shared/montage'
import { buildMontageProject } from '../../shared/montageProject'
import { mergeOnReanalyze } from '../../shared/clips'
import type { CacheDoc, Clip, EngineEvent } from '../../shared/types'
import { setActiveLocale } from '../../shared/locale'

vi.mock('../thumbnail', () => ({ generateThumbnail: vi.fn(async () => undefined) }))

const FAKE_FFMPEG = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')
const GB = 1024 ** 3
const FAKE_ENV = ['FAKE_FFMPEG_SLEEP_MS', 'FAKE_FFMPEG_SLEEP_MAP', 'FAKE_FFMPEG_EXIT', 'FAKE_FFMPEG_EXIT_MAP', 'FAKE_FFMPEG_GRANDCHILD', 'FAKE_FFMPEG_PID_DIR', 'FAKE_FFMPEG_STDERR_BYTES']

const kill = (id: string, t: number): EngineEvent => ({
  id, t, type: 'kill', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto'
})
/** 3k [97,106], 2k [197,205], single [297,302] with before 3 / after 2: three clips, 22 s. */
const EVENTS = [kill('k1', 100), kill('k2', 102), kill('k3', 104), kill('k4', 200), kill('k5', 203), kill('k6', 300)]
const TOTAL_SEC = 22

const roots: string[] = []
const services: MontageService[] = []
beforeEach(() => {
  setActiveLocale('en')
  for (const k of FAKE_ENV) delete process.env[k]
})
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  vi.restoreAllMocks()
  for (const k of FAKE_ENV) delete process.env[k]
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface RigOptions {
  /** Share the root (and the job store, library, projects and cache) with an earlier rig: a restart. */
  root?: string
  montage?: Partial<MontageSettingsView['montage']>
  over?: Partial<MontageServiceDeps>
  run?: (opts: RunExportOptions, control: RunExportControl) => Promise<RunExportResult>
  start?: boolean
  events?: EngineEvent[]
}

function rig(opts: RigOptions = {}) {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'montage-scn-'))
  if (!opts.root) roots.push(root)
  const recDir = path.join(root, 'Recordings', '2026-11-15')
  const outDir = path.join(root, 'Montages')
  const cacheDir = path.join(root, 'cache')
  const pidDir = path.join(root, 'pids')
  for (const d of [recDir, cacheDir, pidDir, path.join(root, 'montage'), path.join(root, 'tmp')]) fs.mkdirSync(d, { recursive: true })
  const src = path.join(recDir, 'Valorant_2026-11-15_21-08.mp4')
  const src2 = path.join(recDir, 'Valorant_2026-11-15_21-48.mp4')
  const library = new Library(path.join(root, 'library.json'))
  const projects = new ProjectStore(path.join(root, 'projects'))
  if (!opts.root) {
    for (const s of [src, src2]) {
      fs.writeFileSync(s, 'recording')
      writeCache(s, opts.events ?? EVENTS)
    }
    library.add([src, src2], 'recording', 'valorant')
  }
  function writeCache(videoPath: string, events: EngineEvent[], clips: Clip[] = [{ id: 'm1', start: 400, end: 405, origin: 'manual', event_ids: [] }]): CacheDoc {
    const doc: CacheDoc = {
      version: 1,
      video: { path: videoPath, size: 1, mtime: 1, duration: 600, width: 1920, height: 1080, codec: 'h264', start_time: 0, fps: 60 },
      analysis: { status: 'done', progress_t: 600, engine_version: 'x', templates_version: 'x', h_scale: 1 },
      events,
      spectating: [],
      clips,
      keyframes: [],
      cache_path: cacheFilePath(videoPath, cacheDir),
      game: 'valorant'
    }
    saveCacheDoc(doc)
    return doc
  }
  const settings: MontageSettingsView = {
    montage: { ...DEFAULT_AUTO_MONTAGE, include: { ...DEFAULT_AUTO_MONTAGE.include }, enabled: true, outputDir: outDir, ...opts.montage },
    autoclip: { gap: 10, n: 5, before: 3, after: 2, max_len: 60 },
    diskWarnGb: 10,
    diskStopGb: 2,
    storageRoot: root
  }
  const storeFile = path.join(root, 'montage', 'jobs.json')
  const store = new MontageJobStore(storeFile)
  const game = { running: false, recording: false }
  const encoders = { list: ['h264_nvenc', 'libopenh264'] }
  process.env.FAKE_FFMPEG_PID_DIR = pidDir
  const run = vi.fn((o: RunExportOptions, c?: RunExportControl) => (opts.run ?? runExport)(o, c ?? {}))
  const notify = vi.fn()
  const deps: MontageServiceDeps = {
    store,
    getSettings: () => settings,
    library: {
      get: (p) => library.get(p),
      hasMontage: (id) => library.hasMontage(id),
      addMontage: (out, info, extra) => {
        library.addMontage(out, info, extra)
      }
    },
    saveProject: vi.fn((p) => projects.save(p as StoredProject)),
    loadProject: (id) => projects.load(id),
    readCache: (p) => loadCacheDoc(resolveCacheFile(p, cacheDir, false)) as CacheDoc | null,
    autoclip: vi.fn(async () => [] as Clip[]),
    render: createMontageRenderer({
      detectEncoders: async () => encoders.list,
      ffmpeg: { bin: process.execPath, prefixArgs: [FAKE_FFMPEG] },
      tempDir: path.join(root, 'tmp'),
      hasAudio: async () => true,
      mediaEnd: async () => null,
      run
    }),
    probeOutput: vi.fn(async (file: string) => (fs.existsSync(file) ? { duration: store.list().find((j) => j.outputPath === file)?.totalSec ?? 0, hasVideo: true, hasAudio: true } : null)),
    diskFree: async () => 500 * GB,
    fileExists: (f) => {
      try {
        return fs.statSync(f).isFile()
      } catch {
        return false
      }
    },
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    cleanupOutput: cleanupMontageOutput,
    // Same path as main/index.ts: only a recording entry is removed (entry and file).
    removeSource: vi.fn(async (p: string) => {
      const entry = library.get(p)
      if (!entry || entry.source !== 'recording') return
      library.remove(p)
    }),
    notify,
    now: () => Date.now(),
    isGameRunning: () => game.running,
    isRecording: () => game.recording,
    ...opts.over
  }
  const service = createMontageService(deps)
  services.push(service)
  if (opts.start !== false) service.start()
  const id = montageJobId(src)
  const outFiles = (): string[] => (fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : [])
  const montageEntries = () => library.getEntries().filter((e) => e.source === 'montage')
  const pids = (): Array<{ ffmpeg: number; grandchild: number | null }> =>
    fs.readdirSync(pidDir).filter((f) => f.endsWith('.pids.json')).map((f) => JSON.parse(fs.readFileSync(path.join(pidDir, f), 'utf8')))
  const record = (p = src): void => {
    service.onMatchRecorded(p, 'valorant')
    service.onMatchAnalyzed(p, 'valorant')
  }
  return { root, src, src2, outDir, cacheDir, storeFile, library, projects, settings, store, game, encoders, run, notify, deps, service, id, outFiles, montageEntries, pids, record, writeCache }
}

type Rig = ReturnType<typeof rig>

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitExporting = async (r: Rig, id = r.id): Promise<void> => {
  await vi.waitFor(() => {
    expect(r.store.get(id)?.state).toBe('exporting')
    expect(r.pids().length).toBeGreaterThan(0)
  }, { timeout: 10_000 })
}

// ---------------------------------------------------------------------------------------------------------------------

describe('scenario 3: app crash mid-export, then restart', () => {
  function crashedRig() {
    const first = rig({ start: false })
    // State on disk at the moment of the crash: the job is exporting, its planned output is recorded, and the export left
    // a .partial, a uuid .partial, intermediate segments and even a published but unverified output behind.
    const out = path.join(first.outDir, 'Montage_Valorant_2026-11-15_21-08.mp4')
    const s = first.store
    s.create(first.src, 'valorant')
    s.transition(first.id, 'analyzing')
    s.transition(first.id, 'selecting')
    s.transition(first.id, 'exporting', { clipCount: 3, totalSec: TOTAL_SEC, projectId: montageProjectId(first.id), formatPreset: 'youtube', progress: 0.4 })
    s.patch(first.id, { outputPath: out })
    fs.mkdirSync(first.outDir, { recursive: true })
    for (const f of [
      'Montage_Valorant_2026-11-15_21-08.mp4',
      'Montage_Valorant_2026-11-15_21-08.partial.mp4',
      'Montage_Valorant_2026-11-15_21-08.0f8fad5b-d9cb-469f-a165-70867728950e.partial.mp4',
      '.aditor-seg-ab12cd-0.mov',
      '.aditor-seg-ab12cd-1.partial.mov',
      'Montage_Older_match.mp4'
    ]) fs.writeFileSync(path.join(first.outDir, f), 'leftover')
    return first
  }

  it('the job resumes once: attempts + 1, no .partial or segment left, one montage file, one library entry', async () => {
    const first = crashedRig()
    const next = rig({ root: first.root })
    await vi.waitFor(() => expect(next.store.get(next.id)?.state).toBe('done'), { timeout: 15_000 })
    await next.service.idle()
    expect(next.store.get(next.id)).toMatchObject({ state: 'done', attempts: 1, clipCount: 3, totalSec: TOTAL_SEC })
    expect(next.outFiles()).toEqual(['Montage_Older_match.mp4', 'Montage_Valorant_2026-11-15_21-08.mp4'])
    expect(fs.readFileSync(path.join(next.outDir, 'Montage_Valorant_2026-11-15_21-08.mp4'), 'utf8')).toBe('complete-data')
    expect(next.montageEntries()).toHaveLength(1)
    expect(next.montageEntries()[0]).toMatchObject({ montage: { sourcePath: next.src, jobId: next.id, projectId: montageProjectId(next.id) } })
    expect(next.run).toHaveBeenCalledOnce()
    expect(fs.readdirSync(path.join(next.root, 'tmp'))).toEqual([])
    // Persisted: a third start does nothing.
    expect(new MontageJobStore(next.storeFile).get(next.id)?.state).toBe('done')
    const third = rig({ root: first.root })
    third.record()
    await third.service.idle()
    expect(third.run).not.toHaveBeenCalled()
    expect(third.montageEntries()).toHaveLength(1)
  })
})

describe('scenario 4: low disk', () => {
  it.each([
    ['below diskWarnGb', 9 * GB, 10],
    ['below the estimate plus diskStopGb', 2 * GB + 1, 1]
  ])('%s → skipped(lowDisk) before exporting; the recording, its cache and library entry are untouched', async (_label, free, warn) => {
    const r = rig({ start: false, over: { diskFree: async () => free } })
    r.settings.diskWarnGb = warn
    const entryBefore = JSON.stringify(r.library.get(r.src))
    const cacheBefore = fs.readFileSync(cacheFilePath(r.src, r.cacheDir), 'utf8')
    r.service.start()
    r.record()
    await r.service.idle()
    expect(r.store.get(r.id)).toMatchObject({ state: 'skipped', skipReason: 'lowDisk' })
    expect(r.run).not.toHaveBeenCalled()
    expect(r.outFiles()).toEqual([])
    expect(await r.projects.load(montageProjectId(r.id))).toBeNull()
    expect(fs.readFileSync(r.src, 'utf8')).toBe('recording')
    expect(JSON.stringify(r.library.get(r.src))).toBe(entryBefore)
    expect(fs.readFileSync(cacheFilePath(r.src, r.cacheDir), 'utf8')).toBe(cacheBefore)
    expect(r.deps.removeSource).not.toHaveBeenCalled()
  })

  it('(defect) the user gets a notice that the montage was skipped for low disk space', async () => {
    const r = rig({ over: { diskFree: async () => 1 * GB } })
    r.record()
    await r.service.idle()
    expect(r.store.get(r.id)?.skipReason).toBe('lowDisk')
    expect(r.notify).toHaveBeenCalledWith('montage', expect.any(String))
  })
})

describe('scenario 5: no hardware encoder', () => {
  const encoderOf = (o: RunExportOptions): string => o.jobs[0].args[o.jobs[0].args.indexOf('-c:v') + 1]

  it('only libopenh264 available → the montage is encoded with it', async () => {
    const r = rig({ start: false })
    r.encoders.list = ['libopenh264']
    r.service.start()
    r.record()
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('done')
    expect(r.run.mock.calls.map((c) => encoderOf(c[0]))).toEqual(['libopenh264'])
  })

  it('a hardware encoder that refuses to open falls back to libopenh264, leaving no files from the failed attempt', async () => {
    const r = rig({
      start: false,
      run: async (o, c) => (encoderOf(o) === 'h264_nvenc'
        ? { ok: false, error: exportFailureMessage(1, '[h264_nvenc @ 000001] OpenEncodeSessionEx failed: unsupported device (2)'), outputs: [] }
        : runExport(o, c))
    })
    r.service.start()
    r.record()
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('done')
    expect(r.run.mock.calls.map((c) => encoderOf(c[0]))).toEqual(['h264_nvenc', 'libopenh264'])
    expect(r.outFiles()).toEqual(['Montage_Valorant_2026-11-15_21-08.mp4'])
  })

  it('no working encoder → failed(encoder) with a clear message and a notice; the recording is unaffected; retry works once one is available', async () => {
    const r = rig({ start: false })
    r.encoders.list = []
    const entryBefore = JSON.stringify(r.library.get(r.src))
    r.service.start()
    r.record()
    await r.service.idle()
    const job = r.store.get(r.id)!
    expect(job).toMatchObject({ state: 'failed', failCode: 'encoder' })
    expect(job.error).toMatch(/encoder/i)
    expect(r.notify).toHaveBeenCalledWith('montage', expect.stringContaining(job.error!))
    expect(r.run).not.toHaveBeenCalled()
    expect(r.outFiles()).toEqual([])
    expect(fs.readFileSync(r.src, 'utf8')).toBe('recording')
    expect(JSON.stringify(r.library.get(r.src))).toBe(entryBefore)
    r.encoders.list = ['libopenh264']
    expect(r.service.retry(r.id)).toBe(true)
    await vi.waitFor(() => expect(r.store.get(r.id)?.state).toBe('done'), { timeout: 10_000 })
  })

  it('every encoder refuses (libopenh264 too) → failed(encoder) with the encoder hint, recording kept', async () => {
    const r = rig({
      start: false,
      run: async () => ({ ok: false, error: exportFailureMessage(1, 'Error while opening encoder for output stream #0:0'), outputs: [] })
    })
    r.service.start()
    r.record()
    await r.service.idle()
    expect(r.store.get(r.id)).toMatchObject({ state: 'failed', failCode: 'encoder' })
    expect(r.run).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(r.src)).toBe(true)
    expect(r.outFiles()).toEqual([])
  })
})

describe('scenario 6: analysis failure / engine timeout', () => {
  function queued(r: Rig) {
    const runs: Array<{ resolve: (doc: unknown) => void; reject: (err: Error) => void }> = []
    const engine = {
      request: vi.fn(() => {
        const promise = new Promise((resolve, reject) => runs.push({ resolve, reject }))
        return { id: String(runs.length), promise }
      }),
      cancel: vi.fn()
    }
    const queue = new AnalysisQueue(engine as unknown as EngineClient, r.library, { profileDir: r.root, cacheDir: r.cacheDir })
    // main/index.ts wiring, plus the proposed failure event (see the report): absent today, so nothing is called.
    queue.on('analyzed', (p: string, g) => r.service.onMatchAnalyzed(p, g))
    const proposed = r.service as MontageService & { onAnalysisFailed?: (videoPath: string, error?: string) => void }
    queue.on('analysisFailed', (p: string, _g: unknown, error?: string) => proposed.onAnalysisFailed?.(p, error))
    return { queue, runs }
  }
  const doc = (r: Rig) => loadCacheDoc(cacheFilePath(r.src, r.cacheDir))

  it('(defect) a failed full analysis ends the job as failed(analysis) with a notice instead of leaving it in analyzing', async () => {
    const r = rig()
    const q = queued(r)
    r.service.onMatchRecorded(r.src, 'valorant')
    q.queue.enqueue(r.src)
    await vi.waitFor(() => expect(q.runs).toHaveLength(1))
    q.runs[0].reject(new EngineError('analyze_failed', 'engine timed out'))
    await vi.waitFor(() => expect(r.library.get(r.src)?.status).toBe('error'))
    await r.service.idle()
    expect(r.store.get(r.id)).toMatchObject({ state: 'failed', failCode: 'analysis' })
    expect(r.notify).toHaveBeenCalledWith('montage', expect.any(String))
  })

  it('(defect) after a restart, a job still in analyzing whose library entry failed analysis becomes failed(analysis)', async () => {
    const first = rig()
    first.service.onMatchRecorded(first.src, 'valorant')
    expect(first.store.get(first.id)?.state).toBe('analyzing')
    first.library.update(first.src, { status: 'error', error: 'engine timed out' })
    const next = rig({ root: first.root })
    await next.service.idle()
    expect(next.store.get(next.id)).toMatchObject({ state: 'failed', failCode: 'analysis' })
    // Retry from the UI is possible once it failed.
    expect(next.service.retry(next.id)).toBe(true)
  })

  it('an analysis interrupted by quit (engine_stopped) or cancelled keeps the job waiting; a later successful run builds the montage', async () => {
    const r = rig()
    const q = queued(r)
    r.service.onMatchRecorded(r.src, 'valorant')
    q.queue.enqueue(r.src)
    await vi.waitFor(() => expect(q.runs).toHaveLength(1))
    q.runs[0].reject(new EngineError('engine_stopped', 'stopped'))
    await vi.waitFor(() => expect(r.library.get(r.src)?.status).toBe('pending'))
    expect(r.store.get(r.id)?.state).toBe('analyzing')
    q.queue.enqueue(r.src)
    await vi.waitFor(() => expect(q.runs).toHaveLength(2))
    q.runs[1].resolve(doc(r))
    await vi.waitFor(() => expect(r.store.get(r.id)?.state).toBe('done'), { timeout: 10_000 })
  })
})

describe('scenario 7: the user opens the same match in Studio while the montage exports', () => {
  it("the user's cache edits and own project are never touched; the montage project is separate and open() does not rebuild it", async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '300'
    const r = rig({ start: false })
    const userProject = buildMontageProject({ projectId: 'p_user_edit', name: 'My edit', sourcePath: r.src, clips: [{ id: 'u', start: 1, end: 5, origin: 'manual', event_ids: [] }] })
    await r.projects.save(userProject as StoredProject)
    const userFile = path.join(r.root, 'projects', 'p_user_edit.json')
    const userBytes = fs.readFileSync(userFile, 'utf8')
    r.service.start()
    r.record()
    await waitExporting(r)
    // Studio: open the montage project and save a cache edit (a new manual clip) mid-export.
    expect(await r.service.open(r.id)).toEqual({ projectId: montageProjectId(r.id) })
    const edited = { ...(loadCacheDoc(cacheFilePath(r.src, r.cacheDir)) as CacheDoc) }
    edited.clips = [...edited.clips, { id: 'studio1', start: 150, end: 160, origin: 'manual', event_ids: [] }]
    expect(saveCacheDoc(edited)).toBe(true)
    const cacheBytes = fs.readFileSync(cacheFilePath(r.src, r.cacheDir), 'utf8')
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('done')
    expect(fs.readFileSync(cacheFilePath(r.src, r.cacheDir), 'utf8')).toBe(cacheBytes)
    expect(fs.readFileSync(userFile, 'utf8')).toBe(userBytes)
    expect(r.deps.saveProject).toHaveBeenCalledOnce()
    const montage = await r.projects.load(montageProjectId(r.id))
    expect(montage?.id).toBe(`p_${r.id}`)
    expect(montage?.items.map((i) => [i.source, i.start, i.end])).toEqual([[r.src, 97, 106], [r.src, 197, 205], [r.src, 297, 302]])
  })

  it("the user's later edits to the montage project survive a repeated 'analyzed' and a restart", async () => {
    const r = rig()
    r.record()
    await r.service.idle()
    const p = (await r.projects.load(montageProjectId(r.id)))!
    await r.projects.save({ ...p, name: 'Renamed by user', items: p.items.slice(0, 1) })
    r.record()
    await r.service.idle()
    const next = rig({ root: r.root })
    await next.service.idle()
    expect(await next.projects.load(montageProjectId(r.id))).toMatchObject({ name: 'Renamed by user', items: [p.items[0]] })
    expect(r.run).toHaveBeenCalledOnce()
    expect(next.run).not.toHaveBeenCalled()
  })
})

describe('scenario 8: the next match starts while the previous montage is still exporting', () => {
  it('finalizing the next match is never awaited behind the export, and its job waits its turn', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '5000'
    const r = rig()
    r.record()
    await waitExporting(r)
    // Next match finalized by the recorder (per-match cut with a trusted live cache) while the export runs.
    const base = path.join(r.root, 'rec2')
    fs.mkdirSync(base)
    const deps = makeDeps(base)
    deps.addToLibrary = (paths) => {
      r.library.add(paths, 'recording', 'valorant')
    }
    deps.onMatchRecorded = (p, g) => r.service.onMatchRecorded(p, g)
    deps.onMatchAnalyzed = (p, g) => r.service.onMatchAnalyzed(p, g)
    const dir = path.join(base, 'videos', '.sessions', '20261115-214800-abcd')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: new Date(2026, 10, 15, 21, 48).getTime(), postAnalysis: 'afterExit', game: 'valorant', mode: 'match' }))
    const next = path.join(base, 'videos', 'Valorant_m2.mp4')
    fs.writeFileSync(next, 'video')
    r.writeCache(next, EVENTS)
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ matches: [{ start: 0, end: 10 }] }))
    fs.writeFileSync(path.join(dir, 'matches.json'), JSON.stringify({ cuts: [{ index: 0, start: 0, end: 10, firstSeq: 1, lastSeq: 1, outputPath: next, analysisQueued: false, liveCached: true, liveTrusted: true }] }))
    const t0 = performance.now()
    await cutMatches(dir, deps, { finishing: true })
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(r.store.get(r.id)?.state).toBe('exporting')
    expect(r.store.getBySource(next)?.state).toBe('selecting')
    // One export at a time.
    expect(r.service.status().active?.id).toBe(r.id)
  })

  it('a running export drops to idle priority when recording starts (below normal while the game runs)', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '250'
    const spy = vi.spyOn(os, 'setPriority').mockImplementation(() => undefined)
    const r = rig({ start: false })
    r.game.running = true
    r.service.start()
    r.record()
    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 10_000 })
    expect(spy.mock.calls[0][1]).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
    r.game.recording = true
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('done')
    const levels = spy.mock.calls.map((c) => c[1])
    expect(levels).toContain(os.constants.priority.PRIORITY_LOW)
    expect(levels.at(-1)).toBe(os.constants.priority.PRIORITY_LOW)
    expect(levels.indexOf(os.constants.priority.PRIORITY_LOW)).toBeGreaterThan(0)
  })
})

describe('scenario 9: Auto montage turned off mid-job', () => {
  it('mid-export → cancelled, the ffmpeg tree is killed, partials and segments removed, nothing in the library', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '20000'
    process.env.FAKE_FFMPEG_GRANDCHILD = '1'
    const r = rig()
    r.record()
    await waitExporting(r)
    const [proc] = r.pids()
    expect(alive(proc.ffmpeg)).toBe(true)
    r.settings.montage = { ...r.settings.montage, enabled: false }
    r.service.onSettingsChanged()
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('cancelled')
    expect(r.store.get(r.id)?.outputPath).toBeUndefined()
    expect(alive(proc.ffmpeg)).toBe(false)
    expect(alive(proc.grandchild!)).toBe(false)
    expect(r.outFiles()).toEqual([])
    expect(r.montageEntries()).toEqual([])
    expect(r.notify).not.toHaveBeenCalled()
    expect(fs.existsSync(r.src)).toBe(true)
  })

  it('while selecting (autoclip pending) or waiting for analysis → cancelled with no render; turning it back on does not revive them', async () => {
    let releaseAutoclip = (): void => {}
    const r = rig({ over: { autoclip: vi.fn(() => new Promise<Clip[]>((res) => (releaseAutoclip = () => res([])))) } })
    r.record()
    r.service.onMatchRecorded(r.src2, 'valorant')
    await vi.waitFor(() => expect(r.deps.autoclip).toHaveBeenCalled())
    r.settings.montage = { ...r.settings.montage, enabled: false }
    r.service.onSettingsChanged()
    releaseAutoclip()
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('cancelled')
    expect(r.store.getBySource(r.src2)?.state).toBe('cancelled')
    r.settings.montage = { ...r.settings.montage, enabled: true }
    r.service.onSettingsChanged()
    r.service.onMatchAnalyzed(r.src2, 'valorant')
    await r.service.idle()
    expect(r.store.getBySource(r.src2)?.state).toBe('cancelled')
    expect(r.run).not.toHaveBeenCalled()
    expect(r.outFiles()).toEqual([])
  })
})

describe('scenario 10: source deleted by the user before or during the export', () => {
  it('deleted before the export → skipped(sourceMissing), no file', async () => {
    const r = rig({ start: false, montage: { timing: 'afterGameExit' } })
    r.game.running = true
    r.service.start()
    r.record()
    expect(r.store.get(r.id)?.state).toBe('deferred')
    r.library.remove(r.src)
    r.game.running = false
    r.service.onGameClosed()
    await r.service.idle()
    expect(r.store.get(r.id)).toMatchObject({ state: 'skipped', skipReason: 'sourceMissing' })
    expect(r.run).not.toHaveBeenCalled()
    expect(r.outFiles()).toEqual([])
  })

  it('deleted during the export (ffmpeg fails on the missing input) → ends cleanly, no partial, and the next job still runs', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '400'
    process.env.FAKE_FFMPEG_EXIT = '1'
    const r = rig()
    r.record()
    await waitExporting(r)
    r.library.remove(r.src)
    expect(fs.existsSync(r.src)).toBe(false)
    await r.service.idle()
    const job = r.store.get(r.id)!
    expect(['skipped', 'failed']).toContain(job.state)
    if (job.state === 'skipped') expect(job.skipReason).toBe('sourceMissing')
    else expect(job.error).toBeTruthy()
    expect(job.outputPath).toBeUndefined()
    expect(r.outFiles()).toEqual([])
    expect(r.montageEntries()).toEqual([])
    process.env.FAKE_FFMPEG_EXIT = '0'
    process.env.FAKE_FFMPEG_SLEEP_MS = '0'
    r.record(r.src2)
    await r.service.idle()
    expect(r.store.getBySource(r.src2)?.state).toBe('done')
  })

  it('(defect) deleted while the job waits for analysis, then restart → skipped(sourceMissing) instead of analyzing forever', async () => {
    const first = rig()
    first.service.onMatchRecorded(first.src, 'valorant')
    first.library.remove(first.src)
    const next = rig({ root: first.root })
    await next.service.idle()
    expect(next.store.get(next.id)).toMatchObject({ state: 'skipped', skipReason: 'sourceMissing' })
  })
})

describe('scenario 12: keepSourceRecording false', () => {
  it('the source is deleted only after the verified montage is in the library', async () => {
    const r = rig({ start: false, montage: { keepSourceRecording: false } })
    const add = vi.spyOn(r.library, 'addMontage')
    const remove = vi.spyOn(r.library, 'remove')
    r.service.start()
    r.record()
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('done')
    expect(fs.existsSync(r.src)).toBe(false)
    expect(r.library.get(r.src)).toBeUndefined()
    expect(r.montageEntries()).toHaveLength(1)
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0])
    expect(vi.mocked(r.deps.probeOutput).mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0])
  })

  it.each([
    ['a failed export', { exit: '1' }, 'failed'],
    ['an unreadable output (verify)', { probe: null }, 'failed'],
    ['a length mismatch (verify)', { probe: { duration: TOTAL_SEC + 2, hasVideo: true, hasAudio: true } }, 'failed'],
    ['a library write failure', { addFails: true }, 'failed']
  ] as const)('%s keeps the source and deletes the bad output', async (_label, c, state) => {
    if ('exit' in c) process.env.FAKE_FFMPEG_EXIT = c.exit
    const over: Partial<MontageServiceDeps> = 'probe' in c ? { probeOutput: vi.fn(async () => c.probe) } : {}
    const r = rig({ start: false, montage: { keepSourceRecording: false }, over })
    if ('addFails' in c) vi.spyOn(r.library, 'addMontage').mockImplementation(() => { throw new Error('Failed to save library') })
    r.service.start()
    r.record()
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe(state)
    expect(r.deps.removeSource).not.toHaveBeenCalled()
    expect(fs.readFileSync(r.src, 'utf8')).toBe('recording')
    expect(r.library.get(r.src)?.source).toBe('recording')
    expect(r.outFiles()).toEqual([])
    expect(r.montageEntries()).toEqual([])
  })

  it('a cancelled export keeps the source', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '20000'
    const r = rig({ montage: { keepSourceRecording: false } })
    r.record()
    await waitExporting(r)
    expect(await r.service.cancel(r.id)).toBe(true)
    expect(fs.existsSync(r.src)).toBe(true)
    expect(r.deps.removeSource).not.toHaveBeenCalled()
    expect(r.outFiles()).toEqual([])
  })
})

describe('scenario 13: re-analysis of a match that already has a montage', () => {
  it("a forced re-analysis merges clips per mergeOnReanalyze and its 'analyzed' event builds no second montage", async () => {
    const r = rig()
    const accepted: Clip = { id: 'acc', start: 98, end: 107, origin: 'ai', event_ids: ['k1'], status: 'accepted' }
    const manual: Clip = { id: 'm1', start: 400, end: 405, origin: 'manual', event_ids: [] }
    r.writeCache(r.src, EVENTS, [manual, accepted])
    // Fake engine: writes a fresh cache (fresh AI suggestions only, like a real re-analysis) and returns it.
    const engine = {
      request: vi.fn((_m: string, args: { path: string }) => {
        const fresh = r.writeCache(args.path, EVENTS, [{ id: 'ai_new', start: 296, end: 303, origin: 'ai', event_ids: ['k6'] }])
        return { id: String(engine.request.mock.calls.length), promise: Promise.resolve(fresh) }
      }),
      cancel: vi.fn()
    }
    const queue = new AnalysisQueue(engine as unknown as EngineClient, r.library, { profileDir: r.root, cacheDir: r.cacheDir })
    queue.on('analyzed', (p: string, g) => r.service.onMatchAnalyzed(p, g))
    r.service.onMatchRecorded(r.src, 'valorant')
    queue.enqueue(r.src)
    await vi.waitFor(() => expect(r.store.get(r.id)?.state).toBe('done'), { timeout: 10_000 })
    await r.service.idle()
    const before = (loadCacheDoc(cacheFilePath(r.src, r.cacheDir)) as CacheDoc).clips
    // The montage never writes clips into the match's cache.
    expect(before.map((c) => c.id).some((cid) => cid.startsWith('mt_'))).toBe(false)

    const analyzed = vi.fn()
    queue.on('analyzed', analyzed)
    queue.enqueue(r.src, true)
    await vi.waitFor(() => expect(analyzed).toHaveBeenCalledOnce(), { timeout: 10_000 })
    await r.service.idle()
    const after = (loadCacheDoc(cacheFilePath(r.src, r.cacheDir)) as CacheDoc).clips
    const expected = mergeOnReanalyze(before, [])
    expect(after.filter((c) => c.origin === 'manual' || c.status === 'accepted').map((c) => c.id)).toEqual(expected.map((c) => c.id))
    expect(r.store.get(r.id)?.state).toBe('done')
    expect(r.run).toHaveBeenCalledOnce()
    expect(r.montageEntries()).toHaveLength(1)
    expect(r.outFiles()).toEqual(['Montage_Valorant_2026-11-15_21-08.mp4'])
    // A recovery re-report of the same match is a no-op too.
    r.record()
    await r.service.idle()
    expect(r.store.list()).toHaveLength(1)
  })
})

describe('scenario 14: settings migration from an old settings file', () => {
  it('an old file gets the Auto montage defaults (off), nothing else changes, the file is not rewritten and no job is made', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-scn-settings-'))
    roots.push(dir)
    const file = path.join(dir, 'settings.json')
    const current = migrateSettings({})
    const old = JSON.parse(JSON.stringify(current))
    delete old.recording.autoMontage
    Object.assign(old.recording, { postAnalysis: 'none', fps: 30, autoRecord: true, diskWarnGb: 25 })
    old.autoclip = { ...old.autoclip, before: 4 }
    fs.writeFileSync(file, JSON.stringify(old))
    const bytes = fs.readFileSync(file, 'utf8')
    const loaded = loadSettings(file)
    expect(loaded).toEqual({ ...old, recording: { ...old.recording, autoMontage: DEFAULT_AUTO_MONTAGE } })
    expect(loaded.recording.autoMontage.enabled).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    const r = rig({ montage: loaded.recording.autoMontage })
    r.settings.montage = { ...loaded.recording.autoMontage, outputDir: r.outDir }
    r.record()
    await r.service.idle()
    expect(r.store.list()).toEqual([])
    expect(fs.existsSync(r.storeFile)).toBe(false)
  })
})

describe('scenario 15: quit during export', () => {
  function guard(r: Rig, over: { flushLibrary?: () => unknown; onQuitBlocked?: () => void } = {}) {
    const atQuit: { state?: string; ffmpegAlive?: boolean; grandchildAlive?: boolean; files?: string[] } = {}
    const [proc] = r.pids()
    const quit = vi.fn(() => {
      atQuit.state = new MontageJobStore(r.storeFile).get(r.id)?.state
      atQuit.ffmpegAlive = alive(proc.ffmpeg)
      atQuit.grandchildAlive = proc.grandchild ? alive(proc.grandchild) : false
      atQuit.files = r.outFiles()
    })
    const g = createAppQuitGuard({
      stopRecording: () => undefined,
      flushLibrary: over.flushLibrary ?? (() => r.library.flush()),
      onQuitBlocked: over.onQuitBlocked,
      stopEngine: () => undefined,
      cancelExport: () => undefined,
      cancelProxies: () => undefined,
      cancelMontage: () => r.service.shutdown(),
      stopWatcher: () => undefined,
      quit,
      timeoutMs: 5000
    })
    return { g, quit, atQuit }
  }

  it('the quit guard waits for the cancel: ffmpeg tree killed, no partials, job back to selecting; it resumes once on the next start', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '20000'
    process.env.FAKE_FFMPEG_GRANDCHILD = '1'
    const r = rig()
    r.record()
    await waitExporting(r)
    const { g, quit, atQuit } = guard(r)
    g.onBeforeQuit({ preventDefault: () => undefined })
    await vi.waitFor(() => expect(quit).toHaveBeenCalled(), { timeout: 10_000 })
    expect(atQuit).toEqual({ state: 'selecting', ffmpegAlive: false, grandchildAlive: false, files: [] })
    expect(new MontageJobStore(r.storeFile).get(r.id)?.outputPath).toBeUndefined()

    process.env.FAKE_FFMPEG_SLEEP_MS = '0'
    delete process.env.FAKE_FFMPEG_GRANDCHILD
    const next = rig({ root: r.root })
    await vi.waitFor(() => expect(next.store.get(next.id)?.state).toBe('done'), { timeout: 10_000 })
    expect(next.store.get(next.id)?.attempts).toBe(1)
    expect(next.montageEntries()).toHaveLength(1)
    expect(next.outFiles()).toEqual(['Montage_Valorant_2026-11-15_21-08.mp4'])
  })

  it('(defect) a quit blocked by a failed library flush leaves Auto montage working: start() again resumes the interrupted job', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '20000'
    const r = rig()
    r.record()
    await waitExporting(r)
    const blocked = vi.fn()
    const { g, quit } = guard(r, { flushLibrary: () => false, onQuitBlocked: blocked })
    g.onBeforeQuit({ preventDefault: () => undefined })
    await vi.waitFor(() => expect(blocked).toHaveBeenCalled(), { timeout: 10_000 })
    expect(quit).not.toHaveBeenCalled()
    expect(r.store.get(r.id)?.state).toBe('selecting')
    // The app keeps running (main/index.ts onQuitBlocked restarts the recorder); proposed: it also restarts the montage service.
    process.env.FAKE_FFMPEG_SLEEP_MS = '0'
    r.service.start()
    await r.service.idle()
    expect(r.store.get(r.id)?.state).toBe('done')
  })

  it('quit while the job only waits for analysis or the game returns at once and keeps the job', async () => {
    const r = rig({ start: false, montage: { timing: 'afterGameExit' } })
    r.game.running = true
    r.service.start()
    r.record()
    r.service.onMatchRecorded(r.src2, 'valorant')
    const t0 = performance.now()
    await r.service.shutdown()
    expect(performance.now() - t0).toBeLessThan(100)
    expect(r.store.get(r.id)?.state).toBe('deferred')
    expect(r.store.getBySource(r.src2)?.state).toBe('analyzing')
  })
})
