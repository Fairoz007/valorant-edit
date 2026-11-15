import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Guard for docs/recording-mouse-input-fix.md: calls that can take the foreground from a fullscreen game may only appear in the
 * reviewed places below. A new call site fails this test until it is routed through the focus guard (main/focus-guard.ts) and listed.
 */
const FOCUS_CALL = /\.(show|focus|moveTop|flashFrame|showErrorBox|showMessageBox|showOpenDialog|setAlwaysOnTop)\(|new BrowserWindow\(/g

/** file → number of call sites, each reviewed: inside a focusGuard.run callback, user-initiated, or never focusable. */
const ALLOWED: Record<string, number> = {
  // createWindow(): new BrowserWindow (show: false); ready-to-show and showMainWindow show()/focus() inside focusGuard.run;
  // the quit-blocked showErrorBox inside focusGuard.run.
  'index.ts': 6,
  // Offscreen caption renderer: show: false, focusable: false.
  'export/montage-text.ts': 1,
  // File pickers opened from a click in our own (already focused) window.
  'ipc-handlers.ts': 5,
  // Windows toast: shown by the shell without activation.
  'notify.ts': 1
}

function sources(dir: string, root = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(full, root)
    return /\.ts$/.test(entry.name) && !/\.(test|bench)\.ts$/.test(entry.name) && !entry.name.includes('test-support') ? [full] : []
  })
}

describe('No focus-taking calls outside reviewed places', () => {
  it('matches the reviewed list exactly', () => {
    const root = __dirname
    const found: Record<string, number> = {}
    for (const file of sources(root)) {
      const text = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')
      const count = text.match(FOCUS_CALL)?.length ?? 0
      if (count) found[path.relative(root, file).split(path.sep).join('/')] = count
    }
    expect(found).toEqual(ALLOWED)
  })
})
