/**
 * Auto montage (phase 2 contract): after a recorded VALORANT match is analyzed, pick its highlights and export one montage file.
 * Plan and state machine: `docs/superpowers/plans/auto-montage.md`.
 *
 * This file is shared by main (montage service, settings validation, IPC guards), preload and renderer, so it must not import Node modules.
 * The exported signatures are the contract every part of the feature codes against; change them only through the lead.
 */
import type { AutoClipParams, Clip, EngineEvent, Round } from './types'
import { PRESET_IDS, type PresetId } from './exportFormat'
import { compareHighlights, DEFAULT_MERGE_GAP_SEC, highlightWindows, type HighlightKind, type HighlightWindow } from './highlightScore'

/** Export preset ids reused from `shared/exportPresets.ts` (16:9 YouTube, 9:16 Shorts/TikTok/Reels, 1:1 Square). */
export type ExportPresetId = PresetId

/** Which highlight kinds may go into a montage. */
export interface MontageInclude {
  /** 2k, 3k and 4k rounds. */
  multiKills: boolean
  /** 5k rounds. */
  aces: boolean
  /** Won rounds the player closed out (heuristic, see `selectMontageClips`). */
  clutches: boolean
  /** Lone kills. */
  singleKills: boolean
}

export type MontageTiming = 'afterEachMatch' | 'afterGameExit'
export const MONTAGE_TIMINGS: readonly MontageTiming[] = ['afterEachMatch', 'afterGameExit']

/** `settings.recording.autoMontage`. */
export interface AutoMontageSettings {
  /** Opt-in: building a montage uses GPU/CPU after each match. */
  enabled: boolean
  formatPreset: ExportPresetId
  /** Do not export a montage with fewer clips than this. */
  minClips: number
  /** Cap on the montage's total length in seconds. */
  maxDurationSec: number
  include: MontageInclude
  /** afterEachMatch: as soon as the match is analyzed (low priority while the game runs); afterGameExit: queue until VALORANT closes. */
  timing: MontageTiming
  /** false: delete the per-match source recording after a verified successful export (the UI confirms this on first enable). */
  keepSourceRecording: boolean
  /** null = `<storageRoot>/Montages/<YYYY-MM-DD>/` (see `MONTAGES_DIRNAME`). */
  outputDir: string | null
}

export const MONTAGE_RANGES = {
  minClips: { min: 1, max: 10 },
  maxDurationSec: { min: 15, max: 300 }
} as const

export const DEFAULT_AUTO_MONTAGE: AutoMontageSettings = {
  enabled: false,
  formatPreset: 'youtube',
  minClips: 2,
  maxDurationSec: 90,
  include: { multiKills: true, aces: true, clutches: true, singleKills: true },
  timing: 'afterEachMatch',
  keepSourceRecording: true,
  outputDir: null
}

/** Folder under the storage root that holds montages, grouped by date like `Recordings`. */
export const MONTAGES_DIRNAME = 'Montages'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bool = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb)
const intIn = (v: unknown, r: { min: number; max: number }, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, Math.round(v))) : fb

/**
 * Lenient coercion for persisted settings and settings writes: each field falls back to `base` on its own when invalid;
 * numbers are rounded and clamped to `MONTAGE_RANGES`. `outputDir` is only type-checked here (main validates the path itself).
 * A missing or malformed object (settings files from before this feature) yields a copy of `base`.
 */
export function coerceAutoMontage(raw: unknown, base: AutoMontageSettings = DEFAULT_AUTO_MONTAGE): AutoMontageSettings {
  if (!isObj(raw)) return { ...base, include: { ...base.include } }
  const inc = isObj(raw.include) ? raw.include : {}
  return {
    enabled: bool(raw.enabled, base.enabled),
    formatPreset: PRESET_IDS.includes(raw.formatPreset as PresetId) ? (raw.formatPreset as PresetId) : base.formatPreset,
    minClips: intIn(raw.minClips, MONTAGE_RANGES.minClips, base.minClips),
    maxDurationSec: intIn(raw.maxDurationSec, MONTAGE_RANGES.maxDurationSec, base.maxDurationSec),
    include: {
      multiKills: bool(inc.multiKills, base.include.multiKills),
      aces: bool(inc.aces, base.include.aces),
      clutches: bool(inc.clutches, base.include.clutches),
      singleKills: bool(inc.singleKills, base.include.singleKills)
    },
    timing: MONTAGE_TIMINGS.includes(raw.timing as MontageTiming) ? (raw.timing as MontageTiming) : base.timing,
    keepSourceRecording: bool(raw.keepSourceRecording, base.keepSourceRecording),
    outputDir: raw.outputDir === null ? null : typeof raw.outputDir === 'string' && raw.outputDir.length > 0 ? raw.outputDir : base.outputDir
  }
}

