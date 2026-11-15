// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectTrack, type ProjectTrackProps } from './ProjectTrack'
import { createProject, type ProjectItem } from '../editor/project'
import { autoEditToProject } from '../../shared/autoEditProject'
import type { AutoEditPlan } from '../../shared/autoEdit'
import { i18n } from '../i18n'
import { cleanupMounted, installDomShims, mount } from '../../../test/dom'
import { formatFindings, runAxe } from '../../../test/axe'

const t = i18n.autoEdit
beforeEach(() => installDomShims())
afterEach(() => cleanupMounted())

function props(items: ProjectItem[]): ProjectTrackProps {
  return {
    project: { ...createProject('P'), items },
    collapsed: false,
    onToggleCollapsed: () => undefined,
    selectedId: null,
    onSelect: () => undefined,
    currentId: null,
    progress: 0,
    labelOf: () => 'Clip',
    missingIds: new Set(),
    saveState: 'saved',
    videoPath: 'D:/v.mp4',
    videoDuration: 100,
    onPlay: () => undefined,
    onMissing: () => undefined,
    onTrim: () => undefined,
    onMove: () => undefined,
    onRename: () => undefined,
    onSplit: () => undefined,
    onDuplicate: () => undefined,
    onDelete: () => undefined,
    onUndo: () => undefined,
    onRedo: () => undefined,
    canUndo: false,
    canRedo: false,
    projectId: 'p_test',
    onNewProject: vi.fn(),
    onOpenProject: vi.fn(async () => true),
    onAddExternalVideo: () => undefined,
    onExport: () => undefined,
    exportOpen: false,
    exportPercent: null,
    onAddFromSource: () => undefined,
    onDialogOpenChange: () => undefined
  }
}

const styled: ProjectItem = {
  id: 'b',
  source: 'D:/v.mp4',
  start: 10,
  end: 20,
  speed: 1.5,
  effects: [
    { kind: 'slowmo', at: 15, durationSec: 0.6, speed: 0.5 },
    { kind: 'zoomPunch', at: 15, durationSec: 0.3, scale: 1.2 },
    { kind: 'flash', at: 15, durationSec: 0.1 }
  ],
  overlay: { text: 'DOUBLE KILL', at: 15, durationSec: 1 },
  transitionIn: 'dipBlack',
  transitionSec: 0.5
}

function clip(root: ParentNode, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!
}

describe('ProjectTrack effect badges', () => {
  test('a plain item has no badges and its label is unchanged', () => {
    const m = mount(<ProjectTrack {...props([{ id: 'a', source: 'D:/v.mp4', start: 1, end: 9 }])} />)
    expect(clip(m.container, 'a').querySelector('.ae-fx')).toBeNull()
    expect(clip(m.container, 'a').getAttribute('aria-label')).not.toContain(t.badges)
  })

  test('a styled item shows labelled badges for slow-mo, zoom, flash, caption, speed and transition', () => {
    const m = mount(<ProjectTrack {...props([styled])} />)
    const badges = Array.from(clip(m.container, 'b').querySelectorAll<HTMLElement>('.ae-fx-badge'))
    expect(badges.map((b) => b.getAttribute('aria-label'))).toEqual([
      t.badgeAria.slowmo.replace('{speed}', '0.5'),
      t.badgeAria.zoomPunch,
      t.badgeAria.flash,
      t.badgeAria.caption.replace('{text}', 'DOUBLE KILL'),
      t.badgeAria.speed.replace('{speed}', '1.5'),
      t.badgeAria.dipBlack
    ])
    expect(badges.every((b) => b.getAttribute('role') === 'img')).toBe(true)
    // The caption badge shows the planner's caption text as is.
    expect(badges[3].textContent).toBe('DOUBLE KILL')
    // The listitem label hides its children, so it repeats the effects.
    const label = clip(m.container, 'b').getAttribute('aria-label')!
    expect(label).toContain(t.badgeAria.caption.replace('{text}', 'DOUBLE KILL'))
    expect(label).toContain(t.badgeAria.dipBlack)
  })

  test('items of an auto edit project get badges straight from autoEditToProject', async () => {
    const plan: AutoEditPlan = {
      style: 'hype', presetId: 'source', totalSec: 10, music: null, intro: null, outro: null, letterbox: false, beatSync: false, warnings: [],
      clips: [0, 1].map((i) => ({
        id: `ae_${i}`, source: 'D:/v.mp4', in: i * 20, out: i * 20 + 5, speed: 1, gain: 1,
        effects: [{ kind: 'flash' as const, at: i * 20 + 3, durationSec: 0.1 }], overlay: null,
        transitionIn: 'dipWhite' as const, transitionSec: 0.25, score: 1, kind: 'single' as const, eventIds: []
      }))
    }
    const project = autoEditToProject(plan, 'p_x', 'X')
    const m = mount(<ProjectTrack {...props(project.items)} />)
    const first = Array.from(clip(m.container, 'p_x_ae0').querySelectorAll('.ae-fx-badge')).map((b) => b.getAttribute('aria-label'))
    const second = Array.from(clip(m.container, 'p_x_ae1').querySelectorAll('.ae-fx-badge')).map((b) => b.getAttribute('aria-label'))
    expect(first).toEqual([t.badgeAria.flash]) // the first clip's transition is ignored
    expect(second).toEqual([t.badgeAria.flash, t.badgeAria.dipWhite])
    document.title = 'Valorant Editor'
    document.documentElement.lang = 'en'
    const findings = await runAxe(document)
    expect(findings, formatFindings(findings)).toEqual([])
  })
})
