// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { createProject } from '../editor/project'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { buttonByText, cleanupMounted, click, flush, installDomShims, mount } from '../../../test/dom'
import { i18n } from '../i18n'

const t = i18n.library
let restore: (() => void) | undefined
afterEach(() => {
  cleanupMounted()
  restore?.()
  vi.restoreAllMocks()
})

const NOW = Date.now()
const montage: LibraryEntry = {
  path: 'D:/v/Valorant_2026-11-14_20-00_montage.mp4',
  source: 'montage',
  montage: { sourcePath: 'D:/v/Valorant_2026-11-14_20-00.mp4', projectId: 'p_montage', jobId: 'job1' },
  status: 'pending',
  progress: 0,
  favorite: false,
  addedAt: NOW
}
const imported: LibraryEntry = { path: 'D:/v/imported.mp4', source: 'external', status: 'done', progress: 1, favorite: false, addedAt: NOW - 1000 }

async function setup(entries: LibraryEntry[]) {
  installDomShims()
  const project = { ...createProject('Montage'), items: [{ id: 'i1', source: montage.montage!.sourcePath, start: 1, end: 5 }] }
  const load = vi.fn(async (id: string) => (id === 'p_montage' ? project : null))
  const fake = createFakeApi({ entries, overrides: { projects: { load, markOpened: vi.fn(async () => true) } } })
  restore = installFakeApi(fake)
  const onSelect = vi.fn()
  const { container } = mount(<Providers><LibraryScreen onSelectVideo={onSelect} onOpenSettings={() => {}} /></Providers>)
  await flush()
  return { fake, container, onSelect, load }
}

function card(container: ParentNode, path: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-vcard-path="${path}"]`)!
}

function clickRemove(el: ParentNode): void {
  act(() => el.querySelector<HTMLButtonElement>('.vcard-more')!.click())
  const item = Array.from(el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent === t.card.remove)!
  act(() => item.click())
}

describe('Library: auto montage entries', () => {
  test('show a Montage badge (also in the card label) and are not tagged as imported', async () => {
    const { container } = await setup([montage, imported])
    const c = card(container, montage.path)
    expect(c.querySelector('.vcard-montage')?.textContent).toBe(t.card.montageTag)
    expect(c.querySelector('.vcard-imported')).toBeNull()
    expect(c.querySelector('.vcard-open')?.getAttribute('aria-label')).toContain(t.card.montageTag)
    expect(c.querySelector('.vcard-open')?.getAttribute('aria-disabled')).toBe('false')
    expect(card(container, imported.path).querySelector('.vcard-imported')).not.toBeNull()
  })

  test('clicking the card opens its project in Studio on the source recording', async () => {
    const { container, onSelect, load } = await setup([montage])
    click(card(container, montage.path).querySelector('.vcard-open')!)
    await flush(10)
    expect(load).toHaveBeenCalledWith('p_montage')
    expect(onSelect).toHaveBeenCalledWith(montage.montage!.sourcePath)
  })

  test('a project that cannot be opened shows a toast and stays in the library', async () => {
    const { container, onSelect, load } = await setup([{ ...montage, montage: { ...montage.montage!, projectId: 'p_gone' } }])
    click(card(container, montage.path).querySelector('.vcard-open')!)
    await flush(10)
    expect(load).toHaveBeenCalledWith('p_gone')
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(t.card.montageOpenFailed)
  })

  test('removing a montage asks once and removes only its entry (no imported-source question)', async () => {
    const { container, fake } = await setup([montage])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    clickRemove(card(container, montage.path))
    await flush()
    expect(confirm).toHaveBeenCalledWith(t.card.montageRemoveConfirm.replace('{name}', 'Valorant_2026-11-14_20-00_montage.mp4'))
    expect(container.querySelector('.lib-dlg')).toBeNull()
    expect(fake.api.library.remove).toHaveBeenCalledTimes(1)
    expect(fake.api.library.remove.mock.calls[0]).toEqual([montage.path])
  })

  test('bulk delete: montages never get their file deleted through the imported-source choice', async () => {
    const { container, fake } = await setup([montage, imported])
    click(card(container, montage.path).querySelector('.vcard-select')!)
    click(card(container, imported.path).querySelector('.vcard-select')!)
    click(buttonByText(container.querySelector('.lib-selection-bar')!, t.selection.deleteItems)!)
    await flush()
    const dlg = container.querySelector('.lib-dlg')!
    expect(dlg.textContent).toContain(t.selection.deleteChoiceMessage.replace('{n}', '2').replace('{m}', '1'))
    click(buttonByText(dlg, t.selection.deleteSources)!)
    await flush()
    expect(fake.api.library.removeMany.mock.calls).toEqual([[[imported.path], { deleteSource: true }], [[montage.path]]])
  })

  test('bulk delete of montages only: one confirmation, entries removed without options', async () => {
    const other = { ...montage, path: 'D:/v/second_montage.mp4' }
    const { container, fake } = await setup([montage, other])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    click(card(container, montage.path).querySelector('.vcard-select')!)
    click(card(container, other.path).querySelector('.vcard-select')!)
    click(buttonByText(container.querySelector('.lib-selection-bar')!, t.selection.deleteItems)!)
    await flush()
    expect(confirm).toHaveBeenCalledWith(t.selection.montageRemoveManyConfirm.replace('{n}', '2'))
    expect(fake.api.library.removeMany).toHaveBeenCalledTimes(1)
    expect(fake.api.library.removeMany.mock.calls[0][1]).toBeUndefined()
  })

  test('montages are not offered as Auto edit sources', async () => {
    const { container } = await setup([{ ...montage, status: 'done' }])
    click(card(container, montage.path).querySelector('.vcard-select')!)
    expect(buttonByText(container.querySelector('.lib-selection-bar')!, t.selection.autoEdit)!.disabled).toBe(true)
  })
})
