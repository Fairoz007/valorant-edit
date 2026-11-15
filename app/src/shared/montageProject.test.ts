import { describe, it, expect } from 'vitest'
import { buildMontageProject } from './montageProject'
import { selectMontageClips } from './montage'
import { PROJECT_VERSION, projectShapeError } from '../renderer/editor/project'
import type { Clip, EngineEvent } from './types'

const clip = (id: string, start: number, end: number): Clip => ({ id, start, end, origin: 'ai', event_ids: [], status: 'suggested' })
const base = { projectId: 'p_m_0123456789abcdef', name: 'Montage – Valorant_2026-11-15_21-08', sourcePath: 'C:\\Videos\\Valorant.mp4' }

describe('buildMontageProject', () => {
  it('builds a valid empty project for no clips', () => {
    const p = buildMontageProject({ ...base, clips: [] })
    expect(p).toEqual({ id: base.projectId, version: PROJECT_VERSION, name: base.name, items: [] })
    expect(p.version).toBe(2)
    expect(projectShapeError(p)).toBeNull()
  })

  it('writes one item per clip in order with <projectId>_i<n> ids and clipId links', () => {
    const p = buildMontageProject({ ...base, clips: [clip('c1', 10, 15), clip('c2', 40, 47.5)] })
    expect(p.items).toEqual([
      { id: `${base.projectId}_i0`, source: base.sourcePath, start: 10, end: 15, clipId: 'c1' },
      { id: `${base.projectId}_i1`, source: base.sourcePath, start: 40, end: 47.5, clipId: 'c2' }
    ])
    expect(projectShapeError(p)).toBeNull()
  })

  it('leaves out clips with invalid ranges and keeps item numbering continuous', () => {
    const clips = [clip('bad1', Number.NaN, 5), clip('ok1', 1, 2), clip('bad2', 5, 5), clip('bad3', 9, 3), clip('ok2', 20, Number.POSITIVE_INFINITY), clip('ok3', 30, 31)]
    const p = buildMontageProject({ ...base, clips })
    expect(p.items.map((i) => [i.id, i.clipId])).toEqual([
      [`${base.projectId}_i0`, 'ok1'],
      [`${base.projectId}_i1`, 'ok3']
    ])
    expect(projectShapeError(p)).toBeNull()
  })

  it('omits clipId for a clip without id and writes no items without a source path', () => {
    const p = buildMontageProject({ ...base, clips: [clip('', 1, 2)] })
    expect(p.items).toEqual([{ id: `${base.projectId}_i0`, source: base.sourcePath, start: 1, end: 2 }])
    expect(projectShapeError(p)).toBeNull()
    const noSrc = buildMontageProject({ ...base, sourcePath: '', clips: [clip('c1', 1, 2)] })
    expect(noSrc.items).toEqual([])
    expect(projectShapeError(noSrc)).toBeNull()
  })

  it('does not mutate its input', () => {
    const clips = Object.freeze([clip('c1', 10, 15)]) as Clip[]
    const snapshot = JSON.parse(JSON.stringify(clips))
    buildMontageProject({ ...base, clips })
    expect(clips).toEqual(snapshot)
  })

  it('accepts the output of selectMontageClips', () => {
    const kill = (id: string, t: number): EngineEvent => ({
      id,
      t,
      type: 'kill',
      score: 1,
      damage_line: false,
      name_sig: null,
      counted: true,
      counted_reason: '',
      counted_override: null,
      source: 'auto'
    })
    const sel = selectMontageClips([kill('k1', 0), kill('k2', 50), kill('k3', 51), kill('k4', 120)], [], {
      montage: { minClips: 2, maxDurationSec: 90, include: { multiKills: true, aces: true, clutches: true, singleKills: true } },
      autoclip: { gap: 4, n: 10, before: 3, after: 2, max_len: 30 },
      videoDurationSec: 121
    })
    const p = buildMontageProject({ ...base, clips: sel.clips })
    expect(p.items.map((i) => i.clipId)).toEqual(sel.clips.map((c) => c.id))
    expect(p.items).toHaveLength(3)
    expect(projectShapeError(p)).toBeNull()
  })
})
