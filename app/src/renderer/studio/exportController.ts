import { i18n } from '../i18n'
import { tr } from '../../shared/locale'
import { exportSubDirName, joinForDisplay } from '../../shared/storage'
import {
  coerceExportFormat,
  DEFAULT_EXPORT_FORMAT,
  encodersForCodec,
  formatRequiresPrecise,
  H264_ENCODERS,
  HEVC_ENCODERS,
  type ExportFormat,
  type OutputFrame,
  type PresetId,
  type ReframeMode,
  type VideoCodec
} from '../../shared/exportFormat'
import { applyPreset, maxSecondsFor, sourceFormat, trimItemsToSeconds } from '../../shared/exportPresets'
import { clampOffset } from '../../shared/reframe'
import type { ProjectItem, ProjectStyle } from '../editor/project'
import { projectHasStyling } from '../../shared/autoEditProject'

/**
 * Export drawer state machine (pure TS, no React/DOM dependency; window.api is injected for testing with a fake API).
 * All IPC subscriptions are managed here: progress events are subscribed only during start()/download and unsubscribed on completion or dispose.
 */

export interface ExportItem {
  id: string
  source: string
  start: number
  end: number
  /** v2 styling (Auto edit); sent only when present. */
  speed?: ProjectItem['speed']
  gain?: ProjectItem['gain']
  effects?: ProjectItem['effects']
  overlay?: ProjectItem['overlay']
  transitionIn?: ProjectItem['transitionIn']
  transitionSec?: ProjectItem['transitionSec']
}

/** Export items for a project: range plus the v2 styling fields that are set (unstyled projects send exactly what v1 sent). */
export function exportItemsFrom(project: { items: ProjectItem[] }): ExportItem[] {
  return project.items.map((i) => {
    const out: ExportItem = { id: i.id, source: i.source, start: i.start, end: i.end }
    if (i.speed !== undefined) out.speed = i.speed
    if (i.gain !== undefined) out.gain = i.gain
    if (i.effects !== undefined) out.effects = i.effects
    if (i.overlay !== undefined) out.overlay = i.overlay
    if (i.transitionIn !== undefined) out.transitionIn = i.transitionIn
    if (i.transitionSec !== undefined) out.transitionSec = i.transitionSec
    return out
  })
}

/** v2 project-level styling sent with `export:start` (only the fields that are set). */
function styleFields(style: ProjectStyle | undefined): ProjectStyle {
  if (!style) return {}
  const out: ProjectStyle = {}
  if (style.style !== undefined) out.style = style.style
  if (style.music !== undefined) out.music = style.music
  if (style.intro !== undefined) out.intro = style.intro
  if (style.outro !== undefined) out.outro = style.outro
  if (style.letterbox !== undefined) out.letterbox = style.letterbox
  if (style.presetId !== undefined) out.presetId = style.presetId
  return out
}

export interface ExportApi {
  detectEncoders(): Promise<string[]>
  openh264Status(): Promise<{ installed: boolean }>
  downloadOpenH264(): Promise<string>
  selectOutDir(): Promise<string | null>
  openFolder(dir: string): Promise<boolean>
  start(opts: unknown): Promise<StartResult>
  cancel(): Promise<{ cancelled: boolean }>
/** Check that the output directory exists and is writable before starting. */
  checkOutDir(dir: string): Promise<{ ok: true } | { ok: false; reason: string }>
  diskSpace(dir: string): Promise<{ freeBytes: number; totalBytes: number }>
  onProgress(cb: (data: unknown) => void): () => void
  onOpenH264Progress(cb: (ratio: number) => void): () => void
  /** Read persisted settings (only `exportFormat` is used). Optional: without it the default format is kept. */
  getSettings?(): Promise<unknown>
  /** Persist a settings patch; the controller only writes `{ exportFormat }`. */
  setSettings?(patch: { exportFormat: ExportFormat }): Promise<unknown>
}

type StartResult =
  | { ok: true; outputs: string[]; notices?: string[] }
  | { ok: false; cancelled: true; outputs: string[]; notices?: string[] }
  | { ok: false; cancelled?: false; error: string; outputs: string[]; notices?: string[] }

export type ExportPhase = 'settings' | 'running' | 'done' | 'failed'