/**
 * Rule for `postAnalysis === 'none'` (decided in the plan): Auto montage needs analysis results, so turning it on switches
 * post-recording analysis to 'perMatch'. The UI tells the user before saving; main enforces the same rule on every write so the
 * combination "montage on, analysis none" can never be stored. Returns the postAnalysis value to store.
 */
export function postAnalysisForMontage<T extends string>(postAnalysis: T | 'none', montage: Pick<AutoMontageSettings, 'enabled'>): T | 'perMatch' {
  return montage.enabled && postAnalysis === 'none' ? 'perMatch' : (postAnalysis as T)
}

// ---------------------------------------------------------------------------------------------------------------------
// Job state machine (one job per recorded match, persisted by main in `<appData>/montage/jobs.json`).
//   recorded → analyzing → selecting → exporting → done
//                 │            │            │
//                 └────────────┴────────────┴──→ skipped(reason) | failed(reason)
//   deferred: waiting for VALORANT to close (timing afterGameExit, GPU budget, or a new match started during export).
//   cancelled: the user cancelled, or turned Auto montage off mid-job. Terminal states are never re-entered automatically;
//   only `montage:retry` moves skipped/failed/cancelled back to `selecting`.

export type MontageJobState = 'recorded' | 'analyzing' | 'deferred' | 'selecting' | 'exporting' | 'done' | 'skipped' | 'failed' | 'cancelled'
export const MONTAGE_TERMINAL_STATES: readonly MontageJobState[] = ['done', 'skipped', 'failed', 'cancelled']

export type MontageSkipReason =
  /** Fewer highlight clips than `minClips`. */
  | 'tooFew'
  /** No highlight events at all (0 kills, only deaths, or every kind excluded). */
  | 'empty'
  /** Free disk space below `diskWarnGb`, or below the export estimate plus `diskStopGb`. */
  | 'lowDisk'
  /** Source is not a VALORANT recording (Apex is not supported by Auto montage). */
  | 'notValorant'
  /** The source recording was removed before the montage was built. */
  | 'sourceMissing'

export type MontageFailCode = 'analysis' | 'engine' | 'encoder' | 'export' | 'verify' | 'io'

export interface MontageJob {
  /** Stable id derived from the normalized source path (`montageJobId`), so the same match never gets two jobs. */
  id: string
  sourcePath: string
  game: 'valorant' | 'apex'
  state: MontageJobState
  skipReason?: MontageSkipReason
  failCode?: MontageFailCode
  /** Human-readable message for failed jobs (already translated by main). */
  error?: string
  /** 0..1 while exporting. */
  progress: number
  clipCount?: number
  totalSec?: number
  outputPath?: string
  projectId?: string
  /** Format preset captured when the job was selected (a later settings change does not alter a running job). */
  formatPreset?: ExportPresetId
  createdAt: number
  updatedAt: number
  /** Incremented by each export attempt (resume after restart, retry). */
  attempts: number
}

/** `montage:status` result and `montage:changed` push payload. */
export interface MontageStatus {
  /** The job currently selecting or exporting, if any. */
  active: MontageJob | null
  /** Most recent jobs first (at most `MONTAGE_STATUS_LIMIT`). */
  jobs: MontageJob[]
}
export const MONTAGE_STATUS_LIMIT = 20

/** Job ids are `m_` + 16 hex chars (see `montageJobId`). */
export const MONTAGE_JOB_ID_RE = /^m_[0-9a-f]{16}$/

