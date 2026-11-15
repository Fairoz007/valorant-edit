// Auto montage in the real app (fake engine): the Settings → Recording card toggles and persists the setting, and the
// recording panel shows job status read by main from `<appData>/montage/jobs.json`.
// Main has no e2e hook that starts a montage job (jobs are created only by the recorder's match finalization), so the status
// cases seed jobs.json before launch in the format of `main/montage/montage-job.ts` (version 1, ids from `montageJobId`).
import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, readSettings } from './helpers/test'
import { api } from './helpers/launch'
import { recordingI18n, shellI18n } from '../src/renderer/i18n'
import { montageJobId, montageProjectId, type MontageJob } from '../src/shared/montage'
import { formatTime } from '../src/shared/time'

const t = recordingI18n.autoMontage
const s = t.status

type MontageSettingsView = { recording: { postAnalysis: string; autoMontage: { enabled: boolean } } }

async function openRecordingSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: shellI18n.rail.settings, exact: true }).click()
  await page.locator('#set-tab-recording').click()
}

function montageCard(page: Page) {
  return page.locator('.set-card').filter({ has: page.locator('h2', { hasText: recordingI18n.cards.autoMontage }) })
}

function seedJobs(dataDir: string, jobs: MontageJob[]): string {
  const file = path.join(dataDir, 'montage', 'jobs.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs }, null, 2), 'utf-8')
  return file
}

async function openRecordingPanel(page: Page) {
  await page.locator(`.rail-btn[data-tip="${recordingI18n.title}"]`).click()
  const section = page.locator('section.rec-montage')
  await expect(section).toBeVisible()
  await expect(section.getByRole('heading', { name: s.title })).toBeVisible()
  return section
}

test('settings: Auto montage card turns on (switching "No analysis"), persists, and turns off', async ({ launch }) => {
  const app = await launch({ settings: { language: 'en', recording: { postAnalysis: 'none' } } })
  const { page } = app
  await openRecordingSettings(page)
  const card = montageCard(page)
  await expect(card).toBeVisible()
  await expect(card.locator('[data-row="autoMontage-enabled"] .set-title')).toHaveText(t.rows.enabled.title)

  const sw = page.locator('#set-autoMontage-enabled')
  await expect(sw).toHaveAttribute('role', 'switch')
  await expect(sw).not.toBeChecked()
  // Sub-options are disabled while off.
  await expect(page.locator('#set-autoMontage-minClips')).toBeDisabled()

  // postAnalysis is "none": turning on asks first; Cancel leaves everything unchanged.
  await sw.click()
  const dlg = page.getByRole('alertdialog', { name: t.enableDialog.title })
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: t.enableDialog.cancel, exact: true }).click()
  await expect(dlg).toBeHidden()
  await expect(sw).not.toBeChecked()
  expect((await api<MontageSettingsView>(page, 'api.settings.get()')).recording.autoMontage.enabled).toBe(false)

  // Confirm: Auto montage on and analysis switched to after each match.
  await sw.click()
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: t.enableDialog.confirm, exact: true }).click()
  await expect(dlg).toBeHidden()
  await expect(sw).toBeChecked()
  await expect(page.locator('#set-autoMontage-minClips')).toBeEnabled()
  await expect
    .poll(async () => {
      const v = await api<MontageSettingsView>(page, 'api.settings.get()')
      return [v.recording.autoMontage.enabled, v.recording.postAnalysis]
    })
    .toEqual([true, 'perMatch'])
  await expect.poll(() => (readSettings(app).recording as MontageSettingsView['recording']).autoMontage.enabled).toBe(true)
  // With Auto montage on, the recording panel shows the idle line.
  const panel = await openRecordingPanel(page)
  await expect(panel.locator('#rec-montage-status')).toHaveText(s.idleEach)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  // Off again: no dialog, persisted, postAnalysis stays perMatch.
  await openRecordingSettings(page)
  await expect(sw).toBeChecked()
  await sw.click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(sw).not.toBeChecked()
  await expect
    .poll(async () => {
      const v = await api<MontageSettingsView>(page, 'api.settings.get()')
      return [v.recording.autoMontage.enabled, v.recording.postAnalysis]
    })
    .toEqual([false, 'perMatch'])
  await expect.poll(() => (readSettings(app).recording as MontageSettingsView['recording']).autoMontage.enabled).toBe(false)
})

