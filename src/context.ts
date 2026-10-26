/**
 * Dynamic context injection: the memory snapshot that reaches the model before
 * each step. The snapshot is assembled from the durable store, never from
 * process-local scratch, so a restart cannot silently drop remembered context.
 *
 * The context is registered as a `systemPrompt.context` contribution in the
 * caller's scope. When the `system-prompt` service is absent (headless
 * assemblies without the prompt seam), registration is skipped and the
 * snapshot is served through the memory service instead.
 * @module dsh-memory/src/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type { MemoryStore } from './store.ts'
import { renderRetrievedContext } from './retrieval.ts'
import { findResumableSessions, renderResumeHint } from './resume.ts'
import { renderShortTermProjection } from './state.ts'
import type { MemoryMode } from './types.ts'

/** Prompt-context order: after the harness identity, before tool guidance. */
export const MEMORY_CONTEXT_ORDER = 50

/** Prompt-context name used by the memory snapshot. */
export const MEMORY_CONTEXT_NAME = 'dsh-memory'

/** Knobs for the injected memory snapshot. */
export interface MemoryContextOptions {
  /**
   * Brand-new session nudge: when this session has no portable doc yet but
   * other sessions still have unresolved tasks, surface a one-line
   * "call brain_memory_resume" hint. Default off at the function level so existing
   * pure callers see byte-identical output; the plugin turns it on by config.
   */
  resumeHint?: boolean | (() => boolean)
  /** Max unfinished tasks the nudge counts. */
  resumeHintLimit?: number
  /**
   * Whether the snapshot is injected at all. A plain boolean is the pure-caller
   * default; the plugin passes a getter so the value can be flipped live.
   */
  injectContext?: boolean | (() => boolean)
}

/**
 * 渲染一条画像关系。
 *
 * 兼容两种形态：
 *   · 新的结构化 `{ from, relation, to }` → 「我 的 母亲 是 王秀兰」
 *   · 旧的扁平字符串 `"妈妈"` → 原样输出
 */
export function renderRelation(r: unknown): string {
  if (typeof r === 'string') return r
  if (r !== null && typeof r === 'object') {
    const o = r as { from?: unknown, relation?: unknown, to?: unknown, note?: unknown }
    const from = String(o.from ?? '').trim()
    const rel = String(o.relation ?? '').trim()
    const to = String(o.to ?? '').trim()
    const note = String(o.note ?? '').trim()
    if (from !== '' && rel !== '' && to !== '') {
      return note === '' ? `${from} 的 ${rel} 是 ${to}` : `${from} 的 ${rel} 是 ${to}（${note}）`
    }
    if (to !== '') return to
  }
  return ''
}

