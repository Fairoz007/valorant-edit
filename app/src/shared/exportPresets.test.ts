import { describe, expect, it } from 'vitest'
import {
  applyPreset,
  getPreset,
  lengthWarning,
  maxSecondsFor,
  outputFps,
  PRESETS,
  presetState,
  resolveOutputSpec,
  sourceFormat,
  trimItemsToSeconds
} from './exportPresets'
import {
  coerceExportFormat,
  DEFAULT_EXPORT_FORMAT,
  encoderCodec,
  encodersForCodec,
  formatRequiresPrecise,
  PRESET_IDS,
  validateExportFormat,
  type ExportFormat
} from './exportFormat'

const SRC = { width: 1920, height: 1080, fps: 60 }

describe('preset table', () => {
  it('matches the platform spec', () => {
    const t = Object.fromEntries(PRESETS.map((p) => [p.id, p]))
    expect(t.youtube).toMatchObject({ frame: '16:9', width: null, height: null, fpsCap: null, maxSeconds: null })
    expect(t.shorts).toMatchObject({ frame: '9:16', width: 1080, height: 1920, fpsCap: 60, maxSeconds: 60 })
    expect(t.tiktok).toMatchObject({ frame: '9:16', width: 1080, height: 1920, fpsCap: 60, maxSeconds: 600 })
    expect(t.reels).toMatchObject({ frame: '9:16', width: 1080, height: 1920, fpsCap: 30, maxSeconds: 90 })
    expect(t.square).toMatchObject({ frame: '1:1', width: 1080, height: 1080, fpsCap: 60, maxSeconds: null })
    expect(PRESETS.map((p) => p.id)).toEqual([...PRESET_IDS])
    for (const p of PRESETS) expect(validateExportFormat(applyPreset(DEFAULT_EXPORT_FORMAT, p.id)).ok).toBe(true)
  })

  it('getPreset throws for unknown ids', () => {
    expect(() => getPreset('vimeo' as never)).toThrow()
  })
})

