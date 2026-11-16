import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GAME_IDS } from '../../shared/games'
import { createGameProcessFinder, findGameProcess, GameWatcher, parseGameProcess, sameProcess } from './game-watcher'

const tasklist = vi.hoisted(() => vi.fn<(file: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string) => void) => void>())
vi.mock('child_process', () => ({ execFile: tasklist }))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Filtered game process queries', () => {
  beforeEach(() => { tasklist.mockReset() })

  it('queries games one at a time with their image filters and preserves execution limits', async () => {
    tasklist.mockImplementation((_file, _args, _options, callback) => callback(null, ''))
    await expect(findGameProcess(GAME_IDS, 'win32')).resolves.toBeNull()
    const options = { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
    expect(tasklist.mock.calls).toEqual([
      ['tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq r5apex*'], options, expect.any(Function)],
      ['tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq VALORANT-Win64-Shipping.exe'], options, expect.any(Function)]
    ])
  })

  it('by default detects only VALORANT, and never queries off Windows', async () => {
    tasklist.mockImplementation((_file, _args, _options, callback) => callback(null, '"r5apex.exe","123"'))
    await expect(findGameProcess(undefined, 'win32')).resolves.toBeNull()
    expect(tasklist.mock.calls.map((call) => call[1].at(-1))).toEqual(['IMAGENAME eq VALORANT-Win64-Shipping.exe'])
    tasklist.mockClear()
    await expect(findGameProcess(undefined, 'darwin')).resolves.toBeNull()
    expect(tasklist).not.toHaveBeenCalled()
  })

  it('never runs two tasklist processes at once', async () => {
    const pending = findGameProcess(GAME_IDS, 'win32')
    expect(tasklist).toHaveBeenCalledTimes(1)
    tasklist.mock.calls[0][3](null, '')
    await vi.waitFor(() => expect(tasklist).toHaveBeenCalledTimes(2))
    tasklist.mock.calls[1][3](null, '"VALORANT-Win64-Shipping.exe","456"')
    await expect(pending).resolves.toEqual({ game: 'valorant', pid: 456 })
  })

  it('stops after the first matching game', async () => {
    tasklist.mockImplementation((_file, _args, _options, callback) => callback(null, '"r5apex_dx12.exe","123"'))
    await expect(findGameProcess(GAME_IDS, 'win32')).resolves.toEqual({ game: 'apex', pid: 123 })
    expect(tasklist).toHaveBeenCalledTimes(1)
  })

  it('ignores localized no-match output and validates wildcard results with the process regex', async () => {
    tasklist
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, 'INFO: 沒有符合指定準則的工作。\r\n"r5apex_launcher.exe","55"'))
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, '"VALORANT-Win64-Shipping.exe","456"'))
    await expect(findGameProcess(GAME_IDS, 'win32')).resolves.toEqual({ game: 'valorant', pid: 456 })
  })

  it('rejects when a query fails, so a failed query is never read as "no game"', async () => {
    const error = new Error('tasklist failed')
    tasklist
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, ''))
      .mockImplementationOnce((_file, _args, _options, callback) => callback(error, ''))
    await expect(findGameProcess(GAME_IDS, 'win32')).rejects.toBe(error)
  })

  it.each([0xC0000142, 0x40010004])('retries a query once when tasklist exits with transient code %i, and rejects if it fails again', async (code) => {
    vi.useFakeTimers()
    const dllInit = Object.assign(new Error('Command failed: tasklist'), { code })
    tasklist
      .mockImplementationOnce((_file, _args, _options, callback) => callback(dllInit, ''))
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, '"r5apex.exe","77"'))
    const found = findGameProcess(GAME_IDS, 'win32')
    await vi.runAllTimersAsync()
    await expect(found).resolves.toEqual({ game: 'apex', pid: 77 })
    expect(tasklist).toHaveBeenCalledTimes(2)

    tasklist.mockReset()
    tasklist.mockImplementation((_file, _args, _options, callback) => callback(dllInit, ''))
    const failed = findGameProcess(GAME_IDS, 'win32')
    const assertion = expect(failed).rejects.toBe(dllInit)
    await vi.runAllTimersAsync()
    await assertion
    expect(tasklist).toHaveBeenCalledTimes(2)
  })
})

