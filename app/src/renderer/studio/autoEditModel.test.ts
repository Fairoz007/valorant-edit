import { describe, expect, test } from 'vitest'
import { AUTO_EDIT_TARGET_RANGE, DEFAULT_AUTO_EDIT_OPTIONS, STYLE_PRESETS, type AutoEditSource } from '../../shared/autoEdit'
import { planAutoEdit } from '../../shared/autoEditPlan'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import type { EngineEvent } from '../../shared/types'
import {
  buildOptions,
  createBlock,
  customTargetSec,
  defaultProjectName,
  effectBadges,
  effectivePreset,
  estimatePlan,
  formatForPreset,
  initialDraft,
  parseTargetText,
  resolveTarget,
  selectedSources,
  styleCap,
  styleSilencesSlowMo
} from './autoEditModel'

function kill(id: string, t: number): EngineEvent {
  return { id, t, type: 'kill', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto' }
}

function source(path: string, recordedAt: number, killTimes: number[]): AutoEditSource {
  return { path, durationSec: 600, recordedAt, events: killTimes.map((t, i) => kill(`${path}_${i}`, t)), hasAudio: true }
}

describe('draft → planner options', () => {
  test('defaults mirror DEFAULT_AUTO_EDIT_OPTIONS and every draft field reaches the options', () => {
    const d = { ...initialDraft(['D:/b.mp4', 'D:/a.mp4', 'D:/a.mp4']), includeDeaths: true, musicPath: '  D:/m.mp3 ', style: 'hype' as const, presetId: 'square' as const }
    expect(d.sources).toEqual(['D:/b.mp4', 'D:/a.mp4'])
    const o = buildOptions(d, { before: 5, after: 2, mergeGap: 3 })!
    expect(o).toEqual({
      ...DEFAULT_AUTO_EDIT_OPTIONS,
      sources: ['D:/b.mp4', 'D:/a.mp4'],
      targetSec: 60,
      includeDeaths: true,
      musicPath: 'D:/m.mp3',
      style: 'hype',
      presetId: 'square',
      before: 5,
      after: 2,
      mergeGap: 3
    })
    expect(buildOptions({ ...d, musicPath: '   ' })!.musicPath).toBeNull()
  })

  test('the planner gets the loaded sources in recording order', () => {
    const loaded = new Map([
      ['D:/late.mp4', source('D:/late.mp4', 2000, [30])],
      ['D:/early.mp4', source('D:/early.mp4', 1000, [40])]
    ])
    const d = initialDraft(['D:/late.mp4', 'D:/early.mp4', 'D:/missing.mp4'])
    const sources = selectedSources(d, loaded)
    expect(sources.map((s) => s.path)).toEqual(['D:/early.mp4', 'D:/late.mp4'])
    const plan = planAutoEdit(sources, buildOptions(d)!)
    expect(plan.clips.map((c) => c.source)).toEqual(['D:/early.mp4', 'D:/late.mp4'])
  })
})

describe('target length', () => {
  test('fixed targets pass through; "all" stays "all"', () => {
    expect(resolveTarget({ target: 30, customText: '' })).toBe(30)
    expect(resolveTarget({ target: 'all', customText: '' })).toBe('all')
    expect(resolveTarget({ target: 42, customText: '' })).toBeNull()
  })

  test('custom accepts seconds and m:ss within AUTO_EDIT_TARGET_RANGE only', () => {
    expect(parseTargetText('90')).toBe(90)
    expect(parseTargetText('90s')).toBe(90)
    expect(parseTargetText('1:30')).toBe(90)
    expect(parseTargetText('2m')).toBe(120)
    expect(parseTargetText('1m30s')).toBe(90)
    expect(parseTargetText('abc')).toBeNull()
    expect(parseTargetText('')).toBeNull()
    expect(parseTargetText('0')).toBeNull()
    expect(customTargetSec(String(AUTO_EDIT_TARGET_RANGE.min - 1))).toBeNull()
    expect(customTargetSec(String(AUTO_EDIT_TARGET_RANGE.min))).toBe(AUTO_EDIT_TARGET_RANGE.min)
    expect(customTargetSec(String(AUTO_EDIT_TARGET_RANGE.max))).toBe(AUTO_EDIT_TARGET_RANGE.max)
    expect(customTargetSec(String(AUTO_EDIT_TARGET_RANGE.max + 1))).toBeNull()
    expect(resolveTarget({ target: 'custom', customText: '1:30' })).toBe(90)
    expect(buildOptions({ ...initialDraft(['a']), target: 'custom', customText: '5' })).toBeNull()
  })
})

describe('Shorts override', () => {
  test('a style with a forced preset wins over the dialog choice, and the plan uses it', () => {
    expect(effectivePreset('shorts', 'youtube')).toEqual({ presetId: 'shorts', forced: true })
    expect(effectivePreset('clean', 'youtube')).toEqual({ presetId: 'youtube', forced: false })
    const d = { ...initialDraft(['D:/a.mp4']), style: 'shorts' as const, presetId: 'square' as const }
    const plan = planAutoEdit([source('D:/a.mp4', 0, [30])], buildOptions(d)!)
    expect(plan.presetId).toBe('shorts')
  })

  test('Shorts caps a longer or "all" target at its maxSec', () => {
    const max = STYLE_PRESETS.shorts.maxSec
    expect(styleCap('shorts', 'all')).toBe(max)
    expect(styleCap('shorts', 180)).toBe(max)
    expect(styleCap('shorts', 30)).toBeNull()
    expect(styleCap('clean', 'all')).toBeNull()
  })

  test('styles with slow motion say their slow parts are silent', () => {
    expect(styleSilencesSlowMo('cinematic')).toBe(true)
    expect(styleSilencesSlowMo('clean')).toBe(false)
  })
})

describe('estimate and empty state', () => {
  test('estimate: clip count, planned length and estimateOutputBytes of the output lengths', () => {
    const plan = planAutoEdit([source('D:/a.mp4', 0, [30, 120])], buildOptions(initialDraft(['D:/a.mp4']))!)
    const e = estimatePlan(plan)
    expect(e.clips).toBe(plan.clips.length)
    expect(e.clips).toBeGreaterThan(0)
    expect(e.totalSec).toBe(plan.totalSec)
    const items = plan.clips.map((c) => ({ source: c.source, start: 0, end: c.out - c.in }))
    expect(e.bytes).toBe(estimateOutputBytes({ items }, 'copy', new Map(), 'concat', formatForPreset('source')))
  })

  test('a reframing preset is estimated as a precise export', () => {
    const plan = planAutoEdit([source('D:/a.mp4', 0, [30])], buildOptions({ ...initialDraft(['D:/a.mp4']), presetId: 'square' })!)
    const items = plan.clips.map((c) => ({ source: c.source, start: 0, end: c.out - c.in }))
    expect(estimatePlan(plan).bytes).toBe(estimateOutputBytes({ items }, 'precise', new Map(), 'concat', formatForPreset('square')))
  })

  test('Create is blocked with a reason until there is something to montage', () => {
    const d = initialDraft(['D:/a.mp4'])
    const noKills = planAutoEdit([source('D:/a.mp4', 0, [])], buildOptions(d)!)
    expect(noKills.empty).toBe('noKills')
    expect(createBlock({ draft: d, loading: false, plan: noKills, busy: false })).toBe('noKills')
    expect(createBlock({ draft: initialDraft([]), loading: false, plan: null, busy: false })).toBe('noSelection')
    expect(createBlock({ draft: d, loading: true, plan: null, busy: false })).toBe('loading')
    expect(createBlock({ draft: { ...d, target: 'custom', customText: 'x' }, loading: false, plan: null, busy: false })).toBe('invalidTarget')
    const ok = planAutoEdit([source('D:/a.mp4', 0, [30])], buildOptions(d)!)
    expect(createBlock({ draft: d, loading: false, plan: ok, busy: false })).toBeNull()
    expect(createBlock({ draft: d, loading: false, plan: ok, busy: true })).toBe('busy')
  })

  test('default project name fills style and local date', () => {
    expect(defaultProjectName('Auto edit · {style} · {date}', 'Hype', new Date(2026, 10, 5, 9, 7))).toBe('Auto edit · Hype · 2026-11-05 09:07')
  })
})

describe('effect badges', () => {
  test('plain items have none; styled items list slow-mo, zoom, flash, caption, speed and transition in order', () => {
    expect(effectBadges({})).toEqual([])
    expect(effectBadges({ speed: 1, transitionIn: 'cut' })).toEqual([])
    expect(
      effectBadges({
        effects: [
          { kind: 'flash', at: 3, durationSec: 0.1 },
          { kind: 'zoomPunch', at: 3, durationSec: 0.3, scale: 1.2 },
          { kind: 'slowmo', at: 3, durationSec: 0.6, speed: 0.5 }
        ],
        overlay: { text: 'DOUBLE KILL', at: 3, durationSec: 1 },
        speed: 1.5,
        transitionIn: 'dipWhite'
      })
    ).toEqual([
      { kind: 'slowmo', value: '0.5' },
      { kind: 'zoomPunch' },
      { kind: 'flash' },
      { kind: 'caption', text: 'DOUBLE KILL' },
      { kind: 'speed', text: '×1.5', value: '1.5' },
      { kind: 'transition', value: 'dipWhite' }
    ])
  })
})
