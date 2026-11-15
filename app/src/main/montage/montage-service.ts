/**
 * Auto montage service (main process): drives each recorded match's job through
 * recorded → analyzing → (deferred) → selecting → exporting → done | skipped | failed | cancelled.
 * Every side effect is injected, so the whole state machine runs in unit tests without Electron, the engine or FFmpeg.
 * Plan: `docs/superpowers/plans/auto-montage.md` §1–4.
 */
import path from 'path'
import {
  MONTAGE_STATUS_LIMIT,
  MONTAGES_DIRNAME,
  montageJobId,
  montageProjectId,
  selectMontageClips,
  type AutoMontageSettings,
  type MontageFailCode,
  type MontageJob,
  type MontageSkipReason,
  type MontageStatus
} from '../../shared/montage'
import { buildMontageProject, type MontageProject } from '../../shared/montageProject'
import { DEFAULT_EXPORT_FORMAT, type ExportFormat } from '../../shared/exportFormat'
import { applyPreset } from '../../shared/exportPresets'
import { UNKNOWN_PROBE, type StreamProbe } from '../../shared/exportCompat'
import { dayFolderName } from '../../shared/storage'
import type { AutoClipParams, CacheDoc, Clip, EngineEvent, VideoInfo } from '../../shared/types'
import type { GameId } from '../../shared/games'
import { tr } from '../../shared/locale'
import { mergeOnReanalyze, normalizeClips } from '../../shared/clips'
import type { ExportPriority } from '../export/run'
import { isTerminal, type MontageJobStore } from './montage-job'
import { montageDiskEstimate, verifyFailure, type MontageRenderer, type OutputProbe } from './montage-export'

const GB = 1024 ** 3

export interface MontageSettingsView {
  montage: AutoMontageSettings
  autoclip: AutoClipParams
  diskWarnGb: number
  diskStopGb: number
  /** Root for the default output folder (`<root>/Montages/<YYYY-MM-DD>`). */
  storageRoot: string
}

export interface MontageLibrary {
  get(videoPath: string): { status: string; source?: string } | undefined
  /** Whether the library already holds a montage built by this job (a job pruned from jobs.json must not be rebuilt). */
  hasMontage(jobId: string): boolean
  addMontage(outputPath: string, montage: { sourcePath: string; projectId: string; jobId: string }, extra: { game: GameId; durationSec: number }): void
}

export interface MontageServiceDeps {
  store: MontageJobStore
  getSettings: () => MontageSettingsView
  library: MontageLibrary
  saveProject: (project: MontageProject) => Promise<void>
  loadProject: (id: string) => Promise<unknown | null>
  /** Analysis cache of a video (current cache location), or null. */
  readCache: (videoPath: string) => CacheDoc | null
  /** Engine `autoclip` with `settings.autoclip`. */
  autoclip: (events: EngineEvent[], params: AutoClipParams, duration: number) => Promise<Clip[]>
  render: MontageRenderer
  probeOutput: (file: string) => Promise<OutputProbe | null>
  diskFree: (dir: string) => Promise<number>
  fileExists: (file: string) => boolean
  ensureDir: (dir: string) => void
  /** Remove leftovers of an interrupted export (`.partial`, segments) and, with removeOutput, the unverified output. */
  cleanupOutput: (outputPath: string, opts: { removeOutput?: boolean }) => void
  /** Delete the source recording through the library removal path (entry and file). */
  removeSource: (videoPath: string) => Promise<void>
  notify: (kind: 'montage', message: string) => void
  now: () => number
  /** VALORANT (any supported game) is running; unknown counts as running. */
  isGameRunning: () => boolean
  /** The recorder is capturing (a new match may be in progress): exports drop to idle priority. */
  isRecording: () => boolean
  onStatus?: (status: MontageStatus) => void
  log?: (message: string) => void
}

type StopReason = 'cancel' | 'disable' | 'interrupt'

interface ActiveRun {
  id: string
  ac: AbortController
  reason: StopReason | null
  done: Promise<void>
}

