/**
 * Auto montage end to end with real binaries: the real montage service, job store, library, project store, analysis cache I/O,
 * montage renderer (buildJobs + runExport with the best working H.264 encoder) and output probe, driven over a synthetic
 * 40 s 1920x1080 60 fps recording (testsrc2 + sine). The engine `autoclip` runs in the real `aditor.exe ipc` when it is
 * built (build/engine/aditor or engine/target); otherwise a port of the engine's autoclip (test/fake-engine-e2e.mjs) stands in.
 * Only Electron-bound pieces are faked: notifications, game/recorder presence, settings (a plain object).
 *
 * Skips the whole file when ffmpeg/ffprobe cannot be found (ADITOR_FFMPEG / ADITOR_FFPROBE, repo build/ffmpeg/bin, or PATH).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MontageJobStore, type TransitionPatch } from './montage-job'
import { createMontageService, type MontageSettingsView } from './montage-service'
import { cleanupMontageOutput, createMontageRenderer, createOutputProbe, type MontageRenderer } from './montage-export'
import { detectEncoders } from '../export/encoders'
import { createAudioProbe, createMediaEndProbe } from '../export/keyframe'
import { Library } from '../library'
import { ProjectStore } from '../projects'
import { cacheFilePath, loadCacheDoc, resolveCacheFile, saveCacheDoc } from '../cache-io'
import { diskFreeBytes } from '../recording/disk'
import { EngineClient } from '../engine'
import { DEFAULT_AUTO_MONTAGE, montageJobId, montageProjectId, type MontageJobState } from '../../shared/montage'
import type { PresetId } from '../../shared/exportFormat'
import type { AutoClipParams, CacheDoc, Clip, EngineEvent } from '../../shared/types'
import { projectShapeError } from '../../renderer/editor/project'

const exe = process.platform === 'win32' ? '.exe' : ''
const REPO = path.resolve(__dirname, '../../../..')

function findBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const candidates = [
    name === 'ffmpeg' ? process.env.ADITOR_FFMPEG : process.env.ADITOR_FFPROBE,
    process.env.ADITOR_FFMPEG ? path.join(path.dirname(process.env.ADITOR_FFMPEG), name + exe) : undefined,
    path.join(REPO, 'build/ffmpeg/bin', name + exe),
    name
  ].filter((c): c is string => !!c)
  for (const c of candidates) {
    if (spawnSync(c, ['-version'], { windowsHide: true }).status === 0) return c
  }
  return null
}

function findEngine(): string | null {
  const candidates = [
    path.join(REPO, 'build/engine/aditor', 'aditor' + exe),
    path.join(REPO, 'engine/target/release', 'aditor' + exe),
    path.join(REPO, 'engine/target/debug', 'aditor' + exe)
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

const FFMPEG = findBin('ffmpeg')
const FFPROBE = findBin('ffprobe')
const ENGINE = findEngine()
const run = (bin: string, args: string[]) => spawnSync(bin, args, { encoding: 'utf-8', windowsHide: true, maxBuffer: 1 << 26 })

const SKIP_REASON = !FFMPEG ? 'ffmpeg not found (set ADITOR_FFMPEG or add build/ffmpeg/bin)' : !FFPROBE ? 'ffprobe not found (set ADITOR_FFPROBE)' : null
if (SKIP_REASON) console.warn(`[montage-real] skipped: ${SKIP_REASON}`)
const describeReal = SKIP_REASON ? describe.skip : describe

const DURATION = 40
const FPS = 60
const AUTOCLIP: AutoClipParams = { gap: 4, n: 1, before: 2, after: 1.5, max_len: 60 }

const ev = (id: string, t: number, type: 'kill' | 'death' = 'kill'): EngineEvent => ({
  id,
  t,
  type,
  score: 1,
  damage_line: false,
  name_sig: null,
  counted: type === 'kill',
  counted_reason: '',
  counted_override: null,
  source: 'auto'
})

/** A 3k, a 2k, two singles and two deaths (one inside the last single's post roll). */
const EVENTS: EngineEvent[] = [
  ev('k1', 6.2), ev('k2', 7.4), ev('k3', 8.9),
  ev('d1', 13.0, 'death'),
  ev('k4', 18.1), ev('k5', 20.6),
  ev('k6', 28.3),
  ev('k7', 35.0),
  ev('d2', 36.2, 'death')
]
/** Expected highlight windows (kill - before .. kill + after), chronological. */
const EXPECTED_RANGES = [
  [4.2, 10.4],
  [16.1, 22.1],
  [26.3, 29.8],
  [33.0, 36.5]
]
const EXPECTED_TOTAL = EXPECTED_RANGES.reduce((s, [a, b]) => s + (b - a), 0)

