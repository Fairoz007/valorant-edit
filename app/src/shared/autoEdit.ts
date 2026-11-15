/**
 * Auto edit (phase 2B contract): detected events from one or more videos → one styled montage project.
 * Shared by main (render stage, IPC), preload and renderer (dialog, estimate), so it must not import Node modules.
 * The planner body lives in `autoEditPlan.ts` (agent F); ranking comes from `highlightScore.ts` (shared with Auto montage).
 * Change exported signatures only through the lead.
 */
import type { PresetId } from './exportFormat'
import type { EngineEvent, Round } from './types'
import { DEFAULT_MERGE_GAP_SEC, DEFAULT_SCORE_WEIGHTS, type HighlightKind, type ScoreWeights } from './highlightScore'

export type MontageStyle = 'clean' | 'cinematic' | 'hype' | 'shorts'
export const MONTAGE_STYLES: readonly MontageStyle[] = ['clean', 'cinematic', 'hype', 'shorts']

export type TransitionKind = 'cut' | 'crossfade' | 'dipBlack' | 'dipWhite' | 'zoomBlur'
export const TRANSITION_KINDS: readonly TransitionKind[] = ['cut', 'crossfade', 'dipBlack', 'dipWhite', 'zoomBlur']
/** Transition length range (seconds); `cut` has length 0. */
export const TRANSITION_RANGE = { min: 0.2, max: 0.6 } as const

export type AutoEditOrder = 'chronological' | 'buildUp'
export const AUTO_EDIT_ORDERS: readonly AutoEditOrder[] = ['chronological', 'buildUp']

/** Target lengths offered by the dialog (seconds), plus 'all'. */
export const AUTO_EDIT_TARGETS: readonly (number | 'all')[] = [30, 60, 180, 'all']
export const AUTO_EDIT_TARGET_RANGE = { min: 10, max: 1800 } as const
/** The planned total must land within this many seconds of a numeric target (when enough highlight material exists). */
export const TARGET_TOLERANCE_SEC = 1

/** Slow motion around a kill moment (`setpts` / `atempo`). Times are source seconds. */
export interface SlowMoEffect {
  kind: 'slowmo'
  at: number
  durationSec: number
  /** Playback speed inside the window, 0.25..1 (0.5 = half speed). */
  speed: number
}
/** Quick zoom in and out on a kill (`crop` + `scale`). */
export interface ZoomPunchEffect {
  kind: 'zoomPunch'
  at: number
  durationSec: number
  /** Peak zoom factor, 1..1.5. */
  scale: number
}
/** Short white flash on a kill. */
export interface FlashEffect {
  kind: 'flash'
  at: number
  durationSec: number
}
export type ClipEffect = SlowMoEffect | ZoomPunchEffect | FlashEffect
export type ClipEffectKind = ClipEffect['kind']

/** Caption burned in with `drawtext` ("DOUBLE KILL", "ACE", ...). Times are source seconds. */
export interface ClipOverlay {
  text: string
  at: number
  durationSec: number
}

/** Title or end card. */
export interface TitleCard {
  text: string
  durationSec: number
  /** Background: blurred first/last frame of the montage, or a solid colour token. */
  background: 'blurFrame' | 'black'
}

export interface MusicBed {
  path: string
  /** Linear gain of the music bed, 0..1. */
  gain: number
  /** Lower the music under game audio peaks (`sidechaincompress`). */
  duck: boolean
  fadeInSec: number
  fadeOutSec: number
}

/** A style as data: everything the planner and the render stage need to know. */
export interface StylePreset {
  id: MontageStyle
  transition: TransitionKind
  /** Transition length in seconds (0 for `cut`). */
  transitionSec: number
  overlays: boolean
  /** Slow motion on the final kill of a multikill (null: off). */
  slowMo: { speed: number; durationSec: number } | null
  zoomPunch: { scale: number; durationSec: number } | null
  flash: boolean
  /** Snap cut points to detected music beats (only when a music file is chosen). */
  beatSync: boolean
  /** Cinematic 2.39:1 letterbox bars. */
  letterbox: boolean
  intro: boolean
  outro: boolean
  /** Preset forced by the style (Shorts → 9:16), or null to use the dialog's choice. */
  presetId: PresetId | null
  /** Upper bound on the total length (Shorts: 60 s), or null. */
  maxSec: number | null
  /** Caption size relative to the output height (Shorts: big captions). */
  captionScale: number
  musicGain: number
}