export interface ExportSettings {
  mode: 'concat' | 'separate'
  quality: 'copy' | 'precise'
/** Encoder actually sent to main (derived from encoderChoice and detection results). */
  encoder: string
/** User choice: 'auto' uses priority order; otherwise, the name of a detected available encoder. */
  encoderChoice: string
  outDir: string | null
  baseName: string
  /** Output format chosen by the user (loaded from and persisted to settings.exportFormat). See effectiveFormat for what is exported. */
  format: ExportFormat
  /** "Export only the first N seconds" (N = the selected preset's length limit). Not persisted. */
  trimToLimit: boolean
}

export interface ExportProgress {
  percent: number
  jobIndex: number
  totalJobs: number
  outTimeSeconds: number
}

export interface ExportResult {
  ok: boolean
  cancelled: boolean
  outputs: string[]
  notices: string[]
/** Tail of ffmpeg stderr on failure (or a validation error message). */
  error: string | null
  durationMs: number
}

export interface OpenH264State {
  step: 'idle' | 'consent' | 'downloading' | 'error'
  ratio: number
  error: string | null
}

export interface ExportState {
  phase: ExportPhase
  settings: ExportSettings
  encoders: string[]
  openh264Installed: boolean
  detected: boolean
  disk: { freeBytes: number; totalBytes: number } | null
  outDirError: string | null
  progress: ExportProgress | null
  result: ExportResult | null
  h264: OpenH264State
}

export const ENCODER_AUTO = 'auto'

/** True once detection has confirmed that no HEVC encoder works on this machine (before detection: unknown, false). */
export function hevcUnavailable(encoders: readonly string[], detected: boolean): boolean {
  return detected && encodersForCodec(encoders, 'h265').length === 0
}

/**
 * Format that is actually exported: a (persisted) H.265 choice falls back to H.264 when detection found no working HEVC encoder.
 * The fallback is never written back to settings, so the choice comes back once an HEVC encoder works again.
 */
export function effectiveFormat(fmt: ExportFormat, encoders: readonly string[], detected: boolean): ExportFormat {
  return fmt.codec === 'h265' && hevcUnavailable(encoders, detected) ? { ...fmt, codec: 'h264' } : fmt
}

/** Priority order per codec (H.265 never uses OpenH264). */
function pickEncoder(list: readonly string[], codec: VideoCodec): string {
  const priority: readonly string[] = codec === 'h265' ? HEVC_ENCODERS : H264_ENCODERS
  for (const e of priority) if (list.includes(e)) return e
  return list[0] ?? ''
}

