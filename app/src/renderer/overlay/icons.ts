import type { OverlayIcon } from '../../shared/overlay'

const S = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"'

/** Fixed SVG markup per icon (never user text). The crosshair follows the kill-feed reference. */
const ICONS: Record<OverlayIcon, string> = {
  crosshair: `<svg ${S}><circle cx="12" cy="12" r="6.5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  rec: `<svg ${S}><circle cx="12" cy="12" r="9"/><circle class="dot" cx="12" cy="12" r="4.5" stroke="none"/></svg>`,
  pause: `<svg ${S}><path d="M9 5v14M15 5v14"/></svg>`,
  play: `<svg ${S}><path d="M8 5l11 7-11 7z"/></svg>`,
  stop: `<svg ${S}><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`,
  save: `<svg ${S}><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>`,
  match: `<svg ${S}><path d="M5 19L19 5M14 5h5v5"/><path d="M5 5l5 5M19 19l-5-5"/></svg>`,
  round: `<svg ${S}><path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/></svg>`,
  disk: `<svg ${S}><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 14h.01M11 14h6"/></svg>`,
  swap: `<svg ${S}><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>`,
  warn: `<svg ${S}><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.01"/></svg>`,
  error: `<svg ${S}><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`,
  spark: `<svg ${S}><path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/></svg>`,
  check: `<svg ${S}><path d="M4 12.5l5 5L20 6.5"/></svg>`
}

export function overlayIconSvg(name: OverlayIcon): string {
  return ICONS[name] ?? ICONS.check
}
