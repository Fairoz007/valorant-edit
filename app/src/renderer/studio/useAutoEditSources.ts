import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { AutoEditSource } from '../../shared/autoEdit'
import type { CacheDoc } from '../../shared/types'
import { recordedTime } from '../library/recordedTime'
import { dayFolderName } from '../../shared/storage'

export type SourceLoad = { status: 'loading' } | { status: 'ready'; source: AutoEditSource } | { status: 'error' }

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

/** Analyzed library videos that can feed an auto edit (montage outputs are excluded: they are results, not sources). */
export function analyzedCandidates(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return entries.filter((e) => e.status === 'done' && e.source !== 'montage')
}

/** Local day key of an entry's recording time (same day grouping as the library). */
export function recordingDay(entry: Pick<LibraryEntry, 'path' | 'addedAt'>): string {
  return dayFolderName(recordedTime(entry))
}

/** Every analyzed candidate recorded on one of the days of `paths`. */
export function sameDayPaths(entries: readonly LibraryEntry[], paths: readonly string[]): string[] {
  const wanted = new Set(paths.map(norm))
  const days = new Set(entries.filter((e) => wanted.has(norm(e.path))).map(recordingDay))
  return analyzedCandidates(entries).filter((e) => days.has(recordingDay(e))).map((e) => e.path)
}

/** Analysis cache → planner source. Audio presence is not probed by the renderer yet, so `hasAudio` is assumed. */
export function sourceFromDoc(path: string, doc: CacheDoc, entry: LibraryEntry | undefined): AutoEditSource {
  return {
    path,
    durationSec: doc.video?.duration ?? entry?.durationSec ?? 0,
    recordedAt: entry ? recordedTime(entry) : 0,
    events: Array.isArray(doc.events) ? doc.events : [],
    ...(doc.rounds ? { rounds: doc.rounds } : {}),
    hasAudio: true
  }
}

/**
 * Load the analysis (`cache.loadByVideo`, the same cache Studio opens) of every checked path once; results are kept
 * while the dialog is open, so unchecking and checking a video again does not reload it.
 */
export function useAutoEditSources(
  paths: readonly string[],
  entries: readonly LibraryEntry[],
  /** Sources already in memory (Studio passes its open document, including unsaved event edits). */
  preloaded: readonly AutoEditSource[] = []
): ReadonlyMap<string, SourceLoad> {
  const [loads, setLoads] = useState<ReadonlyMap<string, SourceLoad>>(
    () => new Map(preloaded.map((s): [string, SourceLoad] => [s.path, { status: 'ready', source: s }]))
  )
  const requested = useRef(new Set<string>(preloaded.map((s) => s.path)))
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const key = useMemo(() => paths.join('\n'), [paths])
  useEffect(() => {
    const todo = paths.filter((p) => !requested.current.has(p))
    if (todo.length === 0) return
    for (const p of todo) requested.current.add(p)
    setLoads((prev) => {
      const next = new Map(prev)
      for (const p of todo) next.set(p, { status: 'loading' })
      return next
    })
    for (const p of todo) {
      void (async () => {
        let load: SourceLoad
        try {
          const doc = (await window.api?.cache?.loadByVideo?.(p)) as CacheDoc | null | undefined
          const entry = entriesRef.current.find((e) => norm(e.path) === norm(p))
          load = doc && doc.analysis?.status === 'done' ? { status: 'ready', source: sourceFromDoc(p, doc, entry) } : { status: 'error' }
        } catch {
          load = { status: 'error' }
        }
        if (!alive.current) return
        setLoads((prev) => new Map(prev).set(p, load))
      })()
    }
    // `key` stands for `paths` (a new array on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Library entries can arrive after the analysis: refresh the recording time used for ordering.
  useEffect(() => {
    setLoads((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const [p, load] of prev) {
        if (load.status !== 'ready') continue
        const entry = entries.find((e) => norm(e.path) === norm(p))
        if (entry && recordedTime(entry) !== load.source.recordedAt) {
          next.set(p, { status: 'ready', source: { ...load.source, recordedAt: recordedTime(entry) } })
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [entries])

  return loads
}
