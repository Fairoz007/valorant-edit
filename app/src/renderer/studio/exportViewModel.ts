import { Project } from '../editor/project'
import { concatCompatible, extraSecondsForCopy, StreamProbe, UNKNOWN_PROBE } from '../../shared/exportCompat'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import { concatRenderSpec, sourceSpec, type VideoSpec } from '../../shared/encodeQuality'
import { DEFAULT_EXPORT_FORMAT, encodersForCodec, formatRequiresPrecise, type ExportFormat, type VideoCodec } from '../../shared/exportFormat'
import { projectHasStyling } from '../../shared/autoEditProject'
import { lengthWarning, maxSecondsFor, resolveOutputSpec, trimItemsToSeconds } from '../../shared/exportPresets'
import { computeReframe, type ReframeGeometry, type Size } from '../../shared/reframe'
import { effectiveFormat, hevcUnavailable } from './exportController'
import { i18n } from '../i18n'
import { tr } from '../../shared/locale'

/** Source video metadata (returned by engine:probe); optional stream parameters remain unknown when unavailable. */
export interface SourceInfo {
  codec: string
  width: number
  height: number
  fps?: number
  pix_fmt?: string
  acodec?: string
  sample_rate?: number
  channels?: number
}

export interface ExportPlan {
  mode: 'concat' | 'separate'
  quality: 'copy' | 'precise'
/** Keyed by source path; omit sources that could not be probed (treat as unknown and do not use to detect mismatches). */
  sources: Record<string, SourceInfo | undefined>
/** Keyframe times keyed by source path (currently available only for the analyzed current video). */
  keyframes: Record<string, number[] | undefined>
/** IDs of clips with missing sources (ProjectProvider.missingItemIds). */
  missingItemIds: ReadonlySet<string>
}

/** The user's format choices (independent of the probe results, so they show before probing finishes). */
export interface ExportChoice {
  /** Output format chosen by the user (default: source frame, H.264). */
  format?: ExportFormat
  /** "Export only the first N seconds" of the selected preset's limit. */
  trimToLimit?: boolean
  /** Export mode while the plan is not ready yet (the plan's mode wins). */
  mode?: 'concat' | 'separate'
}

export interface Notice {
  kind: 'info' | 'warn'
  text: string
}

export interface ExportEncoders {
  encoders: string[]
/** Whether the OpenH264 DLL is installed. */
  openh264: boolean
  /** False while detection is still running; an empty list then means unknown. */
  detected?: boolean
}

/** Data for the summary line above the Export button. */
export interface ExportSummary {
  width: number
  height: number
  fps: number
  codec: VideoCodec
  bytes: number
  /** Exported length (after the optional trim). */
  seconds: number
  /** Separate mode with sources of different sizes: the size shown is the first clip's. */
  varies: boolean
}

export interface ExportViewModel {
  notices: Notice[]
  estimatedBytes: number
  copyAvailable: boolean
  /** Why fast lossless is unavailable (inline reason), or null when it is available. */
  copyReason: string | null
/** Average extra seconds at each clip start for fast lossless; null for other modes or without keyframe data (never fabricate a number). */
  extraSecondsHint: number | null
  canStart: boolean
  blockers: string[]
/** Quality that will actually be used (fast lossless automatically switches to precise for a merged export with mismatched sources or a reframed format). */
  effectiveQuality: 'copy' | 'precise'
/** Whether OpenH264 must be acquired first (precise re-encoding, no available encoder, and not already installed). */
  openh264Required: boolean
  /** Format that will be exported (an unavailable H.265 choice falls back to H.264). */
  format: ExportFormat
  mode: 'concat' | 'separate'
  /** Detection confirmed that no HEVC encoder works: H.265 is disabled. */
  h265Unavailable: boolean
  /** The user's (persisted) H.265 choice is being exported as H.264 because H.265 is unavailable. */
  codecFallback: boolean
  /** Output spec of the timeline (concat) or the first clip (separate). */
  outSpec: VideoSpec
  /** Spec the output is derived from: the concat timeline, or the first clip's source (separate). */
  srcSpec: VideoSpec
  summary: ExportSummary
  /** Over the selected preset's length limit (a warning, never a block). */
  lengthWarning: { maxSeconds: number; seconds: number } | null
  /** Items that will actually be exported (trimmed when the trim option is on). */
  exportItems: Project['items']
}

