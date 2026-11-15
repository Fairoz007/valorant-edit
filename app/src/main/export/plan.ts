import path from 'path'
import { ProjectItem } from '../../renderer/editor/project'
import { concatCompatible, StreamProbe } from '../../shared/exportCompat'
import type { CopyCut } from './keyframe'
import { sourceSpec, concatRenderSpec, videoEncodeArgs, type VideoSpec } from './encodeQuality'
import { tr } from '../../shared/locale'
import { DEFAULT_EXPORT_FORMAT, encoderCodec, formatRequiresPrecise, type ExportFormat, type VideoCodec } from '../../shared/exportFormat'
import { resolveOutputSpec } from '../../shared/exportPresets'
import { computeReframe, reframeFilter, type Size } from '../../shared/reframe'

// Compatibility checks live in shared (the renderer's export drawer also uses them); re-export here to preserve the existing import path.
export { concatCompatible, extraSecondsForCopy } from '../../shared/exportCompat'
export type { StreamProbe } from '../../shared/exportCompat'

export interface FfmpegJob {
  args: string[]
  output: string
  tempFiles?: string[]
  /** Intermediate file (a normalized segment): not a final output and deleted after the job. */
  intermediate?: boolean
  /** Seconds of output this job produces, used to weight export progress. */
  durationSec?: number
}

export class NoEncoderError extends Error {
  constructor(message = 'No video encoder available for precise export') {
    super(message)
    this.name = 'NoEncoderError'
  }
}

const CODEC_LABEL: Record<VideoCodec, string> = { h264: 'H.264', h265: 'H.265' }

/** Shared by the IPC request validation and buildJobs. */
export function encoderMismatchMessage(encoder: string, codec: VideoCodec): string {
  return tr('所選的編碼器（{encoder}）無法輸出 {codec}，請選擇對應的編碼器', { encoder, codec: CODEC_LABEL[codec] })
}

