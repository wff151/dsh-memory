/**
 * The dsh-memory domain declaration: record schemas and the `defineDomain`
 * spec the memory store opens. The zod schemas are the durable-boundary
 * validators; the spec object is the single source of the domain's identity,
 * version, and layout.
 * @module dsh-memory/src/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryId, RecordId, SessionId } from './types.ts'

/** Memory id schema at the durable boundary; branding has no runtime representation. */
const memoryId = z.string().transform(value => value as MemoryId)

/** Evolution record id schema. */
const recordId = z.string().transform(value => value as RecordId)

/** Session id schema. */
const sessionId = z.string().transform(value => value as SessionId)

/** Memory mode: daily (personal) or work (professional). */
const memoryMode = z.enum(['daily', 'work'])

/** One public memory entry (long-term, dated, tagged). */
export const publicMemorySchema = z.object({
  memory_id: memoryId,
  mode: memoryMode,
  date: z.string(),
  time: z.string(),
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()).default([]),
  goal: z.string().default(''),
  unresolved: z.array(z.string()).default([]),
  result: z.string().default(''),
  source: z.string().default('manual'),
  /** 关联任务 id（同一任务的多次记录可聚合，v2 可选）。 */
  taskId: z.string().optional(),
  /** 所属任务阶段（v2 可选）。 */
  taskPhase: z.string().optional(),
  /** 被检索/被引用计数（反馈回路：命中提权，v2 可选）。 */
  refCount: z.number().optional(),
  /**
   * **详细文档**（v4 新增）：真正回忆时的依据。
   *
   * 与 `summary` 的分工：
   *   · `summary` = **索引**。检索结果里显示的短摘要，用来快速判断
   *     「这条是不是我要找的」，决定值不值得翻详情。短、便宜。
   *   · `detail`  = **正文**。按时间线排列的事实条目
   *     （xx 事件 → 做了 xx → 下一时间点又做 xx），保留原文措辞。
   *
   * 缺省为空：老的记忆条目没有详情，检索时只显示 summary。
   * 详情只在**长期归档**那一刻生成（低频），不进每轮上下文。
   */
  detail: z.string().optional(),
  /**
   * **关系边**（v5 新增）：这条记忆指向的其它实体，以及是什么关系。
   *
   * 存在的原因：实测有 10% 的检索失败是**跨实体推理**——
   * 「他喜欢的那个姑娘是谁」应该命中「田晓霞」，但代词消解只能指向
   * 「话题这个人」（孙少平），指不到「话题的关系人」。
   * 有了这条边，检索可以从「孙少平」跳到「田晓霞」。
   *
   * 例：`[{ relation: '爱慕', target: '田晓霞' }]`
   *
   * 可选字段：不给也能用（退回当前的 90%），给了能多救那 10%。
   */
  relatedTo: z
    .array(
      z.object({
        /** 关系类型：爱慕 / 兄弟 / 父子 / 夫妻 / 仇敌 / 上下级 … */
        relation: z.string(),
        /** 目标实体名（另一个条目的 title 或人名）。 */
        target: z.string(),
      }),
    )
    .optional(),
  /**
   * **条目类型**（v6 新增）：人物 / 地点 / 事件。
   *
   * 存在的原因：实测问「那个在煤矿下井的年轻人是谁」时，
   * "煤矿"这个词同时命中人物、地点、事件三条，分不出主次（不含名问法 top1 只有 53%）。
   * 有了类型，就能先判提问意图（谁/哪/什么），再收窄候选。
   *
   * 缺省不填：老条目没有类型，检索时不收窄（退回当前行为）。
   */
  kind: z.enum(['person', 'place', 'event', 'unknown']).optional(),
})

