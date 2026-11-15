import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { createExportService, validateExportRequest } from './export-ipc'
import { encoderFailureHint, exportFailureMessage, runExport } from './run'
import { sanitizeExportFormat } from '../ipc-guards'
import { DEFAULT_EXPORT_FORMAT, MAX_OUTPUT_SIDE, type ExportFormat } from '../../shared/exportFormat'
import { applyPreset } from '../../shared/exportPresets'

const FAKE = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')
const SHORTS: ExportFormat = applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts')

describe('sanitizeExportFormat', () => {
  it('accepts every preset and the default, returning a clean copy', () => {
    expect(sanitizeExportFormat(DEFAULT_EXPORT_FORMAT)).toEqual(DEFAULT_EXPORT_FORMAT)
    for (const id of ['youtube', 'shorts', 'tiktok', 'reels', 'square'] as const) {
      const fmt = applyPreset(DEFAULT_EXPORT_FORMAT, id)
      expect(sanitizeExportFormat({ ...fmt, extra: 'ignored' })).toEqual(fmt)
    }
  })

  it.each([
    ['unknown preset', { ...SHORTS, preset: 'snapchat' }, /不支援的匯出預設：snapchat/],
    ['unknown frame', { ...SHORTS, frame: '4:3' }, /畫面比例：4:3/],
    ['unknown reframe', { ...SHORTS, reframe: 'stretch' }, /重新構圖方式：stretch/],
    ['offset above 1', { ...SHORTS, offset: 1.5 }, /裁切位置/],
    ['offset below -1', { ...SHORTS, offset: -2 }, /裁切位置/],
    ['offset NaN', { ...SHORTS, offset: Number.NaN }, /裁切位置/],
    ['offset as a string', { ...SHORTS, offset: '0' }, /裁切位置/],
    ['odd width', { ...SHORTS, width: 1081, height: 1920 }, /輸出尺寸/],
    ['odd height', { ...SHORTS, width: 1080, height: 1919 }, /輸出尺寸/],
    ['oversized', { ...SHORTS, width: 4320, height: 7680 }, new RegExp(`輸出尺寸.*${MAX_OUTPUT_SIDE}`)],
    ['undersized', { ...SHORTS, width: 72, height: 128 }, /輸出尺寸/],
    ['wrong aspect', { ...SHORTS, width: 1080, height: 1080 }, /輸出尺寸/],
    ['only one side', { ...SHORTS, width: 1080, height: null }, /輸出尺寸/],
    ['size on source frame', { ...DEFAULT_EXPORT_FORMAT, width: 1920, height: 1080 }, /輸出尺寸/],
    ['bad codec', { ...SHORTS, codec: 'av1' }, /編碼格式：av1/],
    ['fps cap 0', { ...SHORTS, fpsCap: 0 }, /影格率上限/],
    ['fps cap fractional', { ...SHORTS, fpsCap: 29.97 }, /影格率上限/],
    ['not an object', 'shorts', /匯出格式設定不正確/],
    ['array', [], /匯出格式設定不正確/],
    ['null', null, /匯出格式設定不正確/]
  ])('rejects %s with a specific message', (_name, raw, message) => {
    expect(() => sanitizeExportFormat(raw)).toThrow(message)
  })

  it('truncates long rejected values in the message', () => {
    expect(() => sanitizeExportFormat({ ...SHORTS, preset: 'x'.repeat(500) })).toThrow(/x{40}…$/)
  })
})