describe('fps cap', () => {
  it('caps but never upscales', () => {
    expect(outputFps(144, 60)).toBe(60)
    expect(outputFps(30, 60)).toBe(30)
    expect(outputFps(60, 30)).toBe(30)
    expect(outputFps(59.94, null)).toBe(59.94)
    expect(resolveOutputSpec({ ...SRC, fps: 120 }, applyPreset(DEFAULT_EXPORT_FORMAT, 'reels')).fps).toBe(30)
    expect(resolveOutputSpec({ ...SRC, fps: 24 }, applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts')).fps).toBe(24)
  })
})

describe('resolveOutputSpec', () => {
  it('source frame keeps the source size', () => {
    expect(resolveOutputSpec(SRC, DEFAULT_EXPORT_FORMAT)).toEqual(SRC)
    expect(resolveOutputSpec({ width: 1365, height: 767, fps: 30 }, DEFAULT_EXPORT_FORMAT)).toEqual({ width: 1364, height: 766, fps: 30 })
  })

  it('fixed preset sizes', () => {
    expect(resolveOutputSpec(SRC, applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts'))).toEqual({ width: 1080, height: 1920, fps: 60 })
    expect(resolveOutputSpec(SRC, applyPreset(DEFAULT_EXPORT_FORMAT, 'square'))).toEqual({ width: 1080, height: 1080, fps: 60 })
  })

  it('YouTube keeps the source size and caps at 3840×2160', () => {
    const yt = applyPreset(DEFAULT_EXPORT_FORMAT, 'youtube')
    expect(resolveOutputSpec(SRC, yt)).toEqual(SRC)
    expect(resolveOutputSpec({ width: 3840, height: 2160, fps: 60 }, yt)).toEqual({ width: 3840, height: 2160, fps: 60 })
    expect(resolveOutputSpec({ width: 7680, height: 4320, fps: 30 }, yt)).toEqual({ width: 3840, height: 2160, fps: 30 })
    // 21:9 keeps its 1080 short side.
    expect(resolveOutputSpec({ width: 2560, height: 1080, fps: 60 }, yt)).toEqual({ width: 1920, height: 1080, fps: 60 })
  })

  it('custom frames derive from the short side', () => {
    const f = (frame: ExportFormat['frame']): ExportFormat => ({ ...DEFAULT_EXPORT_FORMAT, frame })
    expect(resolveOutputSpec(SRC, f('9:16'))).toEqual({ width: 1080, height: 1920, fps: 60 })
    expect(resolveOutputSpec(SRC, f('1:1'))).toEqual({ width: 1080, height: 1080, fps: 60 })
    expect(resolveOutputSpec({ width: 1366, height: 768, fps: 60 }, f('9:16'))).toEqual({ width: 768, height: 1366, fps: 60 })
    expect(resolveOutputSpec({ width: 7680, height: 4320, fps: 60 }, f('9:16'))).toEqual({ width: 2160, height: 3840, fps: 60 })
    for (const spec of [resolveOutputSpec({ width: 1365, height: 767, fps: 60 }, f('9:16')), resolveOutputSpec({ width: 1365, height: 767, fps: 60 }, f('1:1'))]) {
      expect(spec.width % 2).toBe(0)
      expect(spec.height % 2).toBe(0)
    }
  })
})

describe('presetState / Custom', () => {
  it('shows the preset until an output field changes', () => {
    const shorts = applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts')
    expect(presetState(shorts)).toBe('shorts')
    expect(presetState({ ...shorts, offset: 0.8, codec: 'h265', reframe: 'blur' })).toBe('shorts')
    expect(presetState({ ...shorts, fpsCap: 30 })).toBe('custom')
    expect(presetState({ ...shorts, frame: '1:1', width: 1080, height: 1080 })).toBe('custom')
    expect(presetState(DEFAULT_EXPORT_FORMAT)).toBe('source')
    expect(presetState({ ...DEFAULT_EXPORT_FORMAT, frame: '9:16' })).toBe('custom')
    // Shorts and TikTok share output fields: the stored preset decides.
    expect(presetState(applyPreset(DEFAULT_EXPORT_FORMAT, 'tiktok'))).toBe('tiktok')
  })

  it('applyPreset keeps codec and offset; sourceFormat resets the frame', () => {
    const f = applyPreset({ ...DEFAULT_EXPORT_FORMAT, codec: 'h265', offset: -0.5, reframe: 'bars' }, 'reels')
    expect(f).toMatchObject({ codec: 'h265', offset: -0.5, reframe: 'crop', preset: 'reels' })
    expect(sourceFormat(f)).toMatchObject({ frame: 'source', width: null, height: null, fpsCap: null, preset: null, codec: 'h265' })
  })
})

describe('max length', () => {
  const items = [
    { start: 0, end: 40 },
    { start: 100, end: 130 }
  ]
  it('warns over the limit (concat total, separate per clip)', () => {
    const shorts = applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts')
    expect(lengthWarning(items, 'concat', shorts)).toEqual({ maxSeconds: 60, seconds: 70 })
    expect(lengthWarning(items, 'separate', shorts)).toBeNull()
    expect(lengthWarning(items, 'concat', applyPreset(DEFAULT_EXPORT_FORMAT, 'tiktok'))).toBeNull()
    expect(lengthWarning(items, 'concat', applyPreset(DEFAULT_EXPORT_FORMAT, 'square'))).toBeNull()
    expect(lengthWarning(items, 'concat', { ...shorts, fpsCap: 30 })).toBeNull() // Custom has no limit
    expect(maxSecondsFor(applyPreset(DEFAULT_EXPORT_FORMAT, 'reels'))).toBe(90)
  })

  it('trims to the first N seconds', () => {
    expect(trimItemsToSeconds(items, 60, 'concat')).toEqual([
      { start: 0, end: 40 },
      { start: 100, end: 120 }
    ])
    expect(trimItemsToSeconds(items, 30, 'concat')).toEqual([{ start: 0, end: 30 }])
    expect(trimItemsToSeconds(items, 35, 'separate')).toEqual([
      { start: 0, end: 35 },
      { start: 100, end: 130 }
    ])
    expect(trimItemsToSeconds(items, 0, 'concat')).toEqual([])
  })
})

describe('validateExportFormat / coerceExportFormat', () => {
  const ok = applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts')
  it('accepts valid formats', () => {
    expect(validateExportFormat(DEFAULT_EXPORT_FORMAT)).toEqual({ ok: true, value: DEFAULT_EXPORT_FORMAT })
    expect(validateExportFormat({ ...ok, extra: 1 })).toEqual({ ok: true, value: ok })
  })

  it('rejects bad values', () => {
    const bad: Array<[unknown, string]> = [
      [null, 'shape'],
      [[], 'shape'],
      [{ ...ok, preset: 'vimeo' }, 'preset'],
      [{ ...ok, frame: '4:3' }, 'frame'],
      [{ ...ok, reframe: 'zoom' }, 'reframe'],
      [{ ...ok, offset: 1.01 }, 'offset'],
      [{ ...ok, offset: Number.NaN }, 'offset'],
      [{ ...ok, offset: '0' }, 'offset'],
      [{ ...ok, codec: 'av1' }, 'codec'],
      [{ ...ok, width: 1081 }, 'size'],
      [{ ...ok, width: 1080, height: null }, 'size'],
      [{ ...ok, width: 4320, height: 7680 }, 'size'],
      [{ ...ok, width: 1080, height: 1080 }, 'size'], // 1:1 size for a 9:16 frame
      [{ ...DEFAULT_EXPORT_FORMAT, width: 1920, height: 1080 }, 'size'], // size with the source frame
      [{ ...ok, fpsCap: 0 }, 'fps'],
      [{ ...ok, fpsCap: 29.97 }, 'fps'],
      [{ ...ok, fpsCap: 500 }, 'fps']
    ]
    for (const [raw, error] of bad) expect(validateExportFormat(raw)).toEqual({ ok: false, error })
  })

  it('coerce keeps valid objects and falls back entirely otherwise', () => {
    expect(coerceExportFormat(undefined)).toEqual(DEFAULT_EXPORT_FORMAT)
    expect(coerceExportFormat(ok)).toEqual(ok)
    expect(coerceExportFormat({ ...ok, width: 3 }, ok)).toEqual(ok)
    expect(coerceExportFormat({ ...ok, width: 3 })).toEqual(DEFAULT_EXPORT_FORMAT)
  })
})

describe('codec helpers', () => {
  it('maps encoders to codecs and requires precise for reframing or H.265', () => {
    expect(encoderCodec('hevc_nvenc')).toBe('h265')
    expect(encoderCodec('h264_qsv')).toBe('h264')
    expect(encoderCodec('libopenh264')).toBe('h264')
    expect(encodersForCodec(['h264_nvenc', 'hevc_nvenc', 'libopenh264', 'hevc_amf'], 'h265')).toEqual(['hevc_nvenc', 'hevc_amf'])
    expect(formatRequiresPrecise(DEFAULT_EXPORT_FORMAT)).toBe(false)
    expect(formatRequiresPrecise({ ...DEFAULT_EXPORT_FORMAT, codec: 'h265' })).toBe(true)
    expect(formatRequiresPrecise(applyPreset(DEFAULT_EXPORT_FORMAT, 'youtube'))).toBe(true)
  })
})