/** Deterministic job id from a source path: case-insensitive, separator-insensitive (Windows paths), FNV-1a 64-bit. */
export function montageJobId(sourcePath: string): string {
  const norm = sourcePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let h = 0xcbf29ce484222325n
  for (const ch of new TextEncoder().encode(norm)) {
    h ^= BigInt(ch)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `m_${h.toString(16).padStart(16, '0')}`
}

/** Project id of the montage project for a job (valid `ProjectStore` id). */
export function montageProjectId(jobId: string): string {
  return `p_${jobId}`
}

/** IPC channel names. */
export const MONTAGE_CHANNELS = {
  /** invoke → MontageStatus */
  status: 'montage:status',
  /** invoke(jobId) → { projectId } | null: make sure the montage project exists and return its id so the renderer opens it in Studio. */
  open: 'montage:open',
  /** invoke(jobId) → boolean: re-run a skipped/failed/cancelled job. */
  retry: 'montage:retry',
  /** invoke(jobId) → boolean: cancel a queued, deferred or running job. */
  cancel: 'montage:cancel',
  /** push: MontageStatus */
  changed: 'montage:changed'
} as const

// ---------------------------------------------------------------------------------------------------------------------
// Composition (implemented by subagent C; signature fixed).

export interface MontageSelectInput {
  montage: Pick<AutoMontageSettings, 'minClips' | 'maxDurationSec' | 'include'>
  /** `settings.autoclip` (pre/post roll: `before`/`after`). */
  autoclip: AutoClipParams
  /** Source video length in seconds (clips are clamped to [0, videoDurationSec]). */
  videoDurationSec: number
  /** Rounds from the cache, when known (used for clutch detection and round grouping). */
  rounds?: Round[]
}

export interface MontageSelection {
  /** Chosen clips in chronological order, non-overlapping. Ids are kept from the input clips where a clip is reused unchanged. */
  clips: Clip[]
  /** Sum of the chosen clips' lengths in seconds. */
  totalSec: number
  skipped?: 'tooFew' | 'empty'
}

/** Chosen ranges closer than this are joined into one clip. */
const MONTAGE_JOIN_GAP_SEC = 0.5
/** When the best window alone is over the cap, its pre/post roll is trimmed down to this much around the kills. */
const MONTAGE_TRIM_PAD_SEC = 0.5

const finiteOr = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)

/** Kind used for filtering and ranking, or null when the include settings exclude the window. */
function effectiveKind(kind: HighlightKind, inc: MontageInclude): HighlightKind | null {
  switch (kind) {
    case 'ace':
      return inc.aces ? 'ace' : null
    case '4k':
    case '3k':
    case '2k':
      return inc.multiKills ? kind : null
    case 'clutch':
      // A clutch is a 2k as well: with clutches off it still goes in (and ranks) as a multikill.
      return inc.clutches ? 'clutch' : inc.multiKills ? '2k' : null
    case 'single':
      return inc.singleKills ? 'single' : null
  }
}

/** Which existing clip names a montage clip when several meet in it: manual, then accepted, then suggested; then earliest. */
const clipPriority = (c: Clip): number => (c.origin === 'manual' ? 0 : (c.status ?? 'accepted') === 'accepted' ? 1 : 2)
const compareExisting = (a: Clip, b: Clip): number =>
  clipPriority(a) - clipPriority(b) || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

interface Candidate {
  /** Window with its effective kind (ranked by `compareHighlights`). */
  w: HighlightWindow
  /** Window range united with the existing clips it overlaps. */
  start: number
  end: number
  existing: Clip[]
}

interface Joined {
  start: number
  end: number
  eventIds: string[]
  existing: Clip[]
}

/** Join candidates whose ranges overlap or lie less than `MONTAGE_JOIN_GAP_SEC` apart; result is chronological. */
function joinRanges(cands: Candidate[]): Joined[] {
  const sorted = [...cands].sort((a, b) => a.start - b.start || a.end - b.end || a.w.firstKill - b.w.firstKill)
  const out: Joined[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start - last.end < MONTAGE_JOIN_GAP_SEC) {
      last.end = Math.max(last.end, c.end)
      last.eventIds.push(...c.w.eventIds)
      last.existing.push(...c.existing)
    } else {
      out.push({ start: c.start, end: c.end, eventIds: [...c.w.eventIds], existing: [...c.existing] })
    }
  }
  return out
}

const totalOf = (j: Joined[]): number => j.reduce((s, x) => s + (x.end - x.start), 0)

/**
 * Pick and order the montage clips from a match's events and its clips (autoclip output plus existing cache clips).
 * Pure: no I/O, deterministic for the same input; inputs are never mutated.
 *
 * 1. Windows come from the shared ranker (`highlightWindows`) with `autoclip.before/after` as pre/post roll and
 *    `autoclip.gap` as merge gap (`DEFAULT_MERGE_GAP_SEC` when not a positive number), so a multikill is never split.
 *    `autoclip.n` and `autoclip.max_len` do not apply to montages.
 * 2. Include filter: aces → ace; multiKills → 2k/3k/4k; clutches → clutch; singleKills → single. With clutches off and
 *    multiKills on, a clutch is kept and ranked as a 2k.
 * 3. Existing clips: a non-skipped clip overlapping a window is reused — the montage clip spans the union of both ranges
 *    and keeps that clip's id, origin, status and other fields (manual beats accepted beats suggested when several meet
 *    in one montage clip; the others are absorbed). Skipped clips are ignored entirely, so a window overlapping only a
 *    skipped clip is still eligible. Stale AI suggestions are ignored too (their range comes from an older analysis;
 *    the fresh window replaces them), while stale accepted/manual clips are reused because a user decision is attached.
 *    Existing clips that overlap no eligible window are not part of the montage.
 * 4. Ranges overlapping or less than 0.5 s apart are joined into one clip (event ids united, chronological).
 * 5. Cap: while the total exceeds `maxDurationSec`, the lowest-value window (`compareHighlights`) is dropped. When only
 *    the best window remains and it is still over the cap, its range is trimmed toward
 *    [firstKill - 0.5, lastKill + 0.5] (half from each side where possible); a kill span longer than the cap is kept
 *    whole, so the result exceeds the cap in that one case. A non-positive or non-finite cap means no cap.
 * 6. `empty` when no eligible window exists; `tooFew` when fewer than `minClips` clips remain after joining and the cap.
 */
