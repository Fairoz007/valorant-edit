import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import '../styles/exportDrawer.css'
import { i18n } from '../i18n'
import { formatTime } from '../../shared/time'
import { fillTemplate as fmt } from '../../shared/template'
import { tr } from '../../shared/locale'
import { exportSubDirName, joinForDisplay } from '../../shared/storage'
import { encodersForCodec, type OutputFrame, type PresetId, type ReframeMode, type VideoCodec } from '../../shared/exportFormat'
import { presetState } from '../../shared/exportPresets'
import type { ReframeGeometry, Size } from '../../shared/reframe'
import { totalDuration, Project } from '../editor/project'
import { Check, ChevronDown, Copy, Download, FolderOpen, AlertTriangle, X } from '../components/icons'
import { ExportController, ExportItem, ExportState } from './exportController'
import {
  diskIsLow,
  ExportPlan,
  exportViewModel,
  ExportViewModel,
  formatBytes,
  previewGeometry,
  type PreviewSource
} from './exportViewModel'
import { ExportFormatFields, ExportPresetCards, formatLimit, frameLabel, presetName, reframeLabel, summaryText } from './ExportFormatControls'
import { ExportPreview } from './ExportPreview'
import { OpenH264Dialog } from './OpenH264Dialog'
import { nextTrapIndex } from './focusTrap'

  /** Source-probe results (the parts unrelated to current settings); the drawer adds mode/quality from settings. */
import type { ExportPlanBase } from './exportPlanBase'
export type { ExportPlanBase }

export interface ExportDrawerViewProps {
  state: ExportState
  vm: ExportViewModel
  project: Project
  items: ExportItem[]
  sourceCount: number
  /** Live reframe preview (geometry from computeReframe for the preview source). */
  preview: { src: Size; geometry: ReframeGeometry; videoRef?: React.RefObject<HTMLVideoElement> }
  on: {
    mode: (m: 'concat' | 'separate') => void
    quality: (q: 'copy' | 'precise') => void
    encoder: (e: string) => void
    baseName: (n: string) => void
    browse: () => void
    start: () => void
    cancelExport: () => void
    close: () => void
    minimize: () => void
    retry: () => void
    finish: () => void
    openFolder: () => void
    copyError: () => void
    declineConsent: () => void
    acceptConsent: () => void
    preset: (id: PresetId | 'source') => void
    frame: (f: OutputFrame) => void
    reframe: (m: ReframeMode) => void
    offset: (o: number) => void
    codec: (c: VideoCodec) => void
    fpsCap: (cap: number | null) => void
    trim: (on: boolean) => void
  }
}

/** Encoder display name without suffixes such as "detected". */
function encoderName(name: string): string {
  const nice: Record<string, string> = {
    h264_nvenc: 'NVIDIA NVENC',
    h264_qsv: 'Intel Quick Sync',
    h264_amf: 'AMD AMF',
    hevc_nvenc: 'NVIDIA NVENC',
    hevc_qsv: 'Intel Quick Sync',
    hevc_amf: 'AMD AMF'
  }
  return nice[name] ?? name
}

function encoderLabel(name: string): string {
  const t = i18n.export
  if (name === 'libopenh264') return t.encoderOpenh264
  return fmt(t.encoderDetected, { name: encoderName(name) })
}

/** Frame-rate caps offered in Advanced (plus the current one when it is something else). */
const FPS_CAPS = [60, 30]

