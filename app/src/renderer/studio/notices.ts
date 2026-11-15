import type { PlayabilityResult } from '../media/playability'
import { i18n } from '../i18n'

export type NoticeAction = 'resume' | 'copyError' | 'generateProxy' | 'later' | 'relink' | 'back'

/**
 * Why the source `<video>` failed to load: `missing` = the file is not on disk (moved/renamed/deleted/drive gone),
 * `undecodable` = the file exists but Chromium cannot play it, `unknown` = the existence check itself failed.
 */
export type VideoFault = 'missing' | 'undecodable' | 'unknown'

export interface StudioNotice {
  id: string
  kind: 'error' | 'warn' | 'info'
  title: string
  text: string
  actions: NoticeAction[]
}

export interface StudioNoticeInput {
  analysis: 'done' | 'error'
/** Source-mode `<video>` load failure, classified by whether the file exists (see VideoFault). */
  videoFault?: VideoFault | null
  playability: PlayabilityResult
/** Proxy status: none means not generated (eligible for suggestion), available means present, generating means in progress (UI shows progress). */
  proxyState: 'none' | 'available' | 'generating'
/** Engine error code (shown in the message). */
  errorCode?: string | number
/** Proxy suggestion setting: do not suggest when false (defaults to true). */
  proxySuggest?: boolean
}

/**
 * Pure function for the studio's top notice (spec §3.2.6):
 * engine error → error plus Resume Analysis; unplayable/no hardware decoding without an existing proxy → proxy suggestion; otherwise null.
 */
export function studioNotice(input: StudioNoticeInput): StudioNotice | null {
  const t = i18n.studio.notices
  if (input.analysis === 'error') {
    return {
      id: 'engine-error',
      kind: 'error',
      title: t.engineErrorTitle,
      text: t.engineErrorText.replace('{code}', String(input.errorCode ?? 'unknown')),
      actions: ['resume', 'copyError']
    }
  }
  if (input.videoFault === 'missing') {
    return { id: 'video-missing', kind: 'error', title: t.videoNotFoundTitle, text: t.videoNotFoundText, actions: ['relink', 'back'] }
  }
  // The file is there but cannot be decoded: a proxy (H.264 copy) is the fix, unless one is already in use or being made.
  if (input.videoFault === 'undecodable' && input.proxyState === 'none') {
    return { id: 'video-undecodable', kind: 'error', title: t.videoUndecodableTitle, text: t.videoUndecodableText, actions: ['generateProxy', 'back'] }
  }
  if (input.videoFault === 'undecodable' && input.proxyState === 'generating') return null // The progress notice takes over.
  if (input.videoFault) {
    return { id: 'video-unplayable', kind: 'error', title: t.videoMissingTitle, text: t.videoMissingText, actions: ['relink', 'back'] }
  }
  if (input.proxyState === 'none' && input.proxySuggest !== false) {
    const p = input.playability
    if (!p.supported || !p.smooth || !p.powerEfficient) {
      return {
        id: 'proxy-suggest',
        kind: 'warn',
        title: t.proxyTitle,
        text: t.proxyText,
        actions: ['generateProxy', 'later']
      }
    }
  }
  return null
}

/** Proxy-generation status bar: show a percentage when progress (0–1) is available, otherwise generic text. */
export function proxyBusyNotice(ratio: number | null): StudioNotice {
  const t = i18n.studio.notices
  const title =
    ratio === null ? t.proxyBusy : t.proxyGenerating.replace('{n}', String(Math.round(Math.max(0, Math.min(1, ratio)) * 100)))
  return { id: 'proxy-generating', kind: 'info', title, text: '', actions: [] }
}
