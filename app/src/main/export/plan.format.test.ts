import { describe, it, expect } from 'vitest'
import { buildJobs, resolveQuality, NoEncoderError, type StreamProbe } from './plan'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import { applyPreset } from '../../shared/exportPresets'
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, type PresetId } from '../../shared/exportFormat'
import type { ProjectItem } from '../../renderer/editor/project'

const probe = (width: number, height: number, fps: number): StreamProbe =>
  ({ vcodec: 'h264', width, height, fps, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 })
const after = (args: string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const preset = (id: PresetId, over: Partial<ExportFormat> = {}): ExportFormat => ({ ...applyPreset(DEFAULT_EXPORT_FORMAT, id), ...over })

const SRC = 'C:/clips/game 1.mp4'
const item: ProjectItem = { id: '1', source: SRC, start: 10, end: 20 }
const one = (p: StreamProbe): Map<string, StreamProbe> => new Map([[SRC, p]])
const separate = (format: ExportFormat | undefined, p: StreamProbe, encoder = 'h264_nvenc', quality: 'copy' | 'precise' = 'precise') =>
  buildJobs([item], { mode: 'separate', quality, encoder, outDir: 'C:/out', baseName: 'h', format }, one(p))

describe('default format keeps today\'s arguments byte for byte', () => {
  const golden = (output: string): string[] => [
    '-ss', '10.000', '-i', SRC, '-t', '10.000', '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '19',
    '-b:v', '24900k', '-maxrate', '37350k', '-bufsize', '49800k', '-spatial-aq', '1', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-map_metadata', '-1', '-map_chapters', '-1', '-video_track_timescale', '90000', '-y', output
  ]

  it('separate precise: no -vf, source-spec bitrate, no hvc1 tag (missing format and explicit default are identical)', () => {
    const missing = separate(undefined, probe(1920, 1080, 60))
    const explicit = separate(DEFAULT_EXPORT_FORMAT, probe(1920, 1080, 60))
    expect(missing.jobs[0].args).toEqual(golden(missing.jobs[0].output))
    expect(explicit.jobs[0].args).toEqual(missing.jobs[0].args)
    expect(missing.notices).toEqual([])
  })

  it('concat precise from one source: no -vf on segments, no tag on the final mux', () => {
    const items = [item, { ...item, id: '2', start: 30, end: 35 }]
    const opts = { mode: 'concat' as const, quality: 'precise' as const, encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h' }
    const a = buildJobs(items, opts, one(probe(1920, 1080, 60)))
    const b = buildJobs(items, { ...opts, format: { ...DEFAULT_EXPORT_FORMAT } }, one(probe(1920, 1080, 60)))
    const strip = (args: string[]): string[] => args.map((x) => x.replace(/\.aditor-seg-\w+-/, '.aditor-seg-TAG-'))
    expect(a.jobs.map((j) => strip(j.args))).toEqual(b.jobs.map((j) => strip(j.args)))
    for (const j of a.jobs) {
      expect(j.args).not.toContain('-vf')
      expect(j.args).not.toContain('-tag:v')
    }
  })

  it('copy stays copy with the default format', () => {
    expect(resolveQuality([item], { mode: 'separate', quality: 'copy', format: DEFAULT_EXPORT_FORMAT }, one(probe(1920, 1080, 60)))).toEqual({ quality: 'copy', notices: [] })
  })
})

describe('separate exports with platform presets', () => {
  it('Shorts from 1080p144: centred 9:16 crop, scaled to 1080×1920, capped at 60 fps; bitrate from the 1080×1920@60 output', () => {
    const { jobs } = separate(preset('shorts'), probe(1920, 1080, 144))
    const a = jobs[0].args
    expect(after(a, '-vf')).toBe('crop=608:1080:656:0,scale=1080:1920:flags=lanczos,fps=60,format=yuv420p')
    expect(after(a, '-c:v')).toBe('h264_nvenc')
    // 1080×1920×60×0.2 bpp ≈ 24.9 Mbps (the 1080p144 source would get 59.7 Mbps).
    expect(after(a, '-b:v')).toBe('24900k')
    expect(after(a, '-maxrate')).toBe('37350k')
    expect(after(a, '-bufsize')).toBe('49800k')
    // The filter is an output option: after -i and the stream maps, before the encoder.
    expect(a.indexOf('-vf')).toBeGreaterThan(a.indexOf('-i'))
    expect(a.indexOf('-vf')).toBeLessThan(a.indexOf('-c:v'))
    expect(a).not.toContain('-tag:v')
    expect(a.slice(-2)).toEqual(['-y', jobs[0].output])
  })

  it('Shorts crop offset moves the window to the edges', () => {
    expect(after(separate(preset('shorts', { offset: -1 }), probe(1920, 1080, 60)).jobs[0].args, '-vf')).toBe('crop=608:1080:0:0,scale=1080:1920:flags=lanczos,fps=60,format=yuv420p')
    expect(after(separate(preset('shorts', { offset: 1 }), probe(1920, 1080, 60)).jobs[0].args, '-vf')).toBe('crop=608:1080:1312:0,scale=1080:1920:flags=lanczos,fps=60,format=yuv420p')
  })

  it('Shorts with blur background uses only split/scale/crop/overlay', () => {
    const vf = after(separate(preset('shorts', { reframe: 'blur' }), probe(1920, 1080, 60)).jobs[0].args, '-vf')
    expect(vf).toBe(
      'split=2[rf_bg][rf_fg];' +
        '[rf_bg]scale=3414:1920:flags=fast_bilinear,crop=1080:1920:1166:0,scale=46:80:flags=area,scale=1080:1920:flags=bicubic[rf_bgb];' +
        '[rf_fg]scale=1080:608:flags=lanczos[rf_fgs];' +
        '[rf_bgb][rf_fgs]overlay=0:656,fps=60,format=yuv420p'
    )
  })

  it('Reels caps at 30 fps and encodes for 1080×1920@30', () => {
    const a = separate(preset('reels'), probe(1920, 1080, 60)).jobs[0].args
    expect(after(a, '-vf')).toBe('crop=608:1080:656:0,scale=1080:1920:flags=lanczos,fps=30,format=yuv420p')
    expect(after(a, '-b:v')).toBe('12400k')
  })

  it('Square from 1080p60: centred 1:1 crop at 1080×1080, 14 Mbps', () => {
    const a = separate(preset('square'), probe(1920, 1080, 60)).jobs[0].args
    expect(after(a, '-vf')).toBe('crop=1080:1080:420:0,scale=1080:1080:flags=lanczos,fps=60,format=yuv420p')
    expect(after(a, '-b:v')).toBe('14000k')
    expect(after(a, '-maxrate')).toBe('21000k')
  })

  it('YouTube from an ultrawide 2560×1080 source letterboxes into 1920×1080 and encodes for 1080p, not the source', () => {
    const a = separate(preset('youtube'), probe(2560, 1080, 60)).jobs[0].args
    expect(after(a, '-vf')).toBe('scale=1920:810:flags=lanczos,pad=1920:1080:0:134:color=black,fps=60,format=yuv420p')
    expect(after(a, '-b:v')).toBe('24900k')
  })

  it('YouTube from a 16:9 source is a plain scale at the source fps', () => {
    const a = separate(preset('youtube'), probe(1920, 1080, 60)).jobs[0].args
    expect(after(a, '-vf')).toBe('scale=1920:1080:flags=lanczos,fps=60,format=yuv420p')
  })

  it('a frame-rate cap alone keeps the source size; an odd source drops its last column', () => {
    const fmt = { ...DEFAULT_EXPORT_FORMAT, fpsCap: 60 }
    const a = separate(fmt, probe(1920, 1080, 144)).jobs[0].args
    expect(after(a, '-vf')).toBe('scale=1920:1080:flags=lanczos,fps=60,format=yuv420p')
    expect(after(a, '-b:v')).toBe('24900k')
    expect(after(separate(fmt, probe(1919, 1080, 144)).jobs[0].args, '-vf')).toBe('crop=1918:1080:0:0,scale=1918:1080:flags=lanczos,fps=60,format=yuv420p')
    // A cap at or above the source fps changes nothing (never upscales the frame rate).
    expect(separate({ ...DEFAULT_EXPORT_FORMAT, fpsCap: 60 }, probe(1920, 1080, 60), 'h264_nvenc', 'precise').jobs[0].args).not.toContain('-vf')
  })

  it('copy with a preset is forced to precise with a notice; without an encoder it is NoEncoderError', () => {
    const res = separate(preset('shorts'), probe(1920, 1080, 60), 'h264_nvenc', 'copy')
    expect(res.notices).toHaveLength(1)
    expect(res.notices[0]).toMatch(/重新編碼/)
    expect(after(res.jobs[0].args, '-c:v')).toBe('h264_nvenc')
    expect(res.jobs[0].args).not.toContain('copy')
    expect(() => buildJobs([item], { mode: 'separate', quality: 'copy', outDir: 'C:/out', baseName: 'h', format: preset('shorts') }, one(probe(1920, 1080, 60)))).toThrow(NoEncoderError)
  })

  it.each([
    ['frame', { frame: '1:1', width: null, height: null }],
    ['size', { frame: '16:9', width: 1280, height: 720 }],
    ['fps cap', { fpsCap: 30 }],
    ['H.265', { codec: 'h265' }]
  ] as const)('resolveQuality forces precise for %s (separate and concat)', (_name, over) => {
    const fmt = { ...DEFAULT_EXPORT_FORMAT, ...over } as ExportFormat
    for (const mode of ['separate', 'concat'] as const) {
      const r = resolveQuality([item], { mode, quality: 'copy', format: fmt }, one(probe(1920, 1080, 60)))
      expect(r.quality).toBe('precise')
      expect(r.notices).toHaveLength(1)
    }
  })

  it('the disk estimate uses the same output spec as the jobs', () => {
    const items = [item]
    for (const id of ['shorts', 'square', 'youtube', 'reels'] as const) {
      const p = one(probe(2560, 1440, 144))
      const { jobs } = buildJobs(items, { mode: 'separate', quality: 'copy', encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h', format: preset(id) }, p)
      const peak = Number(after(jobs[0].args, '-maxrate')!.replace('k', ''))
      const expected = Math.ceil(Math.max((25 * 1024 * 1024) / 8, ((peak + 192) * 1000) / 8) * 10)
      expect(estimateOutputBytes({ items }, 'copy', p, 'separate', preset(id))).toBe(expected)
    }
  })
})

describe('H.265', () => {
  it.each([
    ['hevc_nvenc', ['-preset', 'p6', '-rc', 'vbr', '-cq', '21', '-profile:v', 'main']],
    ['hevc_qsv', ['-preset', 'slow', '-profile:v', 'main']],
    ['hevc_amf', ['-quality', 'quality', '-rc', 'vbr_peak', '-profile:v', 'main']]
  ] as const)('separate Shorts with %s: HEVC encoder, Main profile, output-spec bitrate and the hvc1 tag', (encoder, expected) => {
    const a = separate(preset('shorts', { codec: 'h265' }), probe(1920, 1080, 60), encoder).jobs[0].args
    expect(after(a, '-c:v')).toBe(encoder)
    for (let i = 0; i < expected.length; i += 2) expect(after(a, expected[i])).toBe(expected[i + 1])
    expect(after(a, '-b:v')).toBe('24900k')
    expect(after(a, '-tag:v')).toBe('hvc1')
    expect(a.indexOf('-tag:v')).toBeLessThan(a.indexOf('-y'))
    expect(a.join(' ')).not.toMatch(/libx265|h264/)
  })

  it('H.265 at the source frame encodes without a filter but still tags hvc1', () => {
    const a = separate({ ...DEFAULT_EXPORT_FORMAT, codec: 'h265' }, probe(1920, 1080, 60), 'hevc_nvenc').jobs[0].args
    expect(a).not.toContain('-vf')
    expect(after(a, '-c:v')).toBe('hevc_nvenc')
    expect(after(a, '-tag:v')).toBe('hvc1')
    // HEVC Main is 8-bit 4:2:0: a 10-bit source must be converted even without a reframe filter.
    expect(after(a, '-pix_fmt')).toBe('yuv420p')
  })

  it('H.264 at the source frame keeps its args without -pix_fmt (unchanged behaviour)', () => {
    const a = separate(DEFAULT_EXPORT_FORMAT, probe(1920, 1080, 60), 'h264_nvenc').jobs[0].args
    expect(a).not.toContain('-pix_fmt')
  })

  it('concat H.265: segments and the final MP4 mux carry hvc1; the final job copies HEVC video', () => {
    const items = [item, { ...item, id: '2', start: 30, end: 35 }]
    const res = buildJobs(items, { mode: 'concat', quality: 'precise', encoder: 'hevc_qsv', outDir: 'C:/out', baseName: 'h', format: preset('square', { codec: 'h265' }) }, one(probe(1920, 1080, 60)))
    const final = res.jobs[res.jobs.length - 1]
    expect(final.output).toMatch(/h\.mp4$/)
    expect(after(final.args, '-c:v')).toBe('copy')
    expect(after(final.args, '-tag:v')).toBe('hvc1')
    for (const s of res.jobs.filter((j) => j.intermediate)) {
      expect(after(s.args, '-c:v')).toBe('hevc_qsv')
      expect(after(s.args, '-tag:v')).toBe('hvc1')
      expect(after(s.args, '-vf')).toBe('crop=1080:1080:420:0,scale=1080:1080:flags=lanczos,fps=60,format=yuv420p')
    }
  })

  it('refuses an encoder that does not produce the requested codec', () => {
    expect(() => separate(preset('shorts', { codec: 'h265' }), probe(1920, 1080, 60), 'h264_nvenc')).toThrow(/hevc|H\.265/i)
    expect(() => separate(preset('shorts'), probe(1920, 1080, 60), 'hevc_nvenc')).toThrow(/H\.264/)
  })
})

describe('concat with presets', () => {
  const A = 'C:/a.mp4'
  const B = 'C:/b.mp4'
  const items: ProjectItem[] = [
    { id: '1', source: A, start: 1, end: 5 },
    { id: '2', source: B, start: 2, end: 6 },
    { id: '3', source: A, start: 8, end: 9 }
  ]
  const concat = (format: ExportFormat | undefined, probes: Map<string, StreamProbe>, quality: 'copy' | 'precise' = 'precise') =>
    buildJobs(items, { mode: 'concat', quality, encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h', format }, probes)

  it('mixed 1080p60 + 1440p144 Shorts: one 1080×1920@60 output spec, each segment cropped from its own source size', () => {
    const res = concat(preset('shorts'), new Map([[A, probe(1920, 1080, 60)], [B, probe(2560, 1440, 144)]]))
    const segs = res.jobs.filter((j) => j.intermediate)
    expect(segs).toHaveLength(3)
    const vfA = 'crop=608:1080:656:0,scale=1080:1920:flags=lanczos,fps=60,format=yuv420p'
    const vfB = 'crop=810:1440:874:0,scale=1080:1920:flags=lanczos,fps=60,format=yuv420p'
    expect(segs.map((s) => after(s.args, '-vf'))).toEqual([vfA, vfB, vfA])
    for (const s of segs) {
      expect(after(s.args, '-b:v')).toBe('24900k')
      expect(after(s.args, '-maxrate')).toBe('37350k')
    }
    expect(res.jobs[res.jobs.length - 1].args).not.toContain('-tag:v')
  })

  it('same-source Shorts concat: every segment reframed even though sources already match', () => {
    const res = concat(preset('shorts'), new Map([[A, probe(1920, 1080, 60)], [B, probe(1920, 1080, 60)]]))
    for (const s of res.jobs.filter((j) => j.intermediate)) expect(after(s.args, '-vf')).toBe('crop=608:1080:656:0,scale=1080:1920:flags=lanczos,fps=60,format=yuv420p')
    // Matching sources: no "different specs" notice.
    expect(res.notices).toEqual([])
  })

  it('copy concat with a preset: forced to precise with the format notice', () => {
    const res = concat(preset('square'), new Map([[A, probe(1920, 1080, 60)], [B, probe(1920, 1080, 60)]]), 'copy')
    expect(res.notices[0]).toMatch(/重新編碼/)
    expect(res.jobs.filter((j) => j.intermediate).every((s) => after(s.args, '-c:v') === 'h264_nvenc')).toBe(true)
  })

  it('default format, mixed landscape + portrait: each source letterboxed into the 1920×1920 timeline (normalization semantics kept)', () => {
    const res = concat(undefined, new Map([[A, probe(1920, 1080, 60)], [B, probe(1080, 1920, 60)]]))
    const segs = res.jobs.filter((j) => j.intermediate)
    expect(after(segs[0].args, '-vf')).toBe('scale=1920:1080:flags=lanczos,pad=1920:1920:0:420:color=black,fps=60,format=yuv420p')
    expect(after(segs[1].args, '-vf')).toBe('scale=1080:1920:flags=lanczos,pad=1920:1920:420:0:color=black,fps=60,format=yuv420p')
    expect(res.notices.some((n) => n.includes('來源規格不同'))).toBe(true)
  })

  it('YouTube with mixed sources letterboxes each into the derived 16:9 output', () => {
    // Timeline 1920×1440@60 (widest × tallest) → YouTube keeps the 1440 short side: 2560×1440.
    const res = concat(preset('youtube'), new Map([[A, probe(1920, 1080, 60)], [B, probe(1440, 1440, 30)]]))
    const segs = res.jobs.filter((j) => j.intermediate)
    expect(after(segs[0].args, '-vf')).toBe('scale=2560:1440:flags=lanczos,fps=60,format=yuv420p')
    expect(after(segs[1].args, '-vf')).toBe('scale=1440:1440:flags=lanczos,pad=2560:1440:560:0:color=black,fps=60,format=yuv420p')
    expect(after(segs[0].args, '-b:v')).toBe('44200k')
  })
})
