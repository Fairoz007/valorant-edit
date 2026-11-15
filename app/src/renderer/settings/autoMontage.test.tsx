// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'
import { SettingsController, type SettingsApi } from './settingsController'
import { AUTO_MONTAGE_FIELDS } from './rows'
import { KEEP_SOURCE_ACK_KEY, defaultMontageDir } from './AutoMontageControl'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { DEFAULT_AUTO_MONTAGE, type AutoMontageSettings } from '../../shared/montage'
import type { RecordingSettings } from '../../shared/recording'
import { recordingI18n } from '../i18n'
import { cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'
import { formatFindings, runAxe } from '../../../test/axe'

const t = recordingI18n.autoMontage

function rig(recording: Partial<RecordingSettings> = {}, montage: Partial<AutoMontageSettings> = {}, extra: Partial<Settings> = {}) {
  let current: Settings = structuredClone(DEFAULT_SETTINGS)
  current = {
    ...current,
    ...extra,
    recording: { ...current.recording, ...recording, autoMontage: { ...DEFAULT_AUTO_MONTAGE, include: { ...DEFAULT_AUTO_MONTAGE.include }, ...montage } }
  }
  const set = vi.fn(async (partial: Partial<Settings>) => {
    current = { ...current, ...partial }
    return { settings: current, persisted: true }
  })
  const api: SettingsApi = {
    settings: { get: async () => current, set, onChanged: () => () => undefined, suggestStorageRoot: async () => 'C:\\Users\\me\\Videos\\Valorant Editor' },
    recording: { getCapabilities: vi.fn(async () => null) },
    export: { selectOutDir: async () => null, detectEncoders: async () => [], openh264Status: async () => ({ installed: false }) }
  }
  const controller = new SettingsController(api)
  return { api, controller, set, current: () => current }
}

async function show(...args: Parameters<typeof rig>) {
  const r = rig(...args)
  mount(<SettingsScreen controller={r.controller} initialCategory="recording" />)
  await flush()
  return r
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const ctl = <T extends HTMLElement>(field: string): T => el<T>(`set-autoMontage-${field}`)
const isDisabled = (e: Element): boolean => e.matches(':disabled')
const dialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"]')
const saved = (r: ReturnType<typeof rig>): AutoMontageSettings => r.current().recording.autoMontage

async function typeNumber(input: HTMLInputElement, value: string): Promise<void> {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
}

let previousApi: Window['api']
beforeEach(() => {
  installDomShims()
  localStorage.clear()
  previousApi = window.api
  window.api = { ...window.api, export: undefined } as unknown as Window['api']
})
afterEach(() => { cleanupMounted(); window.api = previousApi; vi.restoreAllMocks() })

describe('Auto montage settings card', () => {
  test('card renders every row with its title and description; VALORANT only is stated', async () => {
    await show()
    const card = Array.from(document.querySelectorAll('.set-card')).find((c) => c.querySelector('h2')?.textContent === recordingI18n.cards.autoMontage)!
    expect(card).toBeTruthy()
    expect(Array.from(card.querySelectorAll<HTMLElement>('[data-row]')).map((e) => e.dataset.row)).toEqual(AUTO_MONTAGE_FIELDS.map((f) => `autoMontage-${f}`))
    for (const f of AUTO_MONTAGE_FIELDS) {
      expect(el(`set-autoMontage-${f}-title`).textContent).toBe(t.rows[f].title)
      expect(el(`set-autoMontage-${f}-desc`).textContent).toBe(t.rows[f].desc)
    }
    expect(t.rows.enabled.desc).toContain('VALORANT')
    expect(ctl<HTMLInputElement>('enabled').getAttribute('role')).toBe('switch')
    expect(ctl('enabled').getAttribute('aria-describedby')).toContain('set-autoMontage-enabled-desc')
  })

  test('sub-options are visible but disabled while Auto montage is off, with the reason for screen readers', async () => {
    await show()
    expect(ctl<HTMLInputElement>('enabled').checked).toBe(false)
    const presets = document.querySelectorAll<HTMLInputElement>('#set-autoMontage-formatPreset input[type="radio"]')
    expect(presets.length).toBe(5)
    presets.forEach((p) => expect(isDisabled(p)).toBe(true))
    expect(isDisabled(ctl('minClips'))).toBe(true)
    expect(isDisabled(ctl('maxDurationSec'))).toBe(true)
    for (const k of ['multiKills', 'aces', 'clutches', 'singleKills']) expect(isDisabled(el(`set-autoMontage-include-${k}`))).toBe(true)
    document.querySelectorAll<HTMLInputElement>('#set-autoMontage-timing input').forEach((i) => expect(isDisabled(i)).toBe(true))
    expect(isDisabled(ctl('keepSourceRecording'))).toBe(true)
    expect(isDisabled(ctl('outputDir'))).toBe(true)
    expect(ctl('minClips').getAttribute('aria-describedby')).toContain('set-autoMontage-minClips-off')
    expect(el('set-autoMontage-minClips-off').textContent).toBe(t.offHint)
  })

  test('enabling while post-recording analysis is "none" asks first; confirm saves both', async () => {
    const r = await show({ postAnalysis: 'none' })
    click(ctl('enabled'))
    await flush()
    const dlg = dialog()!
    expect(dlg).not.toBeNull()
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(el(dlg.getAttribute('aria-labelledby')!).textContent).toBe(t.enableDialog.title)
    expect(el(dlg.getAttribute('aria-describedby')!).textContent).toBe(t.enableDialog.body)
    expect(r.set).not.toHaveBeenCalled()
    expect(document.activeElement?.textContent).toBe(t.enableDialog.cancel)
    click(el('set-autoMontage-enabled-confirm-confirm'))
    await flush()
    expect(dialog()).toBeNull()
    expect(saved(r).enabled).toBe(true)
    expect(r.current().recording.postAnalysis).toBe('perMatch')
    expect(ctl<HTMLInputElement>('enabled').checked).toBe(true)
    expect(isDisabled(ctl('minClips'))).toBe(false)
  })

  test('cancelling the analysis confirm (button or Esc) saves nothing and returns focus to the switch', async () => {
    const r = await show({ postAnalysis: 'none' })
    click(ctl('enabled'))
    await flush()
    click(el('set-autoMontage-enabled-confirm-cancel'))
    await flush()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(ctl('enabled'))
    click(ctl('enabled'))
    await flush()
    press(document.activeElement!, 'Escape')
    await flush()
    expect(dialog()).toBeNull()
    expect(r.set).not.toHaveBeenCalled()
    expect(saved(r).enabled).toBe(false)
    expect(ctl<HTMLInputElement>('enabled').checked).toBe(false)
  })

  test('enabling with analysis already on saves directly; turning off saves enabled=false', async () => {
    const r = await show({ postAnalysis: 'afterExit' })
    click(ctl('enabled'))
    await flush()
    expect(dialog()).toBeNull()
    expect(saved(r).enabled).toBe(true)
    expect(r.current().recording.postAnalysis).toBe('afterExit')
    click(ctl('enabled'))
    await flush()
    expect(saved(r).enabled).toBe(false)
  })

  test('"No analysis" is disabled with an explanation while Auto montage is on', async () => {
    await show({ postAnalysis: 'perMatch' }, { enabled: true })
    const select = el<HTMLSelectElement>('set-recording-postAnalysis')
    expect(select.querySelector<HTMLOptionElement>('option[value="none"]')!.disabled).toBe(true)
    expect(select.getAttribute('aria-describedby')).toContain('set-recording-postAnalysis-montage')
    expect(el('set-recording-postAnalysis-montage').textContent).toBe(t.analysisNoneDisabled)
    cleanupMounted()
    await show({ postAnalysis: 'perMatch' })
    expect(el<HTMLSelectElement>('set-recording-postAnalysis').querySelector<HTMLOptionElement>('option[value="none"]')!.disabled).toBe(false)
    expect(el('set-recording-postAnalysis-montage')).toBeNull()
  })

  test('format preset cards: YouTube, Shorts, TikTok, Reels, Square (no Original); choosing one saves it', async () => {
    const r = await show({}, { enabled: true })
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('#set-autoMontage-formatPreset input[type="radio"]'))
    expect(radios.map((i) => i.value)).toEqual(['youtube', 'shorts', 'tiktok', 'reels', 'square'])
    expect(radios.every((i) => i.name === 'set-autoMontage-formatPreset-preset')).toBe(true)
    expect(radios.find((i) => i.checked)?.value).toBe('youtube')
    const group = ctl('formatPreset')
    expect(group.getAttribute('aria-labelledby')).toBe('set-autoMontage-formatPreset-title')
    click(radios[1])
    await flush()
    expect(saved(r).formatPreset).toBe('shorts')
    expect(document.querySelector<HTMLInputElement>('#set-autoMontage-formatPreset input[value="shorts"]')!.checked).toBe(true)
  })

  test('min clips and max length are clamped to their ranges', async () => {
    const r = await show({}, { enabled: true })
    await typeNumber(ctl('minClips'), '50')
    expect(saved(r).minClips).toBe(10)
    await typeNumber(ctl('minClips'), '0')
    expect(saved(r).minClips).toBe(1)
    await typeNumber(ctl('maxDurationSec'), '5')
    expect(saved(r).maxDurationSec).toBe(15)
    await typeNumber(ctl('maxDurationSec'), '1000')
    expect(saved(r).maxDurationSec).toBe(300)
    await typeNumber(ctl('maxDurationSec'), '120')
    expect(saved(r).maxDurationSec).toBe(120)
    expect(ctl<HTMLInputElement>('maxDurationSec').value).toBe('120')
  })

  test('include checkboxes each save their own flag, and quick successive toggles do not undo each other', async () => {
    const r = await show({}, { enabled: true })
    const box = (k: string): HTMLInputElement => el(`set-autoMontage-include-${k}`)
    expect(ctl('include').getAttribute('role')).toBe('group')
    expect(box('aces').closest('label')?.textContent).toBe(t.include.aces)
    // Two clicks before the first write resolves.
    act(() => { box('singleKills').click(); box('clutches').click() })
    await flush()
    expect(saved(r).include).toEqual({ multiKills: true, aces: true, clutches: false, singleKills: false })
    click(box('singleKills'))
    await flush()
    expect(saved(r).include.singleKills).toBe(true)
    expect(saved(r).include.clutches).toBe(false)
  })

  test('timing is a radio group with both options', async () => {
    const r = await show({}, { enabled: true })
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('#set-autoMontage-timing input'))
    expect(radios.map((i) => i.value)).toEqual(['afterEachMatch', 'afterGameExit'])
    expect(radios.map((i) => i.closest('label')?.textContent)).toEqual([t.timingAfterEachMatch, t.timingAfterGameExit])
    click(radios[1])
    await flush()
    expect(saved(r).timing).toBe('afterGameExit')
  })

  test('turning off "keep source" asks once; cancel keeps it on, confirm saves and is remembered', async () => {
    const r = await show({}, { enabled: true })
    click(ctl('keepSourceRecording'))
    await flush()
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain(t.keepSourceDialog.body)
    click(el('set-autoMontage-keepSourceRecording-confirm-cancel'))
    await flush()
    expect(dialog()).toBeNull()
    expect(r.set).not.toHaveBeenCalled()
    expect(ctl<HTMLInputElement>('keepSourceRecording').checked).toBe(true)
    click(ctl('keepSourceRecording'))
    await flush()
    click(el('set-autoMontage-keepSourceRecording-confirm-confirm'))
    await flush()
    expect(saved(r).keepSourceRecording).toBe(false)
    expect(localStorage.getItem(KEEP_SOURCE_ACK_KEY)).toBe('1')
    click(ctl('keepSourceRecording'))
    await flush()
    expect(saved(r).keepSourceRecording).toBe(true)
    // Second time off: no dialog.
    click(ctl('keepSourceRecording'))
    await flush()
    expect(dialog()).toBeNull()
    expect(saved(r).keepSourceRecording).toBe(false)
  })

  test('output folder: shows the default under the storage location, choose saves a folder, reset goes back to default', async () => {
    const selectOutDir = vi.fn(async () => 'D:\\Clips')
    window.api = { ...window.api, export: { selectOutDir } } as unknown as Window['api']
    const r = await show({}, { enabled: true }, { storageRoot: 'E:\\VE' })
    expect(el('set-autoMontage-outputDir-value').textContent).toContain(defaultMontageDir('E:\\VE'))
    expect(defaultMontageDir('E:\\VE\\')).toBe('E:\\VE\\Montages')
    expect(defaultMontageDir('/home/me/ve')).toBe('/home/me/ve/Montages')
    click(ctl('outputDir'))
    await flush()
    expect(selectOutDir).toHaveBeenCalledOnce()
    expect(saved(r).outputDir).toBe('D:\\Clips')
    expect(el('set-autoMontage-outputDir-value').textContent).toBe('D:\\Clips')
    const reset = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === t.outputReset)!
    click(reset)
    await flush()
    expect(saved(r).outputDir).toBeNull()
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === t.outputReset)).toBe(false)
    // Cancelled picker: nothing saved. Failing picker: error shown.
    selectOutDir.mockResolvedValueOnce(null as unknown as string)
    const calls = r.set.mock.calls.length
    click(ctl('outputDir'))
    await flush()
    expect(r.set.mock.calls.length).toBe(calls)
    selectOutDir.mockRejectedValueOnce(new Error('boom'))
    click(ctl('outputDir'))
    await flush()
    expect(document.querySelector('[data-row="autoMontage-outputDir"] [role="alert"]')?.textContent).toBe(t.outputPickFailed)
  })

  test('output folder uses the suggested storage root when none is set', async () => {
    await show({}, { enabled: true })
    expect(el('set-autoMontage-outputDir-value').textContent).toContain('C:\\Users\\me\\Videos\\Valorant Editor\\Montages')
  })

  test('axe: card (off and on) and both dialogs have no serious violations', async () => {
    await show({ postAnalysis: 'none' })
    const card = (): Element => ctl('enabled').closest('.set-card')!
    let findings = await runAxe(card())
    expect(findings, formatFindings(findings)).toEqual([])
    click(ctl('enabled'))
    await flush()
    findings = await runAxe(dialog()!)
    expect(findings, formatFindings(findings)).toEqual([])
    click(el('set-autoMontage-enabled-confirm-confirm'))
    await flush()
    findings = await runAxe(card())
    expect(findings, formatFindings(findings)).toEqual([])
    click(ctl('keepSourceRecording'))
    await flush()
    findings = await runAxe(dialog()!)
    expect(findings, formatFindings(findings)).toEqual([])
  })

  test('dialog traps Tab focus', async () => {
    await show({ postAnalysis: 'none' })
    click(ctl('enabled'))
    await flush()
    const dlg = dialog()!
    for (let i = 0; i < 4; i++) { press(document.activeElement!, 'Tab'); expect(dlg.contains(document.activeElement)).toBe(true) }
  })
})
