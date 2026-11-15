import React, { useEffect, useRef, useState } from 'react'
import type { ReframeGeometry, Size } from '../../shared/reframe'
import { i18n } from '../i18n'

/**
 * Live reframe preview. Every position and size is a percentage derived from computeReframe() — the same geometry the export
 * filter uses — so the preview shows exactly what is exported:
 * - crop / scale: the whole source frame with the exported region outlined and the rest dimmed;
 * - bars / blur: a small mock of the output frame (foreground at `pos`/`scaled`, background black or the blurred fill).
 * The image is the player's current frame, drawn into canvases (drawImage works for any video origin); without a frame a neutral
 * placeholder with the same aspect is shown.
 */
export interface ExportPreviewProps {
  geometry: ReframeGeometry
  /** Source size the geometry was computed for (the size of the video the image comes from). */
  src: Size
  /** Player element to take the current frame from (optional; tests and the dev fixture have none). */
  videoRef?: React.RefObject<HTMLVideoElement>
  /** Accessible description (frame and fit). */
  label: string
}

const pct = (v: number, of: number): string => `${of > 0 ? Math.round((v / of) * 10000) / 100 : 0}%`

/** Canvas resolution (cheap: a thumbnail, not the export). */
const CANVAS_W = 320

/** Draw the player's current frame into every canvas whenever it changes (load, seek, playback ticks); returns whether a frame was drawn. */
function useVideoFrame(videoRef: React.RefObject<HTMLVideoElement> | undefined, canvases: Array<React.RefObject<HTMLCanvasElement>>, key: string): boolean {
  const [hasFrame, setHasFrame] = useState(false)
  useEffect(() => {
    const v = videoRef?.current
    if (!v) return
    let raf = 0
    const draw = (): void => {
      raf = 0
      if (v.readyState < 2 || !v.videoWidth) {
        setHasFrame(false)
        return
      }
      let drawn = false
      for (const ref of canvases) {
        const el = ref.current
        const ctx = el?.getContext('2d')
        if (!el || !ctx) continue
        try {
          ctx.drawImage(v, 0, 0, el.width, el.height)
          drawn = true
        } catch {
          // A frame that cannot be drawn (decoder reset): keep the placeholder.
        }
      }
      setHasFrame(drawn)
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    draw()
    const events = ['loadeddata', 'seeked', 'timeupdate'] as const
    for (const e of events) v.addEventListener(e, schedule)
    return () => {
      for (const e of events) v.removeEventListener(e, schedule)
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, key])
  return hasFrame
}

/** Box sized by width for landscape-ish shapes and by height for tall ones (keeps tall previews from growing the drawer). */
function boxStyle(w: number, h: number): React.CSSProperties {
  const ratio = w / h
  return ratio >= 1.5 ? { aspectRatio: `${w} / ${h}`, width: '100%' } : { aspectRatio: `${w} / ${h}`, height: 'var(--xd-pv-h)' }
}

export function ExportPreview({ geometry: g, src, videoRef, label }: ExportPreviewProps): JSX.Element {
  const t = i18n.export
  const fg = useRef<HTMLCanvasElement>(null)
  const bg = useRef<HTMLCanvasElement>(null)
  const sourceView = g.kind === 'crop' || g.kind === 'scale'
  const canvasH = Math.max(2, Math.round((CANVAS_W * src.height) / src.width))
  const hasFrame = useVideoFrame(videoRef, g.kind === 'blur' ? [fg, bg] : [fg], `${g.kind}:${src.width}x${src.height}`)
  const canvas = (ref: React.RefObject<HTMLCanvasElement>, className: string): JSX.Element => (
    <canvas ref={ref} className={className} width={CANVAS_W} height={canvasH} aria-hidden="true" />
  )
  const placeholder = !hasFrame && <span className="xd-pv-empty">{t.previewNone}</span>

  if (sourceView) {
    const c = g.crop
    return (
      <div className="xd-pv-stage">
        <div
          className={`xd-pv xd-pv-source${hasFrame ? ' has-frame' : ''}`}
          role="img"
          aria-label={label}
          data-kind={g.kind}
          style={boxStyle(src.width, src.height)}
        >
          {canvas(fg, 'xd-pv-img')}
          {placeholder}
          <span
            className="xd-pv-frame"
            aria-hidden="true"
            data-crop-x={c.x}
            data-crop-y={c.y}
            data-crop-w={c.width}
            data-crop-h={c.height}
            style={{ left: pct(c.x, src.width), top: pct(c.y, src.height), width: pct(c.width, src.width), height: pct(c.height, src.height) }}
          />
        </div>
      </div>
    )
  }

  const { width: W, height: H } = g.out
  const back = g.background
  return (
    <div className="xd-pv-stage">
      <div
        className={`xd-pv xd-pv-out xd-pv-${g.kind}${hasFrame ? ' has-frame' : ''}`}
        role="img"
        aria-label={label}
        data-kind={g.kind}
        style={boxStyle(W, H)}
      >
        {back && (
          <span
            className="xd-pv-bg"
            aria-hidden="true"
            style={{ left: pct(-back.crop.x, W), top: pct(-back.crop.y, H), width: pct(back.scaled.width, W), height: pct(back.scaled.height, H) }}
          >
            {canvas(bg, 'xd-pv-img')}
          </span>
        )}
        <span
          className="xd-pv-fg"
          aria-hidden="true"
          data-pos-x={g.pos.x}
          data-pos-y={g.pos.y}
          data-scaled-w={g.scaled.width}
          data-scaled-h={g.scaled.height}
          style={{ left: pct(g.pos.x, W), top: pct(g.pos.y, H), width: pct(g.scaled.width, W), height: pct(g.scaled.height, H) }}
        >
          {canvas(fg, 'xd-pv-img')}
        </span>
        {placeholder}
      </div>
    </div>
  )
}
