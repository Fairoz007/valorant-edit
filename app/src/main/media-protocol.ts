import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { MEDIA_SCHEME, pathFromMediaUrl } from '../shared/media-url'
import { isSafeLocalVideoPath } from './safe-path'

/**
 * `aditor-media:` protocol: serves library videos, thumbnails and proxy files to the renderer (see shared/media-url.ts).
 *
 * Security: only paths that `isAllowed` accepts are served (library entries and their thumbnails, the proxy/thumbnail
 * cache, and sources of saved projects); anything else is 403. Traversal is impossible by construction (pathFromMediaUrl
 * rejects `.`/`..` and separators inside segments, and Chromium resolves dot segments before the request reaches us),
 * and the allowlist compares normalized absolute paths. The window keeps sandbox, contextIsolation and webSecurity.
 *
 * Range requests are implemented here (not via net.fetch(file://)) so <video> seeking gets correct 206 responses,
 * and so the handler is a plain function that unit tests can call without Electron.
 */

export { MEDIA_SCHEME }

/** Privilege set for protocol.registerSchemesAsPrivileged (must run before app ready). */
export const MEDIA_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true
} as const

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

export function mediaMimeType(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
}

export interface ByteRange {
  start: number
  end: number
}

/**
 * Parse a single `Range: bytes=…` header against a file size.
 * Returns null when there is no usable range (serve the whole file: absent, malformed, non-bytes or multi-range),
 * or 'unsatisfiable' when the range lies outside the file (416).
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return null
  if (a === '') {
    // Suffix range: last N bytes.
    const n = Number(b)
    if (n === 0) return 'unsatisfiable'
    if (size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  if (start >= size) return 'unsatisfiable'
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (end < start) return null
  return { start, end }
}

export interface MediaHandlerDeps {
  /** Whether this absolute path may be served. */
  isAllowed: (filePath: string) => boolean
  platform?: NodeJS.Platform
}

const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } })

/** Handle one `aditor-media:` request. Never throws: failures become 4xx/5xx responses. */
export async function handleMediaRequest(request: Request, deps: MediaHandlerDeps): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed', { Allow: 'GET, HEAD' })
  const filePath = pathFromMediaUrl(request.url, deps.platform ?? process.platform)
  if (!filePath) return text(400, 'Bad media URL')
  if (!deps.isAllowed(filePath)) return text(403, 'Forbidden')

  let size: number
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) return text(404, 'Not found')
    size = stat.size
  } catch {
    return text(404, 'Not found')
  }

  const base: Record<string, string> = {
    'Content-Type': mediaMimeType(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') return text(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` })

  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const length = size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = { ...base, 'Content-Length': String(length) }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const status = range ? 206 : 200
  if (method === 'HEAD' || length === 0) return new Response(null, { status, headers })

  const stream = fs.createReadStream(filePath, { start, end })
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers })
}

/** Key for comparing paths: absolute, native separators, case-insensitive on Windows. */
export function mediaPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.win32.resolve(p).toLowerCase()
  return path.posix.resolve(p)
}

/** Whether `child` is strictly inside `root` (both already normalized with mediaPathKey). */
function isInside(root: string, child: string, platform: NodeJS.Platform): boolean {
  const rel = (platform === 'win32' ? path.win32 : path.posix).relative(root, child)
  return rel.length > 0 && !rel.startsWith('..') && !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(rel)
}

const SERVABLE_EXTS = new Set(Object.keys(MIME))

export interface MediaAccessOptions {
  /** Library entries (video path and optional thumbnail path). Read on every request so imports/removals apply at once. */
  libraryEntries: () => ReadonlyArray<{ path: string; thumb?: string }>
  /** Directories whose files may be served (the proxy and thumbnail cache). */
  cacheRoots: () => string[]
  platform?: NodeJS.Platform
}

export interface MediaAccess {
  isAllowed: (filePath: string) => boolean
  /** Allow sources referenced by a project the app loaded or saved (they may have been removed from the library). */
  allowProjectSources: (sources: unknown[]) => void
}

export function createMediaAccess(opts: MediaAccessOptions): MediaAccess {
  const platform = opts.platform ?? process.platform
  const projectSources = new Set<string>()
  const key = (p: string): string => mediaPathKey(p, platform)
  return {
    isAllowed(filePath) {
      if (typeof filePath !== 'string' || filePath.includes('\0')) return false
      if (!SERVABLE_EXTS.has(path.extname(filePath).toLowerCase())) return false
      const k = key(filePath)
      if (projectSources.has(k)) return true
      for (const root of opts.cacheRoots()) if (isInside(key(root), k, platform)) return true
      for (const e of opts.libraryEntries()) {
        if (key(e.path) === k) return true
        if (e.thumb && key(e.thumb) === k) return true
      }
      return false
    },
    allowProjectSources(sources) {
      for (const s of sources) {
        // Same rule as project-source existence checks: local absolute video paths only, never UNC/device paths.
        if (isSafeLocalVideoPath(s, platform)) projectSources.add(key(s))
      }
    }
  }
}
