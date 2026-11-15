import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import os from 'os'

// Console-subsystem children (aditor.exe, ffmpeg.exe) flash a console window on Windows unless spawned with windowsHide.
const spawnSpy = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    spawnSpy(...args)
    return actual.spawn(...args)
  }
  return { ...actual, default: { ...actual, spawn }, spawn }
})

import { EngineClient } from './engine'
import { detectEncoders } from './export/encoders'

const FAKE_ENGINE = path.resolve(__dirname, '../../test/fake-engine.mjs')

describe('child processes are spawned hidden', () => {
  let client: EngineClient | null = null
  afterEach(async () => {
    await client?.stop()
    client = null
    spawnSpy.mockClear()
  })

  it('analysis engine', async () => {
    client = new EngineClient({ command: process.execPath, args: [FAKE_ENGINE] })
    await client.start()
    expect(spawnSpy).toHaveBeenCalledWith(process.execPath, [FAKE_ENGINE], expect.objectContaining({ windowsHide: true }))
  })

  it('ffmpeg -encoders listing', async () => {
    const missing = path.join(os.tmpdir(), 'aditor-missing-ffmpeg.exe')
    await detectEncoders(missing)
    const listing = spawnSpy.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('-encoders'))
    expect(listing?.[2]).toMatchObject({ windowsHide: true })
  })
})
