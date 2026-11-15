/**
 * Turns recorder activity into in-game overlay cards (pure: no Electron).
 * Kills in one round update a single card in place (KILL → DOUBLE KILL → … → ACE), so a five-kill round shows one ACE card.
 */
import path from 'path'
import { tr } from '../../shared/locale'
import { multiKillLevel, type OverlayCard, type OverlayIcon, type OverlayTone } from '../../shared/overlay'
import type { LiveUpdate, OverlaySettings, RecordingStatus } from '../../shared/recording'
import type { RecorderActivity, RecordingNoticeKind } from '../recording'

export type OverlayInput =
  | { type: 'notice'; kind: RecordingNoticeKind; message: string }
  | { type: 'status'; status: RecordingStatus }
  | { type: 'live'; update: LiveUpdate }
  | { type: 'activity'; activity: RecorderActivity }
  | { type: 'analysis'; kills: number | null }

/** What happened to an input: shown on the overlay, blocked by exclusive fullscreen, or not for the overlay (show a toast instead). */
export type OverlayOutcome = 'shown' | 'exclusive' | 'off'

export interface OverlayControllerDeps {
  getSettings: () => OverlaySettings
  /** Show or update one card: 'shown', 'exclusive' (no window can appear over the game) or 'off' (no game: use a toast). */
  present: (card: OverlayCard) => Promise<'shown' | 'exclusive' | 'off'>
  now?: () => number
}

/** Without round boundaries (Riot Client down) kills further apart than this start a new card. */
export const KILL_STREAK_GAP_MS = 45_000

function killTitle(count: number): string {
  switch (multiKillLevel(count)) {
    case 1: return tr('擊殺')
    case 2: return tr('雙殺')
    case 3: return tr('三殺')
    case 4: return tr('四殺')
    case 5: return tr('五殺')
  }
}

const NOTICE_LOOK: Record<Exclude<RecordingNoticeKind, 'matchStart' | 'matchEnd' | 'matchCancel'>, { tone: OverlayTone; icon: OverlayIcon }> = {
  finalized: { tone: 'ok', icon: 'save' },
  diskWarn: { tone: 'warn', icon: 'disk' },
  warning: { tone: 'warn', icon: 'warn' },
  error: { tone: 'error', icon: 'error' },
  montage: { tone: 'ok', icon: 'spark' }
}

function noticeTitle(kind: keyof typeof NOTICE_LOOK): string {
  switch (kind) {
    case 'finalized': return tr('已儲存')
    case 'diskWarn': return tr('磁碟空間不足')
    case 'warning': return tr('注意')
    case 'error': return tr('錯誤')
    case 'montage': return tr('精華影片')
  }
}

/** The recorder's "Saved: a.mp4、b.mp4" without its prefix, since the card title already says "Saved". */
function savedDetail(message: string): string {
  const prefix = tr('已儲存：{paths}', { paths: '' })
  const rest = prefix && message.startsWith(prefix) ? message.slice(prefix.length) : message
  return rest.split(/、|, /).map((p) => path.basename(p.trim())).filter(Boolean).join(', ') || message
}

function captureName(capture: RecordingStatus['capture']): string | null {
  return capture === 'wgc' ? 'WGC' : capture === 'dda' ? 'DDA' : capture === 'hook' ? 'Hook' : null
}

export interface OverlayController {
  handle(input: OverlayInput): Promise<OverlayOutcome>
  /** Sample cards for the Settings "Test overlay" button; shown even when the overlay is off or no game runs. */
  test(): OverlayCard[]
}

