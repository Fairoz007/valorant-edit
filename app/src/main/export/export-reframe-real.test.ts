/**
 * Real ffmpeg/ffprobe export of the reframing formats (export-ipc → plan → run): platform presets (Shorts, Square), crop offset,
 * blur background, concat reframing and H.265. Each output is probed (size, fps, codec, duration) and one decoded frame is searched for
 * coloured markers whose expected output position is derived from computeReframe(), the same geometry the plan uses.
 *
 * Fixture (1920×1080, 60 fps, 3 s, mpeg4 + AAC sine), built only from filters in the bundled build (color, testsrc2, overlay, drawbox, format):
 * - black background, so the markers are unambiguous;
 * - marker A: pure green 40×40 at (900,500), centre (920,520): inside the centre 9:16 crop (x 656..1264) and the square crop (x 420..1500),
 *   outside the right-edge 9:16 crop (x 1312..1920);
 * - marker B: pure magenta 40×40 at (1600,300), centre (1620,320): only inside the right-edge 9:16 crop (offset 1);
 * - testsrc2 (moving content for the encoder) 384×216 at (0,760): outside every crop; in blur mode it is excluded from the marker search.
 * In blur mode both markers stay out of the visible background: the background only shows source x ≈ 656..1264 (marker B is outside)
 * and source rows < 369 or > 711 (marker A, rows 500..540, sits behind the foreground band).
 *
 * Needs ffmpeg + ffprobe (ADITOR_FFMPEG, repo build/ffmpeg/bin, or PATH) and a working H.264 encoder from detectEncoders(); skipped otherwise.
 * The H.265 test additionally needs a working hevc_* hardware encoder.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createExportService } from './export-ipc'
import { createAudioProbe, createCutLookup, createMediaEndProbe } from './keyframe'
import { detectEncoders, pickEncoder } from './encoders'
import { computeReframe, type ReframeGeometry } from '../../shared/reframe'
import { applyPreset, resolveOutputSpec } from '../../shared/exportPresets'
import { DEFAULT_EXPORT_FORMAT, type ExportFormat } from '../../shared/exportFormat'

const exe = process.platform === 'win32' ? '.exe' : ''

function findBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const candidates = [
    name === 'ffmpeg' ? process.env.ADITOR_FFMPEG : process.env.ADITOR_FFPROBE,
    process.env.ADITOR_FFMPEG ? path.join(path.dirname(process.env.ADITOR_FFMPEG), name + exe) : undefined,
    path.resolve(__dirname, '../../../../build/ffmpeg/bin', name + exe),
    name
  ].filter((c): c is string => !!c)
  for (const c of candidates) {
    if (spawnSync(c, ['-version'], { windowsHide: true }).status === 0) return c
  }
  return null
}

const FFMPEG = findBin('ffmpeg')
const FFPROBE = findBin('ffprobe')
const run = (bin: string, args: string[]) => spawnSync(bin, args, { encoding: 'utf-8', windowsHide: true, maxBuffer: 1 << 26 })

// Encoders that pass a real test encode (same detection as the app). Only probed when ffmpeg exists.
const ENCODERS = FFMPEG && FFPROBE ? await detectEncoders(FFMPEG) : []
const H264 = pickEncoder(ENCODERS, 'h264')
const HEVC = pickEncoder(ENCODERS, 'h265')

const SRC = { width: 1920, height: 1080 }
const FPS = 60
const DURATION = 3
const FRAME = 1 / FPS
const MARKER = 40

interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Marker {
  name: string
  box: Box
  /** Pixel test for the decoded rgb24 colour (after yuv420p/encode round trips). */
  match: (r: number, g: number, b: number) => boolean
}
const GREEN: Marker = { name: 'green', box: { x: 900, y: 500, width: MARKER, height: MARKER }, match: (r, g, b) => g > 150 && r < 100 && b < 100 }
const MAGENTA: Marker = { name: 'magenta', box: { x: 1600, y: 300, width: MARKER, height: MARKER }, match: (r, g, b) => r > 150 && b > 150 && g < 100 }
const TESTSRC: Box = { x: 0, y: 760, width: 384, height: 216 }

const SHORTS = applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts')
const SQUARE = applyPreset(DEFAULT_EXPORT_FORMAT, 'square')