test('recording panel: seeded montage jobs show "Montage ready" with Open, then a skipped job with its reason', async ({ launch }) => {
  // First launch only to create the appData root; jobs are seeded while the app is closed.
  const app = await launch({ settings: { language: 'en' } })
  const { root, dataDir } = app
  await app.closeWindow()

  const t0 = Date.now() - 60_000
  const doneSrc = path.join(root, 'Recordings', '2026-11-15', 'Valorant_2026-11-15_21-08.mp4')
  const skipSrc = path.join(root, 'Recordings', '2026-11-15', 'Valorant_2026-11-15_21-48.mp4')
  const doneId = montageJobId(doneSrc)
  const skipId = montageJobId(skipSrc)
  const done = (createdAt: number): MontageJob => ({
    id: doneId,
    sourcePath: doneSrc,
    game: 'valorant',
    state: 'done',
    progress: 1,
    clipCount: 4,
    totalSec: 19.2,
    outputPath: path.join(root, 'Montages', '2026-11-15', 'Montage_Valorant_2026-11-15_21-08.mp4'),
    projectId: montageProjectId(doneId),
    formatPreset: 'youtube',
    createdAt,
    updatedAt: createdAt + 1000,
    attempts: 0
  })
  const skipped = (createdAt: number): MontageJob => ({
    id: skipId,
    sourcePath: skipSrc,
    game: 'valorant',
    state: 'skipped',
    skipReason: 'tooFew',
    progress: 0,
    clipCount: 1,
    createdAt,
    updatedAt: createdAt + 1000,
    attempts: 0
  })

  // The panel shows the most recent job: the done one first.
  const jobsFile = seedJobs(dataDir, [skipped(t0), done(t0 + 10_000)])
  const a1 = await launch({ root, ownRoot: true })
  const status = await api<{ active: unknown; jobs: MontageJob[] }>(a1.page, 'api.montage.getStatus()')
  expect(status.active).toBeNull()
  expect(status.jobs.map((j) => [j.id, j.state])).toEqual([[doneId, 'done'], [skipId, 'skipped']])
  const p1 = await openRecordingPanel(a1.page)
  await expect(p1.locator('#rec-montage-status')).toHaveText(s.done.replace('{n}', '4').replace('{dur}', formatTime(19.2)))
  await expect(p1.locator('#rec-montage-status')).toContainText('Montage ready')
  await expect(p1.getByRole('button', { name: s.open, exact: true })).toBeVisible()
  await expect(p1.getByRole('button', { name: s.retry, exact: true })).toHaveCount(0)
  // Auto montage is off in these settings: terminal jobs are left as they were (start() only cancels unfinished jobs).
  await a1.closeWindow()
  const kept = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')) as { jobs: MontageJob[] }
  expect(kept.jobs.map((j) => j.state).sort()).toEqual(['done', 'skipped'])

  // Skipped job most recent: its reason and Retry.
  seedJobs(dataDir, [done(t0), skipped(t0 + 10_000)])
  const a2 = await launch({ root, ownRoot: true })
  const p2 = await openRecordingPanel(a2.page)
  await expect(p2.locator('#rec-montage-status')).toHaveText(s.skipped.tooFewOne)
  await expect(p2.getByRole('button', { name: s.retry, exact: true })).toBeVisible()
  await expect(p2.getByRole('button', { name: s.open, exact: true })).toHaveCount(0)
})
