import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../shared/settings'
import { DEFAULT_EXPORT_FORMAT, type ExportFormat } from '../shared/exportFormat'
import { loadSettings, SettingsStore } from './settings'
import { registerSettingsHandlers } from './settings-ipc'

type Fn = (...a: any[]) => any

const SHORTS_H265: ExportFormat = { preset: 'shorts', frame: '9:16', reframe: 'blur', offset: -0.25, codec: 'h265', width: 1080, height: 1920, fpsCap: 60 }

describe('exportFormat settings', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-sfmt-'))
    file = path.join(dir, 'settings.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  // A settings.json written before exportFormat existed (every other field non-default).
  const legacy = {
    version: SETTINGS_VERSION,
    language: 'ja',
    onboardingDone: true,
    autoAnalyze: false,
    before: 7,
    after: 4,
    previewVolume: 40,
    defaultOutDir: null,
    lowPerfAsked: true,
    autoclip: { ...DEFAULT_SETTINGS.autoclip },
    recording: { ...DEFAULT_SETTINGS.recording, fps: 60 }
  }

  it('a settings.json without exportFormat loads the default format and leaves every other field unchanged', () => {
    fs.writeFileSync(file, JSON.stringify(legacy))
    const loaded = loadSettings(file)
    expect(loaded.exportFormat).toEqual(DEFAULT_EXPORT_FORMAT)
    const withFormat = loadSettings((fs.writeFileSync(file, JSON.stringify({ ...legacy, exportFormat: SHORTS_H265 })), file))
    // Adding a valid exportFormat changes nothing else.
    expect({ ...loaded, exportFormat: null }).toEqual({ ...withFormat, exportFormat: null })
    expect(loaded).toMatchObject({ language: 'ja', onboardingDone: true, autoAnalyze: false, before: 7, after: 4, previewVolume: 40, lowPerfAsked: true })
  })

  it.each([
    ['not an object', 'shorts'],
    ['unknown preset', { ...SHORTS_H265, preset: 'snapchat' }],
    ['offset out of range', { ...SHORTS_H265, offset: 2 }],
    ['odd size', { ...SHORTS_H265, width: 1081 }],
    ['oversized', { ...SHORTS_H265, width: 4320, height: 7680 }],
    ['size on the source frame', { ...DEFAULT_EXPORT_FORMAT, width: 1920, height: 1080 }],
    ['missing field', { frame: '9:16' }],
    ['bad codec', { ...SHORTS_H265, codec: 'av1' }]
  ])('an invalid persisted exportFormat (%s) falls back to the default', (_name, exportFormat) => {
    fs.writeFileSync(file, JSON.stringify({ ...legacy, exportFormat }))
    const loaded = loadSettings(file)
    expect(loaded.exportFormat).toEqual(DEFAULT_EXPORT_FORMAT)
    expect(loaded.before).toBe(7)
  })

  it('a valid exportFormat round-trips through the store and the file', () => {
    const store = new SettingsStore(file)
    expect(store.set({ exportFormat: SHORTS_H265 }).persisted).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).exportFormat).toEqual(SHORTS_H265)
    expect(new SettingsStore(file).get().exportFormat).toEqual(SHORTS_H265)
    // Unrelated changes keep it.
    store.set({ before: 3 })
    expect(loadSettings(file).exportFormat).toEqual(SHORTS_H265)
  })

  it('settings:set validates exportFormat: a valid one is applied and persisted, an invalid one keeps the saved format', async () => {
    const store = new SettingsStore(file)
    const handlers = new Map<string, Fn>()
    registerSettingsHandlers({ handle: (ch: string, fn: Fn) => void handlers.set(ch, fn) }, store, () => [])
    const set = handlers.get('settings:set')!

    const ok = await set({}, { exportFormat: SHORTS_H265 })
    expect(ok.persisted).toBe(true)
    expect(ok.settings.exportFormat).toEqual(SHORTS_H265)
    expect(loadSettings(file).exportFormat).toEqual(SHORTS_H265)

    for (const bad of [{ ...SHORTS_H265, offset: -3 }, { ...SHORTS_H265, preset: 'x' }, { ...SHORTS_H265, height: 1921 }, null, 'square']) {
      const res = await set({}, { exportFormat: bad, before: 9 })
      expect(res.settings.exportFormat).toEqual(SHORTS_H265)
      // The rest of the same request still applies.
      expect(res.settings.before).toBe(9)
    }
    expect(loadSettings(file).exportFormat).toEqual(SHORTS_H265)

    // Back to the default (source frame) is a valid change.
    expect((await set({}, { exportFormat: DEFAULT_EXPORT_FORMAT })).settings.exportFormat).toEqual(DEFAULT_EXPORT_FORMAT)
  })
})
