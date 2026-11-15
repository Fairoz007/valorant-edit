import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'fs'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { ExportDrawer, ExportPlanBase } from './ExportDrawer'
import { createExportController, ExportApi } from './exportController'
import { Project } from '../editor/project'
import { exportViewModel, formatBytes } from './exportViewModel'
import { DEFAULT_EXPORT_FORMAT } from '../../shared/exportFormat'
import { fillTemplate as fmt } from '../../shared/template'
import { i18n } from '../i18n'

const A = 'D:/v/a.mp4'
const B = 'D:/v/b.mp4'
const project: Project = {
  version: 1,
  name: '我的精華專案',
  items: [
    { id: '1', source: A, start: 10, end: 40 },
    { id: '2', source: B, start: 100, end: 130 }
  ]
}
const base: ExportPlanBase = {
  sources: { [A]: { codec: 'h264', width: 1920, height: 1080 }, [B]: { codec: 'h264', width: 1920, height: 1080 } },
  keyframes: { [A]: [0, 8], [B]: [] },
  missingItemIds: new Set<string>()
}
const GB = 1024 ** 3

function fakeApi(over: Record<string, unknown> = {}): { api: ExportApi; resolveStart: (r: unknown) => void } {
  let resolveStart: (r: unknown) => void = () => undefined
  const api = {
    detectEncoders: async () => ['h264_nvenc'],
    openh264Status: async () => ({ installed: false }),
    downloadOpenH264: async () => 'x',
    selectOutDir: async () => 'D:/o',
    checkOutDir: async () => ({ ok: true }),
    openFolder: async () => true,
    diskSpace: async () => ({ freeBytes: 200 * GB, totalBytes: 500 * GB }),
    start: () => new Promise((r) => (resolveStart = r)),
    cancel: async () => ({ cancelled: true }),
    onProgress: () => () => undefined,
    onOpenH264Progress: () => () => undefined,
    ...over
  } as unknown as ExportApi
  return { api, resolveStart: (r) => resolveStart(r) }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const ITEMS = project.items.map((i) => ({ ...i }))
const html = (c: ReturnType<typeof createExportController>, p: Project = project, b: ExportPlanBase | null = base): string =>
  renderToStaticMarkup(React.createElement(ExportDrawer, { controller: c, project: p, base: b, onClose: () => undefined }))

async function ready(over: Record<string, unknown> = {}, outDir: string | null = 'D:/out') {
  const f = fakeApi(over)
  const c = createExportController(f.api, project.name)
  await c.init(outDir)
  return { c, f }
}

describe('ExportDrawer markup (all four states)', () => {
  test('settings: dialog semantics, summary, modes, quality, output, enabled start', async () => {
    const { c } = await ready()
    // Both clips come from the same video (compatibility is known); engine metadata is incomplete for other sources, so conservatively use precise encoding (I9).
    const sameSource: Project = { ...project, items: [project.items[0], { ...project.items[1], source: A, start: 10, end: 40 }] }
    const m = html(c, sameSource)
    expect(html(c)).toContain('無法確認幀率')
    expect(m).toContain('role="dialog"')
    expect(m).toContain('aria-modal="true"')
    expect(m).toContain('aria-labelledby="xd-title"')
    expect(m).toContain('id="xd-title"')
    expect(m).toContain('匯出專案')
    expect(m).toContain('串成一支合輯')
    expect(m).toContain('每段各一檔')
    expect(m).toContain('快速無損')
    expect(m).toContain('精準重新編碼')
    expect(m).toContain('NVIDIA NVENC')
    expect(m).toContain('預估大小約')
    expect(m).toContain('可用 200 GB')
    expect(m).toContain('data-phase="settings"')
    expect(m).toMatch(/<button type="button" class="btn-accent"><svg[^>]*>[\s\S]*?<\/svg> 開始匯出<\/button>/)
    expect(m).toContain('片段起點平均會多出約 2.0 秒') // Keyframe distance is 10-8 (B has no data).
  })

  test('running: progressbar with aria-valuenow, cancel button, lock explanation, minimize label', async () => {
    const { c, f } = await ready()
    void c.start(ITEMS)
    await flush()
    const m = html(c)
    expect(m).toContain('data-phase="running"')
    expect(m).toContain('role="progressbar"')
    expect(m).toContain('aria-valuenow="0"')
    expect(m).toContain('取消匯出')
    expect(m).toContain('編輯區已鎖定')
    expect(m).toContain('縮小為進度徽章')
    expect(m).not.toContain('開始匯出')
    f.resolveStart({ ok: true, outputs: [], notices: [] })
  })

  test('done: outputs listed with open folder + finish; cancelled variant explains partial removal', async () => {
    const { c, f } = await ready()
    const p = c.start(ITEMS)
    await flush()
    f.resolveStart({ ok: true, outputs: ['D:/out/我的精華專案.mp4'], notices: ['已自動改用精準重新編碼'] })
    await p
    const m = html(c)
    expect(m).toContain('data-phase="done"')
    expect(m).toContain('匯出完成')
    expect(m).toContain('D:/out/我的精華專案.mp4')
    expect(m).toContain('開啟資料夾')
    expect(m).toContain('已自動改用精準重新編碼')

    const r = await ready()
    const p2 = r.c.start(ITEMS)
    await flush()
    await r.c.cancel()
    r.f.resolveStart({ ok: false, cancelled: true, outputs: ['D:/out/a_1.mp4'], notices: [] })
    await p2
    const m2 = html(r.c)
    expect(m2).toContain('已取消匯出')
    expect(m2).toContain('未完成的檔案已刪除')
    expect(m2).toContain('D:/out/a_1.mp4')
  })

  test('failed: alert region with stderr tail, copy and retry buttons', async () => {
    const { c, f } = await ready()
    const p = c.start(ITEMS)
    await flush()
    f.resolveStart({ ok: false, error: '匯出失敗 (exit code 1):\nConversion failed!', outputs: [] })
    await p
    const m = html(c)
    expect(m).toContain('data-phase="failed"')
    expect(m).toContain('role="alert"')
    expect(m).toContain('aria-live="assertive"')
    expect(m).toContain('Conversion failed!')
    expect(m).toContain('複製錯誤訊息')
    expect(m).toContain('重試')
  })
})

describe('ExportDrawer blockers and warnings', () => {
  test('4K sources use the peak-rate estimate for the displayed size and disk warning', async () => {
    const { c } = await ready({ diskSpace: async () => ({ freeBytes: GB, totalBytes: 10 * GB }) })
    await c.setQuality('precise')
    const highRes: ExportPlanBase = { ...base, sources: { [A]: { codec: 'h264', width: 3840, height: 2160, fps: 60 }, [B]: { codec: 'h264', width: 3840, height: 2160, fps: 60 } } }
    const m = html(c, project, highRes)
    expect(m).toContain('1.0 GB')
    expect(m).toContain('剩餘空間不足')
  })

  test('empty project: blocker shown, start disabled', async () => {
    const { c } = await ready()
    const m = html(c, { ...project, items: [] })
    expect(m).toContain('專案沒有任何片段')
    expect(m).toMatch(/<button type="button" class="btn-accent" disabled=""/)
  })

  test('missing source files are listed as blockers and start is disabled', async () => {
    const { c } = await ready()
    const m = html(c, project, { ...base, missingItemIds: new Set(['2']) })
    expect(m).toContain('找不到來源影片：' + B)
    expect(m).not.toContain('找不到來源影片：' + A)
    expect(m).toMatch(/<button type="button" class="btn-accent" disabled=""/)
  })

  test('output dir problems: no default dir and non-existing dir both block with a clear message', async () => {
    const none = await ready({}, null)
    expect(html(none.c)).toContain('請先選擇輸出資料夾')
    const bad = await ready({ diskSpace: async () => { throw new Error('資料夾不存在') } }, 'D:/nope')
    const m = html(bad.c)
    expect(m).toContain('輸出資料夾不存在或路徑不正確')
    expect(m).toMatch(/<button type="button" class="btn-accent" disabled=""/)
  })

  test('low disk space shows a warning (free < estimate x 1.1)', async () => {
    const { c } = await ready({ diskSpace: async () => ({ freeBytes: 1024, totalBytes: 10 * GB }) })
    const m = html(c)
    expect(m).toContain('剩餘空間不足')
  })

  test('Mixed source parameters disable copy with an “Unavailable” label and a fallback notice', async () => {
    const { c } = await ready()
    const mixed: ExportPlanBase = { ...base, sources: { ...base.sources, [B]: { codec: 'h264', width: 1728, height: 1080 } } }
    const m = html(c, project, mixed)
    expect(m).toContain('已自動改用精準重新編碼')
    expect(m).toContain('不可用')
    expect(m).toMatch(/name="xd-quality" disabled=""/)
  })

  test('no hardware encoder and openh264 missing: precise opens the consent dialog markup (and no download yet)', async () => {
    let downloaded = 0
    const { c } = await ready({
      detectEncoders: async () => [],
      downloadOpenH264: async () => {
        downloaded++
        return 'x'
      }
    })
    await c.setQuality('precise')
    const m = html(c)
    expect(m).toContain('需要下載 Cisco OpenH264')
    expect(m).toContain('ciscobinary.openh264.org')
    expect(m).toContain('改用快速無損')
    expect(m).toContain('同意並下載')
    expect(m).toContain('aria-labelledby="xd-h264-title"')
    expect(downloaded).toBe(0)
  })

  test('download in progress shows a progressbar inside the consent dialog', async () => {
    const f = fakeApi({ detectEncoders: async () => [], downloadOpenH264: () => new Promise(() => undefined) })
    const c = createExportController(f.api, 'x')
    await c.init('D:/out')
    await c.setQuality('precise')
    void c.acceptConsent()
    await flush()
    const m = html(c)
    expect(m).toContain('下載中')
    expect(m).toContain('role="progressbar"')
  })
})

describe('export path hygiene', () => {
  const root = path.resolve(__dirname, '..')
  const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf-8')
  test('old ExportDialog is gone and nothing imports it', () => {
    expect(fs.existsSync(path.join(root, 'components', 'ExportDialog.tsx'))).toBe(false)
    expect(read('studio/StudioScreen.tsx')).not.toContain('ExportDialog')
  })
  test('no hex colour literals in the new TSX/CSS, no backdrop-filter', () => {
    for (const f of ['studio/ExportDrawer.tsx', 'studio/ExportFormatControls.tsx', 'studio/ExportPreview.tsx', 'studio/OpenH264Dialog.tsx', 'styles/exportDrawer.css']) {
      const src = read(f)
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, f).not.toContain('backdrop-filter')
    }
  })

  test('Encoder selector offers Automatic and every detected encoder, and stays enabled in copy mode', async () => {
    const f = fakeApi({ detectEncoders: async () => ['h264_nvenc', 'h264_amf'] })
    const c = createExportController(f.api)
    await c.init('D:/o')
    const m = renderToStaticMarkup(React.createElement(ExportDrawer, { controller: c, project, base, onClose: () => undefined }))
    expect(m).toContain('value="auto"')
    expect(m).toContain('value="h264_nvenc"')
    expect(m).toContain('value="h264_amf"')
    expect(m).not.toContain('value="h264_qsv"')
    expect(m).not.toMatch(/<select[^>]*aria-label="編碼器"[^>]*disabled/)
  })
})

