/**
 * Reframing geometry: the single source of truth for how a source is fitted into the output frame.
 * The export plan (FFmpeg filter) and the export drawer preview both use computeReframe(), so the preview shows exactly what is exported.
 * All values are integer pixels; every size and position is even (yuv420p chroma alignment), and the crop rectangle never leaves the source.
 */
import type { VideoSpec } from './encodeQuality'
import type { ReframeMode } from './exportFormat'

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ReframeGeometry {
  /** Effective operation: 'scale' when the source already has the output aspect (no crop, no bars, no blur). */
  kind: 'scale' | 'crop' | 'blur' | 'bars'
  out: Size
  fps: number
  /**
   * Region of the source shown in the foreground, in source pixels. For 'crop' the crop rectangle; otherwise the whole source
   * (odd source sizes lose their last row/column so everything stays even).
   */
  crop: Rect
  /** Foreground size in output pixels after scaling (equals `out` for 'scale' and 'crop'). */
  scaled: Size
  /** Top-left of the foreground inside the output frame ((0,0) for 'scale' and 'crop'). */
  pos: { x: number; y: number }
  /** 'blur' only: the background is the crop region scaled to `scaled` (fill), then cut to the output size at `crop`. */
  background: { scaled: Size; crop: Rect } | null
}

/** Used when a source size is unknown (matches FALLBACK_SPEC in encodeQuality). */
const FALLBACK_SOURCE: Size = { width: 1920, height: 1080 }
/** Background blur: shrink by this factor and scale back up (only `scale` is needed; the bundled FFmpeg has no gblur/boxblur). */
export const BLUR_DOWNSCALE = 24

const evenFloor = (v: number): number => Math.max(2, Math.floor(v / 2) * 2)
const evenRound = (v: number): number => Math.max(2, Math.round(v / 2) * 2)
/** Even floor for positions (0 allowed; never negative). */
const even0 = (v: number): number => Math.max(0, Math.floor(v / 2) * 2)

export function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0
  return Math.min(1, Math.max(-1, offset))
}

function usableSource(src: Size): Size {
  const ok = (v: number): boolean => Number.isFinite(v) && v >= 2
  if (!ok(src.width) || !ok(src.height)) return { ...FALLBACK_SOURCE }
  return { width: evenFloor(src.width), height: evenFloor(src.height) }
}

/**
 * Compute the reframe geometry for one source.
 * - crop: the largest region of the output aspect, positioned along the cropped axis by `offset` (-1..1, clamped; the other axis is centred), scaled to `out`.
 * - bars: the whole source scaled to fit and centred on black (letterbox/pillarbox).
 * - blur: like bars, over a blurred scaled-to-fill copy of the source.
 * When the even-rounded fit already fills the output, every mode degrades to 'scale'.
 */
export function computeReframe(src: Size, out: VideoSpec, mode: ReframeMode, offset: number): ReframeGeometry {
  const s = usableSource(src)
  const ow = evenFloor(out.width)
  const oh = evenFloor(out.height)
  const outSize = { width: ow, height: oh }
  const full: Rect = { x: 0, y: 0, width: s.width, height: s.height }
  const wider = s.width * oh > s.height * ow // source is wider than the output aspect
  const base = { out: outSize, fps: out.fps }

  // Fit (bars/blur foreground) and the crop rectangle, both even.
  const fit: Size = wider
    ? { width: ow, height: Math.min(oh, evenRound((ow * s.height) / s.width)) }
    : { width: Math.min(ow, evenRound((oh * s.width) / s.height)), height: oh }
  const cropSize: Size = wider
    ? { width: Math.min(s.width, evenRound((s.height * ow) / oh)), height: s.height }
    : { width: s.width, height: Math.min(s.height, evenRound((s.width * oh) / ow)) }

  const scaleOnly = mode === 'crop' ? cropSize.width === s.width && cropSize.height === s.height : fit.width === ow && fit.height === oh
  if (scaleOnly) {
    return { ...base, kind: 'scale', crop: full, scaled: outSize, pos: { x: 0, y: 0 }, background: null }
  }

  if (mode === 'crop') {
    const t = (clampOffset(offset) + 1) / 2
    // Slack is even (both sizes even), so the extremes (offset ±1) land exactly on the edges; the other axis is centred.
    const slackX = s.width - cropSize.width
    const slackY = s.height - cropSize.height
    const crop: Rect = {
      x: wider ? even0(t * slackX) : even0(slackX / 2),
      y: wider ? even0(slackY / 2) : even0(t * slackY),
      ...cropSize
    }
    return { ...base, kind: 'crop', crop, scaled: outSize, pos: { x: 0, y: 0 }, background: null }
  }

  const pos = { x: even0((ow - fit.width) / 2), y: even0((oh - fit.height) / 2) }
  if (mode === 'bars') {
    return { ...base, kind: 'bars', crop: full, scaled: fit, pos, background: null }
  }
  const fill: Size = wider
    ? { width: Math.max(ow, evenRound((oh * s.width) / s.height)), height: oh }
    : { width: ow, height: Math.max(oh, evenRound((ow * s.height) / s.width)) }
  const bgCrop: Rect = { x: even0((fill.width - ow) / 2), y: even0((fill.height - oh) / 2), width: ow, height: oh }
  return { ...base, kind: 'blur', crop: full, scaled: fit, pos, background: { scaled: fill, crop: bgCrop } }
}

const fpsTail = (fps: number): string => `fps=${fps},format=yuv420p`
const cropStep = (r: Rect): string => `crop=${r.width}:${r.height}:${r.x}:${r.y}`

/**
 * FFmpeg `-vf` filtergraph for the geometry (single input, single output). Always ends with `fps=<n>,format=yuv420p`.
 * Uses only filters in the bundled build (crop, scale, pad, split, overlay, fps, format).
 * `src` is the real source size: a leading crop removes the odd last row/column when needed.
 */
export function reframeFilter(g: ReframeGeometry, src: Size): string {
  const { width: W, height: H } = g.out
  // 'crop' always starts with its crop rectangle; other kinds crop only to drop an odd last row/column.
  const needsCrop = g.crop.x !== 0 || g.crop.y !== 0 || g.crop.width !== src.width || g.crop.height !== src.height
  const pre = needsCrop ? `${cropStep(g.crop)},` : ''
  switch (g.kind) {
    case 'scale':
    case 'crop':
      return `${pre}scale=${W}:${H}:flags=lanczos,${fpsTail(g.fps)}`
    case 'bars':
      return `${pre}scale=${g.scaled.width}:${g.scaled.height}:flags=lanczos,pad=${W}:${H}:${g.pos.x}:${g.pos.y}:color=black,${fpsTail(g.fps)}`
    case 'blur': {
      const bg = g.background!
      const bw = evenRound(W / BLUR_DOWNSCALE)
      const bh = evenRound(H / BLUR_DOWNSCALE)
      return (
        `${pre}split=2[rf_bg][rf_fg];` +
        `[rf_bg]scale=${bg.scaled.width}:${bg.scaled.height}:flags=fast_bilinear,${cropStep(bg.crop)},scale=${bw}:${bh}:flags=area,scale=${W}:${H}:flags=bicubic[rf_bgb];` +
        `[rf_fg]scale=${g.scaled.width}:${g.scaled.height}:flags=lanczos[rf_fgs];` +
        `[rf_bgb][rf_fgs]overlay=${g.pos.x}:${g.pos.y},${fpsTail(g.fps)}`
      )
    }
  }
}
