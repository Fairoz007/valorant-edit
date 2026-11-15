/**
 * Caption and title-card text for the montage render stage. The pinned FFmpeg has no `drawtext`, so text is rendered
 * to a transparent PNG and placed with the `overlay` filter. Production rendering uses an offscreen Electron window
 * with the bundled Montserrat Black font; tests inject a stub (`solidPng`).
 * Also a minimal PNG writer/reader (zlib only): the pinned FFmpeg has no PNG encoder.
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

export interface TextPngOptions {
  /** Target height of the text line in output pixels. */
  heightPx: number
  /** 'pill': translucent dark box behind the text (captions over gameplay); 'transparent': text only (title cards). */
  background: 'transparent' | 'pill'
}

/** Renders one line of text to PNG bytes (RGBA, transparent background). */
export type RenderTextPng = (text: string, opts: TextPngOptions) => Promise<Buffer>

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** Encode 8-bit RGBA (`channels` 4) or RGB (`channels` 3) pixels as PNG. */
export function encodePng(pixels: Uint8Array, width: number, height: number, channels: 3 | 4 = 4): Buffer {
  if (width <= 0 || height <= 0 || pixels.length !== width * height * channels) throw new Error('Invalid PNG pixel buffer')
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Width and height from a PNG header, or null when the bytes are not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** Solid-colour RGBA PNG (test stub renderer, and an empty transparent card). */
export function solidPng(width: number, height: number, rgba: readonly [number, number, number, number]): Buffer {
  const px = new Uint8Array(width * height * 4)
  for (let i = 0; i < px.length; i += 4) px.set(rgba, i)
  return encodePng(px, width, height, 4)
}

/** Bundled Montserrat Black (copy of the renderer's font; see THIRD_PARTY_NOTICES.md §8). */
export function montageFontPath(isPackaged: boolean, resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath): string {
  const name = 'montserrat-latin-900-normal.woff2'
  if (isPackaged && resourcesPath) return path.join(resourcesPath, 'templates', 'montage', name)
  // Development: out/main → repo root (same rule as profileDir in shared/paths.ts).
  const repo = path.resolve(__dirname, '../../..')
  const dev = path.join(repo, 'templates', 'montage', name)
  return fs.existsSync(dev) ? dev : path.join(repo, 'app', 'src', 'renderer', 'assets', 'fonts', name)
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Self-contained page: the font is inlined as a data: URL, so the page loads nothing. */
export function textPageHtml(text: string, opts: TextPngOptions, fontBase64: string): string {
  const h = Math.max(8, Math.round(opts.heightPx))
  const font = Math.round(h * 0.8)
  const pad = opts.background === 'pill' ? Math.round(h * 0.25) : Math.round(h * 0.08)
  const box = opts.background === 'pill' ? `background:rgba(0,0,0,0.55);border-radius:${Math.round(h * 0.2)}px;` : ''
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    `@font-face{font-family:MontageText;src:url(data:font/woff2;base64,${fontBase64}) format('woff2');font-weight:900}` +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    `#t{display:inline-block;white-space:nowrap;font-family:MontageText,sans-serif;font-weight:900;font-size:${font}px;line-height:${h}px;` +
    `color:#fff;padding:0 ${pad}px;${box}text-shadow:0 ${Math.max(1, Math.round(h * 0.04))}px ${Math.round(h * 0.08)}px rgba(0,0,0,0.8)}` +
    `</style></head><body><span id="t">${escapeHtml(text)}</span></body></html>`
  )
}

/** Production default: the Electron renderer with the bundled font, created on first use (no Electron import until then). */
export function defaultTextRenderer(): RenderTextPng {
  let inner: RenderTextPng | null = null
  return async (text, opts) => {
    if (!inner) {
      const { app } = await import('electron')
      inner = createElectronTextRenderer(montageFontPath(app.isPackaged))
    }
    return inner(text, opts)
  }
}

/**
 * Production renderer: one hidden offscreen, transparent BrowserWindow per call, no Node integration, sandboxed,
 * loading a data: page; the text box is measured in the page and captured with `capturePage`.
 */
export function createElectronTextRenderer(fontPath: string): RenderTextPng {
  let fontBase64: string | null = null
  return async (text, opts) => {
    if (text.trim().length === 0) return solidPng(2, 2, [0, 0, 0, 0])
    fontBase64 ??= (await fs.promises.readFile(fontPath)).toString('base64')
    const { BrowserWindow } = await import('electron')
    const h = Math.max(8, Math.round(opts.heightPx))
    const win = new BrowserWindow({
      show: false,
      // Never focusable: this can run while the game is in front (Auto montage after each match).
      focusable: false,
      skipTaskbar: true,
      width: Math.min(8000, Math.max(64, Math.round(h * (text.length + 2) * 0.9))),
      height: h + 4,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true }
    })
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(textPageHtml(text, opts, fontBase64)))
      const rect = (await win.webContents.executeJavaScript(
        "document.fonts.ready.then(() => { const r = document.getElementById('t').getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) } })"
      )) as { width: number; height: number }
      win.webContents.invalidate()
      await new Promise((r) => setTimeout(r, 50))
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
      const png = image.toPNG()
      if (!pngSize(png)) throw new Error('Text rendering produced no image')
      return png
    } finally {
      win.destroy()
    }
  }
}
