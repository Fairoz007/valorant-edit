/**
 * Auto edit planner (phase 2B.1). Signature fixed by the lead; agent F replaces the body.
 * Pure and deterministic: no I/O, same input → same plan. Ranking via `highlightScore.ts` (shared with Auto montage).
 */
import {
  AUTO_EDIT_TARGET_RANGE,
  clipOutputSec,
  planTotalSec,
  STYLE_PRESETS,
  TARGET_TOLERANCE_SEC,
  type AutoEditClip,
  type AutoEditOptions,
  type AutoEditPlan,
  type AutoEditSource,
  type ClipEffect,
  type ClipOverlay,
  type MusicBed,
  type StylePreset,
  type TitleCard
} from './autoEdit'
import { compareHighlights, highlightWindows, isDeathEvent, KIND_CAPTION, scoreHighlight, type HighlightWindow } from './highlightScore'

/** A clip that ends in the player's death is cut this long before the death. */
const DEATH_TRIM_SEC = 0.2
/** A death-trimmed clip must keep this much after its last kill... */
const DEATH_MIN_AFTER_KILL_SEC = 0.3
/** ...and be at least this long, or it is dropped. */
const MIN_CLIP_SEC = 1
/** Same kind in the same source within this many seconds of a picked clip → duplicate penalty. */
const DUPLICATE_WINDOW_SEC = 30
/** When shrinking rolls to fit a target, keep at least this much pre/post roll (or the original roll if shorter). */
const MIN_ROLL_SEC = 1
const CAPTION_SEC = 1.5
const FLASH_SEC = 0.1
/** Effects per clip are capped by the project schema (16): slow-mo + zoom + at most 14 flashes. */
const MAX_FLASHES = 14
const INTRO: Omit<TitleCard, 'text'> = { durationSec: 2, background: 'blurFrame' }
const OUTRO: TitleCard = { text: 'GG', durationSec: 1.5, background: 'black' }

export const AUTO_EDIT_WARNING_SHORT = 'Target longer than the available highlights'
export const AUTO_EDIT_WARNING_LONG = 'Target shorter than the best highlight'

/** One usable highlight window with its static adjustment bounds. */
interface Cand {
  /** Global chronological index (source order, then time). */
  idx: number
  srcIdx: number
  path: string
  w: HighlightWindow
  /** Base range after death trimming, min-length and overlap resolution. */
  s0: number
  e0: number
  /** Furthest the range may grow (source, round, deaths when excluded), independent of neighbours. */
  outerLo: number
  outerHi: number
  /** Furthest the range may shrink (kills always stay inside). */
  hiS: number
  loE: number
  base: number
}

interface Range {
  c: Cand
  start: number
  end: number
}

