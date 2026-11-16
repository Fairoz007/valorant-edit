import { execFile } from 'child_process'
import type { RecorderCommand } from './recording'

/** One answer from `aditorrec --foreground <pid>` (recorder/src/foreground.rs): window-manager queries only, no process handle. */
export interface ForegroundInfo {
  foregroundPid: number | null
  /** The game's window is the foreground window and is not minimized. */
  gameForeground: boolean
  /** A Direct3D app holds exclusive fullscreen; no other window can appear over it. */
  exclusiveFullscreen: boolean
  /** Game window and its monitor in screen pixels ([x, y, width, height]); null unless the game is in front. */
  gameRect: [number, number, number, number] | null
  monitorRect: [number, number, number, number] | null
  /** The game window covers its whole monitor (Fullscreen or Windowed Fullscreen). */
  coversMonitor: boolean
  /** The monitor runs a resolution other than the desktop one: the game is in Fullscreen with its own display mode. */
  displayModeChanged: boolean
}

const QUERY_TIMEOUT_MS = 3000

function rect(value: unknown): [number, number, number, number] | null {
  return Array.isArray(value) && value.length === 4 && value.every((n) => Number.isSafeInteger(n)) ? value as [number, number, number, number] : null
}

/** Parses the recorder's JSON line; anything malformed is null (unknown). */
export function parseForeground(stdout: string): ForegroundInfo | null {
  try {
    const raw = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '')
    if (!raw || typeof raw !== 'object' || typeof raw.game_foreground !== 'boolean') return null
    return {
      foregroundPid: Number.isSafeInteger(raw.foreground_pid) ? raw.foreground_pid : null,
      gameForeground: raw.game_foreground,
      exclusiveFullscreen: raw.exclusive_fullscreen === true,
      gameRect: rect(raw.game_rect),
      monitorRect: rect(raw.monitor_rect),
      coversMonitor: raw.covers_monitor === true,
      displayModeChanged: raw.display_mode_changed === true
    }
  } catch {
    return null
  }
}

/** Asks aditorrec which window is in front; resolves null when the query cannot run (other platforms, missing binary, timeout). */
export function createForegroundQuery(command: RecorderCommand, platform: NodeJS.Platform = process.platform): (gamePid: number) => Promise<ForegroundInfo | null> {
  return (gamePid) => new Promise((resolve) => {
    if (platform !== 'win32') { resolve(null); return }
    execFile(command.command, [...command.args, '--foreground', String(Math.max(0, Math.trunc(gamePid)))], {
      windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024,
      ...(command.env ? { env: { ...process.env, ...command.env } } : {})
    }, (error, stdout) => resolve(error ? null : parseForeground(String(stdout))))
  })
}
