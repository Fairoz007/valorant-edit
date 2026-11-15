import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_CHANNELS } from '../shared/overlay'

const source = fs.readFileSync(path.join(__dirname, 'overlay.ts'), 'utf8')

describe('overlay preload', () => {
  it('imports nothing but electron, so the main preload never gets a shared chunk it cannot require in the sandbox', () => {
    const imports = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports).toEqual(['electron'])
  })

  it('listens on the channel main sends cards to', () => {
    expect(source).toContain(`const CARD_CHANNEL = '${OVERLAY_CHANNELS.card}'`)
  })
})
