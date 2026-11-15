/**
 * Platform export presets (data) and the rules that turn an ExportFormat plus a source spec into the output spec.
 * Edit PRESETS to change a platform; the drawer cards, the plan and the tests all read this table.
 */
import type { VideoSpec } from './encodeQuality'
import { DEFAULT_EXPORT_FORMAT, FRAME_RATIO, type ExportFormat, type OutputFrame, type PresetId, type ReframeMode } from './exportFormat'

export interface ExportPreset {
  id: PresetId
  frame: Exclude<OutputFrame, 'source'>
  /** Fixed output size; null = derived from the source (capped at maxLongSide/maxShortSide). */
  width: number | null
  height: number | null
  /** Output fps = min(source fps, cap); null = source fps. */
  fpsCap: number | null
  /** Platform length limit in seconds; null = none. Over the limit is a warning, never a block. */
  maxSeconds: number | null
  /** Reframe mode filled in when the preset is chosen. */
  reframe: ReframeMode
}

export const PRESETS: readonly ExportPreset[] = [
  { id: 'youtube', frame: '16:9', width: null, height: null, fpsCap: null, maxSeconds: null, reframe: 'bars' },
  { id: 'shorts', frame: '9:16', width: 1080, height: 1920, fpsCap: 60, maxSeconds: 60, reframe: 'crop' },
  { id: 'tiktok', frame: '9:16', width: 1080, height: 1920, fpsCap: 60, maxSeconds: 600, reframe: 'crop' },
  { id: 'reels', frame: '9:16', width: 1080, height: 1920, fpsCap: 30, maxSeconds: 90, reframe: 'crop' },
  { id: 'square', frame: '1:1', width: 1080, height: 1080, fpsCap: 60, maxSeconds: null, reframe: 'crop' }
]

/** Derived sizes never exceed 3840×2160 (or 2160×3840 for portrait). */
export const MAX_LONG_SIDE = 3840
export const MAX_SHORT_SIDE = 2160

export function getPreset(id: PresetId): ExportPreset {
  const p = PRESETS.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown export preset: ${id}`)
  return p
}

/** Fill the format from a preset (keeps codec and offset, which presets do not define). */
export function applyPreset(fmt: ExportFormat, id: PresetId): ExportFormat {
  const p = getPreset(id)
  return { ...fmt, preset: id, frame: p.frame, width: p.width, height: p.height, fpsCap: p.fpsCap, reframe: p.reframe }
}

/** Back to the source frame (no preset, no reframing); keeps codec. */
export function sourceFormat(fmt: ExportFormat): ExportFormat {
  return { ...DEFAULT_EXPORT_FORMAT, codec: fmt.codec, offset: fmt.offset, reframe: fmt.reframe }
}

/**
 * What the drawer shows as selected: a preset while its output fields (frame, size, fps cap) are unchanged,
 * 'source' for the untouched source frame, otherwise 'custom'. Reframe mode, offset and codec are styling choices
 * within a platform and never turn a preset into Custom (so the platform length warning stays).
 */
export function presetState(fmt: ExportFormat): PresetId | 'source' | 'custom' {
  if (fmt.preset !== null) {
    const p = getPreset(fmt.preset)
    if (p.frame === fmt.frame && p.width === fmt.width && p.height === fmt.height && p.fpsCap === fmt.fpsCap) {
      return p.id
    }
  }
  if (fmt.frame === 'source' && fmt.width === null && fmt.height === null && fmt.fpsCap === null) return 'source'
  return 'custom'
}

const evenRound = (v: number): number => Math.max(2, Math.round(v / 2) * 2)
const evenFloor = (v: number): number => Math.max(2, Math.floor(v / 2) * 2)

/** Output fps: min(source, cap); never upscales. */
export function outputFps(sourceFps: number, cap: number | null): number {
  return cap !== null && cap > 0 && cap < sourceFps ? cap : sourceFps
}

/**
 * Output spec for a source (or concat timeline) spec:
 * - 'source': the source size (even) at the capped fps.
 * - explicit width/height: used as-is.
 * - otherwise: keep the source's short side for the frame's short side, then cap at MAX_LONG_SIDE × MAX_SHORT_SIDE.
 */
export function resolveOutputSpec(src: VideoSpec, fmt: ExportFormat): VideoSpec {
  const fps = outputFps(src.fps, fmt.fpsCap)
  if (fmt.frame === 'source') return { width: evenFloor(src.width), height: evenFloor(src.height), fps }
  if (fmt.width !== null && fmt.height !== null) return { width: fmt.width, height: fmt.height, fps }
  const [rw, rh] = FRAME_RATIO[fmt.frame]
  const short = evenFloor(Math.min(src.width, src.height))
  let w = rw >= rh ? evenRound((short * rw) / rh) : short
  let h = rw >= rh ? short : evenRound((short * rh) / rw)
  const k = Math.min(1, MAX_LONG_SIDE / Math.max(w, h), MAX_SHORT_SIDE / Math.min(w, h))
  if (k < 1) {
    w = evenRound(w * k)
    h = evenRound(h * k)
  }
  return { width: w, height: h, fps }
}

/** Length limit of the selected preset (only while the preset is still selected, not Custom). */
export function maxSecondsFor(fmt: ExportFormat): number | null {
  const state = presetState(fmt)
  return state === 'source' || state === 'custom' ? null : getPreset(state).maxSeconds
}

export interface LengthItem {
  start: number
  end: number
}

const len = (it: LengthItem): number => Math.max(0, it.end - it.start)

/** Over-length check: concat compares the total, separate compares each clip. Returns null when within the limit or there is none. */
export function lengthWarning(
  items: readonly LengthItem[],
  mode: 'concat' | 'separate',
  fmt: ExportFormat
): { maxSeconds: number; seconds: number } | null {
  const max = maxSecondsFor(fmt)
  if (max === null) return null
  const seconds = mode === 'concat' ? items.reduce((s, it) => s + len(it), 0) : Math.max(0, ...items.map(len))
  return seconds > max + 1e-6 ? { maxSeconds: max, seconds } : null
}

/**
 * "Export only the first N seconds": concat keeps the timeline up to N seconds (dropping later clips, shortening the last kept one);
 * separate shortens each clip to N seconds. Item fields other than start/end are kept.
 */
export function trimItemsToSeconds<T extends LengthItem>(items: readonly T[], seconds: number, mode: 'concat' | 'separate'): T[] {
  if (!(seconds > 0)) return []
  if (mode === 'separate') return items.map((it) => (len(it) > seconds ? { ...it, end: it.start + seconds } : it))
  const out: T[] = []
  let left = seconds
  for (const it of items) {
    if (left <= 1e-6) break
    const d = len(it)
    if (d <= 0) continue
    out.push(d > left ? { ...it, end: it.start + left } : it)
    left -= Math.min(d, left)
  }
  return out
}
