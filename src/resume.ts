/**
 * Semantic checkpoint / resume across sessions.
 *
 * The harness already durably persists each session transcript and folds
 * plan-mode state from the log, so resuming the *same* session id restores
 * context. What it does not do is carry an in-flight task across a *new*
 * session (the usual case after a restart): the portable doc is keyed by
 * session id, so a fresh session cannot see the previous task's goal or its
 * unresolved problems.
 *
 * This module closes that gap at the semantic level without replaying any
 * execution: it scans the durable portable docs for sessions that still have
 * unresolved problems and renders a "what was in flight / what was left"
 * brief. The model is guided to *confirm with the user* before continuing —
 * it never auto-runs prior tool calls or side effects. Everything here is a
 * read over the existing portable domain: no new schema, no data migration,
 * fully removable.
 * @module dsh-memory/src/resume
 */

import type { MemoryStore } from './store.ts'
import type { PortableDocRecord } from './domain.ts'
import type { MemoryMode, SessionId } from './types.ts'

const DAY_MS = 86_400_000

/** One session that can be picked back up, projected from its portable doc. */
export interface ResumableSession {
  sessionId: string
  title: string
  mode: MemoryMode
  goal: string
  solvedProblems: string[]
  unresolvedProblems: string[]
  /** ISO time of the last logged exchange ('' when the doc has no log). */
  lastActive: string
  exchangeCount: number
  /** The user's most recent inputs, oldest→newest, to reconstruct the scene. */
  recentUserInputs: string[]
  /**
   * Full progress log of the session (append-only on the doc), empty-filtered,
   * capped at `progressCap` most recent entries. Rendered as 最近进展.
   */
  progressEntries: string[]
}

/** Max progress entries carried into a resume brief (cap = guard, not target). */
export const DEFAULT_PROGRESS_CAP = 20

/** Knobs for selecting resumable sessions. All fields optional. */
export interface ResumeSelectOptions {
  /** Maximum candidates to return. Default 3. */
  limit?: number
  /** Hide the current/new session itself from the candidates. */
  excludeSessionId?: string | SessionId
  /** Restrict to one memory mode; absent = both daily and work. */
  mode?: MemoryMode
  /**
   * Only surface sessions that still have unresolved problems (the strong
   * "not finished" signal). Default true. When false, recently active docs
   * without explicit unresolved items may also be returned.
   */
  onlyUnresolved?: boolean
  /** Drop sessions whose last activity is older than this many days. */
  maxAgeDays?: number
  /** How many of the user's latest inputs to carry per candidate. Default 3. */
  recentLogCount?: number
  /** Max progress entries carried per candidate (empty-filtered, newest kept). Default 20. */
  progressCap?: number
  /** Current time in ms (injected for deterministic tests). */
  nowMs?: number
}

/** Millisecond timestamp of a doc's last logged exchange; 0 when it has none. */
export function docLastActiveMs(doc: PortableDocRecord): number {
  const last = doc.log.length > 0 ? doc.log[doc.log.length - 1]?.time : undefined
  if (last === undefined) return 0
  const t = Date.parse(last)
  return Number.isFinite(t) ? t : 0
}

/**
 * Whether a portable doc represents an unfinished, resumable session.
 * Conservative by default: explicit unresolved problems are required, so a
 * finished task or plain chat is not pushed at the user. With
 * `onlyUnresolved=false`, any doc carrying a goal, an exchange log, or
 * unresolved items counts.
 */
export function isResumable(doc: PortableDocRecord, onlyUnresolved = true): boolean {
  if (doc.unresolvedProblems.length > 0) return true
  if (onlyUnresolved) return false
  return doc.goal.trim() !== '' || doc.log.length > 0 || doc.solvedProblems.length > 0
}

function toResumable(doc: PortableDocRecord, recentLogCount: number, progressCap = DEFAULT_PROGRESS_CAP): ResumableSession {
  const tail = doc.log.slice(-Math.max(0, recentLogCount))
  const progressEntries = doc.progress.filter(item => item.trim() !== '').slice(-Math.max(0, progressCap))
  return {
    sessionId: String(doc.sessionId),
    title: doc.title,
    mode: doc.mode,
    goal: doc.goal,
    solvedProblems: [...doc.solvedProblems],
    unresolvedProblems: [...doc.unresolvedProblems],
    lastActive: doc.log.length > 0 ? (doc.log[doc.log.length - 1]?.time ?? '') : '',
    exchangeCount: doc.exchangeCount,
    recentUserInputs: tail.map(entry => entry.user).filter(text => text.trim() !== '' && text !== '[小黑板更新]'),
    progressEntries,
  }
}

