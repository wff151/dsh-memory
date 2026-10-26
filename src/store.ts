/**
 * Memory store: opens the dsh-memory domain and exposes typed, durable
 * operations for every memory subsystem (public / short-term / permanent /
 * portable / evolution). All writes go through the domain's write chain, so
 * reads never diverge from the medium.
 * @module dsh-memory/src/store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  memoryDomainSpec,
  type AgentEvolutionRecord,
  type MemoryDomainState,
  type PermanentProfileRecord,
  type PortableDocRecord,
  type PublicMemoryRecord,
  type ShortTermItemRecord,
} from './domain.ts'
import type { MemoryId, MemoryMode, RecordId } from './types.ts'
import { inferEntryKind } from './intent.ts'

const MODES: readonly MemoryMode[] = ['daily', 'work']

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function todayStr(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Durable memory store over the dsh-memory domain. One instance owns the
 * domain's lifecycle; callers close it via {@link close} (typically as a
 * `ctx.effect` disposer).
 */
export class MemoryStore {
  private domain: Domain<typeof memoryDomainSpec> | undefined
  private tables: {
    public: KvTable<MemoryId, PublicMemoryRecord>
    short: KvTable<string, ShortTermItemRecord>
    permanent: KvTable<string, PermanentProfileRecord>
    portable: KvTable<string, PortableDocRecord>
    evolution: KvTable<RecordId, AgentEvolutionRecord>
  } | undefined

  private constructor() {}

  /** Open the memory domain and resolve its typed table handles. */
  static async open(ctx: Context): Promise<MemoryStore> {
    const store = new MemoryStore()
    const domain = await ctx.storageDomain.open(memoryDomainSpec)
    store.domain = domain
    store.tables = {
      public: domain.table('public'),
      short: domain.table('short'),
      permanent: domain.table('permanent'),
      portable: domain.table('portable'),
      evolution: domain.table('evolution'),
    }
    return store
  }

  /** Close the domain, draining queued writes. Idempotent. */
  async close(): Promise<void> {
    await this.domain?.close()
    this.domain = undefined
    this.tables = undefined
  }

  private requireTables(): NonNullable<MemoryStore['tables']> {
    if (this.tables === undefined) throw new Error('dsh-memory store is not open')
    return this.tables
  }

  // ─── public memory (long-term) ──────────────────────────────────────────

