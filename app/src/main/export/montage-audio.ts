/**
 * Music bed for the montage render stage, mixed in Node because the pinned FFmpeg has no amix/sidechaincompress.
 * PCM is interleaved stereo f32le at `MIX_SAMPLE_RATE`; files are processed in chunks so hours of audio never sit in memory.
 */
import fs from 'fs'

export const MIX_SAMPLE_RATE = 48000
export const MIX_CHANNELS = 2
const BYTES_PER_FRAME = 4 * MIX_CHANNELS
/** Frames per read/write chunk (about 1.4 s). */
const CHUNK_FRAMES = 65536

export interface MixOptions {
  sampleRate?: number
  /** Length of the game audio (and of the mix) in sample frames; needed for the fade-out. */
  totalFrames: number
  /** Linear music gain 0..1. */
  gain: number
  fadeInSec: number
  fadeOutSec: number
  duck: boolean
  /** Music level while ducked (fraction of `gain`). */
  duckLevel?: number
  /** Game-audio RMS above which the music is ducked (linear; 0.03 ≈ -30 dBFS). */
  thresholdRms?: number
  attackSec?: number
  releaseSec?: number
}

export const DUCK_DEFAULTS = { duckLevel: 0.3, thresholdRms: 0.03, attackSec: 0.01, releaseSec: 0.3 } as const

export interface Mixer {
  /** Mix one chunk: `game` and `music` are interleaved stereo; `music` may be shorter (the rest is silence). Returns a new buffer. */
  process(game: Float32Array, music: Float32Array): Float32Array
}

/**
 * Game audio passes through unchanged; music is scaled by gain × fade × duck and added, then clipped to ±1.
 * Ducking: an envelope follower on the game's power (time constant = attack) gives the RMS; while it is above the
 * threshold the music gain moves towards `duckLevel` with the attack time and back to 1 with the release time (no clicks).
 */
export function createMixer(o: MixOptions): Mixer {
  const sr = o.sampleRate ?? MIX_SAMPLE_RATE
  const duckLevel = o.duckLevel ?? DUCK_DEFAULTS.duckLevel
  const threshold = o.thresholdRms ?? DUCK_DEFAULTS.thresholdRms
  const coef = (sec: number): number => 1 - Math.exp(-1 / Math.max(1, sec * sr))
  const attack = coef(o.attackSec ?? DUCK_DEFAULTS.attackSec)
  const release = coef(o.releaseSec ?? DUCK_DEFAULTS.releaseSec)
  // RMS detector: power smoothed symmetrically over the attack time, so the level follows the game quickly both ways
  // and the release time applies to the music gain only.
  const detector = attack
  const fadeIn = Math.max(0, o.fadeInSec) * sr
  const fadeOut = Math.max(0, o.fadeOutSec) * sr
  let env = 0
  let duckGain = 1
  let frame = 0
  return {
    process(game, music) {
      const frames = Math.floor(game.length / MIX_CHANNELS)
      const out = new Float32Array(frames * MIX_CHANNELS)
      for (let i = 0; i < frames; i++, frame++) {
        const l = game[2 * i]
        const r = game[2 * i + 1]
        if (o.duck) {
          const power = (l * l + r * r) / 2
          env += detector * (power - env)
          const target = Math.sqrt(env) > threshold ? duckLevel : 1
          duckGain += (target < duckGain ? attack : release) * (target - duckGain)
        }
        const fi = fadeIn > 0 ? Math.min(1, frame / fadeIn) : 1
        const fo = fadeOut > 0 ? Math.min(1, Math.max(0, o.totalFrames - frame) / fadeOut) : 1
        const g = o.gain * fi * fo * duckGain
        const ml = 2 * i < music.length ? music[2 * i] : 0
        const mr = 2 * i + 1 < music.length ? music[2 * i + 1] : 0
        out[2 * i] = Math.max(-1, Math.min(1, l + ml * g))
        out[2 * i + 1] = Math.max(-1, Math.min(1, r + mr * g))
      }
      return out
    }
  }
}

