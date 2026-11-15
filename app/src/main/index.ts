import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage } from 'electron'
import { createMediaAccess, handleMediaRequest, MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES } from './media-protocol'
import { proxyDir } from '../shared/paths'
import { createAppQuitGuard } from './quit-guard'
import { delimiter, join, resolve } from 'path'
import { EngineClient } from './engine'
import { Library } from './library'
import { AnalysisQueue } from './queue'
import { SettingsStore, loadSettings } from './settings'
import { initializeTelemetry, updateTelemetryConsent, reportChildDiagnostic } from './telemetry'
import { WatchManager } from './watch'
import { ProjectStore } from './projects'
import { registerIpcHandlers } from './ipc-handlers'
import { createCloseGate } from './project-ipc'
import { currentE2EConfig } from './e2e'
import { applyWindowSecurity } from './window-security'
import { applyAppUserModelId } from './app-identity'
import { sanitizeAnalyzeArgs, sanitizeAutoclipArgs, sanitizeProbeArgs } from './ipc-guards'
import { aditorrecCommand, appDataDir, cacheDir, chromiumUserDataDir, engineCommand, ffmpegExecutable, liveEngineCommand, obsHookDir, profileDir, sceneDir } from '../shared/paths'
import { cacheFilePath, loadCacheDoc, resolveCacheFile } from './cache-io'
import { generateThumbnail, cancelAllThumbnails } from './thumbnail'
import { createRecordingService } from './recording'
import { registerRecordingIpc } from './recording-ipc'
import { createRecordingTray } from './tray'
import { resolveLocale, setActiveLocale, tr, type Locale } from '../shared/locale'
import { createRecordingNotifier } from './notify'
import type { RecordingService } from '../shared/recording'
import { obsPassword } from './settings-ipc'
import { createDiagnosticLog } from './recording/diagnostic-log'
import { canAutoUpdate, createAppUpdater, loadAutoUpdater, type AppUpdaterService } from './updater'
import { broadcastUpdateStatus, registerUpdateIpc } from './update-ipc'
import fs from 'fs'
import { createMontageService, type MontageService } from './montage/montage-service'
import { MontageJobStore } from './montage/montage-job'
import { cleanupMontageOutput, createMontageRenderer, createOutputProbe } from './montage/montage-export'
import { broadcastMontageStatus, registerMontageIpc } from './montage/montage-ipc'
import { diskFreeBytes } from './recording/disk'
import type { CacheDoc, Clip } from '../shared/types'
import { createFocusGuard } from './focus-guard'
import { createForegroundQuery } from './foreground'

// E2E hooks (ADITOR_E2E=1 only): use temporary appData/userData so tests do not touch user data; null in production.
const e2e = currentE2EConfig()
if (e2e?.appData) process.env.APPDATA = e2e.appData
// Must be set before ready: the default userData Cache and analysis cache use the same directory (see chromiumUserDataDir).
app.setPath('userData', chromiumUserDataDir())
// Windows toasts and taskbar grouping need the installer's appId; set it before any notification or window exists.
applyAppUserModelId(app)
// Library videos, thumbnails and proxies reach the renderer only through this scheme (never file://); must be registered before ready.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: MEDIA_SCHEME_PRIVILEGES }])

