import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MontageJobStore, canTransition, parseJob } from './montage-job'
import { montageJobId, type MontageJobState } from '../../shared/montage'

let dir: string
let file: string
let t = 1000
const now = (): number => ++t
const SRC = 'D:/Videos/Recordings/2026-11-15/Valorant_2026-11-15_21-08.mp4'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-jobs-'))
  file = path.join(dir, 'montage', 'jobs.json')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('MontageJobStore', () => {
  it('creates one job per match, idempotently, with the derived id', () => {
    const store = new MontageJobStore(file, { now })
    const a = store.create(SRC, 'valorant')
    const b = store.create(SRC.replace(/\//g, '\\').toUpperCase(), 'valorant')
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(a.job.id).toBe(montageJobId(SRC))
    expect(b.job.id).toBe(a.job.id)
    expect(store.list()).toHaveLength(1)
    expect(a.job).toMatchObject({ state: 'recorded', progress: 0, attempts: 0 })
  })

  it('persists every state change atomically and reloads it', () => {
    const store = new MontageJobStore(file, { now })
    const { job } = store.create(SRC, 'valorant')
    store.transition(job.id, 'analyzing')
    store.transition(job.id, 'selecting')
    store.transition(job.id, 'exporting', { clipCount: 3, totalSec: 42, formatPreset: 'shorts', projectId: 'p_x' })
    expect(fs.existsSync(file + '.tmp')).toBe(false)
    const reloaded = new MontageJobStore(file, { now })
    expect(reloaded.get(job.id)).toMatchObject({ state: 'exporting', clipCount: 3, totalSec: 42, formatPreset: 'shorts', projectId: 'p_x' })
  })

  it('progress-only patches stay in memory', () => {
    const store = new MontageJobStore(file, { now })
    const { job } = store.create(SRC, 'valorant')
    store.transition(job.id, 'analyzing')
    store.transition(job.id, 'selecting')
    store.transition(job.id, 'exporting')
    store.patch(job.id, { progress: 0.5 })
    expect(store.get(job.id)?.progress).toBe(0.5)
    expect(new MontageJobStore(file).get(job.id)?.progress).toBe(0)
  })

  it('a corrupt file is backed up and the store starts empty', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json')
    const store = new MontageJobStore(file, { now })
    expect(store.list()).toEqual([])
    expect(store.corruptBackup).toMatch(/jobs\.bak\.\d+\.json$/)
    expect(fs.readFileSync(store.corruptBackup!, 'utf8')).toBe('{ not json')
    expect(fs.existsSync(file)).toBe(false)
    store.create(SRC, 'valorant')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).jobs).toHaveLength(1)
  })

  it('invalid records are dropped (file copied aside) and valid ones kept', () => {
    const store = new MontageJobStore(file, { now })
    store.create(SRC, 'valorant')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    data.jobs.push({ id: 'm_0000000000000000', sourcePath: 'D:/other.mp4', game: 'valorant', state: 'done', createdAt: 1, updatedAt: 1 })
    data.jobs.push({ id: 'nope' })
    fs.writeFileSync(file, JSON.stringify(data))
    const reloaded = new MontageJobStore(file, { now })
    expect(reloaded.list().map((j) => j.sourcePath)).toEqual([SRC])
    expect(reloaded.corruptBackup).not.toBeNull()
  })

  it('terminal states are never re-entered automatically; only retry leaves skipped/failed/cancelled', () => {
    const store = new MontageJobStore(file, { now })
    const { job } = store.create(SRC, 'valorant')
    store.transition(job.id, 'analyzing')
    store.transition(job.id, 'skipped', { skipReason: 'tooFew' })
    for (const to of ['analyzing', 'selecting', 'exporting', 'done', 'deferred', 'failed'] as MontageJobState[]) {
      expect(store.transition(job.id, to)).toBeNull()
    }
    const retried = store.retry(job.id)
    expect(retried).toMatchObject({ state: 'selecting', attempts: 1 })
    expect(retried?.skipReason).toBeUndefined()
    store.transition(job.id, 'exporting')
    store.transition(job.id, 'done', { outputPath: 'D:/m.mp4' })
    expect(store.get(job.id)).toMatchObject({ state: 'done', progress: 1 })
    expect(store.retry(job.id)).toBeNull()
    expect(store.transition(job.id, 'selecting')).toBeNull()
  })

  it('retry is refused for running and done jobs', () => {
    const store = new MontageJobStore(file, { now })
    const { job } = store.create(SRC, 'valorant')
    store.transition(job.id, 'analyzing')
    expect(store.retry(job.id)).toBeNull()
    expect(store.retry('m_ffffffffffffffff')).toBeNull()
  })

  it('failed records the code and message; leaving failed clears them', () => {
    const store = new MontageJobStore(file, { now })
    const { job } = store.create(SRC, 'valorant')
    store.transition(job.id, 'analyzing')
    store.transition(job.id, 'failed', { failCode: 'verify', error: 'bad' })
    expect(store.get(job.id)).toMatchObject({ failCode: 'verify', error: 'bad' })
    const r = store.retry(job.id)!
    expect(r.failCode).toBeUndefined()
    expect(r.error).toBeUndefined()
  })

  it('keeps the most recent jobs and never prunes unfinished ones', () => {
    const store = new MontageJobStore(file, { now, keep: 3 })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const { job } = store.create(`D:/v/${i}.mp4`, 'valorant')
      ids.push(job.id)
      if (i !== 1) {
        store.transition(job.id, 'analyzing')
        store.transition(job.id, 'skipped', { skipReason: 'empty' })
      }
    }
    const kept = new MontageJobStore(file).list().map((j) => j.id)
    expect(kept).toHaveLength(3)
    expect(kept).toContain(ids[1])
    expect(kept).toContain(ids[4])
    expect(kept).not.toContain(ids[0])
  })

  it('list is most recent first', () => {
    const store = new MontageJobStore(file, { now })
    store.create('D:/v/a.mp4', 'valorant')
    store.create('D:/v/b.mp4', 'valorant')
    expect(store.list().map((j) => path.basename(j.sourcePath))).toEqual(['b.mp4', 'a.mp4'])
  })
})

describe('transitions', () => {
  it('follows the plan state machine', () => {
    expect(canTransition('recorded', 'analyzing')).toBe(true)
    expect(canTransition('analyzing', 'deferred')).toBe(true)
    expect(canTransition('deferred', 'selecting')).toBe(true)
    expect(canTransition('exporting', 'done')).toBe(true)
    expect(canTransition('recorded', 'done')).toBe(false)
    expect(canTransition('analyzing', 'exporting')).toBe(false)
    for (const s of ['done', 'skipped', 'failed', 'cancelled'] as MontageJobState[]) expect(canTransition(s, 'selecting')).toBe(false)
  })

  it('parseJob rejects an id that does not belong to its source', () => {
    const good = { id: montageJobId(SRC), sourcePath: SRC, game: 'valorant', state: 'done', createdAt: 1, updatedAt: 2 }
    expect(parseJob(good)).toMatchObject({ id: good.id, progress: 0, attempts: 0 })
    expect(parseJob({ ...good, sourcePath: 'D:/elsewhere.mp4' })).toBeNull()
    expect(parseJob({ ...good, state: 'bogus' })).toBeNull()
  })
})
