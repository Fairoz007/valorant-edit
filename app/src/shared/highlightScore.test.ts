import { describe, it, expect } from 'vitest'
import type { EngineEvent, Round } from './types'
import {
  coerceScoreWeights,
  compareHighlights,
  DEFAULT_SCORE_WEIGHTS,
  HIGHLIGHT_RANK,
  highlightWindows,
  isKillEvent,
  kindForKills,
  scoreHighlight,
  type HighlightKind
} from './highlightScore'

let n = 0
const ev = (t: number, type = 'kill', extra: Partial<EngineEvent> = {}): EngineEvent => ({
  id: `e${n++}`, t, type, score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto', ...extra
})
const opts = { before: 3, after: 1.5, mergeGap: 4, durationSec: 600 }

describe('highlightWindows', () => {
  it('ignores deleted, uncounted and non-kill events', () => {
    expect(isKillEvent(ev(1, 'kill', { deleted: true }))).toBe(false)
    expect(isKillEvent(ev(1, 'kill', { counted: false }))).toBe(false)
    expect(isKillEvent(ev(1, 'death'))).toBe(false)
    expect(highlightWindows([ev(10, 'death'), ev(20, 'kill', { deleted: true })], opts)).toEqual([])
  })

  it("honours the user's counted_override in both directions", () => {
    expect(isKillEvent(ev(1, 'kill', { counted: false, counted_override: true }))).toBe(true)
    expect(isKillEvent(ev(1, 'kill', { counted: true, counted_override: false }))).toBe(false)
    const w = highlightWindows([ev(100, 'kill', { counted: false, counted_override: true }), ev(102, 'kill', { counted_override: false })], opts)
    expect(w.map((x) => x.kills)).toEqual([1])
  })

  it('merges kills within the merge gap so a multikill is one window, with pre/post roll', () => {
    const w = highlightWindows([ev(100), ev(103), ev(106.5), ev(120)], opts)
    expect(w.map((x) => [x.start, x.end, x.kills, x.kind])).toEqual([
      [97, 108, 3, '3k'],
      [117, 121.5, 1, 'single']
    ])
  })

  it('clamps to the source and keeps kills at second 0 and the last second', () => {
    const w = highlightWindows([ev(0), ev(600)], opts)
    expect(w.map((x) => [x.start, x.end])).toEqual([[0, 1.5], [597, 600]])
    expect(highlightWindows([ev(601)], opts)).toEqual([])
  })

  it('never joins kills from different rounds', () => {
    const rounds: Round[] = [
      { start: 0, end: 102, winner: 'enemy', ally: 0, enemy: 1 },
      { start: 102.5, end: 200, winner: 'ally', ally: 1, enemy: 1 }
    ]
    const w = highlightWindows([ev(100), ev(103)], { ...opts, rounds })
    expect(w.map((x) => [x.kills, x.roundIndex])).toEqual([[1, 0], [1, 1]])
  })

  it('marks a won 2k round that the player closed out without dying as clutch', () => {
    const rounds: Round[] = [{ start: 0, end: 100, winner: 'ally', ally: 1, enemy: 0 }]
    expect(highlightWindows([ev(90), ev(93)], { ...opts, rounds })[0].kind).toBe('clutch')
    expect(highlightWindows([ev(50), ev(52)], { ...opts, rounds })[0].kind).toBe('2k')
    expect(highlightWindows([ev(90), ev(93), ev(95, 'death')], { ...opts, rounds })[0].kind).toBe('2k')
    const lost: Round[] = [{ ...rounds[0], winner: 'enemy' }]
    expect(highlightWindows([ev(90), ev(93)], { ...opts, rounds: lost })[0].kind).toBe('2k')
  })

  it('flags windows that end in the player death', () => {
    const [w] = highlightWindows([ev(100), ev(101, 'death')], opts)
    expect(w.endsInDeath).toBe(true)
    expect(w.deathAt).toBe(101)
    expect(highlightWindows([ev(100), ev(110, 'death')], opts)[0].endsInDeath).toBe(false)
  })

  it('classifies 5+ kills as ace', () => {
    expect([1, 2, 3, 4, 5, 6].map(kindForKills)).toEqual(['single', '2k', '3k', '4k', 'ace', 'ace'])
    expect(highlightWindows([ev(1), ev(2), ev(3), ev(4), ev(5)], opts)[0].kind).toBe('ace')
  })
})

describe('scoring', () => {
  const win = (kind: HighlightKind, killTimes: number[], start = 0) => ({ kind, killTimes, start })
  it('keeps ace > 4k > 3k > clutch > 2k > single even with the maximum quick-succession bonus', () => {
    const fast = (k: number) => Array.from({ length: k }, (_, i) => i)
    const slow = (k: number) => Array.from({ length: k }, (_, i) => i * 3.9)
    const kinds: [HighlightKind, number][] = [['ace', 5], ['4k', 4], ['3k', 3], ['clutch', 2], ['2k', 2], ['single', 1]]
    for (let i = 0; i + 1 < kinds.length; i++) {
      const hi = scoreHighlight(win(kinds[i][0], slow(kinds[i][1])))
      const lo = scoreHighlight(win(kinds[i + 1][0], fast(kinds[i + 1][1])))
      expect(hi).toBeGreaterThan(lo)
    }
    expect(HIGHLIGHT_RANK).toEqual(kinds.map((k) => k[0]))
  })

  it('adds the quick-succession bonus per close pair', () => {
    expect(scoreHighlight(win('3k', [0, 1, 5]))).toBe(DEFAULT_SCORE_WEIGHTS.triple + DEFAULT_SCORE_WEIGHTS.quickSuccession)
  })

  it('respects user weights and sorts deterministically', () => {
    const w = { ...DEFAULT_SCORE_WEIGHTS, single: 500 }
    const list = [win('2k', [10, 14], 10), win('single', [50], 50), win('2k', [5, 9], 5)]
    expect([...list].sort((a, b) => compareHighlights(a, b, w)).map((x) => x.start)).toEqual([50, 5, 10])
    expect([...list].sort((a, b) => compareHighlights(a, b)).map((x) => x.start)).toEqual([5, 10, 50])
  })

  it('coerces persisted weights field by field', () => {
    expect(coerceScoreWeights(null)).toEqual(DEFAULT_SCORE_WEIGHTS)
    expect(coerceScoreWeights({ ace: 999, single: -4, triple: 'x', double: 30 })).toEqual({ ...DEFAULT_SCORE_WEIGHTS, ace: 200, single: 0, double: 30 })
  })
})
