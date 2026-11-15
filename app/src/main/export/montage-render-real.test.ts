/**
 * Montage render stage with the real pinned FFmpeg: generated 1920×1080 60 fps testsrc2 sources with sine audio and fake
 * kill events → planAutoEdit → autoEditToProject → runMontage. Checks duration (±1 frame of the plan), fps, size, audio,
 * the dip brightness at a cut, the caption colour at its position, and music ducking (Goertzel in Node).
 * Skipped (with the reason printed) when ffmpeg/ffprobe or a working H.264 encoder is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { clipOutputSec, DEFAULT_AUTO_EDIT_OPTIONS, planTotalSec, type AutoEditPlan, type AutoEditSource, type MontageStyle } from '../../shared/autoEdit'
import { planAutoEdit } from '../../shared/autoEditPlan'
import { autoEditToProject } from '../../shared/autoEditProject'
import { DEFAULT_EXPORT_FORMAT, type ExportFormat } from '../../shared/exportFormat'
import { applyPreset } from '../../shared/exportPresets'
import type { StreamProbe } from '../../shared/exportCompat'
import type { EngineEvent } from '../../shared/types'
import { createDurationProbe, runMontage } from './montage-run'
import { solidPng } from './montage-text'

const exe = process.platform === 'win32' ? '.exe' : ''
function findBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const candidates = [
    name === 'ffmpeg' ? process.env.ADITOR_FFMPEG : process.env.ADITOR_FFPROBE,
    process.env.ADITOR_FFMPEG ? path.join(path.dirname(process.env.ADITOR_FFMPEG), name + exe) : undefined,
    path.resolve(__dirname, '../../../../build/ffmpeg/bin', name + exe),
    name
  ].filter((c): c is string => !!c)
  for (const c of candidates) if (spawnSync(c, ['-version'], { windowsHide: true }).status === 0) return c
  return null
}
const FFMPEG = findBin('ffmpeg')
const FFPROBE = findBin('ffprobe')
const run = (bin: string, args: string[]) => spawnSync(bin, args, { windowsHide: true, maxBuffer: 1 << 28 })
const ENCODER = FFMPEG
  ? ['h264_nvenc', 'libopenh264', 'h264_qsv', 'h264_amf'].find(
      (e) => run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=0.1', '-c:v', e, '-f', 'null', '-']).status === 0
    ) ?? null
  : null
const SKIP_REASON = !FFMPEG || !FFPROBE ? 'ffmpeg/ffprobe not found (ADITOR_FFMPEG, build/ffmpeg/bin or PATH)' : !ENCODER ? 'no working H.264 encoder' : null
if (SKIP_REASON) console.warn(`[montage-render-real] skipped: ${SKIP_REASON}`)
const describeReal = SKIP_REASON ? describe.skip : describe

const FPS = 60
const W = 1920
const H = 1080
/** Caption stub colour: pure green, easy to find in a decoded frame. */
const GREEN: [number, number, number, number] = [0, 255, 0, 255]
const probe: StreamProbe = { vcodec: 'h264', width: W, height: H, fps: FPS, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 }