function SettingsBody({ state, vm, project, sourceCount, preview, on }: ExportDrawerViewProps): JSX.Element {
  const t = i18n.export
  const s = state.settings
  const f = vm.format
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const total = totalDuration(project)
  const estimate = vm.estimatedBytes
  const low = state.disk ? diskIsLow(state.disk.freeBytes, estimate) : false
  const drive = s.outDir && /^[A-Za-z]:/.test(s.outDir) ? s.outDir.slice(0, 2) : (s.outDir ?? '')
  const codecEncoders = encodersForCodec(state.encoders, f.codec)
  const encoderOptions = codecEncoders.length > 0 ? codecEncoders : f.codec === 'h264' ? ['libopenh264'] : []
  const hasHw = codecEncoders.some((e) => e !== 'libopenh264')
  const copyHint = vm.copyAvailable
    ? [t.qualityCopyDesc, vm.extraSecondsHint !== null ? fmt(t.qualityCopyExtra, { sec: vm.extraSecondsHint.toFixed(1) }) : ''].filter(Boolean).join(' ')
    : (vm.copyReason ?? t.qualityCopyUnavailable)
  const selected = presetState(f)
  const warning = vm.lengthWarning
  const fpsCaps = f.fpsCap !== null && !FPS_CAPS.includes(f.fpsCap) ? [...FPS_CAPS, f.fpsCap] : FPS_CAPS
  const previewLabel = `${t.preview}: ${frameLabel(f.frame)}${f.frame === 'source' ? '' : ` · ${reframeLabel(f.reframe)}`} · ${preview.geometry.out.width}×${preview.geometry.out.height}`
  return (
    <>
      <div className="xd-stats">
        <div className="xd-stat">
          <b>{project.items.length}</b>
          <span>{t.summaryClips}</span>
        </div>
        <div className="xd-stat">
          <b>{formatTime(total)}</b>
          <span>{t.summaryDuration}</span>
        </div>
        <div className="xd-stat">
          <b>{sourceCount}</b>
          <span>{t.summarySources}</span>
        </div>
      </div>

      <div className="xd-live" aria-live="polite">
        {vm.notices.map((n, i) => (
          <div key={i} className={`xd-notice xd-${n.kind}`}>
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>{n.text}</div>
          </div>
        ))}
        {warning && selected !== 'source' && selected !== 'custom' && (
          <div className="xd-notice xd-warn" data-length-warning="">
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>
              {fmt(s.mode === 'concat' ? t.lengthOver : t.lengthOverSeparate, {
                platform: presetName(selected),
                max: formatLimit(warning.maxSeconds),
                len: formatTime(warning.seconds)
              })}
              <label className="xd-check">
                <input type="checkbox" checked={s.trimToLimit} onChange={(e) => on.trim(e.target.checked)} />
                {fmt(s.mode === 'concat' ? t.trimToLimit : t.trimToLimitSeparate, { max: formatLimit(warning.maxSeconds) })}
              </label>
            </div>
          </div>
        )}
        {(vm.blockers.length > 0 || state.outDirError) && (
          <div className="xd-notice xd-err" role="alert">
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>
              <b>{t.blockersTitle}</b>
              <ul className="xd-blockers">
                {vm.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
                {state.outDirError && <li>{state.outDirError}</li>}
              </ul>
            </div>
          </div>
        )}
        {vm.openh264Required && (
          <div className="xd-notice xd-warn">
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>{t.needOpenh264}</div>
          </div>
        )}
      </div>

      <ExportPresetCards format={f} srcSpec={vm.srcSpec} onChoose={on.preset} />

      <ExportPreview geometry={preview.geometry} src={preview.src} videoRef={preview.videoRef} label={previewLabel} />

      <ExportFormatFields format={f} geometry={preview.geometry} src={preview.src} on={{ frame: on.frame, reframe: on.reframe, offset: on.offset }} />

      <fieldset className="xd-sec">
        <legend>{t.quality}</legend>
        <label className={`xd-opt${vm.effectiveQuality === 'copy' ? ' on' : ''}${vm.copyAvailable ? '' : ' disabled'}`}>
          <input
            type="radio"
            name="xd-quality"
            checked={vm.effectiveQuality === 'copy'}
            disabled={!vm.copyAvailable}
            aria-describedby="xd-copy-hint"
            onChange={() => void on.quality('copy')}
          />
          <div>
            <b>
              {t.qualityCopy} {!vm.copyAvailable && <span className="xd-pill">{t.unavailable}</span>}
            </b>
            <small id="xd-copy-hint">{copyHint}</small>
          </div>
        </label>
        <label className={`xd-opt${vm.effectiveQuality === 'precise' ? ' on' : ''}`}>
          <input type="radio" name="xd-quality" checked={vm.effectiveQuality === 'precise'} onChange={() => void on.quality('precise')} />
          <div>
            <b>{t.qualityPrecise}</b>
            <small>{t.qualityPreciseDesc}</small>
          </div>
        </label>

        <fieldset className="xd-group">
          <legend>{t.codec}</legend>
          <div className="xd-seg">
            <label className={`xd-chip${f.codec === 'h264' ? ' on' : ''}`}>
              <input type="radio" className="xd-vh" name="xd-codec" value="h264" checked={f.codec === 'h264'} onChange={() => on.codec('h264')} />
              {t.codecH264}
            </label>
            <label className={`xd-chip${f.codec === 'h265' ? ' on' : ''}${vm.h265Unavailable ? ' disabled' : ''}`}>
              <input
                type="radio"
                className="xd-vh"
                name="xd-codec"
                value="h265"
                checked={f.codec === 'h265'}
                disabled={vm.h265Unavailable}
                aria-describedby="xd-codec-hint"
                onChange={() => on.codec('h265')}
              />
              {t.codecH265}
            </label>
          </div>
          <div id="xd-codec-hint" className={`xd-muted xd-hint${vm.h265Unavailable ? ' xd-reason' : ''}`} data-h265-unavailable={vm.h265Unavailable ? '' : undefined}>
            {vm.h265Unavailable ? t.h265Unavailable : f.codec === 'h265' ? t.codecH265Desc : t.codecH264Desc}
          </div>
        </fieldset>

        <select
          className="xd-select"
          aria-label={t.encoder}
          value={s.encoderChoice}
          onChange={(e) => on.encoder(e.target.value)}
        >
          <option value="auto">{t.encoderAuto}</option>
          {encoderOptions.map((e) => (
            <option key={e} value={e}>
              {e === 'libopenh264' && !state.openh264Installed && state.encoders.length === 0 ? t.encoderOpenh264Missing : encoderLabel(e)}
            </option>
          ))}
        </select>
        {!hasHw && f.codec === 'h264' && <div className="xd-muted xd-hint">{t.encoderHint}</div>}
        {vm.effectiveQuality !== 'precise' && <div className="xd-muted xd-hint">{t.encoderCopyNote}</div>}
      </fieldset>

      <fieldset className="xd-sec">
        <legend>{t.output}</legend>
        <fieldset className="xd-group">
          <legend>{t.mode}</legend>
          <label className={`xd-opt${s.mode === 'concat' ? ' on' : ''}`}>
            <input type="radio" name="xd-mode" checked={s.mode === 'concat'} onChange={() => on.mode('concat')} />
            <div>
              <b>{t.modeConcat}</b>
              <small>{t.modeConcatDesc}</small>
            </div>
          </label>
          <label className={`xd-opt${s.mode === 'separate' ? ' on' : ''}`}>
            <input type="radio" name="xd-mode" checked={s.mode === 'separate'} onChange={() => on.mode('separate')} />
            <div>
              <b>{t.modeSeparate}</b>
              <small>{fmt(t.modeSeparateDesc, { n: project.items.length })}</small>
            </div>
          </label>
        </fieldset>
        <div className="xd-row">
          <input className="xd-input" readOnly value={s.outDir ?? ''} placeholder={t.outputDirPlaceholder} aria-label={t.outputDir} />
          <button type="button" className="btn-ghost" onClick={on.browse}>
            <FolderOpen className="ic sm" /> {t.browse}
          </button>
        </div>
        {s.outDir && (
          <div className="xd-muted xd-hint">{tr('實際會存到：{path}', { path: joinForDisplay(s.outDir, exportSubDirName(s.mode)) })}</div>
        )}
        <input
          className="xd-input"
          value={s.baseName}
          aria-label={t.baseName}
          maxLength={100}
          onChange={(e) => on.baseName(e.target.value)}
        />
        <div className="xd-muted xd-hint">
          {fmt(t.estimate, { size: formatBytes(estimate) })}
          {state.disk && ` · ${fmt(t.diskFree, { path: drive, size: formatBytes(state.disk.freeBytes) })}`}
        </div>
        {low && state.disk && (
          <div className="xd-notice xd-warn" role="alert">
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>{fmt(t.diskLow, { need: formatBytes(estimate * 1.1), free: formatBytes(state.disk.freeBytes) })}</div>
          </div>
        )}
      </fieldset>

      <div className="xd-sec">
        <button
          type="button"
          className="btn-ghost xd-adv-toggle"
          aria-expanded={advancedOpen}
          aria-controls="xd-advanced"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <ChevronDown className={`ic sm xd-chev${advancedOpen ? ' open' : ''}`} aria-hidden="true" /> {t.advanced}
        </button>
        {advancedOpen && (
          <div id="xd-advanced" className="xd-adv">
            <label className="xd-field-label" htmlFor="xd-fps">{t.fpsCap}</label>
            <select
              id="xd-fps"
              className="xd-select"
              value={f.fpsCap === null ? 'source' : String(f.fpsCap)}
              aria-describedby="xd-fps-hint"
              onChange={(e) => on.fpsCap(e.target.value === 'source' ? null : Number(e.target.value))}
            >
              <option value="source">{t.fpsSource}</option>
              {fpsCaps.map((n) => (
                <option key={n} value={String(n)}>
                  {fmt(t.fpsCapValue, { n })}
                </option>
              ))}
            </select>
            <div id="xd-fps-hint" className="xd-muted xd-hint">{t.fpsCapHint}</div>
          </div>
        )}
      </div>
    </>
  )
}

function RunningBody({ state, vm }: Pick<ExportDrawerViewProps, 'state' | 'vm'>): JSX.Element {
  const t = i18n.export
  const p = state.progress ?? { percent: 0, jobIndex: 0, totalJobs: 1, outTimeSeconds: 0 }
  const enc = vm.effectiveQuality === 'copy' ? t.qualityCopy : (state.settings.encoder === 'libopenh264' ? t.encoderOpenh264 : encoderName(state.settings.encoder))
  return (
    <>
      <div className="xd-sec">
        <h4>{t.running}</h4>
        <div className="xd-big">{p.percent}%</div>
        <div className="xd-bar xd-bar-lg" role="progressbar" aria-label={t.running} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent}>
          <i style={{ width: `${p.percent}%` }} />
        </div>
        <div className="xd-muted">
          {fmt(t.runningDetail, { i: p.jobIndex + 1, n: p.totalJobs, sec: p.outTimeSeconds.toFixed(1), enc })}
        </div>
      </div>
      <div className="xd-muted">{t.runningLocked}</div>
    </>
  )
}