function toProbe(i: SourceInfo): StreamProbe {
  // Preserve stream metadata when available; use 0/empty string for unknown (see concatCompatible).
  return { vcodec: i.codec, width: i.width, height: i.height, fps: i.fps ?? 0, pix_fmt: i.pix_fmt ?? '', acodec: i.acodec ?? '', sample_rate: i.sample_rate ?? 0, channels: i.channels ?? 0 }
}

const itemSeconds = (items: ReadonlyArray<{ start: number; end: number }>): number =>
  items.reduce((s, it) => s + (Number.isFinite(it.end - it.start) && it.end > it.start ? it.end - it.start : 0), 0)

/** Derived state for the export settings page (pure function). Reuse shared/exportCompat for compatibility checks, the same logic as main's buildJobs. */
export function exportViewModel(project: Project, plan: ExportPlan | null, enc: ExportEncoders, choice: ExportChoice = {}): ExportViewModel {
  const t = i18n.export
  const notices: Notice[] = []
  const blockers: string[] = []
  const items = project.items
  const detected = enc.detected !== false
  const chosen = choice.format ?? DEFAULT_EXPORT_FORMAT
  const format = effectiveFormat(chosen, enc.encoders, detected)
  const h265Unavailable = hevcUnavailable(enc.encoders, detected)
  const codecFallback = chosen.codec !== format.codec
  const mode = plan?.mode ?? choice.mode ?? 'concat'

  if (items.length === 0) blockers.push(t.blockEmpty)

  const missingSources: string[] = []
  if (plan) {
    for (const it of items) {
      if (plan.missingItemIds.has(it.id) && !missingSources.includes(it.source)) missingSources.push(it.source)
    }
  }
  for (const s of missingSources) blockers.push(t.blockMissingSource.replace('{path}', s))

  const probes = new Map<string, StreamProbe>()
  for (const src of new Set(items.map((it) => it.source))) {
    const info = plan?.sources[src]
    // Main substitutes the same unknown probe for a failed probe, which rules out stream copy; match it here.
    probes.set(src, info ? toProbe(info) : UNKNOWN_PROBE)
  }
  let compatible = true
  let compatReason = ''
  if (plan && plan.mode === 'concat') {
    const check = concatCompatible([...probes.values()])
    if (!check.ok) {
      compatible = false
      compatReason = check.reason ?? ''
    }
  }
  // Styled (Auto edit) projects are rendered by the montage stage, which always re-encodes, like a reframed format.
  const formatNeedsPrecise = formatRequiresPrecise(format) || projectHasStyling(project)
  const copyAvailable = compatible && !formatNeedsPrecise
  // The format reason wins: it is the one the user just chose and can undo here.
  const copyReason = formatNeedsPrecise ? t.copyNeedsReencode : compatible ? null : t.qualityCopyUnavailable
  if (!compatible && !formatNeedsPrecise && plan?.quality === 'copy') {
    notices.push({ kind: 'warn', text: tr('{label}（{detail}）', { label: t.fallbackReencodeNotice, detail: compatReason }) })
  }
  if (codecFallback) notices.push({ kind: 'info', text: t.h265FallbackNotice })

  const effectiveQuality: 'copy' | 'precise' = plan && plan.quality === 'copy' && copyAvailable ? 'copy' : 'precise'

  let extraSecondsHint: number | null = null
  if (plan && effectiveQuality === 'copy') {
    const gaps: number[] = []
    for (const it of items) {
      const kf = plan.keyframes[it.source]
      if (kf && kf.length > 0) gaps.push(extraSecondsForCopy(it.start, kf))
    }
    if (gaps.length > 0) extraSecondsHint = gaps.reduce((a, b) => a + b, 0) / gaps.length
  }

  const needsEncoder = plan !== null && effectiveQuality === 'precise'
  const noEncoder = detected && encodersForCodec(enc.encoders, format.codec).length === 0
  const openh264Required = needsEncoder && noEncoder && format.codec === 'h264' && !enc.openh264
  if (needsEncoder && noEncoder && enc.openh264) blockers.push(t.blockNoEncoder)

  // Length limit: a warning with an optional trim (never a block). The trim affects size, duration and what is sent to main.
  const warning = lengthWarning(items, mode, format)
  const limit = choice.trimToLimit ? maxSecondsFor(format) : null
  const exportItems = limit !== null ? trimItemsToSeconds(items, limit, mode) : items

  const canStart = plan !== null && items.length > 0 && missingSources.length === 0 && !(needsEncoder && (noEncoder || !detected))
  const estimatedBytes = estimateOutputBytes({ items: exportItems }, effectiveQuality, probes, mode, format)

  const specOf = (source: string): VideoSpec => sourceSpec(probes.get(source))
  const srcSpec = mode === 'concat'
    ? concatRenderSpec([...probes.values()]).spec
    : items.length > 0 ? specOf(items[0].source) : sourceSpec(undefined)
  const outSpec = resolveOutputSpec(srcSpec, format)
  const varies = mode === 'separate' &&
    new Set(items.map((it) => { const o = resolveOutputSpec(specOf(it.source), format); return `${o.width}x${o.height}@${o.fps}` })).size > 1
  const summary: ExportSummary = {
    width: outSpec.width,
    height: outSpec.height,
    fps: outSpec.fps,
    codec: format.codec,
    bytes: estimatedBytes,
    seconds: itemSeconds(exportItems),
    varies
  }

  return {
    notices,
    estimatedBytes,
    copyAvailable,
    copyReason,
    extraSecondsHint,
    canStart,
    blockers,
    effectiveQuality,
    openh264Required,
    format,
    mode,
    h265Unavailable,
    codecFallback,
    outSpec,
    srcSpec,
    summary,
    lengthWarning: warning,
    exportItems
  }
}

