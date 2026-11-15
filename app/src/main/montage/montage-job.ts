/**
 * Auto montage job store: one job per recorded match (`montageJobId(sourcePath)`), persisted in `<appData>/montage/jobs.json`.
 * State machine: `docs/superpowers/plans/auto-montage.md` §1 and `shared/montage.ts`. No Electron dependency.
 */
import fs from 'fs'
import path from 'path'
import { writeFileAtomicSync } from '../atomic-write'
import {
  MONTAGE_JOB_ID_RE,
  MONTAGE_TERMINAL_STATES,
  montageJobId,
  type MontageFailCode,
  type MontageJob,
  type MontageJobState,
  type MontageSkipReason
} from '../../shared/montage'
import { PRESET_IDS, type PresetId } from '../../shared/exportFormat'

export const MONTAGE_JOBS_FILE_VERSION = 1
/** Jobs kept on disk. Non-terminal jobs are never dropped; the oldest terminal jobs go first. */
export const MONTAGE_JOBS_KEEP = 500

const STATES: readonly MontageJobState[] = ['recorded', 'analyzing', 'deferred', 'selecting', 'exporting', 'done', 'skipped', 'failed', 'cancelled']
const SKIP_REASONS: readonly MontageSkipReason[] = ['tooFew', 'empty', 'lowDisk', 'notValorant', 'sourceMissing']
const FAIL_CODES: readonly MontageFailCode[] = ['analysis', 'engine', 'encoder', 'export', 'verify', 'io']

/**
 * Automatic transitions. Terminal states have no outgoing edge here: only `retry()` leaves skipped/failed/cancelled (to selecting),
 * and `done` is final. `selecting → selecting` and `exporting → selecting` are the resume/interrupt edges (attempts are counted by the caller).
 */
const NEXT: Readonly<Record<MontageJobState, readonly MontageJobState[]>> = {
  recorded: ['analyzing', 'skipped', 'failed', 'cancelled'],
  analyzing: ['selecting', 'deferred', 'skipped', 'failed', 'cancelled'],
  deferred: ['selecting', 'skipped', 'failed', 'cancelled'],
  selecting: ['selecting', 'exporting', 'deferred', 'skipped', 'failed', 'cancelled'],
  exporting: ['selecting', 'done', 'deferred', 'skipped', 'failed', 'cancelled'],
  done: [],
  skipped: [],
  failed: [],
  cancelled: []
}

export const RETRYABLE_STATES: readonly MontageJobState[] = ['skipped', 'failed', 'cancelled']

export function isTerminal(state: MontageJobState): boolean {
  return MONTAGE_TERMINAL_STATES.includes(state)
}

export function canTransition(from: MontageJobState, to: MontageJobState): boolean {
  return NEXT[from].includes(to)
}

export interface TransitionPatch {
  skipReason?: MontageSkipReason
  failCode?: MontageFailCode
  error?: string
  progress?: number
  clipCount?: number
  totalSec?: number
  outputPath?: string
  projectId?: string
  formatPreset?: PresetId
  attempts?: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A persisted job, or null when its shape is invalid (the id must match its source path so a hand-edited file cannot alias two matches). */
export function parseJob(raw: unknown): MontageJob | null {
  if (!isObj(raw)) return null
  const { id, sourcePath, game, state } = raw
  if (typeof id !== 'string' || !MONTAGE_JOB_ID_RE.test(id)) return null
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || montageJobId(sourcePath) !== id) return null
  if (game !== 'valorant' && game !== 'apex') return null
  if (!STATES.includes(state as MontageJobState)) return null
  if (!finiteNum(raw.createdAt) || !finiteNum(raw.updatedAt)) return null
  const job: MontageJob = {
    id,
    sourcePath,
    game,
    state: state as MontageJobState,
    progress: finiteNum(raw.progress) ? Math.min(1, Math.max(0, raw.progress)) : 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    attempts: finiteNum(raw.attempts) && raw.attempts >= 0 ? Math.floor(raw.attempts) : 0
  }
  if (SKIP_REASONS.includes(raw.skipReason as MontageSkipReason)) job.skipReason = raw.skipReason as MontageSkipReason
  if (FAIL_CODES.includes(raw.failCode as MontageFailCode)) job.failCode = raw.failCode as MontageFailCode
  if (typeof raw.error === 'string') job.error = raw.error
  if (finiteNum(raw.clipCount)) job.clipCount = raw.clipCount
  if (finiteNum(raw.totalSec)) job.totalSec = raw.totalSec
  if (typeof raw.outputPath === 'string' && raw.outputPath) job.outputPath = raw.outputPath
  if (typeof raw.projectId === 'string' && raw.projectId) job.projectId = raw.projectId
  if (PRESET_IDS.includes(raw.formatPreset as PresetId)) job.formatPreset = raw.formatPreset as PresetId
  return job
}

export interface MontageJobStoreOptions {
  now?: () => number
  keep?: number
}

/**
 * In-memory jobs mirrored to disk on every state change (tmp + fsync + rename). Progress changes stay in memory.
 * A corrupt file is renamed to `jobs.bak.<ts>.json` and the store starts empty; an unreadable file (locked) blocks saving
 * for the session so it is never overwritten with partial data.
 */
export class MontageJobStore {
  private jobs = new Map<string, MontageJob>()
  private readonly now: () => number
  private readonly keep: number
  /** Path of the backup made from a corrupt file, for diagnostics. */
  corruptBackup: string | null = null
  private saveBlocked = false

