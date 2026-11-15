// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { LibraryEntry } from '../../main/library'
import type { CacheDoc, EngineEvent } from '../../shared/types'
import { planAutoEdit } from '../../shared/autoEditPlan'
import { createProject, type Project } from '../editor/project'
import { LibraryScreen } from '../library/LibraryScreen'
import { i18n } from '../i18n'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { mountStudio, STUDIO_VIDEO } from '../../../test/studioHarness'
import { buttonByText, cleanupMounted, click, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'
import { formatFindings as formatAxeFindings, runAxe } from '../../../test/axe'

vi.mock('../../shared/autoEditPlan', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../shared/autoEditPlan')>()
  return { ...m, planAutoEdit: vi.fn(m.planAutoEdit) }
})

const t = i18n.autoEdit
let restore: (() => void) | undefined

// axe checks document-level attributes; the app sets them in index.html.
beforeAll(() => {
  document.title = 'Valorant Editor'
  document.documentElement.lang = 'en'
  // jsdom has no Path2D; the timeline draws kill markers with it (the canvas itself is a no-op stub).
  const g = globalThis as { Path2D?: unknown }
  if (!g.Path2D) g.Path2D = class { moveTo(): void {} lineTo(): void {} closePath(): void {} arc(): void {} rect(): void {} }
})

afterEach(() => {
  cleanupMounted()
  restore?.()
  restore = undefined
  vi.restoreAllMocks()
  vi.mocked(planAutoEdit).mockClear()
})

