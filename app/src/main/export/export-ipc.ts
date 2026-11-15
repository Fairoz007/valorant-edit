/**
 * Core IPC handlers for exports (no Electron dependency; testable with fake ipcMain/webContents).
 * Channels: `export:start`, `export:cancel`, `export:diskSpace`, `export:checkOutDir`; `export:progress` is sent only to the requesting window.
 */
import fs from 'fs'
import path from 'path'
import { buildJobs, concatList, encoderMismatchMessage, resolveFreeBaseName, resolveQuality, StreamProbe } from './plan'
import { DEFAULT_EXPORT_FORMAT, encoderCodec, type ExportFormat } from '../../shared/exportFormat'
import { sanitizeExportFormat } from '../ipc-guards'
import { UNKNOWN_PROBE } from '../../shared/exportCompat'
import { AudioProbe, createAudioProbe, createCutLookup, createMediaEndProbe, CutLookup, lookupCopyCuts, MediaEndProbe, measureMediaEnds } from './keyframe'
import { runExport, RunExportOptions, RunProgress } from './run'
import { isSafeLocalDirPath, isSafeLocalVideoPath, fileExistsSafe } from '../safe-path'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import { normalizePath } from '../library'
import { tr } from '../../shared/locale'
import { exportSubDirName } from '../../shared/storage'
import { projectHasStyling, validProjectItemStyle, validProjectStyle } from '../../shared/autoEditProject'
import type { ProjectItem } from '../../renderer/editor/project'
import type { MontageItem, MontageProjectStyle } from './montage-plan'
import { runMontage, type MontageErrorCode, type MontageRunDeps } from './montage-run'
import { defaultTextRenderer } from './montage-text'

export interface ExportSender {
  isDestroyed(): boolean
  send(channel: string, data: RunProgress): void
  /** webContents 'destroyed' event (window closed); caller invokes cancel separately when unavailable. */
  once?(event: 'destroyed', listener: () => void): unknown
  removeListener?(event: 'destroyed', listener: () => void): unknown
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: { sender: ExportSender }, ...args: any[]) => unknown): void
}

export interface ExportServiceDeps {
  /** Get source video metadata (engine probe); use defaults on failure or when unavailable. */
  probe?: (source: string) => Promise<unknown>
  ffmpeg?: RunExportOptions['ffmpeg']
  tempDir?: string
  /** Audio-track query for precise concatenation; add silence first when a source has no audio track. */
  hasAudio?: AudioProbe
  /** Query fast stream-copy cut points (keyframes and end); defaults to a packet-only ffprobe query. */
  copyCut?: CutLookup
  /** For concatenation: measure the actual playback end of an intermediate file; defaults to reading packets with ffprobe. */
  mediaEnd?: MediaEndProbe
  /** Montage render stage (styled v2 projects): caption/card PNG renderer; defaults to an offscreen Electron window. */
  renderTextPng?: MontageRunDeps['renderTextPng']
  /** Montage beat sync: source duration probe; defaults to ffprobe. */
  probeDuration?: MontageRunDeps['probeDuration']
}

export interface ValidatedRequest {
  /** v1 fields plus the optional v2 styling fields (speed, gain, effects, overlay, transition). */
  items: MontageItem[]
  /** v2 project-level styling (style, music, intro, outro, letterbox); absent when the request has none. */
  style?: MontageProjectStyle
  mode: 'separate' | 'concat'
  quality: 'copy' | 'precise'
  encoder?: string
  /** User-selected output directory (validated to exist and be writable). */
  outDir: string
  /** Actual output directory: the mode-specific subdirectory under `outDir` (Merged or Clips), created and writable. */
  outputDir: string
  baseName: string
  /** Output format (frame, reframe, size, fps cap, codec); DEFAULT_EXPORT_FORMAT when the request has none. */
  format: ExportFormat
}

class RequestError extends Error {}

const MAX_ITEMS = 2000
const MAX_BASENAME = 100
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Sanitize a filename stem: remove path separators, Windows-invalid characters, trailing dots/spaces, and reserved names; limit its length; use `export` when empty. */
export function sanitizeBaseName(name: string): string {
  let s = name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
  s = s.replace(/[. ]+$/g, '').replace(/^\s+/, '')
  if (/^\.+$/.test(s)) s = ''
  if (s.length > MAX_BASENAME) s = s.slice(0, MAX_BASENAME).replace(/[. ]+$/g, '')
  if (s.length === 0) return 'export'
  if (RESERVED.test(s.split('.')[0])) s = '_' + s
  return s
}