/** One short-term memory item (weighted, decaying). */
export const shortTermItemSchema = z.object({
  id: z.string(),
  mode: memoryMode,
  content: z.string(),
  tags: z.array(z.string()).default([]),
  weight: z.number().default(1),
  accessCount: z.number().default(0),
  createdAt: z.string(),
  lastAccess: z.string(),
  // ── v2 可选字段（全部 optional，旧数据向后兼容）──
  /** 条目类型：fact 事实 / state 当前状态 / event 变更事件 / task 任务上下文。缺省视为 fact。 */
  /**
   * 条目类型：fact 事实 / state 当前状态 / event 变更事件 / task 任务上下文 /
   * relation 人物关系（谁→关系→谁，如小说人物关系网，随书淡忘）。
   * 缺省视为 fact。
   */
  kind: z.enum(['fact', 'state', 'event', 'task', 'relation']).optional(),
  /** kind=state: 状态键（如 beans_stock）；kind=task: 任务 id。 */
  entityKey: z.string().optional(),
  /** kind=state: 当前值描述（渲染投影用）；kind=task: 当前目标 goal。 */
  entityValue: z.string().optional(),
  /** kind=event: 幂等键（task_id + action + target + 参数归一化 hash）。 */
  idempotencyKey: z.string().optional(),
  /** kind=event: 执行状态 pending/success/failed。 */
  eventStatus: z.enum(['pending', 'success', 'failed']).optional(),
  /** 阶段标签 / 阶段摘要标签（阶段折叠用）。 */
  phase: z.string().optional(),
  /** 简洁摘要（事件摘要 / 任务待办摘要）。 */
  summary: z.string().optional(),
  /** 关联任务 id。 */
  relatedTask: z.string().optional(),
  /** 被检索/被引用计数（反馈回路，v2）。 */
  refCount: z.number().optional(),
  /** kind=state: 最后一次来源事件的 id（版本链）。 */
  lastEventId: z.string().optional(),
  /** kind=state: 有效期（小时），过期视为失效状态。 */
  ttlHours: z.number().optional(),
  // ── v3：归属与标题（谁写的 / 哪个会话 / 叫什么）──
  /** 谁写的：user = 用户说的；agent = 模型写的；缺省按 user。 */
  by: z.enum(['user', 'agent']).optional(),
  /** 写入时所属会话。多 agent 并行时用于隔离，不填表示全局。 */
  sessionId: z.string().optional(),
  /** 标题，如「xx项目 · xx问题」。投影与检索展示用。 */
  title: z.string().optional(),
})

/** Permanent user profile (user portrait). */
export const permanentProfileSchema = z.object({
  attributes: z.record(z.string(), z.unknown()).default({}),
  preferences: z.record(z.string(), z.unknown()).default({}),
  skills: z.array(z.string()).default([]),
  /**
   * 人际关系网（用户画像）。
   *
   * v6 起支持**结构化**条目 `{ from, relation, to, note? }`，
   * 同时保留旧的扁平字符串（`"妈妈"`）以向后兼容。
   *
   * 与小说人物关系的分工：
   *   · 这里 = **用户**的家人/朋友/同事，**永久保留**，不衰减
   *   · 小说人物关系 = 短期记忆（`short`，tag `relation`），**随书淡忘**
   */
  relationships: z.array(z.union([
    z.string(),
    z.object({
      /** 关系主体（用户自己可写 `我`）。 */
      from: z.string(),
      /** 关系类型：母亲 / 朋友 / 同事 / 上司 … */
      relation: z.string(),
      /** 关系对象。 */
      to: z.string(),
      /** 可选的补充说明。 */
      note: z.string().optional(),
    }),
  ])).default([]),
  /**
   * v2：画像字段的来源与时间戳（覆盖不丢历史）。
   * 形如 { "preferences.喜欢": { value, updatedAt, sourceSession?, source: 'tool'|'auto' } }。
   * 覆盖旧值时保留上一次来源记录在 sources 里（最多保留最近 3 条）。
   */
  sources: z.record(z.string(), z.unknown()).default({}),
})

