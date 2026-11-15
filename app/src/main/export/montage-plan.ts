/**
 * Montage render stage, planning half (pure: no I/O). A styled v2 project becomes a list of simple segments, each one
 * FFmpeg job writing a PCM .mov intermediate (as the precise concat path in plan.ts), joined with the concat demuxer.
 * Only filters in the pinned LGPL FFmpeg are used (see `ALLOWED_FILTERS`).
 *
 * Timing: every segment gets a whole number of output frames, allocated from the exact cumulative timeline
 * (`round(end·fps) − round(start·fps)`), so the joined output is within half a frame of `planTotalSec`.
 */
import type { ProjectItem } from '../../renderer/editor/project'
import { clipOutputSec, STYLE_PRESETS, type ClipEffect, type MontageStyle, type MusicBed, type TitleCard } from '../../shared/autoEdit'
import type { StreamProbe } from '../../shared/exportCompat'
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, type PresetId } from '../../shared/exportFormat'
import { resolveOutputSpec } from '../../shared/exportPresets'
import { computeReframe, reframeFilter, type Size } from '../../shared/reframe'
import { concatRenderSpec, videoEncodeArgs, type VideoSpec } from './encodeQuality'

/** Filters of the pinned FFmpeg build (`ffmpeg -filters`); nothing else may appear in a montage graph. */
export const ALLOWED_FILTERS: ReadonlySet<string> = new Set([
  'aformat', 'anull', 'aresample', 'atrim', 'volume', 'anullsrc', 'sine', 'crop', 'drawbox', 'format', 'fps', 'hflip',
  'hwdownload', 'null', 'overlay', 'pad', 'rotate', 'scale', 'select', 'setpts', 'split', 'transpose', 'trim', 'vflip',
  'vstack', 'color', 'testsrc2'
])

export type MontageItem = Pick<ProjectItem, 'id' | 'source' | 'start' | 'end' | 'speed' | 'gain' | 'effects' | 'overlay' | 'transitionIn' | 'transitionSec'>

export interface MontageProjectStyle {
  style?: MontageStyle
  music?: MusicBed
  intro?: TitleCard
  outro?: TitleCard
  letterbox?: boolean
  /** Preset chosen in the Auto edit dialog; informational here (the request's `format` is what gets rendered). */
  presetId?: PresetId | 'source'
}

/** Interval in segment-local output seconds. */
export interface Span {
  a: number
  b: number
}
export interface DipStep extends Span {
  alpha: number
  color: 'black' | 'white'
}

export interface ClipSegment {
  kind: 'clip'
  itemIndex: number
  source: string
  srcStart: number
  srcEnd: number
  /** Output seconds per source second (slow-mo stretch / item speed). */
  rate: number
  /** Zoom-punch factor for the whole segment, or null. */
  zoom: number | null
  /** Silent game audio: the source has none, or the playback speed is not 1 (no atempo in the pinned FFmpeg). */
  silent: boolean
  gain: number
  /** Exact planned output length (before frame rounding). */
  exactSec: number
  frames: number
  flashes: Span[]
  captions: Array<Span & { caption: number }>
  dips: DipStep[]
}

export interface CardSegment {
  kind: 'card'
  which: 'intro' | 'outro'
  card: TitleCard
  exactSec: number
  frames: number
  /** Frame used for a 'blurFrame' background: source and source time. */
  frameAt: { source: string; t: number } | null
}

export type MontageSegment = ClipSegment | CardSegment

export interface MontageLayout {
  out: VideoSpec
  segments: MontageSegment[]
  /** Distinct caption texts; `ClipSegment.captions[].caption` indexes this list. */
  captions: string[]
  totalFrames: number
  /** Length the output will have: totalFrames / fps. */
  expectedSec: number
  /** Exact planned length (sum of item output lengths plus cards, as `planTotalSec`). */
  plannedSec: number
  /** Letterbox bar height in pixels (0: none). */
  letterboxBar: number
  /** Caption and card text heights in pixels. */
  captionHeightPx: number
  cardHeightPx: number
}

export interface LayoutOptions {
  format?: ExportFormat
  probes: Map<string, StreamProbe>
  silentSources?: ReadonlySet<string>
}

