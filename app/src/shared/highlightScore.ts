/**
 * Shared highlight core: turns a match's kill/death events into highlight windows and scores them.
 * Both Auto montage (`selectMontageClips` in `montage.ts`) and Auto edit (`planAutoEdit` in `autoEditPlan.ts`) rank
 * with these functions, so there is exactly one ranker. Pure, no Node imports (shared by main and renderer).
 *
 * Ranking order (highest first): ace > 4k > 3k > clutch > 2k > single.
 */
import type { EngineEvent, Round } from './types'

export type HighlightKind = 'ace' | '4k' | '3k' | 'clutch' | '2k' | 'single'

/** Highest value first. */
export const HIGHLIGHT_RANK: readonly HighlightKind[] = ['ace', '4k', '3k', 'clutch', '2k', 'single']

/** User-editable scoring weights (Settings → Auto edit). */
export interface ScoreWeights {
  ace: number
  quadra: number
  triple: number
  clutch: number
  double: number
  single: number
  /** Added once per pair of consecutive kills at most `quickGapSec` apart. */
  quickSuccession: number
  /** Subtracted by planners from a clip that looks like one already chosen (same kind, same source, within 30 s). */
  duplicatePenalty: number
}

/**
 * Defaults keep the ranking order for any kill count: the quick-succession bonus a window can collect
 * (`(kills - 1) * quickSuccession`) is smaller than the gap to the next tier.
 */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  ace: 100,
  quadra: 70,
  triple: 45,
  clutch: 35,
  double: 25,
  single: 10,
  quickSuccession: 5,
  duplicatePenalty: 15
}

export const SCORE_WEIGHT_RANGE = { min: 0, max: 200 } as const

/** Two consecutive kills this close earn the quick-succession bonus. */
export const QUICK_GAP_SEC = 2
/** Default merge gap: kills closer than this join one window, so a multikill is never cut in the middle. */
export const DEFAULT_MERGE_GAP_SEC = 4
/** A clutch needs the window's last kill this close to the round's end. */
export const CLUTCH_END_SEC = 10

export interface HighlightWindowOptions {
  /** Pre-roll before the first kill (seconds, `settings.autoclip.before`). */
  before: number
  /** Post-roll after the last kill (seconds, `settings.autoclip.after`). */
  after: number
  /** Kills at most this many seconds apart join one window. */
  mergeGap: number
  /** Source length; windows are clamped to [0, durationSec]. */
  durationSec: number
  /** When known, windows never cross a round boundary and clutches can be detected. */
  rounds?: Round[]
}

export interface HighlightWindow {
  /** Clamped clip range in source seconds. */
  start: number
  end: number
  /** Times of the first and last kill. */
  firstKill: number
  lastKill: number
  kills: number
  kind: HighlightKind
  /** Kill event ids, chronological. */
  eventIds: string[]
  /** Kill times, chronological. */
  killTimes: number[]
  /** Index into `rounds`, when rounds were given and the window falls inside one. */
  roundIndex?: number
  /** A death event of the player lies in (lastKill, end]: the clip would end on the player's death. */
  endsInDeath: boolean
  /** Time of that death, when `endsInDeath`. */
  deathAt?: number
}

const isLive = (e: EngineEvent): boolean => e.deleted !== true && Number.isFinite(e.t)

/** Player kills that count (VALORANT `kill`; `elim` for imported Apex data). Deleted and uncounted events are ignored. */
export function isKillEvent(e: EngineEvent): boolean {
  return isLive(e) && (e.type === 'kill' || e.type === 'elim') && e.counted
}

/** Player deaths (not deleted). */
export function isDeathEvent(e: EngineEvent): boolean {
  return isLive(e) && e.type === 'death'
}

export function kindForKills(kills: number): HighlightKind {
  if (kills >= 5) return 'ace'
  if (kills === 4) return '4k'
  if (kills === 3) return '3k'
  if (kills === 2) return '2k'
  return 'single'
}

/** Index of the round containing `t` (start inclusive, end inclusive), or -1. */
export function roundIndexAt(rounds: Round[] | undefined, t: number): number {
  if (!rounds) return -1
  return rounds.findIndex((r) => t >= r.start && t <= r.end)
}

/**
 * Group kills into windows: consecutive kills at most `mergeGap` apart (and in the same round when rounds are known)
 * form one window spanning `firstKill - before` .. `lastKill + after`, clamped to the source.
 * Windows are returned chronologically and may overlap through their pre/post roll; callers merge overlaps.
 * Kind: by kill count; a 2k becomes `clutch` when the round was won by the player's team, the player did not die in
 * it, and the last kill is within `CLUTCH_END_SEC` of the round's end (heuristic: the player closed the round out).
 */
