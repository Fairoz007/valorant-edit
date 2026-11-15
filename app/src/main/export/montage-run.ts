/**
 * Montage render stage, running half: drives the segment jobs, the concat, the Node music mix and the final mux under
 * one AbortSignal. Temp files live in one directory that is removed on success, failure and cancel; the output is
 * written as `<name>.partial.mp4` and published without overwriting existing files.
 *
 * Steps: [decode music → beats → snap items] → text PNGs → blur-frame grabs → segments → concat
 *        → [decode game audio → mix → mux].
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { STYLE_PRESETS } from '../../shared/autoEdit'
import type { StreamProbe } from '../../shared/exportCompat'
import type { ExportFormat } from '../../shared/exportFormat'
import { appDataDir, codecsDir } from '../../shared/paths'
import { escapeConcatPath } from './plan'
import { checkDiskSpace, exportFailureMessage, partialPathFor, type RunProgress } from './run'
import { killTree } from './killTree'
import { defaultFfprobePath } from './keyframe'
import { detectBeatsInFile, MixCancelled, mixPcmFiles } from './montage-audio'
import {
  blurFrameSize,
  cardSegmentArgs,
  clipSegmentArgs,
  concatArgs,
  decodePcmArgs,
  frameGrabArgs,
  layoutMontage,
  montagePlannedSec,
  muxArgs,
  snapItemsToBeats,
  type MontageItem,
  type MontageLayout,
  type MontageProjectStyle,
  type PngInput
} from './montage-plan'
import { encodePng, pngSize, type RenderTextPng } from './montage-text'

export type MontageErrorCode = 'montageFfmpeg' | 'montageText' | 'montageMusic' | 'montageIo' | 'montageDisk'

export type MontageRunResult =
  | { ok: true; outputs: string[]; expectedSec: number; plannedSec: number }
  | { ok: false; cancelled: true; outputs: string[] }
  | { ok: false; cancelled?: false; code: MontageErrorCode; error: string; outputs: string[] }

export interface MontageRunRequest {
  items: MontageItem[]
  style: MontageProjectStyle
  format: ExportFormat
  encoder: string
  probes: Map<string, StreamProbe>
  /** Sources without an audio stream (silence is inserted). */
  silentSources?: ReadonlySet<string>
  outputDir: string
  baseName: string
  estimatedBytes: number
}

export interface MontageRunDeps {
  ffmpeg?: { bin: string; prefixArgs?: string[] }
  ffprobe?: string
  /** Parent of the per-export temp directory; defaults to `%APPDATA%\Valorant Editor\temp`. */
  tempDir?: string
  renderTextPng: RenderTextPng
  /** Source duration for beat sync (extend only within the source); defaults to ffprobe. */
  probeDuration?: (file: string, signal?: AbortSignal) => Promise<number | null>
}

export interface MontageRunControl {
  signal?: AbortSignal
  onProgress?: (p: RunProgress) => void
}

class StepError extends Error {
  constructor(readonly code: MontageErrorCode, message: string) {
    super(message)
  }
}
class Cancelled extends Error {}

const STDERR_TAIL = 4096

