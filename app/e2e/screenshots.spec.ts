// UI screenshots for docs/screenshots/ (before/after comparisons). Runs only when ADITOR_SHOTS_DIR is set:
//   set ADITOR_SHOTS_DIR=<dir> && npx playwright test -c e2e/playwright.config.ts screenshots
// ADITOR_E2E_RECORDING_STATUS (JSON) shows the recording panel in a live state (an E2E-only hook in main/e2e.ts; older builds
// ignore it and show Idle). The library is seeded with VALORANT match entries so result badges show.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from './helpers/test'
import { recordingI18n } from '../src/renderer/i18n'

const OUT = process.env.ADITOR_SHOTS_DIR
const PREFIX = process.env.ADITOR_SHOTS_PREFIX ?? ''

test.skip(!OUT, 'set ADITOR_SHOTS_DIR to take UI screenshots')

const RECORDING = {
  phase: 'recording', backend: 'builtin', capture: 'wgc', sessionId: 'shots', startedAt: Date.now() - (23 * 60 + 41) * 1000,
  encoder: 'hevc_nvenc', width: 2560, height: 1440, segments: 711, durationSec: 23 * 60 + 41, diskFreeBytes: 182 * 1024 ** 3,
  droppedFrames: 0, paused: false, error: null, kills: 17, matchIndex: 2, inMatch: true, score: { ally: 9, enemy: 7 }
}

test('UI screenshots', async ({ launch, videos }) => {
  fs.mkdirSync(OUT!, { recursive: true })
  const shot = (name: string) => path.join(OUT!, `${PREFIX}${name}.png`)
  const size = { width: 1440, height: 900 }

  // A library with recorded VALORANT matches (won, lost) and a montage.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-shots-'))
  const data = path.join(root, 'Valorant Editor')
  fs.mkdirSync(data, { recursive: true })
  const now = Date.now()
  const [a, b, c] = videos.videos
  const entry = (p: string, extra: object) => ({ path: p, addedAt: now, favorite: false, status: 'done', progress: 1, game: 'valorant', durationSec: 20, codec: 'h264', ...extra })
  fs.writeFileSync(path.join(data, 'library.json'), JSON.stringify([
    entry(a.path, { source: 'recording', counts: { knock: 0, assist: 0, kill: 21, death: 12 }, score: { ally: 13, enemy: 9 } }),
    entry(b.path, { source: 'recording', counts: { knock: 0, assist: 0, kill: 14, death: 17 }, score: { ally: 8, enemy: 13 } }),
    entry(c.path, { source: 'montage', montage: { sourcePath: a.path, projectId: 'p1', jobId: 'j1' }, counts: { knock: 0, assist: 0, kill: 9 } })
  ]))

  const app = await launch({ size, root, ownRoot: true, env: { ADITOR_E2E_RECORDING_STATUS: JSON.stringify(RECORDING) } })
  const { page } = app
  await page.waitForTimeout(2500)
  await page.screenshot({ path: shot('library') })

  // Recording panel (rail button).
  await page.locator(`.rail-btn[data-tip="${recordingI18n.phases.recording}"], .rail-btn[data-tip="${recordingI18n.title}"]`).first().click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: shot('recording-panel') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // Settings → Recording: the page, then each card on its own.
  await page.locator('.rail-btn').last().click()
  await page.locator('#set-tab-recording').click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: shot('settings-recording') })
  const cards = page.locator('.set-card')
  for (let i = 0; i < await cards.count(); i++) {
    const card = cards.nth(i)
    const title = ((await card.locator('h2').first().textContent()) ?? `card-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    await card.scrollIntoViewIfNeeded()
    await card.screenshot({ path: shot(`settings-card-${title}`) })
  }

  // Onboarding, every step.
  const first = await launch({ size, settings: { onboardingDone: false } })
  for (let step = 0; step < 6; step++) {
    await first.page.waitForTimeout(500)
    await first.page.screenshot({ path: shot(`onboarding-${step + 1}`) })
    const next = first.page.locator('.ob-foot button').last()
    if (!(await next.isVisible()) || (await next.isDisabled())) break
    await next.click()
  }
})
