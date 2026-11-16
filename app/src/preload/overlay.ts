/**
 * Preload for the in-game overlay page: it can only receive cards (no other API).
 *
 * Self-contained on purpose: it imports nothing but 'electron'. A module shared with the main preload would be split into a
 * separate chunk that the main preload then require()s, which sandboxed preloads cannot do, so window.api would vanish.
 * overlay-preload.test.ts pins both rules (imports, and the channel matching OVERLAY_CHANNELS.card).
 */
import { contextBridge, ipcRenderer } from 'electron'

const CARD_CHANNEL = 'overlay:card'

contextBridge.exposeInMainWorld('overlay', {
  onCard: (listener: (frame: unknown) => void): void => {
    ipcRenderer.on(CARD_CHANNEL, (_event, frame: unknown) => listener(frame))
  }
})
