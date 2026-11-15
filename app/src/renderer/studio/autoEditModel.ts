/**
 * Auto edit dialog view model (pure, no React/DOM): the draft the user edits → `AutoEditOptions` for `planAutoEdit`,
 * the estimate line (clips, final length, size via `estimateOutputBytes`), the reason Create is blocked, and the effect
 * badges the project track shows for a styled item.
 */
import {
  AUTO_EDIT_TARGET_RANGE,
  AUTO_EDIT_TARGETS,
  AUDIO_SILENT_WHEN_SPEED_CHANGED,
  DEFAULT_AUTO_EDIT_OPTIONS,
  STYLE_PRESETS,
  clipOutputSec,
  type AutoEditOptions,
  type AutoEditPlan,
  type AutoEditSource,
  type MontageStyle
} from '../../shared/autoEdit'
import { autoEditToProject, projectHasStyling } from '../../shared/autoEditProject'
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, type PresetId } from '../../shared/exportFormat'
import { applyPreset } from '../../shared/exportPresets'
import { estimateOutputBytes, type EstimateItem } from '../../shared/exportEstimate'
import type { ProjectItem } from '../editor/project'

/** Output presets offered by the dialog, in display order ('source' = keep the source frame). */
export const AUTO_EDIT_PRESETS: readonly (PresetId | 'source')[] = ['source', 'youtube', 'shorts', 'tiktok', 'reels', 'square']

/** A fixed target from `AUTO_EDIT_TARGETS`, or a custom length typed by the user. */
export type TargetChoice = number | 'all' | 'custom'

export interface AutoEditDraft {
  /** Checked source paths (any order; the planner and the list use recording order). */
  sources: string[]
  target: TargetChoice
  /** Custom target as typed: seconds ("90") or minutes:seconds ("1:30"). */
  customText: string
  style: MontageStyle
  includeDeaths: boolean
  /** Music file path as shown/typed ('' = no music). */
  musicPath: string
  presetId: PresetId | 'source'
}

/** Pre/post roll and merge gap (from `settings.autoclip` when available). */
export interface AutoEditTuning {
  before: number
  after: number
  mergeGap: number
}

export const DEFAULT_TUNING: AutoEditTuning = {
  before: DEFAULT_AUTO_EDIT_OPTIONS.before,
  after: DEFAULT_AUTO_EDIT_OPTIONS.after,
  mergeGap: DEFAULT_AUTO_EDIT_OPTIONS.mergeGap
}

export function initialDraft(sources: string[]): AutoEditDraft {
  return {
    sources: [...new Set(sources)],
    target: DEFAULT_AUTO_EDIT_OPTIONS.targetSec,
    customText: '',
    style: DEFAULT_AUTO_EDIT_OPTIONS.style,
    includeDeaths: DEFAULT_AUTO_EDIT_OPTIONS.includeDeaths,
    musicPath: '',
    presetId: DEFAULT_AUTO_EDIT_OPTIONS.presetId
  }
}

/** Parse a custom length: "90", "90s", "1:30" or "1m30s". null when not a positive length. */
export function parseTargetText(text: string): number | null {
  const s = text.trim().toLowerCase()
  if (s === '') return null
  let sec: number
  let m: RegExpExecArray | null
  if ((m = /^(\d+):([0-5]?\d)$/.exec(s))) sec = Number(m[1]) * 60 + Number(m[2])
  else if ((m = /^(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s?)?$/.exec(s)) && (m[1] || m[2])) sec = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)
  else return null
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec) : null
}

/** The custom value when it is a length inside `AUTO_EDIT_TARGET_RANGE`, else null. */
export function customTargetSec(text: string): number | null {
  const sec = parseTargetText(text)
  return sec !== null && sec >= AUTO_EDIT_TARGET_RANGE.min && sec <= AUTO_EDIT_TARGET_RANGE.max ? sec : null
}

/** Target seconds for the planner ('all' = every highlight); null while a custom value is missing or out of range. */
export function resolveTarget(d: Pick<AutoEditDraft, 'target' | 'customText'>): number | 'all' | null {
  if (d.target === 'custom') return customTargetSec(d.customText)
  return AUTO_EDIT_TARGETS.includes(d.target) ? d.target : null
}

/** Preset the montage will use: a style that forces a preset (Shorts → 9:16) wins over the dialog's choice. */
export function effectivePreset(style: MontageStyle, presetId: PresetId | 'source'): { presetId: PresetId | 'source'; forced: boolean } {
  const forced = STYLE_PRESETS[style].presetId
  return forced ? { presetId: forced, forced: true } : { presetId, forced: false }
}

/** Upper bound the style puts on the length (Shorts: 60 s) when it cuts the chosen target, else null. */
export function styleCap(style: MontageStyle, target: number | 'all' | null): number | null {
  const max = STYLE_PRESETS[style].maxSec
  if (max === null || target === null) return null
  return target === 'all' || target > max ? max : null
}

/** Whether a style has slow motion, whose parts play without game audio (pinned FFmpeg has no atempo). */
export function styleSilencesSlowMo(style: MontageStyle): boolean {
  return AUDIO_SILENT_WHEN_SPEED_CHANGED && STYLE_PRESETS[style].slowMo !== null
}

