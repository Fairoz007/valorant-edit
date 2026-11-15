import { cacheFilePath } from './cache-io'
import { isSafeLocalVideoPath } from './safe-path'
import { tr } from '../shared/locale'
import { MONTAGE_JOB_ID_RE } from '../shared/montage'
import { MAX_FPS_CAP, MAX_OUTPUT_SIDE, MIN_OUTPUT_SIDE, validateExportFormat, type ExportFormat, type ExportFormatError } from '../shared/exportFormat'

/** Throw unless the value is a safe local video path from the renderer. */
export function requireVideoPath(p: unknown): string {
  if (!isSafeLocalVideoPath(p)) throw new Error(tr('影片路徑不正確'))
  return p
}

/** `engine:probe`: accept only local video paths (reject http://, concat:, and UNC). */
export function sanitizeProbeArgs(videoPath: unknown): { path: string } {
  return { path: requireVideoPath(videoPath) }
}

/** `engine:analyze`: renderer may specify only the video (and whether to force a rerun); main determines cache_dir/profile_dir/beside/hwaccel. */
export function sanitizeAnalyzeArgs(raw: unknown): { path: string; force?: boolean } {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: { path: string; force?: boolean } = { path: requireVideoPath(r.path) }
  if (r.force === true) out.force = true
  return out
}

export function sanitizeAutoclipArgs(raw: unknown): Record<string, unknown> {
  const r = (raw ?? {}) as Record<string, unknown>
  return { events: r.events, params: r.params, duration: r.duration }
}

/**
 * `library:remove` / `library:removeMany`: the renderer may only ask for the source file to be deleted.
 * Anything that is not a plain object with `deleteSource: true` keeps the files.
 */
export function sanitizeRemoveOptions(raw: unknown): { deleteSource: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { deleteSource: false }
  return { deleteSource: (raw as Record<string, unknown>).deleteSource === true }
}

/**
 * `cache:save`: ignore the renderer's `cache_path` and derive the destination from the video path; the video must already be in the library.
 * Return null to reject the request.
 */
export function planCacheSave<D extends { cache_path?: string; video?: { path?: string } }>(
  doc: D | null | undefined,
  library: { get(p: string): unknown },
  cacheDir: string,
  beside: boolean
): { dest: string; doc: D & { cache_path: string } } | null {
  const videoPath = doc?.video?.path
  if (!doc || !isSafeLocalVideoPath(videoPath) || !library.get(videoPath)) return null
  const dest = cacheFilePath(videoPath, cacheDir, beside)
  return { dest, doc: { ...doc, cache_path: dest } }
}

/** Short, printable rendering of a rejected value for an error message. */
function shown(v: unknown): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function exportFormatError(code: ExportFormatError, r: Record<string, unknown>): string {
  switch (code) {
    case 'shape':
      return tr('匯出格式設定不正確')
    case 'preset':
      return tr('不支援的匯出預設：{preset}', { preset: shown(r.preset) })
    case 'frame':
      return tr('不支援的畫面比例：{frame}', { frame: shown(r.frame) })
    case 'reframe':
      return tr('不支援的重新構圖方式：{reframe}', { reframe: shown(r.reframe) })
    case 'offset':
      return tr('裁切位置必須是 -1 到 1 之間的數字')
    case 'codec':
      return tr('不支援的影片編碼格式：{codec}', { codec: shown(r.codec) })
    case 'size':
      return tr('輸出尺寸不正確：寬與高必須同時設定，為 {min}–{max} 之間的偶數，並符合所選的畫面比例（原始比例不可指定尺寸）', {
        min: MIN_OUTPUT_SIDE,
        max: MAX_OUTPUT_SIDE
      })
    case 'fps':
      return tr('影格率上限必須是 1–{max} 之間的整數', { max: MAX_FPS_CAP })
  }
}

/** `export:start` `format`: strict validation (every field present and valid); throws a specific, translated error otherwise. */
export function sanitizeExportFormat(raw: unknown): ExportFormat {
  const v = validateExportFormat(raw)
  if (v.ok) return v.value
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  throw new Error(exportFormatError(v.error, r))
}

/** `montage:open` / `montage:retry` / `montage:cancel`: only a well-formed job id (`m_` + 16 hex) is accepted. */
export function sanitizeMontageJobId(raw: unknown): string {
  if (typeof raw !== 'string' || !MONTAGE_JOB_ID_RE.test(raw)) throw new Error(tr('無效的精華合輯工作 id'))
  return raw
}
