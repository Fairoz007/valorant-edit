import { i18n } from '../i18n'
import { fillTemplate as fmt } from '../../shared/template'
import { formatTime } from '../../shared/time'
import type { VideoSpec } from '../../shared/encodeQuality'
import { OUTPUT_FRAMES, REFRAME_MODES, type ExportFormat, type OutputFrame, type PresetId, type ReframeMode } from '../../shared/exportFormat'
import { applyPreset, PRESETS, presetState, resolveOutputSpec } from '../../shared/exportPresets'
import type { ReframeGeometry, Size } from '../../shared/reframe'
import { formatBytes, formatFps, type ExportSummary } from './exportViewModel'

/** Preset display name. */
export function presetName(id: PresetId | 'source' | 'custom'): string {
  const t = i18n.export
  const names: Record<PresetId | 'source' | 'custom', string> = {
    source: t.presetSource,
    custom: t.presetCustom,
    youtube: t.presetYoutube,
    shorts: t.presetShorts,
    tiktok: t.presetTiktok,
    reels: t.presetReels,
    square: t.presetSquare
  }
  return names[id]
}

/** Length limit for display: "60 s", "90 s", "10 min". */
export function formatLimit(seconds: number): string {
  const t = i18n.export
  if (seconds >= 120 && seconds % 60 === 0) return fmt(t.durMin, { n: seconds / 60 })
  if (Number.isInteger(seconds) && seconds < 120) return fmt(t.durSec, { n: seconds })
  return formatTime(seconds)
}

export function frameLabel(frame: OutputFrame): string {
  const t = i18n.export
  const labels: Record<OutputFrame, string> = { source: t.frameSource, '16:9': t.frame169, '9:16': t.frame916, '1:1': t.frame11 }
  return labels[frame]
}

export function reframeLabel(mode: ReframeMode): string {
  const t = i18n.export
  const labels: Record<ReframeMode, string> = { crop: t.reframeCrop, blur: t.reframeBlur, bars: t.reframeBars }
  return labels[mode]
}

export const codecLabel = (codec: 'h264' | 'h265'): string => (codec === 'h265' ? 'H.265' : 'H.264')

/** "1080×1920 · 60 fps · H.264 · ~42 MB · 0:48" */
export function summaryText(s: ExportSummary): string {
  const t = i18n.export
  const size = `${s.width}×${s.height}${s.varies ? ` (${t.summaryVaries})` : ''}`
  return [size, fmt(t.summaryFps, { n: formatFps(s.fps) }), codecLabel(s.codec), fmt(t.summarySize, { size: formatBytes(s.bytes) }), formatTime(s.seconds)].join(' · ')
}

/** Small outline of the frame shape (CSS box; 'source' uses the source aspect, dashed). */
function FrameShape({ frame, src }: { frame: OutputFrame; src: Size }): JSX.Element {
  const [w, h] = frame === 'source' ? [src.width, src.height] : frame === '16:9' ? [16, 9] : frame === '9:16' ? [9, 16] : [1, 1]
  const k = 22 / Math.max(w, h)
  return (
    <span
      className={`xd-shape${frame === 'source' ? ' xd-shape-src' : ''}`}
      aria-hidden="true"
      style={{ width: `${Math.max(6, Math.round(w * k))}px`, height: `${Math.max(6, Math.round(h * k))}px` }}
    />
  )
}

interface PresetCardsProps {
  format: ExportFormat
  /** Spec the output is derived from (for presets without a fixed size and for Original). */
  srcSpec: VideoSpec
  onChoose: (id: PresetId | 'source') => void
}

