import { describe, expect, it } from 'vitest'
import { BLUR_DOWNSCALE, clampOffset, computeReframe, reframeFilter, type ReframeGeometry, type Size } from './reframe'
import type { ReframeMode } from './exportFormat'

const V = { width: 1080, height: 1920, fps: 60 }
const SQ = { width: 1080, height: 1080, fps: 60 }
const HD = { width: 1920, height: 1080, fps: 60 }

const isEven = (v: number): boolean => v % 2 === 0

function assertSane(g: ReframeGeometry, src: Size): void {
  const vals = [g.out.width, g.out.height, g.crop.x, g.crop.y, g.crop.width, g.crop.height, g.scaled.width, g.scaled.height, g.pos.x, g.pos.y]
  for (const v of vals) {
    expect(Number.isInteger(v)).toBe(true)
    expect(isEven(v)).toBe(true)
    expect(v).toBeGreaterThanOrEqual(0)
  }
  // Crop rectangle inside the (real) source.
  expect(g.crop.x + g.crop.width).toBeLessThanOrEqual(src.width)
  expect(g.crop.y + g.crop.height).toBeLessThanOrEqual(src.height)
  // Foreground inside the output.
  expect(g.pos.x + g.scaled.width).toBeLessThanOrEqual(g.out.width)
  expect(g.pos.y + g.scaled.height).toBeLessThanOrEqual(g.out.height)
  if (g.background) {
    expect(g.background.crop.x + g.background.crop.width).toBeLessThanOrEqual(g.background.scaled.width)
    expect(g.background.crop.y + g.background.crop.height).toBeLessThanOrEqual(g.background.scaled.height)
    expect(g.background.scaled.width).toBeGreaterThanOrEqual(g.out.width)
    expect(g.background.scaled.height).toBeGreaterThanOrEqual(g.out.height)
  }
}

describe('computeReframe: crop', () => {
  it('1920×1080 → 1080×1920 crops a 608×1080 column positioned by the offset', () => {
    const src = { width: 1920, height: 1080 }
    const left = computeReframe(src, V, 'crop', -1)
    const mid = computeReframe(src, V, 'crop', 0)
    const right = computeReframe(src, V, 'crop', 1)
    for (const g of [left, mid, right]) {
      expect(g.kind).toBe('crop')
      expect(g.crop.width).toBe(608)
      expect(g.crop.height).toBe(1080)
      expect(g.crop.y).toBe(0)
      expect(g.scaled).toEqual({ width: 1080, height: 1920 })
      assertSane(g, src)
    }
    expect(left.crop.x).toBe(0)
    expect(mid.crop.x).toBe(656)
    expect(right.crop.x).toBe(1312)
    expect(right.crop.x + right.crop.width).toBe(1920)
  })

  it('1920×1080 → 1080×1080 crops the centred 1080 square', () => {
    const g = computeReframe({ width: 1920, height: 1080 }, SQ, 'crop', 0)
    expect(g.crop).toEqual({ x: 420, y: 0, width: 1080, height: 1080 })
  })

  it('handles 4:3, 16:10, 21:9 and 1366×768 sources for 9:16 and 1:1', () => {
    const cases: Array<[Size, number, number]> = [
      // source, expected 9:16 crop width, expected 1:1 crop width (full height kept)
      [{ width: 1440, height: 1080 }, 608, 1080],
      [{ width: 1920, height: 1200 }, 676, 1200],
      [{ width: 2560, height: 1080 }, 608, 1080],
      [{ width: 1366, height: 768 }, 432, 768]
    ]
    for (const [src, w916, w11] of cases) {
      for (const off of [-1, -0.3, 0, 0.5, 1]) {
        const v = computeReframe(src, V, 'crop', off)
        const s = computeReframe(src, SQ, 'crop', off)
        expect(v.crop.width).toBe(w916)
        expect(v.crop.height).toBe(src.height)
        expect(s.crop.width).toBe(w11)
        expect(s.crop.height).toBe(src.height)
        assertSane(v, src)
        assertSane(s, src)
      }
      expect(computeReframe(src, V, 'crop', 1).crop.x + w916).toBe(src.width)
      expect(computeReframe(src, V, 'crop', -1).crop.x).toBe(0)
    }
  })

  it('crops vertically (offset moves top→bottom) when the source is taller than the frame', () => {
    const src = { width: 1080, height: 1920 }
    const top = computeReframe(src, HD, 'crop', -1)
    const bottom = computeReframe(src, HD, 'crop', 1)
    expect(top.crop).toEqual({ x: 0, y: 0, width: 1080, height: 608 })
    expect(bottom.crop).toEqual({ x: 0, y: 1312, width: 1080, height: 608 })
  })

  it('clamps out-of-range and non-finite offsets', () => {
    const src = { width: 1920, height: 1080 }
    expect(computeReframe(src, V, 'crop', 5).crop.x).toBe(1312)
    expect(computeReframe(src, V, 'crop', -5).crop.x).toBe(0)
    expect(computeReframe(src, V, 'crop', Number.NaN).crop.x).toBe(656)
    expect(clampOffset(Infinity)).toBe(0)
  })

  it('keeps odd sources even and inside the frame', () => {
    const src = { width: 1365, height: 767 }
    for (const mode of ['crop', 'blur', 'bars'] as ReframeMode[]) {
      for (const out of [V, SQ, HD]) {
        const g = computeReframe(src, out, mode, 1)
        assertSane(g, src)
      }
    }
  })
})

