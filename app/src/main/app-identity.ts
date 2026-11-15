/**
 * Windows identity for toasts and the taskbar. Must match `appId` in `app/electron-builder.yml`: without it,
 * notifications show a generic Electron identity (and none at all for the portable build).
 */
export const APP_USER_MODEL_ID = 'com.valoranteditor.app'

export function applyAppUserModelId(app: { setAppUserModelId(id: string): void }, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
}