function DoneBody({ state, project }: Pick<ExportDrawerViewProps, 'state' | 'project'>): JSX.Element {
  const t = i18n.export
  const r = state.result!
  const took = `${Math.max(1, Math.round(r.durationMs / 1000))} ${t.sec}`
  return (
    <>
      <div className="xd-done-head">
        <Check className="ic xd-done-ic" aria-hidden="true" />
        <h3>{r.cancelled ? t.cancelledTitle : t.doneTitle}</h3>
        <div className="xd-muted">
          {r.cancelled ? t.cancelledDesc : fmt(t.doneSummary, { dur: formatTime(totalDuration(project)), took })}
        </div>
      </div>
      <div className="xd-sec">
        <h4>{t.outputFiles}</h4>
        <div className="xd-code" tabIndex={0}>
          {r.outputs.length > 0 ? r.outputs.join('\n') : t.cancelledNone}
        </div>
      </div>
      {r.notices.map((n, i) => (
        <div key={i} className="xd-notice xd-info">
          <AlertTriangle className="ic" aria-hidden="true" />
          <div>{n}</div>
        </div>
      ))}
    </>
  )
}

function FailedBody({ state }: Pick<ExportDrawerViewProps, 'state'>): JSX.Element {
  const t = i18n.export
  const r = state.result!
  return (
    <>
      <div className="xd-live" aria-live="assertive" role="alert">
        <div className="xd-notice xd-err">
          <AlertTriangle className="ic" aria-hidden="true" />
          <div>
            <b>{t.failedTitle}</b>　{t.failedDesc}
          </div>
        </div>
      </div>
      <div className="xd-sec">
        <h4>{t.stderrTitle}</h4>
        <div className="xd-code" tabIndex={0}>
          {r.error}
        </div>
      </div>
      <div className="xd-muted">{t.failedCauses}</div>
    </>
  )
}

