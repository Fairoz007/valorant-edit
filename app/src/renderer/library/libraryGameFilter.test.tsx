// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, click, flush, installDomShims, mount } from '../../../test/dom'
import { i18n } from '../i18n'

const apex: LibraryEntry = {
  source: 'recording',
  path: 'D:/rec/apex.mp4',
  addedAt: Date.now(),
  favorite: false,
  status: 'done',
  progress: 1,
  game: 'apex'
}
const valorant: LibraryEntry = {
  source: 'external',
  path: 'D:/rec/valorant.mp4',
  addedAt: Date.now() - 1000,
  favorite: false,
  status: 'done',
  progress: 1,
  game: 'valorant'
}
/** Completed before multi-game support: belongs to Apex. */
const legacy: LibraryEntry = {
  path: 'D:/rec/legacy.mp4',
  addedAt: Date.now() - 2000,
  favorite: false,
  status: 'done',
  progress: 1
}

let fake: FakeApi
let restore: () => void

beforeEach(async () => {
  installDomShims()
  fake = createFakeApi({ entries: [apex, valorant, legacy] })
  restore = installFakeApi(fake)
})

afterEach(() => {
  cleanupMounted()
  restore()
  vi.restoreAllMocks()
})

async function setup(): Promise<HTMLElement> {
  const { container } = mount(
    <Providers>
      <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
    </Providers>
  )
  await flush()
  return container
}

function cardPaths(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.vcard')).map((card) => card.dataset.vcardPath ?? '')
}

describe('library filters (VALORANT-only)', () => {
  test('there is no game filter or per-card game tag when only VALORANT is supported', async () => {
    const container = await setup()
    expect(container.querySelector(`[role="group"][aria-label="${i18n.library.gameFilter}"]`)).toBeNull()
    expect(container.querySelector('.vcard-game')).toBeNull()
    expect(cardPaths(container)).toHaveLength(3)
  })

  test('source chips count and filter recordings and imports', async () => {
    const container = await setup()
    const chip = (label: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.lib-chip')).find((button) =>
        (button.textContent ?? '').startsWith(label)
      )!
    const recording = chip(i18n.library.chips.recording)
    const external = chip(i18n.library.chips.external)

    expect(recording.querySelector('.n')?.textContent).toBe('1')
    expect(external.querySelector('.n')?.textContent).toBe('2')
    click(recording)
    expect(recording.getAttribute('aria-pressed')).toBe('true')
    expect(cardPaths(container)).toEqual([apex.path])
    click(external)
    expect(recording.getAttribute('aria-pressed')).toBe('false')
    expect(external.getAttribute('aria-pressed')).toBe('true')
    expect(cardPaths(container)).toEqual([valorant.path, legacy.path])
    click(chip(i18n.library.chips.all))
    expect(cardPaths(container)).toHaveLength(3)
    expect(external.getAttribute('aria-pressed')).toBe('false')
  })
})