describe('Game process polling never opens the game process', () => {
  const game = { game: 'valorant' as const, pid: 123 }
  const interval = 3000

  function watch(initial: typeof game | null = game) {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(initial)
    // process.kill(pid, 0) is OpenProcess(PROCESS_TERMINATE | ...) on Windows; any call is a regression.
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const changed = vi.fn()
    const failed = vi.fn()
    const watcher = new GameWatcher(createGameProcessFinder(find), interval, changed, failed, sameProcess)
    watcher.start()
    return { find, kill, changed, failed, watcher }
  }

  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('queries by image name on every poll and never calls process.kill', async () => {
    const { find, kill, changed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(changed.mock.calls).toEqual([[game]])
    await vi.advanceTimersByTimeAsync(interval * 20)
    expect(find).toHaveBeenCalledTimes(21)
    expect(kill).not.toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith(game)
    watcher.stop()
  })

  it('debounces an exit across two polls', async () => {
    const { find, kill, changed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    find.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed.mock.calls).toEqual([[null]])
    expect(kill).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('reports a replacement PID after two polls', async () => {
    const { find, changed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    const next = { game: 'valorant' as const, pid: 456 }
    find.mockResolvedValue(next)
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed.mock.calls).toEqual([[next]])
    watcher.stop()
  })

  it('a failed query is reported and never read as an exit', async () => {
    const { find, changed, failed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    const error = new Error('enumeration failed')
    find.mockRejectedValueOnce(error)
    await vi.advanceTimersByTimeAsync(interval)
    expect(failed.mock.calls).toEqual([[error]])
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed.mock.calls).toEqual([[game]])
    watcher.stop()
  })
})

describe('Game process detection', () => {
  it('accepts only exact game filenames and valid PIDs, returning the first matching process', () => {
    expect(parseGameProcess('INFO: 沒有符合的工作')).toBeNull()
    expect(parseGameProcess('"r5apex_launcher.exe","55","Console"\n"r5apex.exe","0","Console"')).toBeNull()
    expect(parseGameProcess('"R5APEX_DX12.EXE","123","Console","1","10,000 K"\r\n"r5apex.exe","456"')).toEqual({ game: 'apex', pid: 123 })
    expect(parseGameProcess('"VALORANT.exe","70","Console"\n"VALORANT-Win64-Shipping.exe","71","Console"'))
      .toEqual({ game: 'valorant', pid: 71 })
    expect(parseGameProcess('"svchost.exe","4","Services"\n"VALORANT-Win64-Shipping.exe","8","Console"\n"r5apex.exe","9","Console"'))
      .toEqual({ game: 'valorant', pid: 8 })
  })

  it('treats the same PID under another game as a different process', () => {
    expect(sameProcess({ game: 'apex', pid: 1 }, { game: 'apex', pid: 1 })).toBe(true)
    expect(sameProcess({ game: 'apex', pid: 1 }, { game: 'valorant', pid: 1 })).toBe(false)
    expect(sameProcess(null, null)).toBe(true)
    expect(sameProcess(null, { game: 'apex', pid: 1 })).toBe(false)
  })

  it.each([null, 123])('reports the first successful poll immediately for %s', async (pid) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(pid)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(find).toHaveBeenCalledOnce()
    expect(changed.mock.calls).toEqual([[pid]])
    watcher.stop()
  })

  it.each([null, 456])('ignores a transient %s while the same PID remains running', async (transient) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(123)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    find.mockResolvedValueOnce(transient)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(changed.mock.calls).toEqual([[123]])
    watcher.stop()
  })

  it.each([[123, null], [null, 123], [123, 456]])('confirms %s -> %s only after two equal successful polls', async (initial, next) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(initial)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    find.mockResolvedValue(next)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[next]])
    // Stable polls still drive the session's launch-delay checks.
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[next], [next]])
    watcher.stop()
  })

  it.each([[123, null], [null, 123], [123, 456]])('preserves the pending %s -> %s confirmation across query failures', async (initial, next) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(initial)
    const changed = vi.fn()
    const failed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, failed)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    find.mockResolvedValue(next)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    const error = new Error('tasklist failed')
    find.mockRejectedValueOnce(error)
    await vi.advanceTimersByTimeAsync(3000)
    expect(failed).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith(error)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[next]])
    watcher.stop()
    await vi.advanceTimersByTimeAsync(30000)
    expect(find).toHaveBeenCalledTimes(4)
  })

  it('reports the first successful result immediately even after a failed query', async () => {
    vi.useFakeTimers()
    const find = vi.fn().mockRejectedValueOnce(new Error('tasklist failed')).mockResolvedValue(123)
    const changed = vi.fn()
    const failed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, failed)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(failed).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[123]])
    watcher.stop()
  })

  it('reports the first result immediately after restarting with a pending candidate', async () => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(123)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    find.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(3000)
    watcher.stop()
    changed.mockClear()
    find.mockResolvedValue(456)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(changed.mock.calls).toEqual([[456]])
    watcher.stop()
  })

  it('ignores pending queries after stop and prevents overlapping polls', async () => {
    vi.useFakeTimers()
    let resolve!: (pid: number | null) => void
    const find = vi.fn(() => new Promise<number | null>((r) => { resolve = r }))
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(15000)
    expect(find).toHaveBeenCalledOnce()
    watcher.stop()
    resolve(123)
    await vi.advanceTimersByTimeAsync(15000)
    expect(changed).not.toHaveBeenCalled()
    expect(find).toHaveBeenCalledOnce()
  })
})
