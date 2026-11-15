/**
 * Auto montage IPC (no Electron dependency; tests pass a fake ipcMain and window list).
 * invoke: `montage:status`, `montage:open`, `montage:retry`, `montage:cancel`; push: `montage:changed` (MontageStatus) to every window.
 */
import { MONTAGE_CHANNELS, type MontageStatus } from '../../shared/montage'
import { sanitizeMontageJobId } from '../ipc-guards'
import type { MontageService } from './montage-service'

export interface MontageIpcMain {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler?(channel: string): void
}

export interface MontageWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, payload: MontageStatus): void }
}

export function registerMontageIpc(ipcMain: MontageIpcMain, service: Pick<MontageService, 'status' | 'open' | 'retry' | 'cancel'>): () => void {
  ipcMain.handle(MONTAGE_CHANNELS.status, () => service.status())
  ipcMain.handle(MONTAGE_CHANNELS.open, (_event, raw) => service.open(sanitizeMontageJobId(raw)))
  ipcMain.handle(MONTAGE_CHANNELS.retry, (_event, raw) => service.retry(sanitizeMontageJobId(raw)))
  ipcMain.handle(MONTAGE_CHANNELS.cancel, (_event, raw) => service.cancel(sanitizeMontageJobId(raw)))
  return () => {
    for (const channel of [MONTAGE_CHANNELS.status, MONTAGE_CHANNELS.open, MONTAGE_CHANNELS.retry, MONTAGE_CHANNELS.cancel]) {
      ipcMain.removeHandler?.(channel)
    }
  }
}

/** Push a status to every live window; a window closing mid-send is ignored. */
export function broadcastMontageStatus(windows: readonly MontageWindow[], status: MontageStatus): void {
  for (const win of windows) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(MONTAGE_CHANNELS.changed, status)
    } catch (err) {
      console.error('[montage] Failed to publish status:', err)
    }
  }
}