function prepareSource(s: AutoEditSource, srcIdx: number, options: AutoEditOptions): Omit<Cand, 'idx'>[] {
  const dur = Number.isFinite(s.durationSec) ? Math.max(0, s.durationSec) : 0
  const windows = highlightWindows(s.events, {
    before: options.before,
    after: options.after,
    mergeGap: options.mergeGap,
    durationSec: dur,
    rounds: s.rounds
  })
  const deaths = s.events.filter(isDeathEvent).map((e) => e.t).sort((a, b) => a - b)
  const out: { w: HighlightWindow; s0: number; e0: number; deathCap: number }[] = []
  for (const w of windows) {
    let start = w.start
    let end = w.end
    // Death cap for later growth: never run into the next death when deaths are excluded.
    const nextDeath = deaths.find((d) => d > w.lastKill)
    const deathCap = !options.includeDeaths && nextDeath !== undefined ? nextDeath - DEATH_TRIM_SEC : dur
    if (!options.includeDeaths && w.endsInDeath && w.deathAt !== undefined) {
      end = w.deathAt - DEATH_TRIM_SEC
      if (end < w.lastKill + DEATH_MIN_AFTER_KILL_SEC || end - start < MIN_CLIP_SEC) continue
    }
    // Very short windows (zero pre/post roll): grow to the minimum length inside the allowed range.
    if (end - start < MIN_CLIP_SEC) {
      const hi = Math.max(end, Math.min(dur, deathCap))
      end = Math.min(hi, start + MIN_CLIP_SEC)
      start = Math.max(0, end - MIN_CLIP_SEC)
      if (end - start < 0.1) continue
    }
    out.push({ w, s0: start, e0: end, deathCap })
  }
  // Pre/post rolls of neighbouring windows may overlap: split at the midpoint between their kills.
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]
    const b = out[i]
    if (a.e0 > b.s0) {
      const m = (a.w.lastKill + b.w.firstKill) / 2
      a.e0 = Math.min(a.e0, m)
      b.s0 = Math.max(b.s0, m)
    }
  }
  return out.map(({ w, s0, e0, deathCap }) => {
    const prevDeath = [...deaths].reverse().find((d) => d < w.firstKill)
    const round = w.roundIndex !== undefined ? s.rounds?.[w.roundIndex] : undefined
    const lo = Math.max(0, !options.includeDeaths && prevDeath !== undefined ? prevDeath + DEATH_TRIM_SEC : 0, round?.start ?? 0)
    const hi = Math.min(dur, deathCap, round?.end ?? dur)
    return {
      srcIdx,
      path: s.path,
      w,
      s0,
      e0,
      outerLo: Math.min(s0, lo),
      outerHi: Math.max(e0, hi),
      hiS: w.firstKill - Math.min(MIN_ROLL_SEC, w.firstKill - s0),
      loE: w.lastKill + Math.min(MIN_ROLL_SEC, e0 - w.lastKill),
      base: scoreHighlight(w, options.weights)
    }
  })
}

/** Distance between two windows' kill spans (0 when they overlap). */
function killGap(a: HighlightWindow, b: HighlightWindow): number {
  return Math.max(0, a.firstKill - b.lastKill, b.firstKill - a.lastKill)
}

function effects(start: number, end: number, w: HighlightWindow, style: StylePreset): ClipEffect[] {
  if (w.kills < 2) return []
  const fx: ClipEffect[] = []
  if (style.flash) {
    for (const t of w.killTimes.slice(-MAX_FLASHES)) if (t >= start && t <= end) fx.push({ kind: 'flash', at: t, durationSec: FLASH_SEC })
  }
  if (style.zoomPunch) fx.push({ kind: 'zoomPunch', at: w.lastKill, durationSec: style.zoomPunch.durationSec, scale: style.zoomPunch.scale })
  if (style.slowMo) fx.push({ kind: 'slowmo', at: w.lastKill, durationSec: style.slowMo.durationSec, speed: style.slowMo.speed })
  return fx
}

function overlay(start: number, end: number, w: HighlightWindow, style: StylePreset): ClipOverlay | null {
  const text = KIND_CAPTION[w.kind]
  if (!style.overlays || !text) return null
  // At the last kill; pulled earlier when the clip ends before the caption would finish.
  const at = end - w.lastKill >= CAPTION_SEC ? w.lastKill : Math.max(start, end - CAPTION_SEC)
  return { text, at, durationSec: Math.min(CAPTION_SEC, end - at) }
}