/** Geometry for the fixture exactly as plan.ts computes it (resolveOutputSpec + computeReframe with the source size). */
function geometry(fmt: ExportFormat): ReframeGeometry {
  const out = resolveOutputSpec({ ...SRC, fps: FPS }, fmt)
  return computeReframe(SRC, out, fmt.reframe, fmt.offset)
}

/** Source point (continuous pixel coordinates) → output point: pos + (p − crop.origin) × scaled / crop.size. */
function mapPoint(g: ReframeGeometry, x: number, y: number): { x: number; y: number } {
  return {
    x: g.pos.x + ((x - g.crop.x) * g.scaled.width) / g.crop.width,
    y: g.pos.y + ((y - g.crop.y) * g.scaled.height) / g.crop.height
  }
}
function mapBox(g: ReframeGeometry, b: Box): Box {
  const a = mapPoint(g, b.x, b.y)
  const c = mapPoint(g, b.x + b.width, b.y + b.height)
  return { x: a.x, y: a.y, width: c.x - a.x, height: c.y - a.y }
}
/** Whether the whole marker is inside the shown source region (fixture markers are either fully in or fully out). */
const inCrop = (g: ReframeGeometry, b: Box): boolean =>
  b.x >= g.crop.x && b.y >= g.crop.y && b.x + b.width <= g.crop.x + g.crop.width && b.y + b.height <= g.crop.y + g.crop.height

interface VideoInfo {
  width: number
  height: number
  fps: number
  codec: string
  tag: string
  duration: number
}
function videoInfo(file: string): VideoInfo {
  const r = run(FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,codec_name,codec_tag_string,duration', '-of', 'json', file])
  expect(r.status, r.stderr).toBe(0)
  const s = JSON.parse(r.stdout).streams[0]
  const [num, den] = String(s.avg_frame_rate).split('/').map(Number)
  return { width: s.width, height: s.height, fps: num / (den || 1), codec: s.codec_name, tag: s.codec_tag_string, duration: Number(s.duration) }
}

function expectFormat(info: VideoInfo, g: ReframeGeometry, codec: string, duration: number, frames = 1): void {
  expect({ width: info.width, height: info.height, codec: info.codec }).toEqual({ width: g.out.width, height: g.out.height, codec })
  expect(info.fps).toBeCloseTo(g.fps, 1)
  expect(Math.abs(info.duration - duration), `duration ${info.duration}`).toBeLessThanOrEqual(frames * FRAME + 0.005)
}

/** One decoded frame as rgb24 (row-major, 3 bytes per pixel). */
function grabFrame(file: string, at: number, width: number, height: number): Buffer {
  const r = spawnSync(FFMPEG!, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    windowsHide: true,
    maxBuffer: 1 << 26
  })
  expect(r.status, r.stderr?.toString()).toBe(0)
  expect(r.stdout.length).toBe(width * height * 3)
  return r.stdout
}

interface Found {
  count: number
  /** Centroid in continuous pixel coordinates (pixel i covers [i, i+1)). */
  x: number
  y: number
  bbox: Box
}
function findMarker(frame: Buffer, width: number, height: number, m: Marker, exclude: Box): Found {
  let count = 0
  let sx = 0
  let sy = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= exclude.x && x < exclude.x + exclude.width && y >= exclude.y && y < exclude.y + exclude.height) continue
      const i = (y * width + x) * 3
      if (!m.match(frame[i], frame[i + 1], frame[i + 2])) continue
      count++
      sx += x
      sy += y
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return { count, x: sx / (count || 1) + 0.5, y: sy / (count || 1) + 0.5, bbox: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } }
}

const TOLERANCE = 6

