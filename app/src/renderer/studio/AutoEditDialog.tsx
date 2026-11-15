import { useEffect, useId, useMemo, useRef, useState } from 'react'
import '../styles/autoEdit.css'
import type { LibraryEntry } from '../../main/library'
import { AUTO_EDIT_TARGET_RANGE, AUTO_EDIT_TARGETS, MONTAGE_STYLES, STYLE_PRESETS, type AutoEditPlan, type AutoEditSource, type MontageStyle } from '../../shared/autoEdit'
import { planAutoEdit } from '../../shared/autoEditPlan'
import { autoEditToProject } from '../../shared/autoEditProject'
import { coerceExportFormat } from '../../shared/exportFormat'
import { applyPreset, sourceFormat } from '../../shared/exportPresets'
import { formatTime } from '../../shared/time'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { newProjectId, type ProjectWithId } from '../editor/projectIo'
import { useDebounced } from '../hooks/useDebounced'
import { currentLocale, i18n } from '../i18n'
import { fileName } from '../library/cardLogic'
import { recordedTime } from '../library/recordedTime'
import { X } from '../components/icons'
import { formatBytes } from './exportViewModel'
import {
  AUTO_EDIT_PRESETS,
  DEFAULT_TUNING,
  buildOptions,
  byRecording,
  createBlock,
  customTargetSec,
  defaultProjectName,
  effectivePreset,
  estimatePlan,
  initialDraft,
  resolveTarget,
  selectedSources,
  styleCap,
  styleSilencesSlowMo,
  type AutoEditDraft,
  type AutoEditTuning,
  type TargetChoice
} from './autoEditModel'
import { analyzedCandidates, sameDayPaths, useAutoEditSources, type SourceLoad } from './useAutoEditSources'
import { useStudioLibrary } from './useStudioLibrary'

export interface AutoEditDialogProps {
  /** Studio: the open video plus "add other analyzed videos"; Library: the selection plus "All videos from this day". */
  origin: 'studio' | 'library'
  initialPaths: string[]
  /** Sources already in memory (Studio's open document). */
  preloaded?: AutoEditSource[]
  /** Pre/post roll and merge gap; read from `settings.autoclip` when absent. */
  tuning?: AutoEditTuning
  onClose: () => void
  /** Save the new project and open it in Studio; resolve false when that failed (the dialog stays open). */
  onCreate: (project: ProjectWithId, plan: AutoEditPlan) => Promise<boolean>
}

const t = i18n.autoEdit
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
const DEBOUNCE_MS = 200

function targetLabel(v: number | 'all'): string {
  return v === 'all' ? t.targetAll : formatTime(v)
}

