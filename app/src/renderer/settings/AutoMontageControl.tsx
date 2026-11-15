// Auto montage card (settings.recording.autoMontage): one control per row, all writes go through controller.setRecording.
import { useRef, useState } from 'react'
import { FALLBACK_SPEC } from '../../shared/encodeQuality'
import { DEFAULT_EXPORT_FORMAT } from '../../shared/exportFormat'
import { applyPreset } from '../../shared/exportPresets'
import { MONTAGE_RANGES, MONTAGES_DIRNAME, postAnalysisForMontage, type AutoMontageSettings, type MontageInclude } from '../../shared/montage'
import type { RecordingSettings } from '../../shared/recording'
import type { Settings } from '../../shared/settings'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { FolderOpen } from '../components/icons'
import { recordingI18n } from '../i18n'
import { ExportPresetCards } from '../studio/ExportFormatControls'
import { NumberField, SegmentedControl, SwitchControl, describedBy, type ControlIds } from './SettingControls'
import type { SettingsController, SettingsState } from './settingsController'
import { fillTemplate } from './settingsModel'
import { montageTimingOptions } from './recordingOptions'
import type { AutoMontageField } from './rows'
import '../styles/exportDrawer.css'
import './autoMontage.css'

const INCLUDE_KEYS: ReadonlyArray<keyof MontageInclude> = ['multiKills', 'aces', 'clutches', 'singleKills']

/** Set once the user has confirmed that turning off "Keep the match recording" deletes recordings (only asked the first time). */
export const KEEP_SOURCE_ACK_KEY = 'valorant-editor.autoMontage.keepSourceAck'

function keepSourceAcknowledged(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEEP_SOURCE_ACK_KEY) === '1'
  } catch {
    return false
  }
}

function acknowledgeKeepSource(): void {
  try {
    globalThis.localStorage?.setItem(KEEP_SOURCE_ACK_KEY, '1')
  } catch {
    // Without storage the dialog is simply shown again next time.
  }
}

type MontagePatch = Partial<Omit<AutoMontageSettings, 'include'>> & { include?: Partial<MontageInclude> }

/**
 * Each row is its own component, and settings only update after main answers. Remember the last value sent per controller,
 * so two quick edits (for example two include checkboxes) build on each other instead of the second one undoing the first.
 */
const pending = new WeakMap<SettingsController, { base: AutoMontageSettings; value: AutoMontageSettings }>()

function saveMontage(controller: SettingsController, current: AutoMontageSettings, patch: MontagePatch): Promise<void> {
  const last = pending.get(controller)
  const from = last && last.base === current ? last.value : current
  const value: AutoMontageSettings = { ...from, ...patch, include: { ...from.include, ...patch.include } }
  pending.set(controller, { base: current, value })
  return controller.setRecording('autoMontage', value)
}