describe('validateExportRequest format field', () => {
  let root: string
  let outDir: string
  let source: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-fmt-'))
    outDir = path.join(root, 'out')
    fs.mkdirSync(outDir)
    source = path.join(root, 'src.mp4')
    fs.writeFileSync(source, 'x')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  const req = (over: Record<string, unknown> = {}) => ({ items: [{ id: '1', source, start: 0, end: 5 }], mode: 'separate', quality: 'precise', encoder: 'h264_nvenc', outDir, baseName: 'clip', ...over })

  it('a request without format gets the default format (today\'s behaviour)', async () => {
    const v = await validateExportRequest(req())
    expect(v.format).toEqual(DEFAULT_EXPORT_FORMAT)
    expect(v.format).not.toBe(DEFAULT_EXPORT_FORMAT)
  })

  it('a valid format is passed through', async () => {
    expect((await validateExportRequest(req({ format: SHORTS }))).format).toEqual(SHORTS)
    const h265 = { ...SHORTS, codec: 'h265' }
    expect((await validateExportRequest(req({ format: h265, encoder: 'hevc_amf' }))).format).toEqual(h265)
  })

  it.each([
    ['unknown preset', { format: { ...SHORTS, preset: 'vine' } }, /不支援的匯出預設/],
    ['out-of-range offset', { format: { ...SHORTS, offset: 3 } }, /裁切位置/],
    ['odd size', { format: { ...SHORTS, width: 1079 } }, /輸出尺寸/],
    ['oversized size', { format: { ...SHORTS, width: 4096, height: 7282 } }, /輸出尺寸/],
    ['format null', { format: null }, /匯出格式設定不正確/],
    ['H.264 encoder for H.265', { format: { ...SHORTS, codec: 'h265' }, encoder: 'h264_nvenc' }, /h264_nvenc.*H\.265/],
    ['HEVC encoder for H.264', { format: SHORTS, encoder: 'hevc_nvenc' }, /hevc_nvenc.*H\.264/],
    ['HEVC encoder without a format', { encoder: 'hevc_qsv' }, /hevc_qsv.*H\.264/],
    ['H.265 without an encoder', { format: { ...SHORTS, codec: 'h265' }, encoder: undefined }, /HEVC/]
  ])('rejects %s', async (_name, over, message) => {
    await expect(validateExportRequest(req(over))).rejects.toThrow(message)
    // Nothing is created for a rejected request.
    expect(fs.readdirSync(outDir)).toEqual([])
  })
})

describe('export:start with a format', () => {
  let root: string
  let outDir: string
  let source: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-fmts-'))
    outDir = path.join(root, 'out')
    fs.mkdirSync(outDir)
    source = path.join(root, 'src.mp4')
    fs.writeFileSync(source, 'x')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => undefined })

  it('copy + Shorts runs as precise: no copy-cut lookup, the format notice is returned', async () => {
    const copyCut = vi.fn(async () => null)
    const service = createExportService({
      ffmpeg: { bin: process.execPath, prefixArgs: [FAKE] },
      tempDir: path.join(root, 'tmp'),
      probe: async () => ({ codec: 'h264', width: 1920, height: 1080, fps: 60 }),
      copyCut
    })
    const r = await service.start(sender(), { items: [{ id: '1', source, start: 0, end: 5 }], mode: 'separate', quality: 'copy', encoder: 'h264_nvenc', outDir, baseName: 'short', format: SHORTS })
    expect(r).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Clips', 'short_1.mp4')] })
    expect((r as { notices: string[] }).notices.some((n) => n.includes('重新編碼'))).toBe(true)
    expect(copyCut).not.toHaveBeenCalled()
  })

  it('the disk check uses the output-spec estimate for the format (precise rate, not the 30 Mbps copy guess)', async () => {
    const stats = await fs.promises.statfs(outDir)
    // 60 s of 1080×1920@60 at a 37.35 Mbps peak + audio ≈ 282 MB; 100 MB free must block it even though quality says copy.
    const statfs = vi.spyOn(fs.promises, 'statfs').mockImplementation(async () => ({ ...stats, bavail: 100 * 1024 * 1024, bsize: 1 }))
    try {
      const service = createExportService({ ffmpeg: { bin: process.execPath, prefixArgs: [FAKE] }, probe: async () => ({ codec: 'h264', width: 1920, height: 1080, fps: 60 }) })
      const r = await service.start(sender(), { items: [{ id: '1', source, start: 0, end: 60 }], mode: 'separate', quality: 'copy', encoder: 'h264_nvenc', outDir, baseName: 'big', format: SHORTS })
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('磁碟剩餘空間不足') })
      expect(r.ok === false && 'error' in r && r.error).toContain('需要約: 295.4 MB')
    } finally {
      statfs.mockRestore()
    }
  })

  it('an invalid format fails the start with the specific message and no output', async () => {
    const service = createExportService({ ffmpeg: { bin: process.execPath, prefixArgs: [FAKE] } })
    const r = await service.start(sender(), { items: [{ id: '1', source, start: 0, end: 5 }], mode: 'separate', quality: 'precise', encoder: 'h264_nvenc', outDir, baseName: 'x', format: { ...SHORTS, preset: 'nope' } })
    expect(r).toMatchObject({ ok: false, outputs: [], error: expect.stringContaining('不支援的匯出預設：nope') })
  })
})