interface ProbeStreams {
  streams: Array<{ codec_type: string; width?: number; height?: number; codec_name?: string }>
  format: { duration: string }
}

interface PresetResult {
  preset: string
  expected: string
  actual: string
  totalSec: number
  probed: number
  audio: boolean
  decodeClean: boolean
  encoder: string
}

describeReal('real montage: recorded match -> one verified montage file per preset', () => {
  let root: string
  let source: string
  let cacheDir: string
  let engine: EngineClient | null = null
  let autoclip: (events: EngineEvent[], params: AutoClipParams, duration: number) => Promise<Clip[]>
  let usingRealEngine = false
  const results: PresetResult[] = []

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-montage-real-'))
    const recDir = path.join(root, 'Recordings', '2026-11-15')
    fs.mkdirSync(recDir, { recursive: true })
    source = path.join(recDir, 'Valorant_2026-11-15_21-08.mp4')
    const r = run(FFMPEG!, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=${FPS}:duration=${DURATION}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
      '-c:v', 'libopenh264', '-b:v', '6M', '-g', String(FPS * 4), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', source
    ])
    expect(r.status, r.stderr).toBe(0)

    // Analysis cache written and read through the app's own cache I/O.
    cacheDir = path.join(root, 'appData', 'cache')
    const doc: CacheDoc = {
      version: 1,
      video: { path: source, size: fs.statSync(source).size, mtime: 1, duration: DURATION, width: 1920, height: 1080, codec: 'h264', start_time: 0, fps: FPS, pix_fmt: 'yuv420p' },
      analysis: { status: 'done', progress_t: DURATION, engine_version: '0.3.0', templates_version: 'x', h_scale: 1 },
      events: EVENTS,
      spectating: [],
      clips: [],
      keyframes: [],
      cache_path: cacheFilePath(source, cacheDir),
      game: 'valorant'
    }
    fs.mkdirSync(cacheDir, { recursive: true })
    expect(saveCacheDoc(doc)).toBe(true)

    if (ENGINE) {
      engine = new EngineClient({ command: ENGINE, args: ['ipc'], env: { ADITOR_FFMPEG: FFMPEG! } })
      await engine.start()
      usingRealEngine = true
      autoclip = async (events, params, duration) => {
        const res = (await engine!.request('autoclip', { events, params, duration }).promise) as { clips?: Clip[] } | null
        return Array.isArray(res?.clips) ? res.clips : []
      }
    } else {
      console.warn('[montage-real] aditor engine not built: using the autoclip port from test/fake-engine-e2e.mjs')
      // @ts-expect-error -- plain .mjs test helper without types
      const mod = (await import('../../../test/fake-engine-e2e.mjs')) as { autoClips: (e: EngineEvent[], p: AutoClipParams, d: number) => Clip[] }
      autoclip = async (events, params, duration) => mod.autoClips(events, params, duration)
    }
  }, 240_000)

  afterAll(async () => {
    await engine?.stop()
    if (results.length) {
      console.log(`[montage-real] engine autoclip: ${usingRealEngine ? `real (${ENGINE})` : 'port'}`)
      console.table(results.map((r) => ({ ...r, totalSec: r.totalSec.toFixed(3), probed: r.probed.toFixed(3), delta: (r.probed - r.totalSec).toFixed(3) })))
    }
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  /** `software`: hide hardware encoders so the libopenh264 fallback (what machines without a GPU encoder use) is covered too. */
  const PRESETS: Array<{ preset: PresetId; width: number; height: number; software?: boolean }> = [
    { preset: 'youtube', width: 1920, height: 1080 },
    { preset: 'shorts', width: 1080, height: 1920 },
    { preset: 'square', width: 1080, height: 1080 },
    { preset: 'shorts', width: 1080, height: 1920, software: true }
  ]

  for (const { preset, width, height, software } of PRESETS) {
    const tag = software ? `${preset}-sw` : preset
    it(`${tag}: recorded -> analyzed -> selecting -> exporting -> done, ${width}x${height}${software ? ' (libopenh264 only)' : ''}`, async () => {
      const working = await detectEncoders(FFMPEG!)
      if (software && !working.includes('libopenh264')) {
        console.warn('[montage-real] libopenh264 not usable here: software-encoder case not run')
        return
      }
      const appData = path.join(root, `appData-${tag}`)
      const outDir = path.join(root, 'Montages', tag)
      fs.mkdirSync(appData, { recursive: true })

      // Record every state the job enters (the store is the real one; this only observes transitions).
      const states: MontageJobState[] = []
      class TracingStore extends MontageJobStore {
        create(sourcePath: string, game: 'valorant' | 'apex') {
          const r = super.create(sourcePath, game)
          if (r.created) states.push(r.job.state)
          return r
        }
        transition(id: string, to: MontageJobState, patch?: TransitionPatch) {
          const r = super.transition(id, to, patch)
          if (r) states.push(to)
          return r
        }
      }
      const store = new TracingStore(path.join(appData, 'montage', 'jobs.json'))
      const library = new Library(path.join(appData, 'library.json'))
      library.add([source], 'recording', 'valorant')
      const projects = new ProjectStore(path.join(appData, 'projects'))
      const notes: string[] = []
      let encoder = ''

      const settings: MontageSettingsView = {
        montage: { ...DEFAULT_AUTO_MONTAGE, include: { ...DEFAULT_AUTO_MONTAGE.include }, enabled: true, formatPreset: preset, outputDir: outDir, minClips: 2, maxDurationSec: 90 },
        autoclip: AUTOCLIP,
        diskWarnGb: 0,
        diskStopGb: 0,
        storageRoot: root
      }
      const real = createMontageRenderer({
        detectEncoders: async () => (software ? working.filter((e) => e === 'libopenh264') : working),
        ffmpeg: { bin: FFMPEG! },
        tempDir: path.join(root, `tmp-${tag}`),
        hasAudio: createAudioProbe(FFPROBE!),
        mediaEnd: createMediaEndProbe(FFPROBE!)
      })
      const render: MontageRenderer = async (req, control) => {
        const res = await real(req, control)
        if (res.ok) encoder = res.encoder
        return res
      }

      const service = createMontageService({
        store,
        getSettings: () => settings,
        library: {
          get: (p) => library.get(p),
          hasMontage: (id) => library.hasMontage(id),
          addMontage: (out, info, extra) => {
            library.addMontage(out, info, extra)
          }
        },
        saveProject: (p) => projects.save(p),
        loadProject: (id) => projects.load(id),
        readCache: (p) => loadCacheDoc(resolveCacheFile(p, cacheDir, false)) as CacheDoc | null,
        autoclip: (events, params, duration) => autoclip(events, params, duration),
        render,
        probeOutput: createOutputProbe(FFPROBE!),
        diskFree: (dir) => diskFreeBytes(dir),
        fileExists: (f) => {
          try {
            return fs.statSync(f).isFile()
          } catch {
            return false
          }
        },
        ensureDir: (dir) => {
          fs.mkdirSync(dir, { recursive: true })
        },
        cleanupOutput: cleanupMontageOutput,
        removeSource: async () => {
          throw new Error('keepSourceRecording is on: the source must not be removed')
        },
        notify: (_kind, message) => notes.push(message),
        now: () => Date.now(),
        isGameRunning: () => false,
        isRecording: () => false
      })
      service.start()
      service.onMatchRecorded(source, 'valorant')
      library.update(source, { status: 'done' })
      service.onMatchAnalyzed(source, 'valorant')
      await service.idle()
      await service.shutdown()

      const id = montageJobId(source)
      const job = store.get(id)!
      expect(job, 'job exists').toBeTruthy()
      expect(job.state, JSON.stringify(job)).toBe('done')
      expect(states).toEqual(['recorded', 'analyzing', 'selecting', 'exporting', 'done'])
      expect(job.formatPreset).toBe(preset)
      expect(job.clipCount).toBe(EXPECTED_RANGES.length)
      expect(job.totalSec).toBeCloseTo(EXPECTED_TOTAL, 6)
      expect(notes).toHaveLength(1)
      // The persisted file agrees with memory.
      const persisted = JSON.parse(fs.readFileSync(path.join(appData, 'montage', 'jobs.json'), 'utf-8')) as { jobs: Array<{ id: string; state: string }> }
      expect(persisted.jobs.find((j) => j.id === id)?.state).toBe('done')

      const out = job.outputPath!
      expect(out && fs.existsSync(out), `output ${out}`).toBe(true)
      expect(path.dirname(out)).toBe(outDir)

      // ffprobe: size, duration, audio.
      const pr = run(FFPROBE!, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', out])
      expect(pr.status, pr.stderr).toBe(0)
      const info = JSON.parse(pr.stdout) as ProbeStreams
      const video = info.streams.find((s) => s.codec_type === 'video')!
      const audio = info.streams.some((s) => s.codec_type === 'audio')
      const probed = Number(info.format.duration)
      expect(video.codec_name).toBe('h264')
      expect([video.width, video.height]).toEqual([width, height])
      expect(audio).toBe(true)
      expect(Math.abs(probed - job.totalSec!), `probed ${probed} vs planned ${job.totalSec}`).toBeLessThanOrEqual(0.5)

      // Full decode is clean.
      const dec = run(FFMPEG!, ['-v', 'error', '-i', out, '-f', 'null', '-'])
      expect(dec.status, dec.stderr).toBe(0)
      expect(dec.stderr.trim()).toBe('')

      // Exactly one library montage entry, pointing back at the match and the project.
      const montages = library.getEntries().filter((e) => e.source === 'montage')
      expect(montages).toHaveLength(1)
      expect(montages[0].path).toBe(out)
      expect(montages[0].montage).toEqual({ sourcePath: source, projectId: montageProjectId(id), jobId: id })
      expect(library.get(source)?.source).toBe('recording')
      expect(fs.existsSync(source)).toBe(true)

      // No leftovers in the output folder: only the montage itself.
      const left = fs.readdirSync(outDir)
      expect(left.filter((f) => /\.partial\b/i.test(f) || f.startsWith('.aditor-seg-')), left.join(', ')).toEqual([])
      expect(left).toEqual([path.basename(out)])

      // The Studio project opens and matches the chosen clips.
      expect(await service.open(id)).toEqual({ projectId: montageProjectId(id) })
      const raw = JSON.parse(fs.readFileSync(path.join(appData, 'projects', `${montageProjectId(id)}.json`), 'utf-8'))
      expect(projectShapeError(raw)).toBeNull()
      const loaded = await projects.load(montageProjectId(id))
      expect(loaded).not.toBeNull()
      expect(loaded!.items).toHaveLength(EXPECTED_RANGES.length)
      loaded!.items.forEach((it, i) => {
        expect(it.source).toBe(source)
        expect(it.start).toBeCloseTo(EXPECTED_RANGES[i][0], 6)
        expect(it.end).toBeCloseTo(EXPECTED_RANGES[i][1], 6)
        expect(typeof it.clipId).toBe('string')
      })
      // The project's items sum to the planned total.
      expect(loaded!.items.reduce((s, it) => s + it.end - it.start, 0)).toBeCloseTo(job.totalSec!, 6)
      if (usingRealEngine) {
        // Montage clips reuse the engine's autoclip ids (c<start ms>), so Studio links them to the cache clips.
        expect(loaded!.items.map((it) => it.clipId)).toEqual(EXPECTED_RANGES.map(([a]) => `c${Math.round(a * 1000)}`))
      }

      if (software) expect(encoder).toBe('libopenh264')
      results.push({ preset: tag, expected: `${width}x${height}`, actual: `${video.width}x${video.height}`, totalSec: job.totalSec!, probed, audio, decodeClean: dec.status === 0 && dec.stderr.trim() === '', encoder })
    }, 300_000)
  }
})