export function highlightWindows(events: EngineEvent[], opts: HighlightWindowOptions): HighlightWindow[] {
  const dur = Math.max(0, Number.isFinite(opts.durationSec) ? opts.durationSec : 0)
  const kills = events.filter(isKillEvent).filter((e) => e.t >= 0 && e.t <= dur).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
  const deaths = events.filter(isDeathEvent).map((e) => e.t).sort((a, b) => a - b)
  const groups: EngineEvent[][] = []
  for (const k of kills) {
    const g = groups[groups.length - 1]
    const prev = g?.[g.length - 1]
    const sameRound = !opts.rounds || roundIndexAt(opts.rounds, prev?.t ?? -1) === roundIndexAt(opts.rounds, k.t)
    if (g && prev && k.t - prev.t <= opts.mergeGap && sameRound) g.push(k)
    else groups.push([k])
  }
  return groups.map((g) => {
    const firstKill = g[0].t
    const lastKill = g[g.length - 1].t
    const start = Math.max(0, firstKill - Math.max(0, opts.before))
    const end = Math.min(dur, lastKill + Math.max(0, opts.after))
    const ri = roundIndexAt(opts.rounds, firstKill)
    let kind = kindForKills(g.length)
    if (kind === '2k' && ri >= 0 && opts.rounds) {
      const r = opts.rounds[ri]
      const diedInRound = deaths.some((d) => d >= r.start && d <= r.end)
      if (r.winner === 'ally' && !diedInRound && r.end - lastKill <= CLUTCH_END_SEC) kind = 'clutch'
    }
    const deathAt = deaths.find((d) => d > lastKill && d <= end)
    return {
      start,
      end,
      firstKill,
      lastKill,
      kills: g.length,
      kind,
      eventIds: g.map((e) => e.id),
      killTimes: g.map((e) => e.t),
      ...(ri >= 0 ? { roundIndex: ri } : {}),
      endsInDeath: deathAt !== undefined,
      ...(deathAt !== undefined ? { deathAt } : {})
    }
  })
}

const KIND_WEIGHT: Record<HighlightKind, keyof ScoreWeights> = {
  ace: 'ace',
  '4k': 'quadra',
  '3k': 'triple',
  clutch: 'clutch',
  '2k': 'double',
  single: 'single'
}

/** Score of one window: kind weight plus the quick-succession bonus. Duplicate penalties are applied by planners. */
export function scoreHighlight(w: Pick<HighlightWindow, 'kind' | 'killTimes'>, weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS): number {
  let quick = 0
  for (let i = 1; i < w.killTimes.length; i++) if (w.killTimes[i] - w.killTimes[i - 1] <= QUICK_GAP_SEC) quick++
  return weights[KIND_WEIGHT[w.kind]] + quick * weights.quickSuccession
}

/** Sort comparator: higher score first, then higher kind rank, then earlier. Deterministic. */
export function compareHighlights(
  a: Pick<HighlightWindow, 'kind' | 'killTimes' | 'start'>,
  b: Pick<HighlightWindow, 'kind' | 'killTimes' | 'start'>,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS
): number {
  return (
    scoreHighlight(b, weights) - scoreHighlight(a, weights) ||
    HIGHLIGHT_RANK.indexOf(a.kind) - HIGHLIGHT_RANK.indexOf(b.kind) ||
    a.start - b.start
  )
}

/** Lenient coercion of persisted weights: each field falls back on its own and is clamped to `SCORE_WEIGHT_RANGE`. */
export function coerceScoreWeights(raw: unknown, base: ScoreWeights = DEFAULT_SCORE_WEIGHTS): ScoreWeights {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out = { ...base }
  for (const k of Object.keys(base) as (keyof ScoreWeights)[]) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(SCORE_WEIGHT_RANGE.max, Math.max(SCORE_WEIGHT_RANGE.min, v))
  }
  return out
}

/** Overlay caption per kind ("DOUBLE KILL", "ACE", ...); singles get none. English source text, translated by callers. */
export const KIND_CAPTION: Record<HighlightKind, string | null> = {
  ace: 'ACE',
  '4k': 'QUADRA KILL',
  '3k': 'TRIPLE KILL',
  clutch: 'CLUTCH',
  '2k': 'DOUBLE KILL',
  single: null
}