describe('encoder rejection errors', () => {
  const samples = [
    '[h264_nvenc @ 000001] Frame Dimension less than the minimum supported value.\n[h264_nvenc @ 000001] InitializeEncoder failed: invalid param (8)',
    '[hevc_nvenc @ 0x55] OpenEncodeSessionEx failed: unsupported device (2): (no details)\n[hevc_nvenc @ 0x55] No capable devices found',
    '[hevc_amf @ 0000] encoder->Init() failed with error 14\nError while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height',
    '[hevc_qsv @ 0000] Error initializing an MFX session: -9.\nError initializing output stream 0:0 --',
    '[h264_nvenc @ 01] Driver does not support the required nvenc API version. Required: 12.1 Found: 11.0'
  ]

  it.each(samples)('recognises typical hardware-encoder failures: %s', (stderr) => {
    expect(encoderFailureHint(stderr)).toMatch(/編碼器無法以這個輸出尺寸或編碼格式啟動/)
  })

  it('other failures get no encoder hint (the OpenH264 library mismatch has its own handling)', () => {
    expect(encoderFailureHint('[libopenh264 @ 0000020a] Incorrect library version loaded\nError initializing output stream 0:0 --\nConversion failed!')).toBeNull()
    expect(encoderFailureHint('C:/in.mp4: No such file or directory')).toBeNull()
  })

  it('keeps the exit-code prefix and the stderr tail, adding the hint after the exit code', () => {
    const msg = exportFailureMessage(1, samples[0])
    expect(msg.startsWith('匯出失敗 (exit code 1): ')).toBe(true)
    expect(msg).toContain('編碼器無法')
    expect(msg.endsWith(samples[0])).toBe(true)
    expect(exportFailureMessage(3, 'plain failure')).toBe('匯出失敗 (exit code 3):\nplain failure')
    // Telemetry (stableDiagnostic) groups by "(exit code N" and drops everything after it.
    expect(msg).toMatch(/\(exit code 1\)/)
    // Only the last 4 KB of stderr is kept.
    const long = exportFailureMessage(1, 'y'.repeat(10_000) + samples[0])
    expect(long.length).toBeLessThan(4096 + 300)
  })

  it('runExport returns the hint and stderr when ffmpeg fails to open the encoder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-encfail-'))
    try {
      const script = `process.stderr.write(${JSON.stringify(samples[0])}); process.exit(1)`
      const output = path.join(root, 'clip_1.mp4')
      const res = await runExport({
        jobs: [{ args: ['-i', 'in.mp4', '-y', output], output }],
        totalEstimatedSeconds: 1,
        outDir: root,
        estimatedBytes: 0,
        ffmpeg: { bin: process.execPath, prefixArgs: ['-e', script, '--'] },
        tempDir: path.join(root, 'tmp')
      })
      expect(res.ok).toBe(false)
      const error = (res as { error: string }).error
      expect(error).toContain('exit code 1')
      expect(error).toContain('編碼器無法')
      expect(error).toContain('InitializeEncoder failed')
      expect(fs.readdirSync(root)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
