import { describe, it, expect } from 'vitest'
import { DEFAULT_AUTO_EDIT_OPTIONS, MONTAGE_STYLES, planTotalSec, type AutoEditSource, type MontageStyle } from '../../shared/autoEdit'
import { planAutoEdit } from '../../shared/autoEditPlan'
import { autoEditToProject } from '../../shared/autoEditProject'
import { DEFAULT_EXPORT_FORMAT } from '../../shared/exportFormat'
import { applyPreset } from '../../shared/exportPresets'
import type { StreamProbe } from '../../shared/exportCompat'
import type { EngineEvent } from '../../shared/types'
import { escapeConcatPath } from './plan'
import {
  ALLOWED_FILTERS,
  argvFilterNames,
  cardSegmentArgs,
  clipSegmentArgs,
  concatArgs,
  decodePcmArgs,
  DIP_STEPS,
  filterNames,
  fitText,
  frameGrabArgs,
  layoutMontage,
  montagePlannedSec,
  muxArgs,
  snapItemsToBeats,
  zoomCrop,
  type ClipSegment,
  type MontageItem,
  type MontageLayout,
  type MontageProjectStyle
} from './montage-plan'

const A = 'C:\\Users\\Jane Doe\\OneDrive - Contoso\\Vidéos\\試合 1.mp4'
const B = "C:\\Users\\Jane Doe\\Videos\\it's B.mkv"
const probe: StreamProbe = { vcodec: 'h264', width: 1920, height: 1080, fps: 60, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 }
const probes = new Map([[A, probe], [B, probe]])

let seq = 0
const kill = (t: number): EngineEvent => ({
  id: `k${seq++}`, t, type: 'kill', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto'
})
const sources: AutoEditSource[] = [
  { path: A, durationSec: 120, recordedAt: 1000, hasAudio: true, events: [10, 40, 41.5, 43, 80, 81, 82, 83, 84].map(kill) },
  { path: B, durationSec: 90, recordedAt: 2000, hasAudio: true, events: [15, 16.5, 60].map(kill) }
]

function project(style: MontageStyle, music = false): { items: MontageItem[]; style: MontageProjectStyle; planned: number } {
  const plan = planAutoEdit(sources, { ...DEFAULT_AUTO_EDIT_OPTIONS, sources: [], targetSec: 'all', style, musicPath: music ? 'C:\\Music\\a.mp3' : null })
  const p = autoEditToProject(plan, 'p', 'Auto edit')
  return { items: p.items, style: { style: p.style, music: p.music, intro: p.intro, outro: p.outro, letterbox: p.letterbox }, planned: planTotalSec(plan.clips, plan.intro, plan.outro) }
}

const pngs = (layout: MontageLayout) => layout.captions.map((_, i) => ({ path: `C:\\Temp\\montage x\\caption-${i}.png`, width: 600, height: 80 }))
function allClipArgs(layout: MontageLayout, format = DEFAULT_EXPORT_FORMAT): string[][] {
  return layout.segments.filter((s): s is ClipSegment => s.kind === 'clip').map((s, i) =>
    clipSegmentArgs(s, { layout, format, encoder: 'h264_nvenc', probe, captionPngs: pngs(layout), output: `C:\\Temp\\seg ${i}.mov` })
  )
}
const graphOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1]

