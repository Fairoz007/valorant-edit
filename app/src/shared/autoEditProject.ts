/**
 * Auto edit plan → editable Studio project (schema v2), and validators for the v2 fields used by `projectShapeError`.
 * Pure, no Node imports.
 */
import type { Project, ProjectItem } from '../renderer/editor/project'
import { MONTAGE_STYLES, TRANSITION_KINDS, type AutoEditPlan, type ClipEffect } from './autoEdit'
import { PRESET_IDS } from './exportFormat'

const num = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optional = (v: unknown, ok: (v: unknown) => boolean): boolean => v === undefined || ok(v)

export const SPEED_RANGE = { min: 0.25, max: 2 } as const
export const GAIN_RANGE = { min: 0, max: 2 } as const

function validEffect(e: unknown): boolean {
  if (!isObj(e) || !num(e.at, 0, Number.MAX_SAFE_INTEGER) || !num(e.durationSec, 0, 10)) return false
  const x = e as unknown as ClipEffect
  if (x.kind === 'slowmo') return num(x.speed, 0.25, 1)
  if (x.kind === 'zoomPunch') return num(x.scale, 1, 1.5)
  return x.kind === 'flash'
}

function validOverlay(o: unknown): boolean {
  return isObj(o) && typeof o.text === 'string' && o.text.length > 0 && o.text.length <= 80 && num(o.at, 0, Number.MAX_SAFE_INTEGER) && num(o.durationSec, 0, 10)
}

function validCard(c: unknown): boolean {
  return isObj(c) && typeof c.text === 'string' && c.text.length <= 120 && num(c.durationSec, 0, 10) && (c.background === 'blurFrame' || c.background === 'black')
}

function validMusic(m: unknown): boolean {
  return isObj(m) && typeof m.path === 'string' && m.path.length > 0 && num(m.gain, 0, 1) && typeof m.duck === 'boolean' && num(m.fadeInSec, 0, 10) && num(m.fadeOutSec, 0, 10)
}

/** v2 item fields (all optional). */
export function validProjectItemStyle(x: Record<string, unknown> | Partial<ProjectItem>): boolean {
  const r = x as Record<string, unknown>
  return (
    optional(r.speed, (v) => num(v, SPEED_RANGE.min, SPEED_RANGE.max)) &&
    optional(r.gain, (v) => num(v, GAIN_RANGE.min, GAIN_RANGE.max)) &&
    optional(r.effects, (v) => Array.isArray(v) && v.length <= 16 && v.every(validEffect)) &&
    optional(r.overlay, validOverlay) &&
    optional(r.transitionIn, (v) => TRANSITION_KINDS.includes(v as never)) &&
    optional(r.transitionSec, (v) => num(v, 0, 1))
  )
}

/** v2 project-level fields (all optional). */
export function validProjectStyle(d: Record<string, unknown>): boolean {
  return (
    optional(d.style, (v) => MONTAGE_STYLES.includes(v as never)) &&
    optional(d.music, validMusic) &&
    optional(d.intro, validCard) &&
    optional(d.outro, validCard) &&
    optional(d.letterbox, (v) => typeof v === 'boolean') &&
    optional(d.presetId, (v) => v === 'source' || PRESET_IDS.includes(v as never))
  )
}

/** True when the project needs the montage render stage (anything beyond a plain v1 concat). */
export function projectHasStyling(p: Pick<Project, 'items' | 'music' | 'intro' | 'outro' | 'letterbox'>): boolean {
  if (p.music || p.intro || p.outro || p.letterbox) return true
  return p.items.some(
    (it) =>
      (it.speed !== undefined && it.speed !== 1) ||
      (it.gain !== undefined && it.gain !== 1) ||
      (it.effects?.length ?? 0) > 0 ||
      it.overlay !== undefined ||
      (it.transitionIn !== undefined && it.transitionIn !== 'cut')
  )
}

/** One project item per plan clip, in plan order; ids are `<projectId>_ae<n>`. Defaults (speed 1, gain 1, cut) are omitted. */
export function autoEditToProject(plan: AutoEditPlan, projectId: string, name: string): Project & { id: string } {
  const items: ProjectItem[] = plan.clips.map((c, i) => ({
    id: `${projectId}_ae${i}`,
    source: c.source,
    start: c.in,
    end: c.out,
    ...(c.speed !== 1 ? { speed: c.speed } : {}),
    ...(c.gain !== 1 ? { gain: c.gain } : {}),
    ...(c.effects.length > 0 ? { effects: c.effects.map((e) => ({ ...e })) } : {}),
    ...(c.overlay ? { overlay: { ...c.overlay } } : {}),
    ...(i > 0 && c.transitionIn !== 'cut' ? { transitionIn: c.transitionIn, transitionSec: c.transitionSec } : {})
  }))
  return {
    id: projectId,
    version: 2,
    name,
    items,
    style: plan.style,
    presetId: plan.presetId,
    ...(plan.music ? { music: { ...plan.music } } : {}),
    ...(plan.intro ? { intro: { ...plan.intro } } : {}),
    ...(plan.outro ? { outro: { ...plan.outro } } : {}),
    ...(plan.letterbox ? { letterbox: true } : {})
  }
}
