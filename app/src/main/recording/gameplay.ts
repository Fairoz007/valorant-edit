/**
 * Which part of a VALORANT recording is gameplay (pure; no I/O).
 *
 * The Riot Client reports a match as INGAME from the loading screen on; agent select (PREGAME) and the menus are already
 * outside matches. The live engine's scoreboard tracker (engine/src/valorant_rounds.rs) starts a match at the first frame
 * that shows the top-HUD score, which is the first round's buy phase, so the first round's `start` is the first gameplay frame.
 *
 * Every rule here errs towards keeping footage: a trim is applied only when the evidence is consistent, and never past a
 * detected kill or death.
 */
import type { LiveMatch } from '../../shared/recording'

export interface Range { start: number; end: number }
export interface LiveRound { start: number; end: number; winner: string; ally: number; enemy: number }

/** Longest loading screen we trust a HUD start after; a later first HUD sighting means detection missed the start. */
export const LOADING_MAX_SEC = 180
/** Kept before the first HUD frame (the HUD fades in). */
export const GAMEPLAY_PRE_PAD_SEC = 2
/** Never trim closer than this to a detected kill or death. */
export const EVENT_GUARD_SEC = 5
/** Buy phase, conservatively: it starts this long after the score changes (round-end screen) … */
export const BUY_PHASE_AFTER_ROUND_END_SEC = 9
/** … and only this much of it is cut (VALORANT's buy phase is 30 s, longer in the first round of a half). */
export const BUY_PHASE_CUT_SEC = 24
/** Session fallback (no Riot Client): footage kept around detected rounds and events. */
export const INFERRED_BEFORE_SEC = 90
export const INFERRED_AFTER_SEC = 60
/** Session fallback: gaps shorter than this between kept stretches are kept too (one match, not several files). */
export const INFERRED_MERGE_GAP_SEC = 180

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** Valid rounds from live.json, in time order. */
export function liveRounds(value: unknown): LiveRound[] {
  if (!Array.isArray(value)) return []
  return value.filter((r): r is LiveRound => !!r && finite(r.start) && finite(r.end) && r.end >= r.start && r.start >= 0 &&
    (r.winner === 'ally' || r.winner === 'enemy'))
    .sort((a, b) => a.start - b.start)
}

/** Times of the player's kills and deaths (and any other detected event) that were not deleted. */
export function liveEventTimes(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((e) => !!e && finite(e.t) && e.t >= 0 && e.deleted !== true).map((e) => e.t as number).sort((a, b) => a - b)
}

/**
 * Start of gameplay in a Riot Client match: the first HUD frame of the match (minus a small pad) when it is plausible,
 * otherwise the match start unchanged. Never later than a detected event minus EVENT_GUARD_SEC.
 */
export function gameplayStart(match: Range, rounds: readonly LiveRound[], events: readonly number[]): number {
  const inMatch = rounds.filter((r) => r.end > match.start && r.start < match.end)
  if (!inMatch.length) return match.start
  const hud = inMatch[0].start
  if (!(hud > match.start) || hud - match.start > LOADING_MAX_SEC) return match.start
  let start = hud - GAMEPLAY_PRE_PAD_SEC
  const firstEvent = events.find((t) => t >= match.start && t <= match.end)
  if (firstEvent !== undefined) start = Math.min(start, firstEvent - EVENT_GUARD_SEC)
  return Math.max(match.start, start)
}

/**
 * trimBuyPhase: the kept ranges of [start, end] with the buy phase between rounds removed. A cut never covers an event
 * (± EVENT_GUARD_SEC) and never reaches into the next round's end; with no rounds the whole range is kept.
 */
export function withoutBuyPhases(range: Range, rounds: readonly LiveRound[], events: readonly number[]): Range[] {
  const inRange = rounds.filter((r) => r.end > range.start && r.start < range.end)
  const cuts: Range[] = []
  for (let i = 0; i < inRange.length; i++) {
    const next = inRange[i + 1]
    // The last round of the match has no buy phase after it.
    if (!next) break
    const from = inRange[i].end + BUY_PHASE_AFTER_ROUND_END_SEC
    const to = Math.min(from + BUY_PHASE_CUT_SEC, next.end - 1)
    if (to - from < 5) continue
    if (events.some((t) => t > from - EVENT_GUARD_SEC && t < to + EVENT_GUARD_SEC)) continue
    cuts.push({ start: Math.max(range.start, from), end: Math.min(range.end, to) })
  }
  const kept: Range[] = []
  let at = range.start
  for (const cut of cuts) {
    if (cut.start > at) kept.push({ start: at, end: cut.start })
    at = Math.max(at, cut.end)
  }
  if (at < range.end) kept.push({ start: at, end: range.end })
  return kept
}

/**
 * Riot Client unreachable: matches inferred from the live engine alone (HUD rounds and events, padded generously and
 * merged). Empty means no evidence of gameplay, which the caller must treat as "keep everything", not as "lobby only".
 */
export function inferredMatches(rounds: readonly LiveRound[], events: readonly number[], recordingEnd: number): LiveMatch[] {
  const spans: Range[] = [
    ...rounds.map((r) => ({ start: r.start, end: r.end })),
    ...events.map((t) => ({ start: t, end: t }))
  ].map((s) => ({ start: Math.max(0, s.start - INFERRED_BEFORE_SEC), end: Math.min(recordingEnd, s.end + INFERRED_AFTER_SEC) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const merged: Range[] = []
  for (const s of spans) {
    const last = merged.at(-1)
    if (last && s.start - last.end < INFERRED_MERGE_GAP_SEC) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  return merged.map((m) => ({ start: m.start, end: m.end }))
}