let seq = 0
const kills = (...ts: number[]): EngineEvent[] =>
  ts.map((t) => ({ id: `k${seq++}`, t, type: 'kill', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto' }))

interface Probed {
  width: number
  height: number
  fps: string
  videoSec: number
  frames: number
  hasAudio: boolean
}
function probeOut(file: string): Probed {
  const r = JSON.parse(run(FFPROBE!, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration,nb_frames', '-of', 'json', file]).stdout.toString())
  const v = r.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
  return { width: v.width, height: v.height, fps: v.r_frame_rate, videoSec: Number(v.duration), frames: Number(v.nb_frames), hasAudio: r.streams.some((s: { codec_type: string }) => s.codec_type === 'audio') }
}
/** One decoded frame at output time t, scaled to w×h, as raw bytes (gray or rgb24). */
function frameAt(file: string, t: number, pixFmt: 'gray' | 'rgb24', w = 192, h = 108): Buffer {
  const r = run(FFMPEG!, ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'])
  expect(r.status).toBe(0)
  return r.stdout
}
const mean = (b: Buffer): number => b.reduce((s, v) => s + v, 0) / b.length
/** Mean RGB of a small block centred on (x, y) of a w-wide rgb24 frame. */
function rgbAt(b: Buffer, w: number, x: number, y: number): [number, number, number] {
  const acc = [0, 0, 0]
  let n = 0
  for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
    const o = ((y + dy) * w + (x + dx)) * 3
    for (let c = 0; c < 3; c++) acc[c] += b[o + c]
    n++
  }
  return acc.map((v) => v / n) as [number, number, number]
}
/** Goertzel power of `freq` in mono f32 samples. */
function goertzel(x: Float32Array, freq: number, sr: number): number {
  const k = (2 * Math.cos((2 * Math.PI * freq) / sr))
  let s1 = 0
  let s2 = 0
  for (const v of x) {
    const s = v + k * s1 - s2
    s2 = s1
    s1 = s
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (x.length * x.length)
}
function audioWindow(file: string, a: number, b: number): Float32Array {
  const r = run(FFMPEG!, ['-v', 'error', '-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-i', file, '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'])
  expect(r.status).toBe(0)
  const buf = r.stdout
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)))
}
/** Output start time of each clip (no slow-mo in the styles checked here besides Cinematic). */
function clipStarts(plan: AutoEditPlan): number[] {
  let t = plan.intro?.durationSec ?? 0
  return plan.clips.map((c) => {
    const s = t
    t += clipOutputSec(c)
    return s
  })
}

describeReal('real ffmpeg montage render', () => {
  let root: string
  let A: string
  let B: string
  let music: string
  const results: string[] = []

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-montage-real-'))
    const dir = path.join(root, 'Vidéos 試合 OneDrive')
    fs.mkdirSync(dir)
    A = path.join(dir, 'match A.mp4')
    B = path.join(dir, "match it's B.mp4")
    music = path.join(dir, 'music track.m4a')
    const src = (file: string, freq: number, audioFilter: string): void => {
      const r = run(FFMPEG!, [
        '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=30`, '-f', 'lavfi', '-i', `sine=f=${freq}:sample_rate=48000:d=30`,
        '-af', audioFilter, '-c:v', ENCODER!, '-b:v', '6M', '-c:a', 'aac', '-ac', '2', '-shortest', '-y', file
      ])
      expect(r.status, r.stderr.toString()).toBe(0)
    }
    src(A, 440, 'volume=1')
    // B: game audio silent from 15 s on (the "quiet" section for the ducking check).
    src(B, 660, "volume=0:enable='gte(t,15)'")
    const m = run(FFMPEG!, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=1000:sample_rate=48000:d=60', '-ac', '2', '-c:a', 'aac', '-f', 'mp4', '-y', music])
    expect(m.status, m.stderr.toString()).toBe(0)
  }, 300_000)

  afterAll(() => {
    if (results.length) console.log('[montage-render-real] planned vs ffprobe:\n' + results.join('\n'))
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  const sources = (): AutoEditSource[] => [
    { path: A, durationSec: 30, recordedAt: 1000, hasAudio: true, events: kills(5, 6, 20) },
    { path: B, durationSec: 30, recordedAt: 2000, hasAudio: true, events: kills(5, 20, 21, 22) }
  ]

  async function render(style: MontageStyle, opts: { music?: boolean; format?: ExportFormat } = {}) {
    const plan = planAutoEdit(sources(), { ...DEFAULT_AUTO_EDIT_OPTIONS, sources: [], targetSec: 'all', style, musicPath: opts.music ? music : null })
    const project = autoEditToProject(plan, 'p', 'Auto edit')
    const outputDir = path.join(root, `out ${style}${opts.music ? ' music' : ''}`)
    fs.mkdirSync(outputDir)
    const tempDir = path.join(root, 'tmp')
    fs.mkdirSync(tempDir, { recursive: true })
    const result = await runMontage(
      {
        items: project.items,
        style: { style: project.style, music: project.music, intro: project.intro, outro: project.outro, letterbox: project.letterbox },
        format: opts.format ?? DEFAULT_EXPORT_FORMAT,
        encoder: ENCODER!,
        probes: new Map([[A, probe], [B, probe]]),
        outputDir,
        baseName: `montage ${style}`,
        estimatedBytes: 1
      },
      {
        ffmpeg: { bin: FFMPEG! },
        tempDir,
        renderTextPng: async (_text, o) => solidPng(o.heightPx * 4, o.heightPx, GREEN),
        probeDuration: createDurationProbe(FFPROBE!)
      }
    )
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('render failed')
    expect(fs.readdirSync(tempDir)).toEqual([])
    const file = result.outputs[0]
    const p = probeOut(file)
    const planned = planTotalSec(plan.clips, plan.intro, plan.outro)
    results.push(`  ${style}${opts.music ? '+music' : ''}: planned ${planned.toFixed(4)} s, expected ${result.expectedSec.toFixed(4)} s, ffprobe video ${p.videoSec.toFixed(4)} s (${p.frames} frames), ${p.width}x${p.height} @ ${p.fps}`)
    expect(Math.abs(p.videoSec - planned)).toBeLessThanOrEqual(1 / FPS + 1e-3)
    expect(p.fps).toBe('60/1')
    expect(p.hasAudio).toBe(true)
    return { plan, file, p, result }
  }

  it('Clean: plain cuts at the planned length', async () => {
    const { p } = await render('clean')
    expect([p.width, p.height]).toEqual([W, H])
  }, 600_000)

  it('Hype with music: white dip at the cut, green caption in its window, music ducked under game audio', async () => {
    const { plan, file } = await render('hype', { music: true })
    const starts = clipStarts(plan)
    // Dip: the last frames before the first cut are washed towards white.
    const cut = starts[1]
    const body = mean(frameAt(file, cut - 1.2, 'gray'))
    const dip = mean(frameAt(file, cut - 0.03, 'gray'))
    expect(dip).toBeGreaterThan(body + 40)
    // Caption: the 2k clip has "DOUBLE KILL" at its last kill; the stub PNG is green, centred in the lower third.
    const ci = plan.clips.findIndex((c) => c.overlay)
    const c = plan.clips[ci]
    const capT = starts[ci] + (c.overlay!.at - c.in) + 0.6
    const [r, g, b] = rgbAt(frameAt(file, capT, 'rgb24'), 192, 96, 72)
    expect(g).toBeGreaterThan(180)
    expect(r).toBeLessThan(90)
    expect(b).toBeLessThan(90)
    const before = rgbAt(frameAt(file, starts[ci] + 0.5, 'rgb24'), 192, 96, 72)
    expect(before[1] > 180 && before[0] < 90 && before[2] < 90).toBe(false)
    // Ducking: 1 kHz music under loud game audio (A's double kill) vs under silent game audio (B's triple kill, after 15 s).
    const loudClip = plan.clips.findIndex((x) => x.source === A)
    const quietClip = plan.clips.findIndex((x) => x.source === B && x.in >= 15)
    expect(quietClip).toBeGreaterThan(-1)
    const window = (i: number): [number, number] => [starts[i] + 1.2, starts[i] + 1.2 + 1.5]
    const loud = goertzel(audioWindow(file, ...window(loudClip)), 1000, 48000)
    const quiet = goertzel(audioWindow(file, ...window(quietClip)), 1000, 48000)
    results.push(`    ducking: 1 kHz power loud-game ${loud.toExponential(3)} vs quiet-game ${quiet.toExponential(3)} (ratio ${(quiet / loud).toFixed(1)})`)
    expect(quiet).toBeGreaterThan(loud * 4)
  }, 600_000)

  it('Cinematic: letterbox bars, intro card; slow motion is in the measured length', async () => {
    const { file, plan } = await render('cinematic')
    expect(plan.clips.some((c) => c.effects.some((e) => e.kind === 'slowmo'))).toBe(true)
    // Intro (blurred first frame + card text, the green stub) centred on screen.
    const [r, g, b] = rgbAt(frameAt(file, 1, 'rgb24'), 192, 96, 54)
    expect([g > 180, r < 90, b < 90]).toEqual([true, true, true])
    const starts = clipStarts(plan)
    const f = frameAt(file, starts[0] + 1.5, 'gray', 192, 108)
    const rowMean = (y: number): number => mean(f.subarray(y * 192, (y + 1) * 192))
    expect(rowMean(2)).toBeLessThan(25)
    expect(rowMean(105)).toBeLessThan(25)
    expect(rowMean(54)).toBeGreaterThan(40)
  }, 600_000)

  it('Shorts renders 1080×1920', async () => {
    const { p } = await render('shorts', { format: applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts') })
    expect([p.width, p.height]).toEqual([1080, 1920])
  }, 600_000)
})