/** `<root>\Montages`, using the separator the root already uses. */
export function defaultMontageDir(root: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${MONTAGES_DIRNAME}`
}

/** Confirmation dialog in the style of the capture-hook warning: alertdialog, focus trap, Esc/scrim cancel, focus returns to the control. */
export function MontageConfirmDialog({ idBase, title, body, confirm, cancel, danger, returnFocusId, onCancel, onConfirm }: {
  idBase: string
  title: string
  body: string
  confirm: string
  cancel: string
  danger?: boolean
  returnFocusId: string
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(boxRef, {
    onEscape: onCancel,
    initialFocus: () => cancelRef.current,
    returnFocusTo: () => document.getElementById(returnFocusId)
  })
  return (
    <div className="set-dlg-scrim" onClick={onCancel}>
      <div
        ref={boxRef}
        className="set-dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${idBase}-title`}
        aria-describedby={`${idBase}-desc`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={`${idBase}-title`}>{title}</h3>
        <p id={`${idBase}-desc`}>{body}</p>
        <div className="set-dlg-foot">
          <button id={`${idBase}-cancel`} ref={cancelRef} type="button" className="set-btn ghost" onClick={onCancel}>
            {cancel}
          </button>
          <button id={`${idBase}-confirm`} type="button" className={`set-btn${danger ? ' danger' : ''}`} onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AutoMontageControl({ field, ids, state, settings, controller }: {
  field: AutoMontageField
  ids: ControlIds
  state: SettingsState
  settings: Settings
  controller: SettingsController
}): JSX.Element {
  const t = recordingI18n.autoMontage
  const recording: RecordingSettings = settings.recording
  const am = recording.autoMontage
  const off = !am.enabled
  const [dialog, setDialog] = useState<'enable' | 'keepSource' | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const save = (patch: MontagePatch): void => {
    void saveMontage(controller, am, patch)
  }
  // Sub-options stay visible but disabled while Auto montage is off; screen readers get the reason.
  const offId = `${ids.ctl}-off`
  const offHint = off ? <span id={offId} className="set-sr">{t.offHint}</span> : null
  const subIds: ControlIds = off ? { ...ids, reason: [ids.reason, offId].filter(Boolean).join(' ') } : ids

  switch (field) {
    case 'enabled':
      return (
        <>
          <SwitchControl
            ids={ids}
            checked={am.enabled}
            onChange={(v) => {
              if (v && recording.postAnalysis === 'none') setDialog('enable')
              else save({ enabled: v })
            }}
          />
          {dialog === 'enable' && (
            <MontageConfirmDialog
              idBase={`${ids.ctl}-confirm`}
              title={t.enableDialog.title}
              body={t.enableDialog.body}
              confirm={t.enableDialog.confirm}
              cancel={t.enableDialog.cancel}
              returnFocusId={ids.ctl}
              onCancel={() => setDialog(null)}
              onConfirm={() => {
                setDialog(null)
                // Main applies the same rule on every write; saving postAnalysis too keeps the UI and the stored value in step.
                const postAnalysis = postAnalysisForMontage(recording.postAnalysis, { enabled: true })
                save({ enabled: true })
                if (postAnalysis !== recording.postAnalysis) void controller.setRecording('postAnalysis', postAnalysis)
              }}
            />
          )}
        </>
      )
    case 'formatPreset':
      return (
        <div className="am-presets">
          <ExportPresetCards
            id={ids.ctl}
            name={`${ids.ctl}-preset`}
            format={applyPreset(DEFAULT_EXPORT_FORMAT, am.formatPreset)}
            srcSpec={FALLBACK_SPEC}
            hideSource
            disabled={off}
            labelledBy={ids.title}
            describedBy={describedBy(subIds)}
            onChoose={(id) => {
              if (id !== 'source' && id !== am.formatPreset) save({ formatPreset: id })
            }}
          />
          {offHint}
        </div>
      )
    case 'minClips':
    case 'maxDurationSec':
      return (
        // NumberField has no disabled prop; a disabled fieldset disables its input.
        <fieldset className="am-fs" disabled={off}>
          <NumberField
            id={ids.ctl}
            value={am[field]}
            range={MONTAGE_RANGES[field]}
            syncKey={state.settings}
            describedBy={describedBy(subIds)}
            unit={field === 'minClips' ? t.clipsUnit : t.secondsUnit}
            onCommit={(v) => save(field === 'minClips' ? { minClips: Math.round(v) } : { maxDurationSec: Math.round(v) })}
          />
          {offHint}
        </fieldset>
      )
    case 'include':
      return (
        <div id={ids.ctl} className="am-include" role="group" aria-labelledby={ids.title} aria-describedby={describedBy(subIds)}>
          {INCLUDE_KEYS.map((key) => (
            <label key={key} className="am-check">
              <input
                id={`${ids.ctl}-${key}`}
                type="checkbox"
                checked={am.include[key]}
                disabled={off}
                onChange={(e) => save({ include: { [key]: e.target.checked } })}
              />
              <span>{t.include[key]}</span>
            </label>
          ))}
          {offHint}
        </div>
      )
    case 'timing':
      return (
        <>
          <SegmentedControl ids={subIds} value={am.timing} options={montageTimingOptions()} disabled={off}
            onChange={(v) => save({ timing: v as AutoMontageSettings['timing'] })} />
          {offHint}
        </>
      )
    case 'keepSourceRecording':
      return (
        <>
          <SwitchControl
            ids={subIds}
            checked={am.keepSourceRecording}
            disabled={off}
            onChange={(v) => {
              if (!v && !keepSourceAcknowledged()) setDialog('keepSource')
              else save({ keepSourceRecording: v })
            }}
          />
          {offHint}
          {dialog === 'keepSource' && (
            <MontageConfirmDialog
              idBase={`${ids.ctl}-confirm`}
              title={t.keepSourceDialog.title}
              body={t.keepSourceDialog.body}
              confirm={t.keepSourceDialog.confirm}
              cancel={t.keepSourceDialog.cancel}
              danger
              returnFocusId={ids.ctl}
              onCancel={() => setDialog(null)}
              onConfirm={() => {
                setDialog(null)
                acknowledgeKeepSource()
                save({ keepSourceRecording: false })
              }}
            />
          )}
        </>
      )
    case 'outputDir': {
      const root = settings.storageRoot ?? state.suggestedStorageRoot
      const shown = am.outputDir ?? (root ? fillTemplate(t.outputDefault, { dir: defaultMontageDir(root) }) : t.outputDefaultUnset)
      const valueId = `${ids.ctl}-value`
      const pick = async (): Promise<void> => {
        setPickError(null)
        let dir: string | null | undefined
        try {
          dir = await window.api?.export?.selectOutDir?.()
        } catch {
          setPickError(t.outputPickFailed)
          return
        }
        if (dir) save({ outputDir: dir })
      }
      return (
        <div className="set-inline am-output">
          <span id={valueId} className={`set-value${am.outputDir ? ' mono' : ''}`} title={am.outputDir ?? undefined}>{shown}</span>
          <button id={ids.ctl} type="button" className="set-btn sm" disabled={off} aria-describedby={describedBy(subIds, valueId)} onClick={() => void pick()}>
            <FolderOpen className="ic sm" />
            {t.outputChoose}
          </button>
          {am.outputDir !== null && (
            <button type="button" className="set-btn ghost sm" disabled={off} aria-describedby={valueId} onClick={() => save({ outputDir: null })}>
              {t.outputReset}
            </button>
          )}
          {offHint}
          {pickError && <span className="set-err" role="alert">{pickError}</span>}
        </div>
      )
    }
  }
}
