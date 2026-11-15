/**
 * Rule (docs/recording-mouse-input-fix.md): while a supported game is the foreground window, the app never calls show(), focus(),
 * moveTop(), flashFrame(), opens a dialog or creates a focusable window. Such actions go through this guard, which runs them
 * immediately when the game is not in front and otherwise defers them until it loses focus or exits.
 */
export interface FocusGuardDeps {
  /** true: the game is in front; false: it is not (or not running); null: unknown (query failed). */
  isGameForeground: () => Promise<boolean | null>
  /** How often deferred actions re-check the foreground (defaults to 2000 ms). */
  retryMs?: number
  log?: (message: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface FocusGuardRunOptions {
  /** The user just asked for this (tray click, second launch): an unknown foreground does not block it. A game in front still does. */
  userInitiated?: boolean
}

export interface FocusGuard {
  /**
   * Run `action` now if allowed, else keep it (the latest action per key wins) and retry. Resolves true when it ran now.
   * Actions never run concurrently with a pending check for the same key.
   */
  run(key: string, action: () => void, options?: FocusGuardRunOptions): Promise<boolean>
  /** Re-check now (for example right after the game exits). */
  flush(): Promise<void>
  /** Keys still waiting for the game to leave the foreground. */
  pending(): string[]
  dispose(): void
}

export function createFocusGuard(deps: FocusGuardDeps): FocusGuard {
  const retryMs = deps.retryMs ?? 2000
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const waiting = new Map<string, { action: () => void; userInitiated: boolean }>()
  let timer: unknown = null
  let disposed = false
  let checking: Promise<void> | null = null

  const log = (message: string): void => { try { deps.log?.(message) } catch { /* logging never blocks focus decisions */ } }

  const allowed = async (userInitiated: boolean): Promise<boolean> => {
    let front: boolean | null
    try { front = await deps.isGameForeground() } catch { front = null }
    if (front === null) return userInitiated
    return !front
  }

  const execute = (key: string, action: () => void): void => {
    try { action() } catch (error) { log(`focus-guard: ${key} failed: ${String(error)}`) }
  }

  const schedule = (): void => {
    if (disposed || timer !== null || waiting.size === 0) return
    timer = setTimer(() => { timer = null; void flush() }, retryMs)
  }

  const flush = (): Promise<void> => {
    if (checking) return checking
    checking = (async () => {
      if (disposed || waiting.size === 0) return
      if (timer !== null) { clearTimer(timer); timer = null }
      // Deferred actions were automatic or already waited once; an unknown foreground keeps them waiting.
      if (await allowed(false)) {
        const ready = [...waiting.entries()]
        waiting.clear()
        for (const [key, entry] of ready) {
          log(`focus-guard: running deferred ${key}`)
          execute(key, entry.action)
        }
      }
    })().finally(() => { checking = null; schedule() })
    return checking
  }

  return {
    async run(key, action, options = {}) {
      if (disposed) return false
      const userInitiated = options.userInitiated === true
      if (await allowed(userInitiated)) {
        if (disposed) return false
        waiting.delete(key)
        execute(key, action)
        return true
      }
      log(`focus-guard: deferred ${key} while the game is in front`)
      waiting.set(key, { action, userInitiated })
      schedule()
      return false
    },
    flush,
    pending: () => [...waiting.keys()],
    dispose() {
      disposed = true
      waiting.clear()
      if (timer !== null) clearTimer(timer)
      timer = null
    }
  }
}