describe('computeReframe: matching aspect', () => {
  it('scales only, without cropping, when the source already matches', () => {
    for (const mode of ['crop', 'blur', 'bars'] as ReframeMode[]) {
      const g = computeReframe({ width: 3840, height: 2160 }, HD, mode, 1)
      expect(g.kind).toBe('scale')
      expect(g.crop).toEqual({ x: 0, y: 0, width: 3840, height: 2160 })
      expect(g.scaled).toEqual({ width: 1920, height: 1080 })
      expect(g.pos).toEqual({ x: 0, y: 0 })
    }
    // 1366×768 is within rounding of 16:9.
    expect(computeReframe({ width: 1366, height: 768 }, HD, 'crop', 0).kind).toBe('scale')
    expect(computeReframe({ width: 1366, height: 768 }, HD, 'bars', 0).kind).toBe('scale')
  })

  it('falls back to 1920×1080 for an unknown source size', () => {
    const g = computeReframe({ width: 0, height: 0 }, V, 'crop', 0)
    expect(g.crop).toEqual({ x: 656, y: 0, width: 608, height: 1080 })
  })
})

describe('computeReframe: bars and blur', () => {
  it('bars: 1920×1080 into 1080×1920 is a 1080×608 band centred vertically', () => {
    const g = computeReframe({ width: 1920, height: 1080 }, V, 'bars', 0)
    expect(g.kind).toBe('bars')
    expect(g.scaled).toEqual({ width: 1080, height: 608 })
    expect(g.pos).toEqual({ x: 0, y: 656 })
    expect(g.background).toBeNull()
  })

  it('bars: 21:9 into 16:9 letterboxes', () => {
    const g = computeReframe({ width: 2560, height: 1080 }, HD, 'bars', 0)
    expect(g.scaled).toEqual({ width: 1920, height: 810 })
    expect(g.pos).toEqual({ x: 0, y: 134 })
  })

  it('blur: foreground fits, background fills and is cut to the output', () => {
    const src = { width: 1920, height: 1080 }
    const g = computeReframe(src, V, 'blur', 0.7)
    expect(g.kind).toBe('blur')
    expect(g.scaled).toEqual({ width: 1080, height: 608 })
    expect(g.pos).toEqual({ x: 0, y: 656 })
    expect(g.background).toEqual({ scaled: { width: 3414, height: 1920 }, crop: { x: 1166, y: 0, width: 1080, height: 1920 } })
    assertSane(g, src)
  })
})

describe('reframeFilter', () => {
  it('crop: crop then scale, ending with fps and yuv420p', () => {
    const src = { width: 1920, height: 1080 }
    const f = reframeFilter(computeReframe(src, V, 'crop', 1), src)
    expect(f).toBe('crop=608:1080:1312:0,scale=1080:1920:flags=lanczos,fps=60,format=yuv420p')
  })

  it('scale: no crop for a matching even source', () => {
    const src = { width: 3840, height: 2160 }
    expect(reframeFilter(computeReframe(src, { ...HD, fps: 30 }, 'crop', 0), src)).toBe('scale=1920:1080:flags=lanczos,fps=30,format=yuv420p')
  })

  it('odd sources drop the last row/column first', () => {
    const src = { width: 1921, height: 1081 }
    expect(reframeFilter(computeReframe(src, HD, 'bars', 0), src)).toBe('crop=1920:1080:0:0,scale=1920:1080:flags=lanczos,fps=60,format=yuv420p')
  })

  it('bars: scale + pad', () => {
    const src = { width: 1920, height: 1080 }
    expect(reframeFilter(computeReframe(src, V, 'bars', 0), src)).toBe(
      'scale=1080:608:flags=lanczos,pad=1080:1920:0:656:color=black,fps=60,format=yuv420p'
    )
  })

  it('blur: split, scaled-down background, overlay — only filters from the bundled build', () => {
    const src = { width: 1920, height: 1080 }
    const f = reframeFilter(computeReframe(src, V, 'blur', 0), src)
    const bw = Math.round(1080 / BLUR_DOWNSCALE / 2) * 2
    const bh = Math.round(1920 / BLUR_DOWNSCALE / 2) * 2
    expect(f).toBe(
      'split=2[rf_bg][rf_fg];' +
        `[rf_bg]scale=3414:1920:flags=fast_bilinear,crop=1080:1920:1166:0,scale=${bw}:${bh}:flags=area,scale=1080:1920:flags=bilinear[rf_bgb];` +
        '[rf_fg]scale=1080:608:flags=lanczos[rf_fgs];' +
        '[rf_bgb][rf_fgs]overlay=0:656,fps=60,format=yuv420p'
    )
    const filters = f.split(/[;,]/).map((part) => part.replace(/^(\[[^\]]+\])+/, '').split('=')[0])
    const allowed = new Set(['crop', 'scale', 'pad', 'split', 'overlay', 'fps', 'format'])
    for (const name of filters) expect(allowed.has(name)).toBe(true)
  })
})