export interface MontageService {
  /** Resume after a restart and start processing. */
  start(): void
  onMatchRecorded(videoPath: string, game: GameId): void
  onMatchAnalyzed(videoPath: string, game: GameId): void
  onGameClosed(): void
  /** Game presence changed (shared poll); a known "not running" releases deferred jobs. */
  setGameRunning(running: boolean): void
  /** Re-read settings: turning Auto montage off cancels queued/running jobs; switching timing releases deferred jobs. */
  onSettingsChanged(): void
  status(): MontageStatus
  retry(jobId: string): boolean
  cancel(jobId: string): Promise<boolean>
  /** Ensure the job's Studio project exists; null when it cannot be (re)built. */
  open(jobId: string): Promise<{ projectId: string } | null>
  /** Quit: stop the running export (ffmpeg tree killed, partials removed) and wait. The job resumes on the next start. */
  shutdown(): Promise<void>
  /** Resolves when no job is running (tests). */
  idle(): Promise<void>
}

/** `m:ss` */
export function formatMontageDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function montageBaseName(sourcePath: string): string {
  return `Montage_${path.basename(sourcePath, path.extname(sourcePath))}`
}

function probeFromVideo(video: Partial<VideoInfo> | undefined): StreamProbe {
  const pos = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  return {
    ...UNKNOWN_PROBE,
    vcodec: typeof video?.codec === 'string' && video.codec ? video.codec : UNKNOWN_PROBE.vcodec,
    width: pos(video?.width) || UNKNOWN_PROBE.width,
    height: pos(video?.height) || UNKNOWN_PROBE.height,
    fps: pos(video?.fps),
    pix_fmt: typeof video?.pix_fmt === 'string' ? video.pix_fmt : ''
  }
}

