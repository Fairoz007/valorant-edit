import { describe, it, expect } from 'vitest'
import { selectMontageClips, type MontageInclude, type MontageSelectInput, type MontageSelection } from './montage'
import type { AutoClipParams, Clip, EngineEvent, Round } from './types'

const ev = (id: string, t: number, type = 'kill', extra: Partial<EngineEvent> = {}): EngineEvent => ({
  id,
  t,
  type,
  score: 1,
  damage_line: false,
  name_sig: null,
  counted: true,
  counted_reason: '',
  counted_override: null,
  source: 'auto',
  ...extra
})
const kill = (id: string, t: number, extra: Partial<EngineEvent> = {}): EngineEvent => ev(id, t, 'kill', extra)
const death = (id: string, t: number): EngineEvent => ev(id, t, 'death')
const clip = (id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  start,
  end,
  origin: 'ai',
  event_ids: [],
  status: 'accepted',
  ...extra
})

const ALL: MontageInclude = { multiKills: true, aces: true, clutches: true, singleKills: true }
const AUTOCLIP: AutoClipParams = { gap: 4, n: 10, before: 3, after: 2, max_len: 30 }

function input(over: {
  include?: Partial<MontageInclude>
  minClips?: number
  maxDurationSec?: number
  autoclip?: Partial<AutoClipParams>
  videoDurationSec?: number
  rounds?: Round[]
} = {}): MontageSelectInput {
  return {
    montage: {
      minClips: over.minClips ?? 1,
      maxDurationSec: over.maxDurationSec ?? 300,
      include: { ...ALL, ...over.include }
    },
    autoclip: { ...AUTOCLIP, ...over.autoclip },
    videoDurationSec: over.videoDurationSec ?? 1000,
    ...(over.rounds ? { rounds: over.rounds } : {})
  }
}

/** Invariants every non-skipped selection must hold. */
function expectWellFormed(sel: MontageSelection, dur: number): void {
  expect(sel.skipped).toBeUndefined()
  expect(sel.clips.length).toBeGreaterThan(0)
  let sum = 0
  for (const [i, c] of sel.clips.entries()) {
    expect(c.start).toBeGreaterThanOrEqual(0)
    expect(c.end).toBeLessThanOrEqual(dur)
    expect(c.end).toBeGreaterThan(c.start)
    if (i > 0) expect(c.start).toBeGreaterThanOrEqual(sel.clips[i - 1].end + 0.5)
    sum += c.end - c.start
  }
  expect(sel.totalSec).toBeCloseTo(sum, 9)
  expect(new Set(sel.clips.map((c) => c.id)).size).toBe(sel.clips.length)
}

const ranges = (sel: MontageSelection): Array<[number, number]> => sel.clips.map((c) => [c.start, c.end])

/** single at 100, 2k at 200, 3k at 300, ace at 400 (rounds unknown). */
const MIXED: EngineEvent[] = [
  kill('s1', 100),
  kill('d1', 200),
  kill('d2', 201),
  kill('t1', 300),
  kill('t2', 301),
  kill('t3', 302),
  ...[0, 1, 2, 3, 4].map((i) => kill(`a${i}`, 400 + i))
]

describe('selectMontageClips: empty and too few', () => {
  it('is empty with 0 kills, even with existing clips', () => {
    expect(selectMontageClips([], [], input())).toEqual({ clips: [], totalSec: 0, skipped: 'empty' })
    expect(selectMontageClips([], [clip('c1', 10, 20)], input())).toEqual({ clips: [], totalSec: 0, skipped: 'empty' })
  })

  it('is empty with only deaths and other non-kill events', () => {
    const events = [death('x1', 50), death('x2', 120), ev('sp', 130, 'spike_plant')]
    expect(selectMontageClips(events, [], input())).toEqual({ clips: [], totalSec: 0, skipped: 'empty' })
  })

  it('is empty when every kind is excluded', () => {
    const none = { multiKills: false, aces: false, clutches: false, singleKills: false }
    expect(selectMontageClips(MIXED, [], input({ include: none })).skipped).toBe('empty')
  })

  it('is tooFew for 1 kill with minClips 2, and picks it with minClips 1', () => {
    const events = [kill('k1', 100)]
    expect(selectMontageClips(events, [], input({ minClips: 2 }))).toEqual({ clips: [], totalSec: 0, skipped: 'tooFew' })
    const sel = selectMontageClips(events, [], input({ minClips: 1 }))
    expectWellFormed(sel, 1000)
    expect(sel.clips).toEqual([{ id: 'mt_97000', start: 97, end: 102, origin: 'ai', event_ids: ['k1'], status: 'suggested' }])
    expect(sel.totalSec).toBe(5)
  })

  it('counts clips after merging for minClips', () => {
    // Two singles whose windows touch become one clip: still too few for minClips 2.
    const events = [kill('k1', 100), kill('k2', 105)]
    expect(selectMontageClips(events, [], input({ minClips: 2 })).skipped).toBe('tooFew')
  })
})