describe('segment layout', () => {
  for (const style of MONTAGE_STYLES) {
    it(`${style}: segment lengths sum to the planned total and frames land within half a frame`, () => {
      const { items, style: st, planned } = project(style)
      const layout = layoutMontage(items, st, { probes, format: style === 'shorts' ? applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts') : DEFAULT_EXPORT_FORMAT })
      const exact = layout.segments.reduce((s, x) => s + x.exactSec, 0)
      expect(Math.abs(exact - planned)).toBeLessThan(1e-6)
      expect(Math.abs(layout.plannedSec - montagePlannedSec(items, st))).toBeLessThan(1e-6)
      expect(layout.segments.reduce((s, x) => s + x.frames, 0)).toBe(layout.totalFrames)
      expect(Math.abs(layout.expectedSec - planned)).toBeLessThanOrEqual(0.5 / layout.out.fps + 1e-9)
      if (style === 'shorts') expect([layout.out.width, layout.out.height]).toEqual([1080, 1920])
    })
  }

  it('splits an item at the edges of slow-mo and zoom windows', () => {
    const item: MontageItem = { id: 'a', source: A, start: 10, end: 14, effects: [{ kind: 'slowmo', at: 12, durationSec: 0.6, speed: 0.5 }, { kind: 'zoomPunch', at: 13, durationSec: 0.4, scale: 1.2 }] }
    const layout = layoutMontage([item], {}, { probes })
    const segs = layout.segments as ClipSegment[]
    expect(segs.map((s) => [s.srcStart, s.srcEnd])).toEqual([[10, 11.7], [11.7, 12.3], [12.3, 12.8], [12.8, 13.2], [13.2, 14]])
    expect(segs.map((s) => s.rate)).toEqual([1, 2, 1, 1, 1])
    expect(segs.map((s) => s.zoom)).toEqual([null, null, null, 1.2, null])
    expect(segs.map((s) => s.silent)).toEqual([false, true, false, false, false])
    expect(layout.plannedSec).toBeCloseTo(4.6, 10)
  })

  it('whole-item speed and silent sources get silent audio', () => {
    const layout = layoutMontage([{ id: 'a', source: A, start: 0, end: 4, speed: 2 }, { id: 'b', source: B, start: 0, end: 2 }], {}, { probes, silentSources: new Set([B]) })
    const segs = layout.segments as ClipSegment[]
    expect(segs.map((s) => [s.rate, s.silent])).toEqual([[0.5, true], [1, true]])
    expect(layout.plannedSec).toBe(4)
  })

  it('places dips across the cut: last half of the outgoing item, first half of the incoming one', () => {
    const items: MontageItem[] = [
      { id: 'a', source: A, start: 0, end: 3 },
      { id: 'b', source: A, start: 10, end: 13, transitionIn: 'dipWhite', transitionSec: 0.6 }
    ]
    const [a, b] = layoutMontage(items, {}, { probes }).segments as ClipSegment[]
    expect(a.dips).toHaveLength(DIP_STEPS)
    expect(a.dips[0].a).toBeCloseTo(2.7, 10)
    expect(a.dips.at(-1)!.b).toBeCloseTo(3, 10)
    expect(a.dips.map((d) => d.alpha).at(-1)).toBe(1)
    expect(b.dips[0]).toMatchObject({ a: 0, alpha: 1, color: 'white' })
    expect(b.dips.at(-1)!.b).toBeCloseTo(0.3, 10)
    expect(new Set([...a.dips, ...b.dips].map((d) => d.alpha)).size).toBeGreaterThanOrEqual(DIP_STEPS)
  })
})

describe('filter graphs', () => {
  it('Clean has no montage filters beyond the reframe', () => {
    const { items, style } = project('clean')
    const layout = layoutMontage(items, style, { probes })
    for (const args of allClipArgs(layout)) {
      const g = graphOf(args)
      expect(g).not.toMatch(/drawbox|setpts=\(PTS|crop=/)
      expect(filterNames(g).filter((n) => n === 'overlay')).toHaveLength(0)
      expect(args).not.toContain('-loop')
    }
  })

  it('Hype has flash, zoom punch and white dips', () => {
    const { items, style } = project('hype')
    const g = allClipArgs(layoutMontage(items, style, { probes })).map(graphOf).join('\n')
    expect(g).toMatch(/drawbox=x=0:y=0:w=iw:h=ih:color=white@0\.6:t=fill:enable='between\(t,/)
    expect(g).toMatch(/crop=1600:900:\(iw-1600\)\/2:\(ih-900\)\/2,scale=1920:1080:flags=bilinear/)
    const alphas = new Set([...g.matchAll(/color=white@([0-9.]+):t=fill:enable/g)].map((m) => m[1]).filter((a) => a !== '0.6'))
    expect(alphas.size).toBeGreaterThanOrEqual(DIP_STEPS - 1)
    expect(g).toMatch(/overlay=x=\(main_w-overlay_w\)\/2:y=main_h\*2\/3-overlay_h\/2:enable='between\(t,/)
  })

  it('Cinematic has letterbox bars, black dips and slow motion', () => {
    const { items, style } = project('cinematic')
    const layout = layoutMontage(items, style, { probes })
    expect(layout.letterboxBar).toBe(138)
    const g = allClipArgs(layout).map(graphOf).join('\n')
    expect(g).toContain('drawbox=x=0:y=0:w=iw:h=138:color=black@1:t=fill')
    expect(g).toContain('drawbox=x=0:y=ih-138:w=iw:h=138:color=black@1:t=fill')
    expect(g).toMatch(/color=black@0\.5:t=fill:enable/)
    expect(g).toContain('setpts=(PTS-STARTPTS)*2,fps=60')
    // Slow-mo sub-segments take silent audio of the stretched length.
    const slow = allClipArgs(layout).filter((a) => graphOf(a).includes('setpts=(PTS-STARTPTS)*2'))
    expect(slow.length).toBeGreaterThan(0)
    for (const a of slow) expect(a.join(' ')).toContain('-f lavfi -i anullsrc=r=48000:cl=stereo')
  })

  it('uses only filters of the pinned FFmpeg build in every job', () => {
    for (const style of MONTAGE_STYLES) {
      const { items, style: st } = project(style, true)
      const format = style === 'shorts' ? applyPreset(DEFAULT_EXPORT_FORMAT, 'shorts') : { ...DEFAULT_EXPORT_FORMAT, frame: '9:16' as const, reframe: 'blur' as const }
      const layout = layoutMontage(items, st, { probes, format })
      const jobs = [...allClipArgs(layout, format)]
      for (const seg of layout.segments) {
        if (seg.kind !== 'card') continue
        jobs.push(cardSegmentArgs(seg, { layout, format, encoder: 'libopenh264', text: { path: 'C:\\t.png', width: 300, height: 60 }, background: { path: 'C:\\b.png', width: 120, height: 68 }, output: 'C:\\c.mov' }))
        jobs.push(frameGrabArgs(A, 1, probe, layout, format, 'C:\\f.rgb'))
      }
      jobs.push(concatArgs('C:\\l.txt', format, 'pcm', 'C:\\m.mov'), decodePcmArgs('C:\\Music\\a.mp3', 30, 'C:\\m.f32'), muxArgs('C:\\m.mov', 'C:\\x.f32', format, 'C:\\o.mp4'))
      for (const args of jobs) {
        const names = argvFilterNames(args)
        for (const n of names) expect(ALLOWED_FILTERS.has(n), `${style}: ${n}`).toBe(true)
      }
      expect(jobs.flatMap(argvFilterNames)).not.toContain('xfade')
    }
  })

  it('passes Windows paths as whole argv entries and never inside filter graphs', () => {
    const { items, style } = project('hype')
    const layout = layoutMontage(items, style, { probes })
    const args = allClipArgs(layout)
    const all = args.flat()
    expect(all).toContain(A)
    expect(all).toContain(B)
    for (const a of args) {
      expect(graphOf(a)).not.toMatch(/Jane Doe|\\|試合/)
      expect(a.at(-1)).toMatch(/^C:\\Temp\\seg \d+\.mov$/)
    }
    expect(escapeConcatPath("C:\\Users\\Jane Doe\\OneDrive\\it's 試合.mov")).toBe("'C:/Users/Jane Doe/OneDrive/it'\\''s 試合.mov'")
  })

  it('filterNames ignores quoted expressions and labels', () => {
    expect(filterNames("[0:v]scale=2:2,drawbox=enable='between(t,1,2)'[a];[a][1:v]overlay=x=1[v]")).toEqual(['scale', 'drawbox', 'overlay'])
  })

  it('zoom crop keeps the output aspect exactly; captions fit the frame', () => {
    expect(zoomCrop({ width: 1920, height: 1080 }, 1.2)).toEqual({ width: 1600, height: 900 })
    const z = zoomCrop({ width: 1080, height: 1920 }, 1.15)
    expect(z.width / z.height).toBeCloseTo(1080 / 1920, 10)
    expect(fitText({ width: 600, height: 100 }, 80, { width: 1920, height: 1080 })).toEqual({ width: 480, height: 80 })
    expect(fitText({ width: 4000, height: 100 }, 80, { width: 1080, height: 1920 }).width).toBeLessThanOrEqual(972)
  })
})

describe('beat sync', () => {
  const items: MontageItem[] = [
    { id: 'a', source: A, start: 10, end: 14 },
    { id: 'b', source: A, start: 20, end: 25, overlay: { text: 'ACE', at: 24.9, durationSec: 1.5 } },
    { id: 'c', source: A, start: 30, end: 31.2 }
  ]

  it('snaps ends to the nearest beat within ±0.3 s, extending or shrinking post-roll only', () => {
    const out = snapItemsToBeats(items, [4.2, 8.95, 10.1], 0, () => 100)
    expect(out[0]).toMatchObject({ start: 10, end: 14.2 })
    // b ends at 4.2 + 5 = 9.2; the beat at 8.95 would cut before its overlay (24.9) → left alone.
    expect(out[1].end).toBe(25)
    // c ends at 10.4; the beat at 10.1 would leave 0.9 s → left alone.
    expect(out[2]).toMatchObject({ start: 30, end: 31.2 })
    // With the intro offset the beats line up differently: a's end moves to 1 + 4 → beat 5.1 (extend 0.1).
    expect(snapItemsToBeats([items[0]], [5.1], 1, () => 100)[0].end).toBeCloseTo(14.1, 10)
  })

  it('never extends past the source or shrinks below 1 s', () => {
    expect(snapItemsToBeats([items[0]], [4.25], 0, () => 14.1)[0].end).toBe(14)
    expect(snapItemsToBeats([items[0]], [4.25], 0, () => null)[0].end).toBe(14)
    expect(snapItemsToBeats([{ id: 'x', source: A, start: 0, end: 1.1 }], [0.85], 0, () => 100)[0].end).toBe(1.1)
    expect(snapItemsToBeats([items[0]], [3.8], 0, () => null)[0].end).toBeCloseTo(13.8, 10)
  })
})
