import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AUTO_EDIT_OPTIONS,
  MONTAGE_STYLES,
  planTotalSec,
  STYLE_PRESETS,
  TARGET_TOLERANCE_SEC,
  type AutoEditOptions,
  type AutoEditPlan,
  type AutoEditSource,
  type MontageStyle
} from './autoEdit'
import { AUTO_EDIT_WARNING_SHORT, planAutoEdit } from './autoEditPlan'
import { autoEditToProject } from './autoEditProject'
import { DEFAULT_SCORE_WEIGHTS } from './highlightScore'
import type { EngineEvent, Round } from './types'
import { projectShapeError } from '../renderer/editor/project'

let seq = 0
const ev = (t: number, type = 'kill', over: Partial<EngineEvent> = {}): EngineEvent => ({
  id: `e${seq++}`, t, type, score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '',
  counted_override: null, source: 'auto', ...over
})
const kills = (...ts: number[]): EngineEvent[] => ts.map((t) => ev(t))
const src = (path: string, events: EngineEvent[], over: Partial<AutoEditSource> = {}): AutoEditSource => ({
  path, durationSec: 600, recordedAt: Date.UTC(2026, 10, 1, 12), events, hasAudio: true, ...over
})
const opts = (over: Partial<AutoEditOptions> = {}): AutoEditOptions => ({ ...DEFAULT_AUTO_EDIT_OPTIONS, sources: [], ...over })

/** A long match: 60 kill groups of varying size, some ending in a death. */
function longMatch(path = 'C:\\Users\\Jane Doe\\Videos\\match.mp4'): AutoEditSource {
  const pattern = [1, 2, 1, 3, 1, 1, 2, 4, 1, 5, 1, 2]
  const events: EngineEvent[] = []
  for (let i = 0; i < 60; i++) {
    const t0 = 30 + i * 38
    const n = pattern[i % pattern.length]
    for (let k = 0; k < n; k++) events.push(ev(t0 + k * 1.5))
    if (i % 5 === 4) events.push(ev(t0 + (n - 1) * 1.5 + 1, 'death'))
  }
  return src(path, events, { durationSec: 2400 })
}

/** Many short 20 s clips with one or two kill groups each. */
function shortSources(n = 15): AutoEditSource[] {
  return Array.from({ length: n }, (_, i) =>
    src(`C:\\clips\\short ${String(i).padStart(2, '0')}.mp4`, i % 3 === 0 ? kills(4, 5.5, 14) : kills(6, 7, 8.2), {
      durationSec: 20, recordedAt: Date.UTC(2026, 10, 1) + i * 60_000
    })
  )
}

function checkPlan(plan: AutoEditPlan, sources: AutoEditSource[]): void {
  expect(plan.totalSec).toBe(planTotalSec(plan.clips, plan.intro, plan.outro))
  const project = autoEditToProject(plan, 'p_test', 'Auto edit')
  expect(projectShapeError(project)).toBeNull()
  plan.clips.forEach((c, i) => {
    expect(c.id).toBe(`ae_${i}`)
    expect(c.in).toBeLessThan(c.out)
    const s = sources.find((x) => x.path === c.source)!
    expect(c.in).toBeGreaterThanOrEqual(0)
    expect(c.out).toBeLessThanOrEqual(s.durationSec)
    // Every kill of the window stays inside the clip.
    for (const id of c.eventIds) {
      const t = s.events.find((e) => e.id === id)!.t
      expect(t).toBeGreaterThanOrEqual(c.in)
      expect(t).toBeLessThanOrEqual(c.out)
    }
    if (i === 0) expect(c).toMatchObject({ transitionIn: 'cut', transitionSec: 0 })
  })
  // Clips from the same source never overlap.
  const bySrc = new Map<string, { in: number; out: number }[]>()
  for (const c of plan.clips) bySrc.set(c.source, [...(bySrc.get(c.source) ?? []), c])
  for (const list of bySrc.values()) {
    const sorted = [...list].sort((a, b) => a.in - b.in)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].in).toBeGreaterThanOrEqual(sorted[i - 1].out - 1e-9)
  }
}