describe('selectMontageClips: include filter', () => {
  it('keeps only the included kinds', () => {
    const pick = (include: Partial<MontageInclude>) =>
      selectMontageClips(MIXED, [], input({ include: { multiKills: false, aces: false, clutches: false, singleKills: false, ...include } }))
    expect(ranges(pick({ singleKills: true }))).toEqual([[97, 102]])
    expect(ranges(pick({ multiKills: true }))).toEqual([
      [197, 203],
      [297, 304]
    ])
    expect(ranges(pick({ aces: true }))).toEqual([[397, 406]])
    expect(pick({ aces: true, singleKills: true }).clips.map((c) => c.event_ids)).toEqual([['s1'], ['a0', 'a1', 'a2', 'a3', 'a4']])
    const all = selectMontageClips(MIXED, [], input())
    expectWellFormed(all, 1000)
    expect(all.clips).toHaveLength(4)
  })

  describe('clutches', () => {
    // Round won by the player's team, player alive, 2k closing the round out (9 s before its end) → clutch.
    const won: Round[] = [{ start: 190, end: 210, winner: 'ally', ally: 1, enemy: 0 }]
    const lost: Round[] = [{ start: 190, end: 210, winner: 'enemy', ally: 0, enemy: 1 }]
    const events = [kill('c1', 200), kill('c2', 201)]
    const off = { multiKills: false, aces: false, clutches: false, singleKills: false }

    it('clutches alone include clutch rounds but not plain 2ks', () => {
      expect(selectMontageClips(events, [], input({ include: { ...off, clutches: true }, rounds: won })).clips).toHaveLength(1)
      expect(selectMontageClips(events, [], input({ include: { ...off, clutches: true }, rounds: lost })).skipped).toBe('empty')
    })

    it('a clutch also counts as a 2k: turning off clutches alone keeps it as a multikill', () => {
      const sel = selectMontageClips(events, [], input({ include: { ...off, multiKills: true }, rounds: won }))
      expect(sel.clips.map((c) => c.event_ids)).toEqual([['c1', 'c2']])
      expect(selectMontageClips(events, [], input({ include: { ...ALL, clutches: false }, rounds: won })).clips).toHaveLength(1)
    })

    it('is excluded when both clutches and multiKills are off', () => {
      expect(selectMontageClips(events, [], input({ include: { ...ALL, clutches: false, multiKills: false }, rounds: won })).skipped).toBe('empty')
    })
  })
})