/** Read pre/post roll from settings.autoclip (the Auto clip defaults), keeping the planner defaults otherwise. */
function useTuning(given: AutoEditTuning | undefined): AutoEditTuning {
  const [tuning, setTuning] = useState<AutoEditTuning>(given ?? DEFAULT_TUNING)
  useEffect(() => {
    if (given) return
    let alive = true
    void Promise.resolve(window.api?.settings?.get?.())
      .then((s: { autoclip?: { before?: unknown; after?: unknown } } | null | undefined) => {
        const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
        if (alive && s?.autoclip) setTuning({ ...DEFAULT_TUNING, before: num(s.autoclip.before, DEFAULT_TUNING.before), after: num(s.autoclip.after, DEFAULT_TUNING.after) })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [given])
  return given ?? tuning
}

/** Carry the dialog's output preset over to the export drawer (persisted export format). Best effort. */
async function rememberPreset(presetId: AutoEditPlan['presetId']): Promise<void> {
  const api = window.api?.settings
  if (!api?.get || !api?.set) return
  const s = (await api.get()) as { exportFormat?: unknown } | null
  const cur = coerceExportFormat(s?.exportFormat)
  await api.set({ exportFormat: presetId === 'source' ? sourceFormat(cur) : applyPreset(cur, presetId) })
}

/**
 * Auto edit (phase 2B.3): pick sources, length, style, music, deaths and output preset, see a live estimate, and
 * Create an ordinary editable project (`autoEditToProject`) that opens in Studio. Rendering comes later through the
 * export drawer. Hosted by OverlayHost (scrim click and Esc close it); the focus trap keeps Tab inside.
 */
export function AutoEditDialog({ origin, initialPaths, preloaded, tuning: givenTuning, onClose, onCreate }: AutoEditDialogProps): JSX.Element {
  const uid = useId()
  const ids = {
    title: `${uid}-title`, intro: `${uid}-intro`, est: `${uid}-est`, custom: `${uid}-custom`, customHint: `${uid}-customhint`,
    music: `${uid}-music`, musicHint: `${uid}-musichint`, forced: `${uid}-forced`, others: `${uid}-others`
  }
  const boxRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<AutoEditDraft>(() => initialDraft(initialPaths))
  const [othersOpen, setOthersOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tuning = useTuning(givenTuning)
  const { entries } = useStudioLibrary()
  const library = useMemo(() => entries ?? [], [entries])
  const loads = useAutoEditSources(draft.sources, library, preloaded)

  useFocusTrap(boxRef, { onEscape: onClose, initialFocus: () => boxRef.current?.querySelector<HTMLElement>('input, button:not([disabled])') })

  const update = (patch: Partial<AutoEditDraft>): void => {
    setError(null)
    setDraft((d) => ({ ...d, ...patch }))
  }
  const toggleSource = (path: string, on: boolean): void => {
    setDraft((d) => ({ ...d, sources: on ? [...d.sources.filter((p) => norm(p) !== norm(path)), path] : d.sources.filter((p) => norm(p) !== norm(path)) }))
  }
  const addSources = (paths: string[]): void => {
    setDraft((d) => {
      const have = new Set(d.sources.map(norm))
      return { ...d, sources: [...d.sources, ...paths.filter((p) => !have.has(norm(p)))] }
    })
  }

  /* Rows: checked sources and the other analyzed candidates, both in recording order. */
  const entryOf = useMemo(() => new Map(library.map((e) => [norm(e.path), e])), [library])
  const recordedOf = (path: string): number => {
    const load = loads.get(path)
    if (load?.status === 'ready') return load.source.recordedAt
    const entry = entryOf.get(norm(path))
    return entry ? recordedTime(entry) : 0
  }
  const checkedRows = byRecording(draft.sources.map((path) => ({ path, recordedAt: recordedOf(path) })))
  const checkedSet = new Set(draft.sources.map(norm))
  const otherRows = byRecording(
    analyzedCandidates(library).filter((e) => !checkedSet.has(norm(e.path))).map((e) => ({ path: e.path, recordedAt: recordedTime(e) }))
  )
  const sameDay = origin === 'library' ? sameDayPaths(library, draft.sources).filter((p) => !checkedSet.has(norm(p))) : []

  /* Live estimate: plan the debounced draft (the planner is pure and synchronous). */
  const debounced = useDebounced(draft, DEBOUNCE_MS)
  const loading = draft.sources.some((p) => loads.get(p)?.status === 'loading' || !loads.has(p))
  const plan = useMemo(() => {
    const options = buildOptions(debounced, tuning)
    return options ? planAutoEdit(selectedSources(debounced, readyMap(loads)), options) : null
  }, [debounced, tuning, loads])
  const pending = debounced !== draft
  const block = createBlock({ draft, loading: loading || pending, plan, busy })
  const estimate = plan && !plan.empty ? estimatePlan(plan) : null
  const effective = effectivePreset(draft.style, draft.presetId)
  const target = resolveTarget(draft)
  const cap = styleCap(draft.style, target)
  const customInvalid = draft.target === 'custom' && draft.customText.trim() !== '' && customTargetSec(draft.customText) === null
  const rangeVars = (s: string): string => s.replace('{min}', String(AUTO_EDIT_TARGET_RANGE.min)).replace('{max}', String(AUTO_EDIT_TARGET_RANGE.max / 60))

  let estimateText: string
  if (block === 'noSelection') estimateText = t.emptyNoSelection
  else if (block === 'invalidTarget') estimateText = rangeVars(t.targetInvalid)
  else if (block === 'loading' || !plan) estimateText = t.estimating
  else if (block === 'noKills') estimateText = t.emptyNoKills
  else if (estimate) {
    estimateText = t.estimate
      .replace('{n}', String(estimate.clips))
      .replace('{len}', formatTime(estimate.totalSec))
      .replace('{size}', formatBytes(estimate.bytes))
  } else estimateText = t.estimating

  const create = async (): Promise<void> => {
    if (block !== null) return
    const options = buildOptions(draft, tuning)
    if (!options) return
    const fresh = planAutoEdit(selectedSources(draft, readyMap(loads)), options)
    if (fresh.empty) return
    setBusy(true)
    setError(null)
    try {
      const id = newProjectId()
      const project = autoEditToProject(fresh, id, defaultProjectName(t.defaultName, t.styles[draft.style], new Date()))
      const ok = await onCreate(project, fresh)
      if (!ok) {
        setError(t.createFailed)
        return
      }
      void rememberPreset(fresh.presetId).catch(() => undefined)
      onClose()
    } catch {
      setError(t.createFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={boxRef}
      className="ae-dlg"
      role="dialog"
      aria-modal="true"
      aria-labelledby={ids.title}
      aria-describedby={ids.intro}
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="ae-head">
        <h2 id={ids.title}>{t.title}</h2>
        <button type="button" className="icon-btn" aria-label={t.cancel} title={t.cancel} onClick={onClose}>
          <X className="ic sm" />
        </button>
      </header>
      <p id={ids.intro} className="ae-intro">{t.intro}</p>

      <div className="ae-body">
        <fieldset className="ae-section">
          <legend>{t.sources}</legend>
          <p className="ae-hint">{t.sourcesHint}</p>
          {checkedRows.length > 0 && (
            <ul className="ae-sources">
              {checkedRows.map((row) => (
                <SourceRow key={row.path} path={row.path} entry={entryOf.get(norm(row.path))} load={loads.get(row.path)} checked onToggle={toggleSource} />
              ))}
            </ul>
          )}
          <div className="ae-source-actions">
            {origin === 'library' && (
              <button type="button" className="btn-ghost sm" disabled={sameDay.length === 0} onClick={() => addSources(sameDay)}>
                {t.addSameDay}
              </button>
            )}
            <button type="button" className="btn-ghost sm" aria-expanded={othersOpen} aria-controls={ids.others} onClick={() => setOthersOpen((v) => !v)}>
              {t.addOthers}
            </button>
          </div>
          {othersOpen && (
            <div id={ids.others}>
              {otherRows.length === 0 ? (
                <p className="ae-hint">{t.noOthers}</p>
              ) : (
                <ul className="ae-sources ae-others" aria-label={t.addOthers}>
                  {otherRows.map((row) => (
                    <SourceRow key={row.path} path={row.path} entry={entryOf.get(norm(row.path))} checked={false} onToggle={toggleSource} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="ae-section">
          <legend>{t.target}</legend>
          <div className="ae-choices">
            {([...AUTO_EDIT_TARGETS, 'custom'] as TargetChoice[]).map((v) => (
              <label key={String(v)} className={`ae-chip${draft.target === v ? ' on' : ''}`}>
                <input type="radio" name={`${uid}-target`} checked={draft.target === v} onChange={() => update({ target: v })} />
                <span>{v === 'custom' ? t.targetCustom : targetLabel(v)}</span>
              </label>
            ))}
          </div>
          {draft.target === 'custom' && (
            <div className="ae-field">
              <label htmlFor={ids.custom}>{t.targetCustomLabel}</label>
              <input
                id={ids.custom}
                className="ae-input"
                inputMode="numeric"
                value={draft.customText}
                aria-invalid={customInvalid || undefined}
                aria-describedby={ids.customHint}
                onChange={(e) => update({ customText: e.target.value })}
              />
              <span id={ids.customHint} className={`ae-hint${customInvalid ? ' ae-bad' : ''}`}>
                {customInvalid ? rangeVars(t.targetInvalid) : rangeVars(t.targetCustomHint)}
              </span>
            </div>
          )}
        </fieldset>

        <fieldset className="ae-section">
          <legend>{t.style}</legend>
          <div className="ae-styles">
            {MONTAGE_STYLES.map((style) => (
              <StyleCard key={style} style={style} name={`${uid}-style`} checked={draft.style === style} onPick={() => update({ style })} />
            ))}
          </div>
          {cap !== null && <p className="ae-hint">{t.styleCap.replace('{style}', t.styles[draft.style]).replace('{sec}', String(cap))}</p>}
        </fieldset>

        <fieldset className="ae-section">
          <legend>{t.music}</legend>
          <div className="ae-field">
            <label htmlFor={ids.music}>{t.musicLabel}</label>
            <div className="ae-row">
              <input
                id={ids.music}
                className="ae-input ae-grow"
                value={draft.musicPath}
                placeholder={t.musicPlaceholder}
                title={draft.musicPath || undefined}
                aria-describedby={ids.musicHint}
                spellCheck={false}
                onChange={(e) => update({ musicPath: e.target.value })}
              />
              <button type="button" className="btn-ghost sm" disabled={draft.musicPath === ''} onClick={() => update({ musicPath: '' })}>
                {t.musicClear}
              </button>
            </div>
            <span id={ids.musicHint} className="ae-hint">{t.musicHint}</span>
          </div>
          <label className="ae-check">
            <input type="checkbox" checked={draft.includeDeaths} onChange={(e) => update({ includeDeaths: e.target.checked })} />
            <span>{t.deaths}</span>
          </label>
        </fieldset>

        <fieldset className="ae-section" aria-describedby={effective.forced ? ids.forced : undefined}>
          <legend>{t.output}</legend>
          <div className="ae-choices">
            {AUTO_EDIT_PRESETS.map((p) => (
              <label key={p} className={`ae-chip${effective.presetId === p ? ' on' : ''}${effective.forced && effective.presetId !== p ? ' off' : ''}`}>
                <input
                  type="radio"
                  name={`${uid}-preset`}
                  checked={effective.presetId === p}
                  disabled={effective.forced && effective.presetId !== p}
                  onChange={() => update({ presetId: p })}
                />
                <span>{t.presets[p]}</span>
              </label>
            ))}
          </div>
          {effective.forced && <p id={ids.forced} className="ae-hint">{t.presetForced.replace('{style}', t.styles[draft.style])}</p>}
        </fieldset>
      </div>

      <div className="ae-foot">
        <div className="ae-status">
          <p id={ids.est} className={`ae-estimate${block === 'noKills' ? ' ae-empty' : ''}`} role="status" aria-live="polite">
            {estimateText}
          </p>
          {plan && plan.warnings.length > 0 && !pending && (
            <ul className="ae-warnings" aria-label={t.warnings}>
              {plan.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {error && <p className="ae-error" role="alert">{error}</p>}
        </div>
        <button type="button" className="btn-ghost" onClick={onClose}>
          {t.cancel}
        </button>
        <button type="button" className="btn-accent" disabled={block !== null} aria-describedby={ids.est} onClick={() => void create()}>
          {busy ? t.creating : t.create}
        </button>
      </div>
    </div>
  )
}

function readyMap(loads: ReadonlyMap<string, SourceLoad>): Map<string, AutoEditSource> {
  const out = new Map<string, AutoEditSource>()
  for (const [p, l] of loads) if (l.status === 'ready') out.set(p, l.source)
  return out
}

function SourceRow({ path, entry, load, checked, onToggle }: {
  path: string
  entry: LibraryEntry | undefined
  load?: SourceLoad
  checked: boolean
  onToggle: (path: string, on: boolean) => void
}): JSX.Element {
  const name = fileName(path).replace(/\.[^.]+$/, '')
  const when = entry ? new Date(recordedTime(entry)).toLocaleString(currentLocale, { hour12: false, dateStyle: 'short', timeStyle: 'short' }) : ''
  const duration = load?.status === 'ready' ? load.source.durationSec : entry?.durationSec
  const kills = entry?.counts?.kill
  const meta = [when, duration ? formatTime(duration) : '', kills !== undefined ? t.sourceKills.replace('{n}', String(kills)) : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="ae-source">
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(path, e.target.checked)} />
        <span className="ae-source-name" title={path}>{name}</span>
        {meta && <span className="ae-source-meta mono">{meta}</span>}
        {checked && load?.status === 'loading' && <span className="ae-source-meta">{t.sourceLoading}</span>}
        {checked && load?.status === 'error' && <span className="ae-source-meta ae-bad">{t.sourceFailed}</span>}
      </label>
    </li>
  )
}

function StyleCard({ style, name, checked, onPick }: { style: MontageStyle; name: string; checked: boolean; onPick: () => void }): JSX.Element {
  const desc = styleSilencesSlowMo(style) ? `${t.styleDesc[style]} ${t.slowMoSilent}` : t.styleDesc[style]
  const preset = STYLE_PRESETS[style]
  return (
    <label className={`ae-style${checked ? ' on' : ''}`} data-style={style}>
      <input type="radio" name={name} checked={checked} onChange={onPick} />
      <span className={`ae-prev ae-prev-${style}${preset.letterbox ? ' lb' : ''}`} aria-hidden="true">
        <i className="a" />
        <i className="b" />
        <i className="fx" />
      </span>
      <span className="ae-style-name">{t.styles[style]}</span>
      <span className="ae-style-desc">{desc}</span>
    </label>
  )
}