const EPS = 1e-9
/** Alpha steps of a dip (the pinned FFmpeg has no fade filter). */
export const DIP_STEPS = 6
const FLASH_ALPHA = 0.6
const LETTERBOX_RATIO = 2.39
const CARD_TEXT_SCALE = 1.6

export function itemOutputSec(it: MontageItem): number {
  return clipOutputSec({ in: it.start, out: it.end, speed: it.speed ?? 1, effects: it.effects ?? [] })
}

/** Exact planned length of a styled project (items plus cards). */
export function montagePlannedSec(items: MontageItem[], style: MontageProjectStyle): number {
  return items.reduce((s, it) => s + itemOutputSec(it), 0) + (style.intro?.durationSec ?? 0) + (style.outro?.durationSec ?? 0)
}

const effectWindow = (e: ClipEffect): Span => (e.kind === 'flash' ? { a: e.at, b: e.at + e.durationSec } : { a: e.at - e.durationSec / 2, b: e.at + e.durationSec / 2 })

interface Piece {
  seg: Omit<ClipSegment, 'frames'> | Omit<CardSegment, 'frames'>
}

/** Map a source-time interval into a sub-segment's local output time (null when they do not intersect). */
function toLocal(seg: { srcStart: number; srcEnd: number; rate: number }, a: number, b: number): Span | null {
  const x = Math.max(a, seg.srcStart)
  const y = Math.min(b, seg.srcEnd)
  if (y - x <= EPS) return null
  return { a: (x - seg.srcStart) * seg.rate, b: (y - seg.srcStart) * seg.rate }
}

function dipSteps(from: number, to: number, fadeIn: boolean, color: 'black' | 'white'): DipStep[] {
  const steps: DipStep[] = []
  const len = (to - from) / DIP_STEPS
  for (let j = 0; j < DIP_STEPS; j++) {
    steps.push({ a: from + j * len, b: from + (j + 1) * len, alpha: fadeIn ? 1 - j / DIP_STEPS : (j + 1) / DIP_STEPS, color })
  }
  return steps
}

function splitItem(it: MontageItem, index: number, items: MontageItem[], silentSource: boolean, captions: string[]): Array<Omit<ClipSegment, 'frames'>> {
  const speed = it.speed ?? 1
  const effects = it.effects ?? []
  const cuts = new Set<number>([it.start, it.end])
  for (const e of effects) {
    if (e.kind === 'flash') continue
    const w = effectWindow(e)
    for (const t of [w.a, w.b]) if (t > it.start + EPS && t < it.end - EPS) cuts.add(t)
  }
  const edges = [...cuts].sort((a, b) => a - b)
  const parts: Array<Omit<ClipSegment, 'frames'>> = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i]
    const b = edges[i + 1]
    if (b - a <= EPS) continue
    const mid = (a + b) / 2
    let stretch = 1
    let zoom: number | null = null
    for (const e of effects) {
      const w = effectWindow(e)
      if (mid < w.a || mid > w.b) continue
      if (e.kind === 'slowmo') stretch += 1 / e.speed - 1
      if (e.kind === 'zoomPunch') zoom = Math.max(zoom ?? 1, e.scale)
    }
    const rate = stretch / speed
    parts.push({
      kind: 'clip', itemIndex: index, source: it.source, srcStart: a, srcEnd: b, rate, zoom: zoom !== null && zoom > 1 ? zoom : null,
      silent: silentSource || Math.abs(rate - 1) > EPS, gain: it.gain ?? 1, exactSec: (b - a) * rate, flashes: [], captions: [], dips: []
    })
  }
  for (const p of parts) {
    for (const e of effects) {
      if (e.kind !== 'flash') continue
      const s = toLocal(p, e.at, e.at + e.durationSec)
      if (s) p.flashes.push(s)
    }
    if (it.overlay) {
      const s = toLocal(p, it.overlay.at, it.overlay.at + it.overlay.durationSec)
      if (s) {
        let ci = captions.indexOf(it.overlay.text)
        if (ci < 0) ci = captions.push(it.overlay.text) - 1
        p.captions.push({ ...s, caption: ci })
      }
    }
  }
  // Dips in item output time: fade in over the first half of this item's transition, fade out over the last half-length of
  // the next item's transition (so the dip is centred on the cut and the length is unchanged).
  const itemSec = parts.reduce((s, p) => s + p.exactSec, 0)
  const dips: DipStep[] = []
  const dipColor = (t: ProjectItem['transitionIn']): 'black' | 'white' | null => (t === 'dipBlack' ? 'black' : t === 'dipWhite' ? 'white' : null)
  const inColor = index > 0 ? dipColor(it.transitionIn) : null
  if (inColor && (it.transitionSec ?? 0) > 0) dips.push(...dipSteps(0, Math.min(itemSec / 2, (it.transitionSec ?? 0) / 2), true, inColor))
  const next = items[index + 1]
  const outColor = next ? dipColor(next.transitionIn) : null
  if (next && outColor && (next.transitionSec ?? 0) > 0) dips.push(...dipSteps(itemSec - Math.min(itemSec / 2, (next.transitionSec ?? 0) / 2), itemSec, false, outColor))
  let offset = 0
  for (const p of parts) {
    for (const d of dips) {
      const a = Math.max(d.a, offset) - offset
      const b = Math.min(d.b, offset + p.exactSec) - offset
      if (b - a > EPS) p.dips.push({ ...d, a, b })
    }
    offset += p.exactSec
  }
  return parts
}