export function selectMontageClips(events: EngineEvent[], clips: Clip[], settings: MontageSelectInput): MontageSelection {
  const dur = Math.max(0, finiteOr(settings.videoDurationSec, 0))
  const ac = settings.autoclip
  const gap = finiteOr(ac?.gap, 0) > 0 ? ac.gap : DEFAULT_MERGE_GAP_SEC
  const before = Math.max(0, finiteOr(ac?.before, 0))
  const after = Math.max(0, finiteOr(ac?.after, 0))
  const capRaw = finiteOr(settings.montage.maxDurationSec, 0)
  const cap = capRaw > 0 ? capRaw : Number.POSITIVE_INFINITY
  const minClips = finiteOr(settings.montage.minClips, 1)
  const inc = settings.montage.include

  const windows = highlightWindows(events, {
    before,
    after,
    mergeGap: gap,
    durationSec: dur,
    ...(settings.rounds ? { rounds: settings.rounds } : {})
  })
  const eligible: HighlightWindow[] = []
  for (const w of windows) {
    const kind = effectiveKind(w.kind, inc)
    if (kind && w.end > w.start) eligible.push({ ...w, kind })
  }
  if (eligible.length === 0) return { clips: [], totalSec: 0, skipped: 'empty' }

  // Existing clips that may be reused, as clamped copies.
  const usable = clips
    .filter((c) => c.status !== 'skipped' && !(c.stale === true && c.origin === 'ai' && c.status === 'suggested'))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end))
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(dur, c.end) }))
    .filter((c) => c.end > c.start)

  const cands: Candidate[] = eligible.map((w) => {
    const existing = usable.filter((c) => c.start < w.end && c.end > w.start)
    return {
      w,
      start: Math.min(w.start, ...existing.map((c) => c.start)),
      end: Math.max(w.end, ...existing.map((c) => c.end)),
      existing
    }
  })

  // Cap: drop the lowest-value window until the total fits (or only the best is left).
  let kept = [...cands].sort((a, b) => compareHighlights(a.w, b.w) || a.w.firstKill - b.w.firstKill)
  let joined = joinRanges(kept)
  while (kept.length > 1 && totalOf(joined) > cap) {
    kept = kept.slice(0, -1)
    joined = joinRanges(kept)
  }
  if (joined.length === 1 && totalOf(joined) > cap) {
    const j = joined[0]
    const w = kept[0].w
    const ks = Math.max(0, w.firstKill - MONTAGE_TRIM_PAD_SEC)
    const ke = Math.min(dur, w.lastKill + MONTAGE_TRIM_PAD_SEC)
    const excess = j.end - j.start - cap
    const slackPre = Math.max(0, ks - j.start)
    const slackPost = Math.max(0, j.end - ke)
    const cutPre = Math.min(slackPre, Math.max(excess / 2, excess - slackPost))
    const cutPost = Math.min(slackPost, excess - cutPre)
    j.start += cutPre
    j.end -= cutPost
  }

  if (joined.length < minClips) return { clips: [], totalSec: 0, skipped: 'tooFew' }

  // After joining, an existing clip belongs to exactly one montage clip (its range is inside every candidate it touched).
  const takenIds = new Set(clips.map((c) => c.id))
  const out: Clip[] = joined.map((j) => {
    const eventIds = [...new Set(j.eventIds)]
    const reuse = [...j.existing].sort(compareExisting)[0]
    if (reuse) {
      const extra = j.existing.flatMap((c) => c.event_ids ?? [])
      return { ...reuse, start: j.start, end: j.end, event_ids: [...new Set([...eventIds, ...extra])] }
    }
    const base = `mt_${Math.round(j.start * 1000)}`
    let id = base
    for (let n = 2; takenIds.has(id); n++) id = `${base}_${n}`
    takenIds.add(id)
    return { id, start: j.start, end: j.end, origin: 'ai', event_ids: eventIds, status: 'suggested' }
  })
  return { clips: out, totalSec: out.reduce((s, c) => s + (c.end - c.start), 0) }
}

