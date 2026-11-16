import { useState } from 'react'
import { OVERLAY_POSITIONS, OVERLAY_RANGES, type OverlaySettings, type RecordingSettings } from '../../shared/recording'
import { recordingI18n } from '../i18n'
import { NumberField, SelectControl, SwitchControl, describedBy, type ControlIds } from './SettingControls'
import type { SettingsController, SettingsState } from './settingsController'
import './overlayPreview.css'

const t = recordingI18n.overlay

export type OverlayField = keyof OverlaySettings | 'test'

/** The same card the game shows, drawn in Settings (styles mirror renderer/overlay/overlay.css). */
export function OverlayPreview({ settings }: { settings: OverlaySettings }): JSX.Element {
  const left = settings.position.endsWith('Left')
  const bottom = settings.position.startsWith('bottom')
  return (
    <figure className={`ovp${left ? ' left' : ''}${bottom ? ' bottom' : ''}`} aria-label={`${t.previewLabel}: ${t.previewTitle} ${t.previewDetail}`}>
      <div className="ovp-screen" aria-hidden="true">
        <div className="ovp-card" style={{ opacity: settings.opacity }}>
          <span className="ovp-title">{t.previewTitle}</span>
          <svg className="ovp-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <circle cx="12" cy="12" r="6.5" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
          </svg>
          <span className="ovp-detail">{t.previewDetail}</span>
        </div>
      </div>
      <figcaption className="set-desc">{t.previewLabel}</figcaption>
    </figure>
  )
}

export function OverlayControl({ field, ids, state, settings, controller }: {
  field: OverlayField
  ids: ControlIds
  state: SettingsState
  settings: RecordingSettings
  controller: SettingsController
}): JSX.Element {
  const overlay = settings.overlay
  const off = !overlay.enabled
  const [test, setTest] = useState<'idle' | 'busy' | 'shown' | 'failed'>('idle')
  switch (field) {
    case 'enabled':
      return <SwitchControl ids={ids} checked={overlay.enabled} onChange={(v) => void controller.setOverlay('enabled', v)} />
    case 'showKills':
    case 'showRounds':
      return <SwitchControl ids={ids} checked={overlay[field]} disabled={off} onChange={(v) => void controller.setOverlay(field, v)} />
    case 'position':
      return <SelectControl ids={ids} value={overlay.position} disabled={off}
        options={OVERLAY_POSITIONS.map((p) => ({ value: p, label: t.positions[p] }))}
        onChange={(v) => void controller.setOverlay('position', v as OverlaySettings['position'])} />
    case 'durationSec':
      return <NumberField id={ids.ctl} value={overlay.durationSec} range={OVERLAY_RANGES.durationSec} syncKey={state.settings}
        describedBy={describedBy(ids)} unit={t.secondsUnit} onCommit={(v) => controller.setOverlay('durationSec', Math.round(v))} />
    case 'opacity': {
      const options = [30, 40, 50, 60, 70, 80, 90, 100].map((pct) => ({ value: String(pct / 100), label: `${pct}%` }))
      const current = String(Math.round(overlay.opacity * 10) / 10)
      return <SelectControl ids={ids} value={options.some((o) => o.value === current) ? current : '0.9'} options={options} disabled={off}
        onChange={(v) => void controller.setOverlay('opacity', Number(v))} />
    }
    case 'test':
      return (
        <div className="set-inline ovp-test">
          <OverlayPreview settings={overlay} />
          <div className="ovp-actions">
            <button id={ids.ctl} type="button" className="set-btn sm" aria-describedby={describedBy(ids)} disabled={test === 'busy'}
              onClick={() => {
                setTest('busy')
                void controller.testOverlay().then((ok) => setTest(ok ? 'shown' : 'failed'))
              }}>
              {t.test}
            </button>
            {test === 'shown' && <small className="set-desc" role="status">{t.testShown}</small>}
            {test === 'failed' && <small className="set-desc" role="alert">{t.testFailed}</small>}
            <small className="set-desc ovp-hint">{t.windowedHint}</small>
          </div>
        </div>
      )
  }
}