describe('windows', () => {
  it('builds clip windows from kills with pre/post roll and merges kills within the merge gap', () => {
    const s = src('a.mp4', kills(20, 23, 60))
    const plan = planAutoEdit([s], opts({ targetSec: 'all', before: 3, after: 1.5, mergeGap: 4 }))
    expect(plan.clips.map((c) => [c.in, c.out, c.kind])).toEqual([[17, 24.5, '2k'], [57, 61.5, 'single']])
    const split = planAutoEdit([s], opts({ targetSec: 'all', mergeGap: 2 }))
    expect(split.clips.map((c) => c.kind)).toEqual(['single', 'single', 'single'])
    checkPlan(plan, [s])
  })

  it('never splits a multikill, even when the target is short', () => {
    const s = src('a.mp4', kills(100, 102, 104, 106, 108))
    const plan = planAutoEdit([s], opts({ targetSec: 10 }))
    expect(plan.clips).toHaveLength(1)
    expect(plan.clips[0].kind).toBe('ace')
    expect(plan.clips[0].in).toBeLessThanOrEqual(100)
    expect(plan.clips[0].out).toBeGreaterThanOrEqual(108)
    expect(Math.abs(plan.totalSec - 10)).toBeLessThanOrEqual(TARGET_TOLERANCE_SEC)
    checkPlan(plan, [s])
  })

  it('clamps windows to the source', () => {
    const s = src('a.mp4', kills(1, 19.5), { durationSec: 20 })
    const plan = planAutoEdit([s], opts({ targetSec: 'all' }))
    expect(plan.clips[0].in).toBe(0)
    expect(plan.clips[plan.clips.length - 1].out).toBe(20)
    checkPlan(plan, [s])
  })

  it('resolves overlapping pre/post rolls of neighbouring windows', () => {
    const s = src('a.mp4', kills(10, 14.5))
    const plan = planAutoEdit([s], opts({ targetSec: 'all', mergeGap: 4, before: 3, after: 3 }))
    expect(plan.clips).toHaveLength(2)
    expect(plan.clips[0].out).toBeCloseTo(12.25, 10)
    expect(plan.clips[1].in).toBeCloseTo(12.25, 10)
    checkPlan(plan, [s])
  })
})

describe('deaths', () => {
  it('trims a clip ending in a death to 0.2 s before it when deaths are excluded', () => {
    const s = src('a.mp4', [...kills(50, 51), ev(52, 'death')])
    const plan = planAutoEdit([s], opts({ targetSec: 'all', after: 3 }))
    expect(plan.clips[0].out).toBeCloseTo(51.8, 10)
    const kept = planAutoEdit([s], opts({ targetSec: 'all', after: 3, includeDeaths: true }))
    expect(kept.clips[0].out).toBe(54)
  })

  it('drops the clip when too little remains before the death', () => {
    const s = src('a.mp4', [...kills(50), ev(50.3, 'death'), ...kills(200)])
    const plan = planAutoEdit([s], opts({ targetSec: 'all' }))
    expect(plan.clips).toHaveLength(1)
    expect(plan.clips[0].in).toBe(197)
    expect(planAutoEdit([s], opts({ targetSec: 'all', includeDeaths: true })).clips).toHaveLength(2)
    // Every clip dropped → noKills.
    expect(planAutoEdit([src('b.mp4', [...kills(50), ev(50.2, 'death')])], opts()).empty).toBe('noKills')
  })

  it('never grows a clip into a death while fitting the target', () => {
    const s = src('a.mp4', [...kills(50, 51), ev(54, 'death'), ev(40, 'death')], { durationSec: 120 })
    const plan = planAutoEdit([s], opts({ targetSec: 60 }))
    expect(plan.clips[0].out).toBeLessThanOrEqual(53.8 + 1e-9)
    expect(plan.clips[0].in).toBeGreaterThanOrEqual(40.2 - 1e-9)
    expect(plan.warnings).toContain(AUTO_EDIT_WARNING_SHORT)
    checkPlan(plan, [s])
  })
})

