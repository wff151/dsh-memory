/**
 * Brain capabilities: one definition per ability, consumed in two modes.
 *
 * - dispatcher mode (default): only a single `brain` tool is registered by the
 *   dsh-brain-dispatch package. Each capability below is reached through its
 *   short `key` via `action` + `params`; the full schemas never reach the model,
 *   so the per-request token tax collapses from ~13 tool schemas to one compact
 *   menu. The model decides directly; it loads only the one ability it needs.
 * - native mode (opt-in fallback): every capability is registered as its own
 *   `brain_memory_<key>` tool exactly as before, preserving the original surface.
 * @module dsh-memory/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from './store.ts'
import type { SemanticService } from './semantic.ts'
import { renderRetrievedContextBudgeted } from './budget.ts'
import type { Importance } from './budget.ts'
import { runShortTermDecay } from './decay.ts'
import { maybeCreateProposals } from './evolution.ts'
import { collectReflectionMaterial } from './reflection.ts'
import { findResumableSessions, renderResumeBrief, selectResumable } from './resume.ts'
import type { AgentEvolutionRecord, PortableDocRecord } from './domain.ts'
import type { MemoryMode, RecordId, SessionId } from './types.ts'
import { inferRelations } from './relations.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const MODE_PARAM = {
  type: 'string' as const,
  enum: ['daily', 'work'] as const,
  description: '记忆模式：daily（日常）/ work（工作）。',
}

function modeOf(value: unknown): MemoryMode {
  return value === 'work' ? 'work' : 'daily'
}

/** Loose execution context handed to a capability (mirrors defineTool's exec). */
export type BrainExec = any

/** One brain ability: compact menu copy, optional native schema, and the body. */
export interface BrainCapability {
  /** Short action key used through the dispatcher, e.g. `search`. */
  key: string
  /** Legacy full-tool name used in native mode, e.g. `brain_memory_search`. */
  nativeName: string
  /** One-line menu entry: when to reach for this ability. */
  menu: string
  /** Compact params hint shown next to the menu entry (no schema, just names). */
  paramsHint: string
  /** Card title for presentCall. */
  title: string
  /** schemastery parameters used ONLY in native full-tool mode. */
  parameters?: Record<string, any>
  /** Run the ability. `args` is the dispatcher `params` object (or native args). */
  run: (args: any, exec: BrainExec) => Promise<string>
}

/** Pull a session id off the tool execution, or throw a clear error. */
function requireSessionId(exec: BrainExec): SessionId {
  const id = exec?.agent?.session?.id
  if (id === undefined) throw new Error('this brain capability requires an owning agent session')
  return id as SessionId
}

