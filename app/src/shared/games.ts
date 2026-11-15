import path from 'path'

/** Games Valorant Editor can record and analyze; the engine takes the same ids as `--game`. */
export type GameId = 'apex' | 'valorant'

export interface GameDescriptor {
  id: GameId
  displayName: string
  /** Matches the image name column of `tasklist /FO CSV` (without quotes). */
  process: RegExp
  tasklistImageFilter: string
  /** Recording file name prefix, e.g. `Apex_2026-10-20_21-08.mp4`. */
  filePrefix: string
  /** Template folder under `templates/`; Apex keeps the original top-level `icons`/`scene` layout. */
  templateDir: string
}

export const GAMES: Record<GameId, GameDescriptor> = {
  apex: { id: 'apex', displayName: 'Apex Legends', process: /^r5apex(?:_dx12)?\.exe$/i, tasklistImageFilter: 'r5apex*', filePrefix: 'Apex', templateDir: '' },
  valorant: { id: 'valorant', displayName: 'VALORANT', process: /^VALORANT-Win64-Shipping\.exe$/i, tasklistImageFilter: 'VALORANT-Win64-Shipping.exe', filePrefix: 'Valorant', templateDir: 'valorant' }
}

/** Every game id the engine and stored data know about (Apex is inherited from Aditor). */
export const GAME_IDS = Object.keys(GAMES) as GameId[]
/** Legacy default: older recordings, caches and library entries without a game were all Apex. */
export const DEFAULT_GAME: GameId = 'apex'

/** The game Valorant Editor is built for: every import is analyzed as VALORANT and only VALORANT is recorded. */
export const PRODUCT_GAME: GameId = 'valorant'
/** Games offered in the UI, detected for recording and analyzed. */
export const SUPPORTED_GAME_IDS: readonly GameId[] = [PRODUCT_GAME]

export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAMES, value)
}

/** Older recordings, caches and library entries carry no game; they were all Apex. */
export function gameOf(value: unknown): GameId {
  return isGameId(value) ? value : DEFAULT_GAME
}

/** `templates/icons` for Apex, `templates/<game>/icons` otherwise; `apexProfileDir` is the shipped `templates/icons`. */
export function gameProfileDir(apexProfileDir: string, game: GameId): string {
  const dir = GAMES[game].templateDir
  return dir ? path.join(path.dirname(apexProfileDir), dir, 'icons') : apexProfileDir
}

export function gameSceneDir(apexProfileDir: string, game: GameId): string {
  return path.join(path.dirname(gameProfileDir(apexProfileDir, game)), 'scene')
}