export function planAutoEdit(sources: AutoEditSource[], options: AutoEditOptions): AutoEditPlan {
  const style = STYLE_PRESETS[options.style]
  const presetId = style.presetId ?? options.presetId
  const emptyPlan = (empty: 'noSources' | 'noKills'): AutoEditPlan => ({
    style: options.style, presetId, clips: [], totalSec: 0, music: null, intro: null, outro: null,
    letterbox: false, beatSync: false, empty, warnings: []
  })
  if (sources.length === 0) return emptyPlan('noSources')

  const ordered = [...sources].sort((a, b) => a.recordedAt - b.recordedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const cands: Cand[] = ordered.flatMap((s, i) => prepareSource(s, i, options)).map((c, idx) => ({ ...c, idx }))
  if (cands.length === 0) return emptyPlan('noKills')

  const weights = options.weights
  const tSec = style.transition === 'cut' ? 0 : style.transitionSec
  const first = ordered[0]
  const intro: TitleCard | null = style.intro
    ? { text: Number.isFinite(first.recordedAt) && first.recordedAt > 0 ? `Auto edit ${new Date(first.recordedAt).toISOString().slice(0, 10)}` : 'Auto edit', ...INTRO }
    : null
  const outro: TitleCard | null = style.outro ? { ...OUTRO } : null
  const cardsSec = (intro?.durationSec ?? 0) + (outro?.durationSec ?? 0)

  // Same sum as `planTotalSec` (dip transitions add nothing), without building full clips.
  const totalOf = (ranges: Range[]): number =>
    ranges.reduce((sec, r) => sec + clipOutputSec({ in: r.start, out: r.end, speed: 1, effects: effects(r.start, r.end, r.c.w, style) }), cardsSec)
  const baseRanges = (cs: Cand[]): Range[] => cs.map((c) => ({ c, start: c.s0, end: c.e0 }))

  // Greedy ranking with the duplicate penalty relative to the clips already picked.
  const scores = new Map<Cand, number>()
  const effScore = (c: Cand, picked: Cand[]): number =>
    c.base - (picked.some((p) => p.srcIdx === c.srcIdx && p.w.kind === c.w.kind && killGap(p.w, c.w) <= DUPLICATE_WINDOW_SEC) ? weights.duplicatePenalty : 0)
  const ranked = (remaining: Cand[], picked: Cand[]): { c: Cand; s: number }[] =>
    remaining
      .map((c) => ({ c, s: effScore(c, picked) }))
      .sort((a, b) => b.s - a.s || compareHighlights(a.c.w, b.c.w, weights) || a.c.idx - b.c.idx)
  const greedy = (accept: (picked: Cand[], c: Cand) => boolean): Cand[] => {
    const picked: Cand[] = []
    let remaining = [...cands]
    while (remaining.length > 0) {
      const next = ranked(remaining, picked).find(({ c }) => accept(picked, c))
      if (!next) break
      scores.set(next.c, next.s)
      picked.push(next.c)
      remaining = remaining.filter((c) => c !== next.c)
    }
    return picked
  }

  /** Adjust pre/post rolls of `picked` by one common amount so the total lands on `target` (or as close as bounds allow). */
  const fit = (picked: Cand[], target: number): Range[] => {
    const base = baseRanges(picked)
    if (Math.abs(totalOf(base) - target) <= TARGET_TOLERANCE_SEC) return base
    // Neighbours from the same source share the free gap between them, split at the midpoint between their kills.
    const lo = new Map<Cand, number>(picked.map((c) => [c, c.outerLo]))
    const hi = new Map<Cand, number>(picked.map((c) => [c, c.outerHi]))
    const bySrc = [...picked].sort((a, b) => a.idx - b.idx)
    for (let i = 1; i < bySrc.length; i++) {
      const a = bySrc[i - 1]
      const b = bySrc[i]
      if (a.srcIdx !== b.srcIdx) continue
      const split = Math.min(b.s0, Math.max(a.e0, (a.w.lastKill + b.w.firstKill) / 2))
      hi.set(a, Math.min(hi.get(a)!, split))
      lo.set(b, Math.max(lo.get(b)!, split))
    }
    const at = (lambda: number): Range[] =>
      picked.map((c) =>
        lambda >= 0
          ? { c, start: Math.max(lo.get(c)!, c.s0 - lambda), end: Math.min(hi.get(c)!, c.e0 + lambda) }
          : { c, start: Math.min(c.hiS, c.s0 - lambda), end: Math.max(c.loE, c.e0 + lambda) }
      )
    const maxExt = Math.max(0, ...picked.map((c) => Math.max(c.s0 - lo.get(c)!, hi.get(c)! - c.e0)))
    const maxShrink = Math.max(0, ...picked.map((c) => Math.max(c.hiS - c.s0, c.e0 - c.loE)))
    let a = -maxShrink
    let b = maxExt
    if (totalOf(at(b)) <= target) return at(b)
    if (totalOf(at(a)) >= target) return at(a)
    for (let i = 0; i < 80; i++) {
      const m = (a + b) / 2
      if (totalOf(at(m)) < target) a = m
      else b = m
    }
    return at((a + b) / 2)
  }

  const warnings: string[] = []
  let target: number | null = null
  if (typeof options.targetSec === 'number' && Number.isFinite(options.targetSec)) {
    target = Math.min(AUTO_EDIT_TARGET_RANGE.max, Math.max(AUTO_EDIT_TARGET_RANGE.min, options.targetSec))
    if (style.maxSec !== null) target = Math.min(target, style.maxSec)
  } else if (style.maxSec !== null && totalOf(baseRanges(cands)) > style.maxSec + TARGET_TOLERANCE_SEC) {
    target = style.maxSec
  }

  let ranges: Range[]
  if (target === null) {
    ranges = baseRanges(greedy(() => true))
  } else {
    const T = target
    let picked = greedy((p, c) => totalOf(baseRanges([...p, c])) <= T + TARGET_TOLERANCE_SEC)
    ranges = fit(picked, T)
    let total = totalOf(ranges)
    const tried = new Set<Cand>(picked)
    while (total < T - TARGET_TOLERANCE_SEC) {
      const next = ranked(cands.filter((c) => !tried.has(c)), picked)[0]
      if (!next) break
      tried.add(next.c)
      const trial = fit([...picked, next.c], T)
      const trialTotal = totalOf(trial)
      if (trialTotal <= T + TARGET_TOLERANCE_SEC) {
        scores.set(next.c, next.s)
        picked = [...picked, next.c]
        ranges = trial
        total = trialTotal
      }
    }
    if (picked.length === 0) {
      // Not even the best highlight fits: use it, shrunk as far as allowed.
      const best = ranked(cands, [])[0]
      scores.set(best.c, best.s)
      ranges = fit([best.c], T)
      warnings.push(AUTO_EDIT_WARNING_LONG)
    } else if (total < T - TARGET_TOLERANCE_SEC) {
      warnings.push(AUTO_EDIT_WARNING_SHORT)
    }
  }

  const chrono = (a: Range, b: Range): number => a.c.idx - b.c.idx
  ranges = [...ranges].sort(
    options.order === 'buildUp' ? (a, b) => scores.get(a.c)! - scores.get(b.c)! || chrono(a, b) : chrono
  )

  const clips: AutoEditClip[] = ranges.map((r, i) => ({
    id: `ae_${i}`,
    source: r.c.path,
    in: r.start,
    out: r.end,
    speed: 1,
    gain: 1,
    effects: effects(r.start, r.end, r.c.w, style),
    overlay: overlay(r.start, r.end, r.c.w, style),
    transitionIn: i === 0 ? 'cut' : style.transition,
    transitionSec: i === 0 ? 0 : tSec,
    score: scores.get(r.c)!,
    kind: r.c.w.kind,
    eventIds: [...r.c.w.eventIds]
  }))

  const music: MusicBed | null = options.musicPath
    ? { path: options.musicPath, gain: style.musicGain, duck: true, fadeInSec: 1, fadeOutSec: 1.5 }
    : null

  return {
    style: options.style,
    presetId,
    clips,
    totalSec: planTotalSec(clips, intro, outro),
    music,
    intro,
    outro,
    letterbox: style.letterbox,
    beatSync: style.beatSync && music !== null,
    warnings
  }
}
