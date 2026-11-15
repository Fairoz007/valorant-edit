import { describe, expect, test } from 'vitest'
import { proxyBusyNotice, studioNotice } from './notices'
import { catalogFor, i18n, LOCALES } from '../i18n'

const okPlayability = { supported: true, smooth: true, powerEfficient: true }
const weakPlayability = { supported: false, smooth: false, powerEfficient: false }

describe('studioNotice', () => {
  test('error → engine-crash notice with resume action', () => {
    const n = studioNotice({ analysis: 'error', playability: okPlayability, proxyState: 'none' })
    expect(n).not.toBeNull()
    expect(n!.kind).toBe('error')
    expect(n!.title).toContain('分析引擎異常結束')
    expect(n!.actions).toContain('resume')
  })

  test('non-playable/no hw decode → proxy suggestion; playable → null', () => {
    const n = studioNotice({ analysis: 'done', playability: weakPlayability, proxyState: 'none' })
    expect(n).not.toBeNull()
    expect(n!.kind).toBe('warn')
    expect(n!.actions).toContain('generateProxy')
    expect(n!.actions).toContain('later')

    expect(studioNotice({ analysis: 'done', playability: okPlayability, proxyState: 'none' })).toBeNull()
  })

  test('no proxy suggestion when a proxy already exists or is generating', () => {
    expect(studioNotice({ analysis: 'done', playability: weakPlayability, proxyState: 'available' })).toBeNull()
    expect(studioNotice({ analysis: 'done', playability: weakPlayability, proxyState: 'generating' })).toBeNull()
  })

  test('error outranks proxy suggestion', () => {
    const n = studioNotice({ analysis: 'error', playability: weakPlayability, proxyState: 'none' })
    expect(n!.kind).toBe('error')
  })
})

describe('studioNotice (language-independent)', () => {
  test('Detection no longer depends on game language: no language or spectator-support notice; normal case returns null', () => {
    expect(studioNotice({ analysis: 'done', playability: okPlayability, proxyState: 'none' })).toBeNull()
  })
})

describe('proxyBusyNotice', () => {
  test('shows the percentage when progress is known, generic text otherwise', () => {
    expect(proxyBusyNotice(0.42).title).toBe('產生中… 42%')
    expect(proxyBusyNotice(null).title).toBe('正在產生代理檔…')
    expect(proxyBusyNotice(1.7).title).toBe('產生中… 100%')
  })
})

describe('error code vs message', () => {
  test('notice text carries the code only; unknown when missing', () => {
    const n = studioNotice({ analysis: 'error', playability: okPlayability, proxyState: 'none', errorCode: 3 })
    expect(n!.text).toContain('代碼 3')
    const m = studioNotice({ analysis: 'error', playability: okPlayability, proxyState: 'none' })
    expect(m!.text).toContain('unknown')
  })
})

describe('video load failure notices (I13): missing vs undecodable', () => {
  const base = { analysis: 'done' as const, playability: { supported: true, smooth: true, powerEfficient: true }, proxyState: 'none' as const }
  const t = i18n.studio.notices
  test('file not on disk → "not found" notice with relink and back', () => {
    const n = studioNotice({ ...base, videoFault: 'missing' })!
    expect(n.id).toBe('video-missing')
    expect(n.kind).toBe('error')
    expect(n.title).toBe(t.videoNotFoundTitle)
    expect(n.text).toBe(t.videoNotFoundText)
    expect(n.actions).toEqual(['relink', 'back'])
  })
  test('file exists but cannot be decoded → suggests generating a proxy instead of relinking', () => {
    const n = studioNotice({ ...base, videoFault: 'undecodable' })!
    expect(n.id).toBe('video-undecodable')
    expect(n.title).toBe(t.videoUndecodableTitle)
    expect(n.text).toBe(t.videoUndecodableText)
    expect(n.actions).toEqual(['generateProxy', 'back'])
    expect(n.actions).not.toContain('relink')
  })
  test('undecodable while a proxy is generating → no error notice (the progress notice shows instead)', () => {
    expect(studioNotice({ ...base, videoFault: 'undecodable', proxyState: 'generating' })).toBeNull()
  })
  test('undecodable even with a proxy, or existence unknown → the generic notice', () => {
    for (const n of [studioNotice({ ...base, videoFault: 'undecodable', proxyState: 'available' })!, studioNotice({ ...base, videoFault: 'unknown' })!]) {
      expect(n.id).toBe('video-unplayable')
      expect(n.title).toBe(t.videoMissingTitle)
      expect(n.actions).toEqual(['relink', 'back'])
    }
  })
  test('every locale has distinct, non-empty texts for both cases', () => {
    for (const locale of LOCALES) {
      const c = catalogFor(locale).i18n.studio.notices
      for (const k of ['videoNotFoundTitle', 'videoNotFoundText', 'videoUndecodableTitle', 'videoUndecodableText'] as const) expect(c[k].trim()).not.toBe('')
      expect(c.videoNotFoundTitle).not.toBe(c.videoUndecodableTitle)
      expect(c.videoNotFoundText).not.toBe(c.videoMissingText)
    }
  })
  test('engine errors still win; no fault → no video notice', () => {
    expect(studioNotice({ ...base, analysis: 'error', videoFault: 'missing' })!.id).toBe('engine-error')
    expect(studioNotice({ ...base, videoFault: null })).toBeNull()
  })
})