function kill(id: string, at: number): EngineEvent {
  return { id, t: at, type: 'kill', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto' }
}

function doc(path: string, events: EngineEvent[]): CacheDoc {
  return {
    version: 1,
    video: { path, size: 0, mtime: 0, duration: 600, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
    analysis: { status: 'done', progress_t: 600, engine_version: 'x', templates_version: 'x', h_scale: 1 },
    events,
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: ''
  }
}

const NOW = new Date(2026, 10, 14, 20, 0).getTime()

function entry(name: string, over: Partial<LibraryEntry> = {}): LibraryEntry {
  return { path: `D:/v/${name}.mp4`, addedAt: NOW, favorite: false, status: 'done', progress: 1, durationSec: 600, codec: 'h264', source: 'recording', ...over }
}

/** projects.save stores, projects.load reads back (plus the startup project), so openProject really opens what was saved. */
function projectStore(startup: Project) {
  const saved = new Map<string, unknown>()
  return {
    saved,
    projects: {
      save: vi.fn(async (p: { id: string }) => {
        saved.set(p.id, p)
        return true
      }),
      load: vi.fn(async (id: string) => (id === 'p_test' ? startup : (saved.get(id) ?? null))),
      markOpened: vi.fn(async () => true)
    }
  }
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.ae-dlg')
}

function createButton(): HTMLButtonElement {
  return buttonByText(dialog()!, t.create) as HTMLButtonElement
}

function estimateText(): string {
  return dialog()!.querySelector('.ae-estimate')?.textContent ?? ''
}

async function openFromStudio(opts: { entries?: LibraryEntry[]; docs?: Record<string, CacheDoc> } = {}) {
  const store = projectStore({ ...createProject('測試專案'), items: [] })
  const kills = [kill('k1', 100), kill('k2', 102), kill('k3', 400)]
  const s = await mountStudio({
    doc: (d) => ({ ...d, events: kills, clips: [] }),
    clips: [],
    api: {
      entries: opts.entries,
      overrides: {
        projects: store.projects,
        cache: { loadByVideo: vi.fn(async (p: string) => opts.docs?.[p] ?? null) }
      }
    }
  })
  restore = s.restore
  const trigger = s.m.container.querySelector<HTMLButtonElement>('[data-autoedit="toggle"]')!
  expect(trigger).not.toBeNull()
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
  focusEl(trigger)
  click(trigger)
  await flush(10)
  return { ...s, store, trigger }
}

describe('Auto edit from Studio', () => {
  test('opens a labelled modal next to Auto clip with the open video checked', async () => {
    const { trigger } = await openFromStudio()
    const d = dialog()!
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe(t.title)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const checked = Array.from(d.querySelectorAll<HTMLInputElement>('.ae-sources input[type="checkbox"]')).filter((c) => c.checked)
    expect(checked).toHaveLength(1)
    expect(checked[0].closest('label')?.querySelector('.ae-source-name')?.getAttribute('title')).toBe(STUDIO_VIDEO)
  })

  test('Browse picks a music file through the native dialog; cancelling keeps the current path', async () => {
    await openFromStudio()
    const pick = vi.fn(async (): Promise<string | null> => 'C:\\Users\\Jane Doe\\Music\\Hype – ä.mp3')
    window.api.autoEdit.selectMusic = pick
    const input = (): HTMLInputElement => dialog()!.querySelector<HTMLInputElement>('.ae-section input.ae-input')!
    click(buttonByText(dialog()!, t.musicBrowse)!)
    await flush(5)
    expect(pick).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('C:\\Users\\Jane Doe\\Music\\Hype – ä.mp3')
    pick.mockResolvedValueOnce(null)
    click(buttonByText(dialog()!, t.musicBrowse)!)
    await flush(5)
    expect(input().value).toBe('C:\\Users\\Jane Doe\\Music\\Hype – ä.mp3')
  })

  test('keyboard: focus starts inside, Tab stays inside, Esc closes and returns focus to the button', async () => {
    const { trigger } = await openFromStudio()
    const d = dialog()!
    expect(d.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 12; i++) {
      press(document.activeElement as Element, 'Tab', { shiftKey: i % 3 === 2 })
      expect(d.contains(document.activeElement), `Tab #${i}`).toBe(true)
    }
    press(document.activeElement as Element, 'Escape')
    await flush()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  test('live estimate calls planAutoEdit with the dialog options, then Create saves a v2 project and opens it', async () => {
    const { store, fake } = await openFromStudio()
    await flush(260)
    const call = vi.mocked(planAutoEdit).mock.calls.at(-1)!
    expect(call[0].map((s) => s.path)).toEqual([STUDIO_VIDEO])
    expect(call[1]).toMatchObject({ sources: [STUDIO_VIDEO], targetSec: 60, style: 'clean', presetId: 'source', includeDeaths: false, musicPath: null })
    expect(estimateText()).toMatch(/2/) // two windows (k1+k2 merged, k3)
    expect(createButton().disabled).toBe(false)

    click(createButton())
    await flush(20)
    await flush(20)
    const saves = store.projects.save.mock.calls.map((c) => c[0] as unknown as Project & { id: string }).filter((p) => p.version === 2 && p.style !== undefined)
    expect(saves).toHaveLength(1)
    const created = saves[0]
    expect(created.items.length).toBe(2)
    expect(created.items[0].id).toBe(`${created.id}_ae0`)
    expect(created.items.every((it) => it.source === STUDIO_VIDEO)).toBe(true)
    expect(store.projects.load).toHaveBeenCalledWith(created.id)
    expect(dialog()).toBeNull()
    // The project track now shows the new project.
    expect(document.querySelector(`[data-item-id="${created.id}_ae0"]`)).not.toBeNull()
    void fake
  })

  test('Shorts forces the 9:16 preset and says why', async () => {
    await openFromStudio()
    const d = dialog()!
    click(d.querySelector<HTMLInputElement>('[data-style="shorts"] input')!)
    await flush(260)
    const presets = Array.from(d.querySelectorAll<HTMLInputElement>(`input[type="radio"][name$="-preset"]`))
    expect(presets).toHaveLength(6)
    const checked = presets.filter((p) => p.checked)
    expect(checked).toHaveLength(1)
    expect(checked[0].closest('label')?.textContent).toBe(t.presets.shorts)
    expect(presets.filter((p) => p.disabled)).toHaveLength(5)
    expect(d.textContent).toContain(t.presetForced.replace('{style}', t.styles.shorts))
    expect(vi.mocked(planAutoEdit).mock.calls.at(-1)![1]).toMatchObject({ style: 'shorts' })
  })

  test('custom target: out-of-range input blocks Create and explains the range', async () => {
    await openFromStudio()
    const d = dialog()!
    const custom = Array.from(d.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.closest('label')?.textContent === t.targetCustom)!
    click(custom)
    const input = d.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!
    expect(input).not.toBeNull()
    setInput(input, '5')
    await flush(260)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(createButton().disabled).toBe(true)
    setInput(input, '1:30')
    await flush(260)
    expect(createButton().disabled).toBe(false)
    expect(vi.mocked(planAutoEdit).mock.calls.at(-1)![1].targetSec).toBe(90)
  })

  test('other analyzed videos can be added; their analysis is loaded from the cache', async () => {
    const other = entry('Valorant_2026-11-14_19-00')
    const { m } = await openFromStudio({ entries: [other], docs: { [other.path]: doc(other.path, [kill('o1', 50)]) } })
    void m
    const d = dialog()!
    click(buttonByText(d, t.addOthers)!)
    const box = d.querySelector<HTMLInputElement>('.ae-others input[type="checkbox"]')!
    click(box)
    await flush(260)
    expect(vi.mocked(window.api.cache.loadByVideo)).toHaveBeenCalledWith(other.path)
    const call = vi.mocked(planAutoEdit).mock.calls.at(-1)!
    // Recording order: the fixture video has no library entry (recordedAt 0), so it comes first.
    expect(call[0].map((s) => s.path)).toEqual([STUDIO_VIDEO, other.path])
  })

  test('axe: no serious violations', async () => {
    await openFromStudio()
    const findings = await runAxe(document)
    expect(findings, formatAxeFindings(findings)).toEqual([])
  })
})

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mountLibrary(entries: LibraryEntry[], docs: Record<string, CacheDoc>) {
  installDomShims()
  const store = projectStore({ ...createProject('測試專案'), items: [] })
  const fake = createFakeApi({
    entries,
    settings: { lastProjectId: 'p_test' },
    overrides: { projects: store.projects, cache: { loadByVideo: vi.fn(async (p: string) => docs[p] ?? null) } }
  })
  restore = installFakeApi(fake)
  const onSelect = vi.fn()
  const m = mount(
    <Providers>
      <LibraryScreen onSelectVideo={onSelect} onOpenSettings={() => undefined} />
    </Providers>
  )
  await flush(20)
  return { m, fake, store, onSelect }
}

function selectCard(container: ParentNode, path: string): void {
  click(container.querySelector<HTMLElement>(`[data-vcard-path="${path}"] .vcard-select`)!)
}

function autoEditButton(container: ParentNode): HTMLButtonElement {
  return buttonByText(container.querySelector('.lib-selection-bar')!, i18n.library.selection.autoEdit)!
}

describe('Auto edit from a Library selection', () => {
  const a = entry('Valorant_2026-11-14_18-00')
  const b = entry('Valorant_2026-11-14_21-30')
  const pending = entry('Valorant_2026-11-14_22-00', { status: 'pending', progress: 0 })
  const docs = { [a.path]: doc(a.path, [kill('a1', 40)]), [b.path]: doc(b.path, [kill('b1', 70), kill('b2', 300)]) }

  test('enabled only for analyzed selections; opens with the selection; "All videos from this day" adds the rest', async () => {
    const { m } = await mountLibrary([a, b, pending], docs)
    selectCard(m.container, pending.path)
    expect(autoEditButton(m.container).disabled).toBe(true)
    selectCard(m.container, a.path)
    expect(autoEditButton(m.container).disabled).toBe(false)
    click(autoEditButton(m.container))
    await flush(260)
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(vi.mocked(planAutoEdit).mock.calls.at(-1)![0].map((s) => s.path)).toEqual([a.path])
    click(buttonByText(d, t.addSameDay)!)
    await flush(260)
    const names = Array.from(d.querySelectorAll('.ae-sources:not(.ae-others) .ae-source-name')).map((n) => n.getAttribute('title'))
    expect(names).toEqual([a.path, b.path]) // recording order; the unanalyzed video is not added
    expect(vi.mocked(planAutoEdit).mock.calls.at(-1)![0].map((s) => s.path)).toEqual([a.path, b.path])
  })

  test('Create saves the project, opens it and switches to Studio', async () => {
    const { m, store, onSelect } = await mountLibrary([a, b], docs)
    selectCard(m.container, b.path)
    selectCard(m.container, a.path)
    click(autoEditButton(m.container))
    await flush(260)
    click(createButton())
    await flush(20)
    await flush(20)
    const created = store.projects.save.mock.calls.map((c) => c[0] as unknown as Project & { id: string }).find((p) => p.version === 2 && p.style === 'clean')!
    expect(created.items.map((it) => it.source)).toEqual([a.path, b.path, b.path])
    expect(store.projects.load).toHaveBeenCalledWith(created.id)
    expect(onSelect).toHaveBeenCalledWith(a.path)
    expect(dialog()).toBeNull()
  })

  test('empty state: no kills found, Create disabled', async () => {
    const quiet = { [a.path]: doc(a.path, []) }
    const { m } = await mountLibrary([a], quiet)
    selectCard(m.container, a.path)
    click(autoEditButton(m.container))
    await flush(260)
    expect(estimateText()).toBe(t.emptyNoKills)
    expect(createButton().disabled).toBe(true)
  })

  test('axe: no serious violations', async () => {
    const { m } = await mountLibrary([a, b], docs)
    selectCard(m.container, a.path)
    click(autoEditButton(m.container))
    await flush(260)
    click(buttonByText(dialog()!, t.addOthers)!)
    const findings = await runAxe(document)
    expect(findings, formatAxeFindings(findings)).toEqual([])
  })
})