/** Draft → planner options; null while the target is invalid. Sources keep the draft order (the planner sorts them). */
export function buildOptions(d: AutoEditDraft, tuning: AutoEditTuning = DEFAULT_TUNING): AutoEditOptions | null {
  const targetSec = resolveTarget(d)
  if (targetSec === null) return null
  const music = d.musicPath.trim()
  return {
    ...DEFAULT_AUTO_EDIT_OPTIONS,
    sources: [...d.sources],
    targetSec,
    includeDeaths: d.includeDeaths,
    musicPath: music === '' ? null : music,
    presetId: d.presetId,
    style: d.style,
    before: tuning.before,
    after: tuning.after,
    mergeGap: tuning.mergeGap
  }
}

/** Sources in recording order (ties keep their path order so the list is stable). */
export function byRecording<T extends { recordedAt: number; path: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.recordedAt - b.recordedAt || a.path.localeCompare(b.path))
}

/** Loaded sources for the checked paths, in recording order (paths still loading or failed are skipped). */
export function selectedSources(draft: Pick<AutoEditDraft, 'sources'>, loaded: ReadonlyMap<string, AutoEditSource>): AutoEditSource[] {
  return byRecording(draft.sources.map((p) => loaded.get(p)).filter((s): s is AutoEditSource => s !== undefined))
}

/** Export format the estimate uses for a preset. */
export function formatForPreset(presetId: PresetId | 'source'): ExportFormat {
  return presetId === 'source' ? { ...DEFAULT_EXPORT_FORMAT } : applyPreset(DEFAULT_EXPORT_FORMAT, presetId)
}

export interface AutoEditEstimate {
  clips: number
  /** Planned output length (`plan.totalSec`). */
  totalSec: number
  bytes: number
}

/**
 * Estimate line for a plan. Each clip counts with its output length (speed and slow-mo applied), cards count too.
 * A styled montage or a reframing preset is re-encoded, so it is estimated as precise; a plain cut list as copy.
 */
export function estimatePlan(plan: AutoEditPlan): AutoEditEstimate {
  const items: EstimateItem[] = plan.clips.map((c) => ({ source: c.source, start: 0, end: clipOutputSec(c) }))
  for (const card of [plan.intro, plan.outro]) if (card) items.push({ start: 0, end: card.durationSec })
  const styled = projectHasStyling(autoEditToProject(plan, 'estimate', 'estimate'))
  const quality = styled || plan.presetId !== 'source' ? 'precise' : 'copy'
  return {
    clips: plan.clips.length,
    totalSec: plan.totalSec,
    bytes: plan.clips.length === 0 ? 0 : estimateOutputBytes({ items }, quality, new Map(), 'concat', formatForPreset(plan.presetId))
  }
}

/** Why Create is disabled (first reason wins), or null when it can run. */
export type AutoEditBlock = 'noSelection' | 'loading' | 'invalidTarget' | 'noKills' | 'busy' | null

export function createBlock(input: {
  draft: AutoEditDraft
  /** Some checked source is still loading its analysis. */
  loading: boolean
  /** Plan computed for the current draft (null when the options are invalid). */
  plan: AutoEditPlan | null
  busy: boolean
}): AutoEditBlock {
  if (input.busy) return 'busy'
  if (input.draft.sources.length === 0) return 'noSelection'
  if (resolveTarget(input.draft) === null) return 'invalidTarget'
  if (input.loading || !input.plan) return 'loading'
  if (input.plan.empty === 'noSources') return 'noSelection'
  if (input.plan.empty === 'noKills') return 'noKills'
  return null
}

/** Default project name: the dialog's name template filled with the style and a local date/time. */
export function defaultProjectName(template: string, styleName: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  return template.replace('{style}', styleName).replace('{date}', date).slice(0, 120)
}

/* ---------------- Project-track effect badges ---------------- */

export type EffectBadgeKind = 'slowmo' | 'zoomPunch' | 'flash' | 'caption' | 'speed' | 'transition'

export interface EffectBadge {
  kind: EffectBadgeKind
  /** Visible text: a short tag, the caption text, or the speed factor. */
  text?: string
  /** Slow-mo speed, whole-item speed, or transition kind for the accessible label. */
  value?: number | string
}

const factor = (n: number): string => String(Math.round(n * 100) / 100)

/** Badges for one project item (v2 styling fields), in a fixed order; empty for a plain v1 item. */
export function effectBadges(item: Pick<ProjectItem, 'effects' | 'overlay' | 'speed' | 'transitionIn'>): EffectBadge[] {
  const out: EffectBadge[] = []
  const effects = item.effects ?? []
  const slow = effects.find((e) => e.kind === 'slowmo')
  if (slow && slow.kind === 'slowmo') out.push({ kind: 'slowmo', value: factor(slow.speed) })
  if (effects.some((e) => e.kind === 'zoomPunch')) out.push({ kind: 'zoomPunch' })
  if (effects.some((e) => e.kind === 'flash')) out.push({ kind: 'flash' })
  if (item.overlay) out.push({ kind: 'caption', text: item.overlay.text })
  if (item.speed !== undefined && item.speed !== 1) out.push({ kind: 'speed', text: `×${factor(item.speed)}`, value: factor(item.speed) })
  if (item.transitionIn !== undefined && item.transitionIn !== 'cut') out.push({ kind: 'transition', value: item.transitionIn })
  return out
}