export function createOverlayController(deps: OverlayControllerDeps): OverlayController {
  const now = deps.now ?? Date.now
  let previous: RecordingStatus | null = null
  let liveSession: string | null = null
  const seenKills = new Set<string>()
  let matchKills = 0
  /** Round being played (1-based) from Riot Client round ends; null without round information. */
  let round: number | null = null
  let streak: { id: number; count: number; lastAt: number; round: number | null } | null = null
  let streakIds = 0
  let cardIds = 0

  const card = (tone: OverlayTone, icon: OverlayIcon, title: string, detail: string, id?: string): OverlayCard => {
    const settings = deps.getSettings()
    const base = Math.round(settings.durationSec * 1000)
    return { id: id ?? `c${++cardIds}`, tone, icon, title, detail, durationMs: tone === 'error' ? base * 2 : base }
  }

  const show = async (cards: OverlayCard[]): Promise<OverlayOutcome> => {
    if (!cards.length) return 'off'
    let outcome: OverlayOutcome = 'shown'
    for (const c of cards) {
      let result: OverlayOutcome
      try { result = await deps.present(c) }
      catch (error) { console.error('[overlay] Failed to show card:', error); result = 'off' }
      // 'off' wins (the toast must still appear), then 'exclusive' (toast after the game loses focus).
      if (result === 'off' || (result === 'exclusive' && outcome === 'shown')) outcome = result
    }
    return outcome
  }

  const statusCards = (status: RecordingStatus): OverlayCard[] => {
    const prev = previous
    previous = status
    if (!prev) return []
    const out: OverlayCard[] = []
    if (status.phase === 'recording' && prev.phase !== 'recording') {
      const method = captureName(status.capture)
      out.push(card('rec', 'rec', tr('錄影中'), method ? tr('{method} 擷取', { method }) : tr('開始錄影')))
    }
    if (status.paused && !prev.paused) out.push(card('info', 'pause', tr('已暫停'), tr('自動錄影已暫停')))
    if (!status.paused && prev.paused) out.push(card('info', 'play', tr('已繼續'), tr('自動錄影已繼續')))
    if (status.phase === 'finalizing' && prev.phase === 'recording') out.push(card('info', 'stop', tr('已停止'), tr('正在儲存錄影')))
    return out
  }

  const killCards = (update: LiveUpdate, settings: OverlaySettings): OverlayCard[] => {
    if (update.sessionId !== liveSession) {
      liveSession = update.sessionId
      seenKills.clear()
      streak = null
    }
    if (!update.events) return []
    const fresh = update.events.filter((e) => e.type === 'kill' && !e.deleted && e.counted !== false && !seenKills.has(e.id))
    if (!fresh.length) return []
    for (const e of fresh) seenKills.add(e.id)
    matchKills += fresh.length
    const at = now()
    if (!streak || streak.round !== round || (round === null && at - streak.lastAt > KILL_STREAK_GAP_MS)) {
      streak = { id: ++streakIds, count: 0, lastAt: at, round }
    }
    streak.count += fresh.length
    streak.lastAt = at
    if (!settings.showKills) return []
    const detail = streak.round !== null ? tr('第 {round} 回合', { round: streak.round }) : tr('本局擊殺 {kills}', { kills: matchKills })
    return [card('kill', 'crosshair', killTitle(streak.count), detail, `kill-${streak.id}`)]
  }

  const activityCards = (activity: RecorderActivity, settings: OverlaySettings): OverlayCard[] => {
    switch (activity.type) {
      case 'game':
        return activity.running ? [card('info', 'check', 'VALORANT', tr('錄影器就緒'))] : []
      case 'match':
        if (activity.ev === 'pending') return [card('info', 'match', tr('找到對局'), tr('倒數中…'))]
        if (activity.ev === 'cancel') return [card('info', 'match', tr('對局取消'), tr('倒數後未開局'))]
        if (activity.ev === 'start') {
          matchKills = 0
          round = 1
          streak = null
          return [card('rec', 'match', tr('第 {index} 局', { index: activity.index }), tr('對局開始'))]
        }
        round = null
        streak = null
        return [card('info', 'match', tr('對局結束'), tr('擊殺 {kills}', { kills: activity.kills }))]
      case 'round': {
        round = activity.ally + activity.enemy + 1
        streak = null
        if (!settings.showRounds) return []
        const won = activity.winner === 'ally'
        return [card(won ? 'ok' : 'loss', 'round', won ? tr('回合勝利') : tr('回合失利'), `${activity.ally} – ${activity.enemy}`)]
      }
      case 'fallback':
        return [card('warn', 'swap', tr('擷取方式'), `${activity.from.toUpperCase()} → ${activity.to.toUpperCase()}`)]
    }
  }

  return {
    async handle(input) {
      const settings = deps.getSettings()
      // Status must be tracked even while off, so turning the overlay on later does not replay old transitions.
      const cards = input.type === 'status' ? statusCards(input.status)
        : input.type === 'live' ? killCards(input.update, settings)
          : input.type === 'activity' ? activityCards(input.activity, settings)
            : input.type === 'analysis' ? [card('ok', 'check', tr('分析完成'), input.kills === null ? tr('可以剪輯了') : tr('擊殺 {kills}', { kills: input.kills }))]
              : input.kind === 'matchStart' || input.kind === 'matchEnd' || input.kind === 'matchCancel'
                // Shown from the match activity; the notice itself only feeds the toast.
                ? null
                : [card(NOTICE_LOOK[input.kind].tone, NOTICE_LOOK[input.kind].icon, noticeTitle(input.kind),
                  input.kind === 'finalized' ? savedDetail(input.message) : input.message)]
      if (!settings.enabled) return 'off'
      if (cards === null) return 'shown'
      return show(cards)
    },
    test() {
      return [
        card('rec', 'rec', tr('錄影中'), tr('{method} 擷取', { method: 'WGC' }), 'test-rec'),
        card('kill', 'crosshair', killTitle(5), tr('第 {round} 回合', { round: 7 }), 'test-kill'),
        card('ok', 'save', tr('已儲存'), 'Valorant 2026-11-15 21-04.mp4', 'test-saved')
      ]
    }
  }
}