/** For 'auto' or a choice that is unavailable for the codec, select by priority; otherwise use the encoder selected by the user. */
export function resolveEncoder(choice: string, encoders: readonly string[], codec: VideoCodec): { choice: string; encoder: string } {
  const list = encodersForCodec(encoders, codec)
  if (choice !== ENCODER_AUTO && list.includes(choice)) return { choice, encoder: choice }
  return { choice: ENCODER_AUTO, encoder: pickEncoder(list, codec) }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface ExportControllerOptions {
  /** Delay before a format change is written to settings (coalesces slider drags). 0 writes immediately. */
  persistDelayMs?: number
}

export function createExportController(api: ExportApi, initialName = 'highlight', opts: ExportControllerOptions = {}) {
  const persistDelayMs = opts.persistDelayMs ?? 300
  let state: ExportState = {
    phase: 'settings',
    settings: {
      mode: 'concat',
      quality: 'copy',
      encoder: '',
      encoderChoice: ENCODER_AUTO,
      outDir: null,
      baseName: initialName,
      format: { ...DEFAULT_EXPORT_FORMAT },
      trimToLimit: false
    },
    encoders: [],
    openh264Installed: false,
    detected: false,
    disk: null,
    outDirError: null,
    progress: null,
    result: null,
    h264: { step: 'idle', ratio: 0, error: null }
  }
  const listeners = new Set<() => void>()
  let lastItems: ExportItem[] | null = null
  let lastStyle: ProjectStyle | undefined
  let offProgress: (() => void) | null = null
  let offH264: (() => void) | null = null
  let diskRequestId = 0
  /** Bumped on every user format change, so a slower settings read never overwrites a choice made meanwhile. */
  let formatEpoch = 0
  let formatLoaded = false
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let pendingFormat: ExportFormat | null = null

  function set(patch: Partial<ExportState>): void {
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }
  /** Re-resolve the encoder for the effective codec (after any change to the format, the choice or the detection result). */
  function withEncoder(settings: ExportSettings, encoders: readonly string[], detected: boolean): ExportSettings {
    const codec = effectiveFormat(settings.format, encoders, detected).codec
    const r = resolveEncoder(settings.encoderChoice, encoders, codec)
    return { ...settings, encoder: r.encoder, encoderChoice: r.choice }
  }
  const setSettings = (patch: Partial<ExportSettings>): void =>
    set({ settings: withEncoder({ ...state.settings, ...patch }, state.encoders, state.detected) })

  function flushPersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = null
    const exportFormat = pendingFormat
    pendingFormat = null
    if (!exportFormat || !api.setSettings) return
    // Persist the user's choice (not the effective format): an unavailable H.265 is never silently rewritten to H.264.
    void Promise.resolve()
      .then(() => api.setSettings?.({ exportFormat }))
      .catch(() => undefined)
  }

  function setFormat(next: ExportFormat): void {
    formatEpoch++
    setSettings({ format: next })
    pendingFormat = next
    if (persistDelayMs <= 0) {
      flushPersist()
      return
    }
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(flushPersist, persistDelayMs)
  }

  /** Load settings.exportFormat once (later opens keep the in-memory choice, which is also what was persisted). */
  async function loadFormat(): Promise<void> {
    if (formatLoaded || !api.getSettings) return
    const epoch = formatEpoch
    try {
      const raw = (await api.getSettings()) as { exportFormat?: unknown } | null | undefined
      formatLoaded = true
      if (epoch !== formatEpoch) return
      setSettings({ format: coerceExportFormat(raw?.exportFormat) })
    } catch {
      // Unreadable settings: keep the current (default) format.
    }
  }

  async function refreshDisk(dir: string | null): Promise<void> {
    const requestId = ++diskRequestId
    if (!dir) {
      set({ disk: null, outDirError: i18n.export.blockNoOutDir })
      return
    }
    // Verify the directory exists and is writable first: an invalid directory blocks in Settings rather than failing only after Start is pressed.
    try {
      const check = await api.checkOutDir(dir)
      if (requestId !== diskRequestId) return
      if (!check.ok) {
        set({ disk: null, outDirError: tr('{label}（{detail}）', { label: i18n.export.blockOutDirInvalid, detail: check.reason }) })
        return
      }
    } catch (e) {
      if (requestId !== diskRequestId) return
      set({ disk: null, outDirError: tr('{label}（{detail}）', { label: i18n.export.blockOutDirInvalid, detail: errMsg(e) }) })
      return
    }
    try {
      const d = await api.diskSpace(dir)
      if (requestId !== diskRequestId) return
      set({ disk: d, outDirError: null })
    } catch (e) {
      if (requestId !== diskRequestId) return
      set({ disk: null, outDirError: tr('{label}（{detail}）', { label: i18n.export.blockOutDirInvalid, detail: errMsg(e) }) })
    }
  }

  async function detect(): Promise<void> {
    let encoders: string[] = []
    let installed = false
    try {
      encoders = (await api.detectEncoders()) ?? []
    } catch {
      encoders = []
    }
    try {
      installed = !!(await api.openh264Status())?.installed
    } catch {
      installed = false
    }
    set({
      encoders,
      openh264Installed: installed,
      detected: true,
      settings: withEncoder(state.settings, encoders, true)
    })
  }

  async function init(defaultOutDir: string | null): Promise<void> {
    setSettings({ outDir: defaultOutDir })
    await Promise.all([detect(), refreshDisk(defaultOutDir), loadFormat()])
    // Precise may have been picked while detection was still running; ask for consent now that the answer is known.
    if (state.settings.quality === 'precise' && needsConsent() && state.h264.step === 'idle') set({ h264: { step: 'consent', ratio: 0, error: null } })
  }

  // Before detection finishes the empty encoder list means "unknown", not "none".
  // Only H.264 can fall back to OpenH264 (an unavailable H.265 already exports as H.264, see effectiveFormat).
  const needsConsent = (): boolean =>
    state.detected &&
    effectiveFormat(state.settings.format, state.encoders, state.detected).codec === 'h264' &&
    encodersForCodec(state.encoders, 'h264').length === 0 &&
    !state.openh264Installed

  async function setQuality(q: 'copy' | 'precise'): Promise<void> {
    setSettings({ quality: q })
    if (q === 'precise' && needsConsent()) set({ h264: { step: 'consent', ratio: 0, error: null } })
  }

  function declineConsent(): void {
    setSettings({ quality: 'copy' })
    set({ h264: { step: 'idle', ratio: 0, error: null } })
  }

  async function acceptConsent(): Promise<void> {
    if (state.h264.step === 'downloading') return
    set({ h264: { step: 'downloading', ratio: 0, error: null } })
    offH264 = api.onOpenH264Progress((r) => {
      if (state.h264.step === 'downloading') set({ h264: { step: 'downloading', ratio: r, error: null } })
    })
    try {
      await api.downloadOpenH264()
    } catch (e) {
      offH264?.()
      offH264 = null
        setSettings({ quality: 'copy' })
      set({ h264: { step: 'error', ratio: 0, error: errMsg(e) } })
      return
    }
    offH264?.()
    offH264 = null
    await detect()
    if (state.encoders.includes('libopenh264')) {
      setSettings({ encoder: 'libopenh264', encoderChoice: 'libopenh264', quality: 'precise' })
      set({ h264: { step: 'idle', ratio: 1, error: null } })
    } else {
      setSettings({ quality: 'copy' })
      set({ h264: { step: 'error', ratio: 0, error: i18n.export.h264NotDetected } })
    }
  }

  async function chooseOutDir(): Promise<void> {
    let dir: string | null = null
    try {
      dir = await api.selectOutDir()
    } catch {
      dir = null
    }
    if (!dir) return
    setSettings({ outDir: dir })
    await refreshDisk(dir)
  }

  /** `style`: the project's v2 styling (Auto edit); a styled concat export renders through main's montage stage. */
  async function start(items: ExportItem[], style?: ProjectStyle): Promise<void> {
    if (state.phase === 'running') return
    const s = state.settings
    if (!s.outDir) {
      set({ outDirError: i18n.export.blockNoOutDir })
      return
    }
    if (state.outDirError) return // Output-directory validation failed; use the same condition as the disabled button and do not send export:start.
    lastItems = items
    lastStyle = style
    flushPersist()
    const format = effectiveFormat(s.format, state.encoders, state.detected)
    // "Export only the first N seconds": N is the selected preset's limit (Original/Custom have none, so nothing is trimmed).
    const limit = s.trimToLimit ? maxSecondsFor(format) : null
    const sentItems = limit !== null ? trimItemsToSeconds(items, limit, s.mode) : items
    // Stream copy cannot reframe, rescale, change fps or codec: ask for precise explicitly (main enforces the same rule).
    // Styled projects (Auto edit) always go through the montage stage, which re-encodes.
    const styled = projectHasStyling({ items: items as ProjectItem[], ...styleFields(style) })
    const quality = formatRequiresPrecise(format) || styled ? 'precise' : s.quality
    const startedAt = Date.now()
    set({ phase: 'running', progress: { percent: 0, jobIndex: 0, totalJobs: 1, outTimeSeconds: 0 }, result: null })
    offProgress = api.onProgress((d) => {
      const p = d as Partial<ExportProgress> | null
      if (!p || typeof p.percent !== 'number') return
      set({
        progress: {
          percent: p.percent,
          jobIndex: p.jobIndex ?? 0,
          totalJobs: p.totalJobs ?? 1,
          outTimeSeconds: p.outTimeSeconds ?? 0
        }
      })
    })
    let res: StartResult
    try {
      res = await api.start({
        items: sentItems,
        mode: s.mode,
        quality,
        encoder: s.encoder || undefined,
        outDir: s.outDir,
        baseName: s.baseName,
        format,
        ...styleFields(style)
      })
    } catch (e) {
      res = { ok: false, error: errMsg(e), outputs: [] }
    } finally {
      offProgress?.()
      offProgress = null
    }
    const durationMs = Date.now() - startedAt
    const notices = res.notices ?? []
    if (res.ok) {
      set({ phase: 'done', result: { ok: true, cancelled: false, outputs: res.outputs, notices, error: null, durationMs } })
    } else if (res.cancelled) {
      set({ phase: 'done', result: { ok: false, cancelled: true, outputs: res.outputs, notices, error: null, durationMs } })
    } else {
      set({ phase: 'failed', result: { ok: false, cancelled: false, outputs: res.outputs, notices, error: res.error, durationMs } })
    }
  }

  async function cancel(): Promise<void> {
    if (state.phase !== 'running') return
    try {
      await api.cancel()
    } catch {
      // If cancellation fails, export will end naturally and start() will report the result.
    }
  }

  function retry(): Promise<void> {
    if (!lastItems) return Promise.resolve()
    set({ phase: 'settings' })
    return start(lastItems, lastStyle)
  }

  /** Actual output directory: mode-specific subfolder (Merged/Clips) under the user's outDir; null when outDir is empty. */
  function getOutputDir(): string | null {
    const { outDir, mode } = state.settings
    return outDir ? joinForDisplay(outDir, exportSubDirName(mode)) : null
  }

  async function openFolder(): Promise<void> {
    const dir = getOutputDir()
    if (!dir) return
    try {
      await api.openFolder(dir)
    } catch {
      // Failure to open the folder does not affect the export result.
    }
  }

  /** Return to Settings after completion or failure. */
  function finish(): void {
    if (state.phase === 'running') return
    set({ phase: 'settings', result: null, progress: null })
    void refreshDisk(state.settings.outDir)
  }

  function dispose(opts: { cancelIfRunning?: boolean } = {}): void {
    flushPersist()
    if (opts.cancelIfRunning && state.phase === 'running') void api.cancel().catch(() => undefined)
    offProgress?.()
    offProgress = null
    offH264?.()
    offH264 = null
  }

  return {
    getState: (): ExportState => state,
    getOutputDir,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    init,
    setMode: (mode: ExportSettings['mode']): void => setSettings({ mode }),
    setQuality,
/** 'auto' or a detected available encoder; ignore unavailable names. */
    setEncoder: (choice: string): void => {
      const codec = effectiveFormat(state.settings.format, state.encoders, state.detected).codec
      if (choice !== ENCODER_AUTO && !encodersForCodec(state.encoders, codec).includes(choice)) return
      setSettings({ encoderChoice: choice })
    },
    /** Pick a platform preset, or 'source' for the original frame. */
    choosePreset: (id: PresetId | 'source'): void => {
      const f = state.settings.format
      setFormat(id === 'source' ? sourceFormat(f) : applyPreset(f, id))
    },
    /** Change the frame shape; a preset's explicit size only fits its own frame and is dropped (the drawer then shows Custom). */
    setFrame: (frame: OutputFrame): void => {
      const f = state.settings.format
      if (f.frame !== frame) setFormat({ ...f, frame, width: null, height: null })
    },
    setReframe: (reframe: ReframeMode): void => {
      if (state.settings.format.reframe !== reframe) setFormat({ ...state.settings.format, reframe })
    },
    setOffset: (offset: number): void => {
      const v = Math.round(clampOffset(offset) * 100) / 100
      if (state.settings.format.offset !== v) setFormat({ ...state.settings.format, offset: v })
    },
    /** H.265 is ignored once detection has confirmed that no HEVC encoder works. */
    setCodec: (codec: VideoCodec): void => {
      if (codec === 'h265' && hevcUnavailable(state.encoders, state.detected)) return
      if (state.settings.format.codec !== codec) setFormat({ ...state.settings.format, codec })
    },
    /** Frame-rate cap (null = source fps). */
    setFpsCap: (fpsCap: number | null): void => {
      if (state.settings.format.fpsCap !== fpsCap) setFormat({ ...state.settings.format, fpsCap })
    },
    setTrimToLimit: (trimToLimit: boolean): void => setSettings({ trimToLimit }),
    redetect: detect,
    setBaseName: (baseName: string): void => setSettings({ baseName }),
    chooseOutDir,
    openFolder,
    declineConsent,
    acceptConsent,
    start,
    cancel,
    retry,
    finish,
    dispose
  }
}

export type ExportController = ReturnType<typeof createExportController>