/** Lay out a styled project: segments with frame counts, captions, output spec. */
export function layoutMontage(items: MontageItem[], style: MontageProjectStyle, opts: LayoutOptions): MontageLayout {
  const format = opts.format ?? DEFAULT_EXPORT_FORMAT
  const { spec } = concatRenderSpec([...new Set(items.map((it) => it.source))].map((s) => opts.probes.get(s)))
  const out = resolveOutputSpec(spec, format)
  const captions: string[] = []
  const pieces: Piece[] = []
  if (style.intro && style.intro.durationSec > 0) {
    const first = items[0]
    pieces.push({ seg: { kind: 'card', which: 'intro', card: style.intro, exactSec: style.intro.durationSec, frameAt: first ? { source: first.source, t: first.start } : null } })
  }
  items.forEach((it, i) => {
    for (const seg of splitItem(it, i, items, opts.silentSources?.has(it.source) === true, captions)) pieces.push({ seg })
  })
  if (style.outro && style.outro.durationSec > 0) {
    const last = items[items.length - 1]
    pieces.push({
      seg: { kind: 'card', which: 'outro', card: style.outro, exactSec: style.outro.durationSec, frameAt: last ? { source: last.source, t: Math.max(last.start, last.end - 1 / out.fps) } : null }
    })
  }
  const segments: MontageSegment[] = []
  let t = 0
  let prevFrame = 0
  for (const { seg } of pieces) {
    t += seg.exactSec
    const endFrame = Math.round(t * out.fps)
    const frames = endFrame - prevFrame
    prevFrame = endFrame
    // A sliver shorter than half a frame gets no frames; its neighbours absorb the time.
    if (frames > 0) segments.push({ ...seg, frames } as MontageSegment)
  }
  const preset = STYLE_PRESETS[style.style ?? 'clean']
  const bar = style.letterbox ? Math.round((out.height - out.width / LETTERBOX_RATIO) / 2) : 0
  return {
    out,
    segments,
    captions,
    totalFrames: prevFrame,
    expectedSec: prevFrame / out.fps,
    plannedSec: t,
    letterboxBar: bar > 1 ? bar : 0,
    captionHeightPx: Math.max(8, Math.round(out.height * preset.captionScale)),
    cardHeightPx: Math.max(8, Math.round(out.height * preset.captionScale * CARD_TEXT_SCALE))
  }
}

/**
 * Beat sync: snap each item's end so its output end lands on the nearest beat within ±`window` seconds (output time),
 * changing post-roll only. Never shrinks below 1 s, before the overlay or the end of any effect window, and never extends
 * past the source duration (unknown duration: shrink only). Items whose end lies inside a slow-mo window are left alone.
 */