/** Preset cards (radio group): Original + one per platform preset, plus a Custom card while the fields no longer match one. */
export function ExportPresetCards({ format, srcSpec, onChoose }: PresetCardsProps): JSX.Element {
  const t = i18n.export
  const state = presetState(format)
  const src = { width: srcSpec.width, height: srcSpec.height }
  const card = (id: PresetId | 'source', frame: OutputFrame, spec: VideoSpec, maxSeconds: number | null): JSX.Element => {
    const on = state === id
    return (
      <label key={id} className={`xd-card${on ? ' on' : ''}`} data-preset={id} data-selected={on ? 'true' : undefined}>
        <input type="radio" className="xd-vh" name="xd-preset" value={id} checked={on} onChange={() => onChoose(id)} />
        <FrameShape frame={frame} src={src} />
        <b>{presetName(id)}</b>
        <small>{`${spec.width}×${spec.height}`}</small>
        <small>{maxSeconds !== null ? fmt(t.maxLength, { dur: formatLimit(maxSeconds) }) : t.noLimit}</small>
      </label>
    )
  }
  const sourceSpecOut = resolveOutputSpec(srcSpec, { ...format, frame: 'source', width: null, height: null, fpsCap: null })
  return (
    <fieldset className="xd-sec">
      <legend>{t.preset}</legend>
      <div className="xd-cards">
        {card('source', 'source', sourceSpecOut, null)}
        {PRESETS.map((p) => card(p.id, p.frame, resolveOutputSpec(srcSpec, applyPreset(format, p.id)), p.maxSeconds))}
        {state === 'custom' && (
          <label className="xd-card on" data-preset="custom" data-selected="true">
            <input type="radio" className="xd-vh" name="xd-preset" value="custom" checked onChange={() => undefined} />
            <FrameShape frame={format.frame} src={src} />
            <b>{t.presetCustom}</b>
            <small>{t.presetCustomDesc}</small>
          </label>
        )}
      </div>
    </fieldset>
  )
}

interface FormatFieldsProps {
  format: ExportFormat
  geometry: ReframeGeometry
  src: Size
  on: {
    frame: (f: OutputFrame) => void
    reframe: (m: ReframeMode) => void
    offset: (o: number) => void
  }
}

/** Format section: frame, fit mode and the crop-position slider (only while the export actually crops). */
export function ExportFormatFields({ format, geometry, src, on }: FormatFieldsProps): JSX.Element {
  const t = i18n.export
  const cropping = geometry.kind === 'crop'
  // Crop moves along the axis that is cut: horizontal for a wide source in a narrower frame, vertical otherwise.
  const horizontal = geometry.crop.width < Math.floor(src.width / 2) * 2
  const [startLabel, endLabel] = horizontal ? [t.offsetLeft, t.offsetRight] : [t.offsetTop, t.offsetBottom]
  const pct = Math.round(Math.abs(format.offset) * 100)
  const valueText = format.offset === 0 ? t.offsetCenter : fmt(t.offsetValue, { side: format.offset < 0 ? startLabel : endLabel, pct })
  return (
    <fieldset className="xd-sec">
      <legend>{t.format}</legend>
      <fieldset className="xd-group">
        <legend>{t.frame}</legend>
        <div className="xd-seg">
          {OUTPUT_FRAMES.map((f) => (
            <label key={f} className={`xd-chip${format.frame === f ? ' on' : ''}`}>
              <input type="radio" className="xd-vh" name="xd-frame" value={f} checked={format.frame === f} onChange={() => on.frame(f)} />
              {frameLabel(f)}
            </label>
          ))}
        </div>
      </fieldset>
      {format.frame === 'source' ? (
        <div className="xd-muted xd-hint">{t.reframeSourceNote}</div>
      ) : (
        <fieldset className="xd-group">
          <legend>{t.reframe}</legend>
          <div className="xd-seg">
            {REFRAME_MODES.map((m) => (
              <label key={m} className={`xd-chip${format.reframe === m ? ' on' : ''}`}>
                <input type="radio" className="xd-vh" name="xd-reframe" value={m} checked={format.reframe === m} onChange={() => on.reframe(m)} />
                {reframeLabel(m)}
              </label>
            ))}
          </div>
          {geometry.kind === 'scale' && <div className="xd-muted xd-hint">{t.reframeSameAspect}</div>}
        </fieldset>
      )}
      {cropping && (
        <div className="xd-group">
          <div className="xd-range-head">
            <label htmlFor="xd-offset">{t.offset}</label>
            <button type="button" className="btn-ghost xd-mini" disabled={format.offset === 0} onClick={() => on.offset(0)}>
              {t.offsetCenter}
            </button>
          </div>
          <input
            id="xd-offset"
            className="xd-range"
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={format.offset}
            aria-valuetext={valueText}
            onChange={(e) => on.offset(Number(e.target.value))}
          />
          <div className="xd-range-ends" aria-hidden="true">
            <span>{startLabel}</span>
            <span>{endLabel}</span>
          </div>
        </div>
      )}
    </fieldset>
  )
}
