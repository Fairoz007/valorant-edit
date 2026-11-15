/** Preload for the in-game overlay page: it can only receive cards (no other API). */
import { contextBridge, ipcRenderer } from 'electron'
import { OVERLAY_CHANNELS, type OverlayFrame } from '../shared/overlay'

contextBridge.exposeInMainWorld('overlay', {
  onCard: (listener: (frame: OverlayFrame) => void): void => {
    ipcRenderer.on(OVERLAY_CHANNELS.card, (_event, frame: OverlayFrame) => listener(frame))
  }
})