describe('ExportDrawer reframing: presets, preview, codec, summary, length', () => {
  const t = i18n.export
  const fresh = (over: Record<string, unknown> = {}): Promise<{ c: ReturnType<typeof createExportController>; f: ReturnType<typeof fakeApi> }> =>
    (async () => {
      const f = fakeApi(over)
      const c = createExportController(f.api, project.name, { persistDelayMs: 0 })
      await c.init('D:/out')
      return { c, f }
    })()
  /** The <input> of a radio group option (attribute order is React's, so match by name and value). */
  const inputTag = (m: string, name: string, value: string): string =>
    [...m.matchAll(/<input [^>]*>/g)].map((x) => x[0]).find((tag) => tag.includes(`name="${name}"`) && tag.includes(`value="${value}"`)) ?? ''
  const selectedPresets = (m: string): string[] => [...m.matchAll(/data-preset="([a-z]+)" data-selected="true"/g)].map((x) => x[1])

  test('preset cards render (Original + every preset) with frame shape, size and limit; the selected one is marked', async () => {
    const { c } = await fresh()
    let m = html(c)
    for (const id of ['source', 'youtube', 'shorts', 'tiktok', 'reels', 'square']) expect(m).toContain(`data-preset="${id}"`)
    expect(selectedPresets(m)).toEqual(['source'])
    expect(m).toContain('class="xd-shape xd-shape-src"')
    expect(m).toContain(t.presetReels)
    expect(m).toContain(fmt(t.maxLength, { dur: fmt(t.durSec, { n: 90 }) }))
    expect(m).toContain(fmt(t.maxLength, { dur: fmt(t.durMin, { n: 10 }) }))
    c.choosePreset('shorts')
    m = html(c)
    expect(selectedPresets(m)).toEqual(['shorts'])
    expect(m).toContain('<label class="xd-card on" data-preset="shorts" data-selected="true">')
    expect(inputTag(m, 'xd-preset', 'shorts')).toContain('checked=""')
    expect(inputTag(m, 'xd-preset', 'source')).not.toContain('checked')
    expect(m).not.toContain('data-preset="custom"')
  })

  test('editing a preset output field shows the Custom card selected', async () => {
    const { c } = await fresh()
    c.choosePreset('square')
    c.setFpsCap(30)
    const m = html(c)
    expect(selectedPresets(m)).toEqual(['custom'])
    expect(m).toContain(t.presetCustom)
    // Styling choices (fit, offset, codec) keep the preset.
    c.choosePreset('tiktok')
    c.setReframe('blur')
    expect(selectedPresets(html(c))).toEqual(['tiktok'])
  })

  test('crop preview frame follows computeReframe for 1920×1080 → 9:16 as the offset moves (-1 / 0 / 1)', async () => {
    const { c } = await fresh()
    c.choosePreset('shorts')
    const frames = [-1, 0, 1].map((o) => {
      c.setOffset(o)
      const m = html(c)
      expect(m).toContain('data-kind="crop"')
      return m.match(/class="xd-pv-frame"[^>]*>/)![0]
    })
    expect(frames[0]).toContain('data-crop-x="0" data-crop-y="0" data-crop-w="608" data-crop-h="1080"')
    expect(frames[0]).toContain('left:0%;top:0%;width:31.67%;height:100%')
    expect(frames[1]).toContain('data-crop-x="656"')
    expect(frames[1]).toContain('left:34.17%')
    expect(frames[2]).toContain('data-crop-x="1312"')
    expect(frames[2]).toContain('left:68.33%')
    // The slider is keyboard operable and labelled; it only exists while cropping.
    const slider = html(c).match(/<input id="xd-offset"[^>]*>/)![0]
    expect(slider).toContain('type="range" min="-1" max="1" step="0.05"')
    expect(slider).toContain('value="1"')
    expect(slider).toContain(`aria-valuetext="${fmt(t.offsetValue, { side: t.offsetRight, pct: 100 })}"`)
    expect(html(c)).toContain(`<label for="xd-offset">${t.offset}</label>`)
    c.setReframe('bars')
    expect(html(c)).not.toContain('id="xd-offset"')
  })

  test('preview uses the player video size when given, and mocks bars/blur output from the same geometry', async () => {
    const { c } = await fresh()
    c.choosePreset('shorts')
    c.setReframe('bars')
    const m = renderToStaticMarkup(React.createElement(ExportDrawer, { controller: c, project, base, onClose: () => undefined, previewSource: { width: 1920, height: 1080, fps: 60 } }))
    expect(m).toContain('data-kind="bars"')
    // 1080 wide, 608 tall foreground centred in 1080×1920: y = 656.
    expect(m).toContain('data-pos-x="0" data-pos-y="656" data-scaled-w="1080" data-scaled-h="608"')
    expect(m).toContain('aspect-ratio:1080 / 1920')
    c.setReframe('blur')
    const b = html(c)
    expect(b).toContain('data-kind="blur"')
    expect(b).toContain('class="xd-pv-bg"')
  })

  test('copy is disabled with an inline reason when the format needs re-encoding', async () => {
    const { c } = await fresh()
    const sameSource: Project = { ...project, items: [project.items[0], { ...project.items[1], source: A }] }
    expect(html(c, sameSource)).not.toMatch(/name="xd-quality" disabled=""/)
    c.choosePreset('square')
    const m = html(c, sameSource)
    expect(m).toMatch(/name="xd-quality" disabled=""/)
    expect(m).toContain(t.copyNeedsReencode)
    expect(m).toContain(t.unavailable)
  })

  test('H.265 is disabled with an explanation when no HEVC encoder works, and enabled when one does', async () => {
    const none = await fresh()
    let m = html(none.c)
    expect(inputTag(m, 'xd-codec', 'h265')).toContain('disabled=""')
    expect(m).toContain(t.h265Unavailable)
    const hevc = await fresh({ detectEncoders: async () => ['h264_nvenc', 'hevc_nvenc'] })
    m = html(hevc.c)
    expect(inputTag(m, 'xd-codec', 'h265')).not.toContain('disabled')
    expect(m).not.toContain(t.h265Unavailable)
    hevc.c.setCodec('h265')
    m = html(hevc.c)
    expect(m).toContain('value="hevc_nvenc"')
    expect(m).not.toContain('value="h264_nvenc"')
  })

  test('a persisted H.265 without an HEVC encoder renders as H.264 with a notice', async () => {
    const { c } = await fresh({ getSettings: async () => ({ exportFormat: { ...DEFAULT_EXPORT_FORMAT, codec: 'h265' } }) })
    const m = html(c)
    expect(inputTag(m, 'xd-codec', 'h264')).toContain('checked=""')
    expect(inputTag(m, 'xd-codec', 'h265')).not.toContain('checked')
    expect(m).toContain(t.h265FallbackNotice)
    expect(m).toContain('· H.264 ·')
  })

  test('summary line above the Export button: size · fps · codec · size estimate · duration', async () => {
    const { c } = await fresh()
    c.choosePreset('shorts')
    const s = c.getState()
    const vm = exportViewModel(project, { ...base, mode: 'concat', quality: s.settings.quality }, { encoders: s.encoders, openh264: false }, { format: s.settings.format })
    const m = html(c)
    const line = `1080×1920 · 60 fps · H.264 · ${fmt(t.summarySize, { size: formatBytes(vm.estimatedBytes) })} · 1:00`
    expect(m).toContain(`<div class="xd-summary" role="status" aria-label="${t.summaryLabel}" data-summary="">${line}</div>`)
    expect(m.indexOf('xd-summary')).toBeLessThan(m.indexOf(t.startExport))
  })

  test('over the preset length: a warning with the trim option (start stays enabled); trimming shortens the summary', async () => {
    const { c } = await fresh()
    const long: Project = { ...project, items: [{ id: '1', source: A, start: 0, end: 50 }, { id: '2', source: B, start: 0, end: 40 }] }
    c.choosePreset('shorts')
    let m = html(c, long)
    expect(m).toContain('data-length-warning=""')
    expect(m).toContain(fmt(t.lengthOver, { platform: t.presetShorts, max: fmt(t.durSec, { n: 60 }), len: '1:30' }))
    expect(m).toContain(fmt(t.trimToLimit, { max: fmt(t.durSec, { n: 60 }) }))
    expect(m).toMatch(/<input type="checkbox"\/>/)
    expect(m).not.toMatch(/<button type="button" class="btn-accent" disabled=""/)
    expect(m).toMatch(/· 1:30<\/div>/)
    c.setTrimToLimit(true)
    m = html(c, long)
    expect(m).toMatch(/<input type="checkbox" checked=""\/>/)
    expect(m).toMatch(/· 1:00<\/div>/)
    // No warning within the limit or for Original.
    expect(html(c)).not.toContain('data-length-warning')
    c.choosePreset('source')
    expect(html(c, long)).not.toContain('data-length-warning')
  })

  test('sections: Format, Quality (codec + encoder), Output (mode), Advanced collapsed behind a button', async () => {
    const { c } = await fresh()
    const m = html(c)
    for (const legend of [t.preset, t.format, t.frame, t.quality, t.codec, t.output, t.mode]) expect(m).toContain(`<legend>${legend}</legend>`)
    expect(m).toMatch(/<button type="button" class="btn-ghost xd-adv-toggle" aria-expanded="false" aria-controls="xd-advanced">/)
    expect(m).not.toContain('id="xd-fps"')
  })
})

describe('ExportDrawer output path explanation', () => {
  test('Shows “Actual output location” and switches between Merged and Clips by mode', async () => {
    const { c } = await ready({}, '/data/out')
    c.setMode('concat')
    expect(html(c)).toContain('實際會存到：/data/out/Merged')
    c.setMode('separate')
    const m = html(c)
    expect(m).toContain('實際會存到：/data/out/Clips')
    expect(m).not.toContain('/data/out/Merged')
  })

  test('Does not show the explanation when outDir is empty', async () => {
    const { c } = await ready({}, null)
    expect(html(c)).not.toContain('實際會存到')
  })
})
