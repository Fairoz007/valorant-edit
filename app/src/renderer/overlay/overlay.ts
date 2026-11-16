/** In-game overlay page: receives cards from main and stacks at most OVERLAY_MAX_CARDS; it never handles input. */
import './overlay.css'
import { OVERLAY_MAX_CARDS, type OverlayCard, type OverlayFrame } from '../../shared/overlay'
import { overlayIconSvg } from './icons'

interface OverlayBridge { onCard(listener: (frame: OverlayFrame) => void): void }
interface Shown { el: HTMLElement; timer: ReturnType<typeof setTimeout> | null }

/** Cards per stack element (one stack in the real page). */
const stacks = new WeakMap<HTMLElement, Map<string, Shown>>()

function render(el: HTMLElement, card: OverlayCard): void {
  el.dataset.tone = card.tone
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = card.title
  const icon = document.createElement('span')
  icon.className = 'icon'
  icon.setAttribute('aria-hidden', 'true')
  // Static markup from a fixed table; card text is only ever set with textContent.
  icon.innerHTML = overlayIconSvg(card.icon)
  const detail = document.createElement('span')
  detail.className = 'detail'
  detail.textContent = card.detail
  el.replaceChildren(title, icon, detail)
  el.setAttribute('aria-label', `${card.title} ${card.detail}`)
}

function leave(shown: Map<string, Shown>, id: string): void {
  const entry = shown.get(id)
  if (!entry) return
  shown.delete(id)
  if (entry.timer) clearTimeout(entry.timer)
  entry.el.classList.add('leaving')
  setTimeout(() => entry.el.remove(), 280)
}

/** Show or update one card in `stack`; exported for tests. */
export function showCard(stack: HTMLElement, frame: OverlayFrame): void {
  const { card } = frame
  let shown = stacks.get(stack)
  if (!shown) { shown = new Map(); stacks.set(stack, shown) }
  stack.className = `stack ${frame.position.startsWith('top') ? 'top' : 'bottom'} ${frame.position.endsWith('Left') ? 'left' : 'right'}`
  stack.style.opacity = String(Math.min(1, Math.max(0.3, frame.opacity)))
  let entry = shown.get(card.id)
  if (entry) {
    // Same id: update in place (a growing multi-kill) and restart its timer.
    render(entry.el, card)
    entry.el.classList.remove('bump')
    void entry.el.offsetWidth
    entry.el.classList.add('bump')
  } else {
    const el = document.createElement('div')
    el.className = 'card'
    el.setAttribute('role', 'status')
    render(el, card)
    // Newest first: at the top for top corners (column), at the bottom for bottom corners (column-reverse).
    stack.prepend(el)
    entry = { el, timer: null }
    shown.set(card.id, entry)
    const ids = [...shown.keys()]
    for (const old of ids.slice(0, Math.max(0, ids.length - OVERLAY_MAX_CARDS))) leave(shown, old)
  }
  if (entry.timer) clearTimeout(entry.timer)
  const owner = shown
  entry.timer = setTimeout(() => leave(owner, card.id), card.durationMs)
}

const bridge = (window as unknown as { overlay?: OverlayBridge }).overlay
const root = document.getElementById('stack')
if (bridge && root) bridge.onCard((frame) => showCard(root, frame))
