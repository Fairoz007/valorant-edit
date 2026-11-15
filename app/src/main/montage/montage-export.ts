/**
 * Montage render pipeline: the same building blocks as the UI export (`buildJobs` + `runExport`) without the UI's single export slot.
 * Always precise concatenation in the preset's format, H.264, with the best working encoder (hardware first, libopenh264 last).
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { buildJobs, concatList, resolveFreeBaseName, type StreamProbe } from '../export/plan'
import { encoderFailureHint, partialPathFor, runExport, type ExportPriority, type RunExportOptions } from '../export/run'
import { createAudioProbe, createMediaEndProbe, defaultFfprobePath, measureMediaEnds, type AudioProbe, type MediaEndProbe } from '../export/keyframe'
import { detectEncoders, ENCODER_PRIORITY } from '../export/encoders'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import type { ExportFormat } from '../../shared/exportFormat'
import type { ProjectItem } from '../../renderer/editor/project'
import { tr } from '../../shared/locale'

export interface MontageRenderRequest {
  items: ProjectItem[]
  outDir: string
  /** File stem; a free name is chosen (" (2)") so an existing file is never replaced. */
  baseName: string
  format: ExportFormat
  /** Source stream info (from the analysis cache); unknown fields fall back to export defaults. */
  probes: Map<string, StreamProbe>
  totalSec: number
}

export interface MontageRenderControl {
  signal: AbortSignal
  /** 0..1 */
  onProgress?: (progress: number) => void
  priority?: () => ExportPriority
  /** Called with the final output path before ffmpeg starts, so an interrupted export can be cleaned up after a restart. */
  onPlanned?: (outputPath: string) => void
}

export type MontageRenderResult =
  | { ok: true; outputPath: string; encoder: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; code: 'encoder' | 'export'; error: string }

export type MontageRenderer = (req: MontageRenderRequest, control: MontageRenderControl) => Promise<MontageRenderResult>

export interface MontageRendererDeps {
  /** Working encoders (cached by the caller or here); defaults to `detectEncoders()`. */
  detectEncoders?: () => Promise<string[]>
  ffmpeg?: RunExportOptions['ffmpeg']
  tempDir?: string
  hasAudio?: AudioProbe
  mediaEnd?: MediaEndProbe
  run?: typeof runExport
}

/** Bytes needed at peak: precise concat writes PCM intermediate segments before the final file, so count the estimate twice. */
export function montageDiskEstimate(items: ProjectItem[], probes: Map<string, StreamProbe>, format: ExportFormat): number {
  return estimateOutputBytes({ items }, 'precise', probes, 'concat', format) * 2
}

export function createMontageRenderer(deps: MontageRendererDeps = {}): MontageRenderer {
  let detected: Promise<string[]> | null = null
  const encoders = (): Promise<string[]> => {
    if (!detected) {
      detected = (deps.detectEncoders ?? (() => detectEncoders()))().then(
        (list) => {
          // No usable H.264 encoder (driver hiccup, OpenH264 DLL installed later) is re-detected next time.
          if (!ENCODER_PRIORITY.h264.some((enc) => list.includes(enc))) detected = null
          return list
        },
        () => {
          detected = null
          return []
        }
      )
    }
    return detected
  }
  const run = deps.run ?? runExport

  return async (req, control) => {
    const { signal } = control
    if (signal.aborted) return { ok: false, cancelled: true }
    const working = await encoders()
    const candidates = ENCODER_PRIORITY.h264.filter((enc) => working.includes(enc))
    if (candidates.length === 0) return { ok: false, code: 'encoder', error: tr('找不到可用的影片編碼器，無法製作精華合輯') }

    const hasAudio = deps.hasAudio ?? createAudioProbe()
    const silentSources = new Set<string>()
    for (const source of new Set(req.items.map((it) => it.source))) {
      if ((await hasAudio(source, signal)) === false) silentSources.add(source)
      if (signal.aborted) return { ok: false, cancelled: true }
    }

    let lastError = ''
    for (const [i, encoder] of candidates.entries()) {
      if (signal.aborted) return { ok: false, cancelled: true }
      const free = resolveFreeBaseName(req.outDir, req.baseName, 'concat', 1, (p) => fs.existsSync(p))
      let built: ReturnType<typeof buildJobs>
      try {
        built = buildJobs(req.items, { mode: 'concat', quality: 'precise', encoder, outDir: req.outDir, baseName: free.baseName, silentSources, format: req.format }, req.probes)
      } catch (err) {
        return { ok: false, code: 'export', error: (err as Error).message }
      }
      const { jobs, concatListContent: staticList } = built
      const final = jobs.find((j) => !j.intermediate)
      if (!final || jobs.some((j) => path.dirname(path.resolve(j.output)) !== path.resolve(req.outDir))) {
        return { ok: false, code: 'export', error: tr('輸出路徑不正確') }
      }
      control.onPlanned?.(final.output)
      const segmentFiles = jobs.filter((j) => j.intermediate).map((j) => j.output)
      const measure = deps.mediaEnd ?? createMediaEndProbe()
      const concatListContent = staticList && segmentFiles.length > 0
        ? async (): Promise<string> => concatList(segmentFiles, await measureMediaEnds(segmentFiles, measure, signal))
        : staticList
      const result = await run(
        {
          jobs,
          totalEstimatedSeconds: req.totalSec,
          outDir: req.outDir,
          estimatedBytes: estimateOutputBytes({ items: req.items }, 'precise', req.probes, 'concat', req.format),
          concatListContent,
          ffmpeg: deps.ffmpeg,
          tempDir: deps.tempDir,
          priority: control.priority
        },
        {
          signal,
          onProgress: (p) => control.onProgress?.(Math.min(1, Math.max(0, p.percent / 100)))
        }
      )
      if (result.ok) {
        const outputPath = result.outputs[0]
        if (!outputPath) return { ok: false, code: 'export', error: tr('匯出沒有產生輸出檔') }
        return { ok: true, outputPath, encoder }
      }
      if (result.cancelled) return { ok: false, cancelled: true }
      lastError = result.error
      // A hardware encoder that refuses this size or driver falls back to the next one (libopenh264 last).
      const more = i < candidates.length - 1
      if (!more || !encoderFailureHint(result.error)) return { ok: false, code: encoderFailureHint(result.error) ? 'encoder' : 'export', error: result.error }
    }
    return { ok: false, code: 'export', error: lastError }
  }
}