describe('selectMontageClips: windows and merging', () => {
  it('never splits a multikill and uses autoclip before/after', () => {
    const events = [kill('k1', 100), kill('k2', 103), kill('k3', 106.5)]
    const sel = selectMontageClips(events, [], input({ autoclip: { before: 4, after: 1 }, include: { singleKills: false } }))
    expect(sel.clips).toEqual([{ id: 'mt_96000', start: 96, end: 107.5, origin: 'ai', event_ids: ['k1', 'k2', 'k3'], status: 'suggested' }])
  })

  it('falls back to the default merge gap when autoclip.gap is not a positive number', () => {
    const events = [kill('k1', 100), kill('k2', 103.5)]
    const singlesOnly = { multiKills: false, aces: false, clutches: false }
    // Gap 1: two singles. Gap 0 / NaN / negative: default 4 s → one 2k, which singles-only excludes.
    expect(selectMontageClips(events, [], input({ autoclip: { gap: 1 }, include: singlesOnly })).skipped).toBeUndefined()
    for (const gap of [0, Number.NaN, -2, Number.POSITIVE_INFINITY]) {
      expect(selectMontageClips(events, [], input({ autoclip: { gap }, include: singlesOnly })).skipped).toBe('empty')
    }
  })

  it('merges overlapping and adjacent (< 0.5 s) ranges, keeps 0.5 s gaps apart', () => {
    // Windows [97,102] and [102,107] touch → one clip.
    const touch = selectMontageClips([kill('k1', 100), kill('k2', 105)], [], input())
    expect(touch.clips).toEqual([{ id: 'mt_97000', start: 97, end: 107, origin: 'ai', event_ids: ['k1', 'k2'], status: 'suggested' }])
    // [97,102] and [102.3,107.3]: 0.3 s apart → joined.
    expect(ranges(selectMontageClips([kill('k1', 100), kill('k2', 105.3)], [], input()))).toEqual([[97, 107.3]])
    // [97,102] and [102.6,107.6]: 0.6 s apart → two clips.
    const apart = selectMontageClips([kill('k1', 100), kill('k2', 105.6)], [], input())
    expectWellFormed(apart, 1000)
    expect(ranges(apart)).toEqual([
      [97, 102],
      [102.6, 107.6]
    ])
  })

  it('clamps kills at second 0 and at the last second', () => {
    const sel = selectMontageClips([kill('k0', 0), kill('kEnd', 600), kill('late', 600.5)], [], input({ videoDurationSec: 600 }))
    expectWellFormed(sel, 600)
    expect(ranges(sel)).toEqual([
      [0, 2],
      [597, 600]
    ])
    expect(sel.clips[0].id).toBe('mt_0')
    expect(sel.clips[1].event_ids).toEqual(['kEnd'])
  })

  it('handles overtime (rounds > 24): no window crosses a round boundary, clutches detected late', () => {
    const rounds: Round[] = Array.from({ length: 28 }, (_, i) => ({
      start: i * 40,
      end: i * 40 + 39,
      winner: i === 26 ? 'ally' : 'enemy',
      ally: 0,
      enemy: 0
    }))
    // Last second of round 25 (index 24) and first second of round 26: 2 s apart but different rounds → not a 2k.
    const boundary = [kill('b1', 999), kill('b2', 1001)]
    expect(selectMontageClips(boundary, [], input({ rounds, videoDurationSec: 1200, include: { singleKills: false } })).skipped).toBe('empty')
    const singles = selectMontageClips(boundary, [], input({ rounds, videoDurationSec: 1200 }))
    expectWellFormed(singles, 1200)
    expect(singles.clips.flatMap((c) => c.event_ids)).toEqual(['b1', 'b2'])
    // Round 27 (index 26, overtime) won by allies: a 2k 6 s before its end is a clutch.
    const ot = [kill('o1', 1071), kill('o2', 1073)]
    const off = { multiKills: false, aces: false, clutches: true, singleKills: false }
    expect(selectMontageClips(ot, [], input({ rounds, videoDurationSec: 1200, include: off })).clips).toHaveLength(1)
  })

  it('ignores deleted and uncounted kills', () => {
    const ignored = [kill('del', 100, { deleted: true }), kill('unc', 101, { counted: false }), kill('nan', Number.NaN)]
    expect(selectMontageClips(ignored, [], input())).toEqual({ clips: [], totalSec: 0, skipped: 'empty' })
    // With one live kill they do not turn it into a 3k.
    const sel = selectMontageClips([...ignored, kill('live', 102)], [], input({ include: { singleKills: false } }))
    expect(sel.skipped).toBe('empty')
    expect(selectMontageClips([...ignored, kill('live', 102)], [], input()).clips.map((c) => c.event_ids)).toEqual([['live']])
  })
})

