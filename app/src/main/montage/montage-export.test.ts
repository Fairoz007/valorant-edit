import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cleanupMontageOutput, createMontageRenderer, montageDiskEstimate, parseOutputProbe, verifyFailure, type MontageRenderRequest } from './montage-export'
import type { RunExportOptions, RunExportResult } from '../export/run'
import { applyPreset } from '../../shared/exportPresets'
import { DEFAULT_EXPORT_FORMAT } from '../../shared/exportFormat'
import { UNKNOWN_PROBE } from '../../shared/exportCompat'
import { setActiveLocale } from '../../shared/locale'

let dir: string
beforeEach(() => {
  setActiveLocale('en')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-export-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const SRC = 'D:/Videos/Valorant_2026-11-15_21-08.mp4'
function request(): MontageRenderRequest {
  return {
    items: [
      { id: 'i0', source: SRC, start: 10, end: 20 },
      { id: 'i1', source: SRC, start: 100, end: 112 }
    ],
    outDir: dir,
    baseName: 'Montage_Valorant_2026-11-15_21-08',
    format: applyPreset({ ...DEFAULT_EXPORT_FORMAT }, 'shorts'),
    probes: new Map([[SRC, { ...UNKNOWN_PROBE, fps: 60 }]]),
    totalSec: 22
  }
}

describe('createMontageRenderer', () => {
  it('precise concat in the preset format with the best encoder, low priority, planned output reported first', async () => {
    const seen: RunExportOptions[] = []
    const run = vi.fn(async (opts: RunExportOptions): Promise<RunExportResult> => {
      seen.push(opts)
      return { ok: true, outputs: [opts.jobs.at(-1)!.output] }
    })
    const planned: string[] = []
    const render = createMontageRenderer({ detectEncoders: async () => ['libopenh264', 'h264_amf', 'hevc_nvenc'], hasAudio: async () => true, mediaEnd: async () => null, run })
    const priority = (): 'idle' => 'idle'
    const res = await render(request(), { signal: new AbortController().signal, priority, onPlanned: (p) => planned.push(p) })
    expect(res).toEqual({ ok: true, outputPath: path.join(dir, 'Montage_Valorant_2026-11-15_21-08.mp4'), encoder: 'h264_amf' })
    expect(planned).toEqual([path.join(dir, 'Montage_Valorant_2026-11-15_21-08.mp4')])
    const opts = seen[0]
    expect(opts.priority).toBe(priority)
    expect(opts.jobs).toHaveLength(3)
    expect(opts.jobs.slice(0, 2).every((j) => j.intermediate)).toBe(true)
    expect(opts.jobs[0].args).toContain('h264_amf')
    // 9:16 crop filter from the Shorts preset.
    expect(opts.jobs[0].args.join(' ')).toMatch(/crop|scale/)
    expect(typeof opts.concatListContent).toBe('function')
  })

  it('never overwrites an existing montage file', async () => {
    fs.writeFileSync(path.join(dir, 'Montage_Valorant_2026-11-15_21-08.mp4'), 'old')
    const run = vi.fn(async (opts: RunExportOptions): Promise<RunExportResult> => ({ ok: true, outputs: [opts.jobs.at(-1)!.output] }))
    const render = createMontageRenderer({ detectEncoders: async () => ['libopenh264'], hasAudio: async () => true, run })
    const res = await render(request(), { signal: new AbortController().signal })
    expect(res).toMatchObject({ ok: true, outputPath: path.join(dir, 'Montage_Valorant_2026-11-15_21-08 (2).mp4') })
  })

  it('falls back to the next encoder when a hardware encoder refuses to open', async () => {
    const encoders: string[] = []
    const run = vi.fn(async (opts: RunExportOptions): Promise<RunExportResult> => {
      const enc = opts.jobs[0].args[opts.jobs[0].args.indexOf('-c:v') + 1]
      encoders.push(enc)
      return enc === 'h264_nvenc'
        ? { ok: false, error: 'exit code 1: Error while opening encoder', outputs: [] }
        : { ok: true, outputs: [opts.jobs.at(-1)!.output] }
    })
    const render = createMontageRenderer({ detectEncoders: async () => ['h264_nvenc', 'libopenh264'], hasAudio: async () => true, run })
    const res = await render(request(), { signal: new AbortController().signal })
    expect(encoders).toEqual(['h264_nvenc', 'libopenh264'])
    expect(res).toMatchObject({ ok: true, encoder: 'libopenh264' })
  })

  it('a non-encoder failure is reported as export without retrying', async () => {
    const run = vi.fn(async (): Promise<RunExportResult> => ({ ok: false, error: 'exit code 1: disk', outputs: [] }))
    const render = createMontageRenderer({ detectEncoders: async () => ['h264_nvenc', 'libopenh264'], hasAudio: async () => true, run })
    expect(await render(request(), { signal: new AbortController().signal })).toEqual({ ok: false, code: 'export', error: 'exit code 1: disk' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('no working H.264 encoder → encoder failure, and detection is retried next time', async () => {
    const detect = vi.fn(async () => ['hevc_nvenc'])
    const run = vi.fn()
    const render = createMontageRenderer({ detectEncoders: detect, run })
    const res = await render(request(), { signal: new AbortController().signal })
    expect(res).toMatchObject({ ok: false, code: 'encoder' })
    expect(run).not.toHaveBeenCalled()
    detect.mockResolvedValue([])
    await render(request(), { signal: new AbortController().signal })
    await render(request(), { signal: new AbortController().signal })
    expect(detect).toHaveBeenCalledTimes(3)
  })

  it('adds silence for a source without audio and reports cancellation', async () => {
    const run = vi.fn(async (opts: RunExportOptions): Promise<RunExportResult> => {
      expect(opts.jobs[0].args).toContain('anullsrc=r=48000:cl=stereo')
      return { ok: false, cancelled: true, outputs: [] }
    })
    const render = createMontageRenderer({ detectEncoders: async () => ['libopenh264'], hasAudio: async () => false, run })
    expect(await render(request(), { signal: new AbortController().signal })).toEqual({ ok: false, cancelled: true })
    const ac = new AbortController()
    ac.abort()
    expect(await render(request(), { signal: ac.signal })).toEqual({ ok: false, cancelled: true })
  })
})

describe('verify', () => {
  it('parses ffprobe output', () => {
    expect(parseOutputProbe(JSON.stringify({ format: { duration: '22.04' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] })))
      .toEqual({ duration: 22.04, hasVideo: true, hasAudio: true })
    expect(parseOutputProbe('nope')).toBeNull()
    expect(parseOutputProbe(JSON.stringify({ streams: [] }))).toBeNull()
  })

  it('accepts ±0.5 s with video and audio', () => {
    expect(verifyFailure({ duration: 22.4, hasVideo: true, hasAudio: true }, 22)).toBeNull()
    expect(verifyFailure({ duration: 21.6, hasVideo: true, hasAudio: true }, 22)).toBeNull()
    expect(verifyFailure({ duration: 22.6, hasVideo: true, hasAudio: true }, 22)).toMatch(/22\.6 s, expected 22\.0 s/)
    expect(verifyFailure({ duration: 22, hasVideo: true, hasAudio: false }, 22)).toMatch(/video or audio/)
    expect(verifyFailure({ duration: 22, hasVideo: false, hasAudio: true }, 22)).toMatch(/video or audio/)
    expect(verifyFailure(null, 22)).toMatch(/Could not read/)
  })
})

describe('cleanupMontageOutput', () => {
  it('removes partials and segments, and the output only when asked', () => {
    const out = path.join(dir, 'Montage_x.mp4')
    const files = [
      'Montage_x.mp4',
      'Montage_x.partial.mp4',
      'Montage_x.0f8fad5b-d9cb-469f-a165-70867728950e.partial.mp4',
      '.aditor-seg-ab12cd-1.mov',
      '.aditor-seg-ab12cd-2.partial.mov',
      'Montage_y.partial.mp4',
      'keep.mp4'
    ]
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x')
    cleanupMontageOutput(out)
    expect(fs.readdirSync(dir).sort()).toEqual(['Montage_x.mp4', 'Montage_y.partial.mp4', 'keep.mp4'])
    cleanupMontageOutput(out, { removeOutput: true })
    expect(fs.readdirSync(dir).sort()).toEqual(['Montage_y.partial.mp4', 'keep.mp4'])
    // A missing folder is fine.
    cleanupMontageOutput(path.join(dir, 'gone', 'a.mp4'), { removeOutput: true })
  })

  it('disk estimate counts the intermediate segments', () => {
    const r = request()
    expect(montageDiskEstimate(r.items, r.probes, r.format)).toBeGreaterThan(22 * ((25 * 1024 * 1024) / 8) * 2 - 1)
  })
})
