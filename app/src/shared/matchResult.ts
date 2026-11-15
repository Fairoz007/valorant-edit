/** Final score and result of a single-match VALORANT recording, from its scoreboard rounds. */
export interface MatchScore { ally: number; enemy: number }

/**
 * The final score when the rounds are exactly one match from its first round (scores 1, 2, 3, … in order); null when
 * there are no rounds, the recording starts mid-match, or it spans more than one match (whole-session recordings).
 */
export function matchScore(rounds: readonly { ally: number; enemy: number }[] | undefined | null): MatchScore | null {
  if (!rounds?.length) return null
  for (const [i, r] of rounds.entries()) {
    if (!Number.isSafeInteger(r.ally) || !Number.isSafeInteger(r.enemy) || r.ally + r.enemy !== i + 1) return null
  }
  const last = rounds[rounds.length - 1]
  return { ally: last.ally, enemy: last.enemy }
}

export function matchResult(score: MatchScore): 'win' | 'loss' | 'draw' {
  return score.ally > score.enemy ? 'win' : score.ally < score.enemy ? 'loss' : 'draw'
}