export function escapeConcatPath(filePath: string): string {
  // Concat demuxer expects single quotes around path and single quotes escaped as '\'\''
  const normalized = filePath.replace(/\\/g, '/')
  const escaped = normalized.replace(/'/g, "'\\''")
  return `'${escaped}'`
}

export interface BuildJobsOptions {
  mode: 'separate' | 'concat'
  quality: 'copy' | 'precise'
  encoder?: string
  outDir: string
  baseName: string
  /**
   * For fast stream copy: cut points for each segment (same index as items)—the nearest keyframe before the start and adjusted end (seconds relative to source start_time).
   * When present, cut exactly from that keyframe; when null/missing, use the conservative method (see copyCutArgs).
   */
  copyCuts?: ReadonlyArray<CopyCut | null | undefined>
  /** Precise concatenation: add equal-length silence to sources known to have no audio track, keeping streams consistent. */
  silentSources?: ReadonlySet<string>
  /** Output frame, reframe mode, size, fps cap and codec; missing = DEFAULT_EXPORT_FORMAT (source size, H.264: the behaviour before reframing). */
  format?: ExportFormat
}

/**
 * For B-frame sources in containers that do not support PTS seeking (such as MP4), ffmpeg moves input `-ss` back by 3/23 seconds
 * before seeking (ffmpeg_demux's dts heuristic). If a keyframe is within 0.13 seconds before `-ss`, this can select the previous keyframe.
 * Set the seek point to "keyframe + 3/23 seconds + 1 ms", then use the same `-itsoffset` to restore timestamps so output time 0 is that keyframe.
 */
const SEEK_DTS_HEURISTIC_S = 3 / 23
const SEEK_MARGIN_S = 0.001
const KEYFRAME_SEEK_PAD_S = SEEK_DTS_HEURISTIC_S + SEEK_MARGIN_S

/** One video stream plus the first audio stream (audio is optional); omit source chapters and metadata (MKV DURATION/title tags become invalid MP4 udta). */
const STREAM_SELECT = ['-map', '0:v:0', '-map', '0:a:0?']
const STRIP_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1']
// Bound the MP4/MOV timescale: inferred VFR rates can otherwise produce INT_MAX timescales that break editor compatibility.
const VIDEO_TIMESCALE = ['-video_track_timescale', '90000']
/**
 * In open-GOP sources, leading B-frames decoded after a keyframe but displayed before it reference the previous GOP (which was cut away) and cannot be decoded.
 * They are hidden by the edit list in a single file but can fall into the previous segment's time range after concatenation; drop them directly (closed GOPs have none, so this has no effect).
 */
const DROP_LEADING_PICTURES = 'lt(pts\\,startpts)'
const AUDIO_AAC = ['-c:a', 'aac', '-b:a', '192k']

const secs = (v: number): string => v.toFixed(3)
const preciseSecs = (v: number): string => v.toFixed(6)
/** Truncate video separately at videoCutRel (seconds relative to output time 0, compared by DTS), allowing audio to last until the final video frame finishes. */
const videoBsf = (videoCutRel?: number): string[] => [
  '-bsf:v',
  `noise=drop=${DROP_LEADING_PICTURES}${videoCutRel === undefined ? '' : `+gte(dts*tb\\,${preciseSecs(videoCutRel)})`}`
]
const durationOf = (item: ProjectItem): string => secs(Math.max(0.1, item.end - item.start))
const clipSeconds = (item: ProjectItem): number => Math.max(0, item.end - item.start)
const totalSeconds = (items: ProjectItem[]): number => items.reduce((s, it) => s + clipSeconds(it), 0)

/**
 * Fast stream-copy a segment:
 * - Known keyframe K: start copying from K, making the first packet a keyframe with timestamp 0; no MP4 edit list is needed to hide extra frames.
 *   Drop audio packets before K (`-copypriorss:a 0`) so audio does not start before video; truncate video at cut.videoCut (no gap at the B-frame tail),
 *   and audio at cut.end (when the final video frame finishes), avoiding silence before the next segment.
 * - Unknown K: seek from the segment start as before (ffmpeg backs up to the previous keyframe), then shift the whole segment to start at 0 with `-avoid_negative_ts make_zero`,
 *   also avoiding an edit list that skips frames.
 */
function usableCut(item: ProjectItem, cut: CopyCut | null | undefined): cut is CopyCut {
  if (!cut || !Number.isFinite(cut.keyframe) || !Number.isFinite(cut.end)) return false
  return cut.keyframe <= item.start && cut.keyframe > -KEYFRAME_SEEK_PAD_S && cut.end > cut.keyframe
}

export function copyCutArgs(item: ProjectItem, cut: CopyCut | null | undefined, output: string): string[] {
  if (usableCut(item, cut)) {
    const { keyframe } = cut
    const videoCut = cut.videoCut !== undefined && Number.isFinite(cut.videoCut) && cut.videoCut < cut.end ? cut.videoCut - keyframe : undefined
    return [
      '-ss',
      preciseSecs(keyframe + KEYFRAME_SEEK_PAD_S),
      '-itsoffset',
      preciseSecs(KEYFRAME_SEEK_PAD_S),
      '-i',
      item.source,
      '-t',
      preciseSecs(cut.end - keyframe),
      ...STREAM_SELECT,
      '-c',
      'copy',
      ...videoBsf(videoCut),
      '-copypriorss:a',
      '0',
      ...STRIP_METADATA,
      ...VIDEO_TIMESCALE,
      '-y',
      output
    ]
  }
  return [
    '-ss',
    secs(item.start),
    '-i',
    item.source,
    '-t',
    durationOf(item),
    ...STREAM_SELECT,
    '-c',
    'copy',
    ...videoBsf(),
    '-avoid_negative_ts',
    'make_zero',
    ...STRIP_METADATA,
    ...VIDEO_TIMESCALE,
    '-y',
    output
  ]
}

/**
 * Actual quality used: stream copy switches to precise (with a notice) when the output format needs re-encoding
 * (reframing, resizing, a frame-rate cap or H.265), or, for concatenation, when source specs are incompatible.
 */
export function resolveQuality(
  items: ProjectItem[],
  opts: Pick<BuildJobsOptions, 'mode' | 'quality' | 'format'>,
  probes: Map<string, StreamProbe>
): { quality: 'copy' | 'precise'; notices: string[] } {
  if (opts.quality === 'copy' && formatRequiresPrecise(opts.format ?? DEFAULT_EXPORT_FORMAT)) {
    return {
      quality: 'precise',
      notices: [tr('這個輸出格式需要重新編碼（調整畫面比例、尺寸、影格率上限或 H.265 都無法直接複製串流），已自動切換為精準轉碼模式')]
    }
  }
  if (opts.mode === 'concat' && opts.quality === 'copy') {
    // Compare each source only once.
    const probeList = [...new Set(items.map((it) => it.source))].map((src) => probes.get(src)).filter((p): p is StreamProbe => !!p)
    const check = concatCompatible(probeList)
    if (!check.ok) {
      return { quality: 'precise', notices: [tr('影片規格不相容（{reason}），已自動切換為精準轉碼模式', { reason: check.reason })] }
    }
  }
  return { quality: opts.quality, notices: [] }
}

export function buildJobs(
  items: ProjectItem[],
  opts: BuildJobsOptions,
  probes: Map<string, StreamProbe>
): { jobs: FfmpegJob[]; notices: string[]; concatListContent?: string } {
  const { quality, notices } = resolveQuality(items, opts, probes)

  if (quality === 'precise' && !opts.encoder) {
    throw new NoEncoderError()
  }
  const codec = (opts.format ?? DEFAULT_EXPORT_FORMAT).codec
  if (quality === 'precise' && encoderCodec(opts.encoder!) !== codec) {
    // Never write H.264 into a file the user asked to be H.265 (or the reverse).
    throw new Error(encoderMismatchMessage(opts.encoder!, codec))
  }

  if (opts.mode === 'concat') {
    return quality === 'copy' ? buildCopyConcat(items, opts, notices) : buildPreciseConcat(items, opts, probes, notices)
  }

  const format = opts.format ?? DEFAULT_EXPORT_FORMAT
  const jobs: FfmpegJob[] = items.map((item, idx) => {
    const output = path.join(opts.outDir, `${opts.baseName}_${idx + 1}.mp4`)
    const durationSec = clipSeconds(item)
    if (quality === 'copy') return { args: copyCutArgs(item, opts.copyCuts?.[idx], output), output, durationSec }
    const probe = probes.get(item.source)
    const src = sourceSpec(probe)
    const out = resolveOutputSpec(src, format)
    const vf = needsReframe(format, src, out) ? ['-vf', itemFilter(probe, src, out, format)] : mainProfilePixFmt(format)
    // Bitrate follows the output spec (a 1080×1920@60 Short is encoded for 1080×1920@60, not for the source).
    const video = [...videoEncodeArgs(opts.encoder!, out), ...codecTag(format)]
    // Put -ss before -i: precise seeking when transcoding, without decoding from the start of the file to the cut (I8).
    const args = ['-ss', secs(item.start), '-i', item.source, '-t', durationOf(item), ...STREAM_SELECT, ...vf, ...video, ...AUDIO_AAC, ...STRIP_METADATA, ...VIDEO_TIMESCALE, '-y', output]
    return { args, output, durationSec }
  })
  return { jobs, notices }
}

/** H.265 in MP4/MOV: tag the track `hvc1` so Apple players, browsers and editors recognise it (FFmpeg's default `hev1` is often rejected). */
const codecTag = (format: ExportFormat): string[] => (format.codec === 'h265' ? ['-tag:v', 'hvc1'] : [])

/**
 * HEVC Main profile is 8-bit 4:2:0: without a reframe filter (which ends in format=yuv420p), a 10-bit or 4:4:4 source would make the
 * encoder fail, so convert explicitly. H.264 keeps its existing args unchanged.
 */
const mainProfilePixFmt = (format: ExportFormat): string[] => (format.codec === 'h265' ? ['-pix_fmt', 'yuv420p'] : [])

/** A filter is needed to change the frame shape, apply an explicit size, or lower the frame rate. */
function needsReframe(format: ExportFormat, src: VideoSpec, out: VideoSpec): boolean {
  return format.frame !== 'source' || format.width !== null || format.height !== null || out.fps < src.fps
}

/** Real source size for the geometry (odd sizes stay odd so the filter can drop the last row/column); unknown → the fallback spec. */
function sourceSize(probe: StreamProbe | undefined, fallback: VideoSpec): Size {
  return probe && probe.width > 0 && probe.height > 0 ? { width: probe.width, height: probe.height } : { width: fallback.width, height: fallback.height }
}

/** `-vf` for one source into the output spec. The source frame (only resized/normalized) always letterboxes; other frames use the chosen reframe mode. */
function itemFilter(probe: StreamProbe | undefined, fallback: VideoSpec, out: VideoSpec, format: ExportFormat): string {
  const size = sourceSize(probe, fallback)
  const mode = format.frame === 'source' ? 'bars' : format.reframe
  return reframeFilter(computeReframe(size, out, mode, format.offset), size)
}

const segmentTag = (): string => Math.random().toString(36).slice(2, 8)
const segmentPath = (outDir: string, tag: string, idx: number, ext: string): string => path.join(outDir, `.aditor-seg-${tag}-${idx + 1}${ext}`)

/**
 * Build a concat demuxer list. When the actual playback end of each segment was measured (see parseMediaEnd in keyframe.ts), add `duration`
 * so the next segment starts exactly after the previous segment's last frame instead of relying on MP4 duration summed from DTS, which may be too short.
 */
export function concatList(files: ReadonlyArray<string>, durations: ReadonlyArray<number | null | undefined> = []): string {
  const lines: string[] = []
  files.forEach((f, i) => {
    lines.push(`file ${escapeConcatPath(f)}`)
    const d = durations[i]
    if (d !== null && d !== undefined && Number.isFinite(d) && d > 0) lines.push(`duration ${d.toFixed(6)}`)
  })
  return lines.join('\n') + '\n'
}

/**
 * Input for concatenating intermediate files. `-copyts`: ffmpeg estimates concat input start_time from the first timestamp of each stream (for some video codecs it cannot estimate one,
 * leaving only the audio start, such as 0.013 seconds). Without this flag, the whole timeline shifts, the first video frame gets a negative timestamp, and the edit list hides it.
 * Intermediate files already start at 0, so keep their timestamps as-is.
 */
const CONCAT_INPUT = ['-copyts', '-f', 'concat', '-safe', '0', '-i', 'LIST_FILE_PLACEHOLDER']
const listOf = (jobs: FfmpegJob[]): string => concatList(jobs.map((j) => j.output))

/**
 * Fast stream-copy concatenation: do not read sources directly with concat demuxer inpoint/outpoint. With long-GOP encoding, packets from the previous keyframe
 * before the inpoint overlap the prior segment's timestamps (Non-monotonic DTS), causing playback to stall at the boundary and audio to overrun and desynchronize.
 * Instead, stream-copy each segment from a keyframe into an intermediate file (each starts at 0 with a keyframe as its first frame), then join them with the concat demuxer.
 */
function buildCopyConcat(
  items: ProjectItem[],
  opts: BuildJobsOptions,
  notices: string[]
): { jobs: FfmpegJob[]; notices: string[]; concatListContent: string } {
  const tag = segmentTag()
  const segments: FfmpegJob[] = items.map((item, idx) => {
    const output = segmentPath(opts.outDir, tag, idx, '.mp4')
    return { intermediate: true, output, args: copyCutArgs(item, opts.copyCuts?.[idx], output), durationSec: clipSeconds(item) }
  })
  const output = path.join(opts.outDir, `${opts.baseName}.mp4`)
  const final: FfmpegJob = {
    output,
    durationSec: totalSeconds(items),
    args: [...CONCAT_INPUT, ...STREAM_SELECT, '-c', 'copy', ...VIDEO_TIMESCALE, '-y', output]
  }
  return { jobs: [...segments, final], notices, concatListContent: listOf(segments) }
}

/**
 * Precise concatenation: transcode each segment to an intermediate file using input-side `-ss` (precise seek), then join with concat demuxer, copying video and encoding the full audio stream to AAC once.
 * - Do not transcode sources directly with inpoint: audio packets before the inpoint are decoded too, adding up to one GOP of sound at each boundary and increasing A/V desynchronization.
 * - Use PCM audio in intermediate .mov files: each AAC segment has 1024 samples of priming, which makes audio timestamps go backward at joins and adds a blank edit to the first video track
 *   (editing software displays a black first frame). PCM has no priming, so encode AAC only once at the end.
 * - Add scale/pad/fps/format normalization only when sources may have different specs (concat requires matching specs for every segment)
 *   or the output format reframes/resizes/caps the frame rate; clips from the same source already match, so otherwise do not change frame rate or resolution.
 *   Every segment's filter is computed from its own source size into the one output spec (mixed sources letterbox into the timeline spec).
 */
function buildPreciseConcat(
  items: ProjectItem[],
  opts: BuildJobsOptions,
  probes: Map<string, StreamProbe>,
  notices: string[]
): { jobs: FfmpegJob[]; notices: string[]; concatListContent: string } {
  const format = opts.format ?? DEFAULT_EXPORT_FORMAT
  const { spec, normalize } = concatRenderSpec([...new Set(items.map((it) => it.source))].map((src) => probes.get(src)))
  const out = resolveOutputSpec(spec, format)
  const filtered = normalize || needsReframe(format, spec, out)
  const video = [...videoEncodeArgs(opts.encoder!, out), ...codecTag(format)]
  const tag = segmentTag()
  const segments: FfmpegJob[] = items.map((item, idx) => {
    const output = segmentPath(opts.outDir, tag, idx, '.mov')
    const vf = filtered ? ['-vf', itemFilter(probes.get(item.source), spec, out, format)] : mainProfilePixFmt(format)
    const silent = opts.silentSources?.has(item.source) === true
    const audioInput = silent ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []
    const streams = silent ? ['-map', '0:v:0', '-map', '1:a:0'] : STREAM_SELECT
    return {
      intermediate: true,
      output,
      durationSec: clipSeconds(item),
      args: ['-ss', secs(item.start), '-i', item.source, ...audioInput, '-t', durationOf(item), ...streams, ...vf, ...video, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', ...(silent ? ['-shortest'] : []), ...STRIP_METADATA, ...VIDEO_TIMESCALE, '-y', output]
    }
  })
  const output = path.join(opts.outDir, `${opts.baseName}.mp4`)
  const final: FfmpegJob = {
    output,
    durationSec: totalSeconds(items),
    // Fill small gaps in audio timestamps; sources without audio already have silence in their intermediate files.
    args: [...CONCAT_INPUT, ...STREAM_SELECT, '-c:v', 'copy', ...codecTag(format), '-af', 'aresample=async=1:first_pts=0', ...AUDIO_AAC, ...VIDEO_TIMESCALE, '-y', output]
  }
  const allNotices = normalize ? [...notices, tr('來源規格不同，已先將每段轉成相同規格再合併')] : notices
  return { jobs: [...segments, final], notices: allNotices, concatListContent: listOf(segments) }
}

/**
 * Find a filename stem that does not overwrite existing files (I6): try `<base>`, `<base> (2)`, `<base> (3)`…
 * until none of the output files for that mode exist.
 */
export function resolveFreeBaseName(
  outDir: string,
  baseName: string,
  mode: 'separate' | 'concat',
  count: number,
  exists: (p: string) => boolean
): { baseName: string; renamed: boolean } {
  const outputs = (b: string): string[] =>
    mode === 'separate' ? Array.from({ length: count }, (_, i) => path.join(outDir, `${b}_${i + 1}.mp4`)) : [path.join(outDir, `${b}.mp4`)]
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? baseName : `${baseName} (${n})`
    if (!outputs(candidate).some(exists)) return { baseName: candidate, renamed: n > 1 }
  }
  return { baseName: `${baseName} (${Date.now()})`, renamed: true }
}
