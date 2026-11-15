import { describe, expect, test } from 'vitest'
import { onVideoError, planSeek, routeTimeUpdate } from './seekPlan'
import { mediaUrl } from '../../shared/media-url'

describe('video src URLs', () => {
  // Was fileUrl() → 'file://C:/v/…' (non-canonical, and blocked from the http://localhost dev page); see shared/media-url.test.ts.
  test('percent-encodes characters that would break the URL (#, ?, %, space) (Minor 1)', () => {
    expect(mediaUrl('C:\\v\\a#1 100%?.mp4')).toBe('aditor-media://local/C:/v/a%231%20100%25%3F.mp4')
  })
  test('converts backslashes', () => expect(mediaUrl('C:\\v\\a.mp4')).toBe('aditor-media://local/C:/v/a.mp4'))
})

describe('planSeek', () => {
  const a = 'aditor-media://local/C:/v/a.mp4'
  const b = 'aditor-media://local/C:/v/b.mp4'
  test('applies now only when the wanted file is already loaded', () => {
    expect(planSeek({ loadedSrc: a, wantedSrc: a })).toBe('now')
  })
  test('defers when the video element still holds another file (never set currentTime on a video about to be replaced)', () => {
    expect(planSeek({ loadedSrc: b, wantedSrc: a })).toBe('defer')
  })
  test('defers before anything has loaded', () => {
    expect(planSeek({ loadedSrc: null, wantedSrc: a })).toBe('defer')
  })
})

describe('routeTimeUpdate', () => {
  const src = 'aditor-media://local/C:/v/a.mp4'
  const foreign = 'aditor-media://local/C:/v/b.mp4'
  test('source mode: updates the source time when the source is loaded', () => {
    expect(routeTimeUpdate({ previewSrc: null, sourceSrc: src, loadedSrc: src, pending: false })).toBe('source')
  })
  test('source mode: ignores stray time updates of a foreign/old video or while a seek is pending', () => {
    expect(routeTimeUpdate({ previewSrc: null, sourceSrc: src, loadedSrc: foreign, pending: false })).toBe('ignore')
    expect(routeTimeUpdate({ previewSrc: null, sourceSrc: src, loadedSrc: src, pending: true })).toBe('ignore')
  })
  test('project mode: loaded source time drives both project progress and source playhead', () => {
    expect(routeTimeUpdate({ previewSrc: src, sourceSrc: src, loadedSrc: src, pending: false })).toBe('preview')
  })
  test('project mode: ignores updates until the previewed file is loaded', () => {
    expect(routeTimeUpdate({ previewSrc: foreign, sourceSrc: src, loadedSrc: src, pending: false })).toBe('ignore')
  })
})

describe('onVideoError', () => {
  const a = 'aditor-media://local/C:/v/a.mp4'
  test('clears the pending seek, the loaded marker and the playing flag', () => {
    const r = onVideoError({ loadedSrc: a, pending: { t: 12, play: true } })
    expect(r).toEqual({ loadedSrc: null, pending: null, playing: false })
  })
  test('afterwards time updates are ignored and seeks defer (no stale pending applied to the next file)', () => {
    const r = onVideoError({ loadedSrc: a, pending: { t: 3, play: false } })
    expect(routeTimeUpdate({ previewSrc: null, sourceSrc: a, loadedSrc: r.loadedSrc, pending: r.pending !== null })).toBe('ignore')
    expect(planSeek({ loadedSrc: r.loadedSrc, wantedSrc: a })).toBe('defer')
  })
})