  /** Record one public memory entry, keyed by its generated id. */
  async recordPublicMemory(input: {
    mode: MemoryMode
    title: string
    summary: string
    tags?: string[] | undefined
    goal?: string | undefined
    unresolved?: string[] | undefined
    result?: string | undefined
    source?: string | undefined
    taskId?: string | undefined
    taskPhase?: string | undefined
    /** 详细文档（按时间线排列的事实条目）；缺省不写，老条目无详情。 */
    detail?: string | undefined
    /** 关系边（指向其它实体）；缺省不写，不影响老条目。 */
    relatedTo?: Array<{ relation: string, target: string }> | undefined
    /** 条目类型（人物/地点/事件）；缺省时由 store 自动推断。 */
    kind?: 'person' | 'place' | 'event' | 'unknown' | undefined
  }): Promise<PublicMemoryRecord> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const entry: PublicMemoryRecord = {
      memory_id: genId('mem') as MemoryId,
      mode: input.mode,
      date: todayStr(),
      time: now,
      title: input.title,
      summary: input.summary,
      tags: input.tags ?? [],
      goal: input.goal ?? '',
      unresolved: input.unresolved ?? [],
      result: input.result ?? '',
      source: input.source ?? 'manual',
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskPhase !== undefined ? { taskPhase: input.taskPhase } : {}),
      ...(input.detail !== undefined && input.detail !== '' ? { detail: input.detail } : {}),
      ...(input.relatedTo !== undefined && input.relatedTo.length > 0 ? { relatedTo: input.relatedTo } : {}),
      // 条目类型：显式给了就用，否则自动推断（人物/地点/事件）。
      // 推断不出（unknown）就**不写**——宁可没有，也不猜错。
      ...(() => {
        const k = input.kind ?? inferEntryKind(input.title, input.summary)
        return k === 'unknown' ? {} : { kind: k }
      })(),
    }
    await tables.public.put(entry.memory_id, entry)
    await this.bumpCounter()
    return entry
  }

  /** List public memories for one mode, newest first. */
  listPublicMemories(mode: MemoryMode): PublicMemoryRecord[] {
    const tables = this.requireTables()
    return [...tables.public.entries()]
      .map(([, entry]) => entry)
      .filter(entry => entry.mode === mode)
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
  }

  /** List every public memory across modes, newest first. */
  listAllPublicMemories(): PublicMemoryRecord[] {
    const tables = this.requireTables()
    return [...tables.public.entries()]
      .map(([, entry]) => entry)
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
  }

  /** Look up one public memory by id. */
  getPublicMemory(id: MemoryId): PublicMemoryRecord | undefined {
    return this.requireTables().public.get(id)
  }

  // ─── short-term memory (weighted, decaying) ─────────────────────────────

  /** Load short-term items for one mode, newest first. */
  listShortTerm(mode: MemoryMode): ShortTermItemRecord[] {
    const tables = this.requireTables()
    return [...tables.short.entries()]
      .map(([, item]) => item)
      .filter(item => item.mode === mode)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  /** Write one short-term item; a duplicate content boosts its weight. */
  async writeShortTerm(
    mode: MemoryMode,
    content: string,
    tags: string[] = [],
    weight = 1,
    kind?: 'fact' | 'state' | 'event' | 'task' | 'relation',
    meta?: {
      by?: 'user' | 'agent'
      sessionId?: string
      title?: string
      /** 摘要：content 是全文，这一份只用于投影展示（每步注入）。 */
      summary?: string
    },
  ): Promise<ShortTermItemRecord> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const existing = [...tables.short.entries()]
      .map(([, item]) => item)
      .find(item => item.mode === mode && item.content === content)
    if (existing !== undefined) {
      const next: ShortTermItemRecord = {
        ...existing,
        weight: Math.min(2, existing.weight + 0.3),
        accessCount: existing.accessCount + 1,
        lastAccess: now,
        ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
        ...(meta?.title !== undefined ? { title: meta.title } : {}),
        ...(meta?.summary !== undefined ? { summary: meta.summary } : {}),
      }
      await tables.short.put(existing.id, next)
      await this.bumpCounter()
      return next
    }
    const item: ShortTermItemRecord = {
      id: genId('st'),
      mode,
      content,
      tags,
      weight,
      accessCount: 0,
      createdAt: now,
      lastAccess: now,
      by: meta?.by ?? 'user',
      ...(kind !== undefined ? { kind } : {}),
      ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
      ...(meta?.title !== undefined ? { title: meta.title } : {}),
      ...(meta?.summary !== undefined ? { summary: meta.summary } : {}),
    }
    await tables.short.put(item.id, item)
    await this.bumpCounter()
    return item
  }

  /** Replace the short-term list for one mode (used by decay). */
  async replaceShortTerm(mode: MemoryMode, items: ShortTermItemRecord[]): Promise<void> {
    const tables = this.requireTables()
    const keep = new Set(items.map(item => item.id))
    for (const [id, item] of tables.short.entries()) {
      if (item.mode === mode && !keep.has(id)) {
        await tables.short.delete(id)
      }
    }
    for (const item of items) {
      await tables.short.put(item.id, item)
    }
  }

  // ─── short-term v2: state / event / task context ────────────────────────
  //
  // 短期记忆从"消息副本"升级为"状态 + 事件 + 任务上下文"三层语义
  // （见 IMPROVE 设计：短期记忆 v2）。全部复用 short 表，用可选字段
  // kind/entityKey/idempotencyKey 等区分条目类型，旧数据向后兼容。

  /** Upsert one state key (kind='state'); same key replaces value, keeps version chain. */
  async upsertState(
    mode: MemoryMode,
    input: {
      key: string
      value: string
      summary?: string | undefined
      taskId?: string | undefined
      ttlHours?: number | undefined
      sourceEventId?: string | undefined
    },
  ): Promise<ShortTermItemRecord> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const existing = [...tables.short.entries()]
      .map(([, item]) => item)
      .find(item => item.mode === mode && item.kind === 'state' && item.entityKey === input.key)
    if (existing !== undefined) {
      const next: ShortTermItemRecord = {
        ...existing,
        entityValue: input.value,
        summary: input.summary ?? existing.summary,
        relatedTask: input.taskId ?? existing.relatedTask,
        ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
        ...(input.sourceEventId !== undefined ? { lastEventId: input.sourceEventId } : {}),
        weight: Math.min(2, existing.weight + 0.1),
        lastAccess: now,
      }
      await tables.short.put(existing.id, next)
      await this.bumpCounter()
      return next
    }
    const item: ShortTermItemRecord = {
      id: genId('st'),
      mode,
      content: `${input.key}=${input.value}`,
      tags: ['state'],
      weight: 1,
      accessCount: 0,
      createdAt: now,
      lastAccess: now,
      kind: 'state',
      entityKey: input.key,
      entityValue: input.value,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.taskId !== undefined ? { relatedTask: input.taskId } : {}),
      ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
      ...(input.sourceEventId !== undefined ? { lastEventId: input.sourceEventId } : {}),
    }
    await tables.short.put(item.id, item)
    await this.bumpCounter()
    return item
  }

  /**
   * Append one event (kind='event'), append-only. When `idempotencyKey` is set
   * and a success event already exists, returns the existing entry (skipped)
   * instead of writing a duplicate — the anti-rework guard.
   */
  async appendEvent(
    mode: MemoryMode,
    input: {
      action: string
      target?: string | undefined
      before?: string | undefined
      after?: string | undefined
      idempotencyKey?: string | undefined
      taskId?: string | undefined
      summary?: string | undefined
      status?: 'pending' | 'success' | 'failed' | undefined
    },
  ): Promise<{ item: ShortTermItemRecord; skipped: boolean }> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const status = input.status ?? 'success'
    if (input.idempotencyKey !== undefined) {
      const existing = this.checkIdempotent(mode, input.idempotencyKey)
      if (existing !== undefined) return { item: existing, skipped: true }
    }
    const parts = [input.action, input.target].filter(Boolean)
    const item: ShortTermItemRecord = {
      id: genId('st'),
      mode,
      content: parts.join(' → '),
      tags: ['event', ...(input.taskId !== undefined ? [input.taskId] : [])],
      weight: 1,
      accessCount: 0,
      createdAt: now,
      lastAccess: now,
      kind: 'event',
      ...(input.target !== undefined ? { entityKey: input.target } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      eventStatus: status,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.taskId !== undefined ? { relatedTask: input.taskId } : {}),
    }
    await tables.short.put(item.id, item)
    await this.bumpCounter()
    return { item, skipped: false }
  }

  /** Look up a success event by idempotency key (anti-rework). */
  checkIdempotent(mode: MemoryMode, idempotencyKey: string): ShortTermItemRecord | undefined {
    return [...this.requireTables().short.entries()]
      .map(([, item]) => item)
      .find(item => item.mode === mode && item.kind === 'event' && item.idempotencyKey === idempotencyKey && item.eventStatus === 'success')
  }

  /**
   * Upsert one task-context entry (kind='task'). Structured fields carry the
   * task's goal / phase / pending / completed / blocked state; `content` is the
   * rendered projection the model reads (no JSON parsing on the hot path).
   */
  async updateTaskContext(
    mode: MemoryMode,
    taskId: string,
    patch: {
      goal?: string | undefined
      phase?: string | undefined
      pending?: string[] | undefined
      completed?: string[] | undefined
      blockedBy?: string[] | undefined
    } = {},
  ): Promise<ShortTermItemRecord> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const existing = [...tables.short.entries()]
      .map(([, item]) => item)
      .find(item => item.mode === mode && item.kind === 'task' && item.entityKey === taskId)
    const base: ShortTermItemRecord = existing ?? {
      id: genId('st'),
      mode,
      content: '',
      tags: ['task-context'],
      weight: 1,
      accessCount: 0,
      createdAt: now,
      lastAccess: now,
      kind: 'task',
      entityKey: taskId,
      entityValue: '',
      phase: '',
      summary: '',
    }
    const goal = patch.goal ?? base.entityValue ?? ''
    const phase = patch.phase ?? base.phase ?? ''
    const pending = patch.pending ?? []
    const completed = patch.completed ?? []
    const blockedBy = patch.blockedBy ?? []
    const lines = [`目标：${goal || '未定'}`]
    if (phase) lines.push(`阶段：${phase}`)
    if (pending.length > 0) lines.push(`待办：${pending.join('、')}`)
    if (completed.length > 0) lines.push(`已完成：${completed.join('、')}`)
    if (blockedBy.length > 0) lines.push(`阻塞：${blockedBy.join('、')}`)
    const next: ShortTermItemRecord = {
      ...base,
      content: lines.join(' | '),
      entityValue: goal,
      ...(phase !== '' ? { phase } : {}),
      summary: `待办 ${pending.length} 项${blockedBy.length > 0 ? ` / 阻塞 ${blockedBy.length}` : ''}`,
      weight: Math.min(2, base.weight + 0.1),
      lastAccess: now,
    }
    await tables.short.put(base.id, next)
    await this.bumpCounter()
    return next
  }

  /** Bump the reference counter of one short-term item (feedback loop). */
  async bumpShortRefCount(id: string, delta = 1): Promise<ShortTermItemRecord | undefined> {
    const tables = this.requireTables()
    const existing = tables.short.get(id)
    if (existing === undefined) return undefined
    const next: ShortTermItemRecord = {
      ...existing,
      refCount: (existing.refCount ?? 0) + delta,
      // 被引用是"重要"信号：提权幅度小于重复写入（0.05 vs 0.3），避免互相踩
      weight: Math.min(2, existing.weight + 0.05 * delta),
      lastAccess: new Date().toISOString(),
    }
    await tables.short.put(id, next)
    await this.bumpCounter()
    return next
  }

  /** Bump the reference counter of one public memory (feedback loop). */
  async bumpPublicRefCount(memoryId: MemoryId, delta = 1): Promise<PublicMemoryRecord | undefined> {
    const tables = this.requireTables()
    const existing = tables.public.get(memoryId)
    if (existing === undefined) return undefined
    const next: PublicMemoryRecord = { ...existing, refCount: (existing.refCount ?? 0) + delta }
    await tables.public.put(memoryId, next)
    await this.bumpCounter()
    return next
  }

  // ─── permanent profile (user portrait) ──────────────────────────────────

  /** Load the permanent profile for one mode, defaulting to an empty portrait. */
  getPermanent(mode: MemoryMode): PermanentProfileRecord {
    const tables = this.requireTables()
    return tables.permanent.get(mode) ?? { attributes: {}, preferences: {}, skills: [], relationships: [], sources: {} }
  }

  /** Set one permanent profile field, supporting dotted paths and entity append. */
  async setPermanent(mode: MemoryMode, pathStr: string, value: unknown): Promise<PermanentProfileRecord> {
    const tables = this.requireTables()
    const profile = this.getPermanent(mode)
    const parts = pathStr.split('.')
    let obj: Record<string, unknown> = profile as unknown as Record<string, unknown>
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i] as string
      const next = obj[key]
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        obj[key] = {}
      }
      obj = obj[key] as Record<string, unknown>
    }
    const lastKey = parts[parts.length - 1] as string
    const isEntity = lastKey === 'skills' || lastKey === 'relationships' || lastKey === 'preferences'
      || Array.isArray(value)
    if (isEntity) {
      const current = obj[lastKey]
      if (!Array.isArray(current)) obj[lastKey] = []
      const list = obj[lastKey] as unknown[]
      if (Array.isArray(value)) {
        for (const v of value) {
          if (!list.includes(v)) list.push(v)
        }
      } else if (!list.includes(value)) {
        list.push(value)
      }
    } else {
      obj[lastKey] = value
    }
    // v2：记录字段来源与时间戳（覆盖不丢历史；sources 保留最近 2 次旧值链）
    const nowIso = new Date().toISOString()
    const sources = (profile.sources ?? {}) as Record<string, unknown>
    const prev = sources[pathStr]
    const sourceEntry: Record<string, unknown> = { value, updatedAt: nowIso, source: 'tool' }
    if (prev !== undefined) {
      const prevRec = prev as Record<string, unknown>
      sourceEntry.prev = Array.isArray(prevRec.prev)
        ? [prevRec, ...(prevRec.prev as unknown[])].slice(0, 2)
        : [prevRec]
    }
    sources[pathStr] = sourceEntry
    profile.sources = sources
    await tables.permanent.put(mode, profile)
    await this.bumpCounter()
    return profile
  }

  // ─── portable docs (per-session working memory) ─────────────────────────

  /** Load one portable doc, or `undefined` when absent. */
  getPortableDoc(sessionId: SessionId): PortableDocRecord | undefined {
    return this.requireTables().portable.get(String(sessionId))
  }

  /** Record one exchange into a session's portable doc, creating it on demand. */
  async recordExchange(
    sessionId: SessionId,
    userInput: string,
    analysis: { solved?: string[] | undefined; unresolved?: string[] | undefined; refinedGoal?: string | undefined; tags?: string[] | undefined } = {},
  ): Promise<PortableDocRecord> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const existing = this.getPortableDoc(sessionId)
    const doc: PortableDocRecord = existing ?? {
      sessionId,
      title: '新建对话',
      mode: 'daily',
      goal: '',
      exchangeCount: 0,
      solvedProblems: [],
      unresolvedProblems: [],
      progress: [],
      result: '',
      nextSteps: [],
      summary: '',
      tags: [],
      log: [],
    }
    doc.exchangeCount += 1
    doc.log = [...doc.log, { turn: doc.exchangeCount, user: userInput.slice(0, 200), time: now }]
    if (analysis.solved) {
      for (const s of analysis.solved) {
        if (!doc.solvedProblems.includes(s)) doc.solvedProblems.push(s)
      }
    }
    if (analysis.unresolved) {
      for (const u of analysis.unresolved) {
        if (!doc.unresolvedProblems.includes(u)) doc.unresolvedProblems.push(u)
      }
    }
    if (analysis.refinedGoal) doc.goal = analysis.refinedGoal
    if (analysis.tags) {
      for (const t of analysis.tags) {
        if (!doc.tags.includes(t)) doc.tags.push(t)
      }
    }
    doc.summary = `第${doc.exchangeCount}次交换 | 目标：${doc.goal || '无明确目标'}`
      + ` | 已解决：${doc.solvedProblems.join('、') || '无'}`
      + ` | 待解决：${doc.unresolvedProblems.join('、') || '无'}`
    await tables.portable.put(String(sessionId), doc)
    await this.bumpCounter()
    return doc
  }

  /** List every portable doc, newest first. */
  listPortableDocs(): PortableDocRecord[] {
    const tables = this.requireTables()
    return [...tables.portable.entries()]
      .map(([, doc]) => doc)
      .sort((a, b) => (a.exchangeCount < b.exchangeCount ? 1 : -1))
  }

  /**
   * Deliberate notebook update (the model's scratchboard). Unlike
   * {@link recordExchange}, this is model-initiated at key moments (set goal,
   * log progress, record an issue, close one, state the result/next steps),
   * not an automatic per-message append. Array fields append-and-dedup except
   * `nextSteps`, which replaces; scalar fields replace when provided.
   */
  async updateNotebook(
    sessionId: SessionId,
    patch: {
      title?: string | undefined
      goal?: string | undefined
      progress?: string[] | undefined
      issues?: string[] | undefined
      solved?: string[] | undefined
      result?: string | undefined
      nextSteps?: string[] | undefined
      tags?: string[] | undefined
    },
  ): Promise<PortableDocRecord> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const existing = this.getPortableDoc(sessionId)
    const doc: PortableDocRecord = existing ?? {
      sessionId,
      title: '新建对话',
      mode: 'daily',
      goal: '',
      exchangeCount: 0,
      solvedProblems: [],
      unresolvedProblems: [],
      progress: [],
      result: '',
      nextSteps: [],
      summary: '',
      tags: [],
      log: [],
    }
    if (typeof patch.title === 'string' && patch.title.trim() !== '') doc.title = patch.title.trim()
    if (typeof patch.goal === 'string' && patch.goal.trim() !== '') doc.goal = patch.goal.trim()
    if (typeof patch.result === 'string') doc.result = patch.result.trim()
    if (Array.isArray(patch.nextSteps)) doc.nextSteps = patch.nextSteps.map(s => s.trim()).filter(Boolean)
    const appendUnique = (target: string[], incoming: string[] | undefined): void => {
      if (!Array.isArray(incoming)) return
      for (const raw of incoming) {
        const item = String(raw ?? '').trim()
        if (item !== '' && !target.includes(item)) target.push(item)
      }
    }
    appendUnique(doc.progress, patch.progress)
    appendUnique(doc.tags, patch.tags)
    appendUnique(doc.unresolvedProblems, patch.issues)
    if (Array.isArray(patch.solved)) {
      appendUnique(doc.solvedProblems, patch.solved)
      const closed = new Set(patch.solved.map(s => String(s ?? '').trim()).filter(Boolean))
      if (closed.size > 0) {
        doc.unresolvedProblems = doc.unresolvedProblems.filter(u => !closed.has(u))
      }
    }
    doc.exchangeCount += 1
    doc.log = [...doc.log, { turn: doc.exchangeCount, user: '[小黑板更新]', time: now }]
    doc.summary = `第${doc.exchangeCount}次更新 | 目标：${doc.goal || '无明确目标'}`
      + ` | 进展：${doc.progress.length} 项 | 待解决：${doc.unresolvedProblems.join('、') || '无'}`
    await tables.portable.put(String(sessionId), doc)
    await this.bumpCounter()
    return doc
  }

  // ─── agent evolution ────────────────────────────────────────────────────

  /** Append one agent evolution record. */
  async appendEvolution(record: AgentEvolutionRecord): Promise<AgentEvolutionRecord> {
    const tables = this.requireTables()
    const stamped: AgentEvolutionRecord = {
      ...record,
      timestamp: record.timestamp ?? new Date().toISOString(),
    }
    await tables.evolution.put(stamped.id as RecordId, stamped)
    await this.bumpCounter()
    return stamped
  }

  /** List evolution records of one type, newest first. */
  listEvolution(type: string): AgentEvolutionRecord[] {
    const tables = this.requireTables()
    return [...tables.evolution.entries()]
      .map(([, record]) => record)
      .filter(record => record.type === type)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  }

  /** List every evolution record across types, newest first. */
  listAllEvolution(): AgentEvolutionRecord[] {
    const tables = this.requireTables()
    return [...tables.evolution.entries()]
      .map(([, record]) => record)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  }

  /** Total recorded memory writes across all subsystems. */
  get memoryCount(): number {
    return this.domain?.global.get().memoryCount ?? 0
  }

  /** Timestamp of the last memory write, absent when no write has occurred. */
  get lastWriteAt(): string | undefined {
    return this.domain?.global.get().lastWriteAt
  }

  /** Whether the memory snapshot is injected as prompt context. */
  get injectContext(): boolean {
    return this.domain?.global.get().injectContext ?? true
  }

  /** Persist the prompt-context injection toggle. */
  async setInjectContext(value: boolean): Promise<void> {
    const global = this.domain?.global
    if (global === undefined) return
    const state: MemoryDomainState = { ...global.get(), injectContext: value }
    await global.set(state)
  }

  // ─── management (settings surface) ───────────────────────────────────────

  /** Delete one public memory by id. */
  async deletePublicMemory(id: MemoryId): Promise<boolean> {
    const tables = this.requireTables()
    const existed = tables.public.get(id) !== undefined
    if (existed) await tables.public.delete(id)
    return existed
  }

  /** Update one public memory by id; absent fields keep their stored values. */
  async updatePublicMemory(
    id: MemoryId,
    patch: Partial<Omit<PublicMemoryRecord, 'memory_id' | 'mode' | 'date' | 'time'>>,
  ): Promise<PublicMemoryRecord | undefined> {
    const tables = this.requireTables()
    const existing = tables.public.get(id)
    if (existing === undefined) return undefined
    const next: PublicMemoryRecord = { ...existing, ...patch }
    await tables.public.put(id, next)
    await this.bumpCounter()
    return next
  }

  /** Delete one short-term item by id. */
  async deleteShortTerm(id: string): Promise<boolean> {
    const tables = this.requireTables()
    const existed = tables.short.get(id) !== undefined
    if (existed) await tables.short.delete(id)
    return existed
  }

  /** Update one short-term item by id; absent fields keep their stored values. */
  async updateShortTerm(
    id: string,
    patch: Partial<Omit<ShortTermItemRecord, 'id' | 'mode' | 'createdAt'>>,
  ): Promise<ShortTermItemRecord | undefined> {
    const tables = this.requireTables()
    const existing = tables.short.get(id)
    if (existing === undefined) return undefined
    const next: ShortTermItemRecord = { ...existing, ...patch }
    await tables.short.put(id, next)
    await this.bumpCounter()
    return next
  }

  /** Delete one portable doc by session id. */
  async deletePortableDoc(sessionId: SessionId): Promise<boolean> {
    const tables = this.requireTables()
    const key = String(sessionId)
    const existed = tables.portable.get(key) !== undefined
    if (existed) await tables.portable.delete(key)
    return existed
  }

  /** Update one portable doc by session id; absent fields keep their stored values. */
  async updatePortableDoc(
    sessionId: SessionId,
    patch: Partial<Omit<PortableDocRecord, 'sessionId' | 'exchangeCount' | 'log'>>,
  ): Promise<PortableDocRecord | undefined> {
    const tables = this.requireTables()
    const key = String(sessionId)
    const existing = tables.portable.get(key)
    if (existing === undefined) return undefined
    const next: PortableDocRecord = { ...existing, ...patch }
    await tables.portable.put(key, next)
    await this.bumpCounter()
    return next
  }

  /** Delete one evolution record by id. */
  async deleteEvolution(id: RecordId): Promise<boolean> {
    const tables = this.requireTables()
    const existed = tables.evolution.get(id) !== undefined
    if (existed) await tables.evolution.delete(id)
    return existed
  }

  /** Update one evolution record by id; absent fields keep their stored values. */
  async updateEvolution(id: RecordId, patch: Partial<AgentEvolutionRecord>): Promise<AgentEvolutionRecord | undefined> {
    const tables = this.requireTables()
    const existing = tables.evolution.get(id)
    if (existing === undefined) return undefined
    const next: AgentEvolutionRecord = { ...existing, ...patch }
    await tables.evolution.put(id, next)
    await this.bumpCounter()
    return next
  }

  /** Replace one permanent profile wholesale. */
  async replacePermanent(mode: MemoryMode, profile: PermanentProfileRecord): Promise<PermanentProfileRecord> {
    const tables = this.requireTables()
    await tables.permanent.put(mode, profile)
    await this.bumpCounter()
    return profile
  }

  private async bumpCounter(): Promise<void> {
    const global = this.domain?.global
    if (global === undefined) return
    const state: MemoryDomainState = { ...global.get(), memoryCount: global.get().memoryCount + 1, lastWriteAt: new Date().toISOString() }
    await global.set(state)
  }
}

/** All supported memory modes. */
export const MEMORY_MODES: readonly MemoryMode[] = MODES