/** In-game overlay contract between main (main/overlay/) and the overlay page (renderer/overlay/). */
import type { OverlayPosition } from './recording'

/** Accent of a card's stripe and title, styled after a kill-feed row: orange for recording/kills, blue for info. */
export type OverlayTone = 'rec' | 'kill' | 'info' | 'ok' | 'loss' | 'warn' | 'error'

export type OverlayIcon = 'rec' | 'crosshair' | 'pause' | 'play' | 'stop' | 'save' | 'match' | 'round' | 'disk' | 'swap' | 'warn' | 'error' | 'spark' | 'check'

export interface OverlayCard {
  /** Same id = update the visible card in place (a growing multi-kill), new id = a new card. */
  id: string
  tone: OverlayTone
  icon: OverlayIcon
  /** Bold, coloured, left side. */
  title: string
  /** Grey, right side. */
  detail: string
  durationMs: number
}

export interface OverlayFrame {
  card: OverlayCard
  position: OverlayPosition
  opacity: number
}

/** Cards visible at once; older ones leave first. */
export const OVERLAY_MAX_CARDS = 3
/** Overlay window size in DIP: three stacked cards with room for the slide-in. */
export const OVERLAY_WINDOW_SIZE = { width: 440, height: 220 } as const
/** Distance from the screen corner in DIP. */
export const OVERLAY_MARGIN = 24

export const OVERLAY_CHANNELS = {
  /** main → overlay page: show or update one card. */
  card: 'overlay:card',
  /** renderer (settings) → main: show sample cards. */
  test: 'overlay:test'
} as const

/** Card title for `count` kills in one round (one card per round, updated in place). */
export function multiKillLevel(count: number): 1 | 2 | 3 | 4 | 5 {
  return Math.max(1, Math.min(5, Math.floor(count))) as 1 | 2 | 3 | 4 | 5
}