function spawnFfmpeg(
  deps: MontageRunDeps,
  args: string[],
  signal: AbortSignal | undefined,
  onTime: (sec: number) => void
): Promise<void> {
  const bin = deps.ffmpeg?.bin ?? (process.env.ADITOR_FFMPEG || 'ffmpeg')
  const env: NodeJS.ProcessEnv = { ...process.env }
  const cDir = codecsDir()
  if (fs.existsSync(cDir)) env.PATH = `${cDir}${path.delimiter}${process.env.PATH || ''}`
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled())
    const proc = spawn(bin, [...(deps.ffmpeg?.prefixArgs ?? []), '-hide_banner', '-nostdin', '-progress', 'pipe:1', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let stderr = ''
    let rest = ''
    let spawnError: Error | null = null
    const onAbort = (): void => void killTree(proc)
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout?.on('data', (d) => {
      const lines = (rest + d.toString()).split('\n')
      rest = lines.pop() ?? ''
      for (const l of lines) {
        if (!l.startsWith('out_time_us=')) continue
        const us = parseInt(l.slice(12), 10)
        if (Number.isFinite(us)) onTime(us / 1e6)
      }
    })
    proc.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-STDERR_TAIL * 2)
    })
    proc.on('error', (err) => {
      spawnError = err
      if (proc.pid === undefined) {
        signal?.removeEventListener('abort', onAbort)
        reject(new StepError('montageFfmpeg', `Could not start ffmpeg: ${err.message}`))
      }
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(new Cancelled())
      else if (spawnError) reject(new StepError('montageFfmpeg', `Could not start ffmpeg: ${spawnError.message}`))
      else if (code === 0) resolve()
      else reject(new StepError('montageFfmpeg', exportFailureMessage(code, stderr)))
    })
  })
}

/** Default duration probe: `ffprobe format=duration`. */
export function createDurationProbe(ffprobe: string = defaultFfprobePath()): (file: string, signal?: AbortSignal) => Promise<number | null> {
  return (file, signal) =>
    new Promise((resolve) => {
      const proc = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      const onAbort = (): void => void killTree(proc)
      signal?.addEventListener('abort', onAbort, { once: true })
      proc.stdout?.on('data', (d) => (out += d.toString()))
      proc.on('error', () => resolve(null))
      proc.on('close', () => {
        signal?.removeEventListener('abort', onAbort)
        const v = parseFloat(out.trim())
        resolve(Number.isFinite(v) && v > 0 ? v : null)
      })
    })
}

async function publish(partial: string, target: string): Promise<string> {
  const ext = path.extname(target)
  const stem = path.join(path.dirname(target), path.basename(target, ext))
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? target : `${stem} (${n})${ext}`
    try {
      try {
        await fs.promises.link(partial, candidate)
      } catch (err) {
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
        await fs.promises.copyFile(partial, candidate, fs.constants.COPYFILE_EXCL)
      }
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

async function removeRetry(p: string, recursive = false): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      await fs.promises.rm(p, { force: true, recursive })
      return
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) return
      await new Promise((r) => setTimeout(r, 100 * (i + 1)))
    }
  }
}

/** Steps with weights (seconds of output-equivalent work) for progress. */
interface Step {
  weight: number
  run: (onFraction: (f: number) => void) => Promise<void>
}