/** Pure drawer rendering from state/view model (no side effects), used by renderToString tests for the four states. */
export function ExportDrawerView(props: ExportDrawerViewProps & { drawerRef?: React.Ref<HTMLElement> }): JSX.Element {
  const { state, vm, on } = props
  const t = i18n.export
  const phase = state.phase
  // Keep the button enabled when OpenH264 is needed (it opens a consent dialog); disable it for every other blocking condition.
  const blocked = vm.blockers.length > 0 || !!state.outDirError || state.settings.baseName.trim() === '' || state.h264.step === 'downloading'
  const startDisabled = blocked || (!vm.canStart && !vm.openh264Required)
  return (
    <aside
      ref={props.drawerRef}
      className="xd"
      role="dialog"
      aria-modal="true"
      aria-labelledby="xd-title"
      data-phase={phase}
      tabIndex={-1}
    >
      <header className="xd-head">
        <h3 id="xd-title">{t.title}</h3>
        <button
          type="button"
          className="icon-btn"
          aria-label={phase === 'running' ? t.minimize : t.close}
          onClick={phase === 'running' ? on.minimize : on.close}
        >
          <X className="ic" />
        </button>
      </header>
      <div className="xd-body">
        {phase === 'settings' && <SettingsBody {...props} />}
        {phase === 'running' && <RunningBody state={state} vm={vm} />}
        {phase === 'done' && <DoneBody state={state} project={props.project} />}
        {phase === 'failed' && <FailedBody state={state} />}
      </div>
      {phase === 'settings' && (
        <div className="xd-summary" role="status" aria-label={t.summaryLabel} data-summary="">
          {summaryText(vm.summary)}
        </div>
      )}
      <footer className="xd-foot">
        {phase === 'settings' && (
          <>
            <button type="button" className="btn-ghost" onClick={on.close}>
              {t.cancel}
            </button>
            <span className="xd-grow" />
            <button type="button" className="btn-accent" disabled={startDisabled} onClick={on.start}>
              <Download className="ic sm" /> {t.startExport}
            </button>
          </>
        )}
        {phase === 'running' && (
          <>
            <span className="xd-grow" />
            <button type="button" className="btn-danger" onClick={on.cancelExport}>
              {t.cancelExport}
            </button>
          </>
        )}
        {phase === 'done' && (
          <>
            <button type="button" className="btn-ghost" onClick={on.openFolder}>
              <FolderOpen className="ic sm" /> {t.openFolder}
            </button>
            <span className="xd-grow" />
            <button type="button" className="btn-accent" onClick={on.finish}>
              {t.finish}
            </button>
          </>
        )}
        {phase === 'failed' && (
          <>
            <button type="button" className="btn-ghost" onClick={on.copyError}>
              <Copy className="ic sm" /> {t.copyError}
            </button>
            <span className="xd-grow" />
            <button type="button" className="btn-ghost" onClick={on.finish}>
              {t.closeBtn}
            </button>
            <button type="button" className="btn-accent" onClick={on.retry}>
              {t.retry}
            </button>
          </>
        )}
      </footer>
      {state.h264.step !== 'idle' && <OpenH264Dialog state={state.h264} onDecline={on.declineConsent} onAccept={on.acceptConsent} />}
    </aside>
  )
}