/** Every marker lands where computeReframe() puts it, or is absent when the geometry crops it out. */
function expectMarkers(file: string, g: ReframeGeometry, expected: Record<string, boolean>): void {
  const { width, height } = g.out
  const frame = grabFrame(file, 1.0, width, height)
  const t = mapBox(g, TESTSRC)
  const exclude = { x: t.x - 8, y: t.y - 8, width: t.width + 16, height: t.height + 16 }
  for (const m of [GREEN, MAGENTA]) {
    const visible = inCrop(g, m.box)
    // Guard the fixture design: the geometry must agree with which marker this case is meant to show.
    expect(visible, `${m.name} visibility from computeReframe`).toBe(expected[m.name])
    const found = findMarker(frame, width, height, m, exclude)
    if (!visible) {
      expect(found.count, `${m.name} must be cropped out`).toBeLessThan(20)
      continue
    }
    const want = mapBox(g, m.box)
    const cx = want.x + want.width / 2
    const cy = want.y + want.height / 2
    // At least a third of the scaled marker area survives the colour threshold (edges blend under 4:2:0 chroma).
    expect(found.count, `${m.name} pixel count`).toBeGreaterThan((want.width * want.height) / 3)
    expect(Math.abs(found.x - cx), `${m.name} x ${found.x} vs ${cx}`).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(found.y - cy), `${m.name} y ${found.y} vs ${cy}`).toBeLessThanOrEqual(TOLERANCE)
    // No stray matches elsewhere (e.g. from the blurred background): the matched pixels form one marker-sized blob.
    expect(found.bbox.width, `${m.name} bbox width`).toBeLessThanOrEqual(want.width + 10)
    expect(found.bbox.height, `${m.name} bbox height`).toBeLessThanOrEqual(want.height + 10)
    if (g.kind === 'blur') {
      // Inside the sharp foreground band, not the blurred background.
      expect(found.y).toBeGreaterThanOrEqual(g.pos.y)
      expect(found.y).toBeLessThan(g.pos.y + g.scaled.height)
    }
  }
}

// Runs without ffmpeg: pins the hand-derived numbers the real exports below are checked against.
it('reframe geometry for the fixture matches the hand-derived numbers', () => {
  expect(geometry({ ...SHORTS, offset: 0 })).toMatchObject({ kind: 'crop', out: { width: 1080, height: 1920 }, fps: 60, crop: { x: 656, y: 0, width: 608, height: 1080 } })
  expect(geometry({ ...SHORTS, offset: 1 })).toMatchObject({ kind: 'crop', crop: { x: 1312, y: 0, width: 608, height: 1080 } })
  expect(geometry(SQUARE)).toMatchObject({ kind: 'crop', out: { width: 1080, height: 1080 }, fps: 60, crop: { x: 420, y: 0, width: 1080, height: 1080 } })
  expect(geometry({ ...SHORTS, reframe: 'blur' })).toMatchObject({ kind: 'blur', scaled: { width: 1080, height: 608 }, pos: { x: 0, y: 656 } })
  // Marker centres in the output: green (920,520) and magenta (1620,320).
  const centre = (g: ReframeGeometry, m: Marker) => mapPoint(g, m.box.x + MARKER / 2, m.box.y + MARKER / 2)
  expect(centre(geometry({ ...SHORTS, offset: 0 }), GREEN).x).toBeCloseTo(468.95, 1) // (920-656)*1080/608
  expect(centre(geometry({ ...SHORTS, offset: 0 }), GREEN).y).toBeCloseTo(924.44, 1) // 520*1920/1080
  expect(centre(geometry({ ...SHORTS, offset: 1 }), MAGENTA).x).toBeCloseTo(547.11, 1) // (1620-1312)*1080/608
  expect(centre(geometry({ ...SHORTS, offset: 1 }), MAGENTA).y).toBeCloseTo(568.89, 1) // 320*1920/1080
  expect(centre(geometry(SQUARE), GREEN)).toEqual({ x: 500, y: 520 })
  expect(centre(geometry({ ...SHORTS, reframe: 'blur' }), GREEN).x).toBeCloseTo(517.5, 1) // 920*1080/1920
  expect(centre(geometry({ ...SHORTS, reframe: 'blur' }), GREEN).y).toBeCloseTo(948.74, 1) // 656+520*608/1080
  expect(centre(geometry({ ...SHORTS, reframe: 'blur' }), MAGENTA).x).toBeCloseTo(911.25, 1) // 1620*1080/1920
  expect(centre(geometry({ ...SHORTS, reframe: 'blur' }), MAGENTA).y).toBeCloseTo(836.15, 1) // 656+320*608/1080
})

const describeReal = FFMPEG && FFPROBE && H264 ? describe : describe.skip

