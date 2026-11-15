import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { codecsDir } from '../../shared/paths'
import { killTree } from './killTree'
import { FALLBACK_SPEC, videoEncodeArgs } from './encodeQuality'
import { HEVC_ENCODERS, type VideoCodec } from '../../shared/exportFormat'

export function parseEncoderList(stdout: string): string[] {
  const result: string[] = []
  const lines = stdout.split('\n')
  for (const line of lines) {
    // Look for video encoder lines: V..... <name> ...
    const match = line.match(/^\s*V\S*\s+([a-zA-Z0-9_-]+)/)
    if (match) {
      result.push(match[1])
    }
  }
  return result
}

/** Encoder priority per output codec (hardware first; no libx265: the bundled FFmpeg is LGPL-only). */
export const ENCODER_PRIORITY: Readonly<Record<VideoCodec, readonly string[]>> = {
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264'],
  h265: HEVC_ENCODERS
}

/** Best available encoder for the codec (H.264 by default); null when none of that codec's encoders is available. */
export function pickEncoder(available: string[], codec: VideoCodec = 'h264'): string | null {
  for (const enc of ENCODER_PRIORITY[codec]) {
    if (available.includes(enc)) {
      return enc
    }
  }
  return null
}

/**
 * NVENC/AMF/QSV have minimum frame dimensions (about 145x49 for NVENC); use a 256x256 test frame to avoid false hardware-unavailable results.
 * Test with the same rate-control arguments as precise export, so a driver that rejects them is not offered.
 */
export function encoderTestArgs(encoder: string): string[] {
  return ['-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', ...videoEncodeArgs(encoder, FALLBACK_SPEC), '-f', 'null', '-']
}

const ENCODER_TEST_TIMEOUT_MS = 10_000

/** Encode a short test frame; if the driver hangs, treat it as unavailable and terminate the process after the timeout (10 seconds by default). */
export function testEncoder(
  ffmpegBin: string,
  encoder: string,
  extraEnv?: Record<string, string>,
  opts: { timeoutMs?: number; prefixArgs?: string[]; args?: string[] } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const proc = spawn(ffmpegBin, [...(opts.prefixArgs ?? []), ...(opts.args ?? encoderTestArgs(encoder))], {
      env: { ...process.env, ...extraEnv },
      stdio: 'ignore',
      windowsHide: true
    })
    const timer = setTimeout(() => {
      void killTree(proc).then(() => finish(false))
    }, opts.timeoutMs ?? ENCODER_TEST_TIMEOUT_MS)
    proc.on('close', (code) => finish(code === 0))
    proc.on('error', () => finish(false))
  })
}

function listEncoders(ffmpegBin: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, ['-encoders'])
    let stdout = ''
    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    proc.on('close', () => {
      resolve(parseEncoderList(stdout))
    })
    proc.on('error', () => {
      resolve([])
    })
  })
}

export interface DetectEncodersDeps {
  /** Video encoders compiled into ffmpeg (`ffmpeg -encoders`). */
  list?: (ffmpegBin: string) => Promise<string[]>
  /** Encode a test frame with the encoder (defaults to testEncoder with encoderTestArgs). */
  test?: (ffmpegBin: string, encoder: string, extraEnv?: Record<string, string>) => Promise<boolean>
}

/**
 * Encoders that are compiled in AND pass a test encode, in priority order: the H.264 encoders first
 * (h264_nvenc, h264_qsv, h264_amf, libopenh264), then the HEVC encoders (hevc_nvenc, hevc_qsv, hevc_amf).
 * Callers that need one codec filter with encodersForCodec()/pickEncoder(list, codec); H.264-only callers (proxy) must not take HEVC entries.
 */
export async function detectEncoders(ffmpegBin = process.env.ADITOR_FFMPEG || 'ffmpeg', deps: DetectEncodersDeps = {}): Promise<string[]> {
  const candidates = await (deps.list ?? listEncoders)(ffmpegBin)
  const test = deps.test ?? ((bin: string, enc: string, env?: Record<string, string>) => testEncoder(bin, enc, env))

  const working: string[] = []
  const gpuEncoders = ['h264_nvenc', 'h264_qsv', 'h264_amf']

  for (const enc of gpuEncoders) {
    if (candidates.includes(enc)) {
      const ok = await test(ffmpegBin, enc)
      if (ok) {
        working.push(enc)
      }
    }
  }

  // Check libopenh264: either system or in codecsDir()
  if (candidates.includes('libopenh264')) {
    const dir = codecsDir()
    let hasDll = false
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
        hasDll = files.some((f) => f.toLowerCase().endsWith('.dll') && f.toLowerCase().includes('openh264'))
      }
    } catch {}

    const extraEnv = hasDll ? { PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` } : undefined
    const ok = await test(ffmpegBin, 'libopenh264', extraEnv)
    if (ok) {
      working.push('libopenh264')
    }
  }

  // HEVC (H.265) hardware encoders, tested with the same rate-control arguments as a real export.
  for (const enc of HEVC_ENCODERS) {
    if (candidates.includes(enc) && (await test(ffmpegBin, enc))) working.push(enc)
  }

  return working
}
