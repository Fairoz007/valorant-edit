import { describe, expect, it, vi } from 'vitest'
import { broadcastMontageStatus, registerMontageIpc } from './montage-ipc'
import { MONTAGE_CHANNELS, type MontageStatus } from '../../shared/montage'

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
    invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  }
}

const status: MontageStatus = { active: null, jobs: [] }
const service = () => ({
  status: vi.fn(() => status),
  open: vi.fn(async () => ({ projectId: 'p_m_0123456789abcdef' })),
  retry: vi.fn(() => true),
  cancel: vi.fn(async () => true)
})

describe('registerMontageIpc', () => {
  it('routes the four invoke channels to the service', async () => {
    const ipc = fakeIpc()
    const s = service()
    registerMontageIpc(ipc, s)
    const id = 'm_0123456789abcdef'
    expect(await ipc.invoke(MONTAGE_CHANNELS.status)).toBe(status)
    expect(await ipc.invoke(MONTAGE_CHANNELS.open, id)).toEqual({ projectId: 'p_m_0123456789abcdef' })
    expect(await ipc.invoke(MONTAGE_CHANNELS.retry, id)).toBe(true)
    expect(await ipc.invoke(MONTAGE_CHANNELS.cancel, id)).toBe(true)
    expect(s.open).toHaveBeenCalledWith(id)
    expect(s.retry).toHaveBeenCalledWith(id)
    expect(s.cancel).toHaveBeenCalledWith(id)
  })

  it.each([MONTAGE_CHANNELS.open, MONTAGE_CHANNELS.retry, MONTAGE_CHANNELS.cancel])('%s rejects malformed job ids before reaching the service', async (channel) => {
    const ipc = fakeIpc()
    const s = service()
    registerMontageIpc(ipc, s)
    for (const bad of [undefined, null, 42, '', 'm_123', 'M_0123456789ABCDEF', '../m_0123456789abcdef', 'm_0123456789abcdefg', { id: 'm_0123456789abcdef' }]) {
      await expect(ipc.invoke(channel, bad)).rejects.toThrow()
    }
    expect(s.open).not.toHaveBeenCalled()
    expect(s.retry).not.toHaveBeenCalled()
    expect(s.cancel).not.toHaveBeenCalled()
  })

  it('unregister removes the handlers', () => {
    const ipc = fakeIpc()
    const off = registerMontageIpc(ipc, service())
    expect(ipc.handlers.size).toBe(4)
    off()
    expect(ipc.handlers.size).toBe(0)
  })
})

describe('broadcastMontageStatus', () => {
  it('sends montage:changed to live windows only and survives a failing window', () => {
    const send = vi.fn()
    const live = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    const dead = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: vi.fn() } }
    const broken = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error('gone') } } }
    broadcastMontageStatus([broken, dead, live], status)
    expect(send).toHaveBeenCalledWith(MONTAGE_CHANNELS.changed, status)
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })
})