/** Render the per-session memory snapshot text for one open session. */
export function renderMemoryContext(
  store: MemoryStore,
  sessionId: SessionId,
  options: MemoryContextOptions = {},
): string {
  const resumeHintOn
    = typeof options.resumeHint === 'function' ? options.resumeHint() : options.resumeHint === true
  const lines: string[] = []
  const portable = store.getPortableDoc(sessionId)
  if (portable !== undefined) {
    // Scratchboard injected every turn, so keep it short: goal, the tail of the
    // progress log, open issues, next steps, and a result once one exists. The
    // full history (including everything solved) lives in .brain/PROJECT.md.
    lines.push(`[项目小黑板] ${portable.title}（更新 ${portable.exchangeCount} 次）`)
    if (portable.goal) lines.push(`  目标：${portable.goal}`)
    const progressTail = portable.progress.slice(-4)
    if (progressTail.length > 0) {
      const more = portable.progress.length - progressTail.length
      lines.push(`  最近进展：${progressTail.join('；')}${more > 0 ? `（另有 ${more} 项见 .brain/PROJECT.md）` : ''}`)
    }
    if (portable.unresolvedProblems.length > 0) lines.push(`  待解决：${portable.unresolvedProblems.join('、')}`)
    if (portable.nextSteps.length > 0) lines.push(`  下一步：${portable.nextSteps.join('；')}`)
    if (portable.result) lines.push(`  当前结果：${portable.result}`)
  } else if (resumeHintOn) {
    // Fresh session: the current portable doc cannot carry a previous task.
    // Point at durable, still-unfinished work in other sessions without
    // auto-starting anything — a guide, not a takeover (additive, reversible).
    const resumable = findResumableSessions(store, {
      excludeSessionId: sessionId,
      limit: options.resumeHintLimit ?? 3,
    })
    const hint = renderResumeHint(resumable.length)
    if (hint !== '') lines.push(hint)
  }
  // v2：短期记忆投影（当前任务 + 当前状态 + 最近变更，预算内）。
  // 事实条目不进投影——仍由检索（searchShortTerm）按需取回，防上下文膨胀。
  const projection = renderShortTermProjection(store, 'daily', { maxStates: 3, maxEvents: 3 })
  if (projection !== '') lines.push(projection)
  const profile = store.getPermanent('daily')
  const profileParts: string[] = []
  const attributes = Object.entries(profile.attributes)
  if (attributes.length > 0) {
    profileParts.push(`属性：${attributes.map(([k, v]) => `${k}=${String(v)}`).join('、')}`)
  }
  const preferences = Object.entries(profile.preferences)
  if (preferences.length > 0) {
    profileParts.push(`喜好：${preferences.map(([k, v]) => `${k}=${String(v)}`).join('、')}`)
  }
  if (profile.skills.length > 0) profileParts.push(`技能：${profile.skills.join('、')}`)
  if (profile.relationships.length > 0) {
    // 结构化条目渲染成「A 的〈关系〉是 B」；旧的扁平字符串原样保留。
    // 只取最近 8 条，防画像膨胀。
    profileParts.push(`关系：${profile.relationships.slice(-8).map(renderRelation).join('、')}`)
  }
  if (profileParts.length > 0) lines.push(`[永久记忆] ${profileParts.join(' | ')}`)

  // 自我记忆：agent 自己的那条线（evolution type='self'），与用户画像并列。
  // 设计草稿里的「agent 专项记忆空间」：可审计、可回溯。只取最近 3 条，防膨胀。
  const selves = store.listEvolution('self').slice(-3)
  if (selves.length > 0) {
    const bits = selves
      .map(s => String((s as Record<string, unknown>).title ?? (s as Record<string, unknown>).content ?? ''))
      .filter(t => t !== '')
    if (bits.length > 0) lines.push(`[自我记忆] ${bits.join('；')}`)
  }

  return lines.join('\n')
}

/**
 * Register the memory snapshot as a dynamic prompt context. The provider is
 * evaluated at each assembly for the owning agent, so the snapshot follows the
 * session's own memory.
 * @param ctx - registrant context carrying the prompt registry.
 * @param store - the opened memory store.
 */
export function registerMemoryContext(
  ctx: Context,
  store: MemoryStore,
  options: MemoryContextOptions = {},
): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.context({
      name: MEMORY_CONTEXT_NAME,
      order: MEMORY_CONTEXT_ORDER,
      text: (assemble) => {
        // The runtime toggle lives in the durable domain state, so a user can
        // switch injection on/off from the settings surface without a restart.
        if (!store.injectContext) return ''
        if (options.injectContext !== undefined) {
          const on = typeof options.injectContext === 'function' ? options.injectContext() : options.injectContext
          if (on !== true) return ''
        }
        const sessionId = assemble.agent?.session.id
        if (sessionId === undefined) return ''
        return renderMemoryContext(store, sessionId, options)
      },
    })
  })
}

/** Render a retrieval-based memory hint for one user query. */
export function renderMemoryHint(store: MemoryStore, query: string, mode: MemoryMode | 'both' = 'both'): string {
  return renderRetrievedContext(store, query, { mode })
}