/** Render the portable doc as a human-readable project status markdown file. */
export function renderProjectMarkdown(doc: PortableDocRecord): string {
  const lines: string[] = []
  lines.push(`# ${doc.title || '项目进展'}`)
  lines.push('')
  lines.push(`> 随身小黑板 · 第 ${doc.exchangeCount} 次更新`)
  if (doc.goal) {
    lines.push('')
    lines.push(`## 目标`)
    lines.push(doc.goal)
  }
  if (doc.progress.length > 0) {
    lines.push('')
    lines.push('## 进展')
    for (const item of doc.progress) lines.push(`- ${item}`)
  }
  if (doc.unresolvedProblems.length > 0) {
    lines.push('')
    lines.push('## 待解决问题')
    for (const item of doc.unresolvedProblems) lines.push(`- ${item}`)
  }
  if (doc.nextSteps.length > 0) {
    lines.push('')
    lines.push('## 下一步')
    for (const item of doc.nextSteps) lines.push(`- ${item}`)
  }
  if (doc.result) {
    lines.push('')
    lines.push('## 结果')
    lines.push(doc.result)
  }
  if (doc.solvedProblems.length > 0) {
    lines.push('')
    lines.push('## 已解决')
    for (const item of doc.solvedProblems) lines.push(`- ${item}`)
  }
  if (doc.tags.length > 0) {
    lines.push('')
    lines.push(`标签：${doc.tags.join('、')}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Build the memory capability table. Capabilities close over the opened store
 * and the optional semantic service exactly as the old tool bodies did.
 */
export function buildMemoryCapabilities(
  store: MemoryStore,
  semantic?: SemanticService,
  /**
   * 从插件配置透下来的运行参数。
   *
   * 只放"工具执行时需要"的项。手动衰减工具必须知道 `shortMaxItems`，
   * 否则它清不到容量上限 —— 定时衰减清了、手动没清，两次行为不一致。
   */
  options: { shortMaxItems?: number; shortContextSharePercent?: number } = {},
): Map<string, BrainCapability> {
  const caps = new Map<string, BrainCapability>()

  const add = (cap: BrainCapability): void => {
    caps.set(cap.key, cap)
  }

  // ── notebook (the scratchboard): deliberately updated at key moments ──────
  add({
    key: 'note',
    nativeName: 'brain_memory_portable_doc',
    menu: '更新随身小黑板：目的 / 进展 / 问题 / 结果 / 下一步。开工定目标、阶段进展、卡住、收尾时用；简单一步任务不必用，不要每轮调用。小黑板是本会话内的；换会话后要取回，用 resume。',
    paramsHint: '{goal?, progress?:[...], issues?:[...], solved?:[...], result?, next_steps?:[...], title?, tags?:[...]}',
    title: '更新随身小黑板',
    parameters: {
      goal: { type: 'string', description: '当前目标（提供则更新）。' },
      progress: { type: 'array', items: { type: 'string' }, description: '本次完成的阶段进展（追加）。' },
      issues: { type: 'array', items: { type: 'string' }, description: '本次发现、仍待解决的问题（追加）。' },
      solved: { type: 'array', items: { type: 'string' }, description: '本次解决的问题（追加，并从待解决移除）。' },
      result: { type: 'string', description: '当前结论 / 最终结果（提供则更新）。' },
      next_steps: { type: 'array', items: { type: 'string' }, description: '下一步计划（整体覆盖）。' },
      title: { type: 'string', description: '小黑板标题（简练任务名）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签（追加）。' },
    },
    run: async (args, exec) => {
      const sessionId = requireSessionId(exec)
      const doc = await store.updateNotebook(sessionId, {
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(typeof args.goal === 'string' ? { goal: args.goal } : {}),
        ...(Array.isArray(args.progress) ? { progress: args.progress } : {}),
        ...(Array.isArray(args.issues) ? { issues: args.issues } : {}),
        ...(Array.isArray(args.solved) ? { solved: args.solved } : {}),
        ...(typeof args.result === 'string' ? { result: args.result } : {}),
        ...(Array.isArray(args.next_steps) ? { nextSteps: args.next_steps } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
      })

      // Best-effort: mirror the notebook to a user-openable project status file
      // under the session working directory. Never fails the memory write.
      // Resolution: explicit DSH_BRAIN_PROJECT_DIR override (keeps the official
      // dsh source tree clean during tests / relocatable installs) → the session
      // creation cwd when the harness populates it (web / subagents) → the
      // process launch dir (headless one-shot does not set session.meta.cwd, but
      // dsh itself keys the session folder off this same directory).
      const cwd: string | undefined = process.env.DSH_BRAIN_PROJECT_DIR
        ?? exec?.agent?.session?.cwd
        ?? process.cwd()
      let mirrored = ''
      if (typeof cwd === 'string' && cwd !== '') {
        try {
          const dir = path.join(cwd, '.brain')
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(path.join(dir, 'PROJECT.md'), renderProjectMarkdown(doc), 'utf8')
          mirrored = `\n已同步项目进展文件：.brain/PROJECT.md`
        } catch {
          mirrored = '' // working dir unavailable (sandboxed/web); storage copy still holds it.
        }
      }

      return [
        `小黑板已更新（第 ${doc.exchangeCount} 次）`,
        `目标：${doc.goal || '无'}`,
        `进展 ${doc.progress.length} 项 | 待解决：${doc.unresolvedProblems.join('、') || '无'}`,
        doc.nextSteps.length > 0 ? `下一步：${doc.nextSteps.join('；')}` : '',
        mirrored.trim(),
      ].filter(Boolean).join('\n')
    },
  })

  // ── search past experience ────────────────────────────────────────────────
  add({
    key: 'search',
    nativeName: 'brain_memory_search',
    menu: '检索长期与短期记忆里的过往经验 / 偏好 / 结论。需要跨会话经验、面临关键或不可逆决定、或怀疑以前踩过同样的坑时用；简单直接的任务不要用。本会话小黑板内容（note 写的）不在此列，用 resume 取。',
    paramsHint: '{query, importance?:"high|normal|low", mode?:"daily|work", top_k?}',
    title: '检索记忆',
    parameters: {
      query: { type: 'string', required: true, description: '检索问题或自然语言描述。' },
      importance: {
        type: 'string',
        enum: ['high', 'normal', 'low'],
        description: '检索预算档：high=关键/安全/不可逆，宁多勿漏；normal=常规（默认）；low=可查可不查、最小预算。',
      },
      mode: { ...MODE_PARAM, description: '限定检索模式；省略则跨 daily 与 work。' },
      top_k: { type: 'integer', description: '返回条数上限；默认随 importance（8/5/3）。' },
    },
    run: async (args) => {
      const mode = args.mode === undefined ? 'both' : modeOf(args.mode)
      const importance: Importance | undefined = args.importance === 'high' || args.importance === 'normal' || args.importance === 'low'
        ? args.importance
        : undefined
      const { text } = await renderRetrievedContextBudgeted(store, String(args.query ?? ''), {
        mode,
        ...(importance !== undefined ? { importance } : {}),
        ...(typeof args.top_k === 'number' ? { topK: args.top_k } : {}),
        ...(semantic !== undefined ? { semantic } : {}),
      })
      return text
    },
  })

  // ── persist a concluded task into long-term memory ────────────────────────
  add({
    key: 'remember',
    nativeName: 'brain_memory_record',
    menu: '把一次有结论、以后可能复用的任务或经验沉淀为可检索的长期记忆。收尾时确有保留价值才用；普通流水账不要记。',
    paramsHint: '{mode?:"daily|work", title, summary, tags?:[...], goal?, unresolved?:[...], result?}',
    title: '记录长期记忆',
    parameters: {
      mode: { ...MODE_PARAM, required: true },
      title: { type: 'string', required: true, description: '简练任务名（记忆标题）。' },
      summary: { type: 'string', required: true, description: '三四百字以内的摘要。' },
      tags: { type: 'array', items: { type: 'string' }, description: '结构化标签。' },
      goal: { type: 'string', description: '本次任务目标。' },
      unresolved: { type: 'array', items: { type: 'string' }, description: '未解决问题。' },
      result: { type: 'string', description: '最终结果。' },
    },
    run: async (args) => {
      const title = String(args.title ?? '')
      const summary = String(args.summary ?? '')
      // 关系边：从标题+摘要里半自动抽（「与 X 相恋」「A 是 B 之兄」）。
      // 抽不到就不写，不影响记录本身。
      const relations = inferRelations(title, `${title} ${summary}`)
      const entry = await store.recordPublicMemory({
        mode: modeOf(args.mode),
        title,
        summary,
        tags: Array.isArray(args.tags) ? args.tags : [],
        goal: typeof args.goal === 'string' ? args.goal : undefined,
        unresolved: Array.isArray(args.unresolved) ? args.unresolved : [],
        result: typeof args.result === 'string' ? args.result : undefined,
        ...(relations.length > 0 ? { relatedTo: relations } : {}),
      })
      if (semantic !== undefined) void semantic.indexOne(entry).catch(() => {})
      return `已记录长期记忆 ${entry.memory_id}（${entry.mode}）\n标题：${entry.title}`
    },
  })

  // ── short-term entry: fact / state / event / task ─────────────────────────
  add({
    key: 'short',
    nativeName: 'brain_memory_write_short',
    menu: '写一条短期记忆。kind=fact（事实/偏好/中间结论）、state（键值状态，同键覆盖，带版本链）、event（变更事件，幂等键防重做）、task（任务上下文：目标/阶段/待办）、relation（人物关系网：谁→关系→谁，如小说人物关系，随书淡忘）。短记忆会衰减，但被检索命中过的会自动续命。',
    paramsHint: '{mode?:"daily|work", kind?:"fact|state|event|task|relation", title?, content?, tags?:[...], weight?, entity_key?, entity_value?, idempotency_key?, event_status?, phase?, pending?:[...], completed?:[...]}',
    title: '写入短期记忆',
    parameters: {
      mode: { ...MODE_PARAM, required: true },
      kind: { type: 'string', enum: ['fact', 'state', 'event', 'task', 'relation'], description: '条目类型，默认 fact。relation = 人物关系（谁→关系→谁）。' },
      title: { type: 'string', description: '标题，如「xx项目 · xx问题」。' },
      content: { type: 'string', description: '内容；state/event/task 下作为摘要或目标。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
      weight: { type: 'number', description: '初始权重，默认 1。' },
      entity_key: { type: 'string', description: 'kind=state 的键；kind=task 的任务 id；kind=event 的作用对象。' },
      entity_value: { type: 'string', description: 'kind=state 的值。' },
      idempotency_key: { type: 'string', description: 'kind=event 的幂等键（已成功过则不重复写）。' },
      event_status: { type: 'string', enum: ['pending', 'success', 'failed'], description: 'kind=event 的状态。' },
      phase: { type: 'string', description: 'kind=task 的阶段。' },
      pending: { type: 'array', items: { type: 'string' }, description: 'kind=task 的待办。' },
      completed: { type: 'array', items: { type: 'string' }, description: 'kind=task 的已完成。' },
    },
    run: async (args, exec) => {
      const mode = modeOf(args.mode)
      const kind = String(args.kind ?? 'fact')
      const content = String(args.content ?? '')
      const title = typeof args.title === 'string' ? args.title : undefined
      const sessionId = exec?.agent !== undefined ? String(exec.agent.session.id) : undefined

      if (kind === 'state' && typeof args.entity_key === 'string') {
        const item = await store.upsertState(mode, {
          key: args.entity_key,
          value: String(args.entity_value ?? content),
          ...(content !== '' ? { summary: content } : {}),
        })
        return `已更新状态 ${item.entityKey} = ${item.entityValue}（权重 ${item.weight.toFixed(2)}）`
      }

      if (kind === 'event') {
        const item = await store.appendEvent(mode, {
          action: title ?? content.slice(0, 40),
          ...(typeof args.entity_key === 'string' ? { target: args.entity_key } : {}),
          ...(typeof args.idempotency_key === 'string' ? { idempotencyKey: args.idempotency_key } : {}),
          ...(content !== '' ? { summary: content } : {}),
          ...(typeof args.event_status === 'string'
            ? { status: args.event_status as 'pending' | 'success' | 'failed' }
            : {}),
        })
        return `已记事件：${item.summary ?? item.content}（${item.eventStatus ?? 'pending'}）`
      }

      if (kind === 'task' && typeof args.entity_key === 'string') {
        const item = await store.updateTaskContext(mode, args.entity_key, {
          ...(content !== '' ? { goal: content } : {}),
          ...(typeof args.phase === 'string' ? { phase: args.phase } : {}),
          ...(Array.isArray(args.pending) ? { pending: args.pending } : {}),
          ...(Array.isArray(args.completed) ? { completed: args.completed } : {}),
        })
        return `已更新任务上下文 ${item.entityKey}（阶段 ${item.phase ?? '-'}）`
      }

      const item = await store.writeShortTerm(
        mode,
        content,
        Array.isArray(args.tags) ? args.tags : [],
        typeof args.weight === 'number' ? args.weight : 1,
        'fact',
        {
          by: 'agent',
          ...(title !== undefined ? { title } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        },
      )
      return `已写入短期记忆（${item.mode}，权重 ${item.weight.toFixed(2)}）\n${item.title ?? item.content}`
    },
  })

  // ── permanent user profile ────────────────────────────────────────────────
  add({
    key: 'profile',
    nativeName: 'brain_memory_set_profile',
    menu: '更新用户长期画像 / 稳定偏好（点路径写入，如 preferences.喜欢）。仅在用户明确表达长期偏好或身份信息时用。',
    paramsHint: '{mode?:"daily|work", path, value?}',
    title: '更新用户画像',
    parameters: {
      mode: { ...MODE_PARAM, required: true },
      path: { type: 'string', required: true, description: '字段路径，如 attributes.职业 或 preferences.喜欢。' },
      value: { type: 'json', description: '字段值；数组或实体字段会追加。' },
    },
    run: async (args) => {
      const profile = await store.setPermanent(modeOf(args.mode), String(args.path ?? ''), args.value ?? true)
      return `已更新用户画像 ${modeOf(args.mode)}.${String(args.path ?? '')}\n`
        + `属性：${Object.keys(profile.attributes).length} | 喜好：${Object.keys(profile.preferences).length} `
        + `| 技能：${profile.skills.length} | 关系：${profile.relationships.length}`
    },
  })

  // ── agent 自我记忆（与用户画像对立的那一块）──────────────────────────────
  add({
    key: 'self',
    nativeName: 'brain_memory_self',
    menu: '记录 agent 自己的记忆：自我认知 / 偏好 / 教训 / 工作方式。与「用户画像」对立的一块空间，回答的问题是「我是谁、我学到什么」。命名建议「日期_主题」，如 20261017_量体温失败。自我进化那套（失败指纹→提案）是另一条线，别混。',
    paramsHint: '{title, content, tags?:[...]}',
    title: '记录自我记忆',
    parameters: {
      title: { type: 'string', required: true, description: '标题，如「20261017_量体温失败」。' },
      content: { type: 'string', required: true, description: '内容：事实 / 教训 / 规则。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
    },
    run: async (args) => {
      const now = new Date().toISOString()
      const rec = await store.appendEvolution({
        type: 'self',
        id: `self_${Date.now().toString(36)}`,
        timestamp: now,
        title: String(args.title ?? ''),
        content: String(args.content ?? ''),
        tags: Array.isArray(args.tags) ? args.tags : [],
      } as AgentEvolutionRecord)
      const id = String((rec as Record<string, unknown>).id ?? '')
      return `已记入自我记忆 ${id}\n${String(args.title ?? '')}`
    },
  })

  // ── resume unfinished work from other sessions ────────────────────────────
  add({
    key: 'resume',
    nativeName: 'brain_memory_resume',
    menu: '断点续跑：只读查看其它历史会话里没收尾的任务（目标 / 已解决 / 待解决 / 最近进展）。换会话接着干时用；接续前先与用户确认，不自动重放。上一会话用 note 记的小黑板内容也在这里取回。',
    paramsHint: '{limit?, include_recent?, session_id?, mode?, max_age_days?, recent_log_count?}',
    title: '断点续跑·查看未收尾任务',
    parameters: {
      limit: { type: 'integer', description: '最多返回几个可接续任务，默认 3。' },
      mode: { ...MODE_PARAM, description: '只看某个记忆模式；省略则跨模式。' },
      include_recent: { type: 'boolean', description: 'true 时也包含近期活跃但无明确未解决问题的会话。' },
      max_age_days: { type: 'number', description: '只看最近多少天内活动过的任务。' },
      recent_log_count: { type: 'integer', description: '每个任务附带最近几条用户消息，默认 3。' },
      session_id: { type: 'string', description: '精确查看某个会话；省略则列出最近可接续任务。' },
    },
    run: async (args, exec) => {
      const recentLogCount = typeof args.recent_log_count === 'number' ? args.recent_log_count : 3
      if (typeof args.session_id === 'string' && args.session_id.trim() !== '') {
        const doc = store.getPortableDoc(args.session_id as SessionId)
        if (doc === undefined) return `没有找到会话 ${args.session_id} 的随身小黑板。`
        const candidates = selectResumable([doc], { onlyUnresolved: false, recentLogCount, limit: 1 })
        return renderResumeBrief(candidates)
      }
      const candidates = findResumableSessions(store, {
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(args.mode === 'work' || args.mode === 'daily' ? { mode: modeOf(args.mode) } : {}),
        onlyUnresolved: args.include_recent === true ? false : true,
        ...(typeof args.max_age_days === 'number' ? { maxAgeDays: args.max_age_days } : {}),
        recentLogCount,
        ...(exec?.agent !== undefined ? { excludeSessionId: exec.agent.session.id } : {}),
      })
      return renderResumeBrief(candidates)
    },
  })

  // ── evolution archive ─────────────────────────────────────────────────────
  add({
    key: 'evolution',
    nativeName: 'brain_memory_evolution',
    menu: '追加一条进化档案（错题日志 / 改进提案 / 规则 / 影子测试 / 反思）。用于沉淀一次明确的失败教训或沉淀出的规则。',
    paramsHint: '{type:"error-log|proposal|shadow-test|rule|reflection", content:{...}}',
    title: '记录进化档案',
    parameters: {
      type: {
        type: 'string',
        required: true,
        enum: ['error-log', 'proposal', 'shadow-test', 'rule', 'reflection'],
        description: '记录类型。',
      },
      content: { type: 'json', required: true, description: '记录内容对象。' },
    },
    run: async (args) => {
      const record = await store.appendEvolution({
        type: args.type === 'proposal' || args.type === 'shadow-test' || args.type === 'rule' || args.type === 'reflection' ? args.type : 'error-log',
        id: `EVO_${Date.now().toString(36)}` as RecordId,
        timestamp: new Date().toISOString(),
        ...(args.content as Record<string, unknown>),
      })
      return `已记录进化档案 ${record.id}（${record.type}）`
    },
  })

  // ── failure-fingerprint check → proposals ─────────────────────────────────
  add({
    key: 'failure_check',
    nativeName: 'brain_memory_evolution_check',
    menu: '检查近期失败指纹：同类错误重复出现达到阈值时自动生成改进提案。反复栽进同一种问题时用。',
    paramsHint: '{threshold?, windowDays?}',
    title: '失败指纹检查',
    parameters: {
      threshold: { type: 'number', description: '触发阈值（同指纹次数，默认 2）。' },
      windowDays: { type: 'number', description: '统计窗口天数（默认 90）。' },
    },
    run: async (args) => {
      const options: Parameters<typeof maybeCreateProposals>[1] = {}
      if (typeof args.threshold === 'number') options.threshold = args.threshold
      if (typeof args.windowDays === 'number') options.windowDays = args.windowDays
      const { counts, proposals, skipped } = await maybeCreateProposals(store, options)
      const threshold = args.threshold ?? 2
      const lines = ['=== 失败指纹检查 ===']
      for (const [fp, count] of Object.entries(counts)) {
        lines.push(`  ${count >= threshold ? '▲' : '·'} ${fp}: ${count} 次`)
      }
      if (proposals.length > 0) {
        lines.push(`\n已生成 ${proposals.length} 条改进提案：`)
        for (const p of proposals) {
          lines.push(`  ${p.id} → ${String((p as Record<string, unknown>).triggerFingerprint)}`)
        }
      }
      if (skipped.length > 0) lines.push(`\n已有未处理提案，跳过：${skipped.join('、')}`)
      if (Object.keys(counts).length === 0) lines.push('  （暂无错题日志）')
      return lines.join('\n')
    },
  })

  // ── reflection material + write ───────────────────────────────────────────
  add({
    key: 'reflect_material',
    nativeName: 'brain_memory_reflection_material',
    menu: '拉取写反思所需的真实素材（新增记忆 / 短期快照 / 失败指纹 / 提案 / 高频主题 / 未解决项）。准备做阶段性复盘时先用它取证。',
    paramsHint: '{windowDays?}',
    title: '反思素材',
    parameters: {
      windowDays: { type: 'number', description: '回顾窗口天数（默认 1）。' },
    },
    run: async (args) => {
      const material = collectReflectionMaterial(store, {
        ...(typeof args.windowDays === 'number' ? { windowDays: args.windowDays } : {}),
      })
      const lines = [`=== 反思素材（近 ${material.windowDays} 天）===`]
      lines.push(`新增公共记忆：${material.newPublicCount} 条`)
      lines.push(`当前短期记忆：${material.shortTermCount} 条`)
      lines.push(`新增进化提案：${material.newProposalCount} 条`)
      if (material.topTags.length > 0) {
        lines.push(`高频主题：${material.topTags.map(t => `${t.tag}×${t.count}`).join('、')}`)
      }
      const fps = Object.entries(material.errorFingerprints)
      lines.push(fps.length > 0
        ? `失败指纹：${fps.map(([fp, c]) => `${fp}×${c}`).join('、')}`
        : '失败指纹：（窗口内无错题）')
      lines.push(material.unresolved.length > 0 ? `未解决：${material.unresolved.join('；')}` : '未解决：（无）')
      lines.push('\n请据此按反思模板（brain action=reflect）完成深度反思。')
      return lines.join('\n')
    },
  })

  add({
    key: 'reflect',
    nativeName: 'brain_memory_reflect',
    menu: '写一条深度反思存入进化档案。建议先 reflect_material 取证，按观察 / 归因 / 行动三段写。',
    paramsHint: '{observation, analysis, action, tags?:[...]}',
    title: '深度反思',
    parameters: {
      observation: { type: 'string', required: true, description: '事实观察 + 模式识别（基于真实记录）。' },
      analysis: { type: 'string', required: true, description: '根因分析 + 趋势判断。' },
      action: { type: 'string', required: true, description: '下一阶段最优先改变的一件可执行事项。' },
      tags: { type: 'json', description: '可选标签数组。' },
    },
    run: async (args) => {
      const userTags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : []
      const record = await store.appendEvolution({
        type: 'reflection',
        id: `REFL_${Date.now().toString(36)}` as RecordId,
        timestamp: new Date().toISOString(),
        observation: String(args.observation ?? ''),
        analysis: String(args.analysis ?? ''),
        action: String(args.action ?? ''),
        tags: [...new Set(['manual', ...userTags])],
      })
      return `已写入深度反思 ${record.id}\n观察：${String(args.observation).slice(0, 120)}…`
    },
  })

  // ── status / decay (maintenance) ──────────────────────────────────────────
  add({
    key: 'status',
    nativeName: 'brain_memory_status',
    menu: '查看记忆系统各分区计数（公共 / 短期 / 画像 / 小黑板 / 进化档案）。',
    paramsHint: '{}',
    title: '查看记忆状态',
    parameters: {},
    run: async () => {
      const lines = ['=== 记忆系统状态 ===']
      for (const mode of ['daily', 'work'] as const) {
        const pub = store.listPublicMemories(mode)
        const short = store.listShortTerm(mode)
        const perm = store.getPermanent(mode)
        lines.push(`\n[${mode === 'daily' ? '日常' : '工作'}]`)
        lines.push(`  公共记忆：${pub.length} 条`)
        lines.push(`  短期记忆：${short.length} 条`)
        lines.push(`  永久画像：${Object.keys(perm.attributes).length} 属性 / ${Object.keys(perm.preferences).length} 喜好 / ${perm.skills.length} 技能 / ${perm.relationships.length} 关系`)
      }
      lines.push(`\n[随身小黑板] ${store.listPortableDocs().length} 份`)
      lines.push(`[进化档案] ${store.listAllEvolution().length} 条`)
      lines.push(`[写入总数] ${store.memoryCount} 次`)
      return lines.join('\n')
    },
  })

  add({
    key: 'decay',
    nativeName: 'brain_memory_decay',
    menu: '手动触发短期记忆衰减清理（权重随时间指数衰减，过时条目归档）。短期窗口太杂时用。',
    paramsHint: '{}',
    title: '短期记忆衰减',
    parameters: {},
    run: async () => {
      // 手动触发时**拿不到上下文窗口**（工具执行上下文里没有 session 的
      // requestContext），所以这一步只走"条数上限"那条触发；
      // 占比触发由定时衰减负责（那里能看到窗口）。
      const summary = await runShortTermDecay(store, {
        maxItems: options.shortMaxItems,
        ...(options.shortContextSharePercent !== undefined
          ? { contextSharePercent: options.shortContextSharePercent }
          : {}),
      })
      const total = summary.daily.archived.length + summary.work.archived.length
      const reason = (r: typeof summary.daily) => r.triggeredBy === 'none' ? '未触发容量裁剪' : `由 ${r.triggeredBy === 'context' ? '窗口占比' : '条数上限'} 触发`
      return `短期记忆衰减完成${total === 0 ? '（无归档）' : ''}\n`
        + `daily：归档 ${summary.daily.archived.length} 条，保留 ${summary.daily.remaining} 条（${reason(summary.daily)}）\n`
        + `work：归档 ${summary.work.archived.length} 条，保留 ${summary.work.remaining} 条（${reason(summary.work)}）`
    },
  })

  // ── vector index maintenance (only when the semantic layer is live) ───────
  if (semantic !== undefined) {
    add({
      key: 'reindex',
      nativeName: 'brain_memory_reindex',
      menu: '为全部长期记忆（重新）生成语义向量索引。首次启用向量检索、更换 embedding 模型、或语义召回不准时用。',
      paramsHint: '{mode?:"daily|work"}',
      title: '重建语义索引',
      parameters: {
        mode: { ...MODE_PARAM, description: '只重建某个模式；省略则重建 daily 与 work。' },
      },
      run: async (args) => {
        const healthy = semantic.isAvailable() ? true : await semantic.probe()
        if (!healthy) {
          return 'embedding 服务当前不可用，索引未更新；记忆检索已自动回退到关键词模式。'
        }
        const r = await semantic.syncIndex(store, {
          ...(args.mode === 'work' || args.mode === 'daily' ? { mode: args.mode } : {}),
        })
        return [
          `语义向量索引完成（模型 ${r.model}）`,
          `新建/重建：${r.indexed} 条`,
          `已最新跳过：${r.skipped} 条`,
          `失败：${r.failed} 条`,
          `清理孤儿向量：${r.pruned} 条`,
        ].join('\n')
      },
    })
  }

  return caps
}

/**
 * Native fallback mode: register every capability as its own full-schema tool,
 * preserving the original `brain_memory_*` surface byte-for-name.
 */
export function registerMemoryTools(
  ctx: Context,
  store: MemoryStore,
  semantic?: SemanticService,
): void {
  const caps = buildMemoryCapabilities(store, semantic)
  for (const cap of caps.values()) {
    ctx.tools.register(defineTool({
      name: cap.nativeName,
      // Native full-tool descriptions reuse the menu line (kept short on purpose).
      description: cap.menu,
      parameters: cap.parameters ?? {},
      output: TEXT_OUTPUT,
      execute: async (args, exec) => cap.run(args, exec),
      presentCall: args => ({
        card: 'generic',
        title: cap.title,
        kind: 'other',
        rawInput: String(args.query ?? args.title ?? args.content ?? args.path ?? cap.key),
      }),
    }))
  }
}
