import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { X } from '../components/icons'
import { recordingI18n as t } from '../i18n'
import { formatBytes } from '../settings/settingsModel'
import { useRecordingStatus } from './useRecordingStatus'
import { useMontageStatus } from './useMontageStatus'
import { useAppSettings } from './useAppSettings'
import './recording.css'
import { tr } from '../../shared/locale'
import { fillTemplate } from '../../shared/template'
import { formatTime } from '../../shared/time'
import type { AutoMontageSettings, MontageJob } from '../../shared/montage'
import type { RecordingMode, RecordingStatus } from '../../shared/recording'

const p = t.panel

type MontageAction = 'open' | 'retry' | 'cancel'

/** Status line and the one action that fits the job's state. */
export function montageLine(job: MontageJob | null, montage: Pick<AutoMontageSettings, 'timing'> | null): { text: string; action: MontageAction | null } {
  const s = t.autoMontage.status
  if (!job) return { text: montage?.timing === 'afterGameExit' ? s.idleExit : s.idleEach, action: null }
  switch (job.state) {
    case 'recorded':
    case 'analyzing':
    case 'selecting':
    case 'deferred':
      return { text: s[job.state], action: 'cancel' }
    case 'exporting':
      return { text: fillTemplate(s.exporting, { pct: Math.round(Math.min(1, Math.max(0, job.progress || 0)) * 100) }), action: 'cancel' }
    case 'done': {
      const dur = formatTime(job.totalSec ?? 0)
      return { text: job.clipCount === 1 ? fillTemplate(s.doneOne, { dur }) : fillTemplate(s.done, { n: job.clipCount ?? 0, dur }), action: 'open' }
    }
    case 'skipped': {
      const reason = job.skipReason ?? 'empty'
      const text = reason !== 'tooFew' ? s.skipped[reason]
        : job.clipCount === undefined ? s.skipped.tooFewNoCount
          : job.clipCount === 1 ? s.skipped.tooFewOne : fillTemplate(s.skipped.tooFew, { n: job.clipCount })
      // Retrying cannot help when the source is gone or is not a VALORANT recording.
      return { text, action: reason === 'notValorant' || reason === 'sourceMissing' ? null : 'retry' }
    }
    case 'failed':
      return { text: job.error ? fillTemplate(s.failed, { error: job.error }) : s.failedUnknown, action: 'retry' }
    case 'cancelled':
      return { text: s.cancelled, action: 'retry' }
  }
}

function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'),path.lastIndexOf('/'))
  return i > 0 ? path.slice(0, i) : path
}

/** Auto montage status in the recording panel: shown while Auto montage is on or a job exists. */
function MontageStatusSection({ onOpenMontage }: { onOpenMontage?: (projectId: string, job: MontageJob) => void }): JSX.Element | null {
  const settings = useAppSettings()
  const { status, error, refresh } = useMontageStatus()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const s = t.autoMontage.status
  const montage = settings?.recording.autoMontage ?? null
  const job = status.active ?? status.jobs[0] ?? null
  if (!montage?.enabled && !job) return null
  const { text, action } = montageLine(job, montage)
  const run = async (kind: MontageAction): Promise<void> => {
    const api = window.api?.montage
    if (!api || !job || busy) return
    setBusy(true)
    setActionError(null)
    try {
      if (kind === 'open') {
        const opened = await api.open(job.id)
        if (!opened) setActionError(s.openFailed)
        else if (onOpenMontage) onOpenMontage(opened.projectId, job)
        else if (job.outputPath) await window.api?.export?.openFolder?.(parentDir(job.outputPath))
      } else {
        if (!await api[kind](job.id)) setActionError(s.actionFailed)
        await refresh()
      }
    } catch {
      setActionError(kind === 'open' ? s.openFailed : s.actionFailed)
    } finally {
      setBusy(false)
    }
  }
  const label = action === 'open' ? s.open : action === 'retry' ? s.retry : s.cancel
  return (
    <section className="rec-montage" aria-labelledby="rec-montage-title">
      <h3 id="rec-montage-title">{s.title}</h3>
      <div className="rec-montage-row">
        <p id="rec-montage-status" className="rec-montage-status" role="status" aria-live="polite">{error && montage?.enabled && !job ? error : text}</p>
        {action && (
          <button type="button" className={`lib-btn${action === 'open' ? ' primary' : ''}`} disabled={busy}
            aria-describedby="rec-montage-status" onClick={() => void run(action)}>{label}</button>
        )}
      </div>
      {actionError && <p className="rec-error" role="alert">{actionError}</p>}
    </section>
  )
}

function elapsedTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

export type PanelTone = 'idle' | 'live' | 'wait' | 'busy' | 'error'

/** The one-line state shown in the panel's pill: Idle / Waiting for match / Recording match N / Saving / Error … */
export function panelState(status: RecordingStatus, mode?: RecordingMode): { label: string; tone: PanelTone } {
  const s = p.states
  switch (status.phase) {
    case 'error': return { label: s.error, tone: 'error' }
    case 'finalizing': return { label: s.saving, tone: 'busy' }
    case 'starting': return { label: s.starting, tone: 'busy' }
    case 'idle': return { label: status.paused ? s.paused : s.idle, tone: 'idle' }
    case 'recording':
      if (status.detectionOnly) return { label: s.detectionOnly, tone: 'wait' }
      if (status.backend === 'obs' && status.obsRecording === false) return { label: s.obsWaiting, tone: 'wait' }
      // Gameplay-only mode keeps nothing outside matches, so between matches the recorder is effectively waiting.
      if (mode === 'match' && status.inMatch === false) return { label: s.waiting, tone: 'wait' }
      if (status.inMatch && status.matchIndex !== null) return { label: fillTemplate(s.recordingMatch, { n: status.matchIndex }), tone: 'live' }
      return { label: s.recording, tone: 'live' }
  }
}

/** A short fix for the recorder errors users can act on. */
export function errorHint(code: string | undefined): string {
  const h = p.hints
  return code && Object.prototype.hasOwnProperty.call(h, code) ? h[code as keyof typeof h] : h.default
}

function captureLabel(capture: RecordingStatus['capture']): string | null {
  const method = capture === 'wgc' ? 'WGC' : capture === 'dda' ? 'DDA' : capture === 'hook' ? 'Hook' : null
  return method ? fillTemplate(p.capture, { method }) : null
}