export const STYLE_PRESETS: Readonly<Record<MontageStyle, StylePreset>> = {
  clean: {
    id: 'clean', transition: 'cut', transitionSec: 0, overlays: false, slowMo: null, zoomPunch: null, flash: false,
    beatSync: false, letterbox: false, intro: false, outro: false, presetId: null, maxSec: null, captionScale: 0.06, musicGain: 0.35
  },
  cinematic: {
    id: 'cinematic', transition: 'crossfade', transitionSec: 0.5, overlays: true, slowMo: { speed: 0.5, durationSec: 0.6 },
    zoomPunch: null, flash: false, beatSync: false, letterbox: true, intro: true, outro: true, presetId: null, maxSec: null,
    captionScale: 0.06, musicGain: 0.4
  },
  hype: {
    id: 'hype', transition: 'zoomBlur', transitionSec: 0.25, overlays: true, slowMo: null,
    zoomPunch: { scale: 1.2, durationSec: 0.3 }, flash: true, beatSync: true, letterbox: false, intro: false, outro: true,
    presetId: null, maxSec: null, captionScale: 0.08, musicGain: 0.5
  },
  shorts: {
    id: 'shorts', transition: 'cut', transitionSec: 0, overlays: true, slowMo: null, zoomPunch: { scale: 1.15, durationSec: 0.3 },
    flash: false, beatSync: false, letterbox: false, intro: false, outro: false, presetId: 'shorts', maxSec: 60,
    captionScale: 0.1, musicGain: 0.4
  }
}

/** One source video with its analysis results. */
export interface AutoEditSource {
  path: string
  durationSec: number
  /** Recording time (ms since epoch, from the file or library entry); sources are used in this order. */
  recordedAt: number
  events: EngineEvent[]
  rounds?: Round[]
  /** false when the source has no audio stream (the render stage inserts silence). */
  hasAudio: boolean
}

export interface AutoEditOptions {
  /** Source paths, in the order the user picked; the planner orders them by `recordedAt`. */
  sources: string[]
  targetSec: number | 'all'
  order: AutoEditOrder
  /** Keep clips that end in the player's death (otherwise they are cut before the death or dropped). */
  includeDeaths: boolean
  musicPath: string | null
  /** Output preset; a style with a forced preset overrides it. 'source' keeps the source frame. */
  presetId: PresetId | 'source'
  style: MontageStyle
  weights: ScoreWeights
  /** Pre/post roll and merge gap (seconds); defaults from `settings.autoclip`. */
  before: number
  after: number
  mergeGap: number
}

export const DEFAULT_AUTO_EDIT_OPTIONS: Omit<AutoEditOptions, 'sources'> = {
  targetSec: 60,
  order: 'chronological',
  includeDeaths: false,
  musicPath: null,
  presetId: 'source',
  style: 'clean',
  weights: DEFAULT_SCORE_WEIGHTS,
  before: 3,
  after: 1.5,
  mergeGap: DEFAULT_MERGE_GAP_SEC
}

export interface AutoEditClip {
  /** Stable id within the plan (`ae_<n>`). */
  id: string
  source: string
  /** Source range in seconds (`in` < `out`). */
  in: number
  out: number
  /** Whole-clip playback speed, 0.25..2 (effects may slow parts further). */
  speed: number
  /** Linear game-audio gain, 0..2. */
  gain: number
  effects: ClipEffect[]
  overlay: ClipOverlay | null
  /** Transition into this clip from the previous one (the first clip's is ignored). */
  transitionIn: TransitionKind
  transitionSec: number
  score: number
  kind: HighlightKind
  eventIds: string[]
}

export interface AutoEditPlan {
  style: MontageStyle
  /** Effective preset (style override applied). */
  presetId: PresetId | 'source'
  clips: AutoEditClip[]
  /**
   * Exact planned output length in seconds: sum of clip lengths after speed and slow-mo, minus transition overlaps,
   * plus intro and outro. The real FFmpeg output must match this within ±1 frame.
   */
  totalSec: number
  music: MusicBed | null
  intro: TitleCard | null
  outro: TitleCard | null
  letterbox: boolean
  beatSync: boolean
  /** Set when there is nothing to montage. */
  empty?: 'noSources' | 'noKills'
  /** Non-fatal notes (e.g. "target longer than available highlights"), English source text. */
  warnings: string[]
}

/** Seconds a clip occupies in the output before transitions: (out - in) / speed, with slow-mo windows stretched. */
export function clipOutputSec(c: Pick<AutoEditClip, 'in' | 'out' | 'speed' | 'effects'>): number {
  let sec = (c.out - c.in) / c.speed
  for (const e of c.effects) {
    if (e.kind !== 'slowmo') continue
    const a = Math.max(c.in, e.at - e.durationSec / 2)
    const b = Math.min(c.out, e.at + e.durationSec / 2)
    if (b > a) sec += (b - a) / c.speed * (1 / e.speed - 1)
  }
  return sec
}

/** `AutoEditPlan.totalSec` for a list of clips and cards (transition overlaps are subtracted). */
export function planTotalSec(clips: AutoEditClip[], intro: TitleCard | null, outro: TitleCard | null): number {
  let sec = 0
  clips.forEach((c, i) => {
    sec += clipOutputSec(c)
    if (i > 0 && c.transitionIn !== 'cut') sec -= c.transitionSec
  })
  return sec + (intro?.durationSec ?? 0) + (outro?.durationSec ?? 0)
}
