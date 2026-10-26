/**
 * Short-term memory v2: state projection + anti-rework guard.
 *
 * 短期记忆从"消息副本"升级为三层语义（见 IMPROVE 设计）：
 *   1. 当前状态（kind='state'，upsert，key → 当前值 + 版本链）；
 *   2. 变更事件（kind='event'，append-only，幂等键防重做）；
 *   3. 任务上下文（kind='task'，goal / phase / pending / completed / blocked）。
 *
 * 本模块提供两件事：
 *   - {@link renderShortTermProjection}：把三层投影成模型可读的短文本
 *     （默认只读投影，不把原始流水塞进上下文）；
 *   - {@link withIdempotency}：动作执行前的幂等包装（已 success 则跳过，
 *     防"以前做过又被重做"）。
 *
 * 存储方法在 store.ts（upsertState / appendEvent / checkIdempotent /
 * updateTaskContext / bumpShortRefCount）。
 * @module dsh-memory/src/state
 */

import type { MemoryStore } from './store.ts'
import type { MemoryMode } from './types.ts'
import type { ShortTermItemRecord } from './domain.ts'

/** 渲染用的相对时间（x 分钟 / 小时 / 天前）。 */
function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const ms = Date.now() - t
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/** 状态是否已过期（ttlHours 失效）。 */
function stateExpired(item: ShortTermItemRecord): boolean {
  if (item.kind !== 'state' || item.ttlHours === undefined) return false
  const base = new Date(item.lastAccess ?? item.createdAt).getTime()
  if (Number.isNaN(base)) return false
  return Date.now() - base > item.ttlHours * 3_600_000
}

/**
 * 渲染短期记忆三层投影（预算内，防止上下文膨胀）。
 * 默认：当前任务 1 条 + 状态 3 条 + 最近事件 3 条 + 人物关系 3 条。
 * 事实条目（kind='fact'）不参与投影——事实仍由检索（searchShortTerm）按需取回。
 */
export function renderShortTermProjection(
  store: MemoryStore,
  mode: MemoryMode,
  options: {
    /** 指定任务 id（缺省取最新一条任务上下文）。 */
    taskId?: string
    /** 状态条目上限，默认 3。 */
    maxStates?: number
    /** 事件条目上限，默认 3。 */
    maxEvents?: number
    /** 人物关系上限，默认 3（小说人物多，必须限量，否则投影会撑爆）。 */
    maxRelations?: number
  } = {},
): string {
  const items = store.listShortTerm(mode)
  const maxStates = options.maxStates ?? 3
  const maxEvents = options.maxEvents ?? 3
  const maxRelations = options.maxRelations ?? 3

  const tasks = items
    .filter(i => i.kind === 'task' && (options.taskId === undefined || i.entityKey === options.taskId))
    .sort((a, b) => (a.lastAccess < b.lastAccess ? 1 : -1))
  const states = items
    .filter(i => i.kind === 'state')
    .sort((a, b) => (a.lastAccess < b.lastAccess ? 1 : -1))
  const events = items
    .filter(i => i.kind === 'event')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  // 人物关系按**权重**排：衰减后权重低的自然沉底，读书记忆会随书淡忘。
  const relations = items
    .filter(i => i.kind === 'relation')
    .sort((a, b) => b.weight - a.weight)

  if (tasks.length === 0 && states.length === 0 && events.length === 0 && relations.length === 0) return ''

  const lines: string[] = []
  const task = tasks[0]
  if (task !== undefined) {
    lines.push(`[当前任务] ${task.content}`)
  }
  const stateLines = states
    .slice(0, maxStates)
    .map((s) => {
      const expired = stateExpired(s)
      const when = relativeTime(s.lastAccess)
      return `  ${s.entityKey}=${s.entityValue ?? ''}${expired ? '（已过期）' : ''}${when ? `（${when}更新）` : ''}`
    })
  if (stateLines.length > 0) {
    lines.push(`[当前状态]${states.length > maxStates ? `（另 ${states.length - maxStates} 项）` : ''}`)
    lines.push(...stateLines)
  }
  const eventLines = events
    .slice(0, maxEvents)
    .map((e) => {
      const when = relativeTime(e.createdAt)
      const text = e.summary ?? e.content
      return `  ${e.eventStatus === 'failed' ? '✗' : e.eventStatus === 'pending' ? '…' : '✓'} ${text}${when ? `（${when}）` : ''}`
    })
  if (eventLines.length > 0) {
    lines.push(`[最近变更]${events.length > maxEvents ? `（另 ${events.length - maxEvents} 条）` : ''}`)
    lines.push(...eventLines)
  }
  // 人物关系：只取权重最高的几条。小说人物关系随书衰减，权重低的自然沉底。
  const relationLines = relations
    .slice(0, maxRelations)
    .map(r => `  ${r.entityKey ?? ''} → ${r.summary ?? r.content}`)
  if (relationLines.length > 0) {
    lines.push(`[人物关系]${relations.length > maxRelations ? `（另 ${relations.length - maxRelations} 条）` : ''}`)
    lines.push(...relationLines)
  }
  return lines.join('\n')
}

/**
 * 幂等执行包装：同幂等键已有 success 事件 → 跳过（不重复执行）；
 * 否则执行 doWork，成功后写一条 success 事件。区分动作型任务（查幂等键）
 * 与状态型任务（查当前状态）——状态型任务请先查状态表是否已达成目标。
 */
export async function withIdempotency<T>(
  store: MemoryStore,
  mode: MemoryMode,
  idempotencyKey: string,
  doWork: () => Promise<T>,
  options: {
    action?: string
    target?: string
    taskId?: string
    summary?: string
  } = {},
): Promise<{ skipped: boolean; result?: T }> {
  if (store.checkIdempotent(mode, idempotencyKey)) {
    return { skipped: true }
  }
  const result = await doWork()
  await store.appendEvent(mode, {
    action: options.action ?? 'exec',
    target: options.target,
    idempotencyKey,
    taskId: options.taskId,
    summary: options.summary,
    status: 'success',
  })
  return { skipped: false, result }
}

/** 组合幂等键：task_id + action + target（调用方可按需再拼参数归一化 hash）。 */
export function idempotencyKeyOf(taskId: string, action: string, target: string): string {
  return `${taskId}:${action}:${target}`
}