/**
 * Pure selection over portable docs: filter to unfinished sessions, apply the
 * mode / age / exclusion constraints, order by most-recent activity first,
 * and project to {@link ResumableSession} (carrying the tail of the log).
 */
export function selectResumable(
  docs: PortableDocRecord[],
  options: ResumeSelectOptions = {},
): ResumableSession[] {
  const limit = options.limit ?? 3
  const recentLogCount = options.recentLogCount ?? 3
  const progressCap = options.progressCap ?? DEFAULT_PROGRESS_CAP
  const onlyUnresolved = options.onlyUnresolved ?? true
  const nowMs = options.nowMs ?? Date.now()
  const exclude = options.excludeSessionId === undefined ? undefined : String(options.excludeSessionId)
  const maxAgeMs = options.maxAgeDays === undefined ? undefined : Math.max(0, options.maxAgeDays) * DAY_MS

  const candidates: PortableDocRecord[] = []
  for (const doc of docs) {
    if (options.mode !== undefined && doc.mode !== options.mode) continue
    if (exclude !== undefined && String(doc.sessionId) === exclude) continue
    if (!isResumable(doc, onlyUnresolved)) continue
    const lastMs = docLastActiveMs(doc)
    if (maxAgeMs !== undefined) {
      // Docs without any timestamp cannot be age-checked; treat as too old.
      if (lastMs === 0 || nowMs - lastMs > maxAgeMs) continue
    }
    candidates.push(doc)
  }

  candidates.sort((a, b) => docLastActiveMs(b) - docLastActiveMs(a))
  return candidates.slice(0, limit).map(doc => toResumable(doc, recentLogCount, progressCap))
}

/** Convenience wrapper: select directly from an opened store. */
export function findResumableSessions(
  store: MemoryStore,
  options: ResumeSelectOptions = {},
): ResumableSession[] {
  return selectResumable(store.listPortableDocs(), options)
}

function fmtTime(iso: string): string {
  if (iso === '') return '时间未知'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return iso.replace('T', ' ').slice(0, 16)
}

/** Closing guidance shared by every non-empty brief: confirm, never replay. */
export const RESUME_GUIDANCE =
  '以上仅为历史记录，不代表现在要自动执行。请先向用户确认要接续哪一个任务；'
  + '确认后可用 brain 工具 action=search 回忆相关细节，再从“待解决”处继续。'
  + '不要自动重放之前的工具调用或任何有副作用的操作。'

/**
 * Render resumable sessions as a model/user-facing brief. Returns an explicit
 * empty message when there is nothing unfinished, so callers never mistake
 * "no rows" for a failure.
 */
export function renderResumeBrief(candidates: ResumableSession[]): string {
  if (candidates.length === 0) return '没有检测到尚未收尾的历史任务（无未解决问题）。'
  const lines: string[] = [
    `=== 可接续的历史任务（断点续跑，共 ${candidates.length} 个）===`,
  ]
  candidates.forEach((c, i) => {
    lines.push('')
    lines.push(`[${i + 1}] ${c.title || '未命名任务'}（${c.mode === 'work' ? '工作' : '日常'}，第 ${c.exchangeCount} 次交换，最近活动 ${fmtTime(c.lastActive)}）`)
    lines.push(`  会话：${c.sessionId}`)
    lines.push(`  目标：${c.goal.trim() !== '' ? c.goal : '（未记录明确目标）'}`)
    lines.push(`  已解决：${c.solvedProblems.length > 0 ? c.solvedProblems.join('、') : '无'}`)
    lines.push(`  待解决：${c.unresolvedProblems.length > 0 ? c.unresolvedProblems.join('、') : '无'}`)
    if (c.progressEntries.length > 0) {
      lines.push('  最近进展：')
      for (const item of c.progressEntries) {
        lines.push(`    · ${item.length > 120 ? `${item.slice(0, 120)}…` : item}`)
      }
    }
    if (c.recentUserInputs.length > 0) {
      lines.push('  最近在做：')
      for (const text of c.recentUserInputs) {
        lines.push(`    · ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`)
      }
    }
  })
  lines.push('')
  lines.push(RESUME_GUIDANCE)
  return lines.join('\n')
}

/**
 * A one-line, non-interrupting nudge injected into a brand-new session when
 * unfinished tasks exist elsewhere. Returns '' when there is nothing to
 * resume, so the injected context stays silent otherwise.
 */
export function renderResumeHint(count: number): string {
  if (count <= 0) return ''
  return `[断点续跑] 检测到 ${count} 个尚未收尾的历史任务。若用户想接着上次的工作，可用 brain 工具 action=resume 查看可接续任务；未与用户确认前不要自动开始或重放任何操作。`
}
