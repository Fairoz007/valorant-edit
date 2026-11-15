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

export function RecordingPanel({ onClose, onWatchLive, onOpenMontage }: {
  onClose: () => void
  onWatchLive?: () => void
  /** Open the montage project (id from `montage.open`) in Studio; without it, "Open" shows the montage file's folder. */
  onOpenMontage?: (projectId: string, job: MontageJob) => void
}): JSX.Element {
  const { status, error, refresh } = useRecordingStatus()
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
          // Show the failure reason (such as a recorder error) first; report that Apex was not found only when there is no error.
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
  const rows: Array<[string, string | number]> = [
    [t.statusTitle, status.phase === 'recording' ? status.detectionOnly ? t.detectionOnly : status.backend === 'obs' ? status.obsRecording === false ? t.obsStandby : t.obsRecording : t.phases[status.phase] : t.phases[status.phase]],
    [t.elapsed, elapsedTime(seconds)],
    [t.segments, status.segments],
    [t.actualEncoder, status.encoder ?? t.unknown],
    [t.resolution, status.width !== null && status.height !== null ? `${status.width} × ${status.height}` : t.unknown],
    [t.dropped, status.droppedFrames],
    [t.matchIndex, status.matchIndex ?? '—'],
    [t.kills, status.kills],
    [t.diskFree, status.diskFreeBytes === null ? t.unknown : formatBytes(status.diskFreeBytes)]
  ]
  return (
    <div ref={boxRef} className="sc-dialog rec-panel" role="dialog" aria-modal="true" aria-labelledby="rec-title">
      <header className="sc-head">
        <h2 id="rec-title">{t.statusTitle}</h2>
        <button ref={closeRef} type="button" className="icon-btn" aria-label={t.close} onClick={onClose}><X className="ic" /></button>
      </header>
      <div className="sc-body">
        <dl className="rec-details">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {(actionError || error || status.error) && <p className="rec-error" role="alert">{actionError ?? error ?? tr('{code}：{message}', { code: status.error?.code, message: status.error?.message })}</p>}
        <div className="rec-actions">
          <button type="button" className="lib-btn" disabled={busy || !!error || !['idle', 'error'].includes(status.phase)} onClick={() => void run('start')}>{t.start}</button>
          <button type="button" className="lib-btn" disabled={busy || !!error || !['starting', 'recording'].includes(status.phase)} onClick={() => void run('stop')}>{t.stop}</button>
          {onWatchLive && (
            <button type="button" className="lib-btn primary" disabled={status.phase !== 'recording'}
              title={status.phase === 'recording' ? undefined : t.watchLiveHint} onClick={onWatchLive}>{t.watchLive}</button>
          )}
          <label className="rec-pause"><input type="checkbox" checked={status.paused} disabled={busy || !!error} onChange={(e) => void run('pause', e.target.checked)} />{t.pauseAuto}</label>
        </div>
        <MontageStatusSection onOpenMontage={onOpenMontage} />
      </div>
    </div>
  )
}