export async function runMontage(req: MontageRunRequest, deps: MontageRunDeps, control: MontageRunControl = {}): Promise<MontageRunResult> {
  const { signal } = control
  if (signal?.aborted) return { ok: false, cancelled: true, outputs: [] }
  const tempRoot = path.join(deps.tempDir ?? path.join(appDataDir(), 'temp'), `montage-${randomUUID()}`)
  const tmp = (name: string): string => path.join(tempRoot, name)
  const finalTarget = path.join(req.outputDir, `${req.baseName}.mp4`)
  let partial: string | null = null
  const music = req.style.music ?? null
  const beatSync = music !== null && STYLE_PRESETS[req.style.style ?? 'clean'].beatSync

  try {
    try {
      await checkDiskSpace(req.outputDir, req.estimatedBytes * 2)
    } catch (err) {
      throw new StepError('montageDisk', (err as Error).message)
    }
    await fs.promises.mkdir(tempRoot, { recursive: true }).catch((err: Error) => {
      throw new StepError('montageIo', `Could not create the temporary folder: ${err.message}`)
    })

    const planned = montagePlannedSec(req.items, req.style)
    const ff = (args: string[], onFraction: (f: number) => void, sec: number): Promise<void> =>
      spawnFfmpeg(deps, args, signal, (t) => onFraction(sec > 0 ? Math.min(1, t / sec) : 0))

    // Step runner with weighted progress across all steps (steps can be appended while running).
    const steps: Step[] = []
    let doneWeight = 0
    let stepIndex = 0
    const report = (fraction: number): void => {
      const total = steps.reduce((s, x) => s + x.weight, 0)
      const percent = total > 0 ? Math.min(100, Math.round(((doneWeight + fraction * steps[stepIndex].weight) / total) * 100)) : 0
      try {
        control.onProgress?.({ jobIndex: stepIndex, totalJobs: steps.length, percent, outTimeSeconds: (doneWeight + fraction * steps[stepIndex].weight) })
      } catch {
        // A progress callback error must not affect the export.
      }
    }
    const runSteps = async (from: number): Promise<void> => {
      for (stepIndex = from; stepIndex < steps.length; stepIndex++) {
        if (signal?.aborted) throw new Cancelled()
        await steps[stepIndex].run(report)
        doneWeight += steps[stepIndex].weight
        report(0)
      }
    }

    // 1. Music: decode once (used for beats and the mix); beat sync snaps item ends before anything is laid out.
    let items = req.items
    const musicPcm = tmp('music.f32')
    if (music) {
      steps.push({
        weight: planned * 0.05,
        run: async (p) => {
          try {
            await ff(decodePcmArgs(music.path, planned + 1, musicPcm), p, planned)
          } catch (err) {
            if (err instanceof StepError) throw new StepError('montageMusic', err.message)
            throw err
          }
        }
      })
      if (beatSync) {
        steps.push({
          weight: planned * 0.02,
          run: async () => {
            const beats = await detectBeatsInFile(musicPcm, signal)
            const probe = deps.probeDuration ?? createDurationProbe(deps.ffprobe)
            const durations = new Map<string, number | null>()
            for (const s of new Set(items.map((it) => it.source))) durations.set(s, await probe(s, signal))
            items = snapItemsToBeats(items, beats, req.style.intro?.durationSec ?? 0, (s) => durations.get(s) ?? null)
          }
        })
      }
      await runSteps(0)
    }

    // 2. Layout (after beat sync), text PNGs and background frames.
    const layout: MontageLayout = layoutMontage(items, req.style, { format: req.format, probes: req.probes, silentSources: req.silentSources })
    const writePng = async (name: string, png: Buffer): Promise<PngInput> => {
      const size = pngSize(png)
      if (!size) throw new StepError('montageText', 'Caption rendering returned an invalid image')
      const file = tmp(name)
      await fs.promises.writeFile(file, png)
      return { path: file, ...size }
    }
    const render = async (text: string, heightPx: number, background: 'transparent' | 'pill'): Promise<Buffer> => {
      try {
        return await deps.renderTextPng(text, { heightPx, background })
      } catch (err) {
        throw new StepError('montageText', `Caption rendering failed: ${(err as Error).message}`)
      }
    }
    const captionPngs: PngInput[] = []
    const cardPngs = new Map<string, { text: PngInput; background: PngInput | null }>()
    const first = steps.length
    steps.push({
      weight: 0.5 + layout.captions.length * 0.1,
      run: async () => {
        for (const [i, text] of layout.captions.entries()) captionPngs.push(await writePng(`caption-${i}.png`, await render(text, layout.captionHeightPx, 'pill')))
        for (const seg of layout.segments) {
          if (seg.kind !== 'card') continue
          const text = await writePng(`${seg.which}-text.png`, await render(seg.card.text, layout.cardHeightPx, 'transparent'))
          cardPngs.set(seg.which, { text, background: null })
        }
      }
    })
    for (const seg of layout.segments) {
      if (seg.kind !== 'card' || seg.card.background !== 'blurFrame' || !seg.frameAt) continue
      const raw = tmp(`${seg.which}-frame.rgb`)
      const frameAt = seg.frameAt
      steps.push({
        weight: 0.3,
        run: async (p) => {
          await ff(frameGrabArgs(frameAt.source, frameAt.t, req.probes.get(frameAt.source), layout, req.format, raw), p, 0)
          const s = blurFrameSize(layout.out)
          const rgb = await fs.promises.readFile(raw)
          if (rgb.length < s.width * s.height * 3) return // No frame (source too short): the card falls back to black.
          const bg = await writePng(`${seg.which}-frame.png`, encodePng(rgb.subarray(0, s.width * s.height * 3), s.width, s.height, 3))
          cardPngs.get(seg.which)!.background = bg
        }
      })
    }

    // 3. Segments, then concat.
    const segFiles: string[] = []
    layout.segments.forEach((seg, i) => {
      const file = tmp(`seg-${String(i + 1).padStart(4, '0')}.mov`)
      segFiles.push(file)
      const sec = seg.frames / layout.out.fps
      steps.push({
        weight: sec,
        run: (p) => {
          if (seg.kind === 'clip') {
            return ff(clipSegmentArgs(seg, { layout, format: req.format, encoder: req.encoder, probe: req.probes.get(seg.source), captionPngs, output: file }), p, sec)
          }
          const card = cardPngs.get(seg.which)!
          return ff(cardSegmentArgs(seg, { layout, format: req.format, encoder: req.encoder, text: card.text, background: card.background, output: file }), p, sec)
        }
      })
    })
    const list = tmp('concat.txt')
    const montageMov = tmp('montage.mov')
    partial = partialPathFor(finalTarget.slice(0, -4) + `.${randomUUID().slice(0, 8)}.mp4`)
    const partialPath = partial
    steps.push({
      weight: layout.expectedSec * 0.1,
      run: async (p) => {
        const lines = segFiles.map((f, i) => `file ${escapeConcatPath(f)}\nduration ${(layout.segments[i].frames / layout.out.fps).toFixed(6)}`)
        await fs.promises.writeFile(list, lines.join('\n') + '\n', 'utf-8')
        await ff(concatArgs(list, req.format, music ? 'pcm' : 'aac', music ? montageMov : partialPath), p, layout.expectedSec)
      }
    })

    // 4. Music mix and final mux.
    if (music) {
      const gamePcm = tmp('game.f32')
      const mixPcm = tmp('mix.avi')
      steps.push({ weight: layout.expectedSec * 0.05, run: (p) => ff(decodePcmArgs(montageMov, null, gamePcm), p, layout.expectedSec) })
      steps.push({
        weight: layout.expectedSec * 0.1,
        run: async (p) => {
          try {
            await mixPcmFiles(gamePcm, musicPcm, mixPcm, { gain: music.gain, fadeInSec: music.fadeInSec, fadeOutSec: music.fadeOutSec, duck: music.duck }, { signal, onProgress: p })
          } catch (err) {
            if (err instanceof MixCancelled) throw new Cancelled()
            throw new StepError('montageMusic', `Music mixing failed: ${(err as Error).message}`)
          }
        }
      })
      steps.push({ weight: layout.expectedSec * 0.05, run: (p) => ff(muxArgs(montageMov, mixPcm, req.format, partialPath), p, layout.expectedSec) })
    }

    await runSteps(first)
    let published: string
    try {
      published = await publish(partialPath, finalTarget)
    } catch (err) {
      throw new StepError('montageIo', `Could not write the output file: ${(err as Error).message}`)
    }
    return { ok: true, outputs: [published], expectedSec: layout.expectedSec, plannedSec: layout.plannedSec }
  } catch (err) {
    if (err instanceof Cancelled || signal?.aborted) return { ok: false, cancelled: true, outputs: [] }
    if (err instanceof StepError) return { ok: false, code: err.code, error: err.message, outputs: [] }
    return { ok: false, code: 'montageIo', error: (err as Error).message, outputs: [] }
  } finally {
    if (partial) await removeRetry(partial)
    await removeRetry(tempRoot, true)
  }
}