export interface ExportDrawerProps {
  controller: ExportController
  project: Project
  base: ExportPlanBase | null
  /** Close drawer (settings/completed/failed: caller closes it; running: minimize to badge and continue exporting). */
  onClose: () => void
  /** Player element: the preview shows its current frame. */
  videoRef?: React.RefObject<HTMLVideoElement>
  /** Size (and fps) of the video in the player, so the preview geometry matches its image. */
  previewSource?: PreviewSource | null
}

/** Export drawer container: subscribe to controller, manage focus entry/restoration, trap Tab, and handle Esc (minimize while running; do not cancel). */
export function ExportDrawer({ controller, project, base, onClose, videoRef, previewSource }: ExportDrawerProps): JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const ref = useRef<HTMLElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const items: ExportItem[] = project.items.map((i) => ({ id: i.id, source: i.source, start: i.start, end: i.end }))
  const s = state.settings
  const plan: ExportPlan | null = base ? { ...base, mode: s.mode, quality: s.quality } : null
  const vm = exportViewModel(
    project,
    plan,
    { encoders: state.encoders, openh264: state.openh264Installed, detected: state.detected },
    { format: s.format, trimToLimit: s.trimToLimit, mode: s.mode }
  )
  const { src, geometry } = previewGeometry(project, plan, vm, previewSource)
  const sourceCount = new Set(project.items.map((i) => i.source)).size

  const closeNow = (): void => {
    if (stateRef.current.phase !== 'running') controller.finish()
    onClose()
  }

  // Remember the trigger and move focus into the drawer on open; restore focus on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => {
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [])

  // After a phase change replaces the button, return focus to the drawer to prevent it from falling to body.
  useEffect(() => {
    ref.current?.focus()
  }, [state.phase])

  // Move focus into the consent dialog when it appears.
  const h264Step = state.h264.step
  useEffect(() => {
    if (h264Step !== 'idle') ref.current?.querySelector<HTMLElement>('.xd-consent button:not([disabled])')?.focus()
  }, [h264Step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      const st = stateRef.current
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation() // Handle Esc here only while the drawer is open.
        if (st.h264.step === 'consent' || st.h264.step === 'error') controller.declineConsent()
        else if (st.h264.step === 'downloading') return
        else closeNow() // While running, closeNow only minimizes the drawer; it does not cancel export.
      } else if (e.key === 'Tab') {
        const root = ref.current?.querySelector<HTMLElement>('.xd-consent') ?? ref.current
        if (!root) return
        const list = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'))
        const i = nextTrapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
        if (i >= 0) {
          e.preventDefault()
          list[i].focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller])

  const on: ExportDrawerViewProps['on'] = {
    mode: (m) => controller.setMode(m),
    quality: (q) => void controller.setQuality(q),
    encoder: (e) => controller.setEncoder(e),
    baseName: (n) => controller.setBaseName(n),
    browse: () => void controller.chooseOutDir(),
    start: () => {
      if (vm.openh264Required) void controller.setQuality('precise')
      else if (vm.canStart) void controller.start(items)
    },
    cancelExport: () => void controller.cancel(),
    close: closeNow,
    minimize: onClose,
    retry: () => void controller.retry(),
    finish: closeNow,
    openFolder: () => void controller.openFolder(),
    copyError: () => void navigator.clipboard?.writeText(stateRef.current.result?.error ?? '').catch(() => undefined),
    declineConsent: () => controller.declineConsent(),
    acceptConsent: () => void controller.acceptConsent(),
    preset: (id) => controller.choosePreset(id),
    frame: (f) => controller.setFrame(f),
    reframe: (m) => controller.setReframe(m),
    offset: (o) => controller.setOffset(o),
    codec: (c) => controller.setCodec(c),
    fpsCap: (cap) => controller.setFpsCap(cap),
    trim: (v) => controller.setTrimToLimit(v)
  }

  return (
    <ExportDrawerView
      drawerRef={ref}
      state={state}
      vm={vm}
      project={project}
      items={items}
      sourceCount={sourceCount}
      preview={{ src, geometry, videoRef }}
      on={on}
    />
  )
}
