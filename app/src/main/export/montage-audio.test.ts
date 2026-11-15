import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AVI_DATA_OFFSET, createBeatDetector, createMixer, detectBeatsInFile, mixPcmFiles, MIX_SAMPLE_RATE } from './montage-audio'

const SR = MIX_SAMPLE_RATE
const stereo = (frames: number, f: (i: number) => number): Float32Array => {
  const x = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) x[2 * i] = x[2 * i + 1] = f(i)
  return x
}
/** Peak of the music contribution (mix − game) over [a, b) seconds. */
function musicPeak(mix: Float32Array, game: Float32Array, a: number, b: number): number {
  let p = 0
  for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) p = Math.max(p, Math.abs(mix[2 * i] - game[2 * i]))
  return p
}

describe('mixer', () => {
  const frames = 4 * SR
  // Game: loud 440 Hz for 0..2 s, silent after. Music: constant 0.5 amplitude 1 kHz.
  const game = stereo(frames, (i) => (i < 2 * SR ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0))
  const music = stereo(frames, (i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR))

  it('ducks the music to about 30 % while the game is loud and recovers after the release', () => {
    const mix = createMixer({ totalFrames: frames, gain: 0.8, fadeInSec: 0, fadeOutSec: 0, duck: true }).process(game, music)
    const loud = musicPeak(mix, game, 0.5, 1.9)
    const quiet = musicPeak(mix, game, 3.2, 3.9)
    expect(loud).toBeCloseTo(0.5 * 0.8 * 0.3, 2)
    expect(quiet).toBeCloseTo(0.5 * 0.8, 2)
    // Attack about 10 ms: ducked well within 100 ms of the game starting.
    expect(musicPeak(mix, game, 0.1, 0.2)).toBeLessThan(0.5 * 0.8 * 0.4)
  })

  it('without ducking keeps the music level; fades in and out; clips to ±1', () => {
    const plain = createMixer({ totalFrames: frames, gain: 0.8, fadeInSec: 0, fadeOutSec: 0, duck: false }).process(game, music)
    expect(musicPeak(plain, game, 0.5, 1.9)).toBeCloseTo(0.4, 2)
    const faded = createMixer({ totalFrames: frames, gain: 1, fadeInSec: 1, fadeOutSec: 1, duck: false }).process(game, music)
    expect(musicPeak(faded, game, 0, 0.05)).toBeLessThan(0.05)
    expect(musicPeak(faded, game, 2.2, 2.8)).toBeCloseTo(0.5, 2)
    expect(musicPeak(faded, game, 3.97, 4)).toBeLessThan(0.05)
    const hot = createMixer({ totalFrames: 10, gain: 1, fadeInSec: 0, fadeOutSec: 0, duck: false }).process(stereo(10, () => 0.9), stereo(10, () => 0.9))
    expect(Math.max(...hot)).toBe(1)
  })

  it('processes in chunks with the same result and treats missing music as silence', () => {
    const whole = createMixer({ totalFrames: frames, gain: 0.8, fadeInSec: 1, fadeOutSec: 1.5, duck: true }).process(game, music)
    const m = createMixer({ totalFrames: frames, gain: 0.8, fadeInSec: 1, fadeOutSec: 1.5, duck: true })
    const parts: Float32Array[] = []
    for (let f = 0; f < frames; f += 10000) parts.push(m.process(game.subarray(2 * f, 2 * Math.min(frames, f + 10000)), music.subarray(2 * f, 2 * Math.min(frames, f + 10000))))
    const chunked = new Float32Array(whole.length)
    let o = 0
    for (const p of parts) chunked.set(p, (o += p.length) - p.length)
    expect(Array.from(chunked)).toEqual(Array.from(whole))
    const noMusic = createMixer({ totalFrames: 100, gain: 1, fadeInSec: 0, fadeOutSec: 0, duck: true }).process(game.subarray(0, 200), new Float32Array(0))
    expect(Array.from(noMusic)).toEqual(Array.from(game.subarray(0, 200)))
  })
})

describe('beat detection', () => {
  it('finds the clicks of a synthetic click track', () => {
    const period = 0.5
    const frames = 6 * SR
    const click = (i: number): number => {
      const t = i / SR
      const k = Math.round(t / period)
      const dt = t - k * period
      return dt >= 0 && dt < 0.01 && k > 0 ? Math.sin(2 * Math.PI * 2000 * dt) * Math.exp(-dt * 400) : 0.01 * Math.sin((2 * Math.PI * 220 * i) / SR)
    }
    const det = createBeatDetector()
    const x = stereo(frames, click)
    for (let f = 0; f < frames; f += 30000) det.push(x.subarray(2 * f, 2 * Math.min(frames, f + 30000)))
    const beats = det.finish()
    const expected = Array.from({ length: 11 }, (_, i) => (i + 1) * period)
    expect(beats).toHaveLength(expected.length)
    beats.forEach((b, i) => expect(Math.abs(b - expected[i])).toBeLessThan(0.025))
  })

  it('returns no beats for silence or a steady tone', () => {
    const d = createBeatDetector()
    d.push(new Float32Array(SR * 2))
    expect(d.finish()).toEqual([])
    const t = createBeatDetector()
    t.push(stereo(3 * SR, (i) => 0.3 * Math.sin((2 * Math.PI * 300 * i) / SR)))
    expect(t.finish().length).toBeLessThanOrEqual(1)
  })
})

describe('PCM files', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  const write = (file: string, x: Float32Array): void => {
    const b = Buffer.alloc(x.length * 4)
    x.forEach((v, i) => b.writeFloatLE(v, i * 4))
    fs.writeFileSync(file, b)
  }

  it('mixes files in chunks (music shorter than the game) and detects beats from a file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-mix-'))
    const g = path.join(dir, 'game.f32')
    const m = path.join(dir, 'music ü.f32')
    const o = path.join(dir, 'mix.f32')
    write(g, stereo(200000, () => 0.1))
    write(m, stereo(70000, () => 0.2))
    const progress: number[] = []
    const r = await mixPcmFiles(g, m, o, { gain: 1, fadeInSec: 0, fadeOutSec: 0, duck: false }, { onProgress: (f) => progress.push(f) })
    expect(r.frames).toBe(200000)
    const out = fs.readFileSync(o)
    // AVI: header, one 1 s chunk per 48000 frames (8-byte chunk header each), idx1.
    const chunks = Math.ceil(200000 / 48000)
    expect(out.length).toBe(AVI_DATA_OFFSET + 200000 * 4 + chunks * 8 + 8 + chunks * 16)
    expect(out.toString('ascii', 0, 4) + out.toString('ascii', 8, 12)).toBe('RIFFAVI ')
    expect(out.readUInt32LE(4)).toBe(out.length - 8)
    expect(out.toString('ascii', AVI_DATA_OFFSET, AVI_DATA_OFFSET + 4)).toBe('00wb')
    const sample = (frame: number): number => {
      const chunk = Math.floor(frame / 48000)
      return out.readInt16LE(AVI_DATA_OFFSET + (chunk + 1) * 8 + frame * 4) / 32767
    }
    expect(sample(0)).toBeCloseTo(0.3, 3)
    expect(sample(150000)).toBeCloseTo(0.1, 3)
    expect(progress.at(-1)).toBe(1)
    expect(await detectBeatsInFile(g)).toEqual([])
    const ac = new AbortController()
    ac.abort()
    await expect(mixPcmFiles(g, m, o, { gain: 1, fadeInSec: 0, fadeOutSec: 0, duck: false }, { signal: ac.signal })).rejects.toThrow()
  })
})