async function assertWritableDir(dir: string): Promise<void> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(dir)
  } catch {
    throw new RequestError(tr('輸出資料夾不存在'))
  }
  if (!st.isDirectory()) throw new RequestError(tr('輸出路徑不是資料夾'))
  const probe = path.join(dir, `.aditor-write-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await fs.promises.writeFile(probe, '', { flag: 'wx' })
  } catch {
    throw new RequestError(tr('輸出資料夾無法寫入'))
  }
  await fs.promises.rm(probe, { force: true }).catch(() => undefined)
}

export async function validateExportRequest(raw: unknown): Promise<ValidatedRequest> {
  if (typeof raw !== 'object' || raw === null) throw new RequestError(tr('匯出請求格式不正確'))
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.items) || r.items.length === 0) throw new RequestError(tr('沒有可匯出的片段'))
  if (r.items.length > MAX_ITEMS) throw new RequestError(tr('片段數量過多'))
  const items: ValidatedRequest['items'] = []
  for (const it of r.items) {
    if (typeof it !== 'object' || it === null) throw new RequestError(tr('片段格式不正確'))
    const { id, source, start, end } = it as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new RequestError(tr('片段時間必須是有限數字'))
    }
    if (start < 0 || end <= start) throw new RequestError(tr('片段時間範圍不正確'))
    if (!isSafeLocalVideoPath(source)) throw new RequestError(tr('來源影片路徑不正確'))
    if (!(await fileExistsSafe(source))) throw new RequestError(tr('找不到來源影片：{source}', { source }))
    const styled = it as Record<string, unknown>
    if (!validProjectItemStyle(styled)) throw new RequestError(tr('片段格式不正確'))
    items.push({ id: typeof id === 'string' ? id : '', source, start, end, ...copyItemStyle(styled as Partial<ProjectItem>) })
  }
  const style = await validateProjectStyle(r)
  if (r.mode !== 'separate' && r.mode !== 'concat') throw new RequestError(tr('匯出模式不正確'))
  if (r.quality !== 'copy' && r.quality !== 'precise') throw new RequestError(tr('匯出品質不正確'))
  let encoder: string | undefined
  if (r.encoder !== undefined && r.encoder !== null) {
    if (typeof r.encoder !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(r.encoder)) throw new RequestError(tr('編碼器名稱不正確'))
    encoder = r.encoder
  }
  let format: ExportFormat = { ...DEFAULT_EXPORT_FORMAT }
  if (r.format !== undefined) {
    try {
      format = sanitizeExportFormat(r.format)
    } catch (err) {
      throw new RequestError((err as Error).message)
    }
  }
  if (encoder !== undefined && encoderCodec(encoder) !== format.codec) throw new RequestError(encoderMismatchMessage(encoder, format.codec))
  if (encoder === undefined && format.codec === 'h265') throw new RequestError(tr('H.265 需要支援 HEVC 的硬體編碼器（NVIDIA、Intel 或 AMD），請選擇 HEVC 編碼器或改用 H.264'))
  if (!isSafeLocalDirPath(r.outDir)) throw new RequestError(tr('輸出資料夾路徑不正確'))
  const outDir = path.resolve(r.outDir)
  await assertWritableDir(outDir)
  if (typeof r.baseName !== 'string') throw new RequestError(tr('檔名不正確'))
  // Create the subdirectory only after all other fields pass validation, so invalid requests do not leave empty folders behind.
  const outputDir = path.join(outDir, exportSubDirName(r.mode))
  try {
    await fs.promises.mkdir(outputDir, { recursive: true })
  } catch {
    throw new RequestError(tr('無法建立輸出子資料夾'))
  }
  await assertWritableDir(outputDir)
  return { items, mode: r.mode, quality: r.quality, encoder, outDir, outputDir, baseName: sanitizeBaseName(r.baseName), format, ...(style ? { style } : {}) }
}

/** Copy only the known v2 item fields (already validated), so nothing else from the renderer reaches the render stage. */
function copyItemStyle(x: Partial<ProjectItem>): Partial<MontageItem> {
  return {
    ...(x.speed !== undefined ? { speed: x.speed } : {}),
    ...(x.gain !== undefined ? { gain: x.gain } : {}),
    ...(x.effects !== undefined ? { effects: x.effects.map((e) => ({ ...e })) } : {}),
    ...(x.overlay !== undefined ? { overlay: { text: x.overlay.text, at: x.overlay.at, durationSec: x.overlay.durationSec } } : {}),
    ...(x.transitionIn !== undefined ? { transitionIn: x.transitionIn } : {}),
    ...(x.transitionSec !== undefined ? { transitionSec: x.transitionSec } : {})
  }
}

/**
 * Music containers the pinned FFmpeg can demux (mov/mp4/m4a, matroska/webm, avi); video files with an audio track also
 * work. MP3, WAV, FLAC and Ogg files cannot be opened by that build (no such demuxers).
 */
export const MUSIC_EXTS: ReadonlySet<string> = new Set(['.m4a', '.mp4', '.mov', '.mkv', '.mka', '.webm', '.avi'])

/** v2 project-level fields: shape via `validProjectStyle`, plus a safe, existing local music file. */
async function validateProjectStyle(r: Record<string, unknown>): Promise<MontageProjectStyle | undefined> {
  if (!validProjectStyle(r)) throw new RequestError(tr('匯出請求格式不正確'))
  const s = r as MontageProjectStyle
  const style: MontageProjectStyle = {
    ...(s.style !== undefined ? { style: s.style } : {}),
    ...(s.music !== undefined ? { music: { path: s.music.path, gain: s.music.gain, duck: s.music.duck, fadeInSec: s.music.fadeInSec, fadeOutSec: s.music.fadeOutSec } } : {}),
    ...(s.intro !== undefined ? { intro: { text: s.intro.text, durationSec: s.intro.durationSec, background: s.intro.background } } : {}),
    ...(s.outro !== undefined ? { outro: { text: s.outro.text, durationSec: s.outro.durationSec, background: s.outro.background } } : {}),
    ...(s.letterbox !== undefined ? { letterbox: s.letterbox } : {}),
    ...(s.presetId !== undefined ? { presetId: s.presetId } : {})
  }
  if (style.music) {
    const p = style.music.path
    if (!isSafeLocalDirPath(p) || !MUSIC_EXTS.has(path.extname(p).toLowerCase())) throw new RequestError(MUSIC_PATH_INVALID)
    const st = await fs.promises.stat(p).catch(() => null)
    if (!st || !st.isFile()) throw new RequestError(MUSIC_NOT_FOUND)
  }
  return Object.keys(style).length > 0 ? style : undefined
}

/** User-facing messages without translations yet (listed for the lead; English source text). */
export const MUSIC_PATH_INVALID = 'The music file path is not valid'
export const MUSIC_NOT_FOUND = 'The music file was not found'
export const MONTAGE_NEEDS_ENCODER = 'Styled montages need a video encoder (precise export)'

/** A concatenated v2 project with styling goes through the montage render stage; everything else uses buildJobs. */
export function isMontageRequest(req: Pick<ValidatedRequest, 'mode' | 'items' | 'style'>): boolean {
  return req.mode === 'concat' && projectHasStyling({ items: req.items as ProjectItem[], ...req.style })
}


const posNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export type ExportStartResult =
  | { ok: true; outputs: string[]; notices: string[] }
  | { ok: false; cancelled: true; outputs: string[]; notices: string[] }
  | { ok: false; cancelled?: false; code?: 'busy' | 'noEncoder' | MontageErrorCode; error: string; outputs: string[]; notices?: string[] }

async function removeStaleSegments(dir: string, sources: string[]): Promise<void> {
  const sourcePaths = new Set(sources.map(normalizePath))
  try {
    const files = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const file of files) {
      // Includes the `.partial` (and `.<uuid>.partial`) file an interrupted segment job leaves behind.
      if (!file.isFile() || !/^\.aditor-seg-[a-z0-9]+-\d+(?:(?:\.[0-9a-f-]{36})?\.partial)?\.(mp4|mov)$/i.test(file.name)) continue
      const target = path.join(dir, file.name)
      if (sourcePaths.has(normalizePath(target))) continue
      try {
        await fs.promises.rm(target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to remove stale export segment:', target, err)
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to read stale export segments:', dir, err)
  }
}

export function createExportService(deps: ExportServiceDeps = {}) {
  /** Allow one export at a time; set this before any await so two starts in the same tick cannot both pass the check. */
  let current: { ac: AbortController; done: Promise<unknown> } | null = null

  async function start(sender: ExportSender, raw: unknown): Promise<ExportStartResult> {
    if (current) return { ok: false, code: 'busy', error: tr('已有匯出正在進行中，請等待完成或先取消'), outputs: [] }
    const ac = new AbortController()
    let resolveDone!: () => void
    current = { ac, done: new Promise<void>((r) => (resolveDone = r)) }
    const onDestroyed = (): void => {
      ac.abort()
    }
    sender.once?.('destroyed', onDestroyed)
    try {
      const req = await validateExportRequest(raw)
      await removeStaleSegments(req.outputDir, req.items.map((item) => item.source))
      if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }

      const probes = new Map<string, StreamProbe>()
      for (const item of req.items) {
        if (probes.has(item.source)) continue
        let info: StreamProbe = { ...UNKNOWN_PROBE }
        if (deps.probe) {
          try {
            const p = (await deps.probe(item.source)) as Record<string, unknown> | null
            if (p) {
              // The engine currently provides only codec/resolution; use any other fields it provides, otherwise keep them unknown.
              info = {
                vcodec: str(p.codec) || 'h264',
                width: posNum(p.width) || 1920,
                height: posNum(p.height) || 1080,
                fps: posNum(p.fps),
                pix_fmt: str(p.pix_fmt),
                acodec: str(p.acodec),
                sample_rate: posNum(p.sample_rate),
                channels: posNum(p.channels)
              }
            }
          } catch {
            // Use defaults when metadata is unavailable.
          }
        }
        probes.set(item.source, info)
      }
      if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }

      if (isMontageRequest(req)) return await startMontage(req, probes, ac.signal, sender)

      // Do not overwrite existing files: append " (2)" to a duplicate name (I6).
      const free = resolveFreeBaseName(req.outputDir, req.baseName, req.mode, req.items.length, (p) => fs.existsSync(p))
      // Fast stream copy: find the keyframe before each segment start and a clean end, then align cuts to them (see keyframe.ts).
      let copyCuts: Awaited<ReturnType<typeof lookupCopyCuts>> | undefined
      const silentSources = new Set<string>()
      // One resolved quality for the copy-cut lookup, the jobs and the disk-space estimate (a reframing format forces precise).
      const quality = resolveQuality(req.items, req, probes).quality
      if (quality === 'copy') {
        copyCuts = await lookupCopyCuts(req.items, deps.copyCut ?? createCutLookup(), ac.signal)
        if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }
      } else if (req.mode === 'concat') {
        const hasAudio = deps.hasAudio ?? createAudioProbe()
        for (const source of probes.keys()) {
          if (await hasAudio(source, ac.signal) === false) silentSources.add(source)
          if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }
        }
      }
      const naming = { ...req, outDir: req.outputDir, baseName: free.baseName, copyCuts, silentSources }
      const { jobs, notices, concatListContent: staticList } = buildJobs(req.items, naming, probes)
      // Concatenation: after all intermediate files are ready, measure each actual playback end for the list duration (keep the original duration if measurement fails).
      const segmentFiles = jobs.filter((j) => j.intermediate).map((j) => j.output)
      const measure = deps.mediaEnd ?? createMediaEndProbe()
      const concatListContent =
        staticList && segmentFiles.length > 0
          ? async (): Promise<string> => concatList(segmentFiles, await measureMediaEnds(segmentFiles, measure, ac.signal))
          : staticList
      if (free.renamed) notices.push(tr('輸出資料夾已有同名檔案，已改用「{baseName}」，不會覆蓋原有檔案', { baseName: free.baseName }))
      // Defense in depth: output files must be directly inside the actual output directory (outDir/<subdirectory>).
      for (const j of jobs) {
        if (path.dirname(path.resolve(j.output)) !== req.outputDir) throw new RequestError(tr('輸出路徑不正確'))
      }
      const totalDur = req.items.reduce((s, it) => s + Math.max(0, it.end - it.start), 0)

      const result = await runExport(
        {
          jobs,
          totalEstimatedSeconds: totalDur,
          outDir: req.outputDir,
          estimatedBytes: estimateOutputBytes({ items: req.items }, quality, probes, req.mode, req.format),
          concatListContent,
          ffmpeg: deps.ffmpeg,
          tempDir: deps.tempDir
        },
        {
          signal: ac.signal,
          onProgress: (progress) => {
            if (sender.isDestroyed()) return
            try {
              sender.send('export:progress', progress)
            } catch {
              // The window was destroyed while sending.
            }
          }
        }
      )
      return { ...result, notices }
    } catch (err) {
      return { ok: false, error: (err as Error).message, outputs: [] }
    } finally {
      sender.removeListener?.('destroyed', onDestroyed)
      current = null
      resolveDone()
    }
  }

  /** Styled v2 project: montage render stage (always re-encoded, one output file). */
  async function startMontage(req: ValidatedRequest, probes: Map<string, StreamProbe>, signal: AbortSignal, sender: ExportSender): Promise<ExportStartResult> {
    if (!req.encoder) return { ok: false, code: 'noEncoder', error: MONTAGE_NEEDS_ENCODER, outputs: [], notices: [] }
    const notices: string[] = []
    const silentSources = new Set<string>()
    const hasAudio = deps.hasAudio ?? createAudioProbe()
    for (const source of probes.keys()) {
      if ((await hasAudio(source, signal)) === false) silentSources.add(source)
      if (signal.aborted) return { ok: false, cancelled: true, outputs: [], notices }
    }
    const free = resolveFreeBaseName(req.outputDir, req.baseName, 'concat', 1, (p) => fs.existsSync(p))
    if (free.renamed) notices.push(tr('輸出資料夾已有同名檔案，已改用「{baseName}」，不會覆蓋原有檔案', { baseName: free.baseName }))
    const result = await runMontage(
      {
        items: req.items,
        style: req.style ?? {},
        format: req.format,
        encoder: req.encoder,
        probes,
        silentSources,
        outputDir: req.outputDir,
        baseName: free.baseName,
        estimatedBytes: estimateOutputBytes({ items: req.items }, 'precise', probes, 'concat', req.format)
      },
      {
        ffmpeg: deps.ffmpeg,
        tempDir: deps.tempDir,
        renderTextPng: deps.renderTextPng ?? defaultTextRenderer(),
        probeDuration: deps.probeDuration
      },
      {
        signal,
        onProgress: (progress) => {
          if (sender.isDestroyed()) return
          try {
            sender.send('export:progress', progress)
          } catch {
            // The window was destroyed while sending.
          }
        }
      }
    )
    if (result.ok) return { ok: true, outputs: result.outputs, notices }
    if (result.cancelled) return { ok: false, cancelled: true, outputs: result.outputs, notices }
    return { ok: false, code: result.code, error: result.error, outputs: result.outputs, notices }
  }

  /** Cancel an active export; no-op when none is active or cancellation is already underway (returns cancelled:false). */
  function cancel(): { cancelled: boolean } {
    if (!current || current.ac.signal.aborted) return { cancelled: false }
    current.ac.abort()
    return { cancelled: true }
  }

  /** Cancel and wait until ffmpeg exits and partial files are removed (used on window close/app exit). */
  async function cancelAndWait(): Promise<void> {
    const c = current
    if (!c) return
    c.ac.abort()
    await c.done
  }

  /**
   * Check the output directory before starting (exists, is a directory, and is writable); share assertWritableDir with `export:start`
   * so invalid directories block on the settings page instead of failing after start. Return a result instead of throwing (so IPC does not prefix the error message).
   */
  async function checkOutDir(dir: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!isSafeLocalDirPath(dir)) return { ok: false, reason: tr('輸出資料夾路徑不正確') }
    try {
      await assertWritableDir(path.resolve(dir))
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  async function diskSpace(dir: unknown): Promise<{ freeBytes: number; totalBytes: number }> {
    if (!isSafeLocalDirPath(dir)) throw new Error(tr('磁碟路徑不正確'))
    const resolved = path.resolve(dir)
    const st = await fs.promises.stat(resolved).catch(() => null)
    if (!st || !st.isDirectory()) throw new Error(tr('資料夾不存在'))
    const s = await fs.promises.statfs(resolved)
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
  }

  return { start, cancel, cancelAndWait, diskSpace, checkOutDir, isRunning: () => current !== null }
}

export type ExportService = ReturnType<typeof createExportService>

export function registerExportHandlers(ipcMain: IpcMainLike, service: ExportService): void {
  ipcMain.handle('export:start', (event, opts: unknown) => service.start(event.sender, opts))
  ipcMain.handle('export:cancel', () => service.cancel())
  ipcMain.handle('export:diskSpace', (_event, dir: unknown) => service.diskSpace(dir))
  ipcMain.handle('export:checkOutDir', (_event, dir: unknown) => service.checkOutDir(dir))
}
