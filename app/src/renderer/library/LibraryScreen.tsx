import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import { DropOverlay } from './DropOverlay'
import { EmptyState } from './EmptyState'
import { LibraryToolbar } from './LibraryToolbar'
import { QueueStrip } from './QueueStrip'
import { VideoCard, fileName } from './VideoCard'
import { RemoveChoiceDialog } from './RemoveChoiceDialog'
import { SUPPORTED_GAME_IDS, type GameId } from '../../shared/games'
import { resolveCardActivation, resolveLibraryEscape } from './cardLogic'
import { VirtualGrid } from './VirtualGrid'
import { isAllSelected, pruneSelection, selectAll, toggleGroup, toggleOne } from './selection'
import { CopyCheck, Film, Trash2, X } from '../components/icons'
import { groupByDate } from '../lib/groupByDate'
import { useLocalNow } from '../lib/localDay'
import { filterEntries, type LibraryGame, type LibraryKind } from '../lib/libraryFilter'
import { useKeymap } from '../hooks/useShortcuts'
import { useToast } from '../shell/ToastHost'
import { useOverlay } from '../shell/OverlayHost'
import { useQueueStore } from '../queue/QueueProvider'
import { i18n } from '../i18n'
import { subscribeStudioSettings } from '../studio/studioSettings'
import { library500Requested } from '../dev/libraryFixtureFlag'
import { useProject } from '../editor/ProjectProvider'
import type { ProjectWithId } from '../editor/projectIo'
import { AutoEditDialog } from '../studio/AutoEditDialog'
import { analyzedCandidates } from '../studio/useAutoEditSources'

const t = i18n.library

/**
 * A pending removal whose source file is not owned by the app (imported or legacy videos): the user chooses
 * between deleting the file and only dropping the library entry.
 */
type RemoveChoice =
  | { kind: 'single'; path: string }
  | { kind: 'many'; paths: string[]; imported: number; hasRecording: boolean; montages: string[] }

interface LibraryScreenProps {
  onSelectVideo: (path: string) => void
  onOpenSettings: () => void
}