describe('selectMontageClips: existing clips', () => {
  const events = [kill('k1', 100)]

  it('reuses an overlapping accepted clip: union range, id/origin/status kept', () => {
    const existing = clip('c_acc', 95, 101, { event_ids: ['k1'] })
    const sel = selectMontageClips(events, [existing], input())
    expect(sel.clips).toEqual([{ id: 'c_acc', start: 95, end: 102, origin: 'ai', event_ids: ['k1'], status: 'accepted' }])
    expect(sel.totalSec).toBe(7)
  })

  it('treats a clip without status as accepted and reuses manual clips', () => {
    const legacy = clip('c_old', 98, 110)
    delete legacy.status
    expect(selectMontageClips(events, [legacy], input()).clips).toEqual([{ id: 'c_old', start: 97, end: 110, origin: 'ai', event_ids: ['k1'] }])
    const manual = clip('c_man', 99, 104, { origin: 'manual', event_ids: ['other'] })
    expect(selectMontageClips(events, [manual], input()).clips).toEqual([
      { id: 'c_man', start: 97, end: 104, origin: 'manual', event_ids: ['k1', 'other'], status: 'accepted' }
    ])
  })

  it('reuses AI suggested clips', () => {
    const sug = clip('c_sug', 96, 101, { status: 'suggested', event_ids: ['k1'] })
    expect(selectMontageClips(events, [sug], input()).clips).toEqual([
      { id: 'c_sug', start: 96, end: 102, origin: 'ai', event_ids: ['k1'], status: 'suggested' }
    ])
  })

  it('never reuses skipped clips; a window only partly covered by a skipped clip is still eligible', () => {
    const skipped = clip('mt_97000', 90, 99, { status: 'skipped' })
    const sel = selectMontageClips(events, [skipped], input())
    // New id avoids colliding with the skipped clip that already has the deterministic id.
    expect(sel.clips).toEqual([{ id: 'mt_97000_2', start: 97, end: 102, origin: 'ai', event_ids: ['k1'], status: 'suggested' }])
  })

  it('leaves out a window whose kills all lie inside a clip the user skipped', () => {
    const skipped = clip('c_skip', 90, 120, { status: 'skipped' })
    expect(selectMontageClips(events, [skipped], input())).toEqual({ clips: [], totalSec: 0, skipped: 'empty' })
  })

  it('prefers manual over accepted over suggested when several clips meet in one montage clip', () => {
    const clips = [
      clip('c_sug', 96, 99, { status: 'suggested' }),
      clip('c_acc', 101, 103),
      clip('c_man', 100.5, 104, { origin: 'manual', event_ids: ['m'] })
    ]
    const sel = selectMontageClips(events, clips, input())
    expect(sel.clips).toEqual([{ id: 'c_man', start: 96, end: 104, origin: 'manual', event_ids: ['k1', 'm'], status: 'accepted' }])
    const noManual = selectMontageClips(events, clips.slice(0, 2), input())
    expect(noManual.clips.map((c) => [c.id, c.status])).toEqual([['c_acc', 'accepted']])
  })

  it('leaves out existing clips that overlap no eligible window and clamps reused ones', () => {
    const clips = [clip('far', 500, 520), clip('wide', -10, 99, { origin: 'manual' }), clip('bad', Number.NaN, 5)]
    const sel = selectMontageClips([kill('k0', 1), kill('k1', 100)], clips, input({ videoDurationSec: 300 }))
    expectWellFormed(sel, 300)
    expect(sel.clips.map((c) => [c.id, c.start, c.end])).toEqual([['wide', 0, 102]])
  })

  it('ignores stale AI suggestions but reuses stale accepted clips (flag kept)', () => {
    const staleSug = clip('st_sug', 90, 101, { status: 'suggested', stale: true })
    expect(selectMontageClips(events, [staleSug], input()).clips).toEqual([
      { id: 'mt_97000', start: 97, end: 102, origin: 'ai', event_ids: ['k1'], status: 'suggested' }
    ])
    const staleAcc = clip('st_acc', 90, 101, { stale: true, event_ids: ['gone'] })
    expect(selectMontageClips(events, [staleAcc], input()).clips).toEqual([
      { id: 'st_acc', start: 90, end: 102, origin: 'ai', event_ids: ['k1', 'gone'], status: 'accepted', stale: true }
    ])
  })
})