  constructor(private readonly file: string, opts: MontageJobStoreOptions = {}) {
    this.now = opts.now ?? Date.now
    this.keep = opts.keep ?? MONTAGE_JOBS_KEEP
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      this.saveBlocked = true
      console.error('[montage] Failed to read jobs, saving is disabled for this session:', err)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
      if (!isObj(parsed) || !Array.isArray(parsed.jobs)) throw new Error('jobs.json has no jobs array')
    } catch (err) {
      console.error('[montage] Job file is corrupt, moved aside:', err)
      this.backupCorrupt()
      return
    }
    let dropped = 0
    for (const entry of parsed.jobs as unknown[]) {
      const job = parseJob(entry)
      if (!job) {
        dropped++
        continue
      }
      // Two records for one match: keep the furthest along (a terminal record wins, so a finished montage is never rebuilt).
      const existing = this.jobs.get(job.id)
      if (!existing || (isTerminal(job.state) && !isTerminal(existing.state)) || (isTerminal(job.state) === isTerminal(existing.state) && job.updatedAt > existing.updatedAt)) {
        this.jobs.set(job.id, job)
      }
    }
    if (dropped > 0) {
      console.error(`[montage] Dropped ${dropped} invalid job record(s)`)
      this.backupCorrupt(true)
      this.save()
    }
  }

  private backupCorrupt(copy = false): void {
    const bak = path.join(path.dirname(this.file), `jobs.bak.${this.now()}.json`)
    try {
      if (copy) fs.copyFileSync(this.file, bak)
      else fs.renameSync(this.file, bak)
      this.corruptBackup = bak
    } catch (err) {
      if (!copy) {
        this.saveBlocked = true
        console.error('[montage] Failed to back up the corrupt job file, saving is disabled for this session:', err)
      }
    }
  }

  /** Persist now; false when blocked or the write failed (memory stays authoritative). */
  save(): boolean {
    if (this.saveBlocked) return false
    this.prune()
    try {
      const jobs = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
      writeFileAtomicSync(this.file, JSON.stringify({ version: MONTAGE_JOBS_FILE_VERSION, jobs }, null, 2))
      return true
    } catch (err) {
      console.error('[montage] Failed to save jobs:', err)
      return false
    }
  }

  private prune(): void {
    if (this.jobs.size <= this.keep) return
    const terminal = [...this.jobs.values()].filter((j) => isTerminal(j.state)).sort((a, b) => a.updatedAt - b.updatedAt)
    for (const job of terminal) {
      if (this.jobs.size <= this.keep) break
      this.jobs.delete(job.id)
    }
  }

  get(id: string): MontageJob | undefined {
    const job = this.jobs.get(id)
    return job ? { ...job } : undefined
  }

  getBySource(sourcePath: string): MontageJob | undefined {
    return this.get(montageJobId(sourcePath))
  }

  /** All jobs, most recent first. */
  list(): MontageJob[] {
    // Reversed insertion order first, so jobs created in the same millisecond still list newest first (sort is stable).
    return [...this.jobs.values()].reverse().sort((a, b) => b.createdAt - a.createdAt).map((j) => ({ ...j }))
  }

  /** Jobs in a state, oldest first (processing order). */
  inState(...states: MontageJobState[]): MontageJob[] {
    return [...this.jobs.values()].filter((j) => states.includes(j.state)).sort((a, b) => a.createdAt - b.createdAt).map((j) => ({ ...j }))
  }

  /** Idempotent: the existing job for the same match is returned unchanged (created: false). */
  create(sourcePath: string, game: 'valorant' | 'apex'): { job: MontageJob; created: boolean } {
    const id = montageJobId(sourcePath)
    const existing = this.jobs.get(id)
    if (existing) return { job: { ...existing }, created: false }
    const t = this.now()
    const job: MontageJob = { id, sourcePath, game, state: 'recorded', progress: 0, createdAt: t, updatedAt: t, attempts: 0 }
    this.jobs.set(id, job)
    this.save()
    return { job: { ...job }, created: true }
  }

  /**
   * Move a job along an allowed edge (see NEXT); returns the updated job or null when the edge is not allowed or the job is unknown.
   * Leaving a state clears the previous outcome fields; entering skipped/failed records the reason.
   */
  transition(id: string, to: MontageJobState, patch: TransitionPatch = {}): MontageJob | null {
    const job = this.jobs.get(id)
    if (!job || !canTransition(job.state, to)) return null
    this.apply(job, to, patch)
    return { ...job }
  }

  private apply(job: MontageJob, to: MontageJobState, patch: TransitionPatch): void {
    job.state = to
    if (to !== 'skipped') delete job.skipReason
    if (to !== 'failed') {
      delete job.failCode
      delete job.error
    }
    if (to !== 'exporting' && to !== 'done') job.progress = 0
    Object.assign(job, patch)
    if (to === 'done') job.progress = 1
    job.updatedAt = this.now()
    this.save()
  }

  /** Only skipped/failed/cancelled may be retried; the job goes back to selecting with attempts + 1. */
  retry(id: string): MontageJob | null {
    const job = this.jobs.get(id)
    if (!job || !RETRYABLE_STATES.includes(job.state)) return null
    delete job.outputPath
    this.apply(job, 'selecting', { attempts: job.attempts + 1 })
    return { ...job }
  }

  /** Field update without a state change (outputPath while exporting, etc.); persisted unless only progress changed. */
  patch(id: string, fields: Omit<TransitionPatch, 'attempts'>): MontageJob | null {
    const job = this.jobs.get(id)
    if (!job) return null
    Object.assign(job, fields)
    const keys = Object.keys(fields)
    if (keys.some((k) => k !== 'progress')) {
      job.updatedAt = this.now()
      this.save()
    }
    return { ...job }
  }

  /** Remove the planned output path (cleanup after an interrupted export). */
  clearOutput(id: string): void {
    const job = this.jobs.get(id)
    if (!job || job.outputPath === undefined) return
    delete job.outputPath
    this.save()
  }
}
