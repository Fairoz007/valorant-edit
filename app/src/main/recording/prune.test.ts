import { afterEach, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { pruneSegments } from './prune'
import { sessionDir, tempRoot } from './test-support'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
it('keeps only the most recent 15 seconds in a long lobby while leaving the index and initialization file unchanged', async () => {
  const root = tempRoot(); roots.push(root)
  const dir = sessionDir(root)
  const segments = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  for (const s of segments) fs.writeFileSync(path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`), '片段')
  fs.writeFileSync(path.join(dir, 'init.mp4'), '初始化')
  fs.writeFileSync(path.join(dir, 'index.jsonl'), '索引')
  const removed = await pruneSegments(dir, segments, [], null)
  expect(removed).toHaveLength(191)
  expect(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8')).toBe('索引')
  expect(fs.readFileSync(path.join(dir, 'init.mp4'), 'utf8')).toBe('初始化')
  expect(fs.existsSync(path.join(dir, 'pruned.json'))).toBe(true)
})
it.each([
  { matches: [], pending: 20, first: 8 },
  { matches: [{ start: 20, end: null }], pending: null, first: 8 },
  { matches: [{ start: 20, end: 40 }], pending: null, first: 8 },
  { matches: [{ start: 20, end: 40 }, { start: 45, end: null }], pending: 45, first: 8 },
  { matches: [], pending: null, first: 42 }
])('protects countdowns, matches, delayed confirmation, and immediate next-match queues: %j', async ({ matches, pending, first }) => {
  const root = tempRoot(); roots.push(root); const dir = sessionDir(root)
  const segments = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  for (const s of segments) fs.writeFileSync(path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`), '片段')
  const removed = await pruneSegments(dir, segments, matches, pending)
  expect(removed.slice(0, first - 1)).toEqual(segments.slice(0, first - 1).map(s => s.seq))
  expect(removed).not.toContain(first)
  if (matches[0]?.end === 40) expect(removed).not.toContain(23)
})
it('cleans only processed segments when the engine is behind and preserves unprocessed countdown segments', async () => {
  const root = tempRoot(); roots.push(root); const dir = sessionDir(root)
  const segments = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  for (const s of segments) fs.writeFileSync(path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`), '片段')
  const removed = await pruneSegments(dir, segments, [], null, 100)
  expect(removed).toEqual(segments.slice(0, 42).map(s => s.seq))
})
it('VALORANT lobby → agent select → loading → match → menus: pruning while recording never touches the match, loading screen included', async () => {
  // Menus/queue 0–40 s, agent select 40–80 s, Riot Client INGAME (loading) 80 s, HUD 130 s, match over 360 s, menus to 400 s.
  const root = tempRoot(); roots.push(root); const dir = sessionDir(root)
  const segments = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  for (const s of segments) fs.writeFileSync(path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`), '片段')
  const removed = new Set(await pruneSegments(dir, segments, [{ start: 80, end: 360 }], null))
  // Agent select and the menus before the match are pruned (match start minus the 5 s pre-pad) …
  expect(segments.filter((s) => s.pts + s.dur <= 75).every((s) => removed.has(s.seq))).toBe(true)
  // … every second of the match (loading screen to end + 5 s) stays; the loading screen is cut only at finalization,
  // once the live rounds prove where gameplay starts.
  expect(segments.filter((s) => s.pts + s.dur > 75 && s.pts < 365).some((s) => removed.has(s.seq))).toBe(false)
  // The menus after the match are pruned too, apart from the last 15 s lobby buffer.
  expect(segments.filter((s) => s.pts >= 366 && s.pts + s.dur <= 398 - 15).every((s) => removed.has(s.seq))).toBe(true)
})
