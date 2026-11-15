import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOCALE, LOCALE_NAMES, resolveLocale, setActiveLocale, tr } from './locale'
import { DEFAULT_SETTINGS } from './settings'
import enMessages from './messages/en'
import { en } from '../renderer/i18n/en'

/** Han, kana, Hangul and full-width punctuation: anything that would show up as non-English text in the English UI. */
const NON_ENGLISH = /[　-ヿ㐀-鿿가-힯＀-￯]/
/** Native language names are shown as-is in the language picker (and are searchable), which is intentional. */
const NATIVE_NAMES = new Set(Object.values(LOCALE_NAMES))

function strings(value: unknown, at: string, out: Array<[string, string]>): Array<[string, string]> {
  if (typeof value === 'string') out.push([at, value])
  else if (typeof value === 'function') {
    // Templating helpers: call with neutral arguments and check the produced text.
    const fn = value as (...args: unknown[]) => unknown
    try { strings(fn(1, 2, 3), `${at}()`, out) } catch { /* helpers that need specific arguments are covered by their own tests */ }
  } else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out)
  return out
}

describe('English is the default and primary language', () => {
  it('defaults to English for the locale and the language setting', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(DEFAULT_SETTINGS.language).toBe('en')
    // An explicit English setting wins over the system language.
    expect(resolveLocale(DEFAULT_SETTINGS.language, 'zh-Hant-TW')).toBe('en')
  })

  it('the English interface catalog contains no untranslated text', () => {
    const leaks = strings(en, 'en', []).filter(([, s]) => NON_ENGLISH.test(s) && !NATIVE_NAMES.has(s))
    expect(leaks).toEqual([])
  })

  it('every English main-process / notification message is translated', () => {
    const leaks = Object.entries(enMessages).filter(([, s]) => NON_ENGLISH.test(s))
    expect(leaks).toEqual([])
  })

  it('tr() returns English text when English is active', () => {
    setActiveLocale('en')
    try {
      expect(tr('打開 Valorant Editor')).toBe('Open Valorant Editor')
    } finally {
      setActiveLocale('zh-TW')
    }
  })

  it('renders every Settings category in English without mixed-language text', async () => {
    vi.resetModules()
    const locale = await import('./locale')
    locale.setActiveLocale('en')
    try {
      const { SettingsScreen } = await import('../renderer/settings/SettingsScreen')
      const { SettingsController } = await import('../renderer/settings/settingsController')
      const { CATEGORIES } = await import('../renderer/settings/rows')
      const api = {
        settings: { get: async () => DEFAULT_SETTINGS, set: async () => ({ settings: DEFAULT_SETTINGS, persisted: true }), onChanged: () => () => undefined },
        library: {
          getEntries: async () => [], getWatchFolders: async () => ({ dirs: [], missing: [] }),
          addWatchFolder: async () => ({ ok: true, dirs: [], missing: [] }), removeWatchFolder: async () => ({ ok: true, dirs: [], missing: [] })
        },
        proxy: { usage: async () => ({ count: 0, bytes: 0 }), delete: async () => true },
        export: { detectEncoders: async () => [], selectOutDir: async () => null, openFolder: async () => true, openh264Status: async () => ({ installed: true }) }
      }
      for (const category of CATEGORIES) {
        const controller = new SettingsController(api as never)
        await controller.start()
        let html = renderToString(React.createElement(SettingsScreen, { controller, initialCategory: category.id }))
        for (const name of NATIVE_NAMES) html = html.split(name).join('')
        const text = html.replace(/<[^>]+>/g, ' ')
        expect({ category: category.id, leak: text.match(new RegExp(`.{0,30}${NON_ENGLISH.source}.{0,30}`))?.[0] ?? null })
          .toEqual({ category: category.id, leak: null })
        if (category.id === 'about') expect(html).toContain('Valorant Editor')
      }
    } finally {
      locale.setActiveLocale('zh-TW')
      vi.resetModules()
    }
  })
})