describeReal(`real ffmpeg export: reframing, presets and codecs (H.264 encoder: ${H264 ?? 'none'})`, () => {
  let root: string
  let outDir: string
  let source: string
  const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => undefined })
  const service = () =>
    createExportService({
      ffmpeg: { bin: FFMPEG! },
      tempDir: path.join(root, 'tmp'),
      probe: async () => ({ codec: 'mpeg4', width: SRC.width, height: SRC.height, fps: FPS }),
      hasAudio: createAudioProbe(FFPROBE!),
      copyCut: createCutLookup(FFPROBE!),
      mediaEnd: createMediaEndProbe(FFPROBE!)
    })
  const exportOne = async (baseName: string, format: ExportFormat, encoder = H264!): Promise<string> => {
    const r = await service().start(sender(), {
      items: [{ id: '1', source, start: 0, end: DURATION }],
      mode: 'separate', quality: 'precise', encoder, outDir, baseName, format
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.outputs).toHaveLength(1)
    return r.outputs[0]
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-reframe-real-'))
    outDir = path.join(root, 'out')
    fs.mkdirSync(outDir)
    source = path.join(root, 'markers.mp4')
    const box = (m: Marker, color: string) => `drawbox=x=${m.box.x}:y=${m.box.y}:w=${m.box.width}:h=${m.box.height}:color=${color}:t=fill`
    const graph =
      `color=c=black:s=${SRC.width}x${SRC.height}:r=${FPS}:d=${DURATION},format=yuv420p[bg];` +
      `testsrc2=s=${TESTSRC.width}x${TESTSRC.height}:r=${FPS}:d=${DURATION},format=yuv420p[ts];` +
      `[bg][ts]overlay=${TESTSRC.x}:${TESTSRC.y},${box(GREEN, '0x00FF00')},${box(MAGENTA, '0xFF00FF')}[v]`
    const r = run(FFMPEG!, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
      '-filter_complex', graph,
      '-map', '[v]', '-map', '0:a',
      '-c:v', 'mpeg4', '-q:v', '2', '-g', String(FPS), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-t', String(DURATION), source
    ])
    expect(r.status, r.stderr).toBe(0)
    const info = videoInfo(source)
    expect({ width: info.width, height: info.height }).toEqual(SRC)
    expect(info.fps).toBeCloseTo(FPS, 1)
  }, 120_000)
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  const cases: Array<{ name: string; format: ExportFormat; visible: Record<string, boolean> }> = [
    { name: 'Shorts, offset 0 (centre crop)', format: { ...SHORTS, offset: 0 }, visible: { green: true, magenta: false } },
    { name: 'Shorts, offset 1 (right-edge crop)', format: { ...SHORTS, offset: 1 }, visible: { green: false, magenta: true } },
    { name: 'Square, offset 0', format: { ...SQUARE, offset: 0 }, visible: { green: true, magenta: false } },
    { name: '9:16 blur background', format: { ...SHORTS, reframe: 'blur' }, visible: { green: true, magenta: true } }
  ]
  cases.forEach(({ name, format, visible }, i) => {
    it(`separate precise: ${name} → size, fps, codec, duration and marker position`, async () => {
      const g = geometry(format)
      const out = await exportOne(`reframe-${i + 1}`, format)
      expectFormat(videoInfo(out), g, 'h264', DURATION)
      expectMarkers(out, g, visible)
    }, 120_000)
  })

  it('concat precise: Shorts timeline of two clips is 1080×1920 with the summed duration', async () => {
    const clips = [
      { id: 'a', source, start: 0.2, end: 1.4 },
      { id: 'b', source, start: 1.6, end: 2.8 }
    ]
    const r = await service().start(sender(), { items: clips, mode: 'concat', quality: 'precise', encoder: H264!, outDir, baseName: 'reframe-concat', format: SHORTS })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.outputs).toHaveLength(1)
    const out = r.outputs[0]
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.startsWith('.aditor-seg'))).toEqual([])
    const g = geometry(SHORTS)
    // 1.2 s + 1.2 s; allow one frame per clip.
    expectFormat(videoInfo(out), g, 'h264', 2.4, clips.length)
    expectMarkers(out, g, { green: true, magenta: false })
  }, 120_000)

  it.skipIf(!HEVC)(
    `H.265 Shorts → hevc tagged hvc1${HEVC ? ` (${HEVC})` : ' [skipped: no working hevc_nvenc/hevc_qsv/hevc_amf encoder on this machine]'}`,
    async () => {
      const format: ExportFormat = { ...SHORTS, codec: 'h265' }
      const g = geometry(format)
      const out = await exportOne('reframe-hevc', format, HEVC!)
      const info = videoInfo(out)
      expectFormat(info, g, 'hevc', DURATION)
      expect(info.tag).toBe('hvc1')
      expectMarkers(out, g, { green: true, magenta: false })
    },
    120_000
  )
})