describe('scoring', () => {
  const s = src('a.mp4', [...kills(20, 22), ...kills(100, 103.5, 107)])

  it('picks the higher-weighted window and stores the score', () => {
    // 3k window 11.5 s, 2k window 6.5 s: only one fits 15 s.
    const def = planAutoEdit([s], opts({ targetSec: 15 }))
    expect(def.clips.map((c) => c.kind)).toEqual(['3k'])
    expect(def.clips[0].score).toBe(DEFAULT_SCORE_WEIGHTS.triple)
    const weights = { ...DEFAULT_SCORE_WEIGHTS, double: 150 }
    const swapped = planAutoEdit([s], opts({ targetSec: 15, weights }))
    expect(swapped.clips.map((c) => c.kind)).toEqual(['2k'])
    expect(swapped.clips[0].score).toBe(150 + DEFAULT_SCORE_WEIGHTS.quickSuccession)
  })

  it('applies the duplicate penalty to the same kind in the same source within 30 s', () => {
    // Two doubles 20 s apart (duplicates) and a lone double far away; triple-length target.
    const d = src('a.mp4', kills(100, 103, 120, 123, 400, 403), { durationSec: 600 })
    const plan = planAutoEdit([d], opts({ targetSec: 'all' }))
    expect(plan.clips.map((c) => c.score)).toEqual([25, 10, 25])
    const two = planAutoEdit([d], opts({ targetSec: 16 }))
    expect(two.clips.map((c) => c.in)).toEqual([97, 397])
    const noPenalty = planAutoEdit([d], opts({ targetSec: 'all', weights: { ...DEFAULT_SCORE_WEIGHTS, duplicatePenalty: 0 } }))
    expect(noPenalty.clips.map((c) => c.score)).toEqual([25, 25, 25])
  })
})

describe('target length', () => {
  const cases: [string, () => AutoEditSource[]][] = [['long match', () => [longMatch()]], ['short sources', () => shortSources()]]
  for (const [name, make] of cases) {
    for (const target of [30, 60, 180]) {
      for (const style of MONTAGE_STYLES) {
        it(`${name}: ${target} s ${style} lands within ±1 s`, () => {
          const sources = make()
          const plan = planAutoEdit(sources, opts({ targetSec: target, style, musicPath: 'C:\\Music\\a.mp3' }))
          const expected = Math.min(target, STYLE_PRESETS[style].maxSec ?? Infinity)
          expect(Math.abs(plan.totalSec - expected)).toBeLessThanOrEqual(TARGET_TOLERANCE_SEC)
          expect(plan.warnings).toEqual([])
          checkPlan(plan, sources)
        })
      }
    }
  }

  it('uses everything and warns when the material is short', () => {
    const sources = shortSources(3)
    const plan = planAutoEdit(sources, opts({ targetSec: 180 }))
    expect(plan.totalSec).toBeLessThan(180 - TARGET_TOLERANCE_SEC)
    expect(plan.warnings).toEqual([AUTO_EDIT_WARNING_SHORT])
    expect(plan.clips.length).toBe(planAutoEdit(sources, opts({ targetSec: 'all' })).clips.length)
    // All the material of the sources (20 s each) is used.
    expect(plan.totalSec).toBeCloseTo(60, 6)
    checkPlan(plan, sources)
  })

  it("'all' keeps every window with its original rolls", () => {
    const sources = [longMatch()]
    const plan = planAutoEdit(sources, opts({ targetSec: 'all' }))
    expect(plan.clips).toHaveLength(60)
    expect(plan.warnings).toEqual([])
    // Group 4 is a single kill at 182 with a death at 183: trimmed to 182.8; group 5 (single at 220) is untouched.
    expect([plan.clips[4].in, plan.clips[4].out]).toEqual([179, 182.8])
    expect([plan.clips[5].in, plan.clips[5].out]).toEqual([217, 221.5])
    checkPlan(plan, sources)
  })

  it('Shorts caps the length at 60 s, also for all', () => {
    const sources = [longMatch()]
    for (const targetSec of [180, 'all'] as const) {
      const plan = planAutoEdit(sources, opts({ targetSec, style: 'shorts' }))
      expect(Math.abs(plan.totalSec - 60)).toBeLessThanOrEqual(TARGET_TOLERANCE_SEC)
      expect(plan.presetId).toBe('shorts')
      checkPlan(plan, sources)
    }
    const few = [src('a.mp4', kills(10))]
    expect(planAutoEdit(few, opts({ targetSec: 'all', style: 'shorts' })).totalSec).toBe(4.5)
  })
})