/** One portable document (per-session working memory). */
export const portableDocSchema = z.object({
  sessionId,
  title: z.string(),
  mode: memoryMode,
  goal: z.string().default(''),
  exchangeCount: z.number().default(0),
  solvedProblems: z.array(z.string()).default([]),
  unresolvedProblems: z.array(z.string()).default([]),
  /** Milestone progress lines (the notebook running log of what got done). */
  progress: z.array(z.string()).default([]),
  /** Result summary once the task reaches a conclusion. */
  result: z.string().default(''),
  /** What to do next, as decided at the latest notebook update. */
  nextSteps: z.array(z.string()).default([]),
  summary: z.string().default(''),
  tags: z.array(z.string()).default([]),
  log: z.array(z.object({
    turn: z.number(),
    user: z.string(),
    time: z.string(),
  })).default([]),
})

/** One agent evolution record (error log, proposal, rule, etc.). */
export const agentEvolutionSchema = z.object({
  /**
   * self = agent 的自我记忆（自我认知 / 偏好 / 教训），与用户画像对立的一块空间。
   * 命名沿用设计草稿：`日期_主体_主题`。
   */
  type: z.enum(['error-log', 'proposal', 'shadow-test', 'rule', 'reflection', 'self']),
  id: recordId,
  timestamp: z.string(),
}).passthrough()

/** Memory domain global state. */
export const memoryDomainStateSchema = z.object({
  memoryCount: z.number().default(0),
  lastWriteAt: z.string().optional(),
  /** Whether the memory snapshot is injected as prompt context (runtime toggle). */
  injectContext: z.boolean().default(true),
})

/** The memory domain spec: one table per memory subsystem plus a write counter. */
const initialGlobalState: MemoryDomainState = { memoryCount: 0, injectContext: true }

export const memoryDomainSpec = defineDomain({
  name: 'brain_memory',
  version: 1,
  global: {
    schema: memoryDomainStateSchema,
    initial: initialGlobalState,
  },
  tables: {
    public: domainTable<MemoryId, z.infer<typeof publicMemorySchema>>(publicMemorySchema),
    short: domainTable<string, z.infer<typeof shortTermItemSchema>>(shortTermItemSchema),
    permanent: domainTable<string, z.infer<typeof permanentProfileSchema>>(permanentProfileSchema),
    portable: domainTable<string, z.infer<typeof portableDocSchema>>(portableDocSchema),
    evolution: domainTable<RecordId, z.infer<typeof agentEvolutionSchema>>(agentEvolutionSchema),
  },
})

/**
 * One embedding vector indexed for a single public memory. Kept in a separate
 * domain so the semantic layer is purely additive: turning embeddings off (or
 * deleting the vector domain) never touches the durable memory records.
 */
export const vectorIndexSchema = z.object({
  /** Public memory id this vector was built from. */
  memory_id: memoryId,
  /** Embedding model that produced the vector (a model switch forces a rebuild). */
  model: z.string(),
  /** Content hash; when the source text changes the entry is re-embedded. */
  hash: z.string(),
  /** Dense embedding (dimension depends on the model). */
  vector: z.array(z.number()),
})

/** Dedicated vector domain — additive semantic index, isolated from memory. */
export const vectorDomainSpec = defineDomain({
  name: 'brain_memory_vectors',
  version: 1,
  tables: {
    vectors: domainTable<MemoryId, z.infer<typeof vectorIndexSchema>>(vectorIndexSchema),
  },
})

export type PublicMemoryRecord = z.infer<typeof publicMemorySchema>
export type ShortTermItemRecord = z.infer<typeof shortTermItemSchema>
export type PermanentProfileRecord = z.infer<typeof permanentProfileSchema>
export type PortableDocRecord = z.infer<typeof portableDocSchema>
export type AgentEvolutionRecord = z.infer<typeof agentEvolutionSchema>
export type MemoryDomainState = z.infer<typeof memoryDomainStateSchema>
export type VectorIndexRecord = z.infer<typeof vectorIndexSchema>
