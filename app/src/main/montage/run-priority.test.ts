import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyProcessPriority, runExport, type ExportPriority } from '../export/run'

const FAKE = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')
const ffmpeg = { bin: process.execPath, prefixArgs: [FAKE] }
let outDir: string

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-prio-'))
  delete process.env.FAKE_FFMPEG_SLEEP_MS
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.FAKE_FFMPEG_SLEEP_MS
  fs.rmSync(outDir, { recursive: true, force: true })
})

const job = (name: string) => {
  const output = path.join(outDir, name)
  return { args: ['-i', 'in.mp4', '-y', output], output }
}

describe('runExport priority option', () => {
  it('applies the priority to each spawned ffmpeg right after spawn', async () => {
    const spy = vi.spyOn(os, 'setPriority').mockImplementation(() => undefined)
    const res = await runExport({ jobs: [job('a.mp4'), job('b.mp4')], totalEstimatedSeconds: 2, outDir, estimatedBytes: 1, ffmpeg, tempDir: outDir, priority: 'belowNormal' })
    expect(res.ok).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    for (const call of spy.mock.calls) {
      expect(call[0]).toEqual(expect.any(Number))
      expect(call[1]).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
    }
  })

  it('a getter is re-read on progress, so a running export can drop to idle', async () => {
    const spy = vi.spyOn(os, 'setPriority').mockImplementation(() => undefined)
    process.env.FAKE_FFMPEG_SLEEP_MS = '200'
    let level: ExportPriority = 'belowNormal'
    const res = await runExport(
      { jobs: [job('a.mp4')], totalEstimatedSeconds: 2, outDir, estimatedBytes: 1, ffmpeg, tempDir: outDir, priority: () => level },
      { onProgress: () => { level = 'idle' } }
    )
    expect(res.ok).toBe(true)
    expect(spy.mock.calls.map((c) => c[1])).toEqual([os.constants.priority.PRIORITY_BELOW_NORMAL, os.constants.priority.PRIORITY_LOW])
  })

  it('without the option no priority is set, and setPriority errors are ignored', async () => {
    const spy = vi.spyOn(os, 'setPriority').mockImplementation(() => {
      throw new Error('EPERM')
    })
    expect((await runExport({ jobs: [job('a.mp4')], totalEstimatedSeconds: 1, outDir, estimatedBytes: 1, ffmpeg, tempDir: outDir })).ok).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    expect((await runExport({ jobs: [job('b.mp4')], totalEstimatedSeconds: 1, outDir, estimatedBytes: 1, ffmpeg, tempDir: outDir, priority: 'idle' })).ok).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    expect(applyProcessPriority(undefined, 'idle')).toBe(false)
    expect(applyProcessPriority(123, 'idle')).toBe(false)
  })

  it('really lowers a child process priority (no mock)', async () => {
    const { spawn } = await import('child_process')
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' })
    try {
      expect(applyProcessPriority(child.pid, 'belowNormal')).toBe(true)
      expect(os.getPriority(child.pid!)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
    } finally {
      child.kill()
    }
  })
})