async function readChunk(fh: fs.promises.FileHandle | null, frames: number): Promise<Float32Array> {
  if (!fh) return new Float32Array(0)
  const buf = Buffer.alloc(frames * BYTES_PER_FRAME)
  const { bytesRead } = await fh.read(buf, 0, buf.length, null)
  const usable = bytesRead - (bytesRead % BYTES_PER_FRAME)
  const out = new Float32Array(usable / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

function toS16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  return buf
}

export class MixCancelled extends Error {}

/**
 * Minimal audio-only AVI (PCM s16le stereo 48 kHz): the pinned FFmpeg has no raw-PCM or WAV demuxer, but it reads AVI.
 * Layout: RIFF/AVI, hdrl (avih + one auds strl), movi with one `00wb` chunk per second, idx1. Sizes are patched at the end.
 * RIFF sizes are 32-bit: up to about 6 hours of audio.
 */
export const AVI_DATA_OFFSET = 12 + 8 + 4 + (8 + 56) + (8 + 4 + (8 + 56) + (8 + 18)) + 12
const AVI_BLOCK = 4
const AVI_BYTE_RATE = MIX_SAMPLE_RATE * AVI_BLOCK

function aviHeader(dataBytes: number, chunks: number, chunkMax: number): Buffer {
  const b = Buffer.alloc(AVI_DATA_OFFSET)
  let o = 0
  const fourcc = (s: string): void => void (o = b.write(s, o, 'ascii') + o)
  const u32 = (v: number): void => void (o = b.writeUInt32LE(v >>> 0, o))
  const u16 = (v: number): void => void (o = b.writeUInt16LE(v, o))
  const moviSize = 4 + dataBytes + chunks * 8
  const strlSize = 4 + (8 + 56) + (8 + 18)
  const hdrlSize = 4 + (8 + 56) + (8 + strlSize)
  fourcc('RIFF'); u32(4 + (8 + hdrlSize) + (8 + moviSize) + (8 + chunks * 16)); fourcc('AVI ')
  fourcc('LIST'); u32(hdrlSize); fourcc('hdrl')
  fourcc('avih'); u32(56)
  u32(1_000_000); u32(AVI_BYTE_RATE); u32(0); u32(0x10); u32(chunks); u32(0); u32(1); u32(chunkMax); u32(0); u32(0); u32(0); u32(0); u32(0); u32(0)
  fourcc('LIST'); u32(strlSize); fourcc('strl')
  fourcc('strh'); u32(56)
  fourcc('auds'); u32(0); u32(0); u16(0); u16(0); u32(0); u32(AVI_BLOCK); u32(AVI_BYTE_RATE); u32(0); u32(dataBytes / AVI_BLOCK); u32(chunkMax); u32(0xffffffff); u32(AVI_BLOCK)
  u16(0); u16(0); u16(0); u16(0)
  fourcc('strf'); u32(18)
  u16(1); u16(MIX_CHANNELS); u32(MIX_SAMPLE_RATE); u32(AVI_BYTE_RATE); u16(AVI_BLOCK); u16(16); u16(0)
  fourcc('LIST'); u32(moviSize); fourcc('movi')
  return b
}

/**
 * Stream-mix `gamePath` (f32le; defines the length) with `musicPath` (f32le, null: game only) into `outPath`, an
 * audio-only PCM AVI (see `aviHeader`). `onProgress` gets the fraction done. Throws `MixCancelled` when `signal` aborts.
 */
export async function mixPcmFiles(
  gamePath: string,
  musicPath: string | null,
  outPath: string,
  opts: Omit<MixOptions, 'totalFrames'>,
  control: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<{ frames: number }> {
  const totalFrames = Math.floor((await fs.promises.stat(gamePath)).size / BYTES_PER_FRAME)
  const mixer = createMixer({ ...opts, totalFrames })
  const game = await fs.promises.open(gamePath, 'r')
  const music = musicPath ? await fs.promises.open(musicPath, 'r') : null
  const out = await fs.promises.open(outPath, 'w')
  let done = 0
  const index: Buffer[] = []
  let moviOffset = 4
  let chunkMax = 0
  try {
    await out.write(aviHeader(0, 0, 0), 0, AVI_DATA_OFFSET, 0)
    let pos = AVI_DATA_OFFSET
    while (done < totalFrames) {
      if (control.signal?.aborted) throw new MixCancelled()
      const g = await readChunk(game, Math.min(MIX_SAMPLE_RATE, totalFrames - done))
      if (g.length === 0) break
      const m = await readChunk(music, g.length / MIX_CHANNELS)
      const pcm = toS16(mixer.process(g, m))
      const head = Buffer.alloc(8)
      head.write('00wb', 0, 'ascii')
      head.writeUInt32LE(pcm.length, 4)
      await out.write(Buffer.concat([head, pcm]), 0, 8 + pcm.length, pos)
      pos += 8 + pcm.length
      const idx = Buffer.alloc(16)
      idx.write('00wb', 0, 'ascii')
      idx.writeUInt32LE(0x10, 4)
      idx.writeUInt32LE(moviOffset, 8)
      idx.writeUInt32LE(pcm.length, 12)
      index.push(idx)
      moviOffset += 8 + pcm.length
      chunkMax = Math.max(chunkMax, pcm.length)
      done += g.length / MIX_CHANNELS
      control.onProgress?.(done / totalFrames)
    }
    const idx1 = Buffer.concat([Buffer.from('idx1', 'ascii'), Buffer.alloc(4), ...index])
    idx1.writeUInt32LE(index.length * 16, 4)
    await out.write(idx1, 0, idx1.length, pos)
    await out.write(aviHeader(done * AVI_BLOCK, index.length, chunkMax), 0, AVI_DATA_OFFSET, 0)
  } finally {
    await game.close()
    await music?.close()
    await out.close()
  }
  return { frames: done }
}

/** Hop size of the onset detector (frames, about 10.7 ms at 48 kHz). */
const HOP = 512

export interface BeatDetector {
  push(interleaved: Float32Array): void
  /** Beat (onset) times in seconds, ascending. */
  finish(): number[]
}

/**
 * Simple energy-onset detector: mono energy per hop, positive energy flux, adaptive threshold (1.5 × the mean flux over
 * about ±0.5 s plus a floor), local maximum, at least 0.15 s between beats. Good for percussive music; not a tempo tracker.
 */
export function createBeatDetector(sampleRate = MIX_SAMPLE_RATE): BeatDetector {
  const energies: number[] = []
  let acc = 0
  let n = 0
  return {
    push(x) {
      for (let i = 0; i + 1 < x.length; i += 2) {
        const m = (x[i] + x[i + 1]) / 2
        acc += m * m
        if (++n === HOP) {
          energies.push(acc / HOP)
          acc = 0
          n = 0
        }
      }
    },
    finish() {
      // No onset at the very first hop (nothing to compare with).
      const flux = energies.map((e, i) => (i > 0 ? Math.max(0, e - energies[i - 1]) : 0))
      const win = Math.max(1, Math.round((0.5 * sampleRate) / HOP))
      const beats: number[] = []
      let sumF = 0
      let sumE = 0
      let lo = 0
      let hi = -1
      for (let i = 0; i < flux.length; i++) {
        while (hi < Math.min(flux.length - 1, i + win)) {
          hi++
          sumF += flux[hi]
          sumE += energies[hi]
        }
        while (lo < i - win) {
          sumF -= flux[lo]
          sumE -= energies[lo]
          lo++
        }
        const n = hi - lo + 1
        const f = flux[i]
        // An onset is a jump that is large against both the local flux and the local energy (a steady tone has neither).
        if (f <= 1e-7 || f <= (sumF / n) * 1.5 || f <= (sumE / n) * 0.5) continue
        if ((i > 0 && flux[i - 1] > f) || (i + 1 < flux.length && flux[i + 1] >= f)) continue
        const t = (i * HOP) / sampleRate
        if (beats.length > 0 && t - beats[beats.length - 1] < 0.15) continue
        beats.push(t)
      }
      return beats
    }
  }
}

/** Beat times of an f32le stereo PCM file, read in chunks. */
export async function detectBeatsInFile(file: string, signal?: AbortSignal, sampleRate = MIX_SAMPLE_RATE): Promise<number[]> {
  const det = createBeatDetector(sampleRate)
  const fh = await fs.promises.open(file, 'r')
  try {
    for (;;) {
      if (signal?.aborted) throw new MixCancelled()
      const chunk = await readChunk(fh, CHUNK_FRAMES)
      if (chunk.length === 0) break
      det.push(chunk)
    }
  } finally {
    await fh.close()
  }
  return det.finish()
}