export interface OutputProbe {
  duration: number
  hasVideo: boolean
  hasAudio: boolean
}

/** ffprobe the finished montage: container duration and stream kinds. null when ffprobe fails. */
export function createOutputProbe(ffprobeBin: string = defaultFfprobePath(), timeoutMs = 30_000): (file: string) => Promise<OutputProbe | null> {
  return (file) =>
    new Promise((resolve) => {
      let stdout = ''
      let settled = false
      const finish = (v: OutputProbe | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const proc = spawn(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        finish(null)
      }, timeoutMs)
      proc.stdout?.on('data', (d) => {
        stdout += d.toString()
        if (stdout.length > 1_000_000) {
          try {
            proc.kill()
          } catch {}
          finish(null)
        }
      })
      proc.on('error', () => finish(null))
      proc.on('close', (code) => {
        if (code !== 0) return finish(null)
        finish(parseOutputProbe(stdout))
      })
    })
}

export function parseOutputProbe(json: string): OutputProbe | null {
  try {
    const doc = JSON.parse(json) as { format?: { duration?: unknown }; streams?: Array<{ codec_type?: unknown }> }
    const duration = Number(doc.format?.duration)
    if (!Number.isFinite(duration)) return null
    const streams = Array.isArray(doc.streams) ? doc.streams : []
    return {
      duration,
      hasVideo: streams.some((s) => s?.codec_type === 'video'),
      hasAudio: streams.some((s) => s?.codec_type === 'audio')
    }
  } catch {
    return null
  }
}

/** Allowed difference between the planned and the measured montage length. */
export const VERIFY_TOLERANCE_SEC = 0.5

/** null when the output is valid, otherwise a translated reason. */
export function verifyFailure(probe: OutputProbe | null, totalSec: number): string | null {
  if (!probe) return tr('無法讀取精華合輯檔案')
  if (!probe.hasVideo || !probe.hasAudio) return tr('精華合輯檔案缺少影像或聲音')
  if (Math.abs(probe.duration - totalSec) > VERIFY_TOLERANCE_SEC) {
    return tr('精華合輯長度不符（{actual} 秒，預期 {expected} 秒）', { actual: probe.duration.toFixed(1), expected: totalSec.toFixed(1) })
  }
  return null
}

const rmQuiet = (file: string): void => {
  try {
    fs.rmSync(file, { force: true })
  } catch (err) {
    console.error('[montage] Failed to remove', file, err)
  }
}

/**
 * Remove what an interrupted montage export can leave next to `outputPath`: the `.partial.mp4` (and `.<uuid>.partial.mp4`)
 * files and the `.aditor-seg-*` intermediate segments in that folder; with `removeOutput`, the unverified output itself.
 */
export function cleanupMontageOutput(outputPath: string, opts: { removeOutput?: boolean } = {}): void {
  const dir = path.dirname(outputPath)
  const ext = path.extname(outputPath)
  const stem = path.basename(outputPath, ext)
  rmQuiet(partialPathFor(outputPath))
  if (opts.removeOutput) rmQuiet(outputPath)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const partialRe = new RegExp(`^${escaped}\\.[0-9a-f-]{36}\\.partial\\${ext}$`, 'i')
  const segRe = /^\.aditor-seg-[a-z0-9]+-\d+(?:(?:\.[0-9a-f-]{36})?\.partial)?\.(mp4|mov)$/i
  for (const name of names) {
    if (partialRe.test(name) || segRe.test(name)) rmQuiet(path.join(dir, name))
  }
}