export function snapItemsToBeats(
  items: MontageItem[],
  beats: readonly number[],
  introSec: number,
  sourceDuration: (source: string) => number | null,
  window = 0.3
): MontageItem[] {
  let t = introSec
  return items.map((it) => {
    const speed = it.speed ?? 1
    const effects = it.effects ?? []
    const endOut = t + itemOutputSec(it)
    const inSlowmo = effects.some((e) => e.kind === 'slowmo' && it.end >= e.at - e.durationSec / 2 - EPS && it.end <= e.at + e.durationSec / 2 + EPS)
    let next = it
    let best: number | null = null
    for (const b of beats) if (Math.abs(b - endOut) <= window && (best === null || Math.abs(b - endOut) < Math.abs(best - endOut))) best = b
    if (best !== null && !inSlowmo) {
      const end = it.end + (best - endOut) * speed
      const minEnd = Math.max(it.start + 1, it.overlay?.at ?? -Infinity, ...effects.map((e) => effectWindow(e).b))
      const dur = sourceDuration(it.source)
      const maxEnd = dur !== null ? dur : it.end
      if (end >= minEnd - EPS && end <= maxEnd + EPS) next = { ...it, end: Math.min(maxEnd, Math.max(minEnd, end)) }
    }
    t += itemOutputSec(next)
    return next
  })
}

const num = (v: number): string => {
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}
const between = (s: Span): string => `enable='between(t,${num(s.a)},${num(s.b)})'`
const box = (color: string, s: Span | null, alpha: number, area = 'x=0:y=0:w=iw:h=ih'): string =>
  `drawbox=${area}:color=${color}@${num(alpha)}:t=fill${s ? `:${between(s)}` : ''}`

function sourceSize(probe: StreamProbe | undefined, fallback: VideoSpec): Size {
  return probe && probe.width > 0 && probe.height > 0 ? { width: probe.width, height: probe.height } : { width: fallback.width, height: fallback.height }
}

/** Same reframe as the precise export (`itemFilter` in plan.ts): the source frame always letterboxes. */
export function montageReframe(probe: StreamProbe | undefined, out: VideoSpec, format: ExportFormat = DEFAULT_EXPORT_FORMAT): string {
  const size = sourceSize(probe, out)
  const mode = format.frame === 'source' ? 'bars' : format.reframe
  return reframeFilter(computeReframe(size, out, mode, format.offset), size)
}

/** Crop for a zoom punch with exactly the output aspect ratio (so the pixel aspect stays 1:1 after scaling back). */
export function zoomCrop(out: Size, scale: number): Size {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(out.width, out.height)
  const m = Math.max(1, Math.round(g / scale))
  let w = (out.width / g) * m
  let h = (out.height / g) * m
  if (w % 2 || h % 2) {
    w -= w % 2
    h -= h % 2
  }
  return { width: w, height: h }
}

const letterboxBoxes = (bar: number): string[] =>
  bar > 0 ? [box('black', null, 1, `x=0:y=0:w=iw:h=${bar}`), box('black', null, 1, `x=0:y=ih-${bar}:w=iw:h=${bar}`)] : []

export interface PngInput {
  path: string
  width: number
  height: number
}

/** Scale a text PNG to `heightPx` (and at most 90 % of the output width). */
export function fitText(png: Pick<PngInput, 'width' | 'height'>, heightPx: number, out: Size): Size {
  let h = heightPx
  let w = Math.round((png.width * h) / Math.max(1, png.height))
  const maxW = Math.floor(out.width * 0.9)
  if (w > maxW) {
    h = Math.max(2, Math.round((h * maxW) / w))
    w = maxW
  }
  return { width: Math.max(2, w + (w % 2)), height: Math.max(2, h + (h % 2)) }
}

const STRIP_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1']
const VIDEO_TIMESCALE = ['-video_track_timescale', '90000']
const PCM_OUT = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
const codecTag = (format: ExportFormat): string[] => (format.codec === 'h265' ? ['-tag:v', 'hvc1'] : [])

export interface SegmentArgsContext {
  layout: MontageLayout
  format?: ExportFormat
  encoder: string
  probe?: StreamProbe
  /** Rendered caption PNGs, indexed like `layout.captions`. */
  captionPngs: PngInput[]
  output: string
}

