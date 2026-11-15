import '../styles/autoEdit.css'
import type { ProjectItem } from '../editor/project'
import { i18n } from '../i18n'
import { effectBadges, type EffectBadge } from './autoEditModel'

const t = i18n.autoEdit

/** Accessible label of one badge (screen readers also get these through the item's own label, see `effectSummary`). */
export function badgeLabel(b: EffectBadge): string {
  switch (b.kind) {
    case 'slowmo':
      return t.badgeAria.slowmo.replace('{speed}', String(b.value))
    case 'zoomPunch':
      return t.badgeAria.zoomPunch
    case 'flash':
      return t.badgeAria.flash
    case 'caption':
      return t.badgeAria.caption.replace('{text}', b.text ?? '')
    case 'speed':
      return t.badgeAria.speed.replace('{speed}', String(b.value))
    case 'transition':
      return b.value === 'dipWhite' ? t.badgeAria.dipWhite : t.badgeAria.dipBlack
  }
}

function badgeText(b: EffectBadge): string {
  switch (b.kind) {
    case 'caption':
    case 'speed':
      return b.text ?? ''
    case 'transition':
      return t.badge.transition
    default:
      return t.badge[b.kind]
  }
}

/** ", Slow motion ×0.5, Caption: DOUBLE KILL" for the item's aria-label ('' for a plain item). */
export function effectSummary(item: Pick<ProjectItem, 'effects' | 'overlay' | 'speed' | 'transitionIn'>): string {
  const labels = effectBadges(item).map(badgeLabel)
  return labels.length === 0 ? '' : `${t.badges}: ${labels.join(', ')}`
}

/**
 * Small effect badges on a project-track clip (slow-mo, zoom, flash, caption, speed ≠ 1, transition). Each badge is a
 * labelled image; the clip's own aria-label repeats the summary because a listitem label hides its children.
 */
export function AutoEditBadges({ item }: { item: Pick<ProjectItem, 'effects' | 'overlay' | 'speed' | 'transitionIn'> }): JSX.Element | null {
  const badges = effectBadges(item)
  if (badges.length === 0) return null
  return (
    <span className="ae-fx" data-fx>
      {badges.map((b) => (
        <span key={b.kind} className={`ae-fx-badge ${b.kind}`} role="img" aria-label={badgeLabel(b)} title={badgeLabel(b)}>
          {badgeText(b)}
        </span>
      ))}
    </span>
  )
}