describe('selectMontageClips: duration cap', () => {
  /** 25 kills, groups 60 s apart: ace, 4k, 3k, 3k, 2k, 2k, 2k, 4 singles (kills 1 s apart inside a group). */
  function stomp(): EngineEvent[] {
    const sizes = [5, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1]
    // Shuffle group order in time so the best windows are not simply the first ones.
    const order = [3, 7, 0, 9, 5, 1, 8, 4, 10, 2, 6]
    const out: EngineEvent[] = []
    order.forEach((g, slot) => {
      for (let i = 0; i < sizes[g]; i++) out.push(kill(`g${g}_${i}`, 30 + slot * 60 + i))
    })
    return out
  }

  it('keeps the highest-value windows, whole, under the cap', () => {
    const events = stomp()
    expect(events).toHaveLength(25)
    const sel = selectMontageClips(events, [], input({ maxDurationSec: 30, videoDurationSec: 900 }))
    expectWellFormed(sel, 900)
    expect(sel.totalSec).toBeLessThanOrEqual(30)
    // Ace (9 s) + 4k (8 s) + the earlier 3k (7 s) = 24 s; the later 3k would make 31 s.
    const groups = sel.clips.map((c) => c.event_ids[0].split('_')[0])
    expect([...groups].sort()).toEqual(['g0', 'g1', 'g3'])
    expect(sel.totalSec).toBe(24)
    for (const c of sel.clips) {
      const g = Number(c.event_ids[0].split('_')[0].slice(1))
      const kills = events.filter((e) => e.id.startsWith(`g${g}_`))
      expect(c.event_ids).toEqual(kills.map((e) => e.id))
      expect(c.start).toBeLessThanOrEqual(kills[0].t - 3)
      expect(c.end).toBeGreaterThanOrEqual(kills[kills.length - 1].t + 2)
    }
  })

  it('is deterministic and does not mutate its inputs', () => {
    const events = stomp()
    const clips = [clip('keep', 88, 92, { origin: 'manual' }), clip('skip', 200, 210, { status: 'skipped' })]
    const settings = input({ maxDurationSec: 45, videoDurationSec: 900 })
    const snapshot = JSON.parse(JSON.stringify({ events, clips, settings }))
    Object.freeze(events)
    Object.freeze(clips)
    const a = selectMontageClips(events, clips, settings)
    const b = selectMontageClips(events, clips, settings)
    expect(a).toEqual(b)
    expect({ events, clips, settings }).toEqual(snapshot)
    // Event order in the input does not matter either.
    expect(selectMontageClips([...events].reverse(), clips, settings)).toEqual(a)
    expect(a.clips).not.toBe(b.clips)
  })

  it('trims the pre/post roll of a single best window over the cap', () => {
    // Ace with kills 3 s apart: window [97, 114] = 17 s, cap 15 → 1 s off each side.
    const ace = [0, 3, 6, 9, 12].map((d, i) => kill(`a${i}`, 100 + d))
    const sel = selectMontageClips([...ace, kill('s', 300)], [], input({ maxDurationSec: 15 }))
    expect(ranges(sel)).toEqual([[98, 113]])
    expect(sel.totalSec).toBe(15)
    expect(sel.clips[0].event_ids).toHaveLength(5)
  })

  it('keeps a kill span longer than the cap whole (trimmed to 0.5 s around the kills)', () => {
    const ace = [0, 4, 8, 12, 16, 20].map((d, i) => kill(`a${i}`, 100 + d))
    const sel = selectMontageClips(ace, [], input({ maxDurationSec: 15 }))
    expect(ranges(sel)).toEqual([[99.5, 120.5]])
    expect(sel.totalSec).toBe(21)
  })

  it('can turn a capped selection into tooFew', () => {
    const events = [...[0, 1, 2, 3, 4].map((i) => kill(`a${i}`, 100 + i)), kill('s', 300)]
    expect(selectMontageClips(events, [], input({ maxDurationSec: 10, minClips: 2 })).skipped).toBe('tooFew')
    expect(selectMontageClips(events, [], input({ maxDurationSec: 20, minClips: 2 })).clips).toHaveLength(2)
  })

  it('treats a non-finite or non-positive cap as no cap', () => {
    for (const maxDurationSec of [Number.NaN, 0]) {
      expect(selectMontageClips(MIXED, [], input({ maxDurationSec })).clips).toHaveLength(4)
    }
  })
})