/** FFmpeg args for one clip segment (filter graph: reframe → speed → zoom → letterbox → flash → captions → dips). */
export function clipSegmentArgs(seg: ClipSegment, ctx: SegmentArgsContext): string[] {
  const { layout, encoder } = ctx
  const format = ctx.format ?? DEFAULT_EXPORT_FORMAT
  const { out } = layout
  const sec = seg.frames / out.fps
  // A little extra source so the frame count is always reached; -frames:v ends the segment.
  const inputSec = seg.srcEnd - seg.srcStart + 0.1
  const inputs: string[] = ['-ss', num(seg.srcStart), '-t', num(inputSec), '-i', seg.source]
  const captionIdx = [...new Set(seg.captions.map((c) => c.caption))]
  captionIdx.forEach((c) => inputs.push('-loop', '1', '-i', ctx.captionPngs[c].path))
  const silenceInput = 1 + captionIdx.length
  if (seg.silent) inputs.push(...SILENCE)

  const chain: string[] = [Math.abs(seg.rate - 1) > EPS ? `setpts=(PTS-STARTPTS)*${num(seg.rate)},fps=${num(out.fps)}` : 'setpts=PTS-STARTPTS']
  if (seg.zoom !== null) {
    const c = zoomCrop(out, seg.zoom)
    chain.push(`crop=${c.width}:${c.height}:(iw-${c.width})/2:(ih-${c.height})/2`, `scale=${out.width}:${out.height}:flags=bilinear`)
  }
  chain.push(...letterboxBoxes(layout.letterboxBar))
  for (const f of seg.flashes) chain.push(box('white', f, FLASH_ALPHA))
  const graph: string[] = [`[0:v]${montageReframe(ctx.probe, out, format)}[rf]`, `[rf]${chain.join(',')}[m0]`]
  let label = 'm0'
  seg.captions.forEach((c, i) => {
    const png = ctx.captionPngs[c.caption]
    const size = fitText(png, layout.captionHeightPx, out)
    const input = 1 + captionIdx.indexOf(c.caption)
    graph.push(`[${input}:v]scale=${size.width}:${size.height}:flags=bicubic[t${i}]`)
    graph.push(`[${label}][t${i}]overlay=x=(main_w-overlay_w)/2:y=main_h*2/3-overlay_h/2:${between(c)}[m${i + 1}]`)
    label = `m${i + 1}`
  })
  const tail = [...seg.dips.map((d) => box(d.color, d, d.alpha)), 'format=yuv420p']
  graph.push(`[${label}]${tail.join(',')}[v]`)
  graph.push(
    seg.silent
      ? `[${silenceInput}:a]atrim=duration=${num(sec)}[a]`
      : `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${num(seg.gain)},atrim=duration=${num(sec)}[a]`
  )
  return [
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-frames:v', String(seg.frames),
    ...videoEncodeArgs(encoder, out), ...codecTag(format),
    ...PCM_OUT, ...STRIP_METADATA, ...VIDEO_TIMESCALE, '-y', ctx.output
  ]
}

export interface CardArgsContext {
  layout: MontageLayout
  format?: ExportFormat
  encoder: string
  /** Card text PNG. */
  text: PngInput
  /** Downscaled frame PNG for 'blurFrame' (null: black background). */
  background: PngInput | null
  output: string
}

/** FFmpeg args for a title card: background (blurred frame or black), centered text, silence. */
export function cardSegmentArgs(seg: CardSegment, ctx: CardArgsContext): string[] {
  const { layout, encoder } = ctx
  const format = ctx.format ?? DEFAULT_EXPORT_FORMAT
  const { out } = layout
  const fps = num(out.fps)
  const sec = seg.frames / out.fps
  const bg = seg.card.background === 'blurFrame' && ctx.background
    ? ['-loop', '1', '-framerate', fps, '-i', ctx.background.path]
    : ['-f', 'lavfi', '-i', `color=c=black:s=${out.width}x${out.height}:r=${fps}`]
  const size = fitText(ctx.text, layout.cardHeightPx, out)
  const graph = [
    `[0:v]scale=${out.width}:${out.height}:flags=bilinear,fps=${fps},format=yuv420p[bg]`,
    `[1:v]scale=${size.width}:${size.height}:flags=bicubic[t]`,
    `[bg][t]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2${letterboxBoxes(layout.letterboxBar).map((b) => ',' + b).join('')},format=yuv420p[v]`,
    `[2:a]atrim=duration=${num(sec)}[a]`
  ]
  return [
    ...bg,
    '-loop', '1', '-framerate', fps, '-i', ctx.text.path,
    ...SILENCE,
    '-filter_complex', graph.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-frames:v', String(seg.frames),
    ...videoEncodeArgs(encoder, out), ...codecTag(format),
    ...PCM_OUT, ...STRIP_METADATA, ...VIDEO_TIMESCALE, '-y', ctx.output
  ]
}

