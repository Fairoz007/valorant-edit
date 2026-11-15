import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createMediaAccess, handleMediaRequest, mediaMimeType, parseRange } from './media-protocol'
import { mediaUrl } from '../shared/media-url'

const IS_WIN = process.platform === 'win32'

let root: string
let videoPath: string
let thumbPath: string
let outsidePath: string
let proxyRoot: string
let proxyFile: string
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))

const access = () => createMediaAccess({
  libraryEntries: () => [{ path: videoPath, thumb: thumbPath }],
  cacheRoots: () => [proxyRoot]
})
const get = (p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> =>
  handleMediaRequest(new Request(mediaUrl(p), { method, headers }), access())
const bytesOf = async (r: Response): Promise<Buffer> => Buffer.from(await r.arrayBuffer())

beforeAll(() => {
  // Non-ASCII, space, #, % and ? -free (Windows forbids ?) folder name, like a real user library.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'メディア #1 100% '))
  videoPath = path.join(root, 'clip a#1.mp4')
  thumbPath = path.join(root, 'thumb ü.jpg')
  outsidePath = path.join(root, 'not in library.mp4')
  proxyRoot = path.join(root, 'proxy')
  fs.mkdirSync(path.join(proxyRoot, 'thumbs'), { recursive: true })
  proxyFile = path.join(proxyRoot, 'abc.mp4')
  fs.writeFileSync(videoPath, BYTES)
  fs.writeFileSync(thumbPath, BYTES.subarray(0, 10))
  fs.writeFileSync(outsidePath, BYTES)
  fs.writeFileSync(proxyFile, BYTES.subarray(0, 20))
  fs.writeFileSync(path.join(proxyRoot, 'thumbs', 'x.jpg'), BYTES.subarray(0, 5))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('parseRange', () => {
  test.each([
    [null, 100, null],
    ['bytes=0-', 100, { start: 0, end: 99 }],
    ['bytes=10-19', 100, { start: 10, end: 19 }],
    ['bytes=90-500', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=20-10', 100, null],
    ['bytes=0-1,5-6', 100, null],
    ['items=0-1', 100, null],
    ['bytes=-', 100, null]
  ] as const)('%s of %d → %j', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected)
  })
})

describe('handleMediaRequest', () => {
  test('allowed library video → 200 with the whole file, length, type and Accept-Ranges', async () => {
    const r = await get(videoPath)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('video/mp4')
    expect(r.headers.get('content-length')).toBe('1000')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect((await bytesOf(r)).equals(BYTES)).toBe(true)
  })

  test('range request → 206 with the exact bytes and Content-Range', async () => {
    const r = await get(videoPath, { Range: 'bytes=100-199' })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(r.headers.get('content-length')).toBe('100')
    expect((await bytesOf(r)).equals(BYTES.subarray(100, 200))).toBe(true)
  })

  test('open-ended and suffix ranges', async () => {
    const open = await get(videoPath, { Range: 'bytes=990-' })
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000')
    expect((await bytesOf(open)).equals(BYTES.subarray(990))).toBe(true)
    const suffix = await get(videoPath, { Range: 'bytes=-4' })
    expect(suffix.headers.get('content-range')).toBe('bytes 996-999/1000')
    expect((await bytesOf(suffix)).equals(BYTES.subarray(996))).toBe(true)
  })

  test('range past the end → 416 with Content-Range: bytes */size', async () => {
    const r = await get(videoPath, { Range: 'bytes=5000-' })
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */1000')
  })

  test('HEAD returns headers only', async () => {
    const r = await get(videoPath, {}, 'HEAD')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-length')).toBe('1000')
    expect((await bytesOf(r)).length).toBe(0)
  })

  test('other methods → 405', async () => {
    const r = await handleMediaRequest(new Request(mediaUrl(videoPath), { method: 'POST', body: 'x' }), access())
    expect(r.status).toBe(405)
  })

  test('library thumbnail and files inside the proxy cache are served', async () => {
    const thumb = await get(thumbPath)
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    expect((await get(proxyFile)).status).toBe(200)
    expect((await get(path.join(proxyRoot, 'thumbs', 'x.jpg'))).status).toBe(200)
  })

  test('a file the app does not know about → 403, even next to a library file', async () => {
    expect((await get(outsidePath)).status).toBe(403)
    expect((await get(path.join(os.homedir(), 'secret.mp4'))).status).toBe(403)
  })

  test('non-media extensions are never served, even inside the proxy cache', async () => {
    const json = path.join(proxyRoot, 'library.json')
    fs.writeFileSync(json, '{}')
    expect((await get(json)).status).toBe(403)
  })

  test('.. traversal is rejected (403), whether literal or percent-encoded', async () => {
    // Escaping the proxy cache with `..` lands on a file that is not allowlisted.
    const viaDots = `${mediaUrl(proxyRoot)}/../${encodeURIComponent('not in library.mp4')}`
    expect((await handleMediaRequest(new Request(viaDots), access())).status).toBe(403)
    const viaEncodedDots = `${mediaUrl(proxyRoot)}/%2E%2E/${encodeURIComponent('not in library.mp4')}`
    expect((await handleMediaRequest(new Request(viaEncodedDots), access())).status).toBe(403)
    // Separators smuggled inside one segment are rejected before the allowlist (400).
    const smuggled = `${mediaUrl(proxyRoot)}/..${IS_WIN ? '%5C' : '%2F'}${encodeURIComponent('not in library.mp4')}`
    expect((await handleMediaRequest(new Request(smuggled), access())).status).toBe(400)
  })

  test('allowlisted but missing file → 404', async () => {
    const gone = path.join(root, 'gone.mp4')
    const a = createMediaAccess({ libraryEntries: () => [{ path: gone }], cacheRoots: () => [] })
    expect((await handleMediaRequest(new Request(mediaUrl(gone)), a)).status).toBe(404)
  })

  test('foreign host / malformed URL → 400', async () => {
    expect((await handleMediaRequest(new Request('aditor-media://evil/C:/a.mp4'), access())).status).toBe(400)
  })
})

describe('createMediaAccess', () => {
  test.runIf(IS_WIN)('Windows: case and separator differences still match the library entry', () => {
    const a = createMediaAccess({ libraryEntries: () => [{ path: 'D:\\Clips\\A.mp4' }], cacheRoots: () => ['C:\\AppData\\proxy'], platform: 'win32' })
    expect(a.isAllowed('d:/clips/a.MP4')).toBe(true)
    expect(a.isAllowed('c:\\appdata\\PROXY\\thumbs\\x.jpg')).toBe(true)
    expect(a.isAllowed('C:\\AppData\\proxy')).toBe(false) // The root itself is not a file to serve.
    expect(a.isAllowed('C:\\AppData\\proxy-evil\\x.mp4')).toBe(false) // Prefix match is not containment.
  })

  test('project sources become servable once a project referencing them is loaded or saved; UNC and junk are ignored', () => {
    const a = createMediaAccess({ libraryEntries: () => [], cacheRoots: () => [], platform: 'win32' })
    expect(a.isAllowed('E:\\old\\removed.mp4')).toBe(false)
    a.allowProjectSources(['E:\\old\\removed.mp4', '\\\\server\\share\\x.mp4', 42, null, 'relative.mp4', 'E:\\x\\notes.txt'])
    expect(a.isAllowed('E:\\old\\removed.mp4')).toBe(true)
    expect(a.isAllowed('\\\\server\\share\\x.mp4')).toBe(false)
    expect(a.isAllowed('E:\\x\\notes.txt')).toBe(false)
  })

  test('library changes apply on the next request (entries are read live)', () => {
    const entries: { path: string }[] = []
    const a = createMediaAccess({ libraryEntries: () => entries, cacheRoots: () => [] })
    const p = path.join(os.tmpdir(), 'later.mp4')
    expect(a.isAllowed(p)).toBe(false)
    entries.push({ path: p })
    expect(a.isAllowed(p)).toBe(true)
  })
})

test('mediaMimeType', () => {
  expect(mediaMimeType('a.MKV')).toBe('video/x-matroska')
  expect(mediaMimeType('a.webm')).toBe('video/webm')
  expect(mediaMimeType('a.bin')).toBe('application/octet-stream')
})

// Real media: a 3 s H.264 clip generated by the staged FFmpeg, in a folder with a space and non-ASCII characters.
const FFMPEG = [process.env.ADITOR_FFMPEG, path.resolve(__dirname, '../../../build/ffmpeg/bin/ffmpeg.exe')]
  .find((p): p is string => !!p && fs.existsSync(p))

describe.runIf(!!FFMPEG)('real clip through the handler', () => {
  let dir: string
  let clip: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'テスト clips '))
    clip = path.join(dir, 'a #1 100%.mp4')
    const r = spawnSync(FFMPEG!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-t', '3',
      '-pix_fmt', 'yuv420p', clip], { windowsHide: true })
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  }, 60_000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('full and ranged reads return exactly the bytes on disk', async () => {
    const onDisk = fs.readFileSync(clip)
    expect(onDisk.length).toBeGreaterThan(10_000)
    const a = createMediaAccess({ libraryEntries: () => [{ path: clip }], cacheRoots: () => [] })
    const full = await handleMediaRequest(new Request(mediaUrl(clip)), a)
    expect(full.status).toBe(200)
    expect((await bytesOf(full)).equals(onDisk)).toBe(true)

    const mid = Math.floor(onDisk.length / 2)
    const ranged = await handleMediaRequest(new Request(mediaUrl(clip), { headers: { Range: `bytes=${mid}-${mid + 4095}` } }), a)
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes ${mid}-${mid + 4095}/${onDisk.length}`)
    const got = await bytesOf(ranged)
    expect(got.length).toBe(4096)
    expect(got.equals(onDisk.subarray(mid, mid + 4096))).toBe(true)
    // The MP4 container header is what Chromium reads first.
    const head = await bytesOf(await handleMediaRequest(new Request(mediaUrl(clip), { headers: { Range: 'bytes=0-11' } }), a))
    expect(head.subarray(4, 8).toString('ascii')).toBe('ftyp')
  })
})
