/**
 * URLs for local media (videos, thumbnails, proxies) loaded by the renderer.
 *
 * The renderer never uses file:// for media: a page served from http://localhost (development) may not load file:// at all
 * ("Media load rejected by URL safety check"), and file:// would let any renderer content address any file. Instead,
 * main registers the privileged `aditor-media:` scheme (see main/media-protocol.ts), which serves only files the app knows
 * about and supports HTTP range requests for <video> seeking.
 *
 * Layout (each path segment is percent-encoded with encodeURIComponent, so `#`, `?`, `%`, spaces and non-ASCII survive):
 * - Windows drive path  `C:\v\a.mp4`            → `aditor-media://local/C:/v/a.mp4`
 * - POSIX path          `/Users/x/a.mp4`        → `aditor-media://local/Users/x/a.mp4`
 * - UNC path            `\\server\share\a.mp4`  → `aditor-media://unc/server/share/a.mp4`
 */
export const MEDIA_SCHEME = 'aditor-media'

const DRIVE_SEGMENT = /^[A-Za-z]:$/

/** Media URL for an absolute Windows (drive or UNC) or POSIX path. Relative or empty paths produce a URL main rejects. */
export function mediaUrl(filePath: string): string {
  const host = /^[\\/]{2}/.test(filePath) ? 'unc' : 'local'
  const segments = filePath.split(/[\\/]+/).filter((s) => s.length > 0)
  // Keep a leading drive letter readable (`C:` rather than `C%3A`); a colon in a path segment is valid in a URL.
  const encoded = segments.map((s, i) => (i === 0 && host === 'local' && DRIVE_SEGMENT.test(s) ? s : encodeURIComponent(s)))
  return `${MEDIA_SCHEME}://${host}/${encoded.join('/')}`
}

/**
 * Inverse of mediaUrl (main process): return the file path the URL names, or null when it is malformed,
 * has a foreign scheme/host, or contains traversal (`.`/`..`), empty segments, separators or NUL inside a segment.
 * `platform` decides how a `local` path is read: Windows requires a drive letter; other platforms read it as POSIX.
 */
export function pathFromMediaUrl(url: string, platform: NodeJS.Platform | string = 'win32'): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null
  if (parsed.username || parsed.password || parsed.port) return null
  const host = parsed.hostname.toLowerCase()
  if (host !== 'local' && host !== 'unc') return null
  const raw = parsed.pathname.split('/').slice(1)
  if (raw.length === 0) return null
  const segments: string[] = []
  for (const part of raw) {
    let s: string
    try {
      s = decodeURIComponent(part)
    } catch {
      return null
    }
    if (s.length === 0 || s === '.' || s === '..' || /[\\/\0]/.test(s)) return null
    segments.push(s)
  }
  if (host === 'unc') {
    // At least \\server\share\file; `?` / `.` servers would be device paths (\\?\, \\.\).
    if (segments.length < 3 || segments[0] === '?' || segments[0] === '.') return null
    return `\\\\${segments.join('\\')}`
  }
  if (platform === 'win32') {
    if (!DRIVE_SEGMENT.test(segments[0]) || segments.length < 2) return null
    return segments.join('\\')
  }
  return `/${segments.join('/')}`
}
