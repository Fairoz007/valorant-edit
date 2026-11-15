import React, { useRef, useState } from 'react'
import { Rail, RailView } from './Rail'
import { ToastProvider } from './ToastHost'
import { OverlayProvider, useOverlay } from './OverlayHost'
import { QueuePopover } from './QueuePopover'
import { QueueProvider } from '../queue/QueueProvider'
import { useProject } from '../editor/ProjectProvider'
import { useToast } from './ToastHost'
import { i18n } from '../i18n'
import { RecordingPanel } from './RecordingPanel'
import type { MontageJob } from '../../shared/montage'
import { useRecordingStatus } from './useRecordingStatus'
import { useAppSettings } from './useAppSettings'
import { useUpdateNotice } from './useUpdateStatus'
import { OnboardingHost } from '../onboarding/Onboarding'
import type { CategoryId } from '../settings/rows'

/** Show a toast once when startup recovery encounters a corrupt or newer-version project (I12). */
function RestoreNotice(): null {
  const { restoreNotice } = useProject()
  const toast = useToast()
  const shown = useRef(false)
  React.useEffect(() => {
    if (!restoreNotice || shown.current) return
    shown.current = true
    const t = i18n.studio.toast
    toast({ message: restoreNotice === 'corrupt' ? t.projectRestoreCorrupt : t.projectRestoreUnsupported })
  }, [restoreNotice, toast])
  return null
}

interface AppShellProps {
  active: RailView | null
  projectCount: number
  onNavigate: (v: RailView, settingsCategory?: CategoryId) => void
  /** "Watch current match" in the recording panel: switch to the live recording view. */
  onOpenLive?: () => void
  /** Open a video in Studio (the recording panel's Auto montage "Open" loads the montage project, then its source). */
  onOpenVideo?: (path: string) => void
  children: React.ReactNode
}

export function AppShell({ active, projectCount, onNavigate, onOpenLive, onOpenVideo, children }: AppShellProps): JSX.Element {
  const [queueOpen, setQueueOpen] = useState(false)
  const queueButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <QueueProvider>
      <ToastProvider>
        <OverlayProvider queueOpen={queueOpen}>
          <ShellFrame
            active={active}
            projectCount={projectCount}
            onNavigate={onNavigate}
            onOpenLive={onOpenLive}
            onOpenVideo={onOpenVideo}
            queueOpen={queueOpen}
            onToggleQueue={() => setQueueOpen((v) => !v)}
            onCloseQueue={() => setQueueOpen(false)}
            queueButtonRef={queueButtonRef}
          >
            {children}
          </ShellFrame>
        </OverlayProvider>
      </ToastProvider>
    </QueueProvider>
  )
}

/** Shell layout (inside OverlayProvider so the keyboard button in the icon rail can open the shortcuts dialog). */
function ShellFrame({
  active,
  projectCount,
  onNavigate,
  onOpenLive,
  onOpenVideo,
  queueOpen,
  onToggleQueue,
  onCloseQueue,
  queueButtonRef,
  children
}: AppShellProps & {
  queueOpen: boolean
  onToggleQueue: () => void
  onCloseQueue: () => void
  queueButtonRef: React.RefObject<HTMLButtonElement>
}): JSX.Element {
  const overlay = useOverlay()
  const recording = useRecordingStatus()
  const { openProject } = useProject()
  // First-run onboarding: overlay the entire app after settings load when onboardingDone is false.
  const settings = useAppSettings()
  const updateNotice = useUpdateNotice()
  return (
    <div className="app">
      <RestoreNotice />
      <Rail
        active={active}
        projectCount={projectCount}
        onNavigate={onNavigate}
        onQueue={onToggleQueue}
        queueOpen={queueOpen}
        onShortcuts={overlay.openShortcuts}
        queueButtonRef={queueButtonRef}
        recordingPhase={recording.status.phase}
        updateNotice={updateNotice}
        onRecording={() => {
          onCloseQueue()
          const watchLive = onOpenLive ? (): void => { overlay.close(); onOpenLive() } : undefined
          const openMontage = onOpenVideo
            ? (projectId: string, job: MontageJob): void => {
                overlay.close()
                void openProject(projectId).then((ok) => { if (ok) onOpenVideo(job.sourcePath) })
              }
            : undefined
          overlay.open(<RecordingPanel onClose={overlay.close} onWatchLive={watchLive} onOpenMontage={openMontage} />)
        }}
      />
      <main className="app-main">{children}</main>
      <QueuePopover open={queueOpen} onClose={onCloseQueue} anchorRef={queueButtonRef} />
      <OnboardingHost settings={settings} />
    </div>
  )
}
