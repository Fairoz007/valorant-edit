import { describe, it, expect } from 'vitest'
import { clipOutputSec, MONTAGE_STYLES, planTotalSec, STYLE_PRESETS, TRANSITION_RANGE, type AutoEditClip, type AutoEditPlan } from './autoEdit'
import { autoEditToProject, projectHasStyling, validProjectItemStyle, validProjectStyle } from './autoEditProject'
import { createProject, migrateProject, PROJECT_VERSION, projectShapeError } from '../renderer/editor/project'

const clip = (over: Partial<AutoEditClip> = {}): AutoEditClip => ({
  id: 'ae_0', source: 'C:\\Users\\Jane Doe\\Videos\\a.mp4', in: 10, out: 14, speed: 1, gain: 1, effects: [], overlay: null,
  transitionIn: 'cut', transitionSec: 0, score: 25, kind: '2k', eventIds: ['e1', 'e2'], ...over
})

describe('style presets', () => {
  it('defines every style with consistent data', () => {
    expect(Object.keys(STYLE_PRESETS).sort()).toEqual([...MONTAGE_STYLES].sort())
    for (const s of MONTAGE_STYLES) {
      const p = STYLE_PRESETS[s]
      expect(p.id).toBe(s)
      if (p.transition === 'cut') expect(p.transitionSec).toBe(0)
      else {
        expect(p.transitionSec).toBeGreaterThanOrEqual(TRANSITION_RANGE.min)
        expect(p.transitionSec).toBeLessThanOrEqual(TRANSITION_RANGE.max)
      }
    }
    expect(STYLE_PRESETS.clean).toMatchObject({ transition: 'cut', overlays: false, slowMo: null, zoomPunch: null, flash: false })
    expect(STYLE_PRESETS.cinematic).toMatchObject({ transition: 'dipBlack', letterbox: true })
    expect(STYLE_PRESETS.hype).toMatchObject({ transition: 'dipWhite' })
    expect(STYLE_PRESETS.cinematic.slowMo).not.toBeNull()
    expect(STYLE_PRESETS.hype).toMatchObject({ beatSync: true, flash: true })
    expect(STYLE_PRESETS.hype.zoomPunch).not.toBeNull()
    expect(STYLE_PRESETS.shorts).toMatchObject({ presetId: 'shorts', maxSec: 60 })
  })
})

describe('planned length', () => {
  it('divides by speed and stretches slow-mo windows', () => {
    expect(clipOutputSec(clip())).toBe(4)
    expect(clipOutputSec(clip({ speed: 2 }))).toBe(2)
    expect(clipOutputSec(clip({ effects: [{ kind: 'slowmo', at: 12, durationSec: 0.6, speed: 0.5 }] }))).toBeCloseTo(4.6, 10)
    // A slow-mo window at the clip edge only stretches the part inside the clip.
    expect(clipOutputSec(clip({ effects: [{ kind: 'slowmo', at: 14, durationSec: 0.6, speed: 0.5 }] }))).toBeCloseTo(4.3, 10)
  })

  it('dip transitions do not change the length; cards are added', () => {
    const clips = [clip({ transitionIn: 'dipBlack', transitionSec: 0.5 }), clip({ id: 'ae_1', transitionIn: 'dipWhite', transitionSec: 0.5 }), clip({ id: 'ae_2' })]
    expect(planTotalSec(clips, null, null)).toBeCloseTo(12, 10)
    expect(planTotalSec(clips, { text: 'x', durationSec: 2, background: 'black' }, { text: 'y', durationSec: 1.5, background: 'blurFrame' })).toBeCloseTo(15.5, 10)
  })
})