describe('ordering', () => {
  const s = src('a.mp4', [...kills(10, 11, 12, 13, 14), ...kills(100), ...kills(200, 201)])

  it('chronological keeps source time order', () => {
    expect(planAutoEdit([s], opts({ targetSec: 'all' })).clips.map((c) => c.kind)).toEqual(['ace', 'single', '2k'])
  })

  it('buildUp puts the weakest first and the best last', () => {
    const plan = planAutoEdit([s], opts({ targetSec: 'all', order: 'buildUp' }))
    expect(plan.clips.map((c) => c.kind)).toEqual(['single', '2k', 'ace'])
    expect(plan.clips.map((c) => c.id)).toEqual(['ae_0', 'ae_1', 'ae_2'])
    expect(plan.clips[0].transitionIn).toBe('cut')
  })

  it('orders multiple videos by recordedAt, ties by path', () => {
    const a = src('C:\\v\\b.mp4', kills(10), { recordedAt: 3000 })
    const b = src('C:\\v\\a.mp4', kills(10), { recordedAt: 1000 })
    const c = src('C:\\v\\c.mp4', kills(10), { recordedAt: 1000 })
    const plan = planAutoEdit([a, c, b], opts({ targetSec: 'all' }))
    expect(plan.clips.map((x) => x.source)).toEqual(['C:\\v\\a.mp4', 'C:\\v\\c.mp4', 'C:\\v\\b.mp4'])
  })
})

