/**
 * Auto edit planner (phase 2B.1). Signature fixed by the lead; agent F replaces the body.
 * Pure and deterministic: no I/O, same input → same plan. Ranking via `highlightScore.ts` (shared with Auto montage).
 */
import { planTotalSec, STYLE_PRESETS, type AutoEditOptions, type AutoEditPlan, type AutoEditSource } from './autoEdit'
import { compareHighlights, highlightWindows } from './highlightScore'

/**
 * Plan a montage across `sources` (used in `recordedAt` order):
 * windows from `highlightWindows` (merge gap keeps multikills whole) → drop or trim clips ending in the player's death
 * unless `includeDeaths` → score (`scoreHighlight` + duplicate penalty) → pick the best that fit `targetSec` (±1 s,
 * style `maxSec` caps it) → order (chronological, or build-up: weakest first, best last) → style effects, overlays,
 * transitions, music, intro/outro. `totalSec` must equal `planTotalSec(clips, intro, outro)`.
 */
export function planAutoEdit(sources: AutoEditSource[], options: AutoEditOptions): AutoEditPlan {
  // Contract stub (agent F replaces): chronological cuts of every window, no styling.
  const style = STYLE_PRESETS[options.style]
  const presetId = style.presetId ?? options.presetId
  if (sources.length === 0) return { style: options.style, presetId, clips: [], totalSec: 0, music: null, intro: null, outro: null, letterbox: false, beatSync: false, empty: 'noSources', warnings: [] }
  const ordered = [...sources].sort((a, b) => a.recordedAt - b.recordedAt)
  const clips = ordered.flatMap((s) =>
    highlightWindows(s.events, { before: options.before, after: options.after, mergeGap: options.mergeGap, durationSec: s.durationSec, rounds: s.rounds })
      .map((w) => ({ s, w }))
  )
  void compareHighlights
  const planned = clips.map(({ s, w }, i) => ({
    id: `ae_${i}`, source: s.path, in: w.start, out: w.end, speed: 1, gain: 1, effects: [], overlay: null,
    transitionIn: 'cut' as const, transitionSec: 0, score: 0, kind: w.kind, eventIds: w.eventIds
  }))
  if (planned.length === 0) return { style: options.style, presetId, clips: [], totalSec: 0, music: null, intro: null, outro: null, letterbox: false, beatSync: false, empty: 'noKills', warnings: [] }
  return { style: options.style, presetId, clips: planned, totalSec: planTotalSec(planned, null, null), music: null, intro: null, outro: null, letterbox: false, beatSync: false, warnings: [] }
}
