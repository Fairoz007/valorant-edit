import { describe, expect, test } from 'vitest'
import { exportViewModel, ExportPlan, previewGeometry } from './exportViewModel'
import { DEFAULT_EXPORT_FORMAT } from '../../shared/exportFormat'
import { applyPreset } from '../../shared/exportPresets'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import { computeReframe } from '../../shared/reframe'
import { Project } from '../editor/project'
import { i18n } from '../i18n'

const A = 'D:/v/a.mp4'
const B = 'D:/v/b.mp4'

function proj(items: Array<[string, string, number, number]>): Project {
  return { version: 1, name: 'p', items: items.map(([id, source, start, end]) => ({ id, source, start, end })) }
}

function plan(over: Partial<ExportPlan> = {}): ExportPlan {
  return {
    mode: 'concat',
    quality: 'copy',
    sources: { [A]: { codec: 'h264', width: 1920, height: 1080 }, [B]: { codec: 'h264', width: 1920, height: 1080 } },
    keyframes: {},
    missingItemIds: new Set<string>(),
    ...over
  }
}

const HW = { encoders: ['h264_nvenc'], openh264: false }

describe('exportViewModel', () => {
  test('a styled (Auto edit) project always re-encodes; a plain one keeps lossless copy', () => {
    const plain = proj([['1', A, 0, 10], ['2', A, 20, 30]])
    expect(exportViewModel(plain, plan(), HW).effectiveQuality).toBe('copy')
    const styled: Project = { ...plain, version: 2, items: plain.items.map((i, n) => (n === 1 ? { ...i, transitionIn: 'dipBlack', transitionSec: 0.5 } : i)) }
    expect(exportViewModel(styled, plan(), HW).effectiveQuality).toBe('precise')
    expect(exportViewModel({ ...plain, version: 2, letterbox: true }, plan(), HW).effectiveQuality).toBe('precise')
  })

  test('estimates mixed precise exports from the selected mode and preserves source fps', () => {
    const p = proj([['1', A, 0, 60], ['2', B, 0, 30]])
    const sources = { [A]: { codec: 'h264', width: 3840, height: 2160, fps: 30 }, [B]: { codec: 'h264', width: 1920, height: 1080, fps: 60 } }
    const merged = exportViewModel(p, plan({ sources }), HW)
    expect(merged.effectiveQuality).toBe('precise')
    expect(merged.estimatedBytes).toBe(90 * (149_250 + 192) * 1000 / 8)
    const separate = exportViewModel(p, plan({ sources, mode: 'separate', quality: 'precise' }), HW)
    expect(separate.estimatedBytes).toBe((60 * (74_700 + 192) + 30 * (37_350 + 192)) * 1000 / 8)
  })

  test('mixed source params → copyAvailable false with fallback notice', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 5, 15]])
    const vm = exportViewModel(p, plan({ sources: { [A]: { codec: 'h264', width: 1920, height: 1080 }, [B]: { codec: 'h264', width: 1728, height: 1080 } } }), HW)
    expect(vm.copyAvailable).toBe(false)
    expect(vm.notices.some((n) => n.text.includes(i18n.export.fallbackReencodeNotice))).toBe(true)
    expect(vm.effectiveQuality).toBe('precise')
    expect(vm.extraSecondsHint).toBeNull()
  })

  test('concat: one source repeated keeps copy; two sources with unconfirmable fps/audio fall back to precise (I9); separate is always copy-capable', () => {
    const same = proj([['1', A, 0, 10], ['2', A, 20, 30]])
    expect(exportViewModel(same, plan(), HW).copyAvailable).toBe(true)
    const p = proj([['1', A, 0, 10], ['2', B, 5, 15]])
    expect(exportViewModel(p, plan(), HW).copyAvailable).toBe(false)
    const mixed = plan({ mode: 'separate', sources: { [A]: { codec: 'h264', width: 1, height: 1 }, [B]: { codec: 'hevc', width: 2, height: 2 } } })
    expect(exportViewModel(p, mixed, HW).copyAvailable).toBe(true)
  })

  test('concat: a source that failed to probe rules out stream copy, as main does', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 5, 15]])
    const full = { codec: 'h264', width: 1920, height: 1080, fps: 60, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 }
    expect(exportViewModel(p, plan({ sources: { [A]: full, [B]: full } }), HW).copyAvailable).toBe(true)
    expect(exportViewModel(p, plan({ sources: { [A]: full } }), HW).copyAvailable).toBe(false)
  })

  test('precise export waits for encoder detection instead of asking for OpenH264', () => {
    const p = proj([['1', A, 0, 10]])
    const vm = exportViewModel(p, plan({ quality: 'precise' }), { encoders: [], openh264: false, detected: false })
    expect(vm.openh264Required).toBe(false)
    expect(vm.canStart).toBe(false)
  })

  test('missing source files become blockers and disable start', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 5, 15]])
    const vm = exportViewModel(p, plan({ missingItemIds: new Set(['2']) }), HW)
    expect(vm.canStart).toBe(false)
    expect(vm.blockers.some((b) => b.includes(B))).toBe(true)
    expect(vm.blockers.some((b) => b.includes(A))).toBe(false)
  })

  test('empty project cannot start', () => {
    const vm = exportViewModel(proj([]), plan(), HW)
    expect(vm.canStart).toBe(false)
    expect(vm.blockers).toContain(i18n.export.blockEmpty)
  })

  test('null plan cannot start', () => {
    expect(exportViewModel(proj([['1', A, 0, 10]]), null, HW).canStart).toBe(false)
  })

  test('extraSecondsHint uses keyframe gaps for copy mode only', () => {
    const p = proj([['1', A, 10, 20], ['2', A, 31, 40]])
    const kf = { [A]: [0, 8, 30] } // 10-8=2 and 31-30=1, so the average is 1.5.
    const copy = exportViewModel(p, plan({ quality: 'copy', keyframes: kf }), HW)
    expect(copy.extraSecondsHint).toBeCloseTo(1.5, 5)
    const precise = exportViewModel(p, plan({ quality: 'precise', keyframes: kf }), HW)
    expect(precise.extraSecondsHint).toBeNull()
  })

  test('extraSecondsHint is null when no keyframes are known (no invented number)', () => {
    const p = proj([['1', A, 10, 20]])
    expect(exportViewModel(p, plan({ quality: 'copy', keyframes: {} }), HW).extraSecondsHint).toBeNull()
  })

  test('openh264 required when no hw encoders and not installed', () => {
    const p = proj([['1', A, 0, 10]])
    const vm = exportViewModel(p, plan({ quality: 'precise' }), { encoders: [], openh264: false })
    expect(vm.openh264Required).toBe(true)
    expect(vm.canStart).toBe(false)
  // Fast lossless does not require an encoder.
    const copy = exportViewModel(p, plan({ quality: 'copy', mode: 'separate' }), { encoders: [], openh264: false })
    expect(copy.openh264Required).toBe(false)
    expect(copy.canStart).toBe(true)
  // Not needed when a hardware encoder is available or it is already installed.
    expect(exportViewModel(p, plan({ quality: 'precise' }), HW).openh264Required).toBe(false)
    expect(exportViewModel(p, plan({ quality: 'precise' }), { encoders: ['libopenh264'], openh264: true }).openh264Required).toBe(false)
  })

  test('mixed params fallback in concat requires an encoder too', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 0, 10]])
    const mixed = plan({ sources: { [A]: { codec: 'h264', width: 1, height: 1 }, [B]: { codec: 'h264', width: 2, height: 2 } } })
    expect(exportViewModel(p, mixed, { encoders: [], openh264: false }).openh264Required).toBe(true)
    expect(exportViewModel(p, mixed, HW).canStart).toBe(true)
  })
})