export function createMontageService(deps: MontageServiceDeps): MontageService {
  const { store } = deps
  let started = false
  let closed = false
  let active: ActiveRun | null = null
  let lastEnabled = deps.getSettings().montage.enabled
  let lastGameRunning: boolean | null = null
  let lastPushedPercent = -1

  const log = (message: string): void => {
    try {
      deps.log?.(`[montage] ${message}`)
    } catch {}
  }

  function status(): MontageStatus {
    const current = active ? store.get(active.id) ?? null : null
    return { active: current, jobs: store.list().slice(0, MONTAGE_STATUS_LIMIT) }
  }

  function emit(): void {
    try {
      deps.onStatus?.(status())
    } catch (err) {
      console.error('[montage] status listener failed:', err)
    }
  }

  const enabled = (): boolean => deps.getSettings().montage.enabled

  /** analyzing/recorded → selecting, or deferred while the game runs with timing afterGameExit. */
  function ready(job: MontageJob): void {
    if (job.state === 'recorded') store.transition(job.id, 'analyzing')
    const wait = deps.getSettings().montage.timing === 'afterGameExit' && deps.isGameRunning()
    store.transition(job.id, wait ? 'deferred' : 'selecting')
    emit()
    pump()
  }

  function releaseDeferred(): void {
    let changed = false
    for (const job of store.inState('deferred')) {
      if (store.transition(job.id, 'selecting')) changed = true
    }
    if (changed) emit()
    pump()
  }

  function pump(): void {
    if (!started || closed || active) return
    const next = store.inState('selecting')[0]
    if (!next) return
    const ac = new AbortController()
    const run: ActiveRun = { id: next.id, ac, reason: null, done: Promise.resolve() }
    active = run
    lastPushedPercent = -1
    run.done = (async () => {
      try {
        // Yield first: hooks call pump() from inside finalization, which must not wait for the cache read below.
        await new Promise<void>((resolve) => setImmediate(resolve))
        await processJob(next.id, run)
      } catch (err) {
        // Unexpected bug: never leave a job stuck in a running state.
        console.error('[montage] job crashed:', err)
        const job = store.get(next.id)
        if (job && !isTerminal(job.state)) fail(next.id, 'io', String((err as Error)?.message ?? err))
      } finally {
        active = null
        emit()
        pump()
      }
    })()
    emit()
  }

  function skip(id: string, reason: MontageSkipReason): void {
    store.transition(id, 'skipped', { skipReason: reason })
    log(`${id} skipped: ${reason}`)
  }

  function fail(id: string, code: MontageFailCode, error: string): void {
    store.transition(id, 'failed', { failCode: code, error })
    log(`${id} failed (${code}): ${error}`)
    deps.notify('montage', tr('精華合輯製作失敗：{error}', { error }))
  }

  /** Stop handling for an aborted run: user cancel and Auto montage off end as cancelled; quit leaves the job to resume. */
  function stopped(run: ActiveRun, outputPath?: string): void {
    if (outputPath) deps.cleanupOutput(outputPath, { removeOutput: true })
    if (run.reason === 'interrupt') {
      const job = store.get(run.id)
      if (job?.state === 'exporting') store.transition(run.id, 'selecting')
      store.clearOutput(run.id)
      return
    }
    store.transition(run.id, 'cancelled')
    store.clearOutput(run.id)
  }

  function priority(): ExportPriority {
    if (deps.isRecording()) return 'idle'
    return deps.isGameRunning() ? 'belowNormal' : 'normal'
  }

  async function processJob(id: string, run: ActiveRun): Promise<void> {
    const signal = run.ac.signal
    const job = store.get(id)
    if (!job || job.state !== 'selecting') return
    if (job.game !== 'valorant') return skip(id, 'notValorant')
    if (!deps.fileExists(job.sourcePath)) return skip(id, 'sourceMissing')

    const settings = deps.getSettings()
    const doc = deps.readCache(job.sourcePath)
    const duration = doc?.video?.duration ?? 0
    if (!doc || !Array.isArray(doc.events) || doc.analysis?.status !== 'done' || !(duration > 0)) {
      return fail(id, 'analysis', tr('找不到這場對局的分析結果'))
    }

    let fresh: Clip[]
    try {
      fresh = await deps.autoclip(doc.events, settings.autoclip, duration)
    } catch (err) {
      if (signal.aborted) return stopped(run)
      return fail(id, 'engine', tr('無法挑選精華片段：{error}', { error: (err as Error)?.message ?? String(err) }))
    }
    if (signal.aborted) return stopped(run)

    // Same rules as a re-analysis in Studio (`mergeOnReanalyze`): manual and accepted clips stay, fresh autoclip output is
    // added as suggestions. Clips the user skipped are passed along so selection leaves those highlights out.
    const cached = normalizeClips(Array.isArray(doc.clips) ? doc.clips : [])
    const userSkipped = cached.filter((c) => c.status === 'skipped')
    const selection = selectMontageClips(doc.events, [...mergeOnReanalyze(cached, fresh), ...userSkipped], {
      montage: settings.montage,
      autoclip: settings.autoclip,
      videoDurationSec: duration,
      rounds: doc.rounds
    })
    if (selection.skipped) return skip(id, selection.skipped)
    if (selection.clips.length === 0) return skip(id, 'empty')

    const formatPreset = settings.montage.formatPreset
    const format: ExportFormat = applyPreset({ ...DEFAULT_EXPORT_FORMAT }, formatPreset)
    const outDir = settings.montage.outputDir ?? path.join(settings.storageRoot, MONTAGES_DIRNAME, dayFolderName(deps.now()))
    try {
      deps.ensureDir(outDir)
    } catch (err) {
      return fail(id, 'io', tr('無法建立精華合輯資料夾：{error}', { error: (err as Error).message }))
    }

    const projectId = montageProjectId(id)
    const sourceBase = path.basename(job.sourcePath, path.extname(job.sourcePath))
    const project = buildMontageProject({ projectId, name: tr('精華合輯 – {name}', { name: sourceBase }), sourcePath: job.sourcePath, clips: selection.clips })
    const probes = new Map([[job.sourcePath, probeFromVideo(doc.video)]])

    // Low disk: skip before exporting; the recording is never touched.
    let free: number | null = null
    try {
      free = await deps.diskFree(outDir)
    } catch {
      free = null // Unknown: runExport checks again before writing.
    }
    if (free !== null) {
      const need = montageDiskEstimate(project.items, probes, format)
      if (free < settings.diskWarnGb * GB || free < need + settings.diskStopGb * GB) {
        deps.notify('montage', tr('磁碟空間不足，已略過這場對局的精華合輯'))
        return skip(id, 'lowDisk')
      }
    }
    if (signal.aborted) return stopped(run)

    store.transition(id, 'exporting', { clipCount: selection.clips.length, totalSec: selection.totalSec, projectId, formatPreset, progress: 0 })
    emit()
    try {
      await deps.saveProject(project)
    } catch (err) {
      return fail(id, 'io', tr('無法儲存精華合輯專案：{error}', { error: (err as Error).message }))
    }
    if (signal.aborted) return stopped(run)

    const result = await deps.render(
      { items: project.items, outDir, baseName: montageBaseName(job.sourcePath), format, probes, totalSec: selection.totalSec },
      {
        signal,
        priority,
        onPlanned: (outputPath) => {
          store.patch(id, { outputPath })
        },
        onProgress: (p) => {
          store.patch(id, { progress: p })
          const percent = Math.floor(p * 100)
          if (percent !== lastPushedPercent) {
            lastPushedPercent = percent
            emit()
          }
        }
      }
    )
    if (!result.ok) {
      if (result.cancelled) return stopped(run)
      store.clearOutput(id)
      return fail(id, result.code, result.error)
    }
    const outputPath = result.outputPath
    if (signal.aborted) return stopped(run, outputPath)

    const probe = await deps.probeOutput(outputPath)
    const bad = verifyFailure(probe, selection.totalSec)
    if (bad) {
      deps.cleanupOutput(outputPath, { removeOutput: true })
      store.clearOutput(id)
      return fail(id, 'verify', tr('精華合輯檢查未通過：{reason}', { reason: bad }))
    }
    if (signal.aborted) return stopped(run, outputPath)

    try {
      deps.library.addMontage(outputPath, { sourcePath: job.sourcePath, projectId, jobId: id }, { game: job.game, durationSec: probe!.duration })
    } catch (err) {
      deps.cleanupOutput(outputPath, { removeOutput: true })
      store.clearOutput(id)
      return fail(id, 'io', tr('無法把精華合輯加入媒體庫：{error}', { error: (err as Error).message }))
    }
    store.transition(id, 'done', { outputPath, clipCount: selection.clips.length, totalSec: selection.totalSec })
    log(`${id} done: ${outputPath}`)
    deps.notify('montage', tr('精華合輯完成：{count} 個片段，{duration}', { count: selection.clips.length, duration: formatMontageDuration(selection.totalSec) }))

    // Only after a verified export that is in the library; read the setting now (the user may have changed it while exporting).
    if (deps.getSettings().montage.keepSourceRecording === false) {
      try {
        await deps.removeSource(job.sourcePath)
      } catch (err) {
        console.error('[montage] Failed to delete the source recording:', err)
      }
    }
  }

  function resume(): void {
    for (const job of store.inState('selecting', 'exporting')) {
      if (job.outputPath) deps.cleanupOutput(job.outputPath, { removeOutput: true })
      store.clearOutput(job.id)
      store.transition(job.id, 'selecting', { attempts: job.attempts + 1 })
    }
    for (const job of store.inState('recorded', 'analyzing')) {
      if (deps.library.get(job.sourcePath)?.status === 'done') ready(job)
      else if (job.state === 'recorded') store.transition(job.id, 'analyzing')
    }
    if (deps.getSettings().montage.timing === 'afterEachMatch') {
      for (const job of store.inState('deferred')) store.transition(job.id, 'selecting')
    }
  }

  return {
    start() {
      if (started || closed) return
      started = true
      if (enabled()) {
        resume()
      } else {
        // Auto montage was turned off while the app was not running: nothing queued may run.
        for (const job of store.inState('recorded', 'analyzing', 'deferred', 'selecting', 'exporting')) {
          if (job.outputPath) deps.cleanupOutput(job.outputPath, { removeOutput: true })
          store.clearOutput(job.id)
          store.transition(job.id, 'cancelled')
        }
      }
      emit()
      pump()
    },

    onMatchRecorded(videoPath, game) {
      // Not gated on shutdown: finalization during quit still persists the job, which runs on the next start.
      if (!enabled()) return
      const id = montageJobId(videoPath)
      if (deps.library.hasMontage(id)) return
      const { job, created } = store.create(videoPath, game)
      if (!created && job.state !== 'recorded') return
      if (game !== 'valorant') skip(job.id, 'notValorant')
      else store.transition(job.id, 'analyzing')
      emit()
    },

    onMatchAnalyzed(videoPath, _game) {
      if (!enabled()) return
      const job = store.getBySource(videoPath)
      if (!job || (job.state !== 'analyzing' && job.state !== 'recorded')) return
      ready(job)
    },

    onGameClosed() {
      if (closed || !enabled()) return
      releaseDeferred()
    },

    setGameRunning(running) {
      if (running === lastGameRunning) return
      lastGameRunning = running
      if (!running && !closed && enabled()) releaseDeferred()
    },

    onSettingsChanged() {
      const s = deps.getSettings().montage
      const was = lastEnabled
      lastEnabled = s.enabled
      if (was && !s.enabled) {
        for (const job of store.inState('recorded', 'analyzing', 'deferred', 'selecting', 'exporting')) {
          if (active?.id === job.id) {
            active.reason = 'disable'
            active.ac.abort()
          } else {
            store.transition(job.id, 'cancelled')
          }
        }
        emit()
        return
      }
      if (s.enabled && (s.timing === 'afterEachMatch' || !deps.isGameRunning())) releaseDeferred()
    },

    status,

    retry(jobId) {
      if (closed) return false
      const job = store.retry(jobId)
      if (!job) return false
      emit()
      pump()
      return true
    },

    async cancel(jobId) {
      const job = store.get(jobId)
      if (!job || isTerminal(job.state)) return false
      const run = active
      if (run?.id === jobId) {
        run.reason = 'cancel'
        run.ac.abort()
        await run.done
        return store.get(jobId)?.state === 'cancelled'
      }
      const ok = store.transition(jobId, 'cancelled') !== null
      emit()
      return ok
    },

    async open(jobId) {
      const job = store.get(jobId)
      if (!job) return null
      const projectId = montageProjectId(jobId)
      if (await deps.loadProject(projectId).catch(() => null)) return { projectId }
      // Rebuild from the analysis cache when the project file is gone (or the job never reached exporting).
      if (!deps.fileExists(job.sourcePath)) return null
      const doc = deps.readCache(job.sourcePath)
      const duration = doc?.video?.duration ?? 0
      if (!doc || !Array.isArray(doc.events) || !(duration > 0)) return null
      const settings = deps.getSettings()
      let fresh: Clip[] = []
      try {
        fresh = await deps.autoclip(doc.events, settings.autoclip, duration)
      } catch {
        return null
      }
      const cached = normalizeClips(Array.isArray(doc.clips) ? doc.clips : [])
      const userSkipped = cached.filter((c) => c.status === 'skipped')
      const selection = selectMontageClips(doc.events, [...mergeOnReanalyze(cached, fresh), ...userSkipped], {
        montage: settings.montage, autoclip: settings.autoclip, videoDurationSec: duration, rounds: doc.rounds
      })
      if (selection.clips.length === 0) return null
      const sourceBase = path.basename(job.sourcePath, path.extname(job.sourcePath))
      try {
        await deps.saveProject(buildMontageProject({ projectId, name: tr('精華合輯 – {name}', { name: sourceBase }), sourcePath: job.sourcePath, clips: selection.clips }))
      } catch {
        return null
      }
      return { projectId }
    },

    async shutdown() {
      closed = true
      const run = active
      if (run) {
        run.reason = 'interrupt'
        run.ac.abort()
        await run.done
      }
    },

    async idle() {
      while (active) await active.done
    }
  }
}