let mainWindow: BrowserWindow | null = null
let engineClient: EngineClient | null = null
let library: Library | null = null
/** Which files `aditor-media:` may serve: library videos and thumbnails, the proxy/thumbnail cache, and saved-project sources. */
const mediaAccess = createMediaAccess({
  libraryEntries: () => library?.getEntries() ?? [],
  cacheRoots: () => [proxyDir()]
})
let queue: AnalysisQueue | null = null
let settingsStore: SettingsStore | null = null
let watchManager: WatchManager | null = null
let closeGate: ReturnType<typeof createCloseGate> | null = null
let cancelExport: (() => Promise<void>) | null = null
let recordingService: RecordingService | null = null
let tray: ReturnType<typeof createRecordingTray> | null = null
let unregisterRecordingIpc: (() => void) | null = null
let unsubscribeSettings: (() => void) | null = null
let appUpdater: AppUpdaterService | null = null
let montageService: MontageService | null = null
let quitting = false
/** Currently active interface language (from the `language` setting; English by default, `auto` follows the Windows display language). */
let locale: Locale = 'en'
let servicesReady = false
let openRequested = !process.argv.includes('--hidden')
/** Maximum time to wait before closing the window when the renderer does not respond to flush. */
const CLOSE_FLUSH_TIMEOUT_MS = 1500
/** PID of the detected game (null when none); set by the recording service's process poll. */
let gamePid: number | null = null
/** Diagnostic log for focus decisions; replaced by recording.log once services start. */
let focusLog: (message: string) => void = () => {}
const queryForeground = createForegroundQuery(aditorrecCommand(app.isPackaged))
/**
 * While the game is the foreground window nothing may show, focus or raise a window of ours (docs/recording-mouse-input-fix.md):
 * a fullscreen game that loses the foreground releases its mouse capture. Such calls wait until the game loses focus or exits.
 */
const focusGuard = createFocusGuard({
  isGameForeground: async () => {
    if (gamePid === null) return false
    const info = await queryForeground(gamePid)
    return info ? info.gameForeground : null
  },
  log: (message) => focusLog(message)
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: join(app.isPackaged ? process.resourcesPath : resolve(__dirname, '../..'), 'resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // preload uses only contextBridge/ipcRenderer and can run in the sandbox (I2).
      sandbox: true,
      contextIsolation: true
    }
  })

  applyWindowSecurity(mainWindow.webContents)

  // Ask the renderer to immediately save the latest project before closing (a second safeguard beyond beforeunload's sendSync).
  // Close only after receiving flushDone or timing out.
  const win = mainWindow
  const rendererAlive = (): boolean => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
  const shouldHide = (): boolean => !quitting && tray !== null && settingsStore?.get().recording.closeToTray === true
  const makeCloseGate = (): ReturnType<typeof createCloseGate> => createCloseGate({
    request: () => win.webContents.send('projects:flushRequest'),
    close: () => {
      if (shouldHide()) {
        win.hide()
        // Recreate the handshake each time the app is minimized to the tray so the latest project is saved on the next close.
        closeGate = makeCloseGate()
      } else win.close()
    },
    timeoutMs: CLOSE_FLUSH_TIMEOUT_MS,
    rendererAlive,
    isQuitting: () => quitting,
    quit: () => app.quit()
  })
  closeGate = makeCloseGate()
  win.on('close', (e) => {
    if (shouldHide() && !rendererAlive()) {
      e.preventDefault()
      win.hide()
      return
    }
    closeGate?.onClose(e)
  })
  // Ask the renderer to pause playback when minimized to the tray or taskbar so audio does not continue in the background.
  const pausePlayback = (): void => {
    if (rendererAlive()) win.webContents.send('app:windowHidden')
  }
  win.on('hide', pausePlayback)
  win.on('minimize', pausePlayback)
  win.on('closed', () => {
    closeGate = null
    mainWindow = null
    // Cancel exports when the window closes so ffmpeg is not orphaned (webContents 'destroyed' triggers the same cancellation).
    void cancelExport?.()
  })

  // Electron emits ready-to-show on every first paint of a new document, including a reload of a window hidden in the tray
  // (language change); showing only once keeps a reload from popping the window over the game.
  win.once('ready-to-show', () => {
    void focusGuard.run('main-window', () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    }, { userInitiated: true })
  })
  // Diagnostic: every focus change of our window with the game state, so a report of lost input can be checked against recording.log.
  win.on('focus', () => focusLog(`main window focus (game pid ${gamePid ?? 'none'})`))
  win.on('blur', () => focusLog('main window blur'))

  loadRenderer(mainWindow)
}