describe('exportViewModel format (reframing, presets, codec)', () => {
  const HD60 = { [A]: { codec: 'h264', width: 1920, height: 1080, fps: 60 }, [B]: { codec: 'h264', width: 1920, height: 1080, fps: 60 } }
  const shorts = applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts')

  test('a format that needs re-encoding disables copy with an inline reason and makes precise effective', () => {
    const p = proj([['1', A, 0, 10]])
    const vm = exportViewModel(p, plan({ sources: HD60 }), HW, { format: shorts })
    expect(vm.copyAvailable).toBe(false)
    expect(vm.copyReason).toBe(i18n.export.copyNeedsReencode)
    expect(vm.effectiveQuality).toBe('precise')
    expect(vm.notices).toEqual([])
    const plain = exportViewModel(p, plan({ sources: HD60 }), HW, { format: DEFAULT_EXPORT_FORMAT })
    expect(plain).toMatchObject({ copyAvailable: true, copyReason: null, effectiveQuality: 'copy' })
    // An explicit fps cap or H.265 alone also needs precise.
    expect(exportViewModel(p, plan({ sources: HD60 }), HW, { format: { ...DEFAULT_EXPORT_FORMAT, fpsCap: 30 } }).copyAvailable).toBe(false)
    expect(exportViewModel(p, plan({ sources: HD60 }), { encoders: ['hevc_nvenc'], openh264: false }, { format: { ...DEFAULT_EXPORT_FORMAT, codec: 'h265' } }).copyAvailable).toBe(false)
  })

  test('the estimate passes the format (output size/fps drive the bitrate)', () => {
    const p = proj([['1', A, 0, 30]])
    const sources = { [A]: { codec: 'h264', width: 3840, height: 2160, fps: 60 } }
    const probes = new Map([[A, { vcodec: 'h264', width: 3840, height: 2160, fps: 60, pix_fmt: '', acodec: '', sample_rate: 0, channels: 0 }]])
    const vm = exportViewModel(p, plan({ sources, quality: 'precise' }), HW, { format: shorts })
    expect(vm.estimatedBytes).toBe(estimateOutputBytes(p, 'precise', probes, 'concat', shorts))
    expect(vm.estimatedBytes).toBeLessThan(exportViewModel(p, plan({ sources, quality: 'precise' }), HW).estimatedBytes)
    expect(vm.summary.bytes).toBe(vm.estimatedBytes)
  })

  test('summary: output size from resolveOutputSpec, capped fps, codec, size estimate and duration', () => {
    const p = proj([['1', A, 0, 30], ['2', B, 0, 18]])
    const vm = exportViewModel(p, plan({ sources: HD60 }), HW, { format: applyPreset(DEFAULT_EXPORT_FORMAT, 'reels') })
    expect(vm.summary).toMatchObject({ width: 1080, height: 1920, fps: 30, codec: 'h264', seconds: 48, varies: false })
    const yt = exportViewModel(p, plan({ sources: HD60 }), HW, { format: applyPreset(DEFAULT_EXPORT_FORMAT, 'youtube') })
    expect(yt.summary).toMatchObject({ width: 1920, height: 1080, fps: 60 })
    const square = exportViewModel(p, plan({ sources: HD60 }), HW, { format: { ...DEFAULT_EXPORT_FORMAT, frame: '1:1' } })
    expect(square.summary).toMatchObject({ width: 1080, height: 1080 })
  })

  test('separate mode with differently sized sources marks the size as varying', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 0, 10]])
    const sources = { [A]: HD60[A], [B]: { codec: 'h264', width: 2560, height: 1440, fps: 60 } }
    const vm = exportViewModel(p, plan({ sources, mode: 'separate' }), HW, { format: DEFAULT_EXPORT_FORMAT })
    expect(vm.summary).toMatchObject({ width: 1920, height: 1080, varies: true })
    expect(exportViewModel(p, plan({ sources, mode: 'separate' }), HW, { format: shorts }).summary.varies).toBe(false)
  })

  test('H.265 unavailable: disabled, a persisted H.265 falls back to H.264 with a notice (unknown before detection)', () => {
    const p = proj([['1', A, 0, 10]])
    const h265 = { ...shorts, codec: 'h265' as const }
    const vm = exportViewModel(p, plan({ sources: HD60 }), HW, { format: h265 })
    expect(vm).toMatchObject({ h265Unavailable: true, codecFallback: true })
    expect(vm.format.codec).toBe('h264')
    expect(vm.summary.codec).toBe('h264')
    expect(vm.notices).toEqual([{ kind: 'info', text: i18n.export.h265FallbackNotice }])
    const ok = exportViewModel(p, plan({ sources: HD60 }), { encoders: ['h264_nvenc', 'hevc_amf'], openh264: false }, { format: h265 })
    expect(ok).toMatchObject({ h265Unavailable: false, codecFallback: false, canStart: true })
    expect(ok.format.codec).toBe('h265')
    const pending = exportViewModel(p, plan({ sources: HD60 }), { encoders: [], openh264: false, detected: false }, { format: h265 })
    expect(pending).toMatchObject({ h265Unavailable: false, codecFallback: false, canStart: false })
  })

  test('H.265 never asks for OpenH264; H.264 without an encoder still does', () => {
    const p = proj([['1', A, 0, 10]])
    const h265 = { ...shorts, codec: 'h265' as const }
    expect(exportViewModel(p, plan({ sources: HD60 }), { encoders: ['hevc_qsv'], openh264: false }, { format: h265 }).openh264Required).toBe(false)
    expect(exportViewModel(p, plan({ sources: HD60 }), { encoders: ['hevc_qsv'], openh264: false }, { format: shorts }).openh264Required).toBe(true)
  })

  test('over the preset length: a warning (not a block); the trim option shortens what is exported', () => {
    const p = proj([['1', A, 0, 50], ['2', B, 0, 40]])
    const vm = exportViewModel(p, plan({ sources: HD60 }), HW, { format: shorts })
    expect(vm.lengthWarning).toEqual({ maxSeconds: 60, seconds: 90 })
    expect(vm.blockers).toEqual([])
    expect(vm.canStart).toBe(true)
    expect(vm.summary.seconds).toBe(90)
    const trimmed = exportViewModel(p, plan({ sources: HD60 }), HW, { format: shorts, trimToLimit: true })
    expect(trimmed.lengthWarning).toEqual({ maxSeconds: 60, seconds: 90 })
    expect(trimmed.exportItems.map((i) => [i.start, i.end])).toEqual([[0, 50], [0, 10]])
    expect(trimmed.summary.seconds).toBe(60)
    expect(trimmed.estimatedBytes).toBeLessThan(vm.estimatedBytes)
    // Custom (edited) formats have no platform limit.
    expect(exportViewModel(p, plan({ sources: HD60 }), HW, { format: { ...shorts, fpsCap: 30 } }).lengthWarning).toBeNull()
  })

  test('preview geometry matches computeReframe for the preview source (1920×1080 → 9:16 crop)', () => {
    const p = proj([['1', A, 0, 10]])
    const xs = [-1, 0, 1].map((offset) => {
      const vm = exportViewModel(p, plan({ sources: HD60 }), HW, { format: { ...shorts, offset } })
      const { src, geometry } = previewGeometry(p, plan({ sources: HD60 }), vm, { width: 1920, height: 1080, fps: 60 })
      expect(src).toEqual({ width: 1920, height: 1080 })
      expect(geometry).toEqual(computeReframe(src, { width: 1080, height: 1920, fps: 60 }, 'crop', offset))
      return [geometry.crop.x, geometry.crop.width]
    })
    expect(xs).toEqual([[0, 608], [656, 608], [1312, 608]])
    // Without a preview source the first clip's probed source is used.
    const vm = exportViewModel(p, plan({ sources: HD60 }), HW, { format: shorts })
    expect(previewGeometry(p, plan({ sources: HD60 }), vm).geometry.crop).toEqual({ x: 656, y: 0, width: 608, height: 1080 })
  })

  test('separate preview uses the preview source spec; concat uses the timeline spec', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 0, 10]])
    const sources = { [A]: HD60[A], [B]: { codec: 'h264', width: 2560, height: 1440, fps: 60 } }
    const youtube916 = { ...DEFAULT_EXPORT_FORMAT, frame: '9:16' as const }
    const sep = exportViewModel(p, plan({ sources, mode: 'separate' }), HW, { format: youtube916 })
    expect(previewGeometry(p, plan({ sources, mode: 'separate' }), sep, { width: 2560, height: 1440, fps: 60 }).geometry.out).toEqual({ width: 1440, height: 2560 })
    const cat = exportViewModel(p, plan({ sources }), HW, { format: youtube916 })
    expect(previewGeometry(p, plan({ sources }), cat, { width: 2560, height: 1440, fps: 60 }).geometry.out).toEqual({ width: cat.outSpec.width, height: cat.outSpec.height })
  })
})
