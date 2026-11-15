import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFocusGuard } from './focus-guard'
import { parseForeground } from './foreground'

afterEach(() => { vi.useRealTimers() })

/** A main window double that records every focus-affecting call. */
function windowDouble() {
  const calls: string[] = []
  return {
    calls,
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    showAndFocus() { this.show(); this.focus() }
  }
}

describe('No focus while the game is in front', () => {
  it('runs show/focus immediately when the game is not in front', async () => {
    const win = windowDouble()
    const guard = createFocusGuard({ isGameForeground: async () => false })
    expect(await guard.run('main', () => win.showAndFocus())).toBe(true)
    expect(win.calls).toEqual(['show', 'focus'])
  })

  it('never calls show/focus while the game is in front, and runs them once it loses focus', async () => {
    vi.useFakeTimers()
    let front = true
    const win = windowDouble()
    const guard = createFocusGuard({ isGameForeground: async () => front, retryMs: 1000 })
    expect(await guard.run('main', () => win.showAndFocus())).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(win.calls).toEqual([])
    expect(guard.pending()).toEqual(['main'])
    front = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(win.calls).toEqual(['show', 'focus'])
    expect(guard.pending()).toEqual([])
    guard.dispose()
  })

  it('a user request (tray click) is still deferred while the game is in front', async () => {
    const win = windowDouble()
    const guard = createFocusGuard({ isGameForeground: async () => true })
    expect(await guard.run('main', () => win.showAndFocus(), { userInitiated: true })).toBe(false)
    expect(win.calls).toEqual([])
    guard.dispose()
  })

  it('an unknown foreground blocks automatic actions but not user requests', async () => {
    const win = windowDouble()
    const guard = createFocusGuard({ isGameForeground: async () => null })
    expect(await guard.run('auto', () => win.show())).toBe(false)
    expect(await guard.run('tray', () => win.focus(), { userInitiated: true })).toBe(true)
    expect(win.calls).toEqual(['focus'])
    guard.dispose()
  })

  it('a failing foreground query counts as unknown', async () => {
    const win = windowDouble()
    const guard = createFocusGuard({ isGameForeground: async () => { throw new Error('boom') } })
    expect(await guard.run('auto', () => win.show())).toBe(false)
    expect(win.calls).toEqual([])
    guard.dispose()
  })

  it('keeps only the latest deferred action per key and flushes on demand (game exit)', async () => {
    let front = true
    const win = windowDouble()
    const guard = createFocusGuard({ isGameForeground: async () => front, retryMs: 60_000 })
    await guard.run('main', () => win.show())
    await guard.run('main', () => win.focus())
    await guard.run('error-box', () => win.calls.push('dialog'))
    front = false
    await guard.flush()
    expect(win.calls).toEqual(['focus', 'dialog'])
    guard.dispose()
  })

  it('drops deferred actions on dispose', async () => {
    vi.useFakeTimers()
    let front = true
    const win = windowDouble()
    const guard = createFocusGuard({ isGameForeground: async () => front, retryMs: 100 })
    await guard.run('main', () => win.show())
    guard.dispose()
    front = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(win.calls).toEqual([])
  })
})

describe('aditorrec --foreground output', () => {
  it('parses the recorder line', () => {
    expect(parseForeground('{"exclusive_fullscreen":false,"foreground_pid":42,"fullscreen_busy":false,"game_foreground":true,"game_rect":[0,0,1920,1080],"monitor_rect":[0,0,1920,1080]}\n'))
      .toEqual({ foregroundPid: 42, gameForeground: true, exclusiveFullscreen: false, gameRect: [0, 0, 1920, 1080], monitorRect: [0, 0, 1920, 1080] })
  })

  it('returns null for anything malformed', () => {
    expect(parseForeground('')).toBeNull()
    expect(parseForeground('internal: error')).toBeNull()
    expect(parseForeground('{"game_foreground":"yes"}')).toBeNull()
  })

  it('drops malformed rectangles', () => {
    expect(parseForeground('{"game_foreground":false,"foreground_pid":null,"game_rect":[1,2],"monitor_rect":null}')?.gameRect).toBeNull()
  })
})
