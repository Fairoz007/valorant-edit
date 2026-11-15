import { describe, expect, it } from 'vitest'
import {
  BUY_PHASE_AFTER_ROUND_END_SEC, BUY_PHASE_CUT_SEC, GAMEPLAY_PRE_PAD_SEC, LOADING_MAX_SEC,
  gameplayStart, inferredMatches, liveEventTimes, liveRounds, withoutBuyPhases, type LiveRound
} from './gameplay'

const round = (start: number, end: number, ally = 1, enemy = 0): LiveRound => ({ start, end, winner: 'ally', ally, enemy })

describe('gameplay start (loading screen cut)', () => {
  // Riot Client: INGAME (loading screen) at 80 s; the HUD score first shows at 130 s (round 1 buy phase).
  const match = { start: 80, end: 360 }

  it('starts at the first HUD frame, not at the loading screen', () => {
    expect(gameplayStart(match, [round(130, 230), round(230, 330, 1, 1)], [])).toBe(130 - GAMEPLAY_PRE_PAD_SEC)
  })

  it('never starts after a detected kill or death', () => {
    expect(gameplayStart(match, [round(130, 230)], [127])).toBe(122)
  })

  it('keeps the match start when the evidence is missing or implausible', () => {
    expect(gameplayStart(match, [], [])).toBe(80)
    // A first HUD sighting long after INGAME means detection missed the real start.
    expect(gameplayStart(match, [round(80 + LOADING_MAX_SEC + 1, 400)], [])).toBe(80)
    // Rounds of an earlier match are ignored.
    expect(gameplayStart(match, [round(10, 70)], [])).toBe(80)
    // The HUD already showing at the match start (a reconnect) leaves nothing to trim.
    expect(gameplayStart(match, [round(60, 140)], [])).toBe(80)
  })
})

describe('buy phase cuts (trimBuyPhase)', () => {
  it('cuts the buy phase after every round but the last', () => {
    const kept = withoutBuyPhases({ start: 128, end: 365 }, [round(130, 230), round(230, 330, 1, 1), round(330, 355, 2, 1)], [175, 300])
    const cut1 = 230 + BUY_PHASE_AFTER_ROUND_END_SEC
    expect(kept).toEqual([
      { start: 128, end: cut1 },
      { start: cut1 + BUY_PHASE_CUT_SEC, end: 330 + BUY_PHASE_AFTER_ROUND_END_SEC },
      // The last cut is shortened so it never reaches into the next round's end (355 - 1).
      { start: 354, end: 365 }
    ])
  })

  it('never cuts across a detected event', () => {
    expect(withoutBuyPhases({ start: 0, end: 400 }, [round(130, 230), round(230, 330)], [245])).toEqual([{ start: 0, end: 400 }])
  })

  it('keeps everything without rounds', () => {
    expect(withoutBuyPhases({ start: 0, end: 100 }, [], [])).toEqual([{ start: 0, end: 100 }])
  })
})

describe('inferred matches (Riot Client unreachable)', () => {
  it('pads rounds and events generously and merges them', () => {
    expect(inferredMatches([round(130, 230), round(230, 330)], [175], 1000)).toEqual([{ start: 40, end: 390 }])
  })

  it('splits two matches separated by a long menu stretch', () => {
    expect(inferredMatches([round(100, 200), round(900, 1000)], [], 1200)).toEqual([{ start: 10, end: 260 }, { start: 810, end: 1060 }])
  })

  it('returns nothing without evidence (the caller then keeps everything)', () => {
    expect(inferredMatches([], [], 1000)).toEqual([])
  })
})

describe('live.json parsing', () => {
  it('keeps valid rounds and non-deleted event times in order', () => {
    expect(liveRounds([round(50, 60), null, { start: 'x' }, round(10, 20), { ...round(1, 2), winner: 'draw' }])).toEqual([round(10, 20), round(50, 60)])
    expect(liveEventTimes([{ t: 5 }, { t: 2, deleted: true }, { t: -1 }, null, { t: 1 }])).toEqual([1, 5])
    expect(liveRounds(undefined)).toEqual([])
  })
})