export function RecordingPanel({ onClose, onWatchLive, onOpenMontage, onOpenSettings }: {
  onClose: () => void
  onWatchLive?: () => void
  /** Open the montage project (id from `montage.open`) in Studio; without it, "Open" shows the montage file's folder. */
  onOpenMontage?: (projectId: string, job: MontageJob) => void
  /** Open Settings → Recording (offered with the fix hint of a recorder error). */
  onOpenSettings?: () => void
}): JSX.Element {
  const { status, error, refresh } = useRecordingStatus()
  const settings = useAppSettings()
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(boxRef, { onEscape: onClose, initialFocus: () => closeRef.current })
  useEffect(() => {
    if (status.phase !== 'recording') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status.phase, status.startedAt])
  const seconds = status.phase === 'recording' && status.startedAt !== null
    ? (now - status.startedAt) / 1000 : status.durationSec
  const run = async (action: 'start' | 'stop' | 'pause', paused?: boolean): Promise<void> => {
    const api = window.api?.recording
    if (!api || busy) return
    setBusy(true)
    setActionError(null)
    try {
      if (action === 'start') {
        if (!await api.startManual()) {
          // Show the failure reason (such as a recorder error) first; report that the game was not found only when there is no error.
          const latest = await api.getStatus()
          setActionError(latest.error?.message ?? t.apexNotRunning)
        }
      } else if (action === 'stop') await api.stopManual()
      else await api.setPaused(paused!)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? `${t.actionFailed} ${err.message}` : t.actionFailed)
    } finally {
      setBusy(false)
    }
  }
  const state = panelState(status, settings?.recording.mode)
  const active = status.phase === 'starting' || status.phase === 'recording'
  const capture = captureLabel(status.capture)
  const overlayOn = settings?.recording.overlay?.enabled !== false
  const tiles: Array<[string, string | number]> = [
    [p.kills, status.kills],
    [p.score, status.score ? `${status.score.ally} – ${status.score.enemy}` : '—'],
    [p.match, status.matchIndex ?? '—'],
    [p.disk, status.diskFreeBytes === null ? t.unknown : formatBytes(status.diskFreeBytes)]
  ]
  const details: Array<[string, string | number]> = [
    [t.segments, status.segments],
    [t.actualEncoder, status.encoder ?? t.unknown],
    [t.resolution, status.width !== null && status.height !== null ? `${status.width} × ${status.height}` : t.unknown],
    [t.dropped, status.droppedFrames]
  ]
  // The recorder's own error gets a fix hint; an action or service failure is shown as is.
  const recorderError = !actionError && !error ? status.error : null
  const banner = actionError ?? error ?? (recorderError ? tr('{code}：{message}', { code: recorderError.code, message: recorderError.message }) : null)
  return (
    <div ref={boxRef} className="sc-dialog rec-panel" role="dialog" aria-modal="true" aria-labelledby="rec-title">
      <header className="sc-head">
        <h2 id="rec-title">{t.statusTitle}</h2>
        <button ref={closeRef} type="button" className="icon-btn" aria-label={t.close} onClick={onClose}><X className="ic" /></button>
      </header>
      <div className="sc-body">
        <section className={`rec-hero tone-${state.tone}`} aria-label={p.title}>
          <div className="rec-hero-top">
            <span className="rec-pill" role="status" aria-live="polite">
              <span className="rec-pill-dot" aria-hidden="true" />
              {state.label}
            </span>
            <span className="rec-chips">
              {capture && <span className="rec-chip">{capture}</span>}
              <span className={`rec-chip${overlayOn ? ' on' : ''}`}>{overlayOn ? p.overlayOn : p.overlayOff}</span>
            </span>
          </div>
          <div className="rec-clock">
            <span className="rec-clock-label">{p.elapsed}</span>
            <span className="rec-clock-time">{elapsedTime(seconds)}</span>
          </div>
        </section>
        <dl className="rec-stats">
          {tiles.map(([label, value]) => <div key={label} className="rec-tile"><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {banner && (
          <div className="rec-banner" role="alert">
            <p className="rec-banner-msg">{banner}</p>
            {recorderError && <p className="rec-banner-fix"><strong>{p.fixTitle}</strong> {errorHint(recorderError.code)}</p>}
            {recorderError && onOpenSettings && (
              <button type="button" className="lib-btn" onClick={onOpenSettings}>{p.openSettings}</button>
            )}
          </div>
        )}
        <div className="rec-actions">
          {active ? (
            <button type="button" className="lib-btn primary rec-main" disabled={busy || !!error} onClick={() => void run('stop')}>
              <span className="rec-stop-ic" aria-hidden="true" />{t.stop}
            </button>
          ) : (
            <button type="button" className="lib-btn primary rec-main" disabled={busy || !!error || status.phase === 'finalizing'}
              onClick={() => void run('start')}>
              <span className="rec-start-ic" aria-hidden="true" />{t.start}
            </button>
          )}
          <button type="button" className="lib-btn" aria-pressed={status.paused} title={p.pauseHint} disabled={busy || !!error}
            onClick={() => void run('pause', !status.paused)}>
            {status.paused ? p.resume : p.pause}
          </button>
          {onWatchLive && (
            <button type="button" className="lib-btn" disabled={status.phase !== 'recording'}
              title={status.phase === 'recording' ? undefined : t.watchLiveHint} onClick={onWatchLive}>{t.watchLive}</button>
          )}
        </div>
        <details className="rec-more">
          <summary>{p.details}</summary>
          <dl className="rec-details">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </details>
        <MontageStatusSection onOpenMontage={onOpenMontage} />
      </div>
    </div>
  )
}
