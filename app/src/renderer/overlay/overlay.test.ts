// @vitest-environment jsdom
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contrast, parseCssVars } from '../a11y/contrast'
import type { OverlayCard, OverlayFrame } from '../../shared/overlay'
import { showCard } from './overlay'

const frame = (id: string, patch: Partial<OverlayCard> = {}, position: OverlayFrame['position'] = 'topRight'): OverlayFrame => ({
  card: { id, tone: 'kill', icon: 'crosshair', title: `T ${id}`, detail: `D ${id}`, durationMs: 3000, ...patch },
  position,
  opacity: 0.9
})

describe('Overlay page', () => {
  let stack: HTMLElement
  beforeEach(() => {
    vi.useFakeTimers()
    stack = document.createElement('div')
    document.body.replaceChildren(stack)
  })
  afterEach(() => vi.useRealTimers())

  const live = (): HTMLElement[] => [...stack.querySelectorAll<HTMLElement>('.card:not(.leaving)')]

  it('stacks newest first and keeps at most three cards', () => {
    for (const id of ['a', 'b', 'c', 'd']) showCard(stack, frame(id))
    expect(live().map((el) => el.querySelector('.title')?.textContent)).toEqual(['T d', 'T c', 'T b'])
    vi.advanceTimersByTime(400)
    expect(stack.querySelectorAll('.card')).toHaveLength(3)
  })

  it('a card with the same id updates in place (multi-kill → ACE)', () => {
    showCard(stack, frame('k', { title: 'KILL' }))
    showCard(stack, frame('k', { title: 'ACE' }))
    expect(live()).toHaveLength(1)
    expect(live()[0].querySelector('.title')?.textContent).toBe('ACE')
  })

  it('cards leave after their duration, and an update restarts the timer', () => {
    showCard(stack, frame('k', { durationMs: 1000 }))
    vi.advanceTimersByTime(800)
    showCard(stack, frame('k', { durationMs: 1000 }))
    vi.advanceTimersByTime(800)
    expect(live()).toHaveLength(1)
    vi.advanceTimersByTime(600)
    expect(live()).toHaveLength(0)
  })

  it('text is never parsed as HTML', () => {
    showCard(stack, frame('x', { title: '<img src=x onerror=alert(1)>', detail: '<b>bold</b>' }))
    expect(stack.querySelector('img')).toBeNull()
    expect(stack.querySelector('b')).toBeNull()
    expect(live()[0].querySelector('.title')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('applies the corner and opacity, and labels cards for screen readers', () => {
    showCard(stack, { ...frame('a', {}, 'bottomLeft'), opacity: 0.5 })
    expect(stack.className).toBe('stack bottom left')
    expect(stack.style.opacity).toBe('0.5')
    expect(live()[0].getAttribute('role')).toBe('status')
    expect(live()[0].getAttribute('aria-label')).toBe('T a D a')
  })
})

describe('Overlay card contrast', () => {
  const vars = parseCssVars(fs.readFileSync(path.join(__dirname, 'overlay.css'), 'utf8'))
  it.each(['rec', 'kill', 'info', 'ok', 'loss', 'warn', 'error'])('title colour %s reaches 4.5:1 on the card', (tone) => {
    expect(contrast(vars[`--tone-${tone}`], vars['--ov-surface'])).toBeGreaterThanOrEqual(4.5)
  })
  it('detail text reaches 4.5:1 on the card', () => {
    expect(contrast(vars['--ov-detail'], vars['--ov-surface'])).toBeGreaterThanOrEqual(4.5)
  })
})

describe('Overlay page never changes the cursor', () => {
  it('overlay.css sets no CSS cursor (the window is click-through; the game below owns the pointer)', () => {
    const css = fs.readFileSync(path.join(__dirname, 'overlay.css'), 'utf8')
    expect(css).not.toMatch(/(^|[;{\s])cursor\s*:/)
  })
})
