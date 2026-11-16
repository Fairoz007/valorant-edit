import { execFile } from 'child_process'
import { GAMES, GAME_IDS, SUPPORTED_GAME_IDS, type GameId } from '../../shared/games'

export interface GameProcess {
  game: GameId
  pid: number
}

/** Returns the first supported game in `tasklist /FO CSV /NH` output, in listing order. */
export function parseGameProcess(output: string): GameProcess | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim())
    if (!match) continue
    const game = GAME_IDS.find((id) => GAMES[id].process.test(match[1]))
    const pid = Number(match[2])
    if (game && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff) return { game, pid }
  }
  return null
}

// Exit codes of a tasklist that never ran its query; one retry usually succeeds.
const TRANSIENT_EXIT_CODES = new Set<unknown>([
  // STATUS_DLL_INIT_FAILED: tasklist could not start; seen on idle or low-memory machines even with one query at a time.
  0xC0000142,
  // DBG_TERMINATE_PROCESS: tasklist was terminated from outside, likely by session end or security software; seen in v0.4.6.
  0x40010004
])
const TRANSIENT_RETRY_MS = 500

async function queryGame(game: GameId): Promise<GameProcess | null> {
  try {
    return await runTasklist(game)
  } catch (error) {
    if (!TRANSIENT_EXIT_CODES.has((error as { code?: unknown }).code)) throw error
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_MS))
    return runTasklist(game)
  }
}

function runTasklist(game: GameId): Promise<GameProcess | null> {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${GAMES[game].tasklistImageFilter}`],
      { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else {
          // Only accept the queried game, even if the filtered output somehow lists another one.
          const found = parseGameProcess(stdout)
          resolve(found?.game === game ? found : null)
        }
      })
  })
}

/**
 * One `tasklist` at a time, in SUPPORTED_GAME_IDS priority order. Spawning one per game concurrently made
 * tasklist fail with 0xC0000142 (DLL initialization failed) on several machines since v0.4.5.
 */
export async function findGameProcess(
  games: readonly GameId[] = SUPPORTED_GAME_IDS,
  platform: NodeJS.Platform = process.platform
): Promise<GameProcess | null> {
  // Process detection uses Windows `tasklist`; recording is Windows-only, so other platforms never see a running game.
  if (platform !== 'win32') return null
  for (const game of games) {
    const match = await queryGame(game)
    if (match) return match
  }
  return null
}

/**
 * Every poll asks Windows for the game by image name (`tasklist`, which reads the system process list).
 * It never opens the game process: `process.kill(pid, 0)` looked cheaper, but on Windows libuv implements it as
 * `OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE)`, so it opened a terminate-rights handle to the
 * Vanguard-protected VALORANT process every 3 seconds (docs/recording-mouse-input-fix.md).
 */
export function createGameProcessFinder(find = findGameProcess): () => Promise<GameProcess | null> {
  return () => find()
}

export function sameProcess(a: GameProcess | null, b: GameProcess | null): boolean {
  return a === b || (a !== null && b !== null && a.game === b.game && a.pid === b.pid)
}

/** Polls never overlap; a failed process query does not mean the game has closed. */
export class GameWatcher<T> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private candidate: T | null = null
  private count = 0

  constructor(
    private find: () => Promise<T | null>,
    private interval: number,
    private changed: (value: T | null) => void,
    private failed: (error: unknown) => void,
    private same: (a: T | null, b: T | null) => boolean = (a, b) => a === b
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.candidate = null
    this.count = 0
    void this.poll(++this.generation)
  }

  stop(): void {
    this.running = false
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async poll(generation: number): Promise<void> {
    try {
      const value = await this.find()
      if (!this.running || generation !== this.generation) return
      const firstPoll = this.count === 0
      this.count = this.same(value, this.candidate) ? Math.min(this.count + 1, 2) : 1
      this.candidate = value
      // Report startup presence immediately; debounce later transitions while retaining stable poll notifications.
      if (firstPoll || this.count >= 2) this.changed(value)
    } catch (error) {
      if (this.running && generation === this.generation) this.failed(error)
    }
    if (this.running && generation === this.generation) {
      this.timer = setTimeout(() => void this.poll(generation), this.interval)
      this.timer.unref()
    }
  }
}