describe('style', () => {
  const s = src('a.mp4', [...kills(10), ...kills(50, 51), ...kills(100, 101, 102), ...kills(150, 151, 152, 153), ...kills(200, 201, 202, 203, 204)])
  const plan = (style: MontageStyle, over: Partial<AutoEditOptions> = {}): AutoEditPlan => planAutoEdit([s], opts({ targetSec: 'all', style, ...over }))

  it('overlay caption per multikill level at the last kill, none for singles or Clean', () => {
    const p = plan('cinematic')
    expect(p.clips.map((c) => c.overlay?.text ?? null)).toEqual([null, 'DOUBLE KILL', 'TRIPLE KILL', 'QUADRA KILL', 'ACE'])
    expect(p.clips[1].overlay).toEqual({ text: 'DOUBLE KILL', at: 51, durationSec: 1.5 })
    expect(plan('clean').clips.every((c) => c.overlay === null)).toBe(true)
  })

  it('clutch caption', () => {
    const rounds: Round[] = [{ start: 0, end: 60, winner: 'ally', ally: 1, enemy: 0 }]
    const p = planAutoEdit([src('a.mp4', kills(50, 52), { rounds })], opts({ targetSec: 'all', style: 'hype' }))
    expect(p.clips[0].kind).toBe('clutch')
    expect(p.clips[0].overlay?.text).toBe('CLUTCH')
  })

  it('effects per style on multikills only', () => {
    expect(plan('clean').clips.every((c) => c.effects.length === 0)).toBe(true)
    const cin = plan('cinematic').clips
    expect(cin[0].effects).toEqual([])
    expect(cin[1].effects).toEqual([{ kind: 'slowmo', at: 51, durationSec: 0.6, speed: 0.5 }])
    const hype = plan('hype').clips
    expect(hype[0].effects).toEqual([])
    expect(hype[2].effects).toEqual([
      { kind: 'flash', at: 100, durationSec: 0.1 }, { kind: 'flash', at: 101, durationSec: 0.1 }, { kind: 'flash', at: 102, durationSec: 0.1 },
      { kind: 'zoomPunch', at: 102, durationSec: 0.3, scale: 1.2 }
    ])
    const shorts = plan('shorts').clips
    expect(shorts[4].effects).toEqual([{ kind: 'zoomPunch', at: 204, durationSec: 0.3, scale: 1.15 }])
  })

  it('caps effects at the schema limit for very long multikills', () => {
    const many = src('a.mp4', kills(...Array.from({ length: 20 }, (_, i) => 10 + i)))
    const p = planAutoEdit([many], opts({ targetSec: 'all', style: 'hype' }))
    expect(p.clips[0].effects.length).toBeLessThanOrEqual(16)
    checkPlan(p, [many])
  })

  it('transitions on every clip but the first', () => {
    for (const style of MONTAGE_STYLES) {
      const p = plan(style)
      const preset = STYLE_PRESETS[style]
      expect(p.clips[0]).toMatchObject({ transitionIn: 'cut', transitionSec: 0 })
      for (const c of p.clips.slice(1)) expect(c).toMatchObject({ transitionIn: preset.transition, transitionSec: preset.transitionSec })
      checkPlan(p, [s])
    }
  })

  it('intro, outro, music, letterbox and beat sync per style', () => {
    const music = 'C:\\Users\\Jane Doe\\Music\\track 1.mp3'
    const cin = plan('cinematic', { musicPath: music })
    expect(cin.intro).toEqual({ text: 'Auto edit 2026-11-01', durationSec: 2, background: 'blurFrame' })
    expect(cin.outro).toEqual({ text: 'GG', durationSec: 1.5, background: 'black' })
    expect(cin.music).toEqual({ path: music, gain: 0.4, duck: true, fadeInSec: 1, fadeOutSec: 1.5 })
    expect(cin.letterbox).toBe(true)
    const clean = plan('clean')
    expect([clean.intro, clean.outro, clean.music, clean.letterbox, clean.beatSync]).toEqual([null, null, null, false, false])
    const hype = plan('hype', { musicPath: music })
    expect([hype.intro, hype.outro?.text, hype.beatSync, hype.music?.gain]).toEqual([null, 'GG', true, 0.5])
    expect(plan('hype').beatSync).toBe(false) // beat sync needs music
    expect(plan('shorts', { presetId: 'youtube' }).presetId).toBe('shorts')
    expect(plan('clean', { presetId: 'youtube' }).presetId).toBe('youtube')
    for (const p of [cin, clean, hype]) {
      expect(p.clips.every((c) => c.speed === 1 && c.gain === 1)).toBe(true)
      checkPlan(p, [s])
    }
  })
})

describe('purity and empty states', () => {
  it('is deterministic and does not mutate its inputs', () => {
    const sources = [...shortSources(4), longMatch()]
    const o = opts({ targetSec: 60, style: 'hype', order: 'buildUp', musicPath: 'm.mp3' })
    const snapshot = JSON.stringify({ sources, o })
    const a = planAutoEdit(sources, o)
    const b = planAutoEdit(sources, o)
    expect(a).toEqual(b)
    expect(JSON.stringify({ sources, o })).toBe(snapshot)
    expect(planAutoEdit([...sources].reverse(), o)).toEqual(a)
  })

  it('reports noSources and noKills', () => {
    expect(planAutoEdit([], opts())).toMatchObject({ empty: 'noSources', clips: [], totalSec: 0 })
    const noKills = src('a.mp4', [ev(10, 'death'), ev(20, 'kill', { counted: false }), ev(30, 'kill', { deleted: true })])
    expect(planAutoEdit([noKills], opts())).toMatchObject({ empty: 'noKills', clips: [], totalSec: 0 })
  })
})
