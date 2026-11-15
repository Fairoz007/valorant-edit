/**
 * Montage routing and request validation through export-ipc, with the fake ffmpeg (a real child process).
 * Job outputs are observed through the fake's per-output pid files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { createExportService, isMontageRequest, MUSIC_NOT_FOUND, MUSIC_PATH_INVALID, validateExportRequest } from './export-ipc'
import { solidPng } from './montage-text'

const FAKE = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')
const ENV_KEYS = ['FAKE_FFMPEG_SLEEP_MS', 'FAKE_FFMPEG_SLEEP_MAP', 'FAKE_FFMPEG_EXIT', 'FAKE_FFMPEG_EXIT_MAP', 'FAKE_FFMPEG_PID_DIR']
const saved: Record<string, string | undefined> = {}

let root: string
let outDir: string
let pidDir: string
let tmpDir: string
let source: string
let music: string

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-montage-ipc-'))
  outDir = path.join(root, 'out dir ü')
  pidDir = path.join(root, 'pids')
  tmpDir = path.join(root, 'tmp')
  for (const d of [outDir, pidDir, tmpDir]) fs.mkdirSync(d)
  source = path.join(root, "src it's 試合.mp4")
  music = path.join(root, 'track 1.m4a')
  fs.writeFileSync(source, 'x')
  fs.writeFileSync(music, 'x')
  process.env.FAKE_FFMPEG_PID_DIR = pidDir
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

const sender = () => Object.assign(new EventEmitter(), { sent: [] as unknown[], isDestroyed: () => false, send(_c: string, d: unknown) { this.sent.push(d) } })
const service = (over: Record<string, unknown> = {}) =>
  createExportService({
    ffmpeg: { bin: process.execPath, prefixArgs: [FAKE] },
    tempDir: tmpDir,
    probe: async () => ({ codec: 'h264', width: 1920, height: 1080, fps: 60 }),
    hasAudio: async () => true,
    probeDuration: async () => 60,
    renderTextPng: async (_t: string, o: { heightPx: number }) => solidPng(o.heightPx * 4, o.heightPx, [0, 255, 0, 255]),
    ...over
  })

const styledItems = () => [
  { id: 'a', source, start: 1, end: 5 },
  {
    id: 'b', source, start: 10, end: 15, transitionIn: 'dipWhite', transitionSec: 0.25,
    effects: [{ kind: 'flash', at: 12, durationSec: 0.1 }, { kind: 'zoomPunch', at: 13, durationSec: 0.3, scale: 1.2 }],
    overlay: { text: 'DOUBLE KILL', at: 13, durationSec: 1.5 }
  }
]
const req = (over: Record<string, unknown> = {}) => ({
  items: styledItems(),
  mode: 'concat',
  quality: 'precise',
  encoder: 'h264_nvenc',
  outDir,
  baseName: 'montage',
  style: 'hype',
  outro: { text: 'GG', durationSec: 1.5, background: 'black' },
  music: { path: music, gain: 0.5, duck: true, fadeInSec: 1, fadeOutSec: 1.5 },
  ...over
})
const jobsRun = (): string[] => fs.readdirSync(pidDir).map((f) => f.replace(/\.pids\.json$/, '')).sort()
const tmpLeft = (): string[] => fs.readdirSync(tmpDir)

describe('request validation', () => {
  it('accepts and copies the v2 item and project fields', async () => {
    const v = await validateExportRequest(req({ intro: { text: 'Auto edit', durationSec: 2, background: 'blurFrame' }, letterbox: true }))
    expect(v.items[1]).toEqual(styledItems()[1])
    expect(v.items[0]).toEqual({ id: 'a', source, start: 1, end: 5 })
    expect(v.style).toEqual({
      style: 'hype', letterbox: true, intro: { text: 'Auto edit', durationSec: 2, background: 'blurFrame' },
      outro: { text: 'GG', durationSec: 1.5, background: 'black' }, music: { path: music, gain: 0.5, duck: true, fadeInSec: 1, fadeOutSec: 1.5 }
    })
    expect(isMontageRequest(v)).toBe(true)
  })

  it('drops unknown fields and keeps unstyled requests unstyled', async () => {
    const v = await validateExportRequest({ items: [{ id: 'a', source, start: 0, end: 1, evil: 1 }], mode: 'concat', quality: 'copy', outDir, baseName: 'x', style: 'clean' })
    expect(v.items[0]).toEqual({ id: 'a', source, start: 0, end: 1 })
    expect(isMontageRequest(v)).toBe(false)
    const plain = await validateExportRequest({ items: [{ id: 'a', source, start: 0, end: 1 }], mode: 'concat', quality: 'copy', outDir, baseName: 'x' })
    expect(plain.style).toBeUndefined()
    expect(isMontageRequest({ ...v, mode: 'separate', items: styledItems() as never })).toBe(false)
  })

  it('rejects invalid v2 fields and unsafe or missing music', async () => {
    for (const bad of [
      { items: [{ id: 'a', source, start: 0, end: 1, speed: 3 }] },
      { items: [{ id: 'a', source, start: 0, end: 1, effects: [{ kind: 'slowmo', at: 0.5, durationSec: 0.5, speed: 2 }] }] },
      { items: [{ id: 'a', source, start: 0, end: 1, transitionIn: 'xfade' }] },
      { style: 'retro' },
      { intro: { text: 'x', durationSec: 60, background: 'black' } }
    ]) {
      await expect(validateExportRequest(req(bad))).rejects.toThrow()
    }
    await expect(validateExportRequest(req({ music: { path: '\\\\server\\share\\a.mp3', gain: 0.5, duck: true, fadeInSec: 1, fadeOutSec: 1 } }))).rejects.toThrow(MUSIC_PATH_INVALID)
    await expect(validateExportRequest(req({ music: { path: source.replace('.mp4', '.exe'), gain: 0.5, duck: true, fadeInSec: 1, fadeOutSec: 1 } }))).rejects.toThrow(MUSIC_PATH_INVALID)
    // The pinned FFmpeg has no MP3 demuxer.
    await expect(validateExportRequest(req({ music: { path: source.replace('.mp4', '.mp3'), gain: 0.5, duck: true, fadeInSec: 1, fadeOutSec: 1 } }))).rejects.toThrow(MUSIC_PATH_INVALID)
    await expect(validateExportRequest(req({ music: { path: path.join(root, 'missing.m4a'), gain: 0.5, duck: true, fadeInSec: 1, fadeOutSec: 1 } }))).rejects.toThrow(MUSIC_NOT_FOUND)
  })
})

describe('montage routing', () => {
  it('renders a styled project through segments, concat, music mix and mux; cleans up temp files', async () => {
    const s = sender()
    const r = await service().start(s, req())
    expect(r).toMatchObject({ ok: true })
    expect(r.outputs).toHaveLength(1)
    expect(path.basename(r.outputs[0])).toBe('montage.mp4')
    expect(fs.readFileSync(r.outputs[0], 'utf-8')).toBe('complete-data')
    const jobs = jobsRun()
    expect(jobs).toEqual(expect.arrayContaining(['music.f32', 'seg-0001.mov', 'game.f32', 'montage.mov']))
    expect(jobs.filter((j) => j.startsWith('seg-')).length).toBeGreaterThanOrEqual(4) // a, b split at the zoom window, outro
    expect(jobs.some((j) => j.endsWith('.partial.mp4'))).toBe(true)
    expect(tmpLeft()).toEqual([])
    expect(fs.readdirSync(path.dirname(r.outputs[0]))).toEqual(['montage.mp4'])
    expect(s.sent.length).toBeGreaterThan(0)
    expect((s.sent.at(-1) as { percent: number }).percent).toBe(100)
  })

  it('does not overwrite an existing output', async () => {
    const first = await service().start(sender(), req({ music: undefined }))
    const second = await service().start(sender(), req({ music: undefined }))
    expect(second.ok).toBe(true)
    expect(path.basename(second.outputs[0])).toBe('montage (2).mp4')
    expect(second.notices?.length).toBe(1)
    expect(first.outputs[0]).not.toBe(second.outputs[0])
  })

  it('unstyled concat requests still use the existing jobs', async () => {
    const r = await service().start(sender(), { items: [{ id: 'a', source, start: 0, end: 2 }], mode: 'concat', quality: 'copy', outDir, baseName: 'plain' })
    expect(r.ok).toBe(true)
    expect(jobsRun().some((j) => j.startsWith('.aditor-seg-'))).toBe(true)
    expect(jobsRun().some((j) => j.startsWith('seg-'))).toBe(false)
  })

  it('needs an encoder', async () => {
    const r = await service().start(sender(), req({ encoder: undefined, quality: 'copy' }))
    expect(r).toMatchObject({ ok: false, code: 'noEncoder' })
  })

  it('reports a failing segment with an error code and leaves nothing behind', async () => {
    process.env.FAKE_FFMPEG_EXIT_MAP = JSON.stringify({ 'seg-0002': 1 })
    const r = await service().start(sender(), req())
    expect(r).toMatchObject({ ok: false, code: 'montageFfmpeg', outputs: [] })
    expect((r as { error: string }).error).toContain('exit code 1')
    expect(tmpLeft()).toEqual([])
    expect(fs.readdirSync(path.join(outDir, fs.readdirSync(outDir)[0]))).toEqual([])
  })

  it('reports caption rendering failures', async () => {
    const r = await service({ renderTextPng: async () => { throw new Error('no GPU') } }).start(sender(), req())
    expect(r).toMatchObject({ ok: false, code: 'montageText' })
    expect(tmpLeft()).toEqual([])
  })

  it('cancels: kills ffmpeg, removes the partial and the temp folder', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MAP = JSON.stringify({ 'seg-0002': 30000 })
    const svc = service()
    const p = svc.start(sender(), req())
    const t0 = Date.now()
    while (!jobsRun().includes('seg-0002.mov')) {
      if (Date.now() - t0 > 10000) throw new Error('segment 2 never started')
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(svc.cancel()).toEqual({ cancelled: true })
    const r = await p
    expect(r).toMatchObject({ ok: false, cancelled: true, outputs: [] })
    expect(tmpLeft()).toEqual([])
    expect(fs.readdirSync(path.join(outDir, fs.readdirSync(outDir)[0]))).toEqual([])
  })
})
