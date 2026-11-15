import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_USER_MODEL_ID, applyAppUserModelId } from './app-identity'

describe('applyAppUserModelId', () => {
  it('sets the AppUserModelId on Windows', () => {
    const app = { setAppUserModelId: vi.fn() }
    applyAppUserModelId(app, 'win32')
    expect(app.setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID)
  })

  it('does nothing on other platforms', () => {
    const app = { setAppUserModelId: vi.fn() }
    applyAppUserModelId(app, 'darwin')
    applyAppUserModelId(app, 'linux')
    expect(app.setAppUserModelId).not.toHaveBeenCalled()
  })

  it('matches the electron-builder appId', () => {
    const yml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(yml).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, '\.')}\s*$`, 'm'))
  })
})
