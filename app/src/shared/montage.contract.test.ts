import { describe, it, expect } from 'vitest'
import {
  coerceAutoMontage,
  DEFAULT_AUTO_MONTAGE,
  MONTAGE_JOB_ID_RE,
  MONTAGE_RANGES,
  montageJobId,
  montageProjectId,
  postAnalysisForMontage
} from './montage'

describe('coerceAutoMontage', () => {
  it('returns a fresh copy of the defaults for missing or malformed input', () => {
    for (const raw of [undefined, null, 42, 'on', [], [1]]) {
      const v = coerceAutoMontage(raw)
      expect(v).toEqual(DEFAULT_AUTO_MONTAGE)
      expect(v).not.toBe(DEFAULT_AUTO_MONTAGE)
      expect(v.include).not.toBe(DEFAULT_AUTO_MONTAGE.include)
    }
  })

  it('is off by default', () => {
    expect(DEFAULT_AUTO_MONTAGE.enabled).toBe(false)
    expect(DEFAULT_AUTO_MONTAGE.keepSourceRecording).toBe(true)
  })

  it('keeps valid fields', () => {
    const raw = {
      enabled: true,
      formatPreset: 'shorts',
      minClips: 4,
      maxDurationSec: 120,
      include: { multiKills: false, aces: true, clutches: false, singleKills: false },
      timing: 'afterGameExit',
      keepSourceRecording: false,
      outputDir: 'D:\\Clips\\Montages'
    }
    expect(coerceAutoMontage(raw)).toEqual(raw)
  })

  it('falls back field by field and clamps and rounds numbers', () => {
    const v = coerceAutoMontage({
      enabled: 'yes',
      formatPreset: 'vhs',
      minClips: 99,
      maxDurationSec: 2.6,
      include: { multiKills: 0, aces: false },
      timing: 'never',
      keepSourceRecording: null,
      outputDir: ''
    })
    expect(v.enabled).toBe(false)
    expect(v.formatPreset).toBe('youtube')
    expect(v.minClips).toBe(MONTAGE_RANGES.minClips.max)
    expect(v.maxDurationSec).toBe(MONTAGE_RANGES.maxDurationSec.min)
    expect(v.include).toEqual({ multiKills: true, aces: false, clutches: true, singleKills: true })
    expect(v.timing).toBe('afterEachMatch')
    expect(v.keepSourceRecording).toBe(true)
    expect(v.outputDir).toBeNull()
    expect(coerceAutoMontage({ minClips: 3.4, maxDurationSec: Number.NaN }).minClips).toBe(3)
    expect(coerceAutoMontage({ maxDurationSec: Number.POSITIVE_INFINITY }).maxDurationSec).toBe(90)
  })

  it('uses the given base for invalid fields', () => {
    const base = { ...DEFAULT_AUTO_MONTAGE, enabled: true, minClips: 5, outputDir: 'E:\\m' }
    const v = coerceAutoMontage({ enabled: 1, minClips: 'x' }, base)
    expect(v.enabled).toBe(true)
    expect(v.minClips).toBe(5)
    expect(v.outputDir).toBe('E:\\m')
    expect(coerceAutoMontage({ outputDir: null }, base).outputDir).toBeNull()
  })
})

describe('postAnalysisForMontage', () => {
  it("switches 'none' to 'perMatch' only while Auto montage is on", () => {
    expect(postAnalysisForMontage('none', { enabled: true })).toBe('perMatch')
    expect(postAnalysisForMontage('none', { enabled: false })).toBe('none')
  })

  it('leaves every other value unchanged', () => {
    for (const p of ['afterExit', 'perMatch'] as const) {
      expect(postAnalysisForMontage(p, { enabled: true })).toBe(p)
      expect(postAnalysisForMontage(p, { enabled: false })).toBe(p)
    }
  })
})

describe('montageJobId', () => {
  it('is well-formed and deterministic', () => {
    const id = montageJobId('C:\\Users\\me\\Videos\\Valorant_2026-11-15_21-08.mp4')
    expect(id).toMatch(MONTAGE_JOB_ID_RE)
    expect(montageJobId('C:\\Users\\me\\Videos\\Valorant_2026-11-15_21-08.mp4')).toBe(id)
  })

  it('ignores case, separator style and trailing separators (Windows paths)', () => {
    const a = montageJobId('C:\\Users\\Me\\Videos\\A.mp4')
    expect(montageJobId('c:/users/me/videos/a.mp4')).toBe(a)
    expect(montageJobId('C:\\Users\\Me\\Videos\\A.mp4\\')).toBe(a)
  })

  it('differs for different files, including non-ASCII and spaced paths', () => {
    const ids = new Set([
      montageJobId('C:\\Videos\\a.mp4'),
      montageJobId('C:\\Videos\\b.mp4'),
      montageJobId('C:\\Users\\テスト\\Videos\\a.mp4'),
      montageJobId('C:\\Users\\Jane Doe\\OneDrive\\Videos\\a.mp4')
    ])
    expect(ids.size).toBe(4)
    for (const id of ids) expect(id).toMatch(MONTAGE_JOB_ID_RE)
  })

  it('matches the FNV-1a 64-bit reference value for the empty path', () => {
    expect(montageJobId('')).toBe('m_cbf29ce484222325')
  })

  it('derives the project id from the job id', () => {
    expect(montageProjectId('m_0123456789abcdef')).toBe('p_m_0123456789abcdef')
  })
})
