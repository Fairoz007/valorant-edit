// @vitest-environment jsdom
// I13: when the source video cannot play, tell a missing file (Relink/Back to Library) apart from an undecodable one
// (Generate proxy/Back), by asking main whether the file exists; the buttons must work.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, flush } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})
const N = i18n.studio.notices
const mountWithFile = (exists: boolean | 'throws', onBack = vi.fn(), generate = vi.fn(async () => null)) =>
  mountStudio({
    onBack,
    api: {
      overrides: {
        library: { fileExists: vi.fn(async () => { if (exists === 'throws') throw new Error('ipc down'); return exists }) },
        proxy: { generate }
      }
    }
  })
const failVideo = async (): Promise<Element> => {
  document.querySelector('video')!.dispatchEvent(new Event('error'))
  await flush(10)
  return document.querySelector('.notice')!
}

describe('video load failure notice (I13)', () => {
  test('missing file: "not found" notice; Back to Library calls onBack', async () => {
    const onBack = vi.fn()
    s = await mountWithFile(false, onBack)
    expect(document.querySelector('.notice')?.textContent ?? '').not.toContain(N.videoNotFoundTitle)
    const bar = await failVideo()
    expect(bar.textContent).toContain(N.videoNotFoundTitle)
    expect(bar.textContent).toContain(N.videoNotFoundText)
    expect(s.fake.api.library.fileExists).toHaveBeenCalled()
    click(buttonByText(bar, N.back)!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('missing file: Relink File returns to the library with an explanatory toast', async () => {
    const onBack = vi.fn()
    s = await mountWithFile(false, onBack)
    const bar = await failVideo()
    click(buttonByText(bar, N.relink)!)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.toast')?.textContent).toContain(i18n.studio.toast.relinkHint)
  })

  test('file exists but cannot be decoded: suggests a proxy (no relink), and the button starts proxy generation', async () => {
    const generate = vi.fn(async () => null)
    s = await mountWithFile(true, vi.fn(), generate)
    const bar = await failVideo()
    expect(bar.textContent).toContain(N.videoUndecodableTitle)
    expect(buttonByText(bar, N.relink)).toBeFalsy()
    click(buttonByText(bar, N.proxyGenerate)!)
    await flush(5)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  test('existence check fails: falls back to the generic "cannot be played" notice', async () => {
    s = await mountWithFile('throws')
    const bar = await failVideo()
    expect(bar.textContent).toContain(N.videoMissingTitle)
    expect(buttonByText(bar, N.relink)).toBeTruthy()
  })
})