export function LibraryScreen({ onSelectVideo, onOpenSettings }: LibraryScreenProps): JSX.Element {
  const toast = useToast()
  const overlay = useOverlay()
  const queueStore = useQueueStore()
  const { openProject } = useProject()
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [kind, setKind] = useState<LibraryKind>('all')
  const [game, setGame] = useState<LibraryGame>('all')
  const [dragging, setDragging] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /** A bulk removal is in flight; blocks a second Delete click from sending the same paths again. */
  const [deleting, setDeleting] = useState(false)
  /** A removal waiting for the user's choice (delete the source file or keep it). */
  const [removeChoice, setRemoveChoice] = useState<RemoveChoice | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  // Proxy suggestion setting (immediate): when disabled, cards hide the proxy-suggestion badge.
  const [proxySuggest, setProxySuggest] = useState(true)
  // Show one notice when the library file is corrupt (main has already backed it up).
  useEffect(() => {
    void window.api?.library?.getLoadNotice?.()?.then((p: string | null) => {
      if (p) toast({ message: t.corruptNotice.replace('{path}', p) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => subscribeStudioSettings(window.api, (s) => setProxySuggest(s.proxySuggest)), [])
  const openMenuClose = useRef<(() => void) | null>(null)
  const handleMenuChange = useCallback((_path: string, close: (() => void) | null) => {
    openMenuClose.current = close
  }, [])

  // Main already throttles library:updated to at most once every 500 ms (including a trailing event); do not throttle again here.
  const load = useCallback(async () => {
    if (library500Requested()) {
      // Development only: load dynamically so production builds exclude synthetic data (see libraryFixtureFlag).
      const m = await import('../dev/libraryFixture')
      setEntries(m.libraryFixtureOnce())
      return
    }
    const data = await window.api?.library?.getEntries?.()
    if (Array.isArray(data)) setEntries(data)
  }, [])

  useEffect(() => {
    void load()
    const unsubscribe = window.api?.library?.onUpdated?.(() => {
      void load()
    })
    return () => unsubscribe?.()
  }, [load])

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelected(new Set())
  }, [])

  useKeymap(
    {
      focusSearch: () => searchRef.current?.focus(),
      toggleFavoriteFilter: () => setFavoriteOnly((v) => !v),
      showShortcuts: overlay.openShortcuts,
      // Esc is handled only by keymap (IME composition is excluded), in priority order: open card menu → selection mode → search text → no action.
      closeOverlay: () => {
        const action = resolveLibraryEscape({ menuOpen: openMenuClose.current !== null, selecting: selectionMode, query: queryRef.current })
        if (action === 'close-menu') openMenuClose.current?.()
        else if (action === 'exit-selection') exitSelection()
        else if (action === 'clear-query') setQuery('')
      }
    },
    // While the removal dialog is open it owns the keyboard: the screen must not act on Esc or any other shortcut.
    { screen: 'library', enabled: removeChoice === null && overlay.kind !== 'dialog' }
  )

  const filtered = useMemo(
    () => filterEntries(entries, { query, favoriteOnly, kind, game }),
    [entries, query, favoriteOnly, kind, game]
  )
  const now = useLocalNow() // Recalculate Today/Yesterday after local midnight or when the window regains focus.
  const groups = useMemo(() => groupByDate(filtered, now), [filtered, now])
  const counts = useMemo(() => {
    const base = { query: '', favoriteOnly: false, kind: 'all' as const, game: 'all' as const }
    const gameCounts = Object.fromEntries(
      SUPPORTED_GAME_IDS.map((id) => [id, filterEntries(entries, { ...base, game: id }).length])
    ) as Record<GameId, number>
    return {
      all: entries.length,
      recording: filterEntries(entries, { ...base, kind: 'recording' }).length,
      external: filterEntries(entries, { ...base, kind: 'external' }).length,
      hl: filterEntries(entries, { ...base, kind: 'hl' }).length,
      ...gameCounts
    }
  }, [entries])

  /** Every entry currently shown in the grid (the filtered list); "Select all" and the bar's disabled state use this. */
  const shownPaths = useMemo(() => filtered.map((entry) => entry.path), [filtered])
  const allShownSelected = isAllSelected(selected, shownPaths)

  // Selection hygiene: only shown entries stay selected, so removed entries and entries hidden by a filter or search
  // can never be deleted unseen. Same Set instance when nothing changed.
  useEffect(() => {
    setSelected((prev) => pruneSelection(prev, new Set(shownPaths)))
  }, [shownPaths])

  const handleToggleSelect = useCallback((path: string) => {
    setSelectionMode(true)
    setSelected((prev) => toggleOne(prev, path))
  }, [])

  const handleToggleGroup = useCallback(
    (groupIndex: number) => {
      const paths = groups[groupIndex]?.entries.map((entry) => entry.path) ?? []
      setSelectionMode(true)
      setSelected((prev) => toggleGroup(prev, paths))
    },
    [groups]
  )

  const handleSelectAll = useCallback(() => {
    setSelected((prev) => selectAll(prev, shownPaths))
  }, [shownPaths])

  /** Run a bulk removal and report the result; entries that failed stay selected. */
  const finishManyRemove = useCallback(
    async (paths: string[], request: () => Promise<{ failed?: string[] } | undefined>) => {
      setDeleting(true)
      try {
        const result = await request()
        const failed: string[] = Array.isArray(result?.failed) ? result.failed : []
        if (failed.length > 0) {
          toast({ message: t.selection.deleteFailed.replace('{n}', String(failed.length)) })
          setSelected(new Set(failed))
        } else {
          exitSelection()
        }
      } catch {
        toast({ message: t.selection.deleteFailed.replace('{n}', String(paths.length)) })
      } finally {
        setDeleting(false)
      }
    },
    [toast, exitSelection]
  )

  const handleDeleteSelected = useCallback(async () => {
    const paths = Array.from(selected)
    if (paths.length === 0) return
    const chosen = entries.filter((entry) => selected.has(entry.path))
    // Montages are app outputs: they never get the imported-source question and only their library entry is removed.
    const imported = chosen.filter((entry) => entry.source !== 'recording' && entry.source !== 'montage').length
    if (imported === 0) {
      // Only recordings and montages are selected: one confirmation is enough (recordings delete their source file).
      const montages = chosen.filter((entry) => entry.source === 'montage').length
      const message = montages === paths.length
        ? t.selection.montageRemoveManyConfirm.replace('{n}', String(paths.length))
        : t.selection.deleteSourceConfirm.replace('{n}', String(paths.length)) + (montages > 0 ? ` ${t.selection.montageNote}` : '')
      if (!window.confirm(message)) return
      await finishManyRemove(paths, () => window.api.library.removeMany(paths))
      return
    }
    // Imported (or legacy) videos are selected: ask whether their source files should be deleted as well.
    setRemoveChoice({
      kind: 'many',
      paths,
      imported,
      hasRecording: chosen.some((entry) => entry.source === 'recording'),
      montages: chosen.filter((entry) => entry.source === 'montage').map((entry) => entry.path)
    })
  }, [entries, selected, finishManyRemove])

  /** Selected videos that can feed an auto edit (analyzed, not montage outputs). */
  const autoEditPaths = useMemo(
    () => analyzedCandidates(entries.filter((entry) => selected.has(entry.path))).map((entry) => entry.path),
    [entries, selected]
  )
  const createAutoEdit = useCallback(
    async (next: ProjectWithId): Promise<boolean> => {
      if ((await window.api?.projects?.save?.(next)) !== true) return false
      if (!(await openProject(next.id))) return false
      exitSelection()
      // Studio needs a video: open the first clip's source (the project track shows the whole montage).
      const first = next.items[0]?.source
      if (first) onSelectVideo(first)
      return true
    },
    [openProject, exitSelection, onSelectVideo]
  )
  const handleAutoEdit = useCallback(() => {
    if (autoEditPaths.length === 0) return
    overlay.open(<AutoEditDialog origin="library" initialPaths={autoEditPaths} onClose={overlay.close} onCreate={createAutoEdit} />)
  }, [autoEditPaths, overlay, createAutoEdit])

  const handleImportFiles = useCallback(() => {
    void window.api?.library?.selectFiles?.().catch((error: unknown) => toast({ message: String(error) }))
  }, [toast])

  const handleImportFolder = useCallback(() => {
    void window.api?.library?.selectFolder?.().catch((error: unknown) => toast({ message: String(error) }))
  }, [toast])

  const handleOpen = useCallback(
    (entry: LibraryEntry) => {
      if (entry.source === 'montage' && entry.montage) {
        // A montage opens its editable project in Studio, on the recording it was built from.
        const { projectId, sourcePath } = entry.montage
        void openProject(projectId)
          .then((ok) => (ok ? onSelectVideo(sourcePath) : toast({ message: t.card.montageOpenFailed })))
          .catch(() => toast({ message: t.card.montageOpenFailed }))
        return
      }
      const action = resolveCardActivation(entry, queueStore.stateOf(entry.path))
      if (action === 'open') onSelectVideo(entry.path)
      else if (action === 'toast-not-analyzed') toast({ message: t.card.notAnalyzedToast })
      else if (action === 'toast-blocked') toast({ message: t.card.openBlocked })
    },
    [onSelectVideo, toast, queueStore, openProject]
  )

  const handleToggleFavorite = useCallback((path: string) => {
    void window.api?.library?.toggleFavorite?.(path).catch((error: unknown) => toast({ message: String(error) }))
  }, [toast])

  const handleRemove = useCallback(
    async (path: string) => {
      const entry = entries.find((entry) => entry.path === path)
      if (entry?.source === 'montage') {
        // Auto montage output: only its library entry goes (the file stays; its source recording and project are kept).
        if (!window.confirm(t.card.montageRemoveConfirm.replace('{name}', fileName(path)))) return
        try {
          await window.api.library.remove(path)
        } catch {
          toast({ message: t.card.removeFailed })
        }
        return
      }
      if (entry?.source === 'recording') {
        // Recordings own their source file: one confirmation is enough.
        const confirmed = window.confirm(t.card.removeSourceConfirm.replace('{name}', fileName(path)))
        if (!confirmed) return
        try {
          await window.api.library.remove(path)
        } catch {
          toast({ message: t.card.removeFailed })
        }
        return
      }
      // Imported (or legacy) videos do not own their file: ask whether it should be deleted.
      setRemoveChoice({ kind: 'single', path })
    },
    [entries, toast]
  )

  /** Remove one entry after the user chose what to do with its source file. */
  const removeSingle = useCallback(
    async (path: string, deleteSource: boolean) => {
      setRemoveChoice(null)
      try {
        await window.api.library.remove(path, { deleteSource })
      } catch {
        toast({ message: t.card.removeFailed })
      }
    },
    [toast]
  )

  /** Remove the selected entries after the user chose what to do with the imported source files. */
  const removeMany = useCallback(
    async (paths: string[], deleteSource: boolean) => {
      setRemoveChoice(null)
      const montages = new Set(removeChoice?.kind === 'many' ? removeChoice.montages : [])
      const others = paths.filter((p) => !montages.has(p))
      await finishManyRemove(paths, async () => {
        // A montage's file is never deleted through the imported-source choice: remove its entries separately.
        const results: Array<{ failed?: string[] } | undefined> = []
        if (others.length > 0) results.push(await window.api.library.removeMany(others, { deleteSource }))
        if (montages.size > 0) results.push(await window.api.library.removeMany([...montages]))
        return { failed: results.flatMap((r) => (Array.isArray(r?.failed) ? r.failed : [])) }
      })
    },
    [finishManyRemove, removeChoice]
  )

  const handleRetry = useCallback((path: string, force?: boolean) => {
    void window.api?.queue?.enqueue?.(path, force)
  }, [])

  const handleSetGame = useCallback((path: string, game: GameId) => {
    void window.api?.library?.setGame?.(path, game).catch((error: unknown) => toast({ message: String(error) }))
  }, [toast])

  const handleSplitMatches = useCallback(
    async (path: string) => {
      toast({ message: t.card.splitStarted })
      const messages: Record<string, string> = {
        none: t.card.splitNone, single: t.card.splitSingle, exists: t.card.splitExists, busy: t.card.splitBusy
      }
      try {
        const res: { ok: boolean; files?: string[]; reason?: string } | undefined = await window.api?.library?.splitMatches?.(path)
        if (!res) return
        if (res.ok) toast({ message: t.card.splitDone.replace('{n}', String(res.files?.length ?? 0)) })
        else if (res.reason !== 'cancelled') toast({ message: messages[res.reason ?? ''] ?? t.card.splitFailed })
      } catch {
        toast({ message: t.card.splitFailed })
      }
    },
    [toast]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        void window.api?.library?.addDroppedFiles?.(files).catch((error: unknown) => toast({ message: String(error) }))
      }
    },
    [toast]
  )

  /** Texts of the removal dialog for the pending request (single video or a whole selection). */
  const removeDialog = useMemo<{
    title: string
    message: string
    note?: string
    deleteLabel: string
    removeLabel: string
  } | null>(() => {
    if (!removeChoice) return null
    if (removeChoice.kind === 'single') {
      return {
        title: t.card.removeChoiceTitle,
        message: t.card.removeChoiceMessage.replace('{name}', fileName(removeChoice.path)),
        deleteLabel: t.card.deleteSource,
        removeLabel: t.card.removeFromLibrary
      }
    }
    const count = String(removeChoice.paths.length)
    return {
      title: t.selection.deleteChoiceTitle.replace('{n}', count),
      message: t.selection.deleteChoiceMessage.replace('{n}', count).replace('{m}', String(removeChoice.imported)),
      note: removeChoice.hasRecording ? t.selection.deleteChoiceRecordingNote : undefined,
      deleteLabel: t.selection.deleteSources,
      removeLabel: t.selection.removeFromLibraryOnly
    }
  }, [removeChoice])

  const renderCard = useCallback(
    (entry: LibraryEntry, active: boolean) => (
      <VideoCard
        key={entry.path}
        entry={entry}
        onOpen={handleOpen}
        onToggleFavorite={handleToggleFavorite}
        onRemove={handleRemove}
        onRetry={handleRetry}
        onSetGame={handleSetGame}
        onSplitMatches={handleSplitMatches}
        onMenuChange={handleMenuChange}
        proxySuggest={proxySuggest}
        active={active}
        selectionMode={selectionMode}
        selected={selected.has(entry.path)}
        onToggleSelect={handleToggleSelect}
      />
    ),
    [
      handleOpen,
      handleToggleFavorite,
      handleRemove,
      handleRetry,
      handleSplitMatches,
      handleSetGame,
      handleMenuChange,
      proxySuggest,
      selectionMode,
      selected,
      handleToggleSelect
    ]
  )

  return (
    <div
      className={`lib-screen${selectionMode ? ' selecting' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        // Dismiss the overlay only when leaving the entire screen.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <header className="lib-topbar">
        <h1>{t.title}</h1>
        <div className="lib-grow" />
        <button type="button" className="lib-btn" onClick={handleImportFolder}>
          {t.importFolder}
        </button>
        <button type="button" className="lib-btn primary" onClick={handleImportFiles}>
          {t.importFiles}
        </button>
      </header>

      {entries.length === 0 ? (
        <EmptyState onImportFiles={handleImportFiles} onImportFolder={handleImportFolder} onOpenSettings={onOpenSettings} />
      ) : (
        <>
          <LibraryToolbar
            query={query}
            onQueryChange={setQuery}
            favoriteOnly={favoriteOnly}
            onToggleFavorite={() => setFavoriteOnly((v) => !v)}
            kind={kind}
            onKindChange={setKind}
            game={game}
            onGameChange={setGame}
            counts={counts}
            searchRef={searchRef}
          />
          <QueueStrip />
          {filtered.length === 0 ? (
            <div className="lib-noresults">
              <h2>{t.noResults.title}</h2>
              <p className="muted">{t.noResults.desc}</p>
            </div>
          ) : (
            <VirtualGrid
              groups={groups}
              renderCard={renderCard}
              selectionMode={selectionMode}
              selected={selected}
              onToggleGroup={handleToggleGroup}
            />
          )}
          {selectionMode && (
            <div className="lib-selection-bar" role="toolbar" aria-label={t.selection.toolbar}>
              <span className="lib-selection-summary">
                <span className="lib-selection-count" aria-live="polite">
                  {selected.size}
                </span>
                <span className="lib-selection-label">{t.selection.selectedItems}</span>
              </span>
              <div className="lib-grow" />
              <button
                type="button"
                className="lib-selection-icon"
                title={t.selection.selectAll}
                aria-label={t.selection.selectAll}
                disabled={allShownSelected || shownPaths.length === 0}
                onClick={handleSelectAll}
              >
                <CopyCheck className="ic sm" />
              </button>
              <button
                type="button"
                className="lib-btn lib-selection-autoedit"
                aria-haspopup="dialog"
                title={autoEditPaths.length === 0 ? t.selection.autoEditHint : undefined}
                disabled={autoEditPaths.length === 0}
                onClick={handleAutoEdit}
              >
                <Film className="ic sm" />
                {t.selection.autoEdit}
              </button>
              <button
                type="button"
                className="lib-btn lib-selection-delete"
                disabled={selected.size === 0 || deleting}
                onClick={() => void handleDeleteSelected()}
              >
                <Trash2 className="ic sm" />
                {t.selection.deleteItems}
              </button>
              <button
                type="button"
                className="lib-selection-icon"
                title={t.selection.exit}
                aria-label={t.selection.exit}
                onClick={exitSelection}
              >
                <X className="ic sm" />
              </button>
            </div>
          )}
        </>
      )}

      <DropOverlay show={dragging} />

      {removeChoice && removeDialog && (
        <RemoveChoiceDialog
          title={removeDialog.title}
          message={removeDialog.message}
          note={removeDialog.note}
          deleteLabel={removeDialog.deleteLabel}
          removeLabel={removeDialog.removeLabel}
          cancelLabel={t.card.cancel}
          onDeleteSource={() => {
            if (removeChoice.kind === 'single') void removeSingle(removeChoice.path, true)
            else void removeMany(removeChoice.paths, true)
          }}
          onRemoveOnly={() => {
            if (removeChoice.kind === 'single') void removeSingle(removeChoice.path, false)
            else void removeMany(removeChoice.paths, false)
          }}
          onCancel={() => setRemoveChoice(null)}
        />
      )}
    </div>
  )
}
