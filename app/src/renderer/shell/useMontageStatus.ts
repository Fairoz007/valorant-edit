import { useCallback, useEffect, useRef, useState } from 'react'
import type { MontageStatus } from '../../shared/montage'
import { recordingI18n } from '../i18n'

export const EMPTY_MONTAGE_STATUS: MontageStatus = { active: null, jobs: [] }

/** Auto montage job status (modelled on useRecordingStatus): subscribe first, then read the snapshot, so a slow snapshot cannot overwrite a newer push. */
export function useMontageStatus(): { status: MontageStatus; error: string | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<MontageStatus>(EMPTY_MONTAGE_STATUS)
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  const active = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++revision.current
    try {
      const api = window.api?.montage
      if (!api) throw new Error('montage api unavailable')
      const next = await api.getStatus()
      if (active.current && revision.current === version) {
        setStatus(next)
        setError(null)
      }
    } catch {
      if (active.current && revision.current === version) setError(recordingI18n.autoMontage.status.unavailable)
    }
  }, [])
  useEffect(() => {
    active.current = true
    const off = window.api?.montage?.onStatus((next) => {
      revision.current += 1
      setStatus(next)
      setError(null)
    })
    void refresh()
    return () => {
      active.current = false
      revision.current += 1
      off?.()
    }
  }, [refresh])
  return { status, error, refresh }
}