/** Read the language from the URL's `lang` when the renderer starts; reload with the new language after a change (beforeunload saves unsaved projects first). */
function loadRenderer(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('lang', locale)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { lang: locale } })
  }
}

/** Resolve the interface language again from settings; return whether it changed. */
function syncLocale(): boolean {
  const next = resolveLocale(settingsStore?.get().language, app.getLocale())
  if (next === locale) return false
  locale = next
  setActiveLocale(next)
  return true
}

/** `userInitiated`: the user asked (tray, second launch, app start); an unknown foreground then does not block it, a game in front still does. */
function showMainWindow(userInitiated = true): void {
  openRequested = true
  if (!servicesReady || quitting) return
  void focusGuard.run('main-window', () => {
    if (quitting) return
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  }, { userInitiated })
}

async function initEngineAndServices(): Promise<void> {
  if (app.isPackaged) {
    const ffmpegPath = ffmpegExecutable(true)
    process.env.ADITOR_FFMPEG = ffmpegPath
    const binDir = resolve(join(ffmpegPath, '..'))
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH || ''}`
  } else if (!process.env.ADITOR_FFMPEG) {
    // Development: use FFmpeg staged in build/ffmpeg/bin when present (engine, thumbnails, keyframe probes and export).
    const devFfmpeg = ffmpegExecutable(false)
    if (devFfmpeg !== 'ffmpeg') process.env.ADITOR_FFMPEG = devFfmpeg
  }

  const cmd = e2e?.fakeEngine ?? engineCommand(app.isPackaged)
  engineClient = new EngineClient({ ...cmd, onDiagnostic: reportChildDiagnostic })
  try {
    const res = await engineClient.start()
    console.log(`[Engine] Ready, version: ${res.engineVersion}`)
  } catch (err) {
    console.error('[Engine] Failed to start engine:', err)
  }

  // Leftover partial proxy files from the previous interrupted run.
  ;(await import('./proxy')).cleanStaleProxyPartials()

  const templateProfileDir = profileDir(app.isPackaged)

  library = new Library(join(appDataDir(), 'library.json'), (file) => recordingService?.noteOutputRemoval?.(file))
  // Reset leftover "analyzing" entries from the previous interrupted run; no queue is processing them.
  library.resetStaleAnalyzing()
  settingsStore = new SettingsStore(join(appDataDir(), 'settings.json'))
  settingsStore.onChange((settings) => updateTelemetryConsent(settings.telemetryEnabled))
  syncLocale()
  queue = new AnalysisQueue(engineClient, library, {
    profileDir: templateProfileDir,
    cacheDir: cacheDir(),
    gameRunning: !e2e,
    // Read decode/cacheLocation for each analysis so setting changes take effect without a restart.
    getSettings: () => settingsStore?.get()
  })

  // Restore folder watching from settings; automatically import new videos (enqueue them when autoAnalyze is enabled).
  watchManager = new WatchManager({ library, queue, settings: settingsStore })
  watchManager.start()

  // Project autosave: `%APPDATA%\Valorant Editor\projects\<id>.json`.
  const projectStore = new ProjectStore(join(appDataDir(), 'projects'))

  const handlers = registerIpcHandlers(library, queue, () => (mainWindow ? [mainWindow] : []), engineClient, settingsStore, watchManager, projectStore, (ok) => closeGate?.ack(ok), (sources) => mediaAccess.allowProjectSources(sources))
  cancelExport = handlers.cancelExport

  const notify = createRecordingNotifier(() => settingsStore!.get().recording)
  const pushLibrary = (): void => {
    const payload = queue!.payload()
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('library:updated', payload)
      } catch (error) {
        console.error('Failed to publish recording library update:', error)
      }
    }
  }
  // Auto montage: one montage per analyzed VALORANT match, exported in the background independently of the UI export slot.
  // Game presence comes from the shared poll; unknown (before the first poll) counts as running.
  let gameRunning: boolean | null = null
  const recordingLog = createDiagnosticLog(join(appDataDir(), 'recording.log'))
  focusLog = recordingLog
  const montage = createMontageService({
    store: new MontageJobStore(join(appDataDir(), 'montage', 'jobs.json')),
    getSettings: () => {
      const s = settingsStore!.get()
      return {
        montage: s.recording.autoMontage,
        autoclip: s.autoclip,
        diskWarnGb: s.recording.diskWarnGb,
        diskStopGb: s.recording.diskStopGb,
        storageRoot: s.storageRoot ?? join(app.getPath('videos'), 'Valorant Editor')
      }
    },
    library: {
      get: (videoPath) => library!.get(videoPath),
      hasMontage: (jobId) => library!.hasMontage(jobId),
      addMontage: (outputPath, info, extra) => {
        library!.addMontage(outputPath, info, extra)
        pushLibrary()
        void generateThumbnail(outputPath, extra.durationSec).then((thumb) => {
          if (thumb && library!.update(outputPath, { thumb })) pushLibrary()
        }, (error) => console.error('Failed to generate montage thumbnail:', error))
      }
    },
    saveProject: (project) => projectStore.save(project),
    loadProject: (id) => projectStore.load(id),
    readCache: (videoPath) => loadCacheDoc(resolveCacheFile(videoPath, cacheDir(), settingsStore!.get().cacheLocation === 'besideVideo')) as CacheDoc | null,
    autoclip: async (events, params, duration) => {
      const res = (await engineClient!.request('autoclip', { events, params, duration }).promise) as { clips?: Clip[] } | null
      return Array.isArray(res?.clips) ? res.clips : []
    },
    render: createMontageRenderer(),
    probeOutput: createOutputProbe(),
    diskFree: (dir) => diskFreeBytes(dir),
    fileExists: (file) => {
      try {
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    },
    ensureDir: (dir) => {
      fs.mkdirSync(dir, { recursive: true })
    },
    cleanupOutput: cleanupMontageOutput,
    // Same path as deleting from the library: stop analysis of the file, then remove the entry and its recording.
    removeSource: async (videoPath) => {
      const entry = library!.get(videoPath)
      if (!entry || entry.source !== 'recording') return
      await queue!.withStoppedAnalysis([videoPath], () => library!.remove(videoPath))
      pushLibrary()
    },
    notify: (kind, message) => notify(kind, message),
    now: () => Date.now(),
    isGameRunning: () => gameRunning !== false,
    isRecording: () => {
      const status = recordingService?.status()
      return status?.phase === 'starting' || status?.phase === 'recording' || status?.obsRecording === true
    },
    onStatus: (status) => broadcastMontageStatus(BrowserWindow.getAllWindows(), status),
    log: (message) => recordingLog(message)
  })
  montageService = montage
  queue.on('analyzed', (videoPath: string, game) => montage.onMatchAnalyzed(videoPath, game))
  queue.on('analysisFailed', (videoPath: string, _game: unknown, error: string) => montage.onAnalysisFailed(videoPath, error))
  const unregisterMontageIpc = registerMontageIpc(ipcMain, montage)
  const unsubscribeMontage = settingsStore.onChange(() => montage.onSettingsChanged())

  recordingService = createRecordingService({
    onDiagnostic: reportChildDiagnostic,
    log: recordingLog,
    getSettings: () => settingsStore!.get().recording,
    getObsPassword: () => obsPassword(settingsStore!.get().recording, safeStorage),
    probeVideo: async (file) => engineClient!.request('probe', sanitizeProbeArgs(file)).promise as Promise<import('../shared/types').VideoInfo>,
    getWatchFolders: () => settingsStore!.get().watchFolders,
    defaultOutputDir: join(app.getPath('videos'), 'Valorant Editor'),
    recorderCommand: aditorrecCommand(app.isPackaged),
    obsHookDir: obsHookDir(app.isPackaged),
    ffmpegPath: ffmpegExecutable(app.isPackaged),
    profileDir: templateProfileDir,
    addToLibrary: (paths, game) => {
      library!.add(paths, 'recording', game)
      if (!library!.flush()) throw new Error('Failed to save library')
      pushLibrary()
    },
    enqueueAnalysis: (videoPath) => queue!.enqueue(videoPath),
    notify,
    onGameExit: () => showMainWindow(false),
    onGamePid: (pid) => {
      gamePid = pid
      // The game exited: anything deferred while it was in front can run now.
      if (pid === null) void focusGuard.flush()
    },
    onGameRunning: (running) => {
      gameRunning = running
      queue!.setGameRunning(running)
      montage.setGameRunning(running)
    },
    onMatchRecorded: (videoPath, game) => montage.onMatchRecorded(videoPath, game),
    onMatchAnalyzed: (videoPath, game) => montage.onMatchAnalyzed(videoPath, game),
    onGameClosed: () => montage.onGameClosed(),
    liveEngineCommand: liveEngineCommand(app.isPackaged),
    sceneDir: sceneDir(app.isPackaged),
    liveCachePath: (videoPath) => cacheFilePath(videoPath, cacheDir(), settingsStore!.get().cacheLocation === 'besideVideo'),
    // Live cache is already done, so the library entry can open immediately; if full analysis is queued next, the queue returns it to pending and replaces it when complete.
    onLiveAnalysis: (videoPath, summary) => {
      if (library!.update(videoPath, { status: 'done', progress: 1, counts: summary.counts, game: summary.game, durationSec: summary.durationSec, codec: summary.codec || undefined, hl: undefined })) pushLibrary()
      void generateThumbnail(videoPath, summary.durationSec).then((thumb) => {
        if (!thumb || library!.get(videoPath)?.status !== 'done') return
        if (library!.update(videoPath, { thumb })) pushLibrary()
      }, (error) => console.error('Failed to generate recording thumbnail:', error))
    }
  })
  unregisterRecordingIpc = registerRecordingIpc(recordingService, () => BrowserWindow.getAllWindows())
  tray = createRecordingTray({
    service: recordingService,
    iconDir: join(app.isPackaged ? process.resourcesPath : resolve(__dirname, '../..'), 'resources'),
    openWindow: () => showMainWindow(true),
    quit: () => app.quit(),
    notifyError: (message) => notify('error', message)
  })
  if (!tray) openRequested = true
  let launchAtLogin: boolean | undefined
  const updateLoginItem = (): void => {
    const enabled = settingsStore!.get().recording.launchAtLogin
    if (!app.isPackaged || enabled === launchAtLogin) return
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
      launchAtLogin = enabled
    } catch (error) {
      notify('error', tr('無法更新開機啟動設定：{error}', { error: String(error) }))
    }
  }
  updateLoginItem()
  const unsubscribeLogin = settingsStore.onChange(updateLoginItem)
  // Auto-update is enabled only in installed builds; E2E does not connect to GitHub.
  appUpdater = createAppUpdater({
    updater: !e2e && canAutoUpdate(app.isPackaged) ? await loadAutoUpdater() : null,
    isEnabled: () => settingsStore!.get().autoUpdate,
    notifyAvailable: (version) => notify('finalized', tr('Valorant Editor {version} 有新版本可用，可在設定中選擇「下載更新」。', { version })),
    broadcast: broadcastUpdateStatus,
    // A manual install only requests quitting here; the quit guard starts the installer after finalization.
    requestQuit: () => app.quit()
  })
  const updater = appUpdater
  const unregisterUpdateIpc = registerUpdateIpc(updater)
  updater.start()
  const unsubscribeLanguage = settingsStore.onChange(() => {
    if (!syncLocale()) return
    tray?.refresh()
    if (mainWindow && !mainWindow.isDestroyed()) loadRenderer(mainWindow)
  })
  unsubscribeSettings = () => {
    unsubscribeLogin()
    unsubscribeLanguage()
    unsubscribeMontage()
    unregisterMontageIpc()
    updater.stop()
    unregisterUpdateIpc()
  }
  // E2E does not detect real Apex to avoid interacting with a game running during tests.
  if (!e2e) recordingService.start()
  // Resume interrupted montage jobs (leftover partial files are removed) and run queued ones.
  montage.start()

  ipcMain.handle('engine:probe', async (_, videoPath: unknown) => {
    return engineClient?.request('probe', sanitizeProbeArgs(videoPath)).promise
  })

  ipcMain.handle('engine:analyze', async (_, args: unknown) => {
    // Missing Studio caches must use the same game-aware queue as every other background analysis.
    const { path, force } = sanitizeAnalyzeArgs(args)
    queue!.enqueue(path, force)
    return null
  })

  ipcMain.handle('engine:autoclip', async (_, args: unknown) => {
    return engineClient?.request('autoclip', sanitizeAutoclipArgs(args)).promise
  })
}

// Before quitting, start export/proxy cancellation and folder-watching shutdown immediately, then always wait for recording
// finalization (including FFmpeg remux), flush the library and stop the engine (I7). Finalization is critical; remaining cleanup keeps its 5-second bound.
// A manual update install uses this same path and only spawns the NSIS installer after this guard finishes.
const quitGuard = createAppQuitGuard({
  stopRecording: () => recordingService?.stop(),
  flushLibrary: () => library?.flush(),
  onQuitBlocked: () => {
    quitting = false
    watchManager?.start()
    if (!e2e) recordingService?.start()
    showMainWindow(false)
    // A modal error box takes the foreground too; it waits for the game to leave the front like the window.
    void focusGuard.run('library-error', () => dialog.showErrorBox('Valorant Editor', tr('無法儲存媒體庫，變更尚未寫入磁碟。請確認磁碟空間與檔案權限後重試。')))
  },
  stopEngine: () => engineClient?.stop(),
  cancelExport: () => cancelExport?.(),
  cancelProxies: async () => (await import('./proxy')).cancelAllProxies(),
  cancelMontage: () => montageService?.shutdown(),
  cancelThumbnails: () => cancelAllThumbnails(),
  stopWatcher: () => watchManager?.stop(),
  installUpdate: () => appUpdater?.installIfRequested() ?? false,
  quit: () => app.quit(),
  timeoutMs: 5000
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const startupSettings = loadSettings(join(appDataDir(), 'settings.json'))
  // Some GPU/driver combinations stall Chromium's hardware decoder (slow-motion preview); Chromium reads this switch only at startup.
  if (startupSettings.decode === 'software') app.commandLine.appendSwitch('disable-accelerated-video-decode')
  // Settings compares this with the current value to offer a restart.
  ipcMain.handle('app:startupDecode', () => startupSettings.decode)
  ipcMain.handle('app:relaunch', () => {
    // Portable builds run from a temporary extraction; relaunch the original executable instead.
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    app.relaunch(portable ? { execPath: portable } : undefined)
    app.quit() // Goes through the quit guard (project flush, recording finalization).
  })
  initializeTelemetry(startupSettings.telemetryEnabled)
  app.on('second-instance', () => showMainWindow(true))
  app.whenReady().then(async () => {
    protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request, mediaAccess))
    await initEngineAndServices()
    servicesReady = true
    if (openRequested) showMainWindow()
    if (e2e && process.env.ADITOR_SENTRY_VERIFY === '1') {
      const { verifyTelemetry } = await import('./telemetry-verification')
      const { writeFileSync } = await import('fs')
      writeFileSync(join(appDataDir(), 'sentry-verification.json'), JSON.stringify(await verifyTelemetry()))
    }
    app.on('activate', () => showMainWindow(true))
  })
  app.on('before-quit', (e) => {
    quitting = true
    quitGuard.onBeforeQuit(e)
  })
  app.on('will-quit', () => {
    focusGuard.dispose()
    unsubscribeSettings?.()
    unregisterRecordingIpc?.()
    tray?.destroy()
    tray = null
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (!tray || !settingsStore?.get().recording.closeToTray)) app.quit()
  })
}