/** Size of the downscaled background frame for 'blurFrame' cards (16× smaller, scaled back up bilinear when used). */
export function blurFrameSize(out: Size): Size {
  return { width: Math.max(2, Math.round(out.width / 16)), height: Math.max(2, Math.round(out.height / 16)) }
}

/** Grab one reframed, 16× downscaled frame as raw RGB24 (turned into a PNG in Node; the pinned FFmpeg has no PNG encoder). */
export function frameGrabArgs(source: string, t: number, probe: StreamProbe | undefined, layout: MontageLayout, format: ExportFormat | undefined, output: string): string[] {
  const s = blurFrameSize(layout.out)
  return [
    '-ss', num(Math.max(0, t)), '-i', source, '-map', '0:v:0', '-frames:v', '1',
    '-vf', `${montageReframe(probe, layout.out, format)},scale=${s.width}:${s.height}:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', output
  ]
}

/** Join the segment intermediates (concat list file) into the montage: video copied, audio PCM (music follows) or AAC (final). */
export function concatArgs(listFile: string, format: ExportFormat | undefined, audio: 'aac' | 'pcm', output: string): string[] {
  return [
    '-copyts', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', ...codecTag(format ?? DEFAULT_EXPORT_FORMAT),
    '-af', 'aresample=async=1:first_pts=0',
    ...(audio === 'aac' ? ['-c:a', 'aac', '-b:a', '192k'] : PCM_OUT),
    ...VIDEO_TIMESCALE, '-y', output
  ]
}

/** Decode any audio file (or a file's first audio stream) to interleaved f32le 48 kHz stereo. */
export function decodePcmArgs(input: string, maxSec: number | null, output: string): string[] {
  return ['-i', input, '-map', '0:a:0', '-vn', ...(maxSec !== null ? ['-t', num(maxSec)] : []), '-f', 'f32le', '-ar', '48000', '-ac', '2', '-y', output]
}

/** Final mux: video copied from the montage, the mixed PCM (audio-only AVI: no raw-PCM demuxer in the pinned build) encoded to AAC. */
export function muxArgs(montage: string, mixAvi: string, format: ExportFormat | undefined, output: string): string[] {
  return [
    '-i', montage, '-i', mixAvi,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...codecTag(format ?? DEFAULT_EXPORT_FORMAT),
    '-c:a', 'aac', '-b:a', '192k', ...VIDEO_TIMESCALE, '-y', output
  ]
}

/** Split a filter graph into filter names (labels, options and quoted expressions ignored). */
export function filterNames(graph: string): string[] {
  const names: string[] = []
  let cur = ''
  let quoted = false
  const flush = (): void => {
    const m = /^\s*(?:\[[^\]]*\]\s*)*([A-Za-z0-9_]+)/.exec(cur)
    if (m) names.push(m[1])
    cur = ''
  }
  for (const ch of graph) {
    if (ch === "'") quoted = !quoted
    if (!quoted && (ch === ',' || ch === ';')) flush()
    else cur += ch
  }
  flush()
  return names
}

/** Every filter an argv uses (`-vf`, `-af`, `-filter_complex` and lavfi inputs). */
export function argvFilterNames(args: readonly string[]): string[] {
  const names: string[] = []
  for (let i = 0; i < args.length - 1; i++) {
    if (['-vf', '-af', '-filter_complex'].includes(args[i])) names.push(...filterNames(args[i + 1]))
    if (args[i] === '-f' && args[i + 1] === 'lavfi' && args[i + 2] === '-i') names.push(...filterNames(args[i + 3]))
  }
  return names
}