/** Video the preview image comes from (normally the player's current video). */
export interface PreviewSource {
  width: number
  height: number
  fps?: number
}

/**
 * Reframe geometry for the preview image, computed exactly as the export computes it for that source:
 * concat renders every clip to the timeline's output spec; separate resolves the output spec from the clip's own source.
 * Without a preview source the first clip's probed source is used (unknown sizes fall back like the export does).
 */
export function previewGeometry(
  project: Project,
  plan: ExportPlan | null,
  vm: ExportViewModel,
  source?: PreviewSource | null
): { src: Size; geometry: ReframeGeometry } {
  const first = project.items[0] ? plan?.sources[project.items[0].source] : undefined
  const info: PreviewSource | undefined = source && source.width > 0 && source.height > 0 ? source : first
  const probe = info ? toProbe({ codec: '', ...info }) : undefined
  const spec = sourceSpec(probe)
  // The real (possibly odd) source size: computeReframe drops an odd last row/column itself, as the export does.
  const src: Size = info ? { width: info.width, height: info.height } : { width: spec.width, height: spec.height }
  const out = vm.mode === 'separate' ? resolveOutputSpec(spec, vm.format) : vm.outSpec
  return { src, geometry: computeReframe(src, out, vm.format.reframe, vm.format.offset) }
}

/** Format bytes as e.g. "1.6 GB" or "212 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 MB'
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
}

/** Frame rate for display: integers as-is, fractional rates with up to two decimals (59.94). */
export function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 100) / 100)
}

/** Whether remaining disk space is insufficient (estimated size × 1.1, same threshold as main's checkDiskSpace). */
export function diskIsLow(freeBytes: number, estimateBytes: number): boolean {
  return freeBytes < estimateBytes * 1.1
}
