/**
 * Export format options shared by the renderer (export drawer), main (IPC validation, FFmpeg plan) and persisted settings.
 * Geometry lives in `reframe.ts`, the platform preset table and output-size rules in `exportPresets.ts`.
 */

/** Output frame shape. 'source' keeps the source size and aspect (the behaviour before reframing existed). */
export type OutputFrame = 'source' | '16:9' | '9:16' | '1:1'
export const OUTPUT_FRAMES: readonly OutputFrame[] = ['source', '16:9', '9:16', '1:1']

/** How a source is fitted into a frame of a different aspect ratio. */
export type ReframeMode = 'crop' | 'blur' | 'bars'
export const REFRAME_MODES: readonly ReframeMode[] = ['crop', 'blur', 'bars']

export type VideoCodec = 'h264' | 'h265'
export const VIDEO_CODECS: readonly VideoCodec[] = ['h264', 'h265']

export type PresetId = 'youtube' | 'shorts' | 'tiktok' | 'reels' | 'square'
export const PRESET_IDS: readonly PresetId[] = ['youtube', 'shorts', 'tiktok', 'reels', 'square']

/** Width:height of each non-source frame. */
export const FRAME_RATIO: Readonly<Record<Exclude<OutputFrame, 'source'>, readonly [number, number]>> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1]
}

export interface ExportFormat {
  /** Last preset the user picked (null = none). The drawer shows "Custom" when the fields no longer match it (see presetState). */
  preset: PresetId | null
  frame: OutputFrame
  reframe: ReframeMode
  /** Crop position along the cropped axis: -1 = left/top edge, 0 = centre, 1 = right/bottom edge. */
  offset: number
  codec: VideoCodec
  /** Explicit output size (both set or both null). null = derived from the source (see resolveOutputSpec). */
  width: number | null
  height: number | null
  /** Frame-rate cap: output fps = min(source fps, cap); never upscales. null = source fps. */
  fpsCap: number | null
}

/** Today's behaviour: source size, H.264, no reframing. Stream copy stays possible. */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = {
  preset: null,
  frame: 'source',
  reframe: 'crop',
  offset: 0,
  codec: 'h264',
  width: null,
  height: null,
  fpsCap: null
}

/** Size limits for an explicit output size: even integers in this range (4K either orientation). */
export const MIN_OUTPUT_SIDE = 128
export const MAX_OUTPUT_SIDE = 3840
export const MAX_FPS_CAP = 240
/** Explicit sizes must match the frame aspect within this relative tolerance (prevents stretched output). */
const ASPECT_TOLERANCE = 0.01

/** HEVC hardware encoders (no libx265: the bundled FFmpeg build is LGPL-only). */
export const HEVC_ENCODERS = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'] as const
export const H264_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264'] as const

/** Codec produced by an encoder name. */
export function encoderCodec(encoder: string): VideoCodec {
  return /^hevc_/.test(encoder) ? 'h265' : 'h264'
}

/** Encoders from a detected list that produce the given codec, in detection order. */
export function encodersForCodec(encoders: readonly string[], codec: VideoCodec): string[] {
  return encoders.filter((e) => encoderCodec(e) === codec)
}

/** Stream copy cannot reframe, rescale, change frame rate or change codec: any of those forces a precise export. */
export function formatRequiresPrecise(fmt: ExportFormat): boolean {
  return fmt.frame !== 'source' || fmt.codec === 'h265' || fmt.width !== null || fmt.height !== null || fmt.fpsCap !== null
}

export type ExportFormatError = 'shape' | 'preset' | 'frame' | 'reframe' | 'offset' | 'codec' | 'size' | 'fps'

const isEvenInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v % 2 === 0

/** Strict validation (for IPC): every field must be present and valid; unknown keys are ignored. */
export function validateExportFormat(raw: unknown): { ok: true; value: ExportFormat } | { ok: false; error: ExportFormatError } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'shape' }
  const r = raw as Record<string, unknown>
  if (r.preset !== null && !PRESET_IDS.includes(r.preset as PresetId)) return { ok: false, error: 'preset' }
  if (!OUTPUT_FRAMES.includes(r.frame as OutputFrame)) return { ok: false, error: 'frame' }
  if (!REFRAME_MODES.includes(r.reframe as ReframeMode)) return { ok: false, error: 'reframe' }
  if (typeof r.offset !== 'number' || !Number.isFinite(r.offset) || r.offset < -1 || r.offset > 1) return { ok: false, error: 'offset' }
  if (!VIDEO_CODECS.includes(r.codec as VideoCodec)) return { ok: false, error: 'codec' }
  const frame = r.frame as OutputFrame
  if (r.width === null || r.height === null) {
    if (r.width !== null || r.height !== null) return { ok: false, error: 'size' }
  } else {
    const inRange = (v: unknown): boolean => isEvenInt(v) && v >= MIN_OUTPUT_SIDE && v <= MAX_OUTPUT_SIDE
    if (!inRange(r.width) || !inRange(r.height) || frame === 'source') return { ok: false, error: 'size' }
    const [rw, rh] = FRAME_RATIO[frame]
    const aspect = (r.width as number) / (r.height as number)
    if (Math.abs(aspect / (rw / rh) - 1) > ASPECT_TOLERANCE) return { ok: false, error: 'size' }
  }
  if (r.fpsCap !== null && !(typeof r.fpsCap === 'number' && Number.isInteger(r.fpsCap) && r.fpsCap >= 1 && r.fpsCap <= MAX_FPS_CAP)) {
    return { ok: false, error: 'fps' }
  }
  return {
    ok: true,
    value: {
      preset: r.preset as PresetId | null,
      frame,
      reframe: r.reframe as ReframeMode,
      offset: r.offset,
      codec: r.codec as VideoCodec,
      width: r.width as number | null,
      height: r.height as number | null,
      fpsCap: r.fpsCap as number | null
    }
  }
}

/**
 * Lenient coercion (for persisted settings): a fully valid object is kept; anything else falls back to `base`
 * (partially valid objects are not mixed, so size/frame combinations can never become inconsistent).
 */
export function coerceExportFormat(raw: unknown, base: ExportFormat = DEFAULT_EXPORT_FORMAT): ExportFormat {
  const v = validateExportFormat(raw)
  return v.ok ? v.value : { ...base }
}