describe('project schema v2', () => {
  it('new projects are v2, v1 migrates and stays valid, newer is unsupported', () => {
    expect(createProject('x').version).toBe(PROJECT_VERSION)
    expect(PROJECT_VERSION).toBe(2)
    const v1 = { version: 1 as const, name: 'old', items: [{ id: 'a', source: 'C:/a.mp4', start: 0, end: 1, clipId: 'c' }] }
    const m = migrateProject(v1)
    expect(m).toEqual({ ...v1, version: 2 })
    expect(migrateProject(m)).toEqual(m)
    expect(projectShapeError(v1)).toBeNull()
    expect(projectShapeError(m)).toBeNull()
    expect(projectShapeError({ version: 3, name: 'f', items: [] })).toMatchObject({ kind: 'unsupported' })
    expect(migrateProject({ version: 3 })).toEqual({ version: 3 })
  })

  it('validates the optional v2 item and project fields', () => {
    expect(validProjectItemStyle({})).toBe(true)
    expect(validProjectItemStyle({ speed: 0.25, gain: 2, transitionIn: 'dipWhite', transitionSec: 0.6 })).toBe(true)
    for (const bad of [{ speed: 0 }, { speed: 3 }, { gain: -1 }, { transitionIn: 'wipe' }, { transitionIn: 'crossfade' }, { effects: [{ kind: 'spin', at: 1, durationSec: 1 }] },
      { effects: [{ kind: 'slowmo', at: 1, durationSec: 1, speed: 2 }] }, { overlay: { text: '', at: 0, durationSec: 1 } }, { effects: 'x' }]) {
      expect(validProjectItemStyle(bad)).toBe(false)
    }
    expect(validProjectStyle({ style: 'cinematic', letterbox: false })).toBe(true)
    expect(validProjectStyle({ style: 'retro' })).toBe(false)
    expect(validProjectStyle({ presetId: 'shorts' })).toBe(true)
    expect(validProjectStyle({ presetId: 'source' })).toBe(true)
    expect(validProjectStyle({ presetId: 'vhs' })).toBe(false)
    expect(validProjectStyle({ music: { path: '', gain: 0.5, duck: true, fadeInSec: 0, fadeOutSec: 0 } })).toBe(false)
    expect(validProjectStyle({ intro: { text: 'Hi', durationSec: 2, background: 'pink' } })).toBe(false)
    expect(projectShapeError({ version: 2, name: 'n', items: [{ id: 'a', source: 's', start: 0, end: 1, speed: 5 }] })).toMatchObject({ kind: 'format' })
  })
})

describe('autoEditToProject', () => {
  it('maps clips to items in order, omitting defaults and the first transition', () => {
    const plan: AutoEditPlan = {
      style: 'cinematic', presetId: 'youtube', totalSec: 0, letterbox: true, beatSync: false, warnings: [],
      music: { path: 'C:\\Music\\a.mp3', gain: 0.4, duck: true, fadeInSec: 1, fadeOutSec: 1 },
      intro: { text: 'Match', durationSec: 2, background: 'blurFrame' }, outro: null,
      clips: [
        clip({ transitionIn: 'dipBlack', transitionSec: 0.5 }),
        clip({ id: 'ae_1', in: 30, out: 36, speed: 0.75, gain: 1.2, transitionIn: 'dipBlack', transitionSec: 0.5,
          effects: [{ kind: 'slowmo', at: 34, durationSec: 0.6, speed: 0.5 }], overlay: { text: 'TRIPLE KILL', at: 34, durationSec: 1.5 } })
      ]
    }
    const p = autoEditToProject(plan, 'p_ae1', 'Auto edit')
    expect(p).toMatchObject({ id: 'p_ae1', version: 2, name: 'Auto edit', style: 'cinematic', presetId: 'youtube', letterbox: true, intro: plan.intro, music: plan.music })
    expect(p.outro).toBeUndefined()
    expect(p.items).toEqual([
      { id: 'p_ae1_ae0', source: plan.clips[0].source, start: 10, end: 14 },
      { id: 'p_ae1_ae1', source: plan.clips[1].source, start: 30, end: 36, speed: 0.75, gain: 1.2, effects: plan.clips[1].effects,
        overlay: plan.clips[1].overlay, transitionIn: 'dipBlack', transitionSec: 0.5 }
    ])
    expect(projectShapeError(p)).toBeNull()
    expect(projectHasStyling(p)).toBe(true)
    expect(projectHasStyling(createProject('plain', [{ id: 'a', source: 's', start: 0, end: 1 }]))).toBe(false)
  })
})
