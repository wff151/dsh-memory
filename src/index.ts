/**
 * dsh-memory plugin entry: opens the memory domain, publishes the `memory`
 * service, registers the model-facing memory tools, and injects the memory
 * snapshot as dynamic prompt context.
 *
 * The store is opened during `apply` and closed via `ctx.effect` disposer, so
 * a plugin unmount drains queued writes.
 * @module dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from './store.ts'
import { registerMemoryTools, buildMemoryCapabilities, type BrainCapability } from './tools.ts'
import { registerMemoryContext } from './context.ts'
import { runShortTermDecay } from './decay.ts'
import { autoRecordExchange, autoRecordAnswer, archiveCompactionSummary } from './autorecord.ts'
import { runPeriodicReflection } from './reflection.ts'
import { createEmbeddingClient } from './embedding.ts'
import { VectorStore } from './vector-store.ts'
import { SemanticService } from './semantic.ts'

// The pure payload outlet (./types.ts, ONE home of the memory types) re-exported
// onto the package root keeps the module edge in the emitted index.d.ts, so
// aggregate programs consuming the declarations still receive the types.
export type * from './types.ts'
export {
  publicMemorySchema,
  shortTermItemSchema,
  permanentProfileSchema,
  portableDocSchema,
  agentEvolutionSchema,
  memoryDomainStateSchema,
  memoryDomainSpec,
} from './domain.ts'
export type {
  PublicMemoryRecord,
  ShortTermItemRecord,
  PermanentProfileRecord,
  PortableDocRecord,
} from './domain.ts'
export { MemoryStore } from './store.ts'
export { searchPublicMemory, searchShortTerm, renderRetrievedContext } from './retrieval.ts'
export { renderMemoryContext, renderMemoryHint } from './context.ts'
export {
  docLastActiveMs,
  isResumable,
  selectResumable,
  findResumableSessions,
  renderResumeBrief,
  renderResumeHint,
  RESUME_GUIDANCE,
} from './resume.ts'
export type { ResumableSession, ResumeSelectOptions } from './resume.ts'
export { decayShortTerm, runShortTermDecay } from './decay.ts'
export type { DecayOptions, DecayResult, DecaySummary } from './decay.ts'
export { autoRecordExchange, autoRecordAnswer, archiveCompactionSummary } from './autorecord.ts'
export type { AutoRecordOptions } from './autorecord.ts'
export { renderShortTermProjection, withIdempotency, idempotencyKeyOf } from './state.ts'
export { countErrorFingerprints, maybeCreateProposals } from './evolution.ts'
export type { EscalationOptions, EscalationResult } from './evolution.ts'
export {
  REFLECTION_TEMPLATE,
  collectReflectionMaterial,
  renderReflectionObservation,
  runPeriodicReflection,
} from './reflection.ts'
export type { ReflectionMaterial, ReflectionOptions, PeriodicReflectionResult } from './reflection.ts'
export { createEmbeddingClient, cosineSimilarity, contentHash } from './embedding.ts'
export type { EmbeddingClient, EmbeddingClientConfig } from './embedding.ts'
export { VectorStore } from './vector-store.ts'
export { SemanticService, memoryEmbeddingText } from './semantic.ts'
export type { SemanticOptions, SyncResult } from './semantic.ts'
export { vectorDomainSpec, vectorIndexSchema } from './domain.ts'
export type { VectorIndexRecord } from './domain.ts'
export {
  searchPublicMemoryVector,
  renderRetrievedContextAsync,
} from './retrieval.ts'
export {
  BUDGET_PROFILES,
  inferImportance,
  estimateTokens,
  resolveBudget,
  searchWithBudget,
  renderBudgetedContext,
  renderRetrievedContextBudgeted,
} from './budget.ts'
export type {
  Importance,
  ImportanceInput,
  SignalGates,
  RetrievalBudget,
  BudgetPass,
  BudgetSearchResult,
  BudgetSearchOptions,
} from './budget.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    brainMemory: MemoryFacility
  }
}

/**
 * Cordis plugin name used by loader diagnostics.
 *
 * 注意：包名已经改成 `dsh-memory`（见 package.json），但这里**故意保留旧名**。
 * 它在 profile 里曾作为 `- id:` 出现过（现在已注释），改名有破坏挂载的风险，
 * 而收益只是"看起来一致"。加载器诊断里看到 `dsh-brain-memory` 是正常的。
 */
export const name = 'dsh-brain-memory'

/** Services required before the plugin can activate. */
export const inject = ['storageDomain', 'tools']

/** Plugin configuration. */
export interface Config {
  /**
   * How brain abilities are exposed to the model.
   * - `dispatcher` (default): no `brain_memory_*` tools are registered. The
   *   separate dsh-brain-dispatch plugin exposes a single lightweight `brain`
   *   tool and routes `action` → capability, collapsing the per-request tool
   *   schema tax. Capabilities still live on `ctx.brainMemory.capabilities`.
   * - `native`: register every ability as its own full-schema `brain_memory_*`
   *   tool (the original surface; use as the opt-in fallback).
   */
  toolMode?: 'dispatcher' | 'native'
  /**
   * Whether the memory snapshot is injected as a dynamic prompt context.
   * Volatile: read per assembly, editable from the Plugins page without a remount.
   */
  injectContext: Volatile<boolean>
  /**
   * Brand-new session resume nudge (semantic checkpoint across sessions):
   * when the current session has no portable doc but other sessions still
   * have unresolved tasks, inject one non-interrupting line pointing at the
   * read-only `brain_memory_resume` tool. Guides; never auto-starts or replays.
   * Default true; set false to silence. Volatile: read per assembly.
   */
  resumeHint: Volatile<boolean>
  /**
   * Short-term memory decay interval in hours (0 disables the periodic pass).
   * Default 6. The decay itself lives in ./decay.ts (port of the memory-system
   * prototype decay.js): time-exponential weight decay + archival to public
   * memory.
   */
  decayIntervalHours?: number
  /**
   * Periodic reflection interval in hours (0 disables the scheduled loop).
   * Default 24 (one reflection/day). The loop lives in ./reflection.ts: pull
   * recent memories / errors / proposals, distill deterministic patterns, and
   * append a periodic reflection record (idempotent per day).
   */
  reflectionIntervalHours?: number
  /**
   * 每个 mode 保留的短期记忆**条数上限**，默认 2000。
   *
   * 衰减只按权重清、不按条数清；而 `autoRecordShort` + `autoRecordAnswer`
   * 每轮至少写 2 条，实测一天能到 143–311 条 → 库会无限增长（实测 611 条）。
   *
   * **它不占每步上下文**（投影固定只取几条），影响的是：
   *   · 检索要遍历的条数
   *   · 特征索引覆盖（索引只取前 300 条，超出的拿不到特征加成）
   *
   * 超限清理顺序：权重最低的先走，同权重最老的先走。置 0 表示不限制。
   */
  shortMaxItems?: number
  /**
   * 短期记忆占用上下文的上限**百分比**，默认 15。
   *
   * 与 `shortMaxItems` 是**两个独立触发条件，谁先满足谁生效**：
   *   · `shortMaxItems` —— 条数上限（固定）
   *   · `shortContextSharePercent` —— 按上下文窗口比例算（随模型自适应）
   *
   * 为什么要有第二条：`2000 条` 在 1M 窗口的模型上永远不触发，
   * 但在 32k 窗口上可能早就太大了。
   *
   * 口径：算的是「短期库**全部条目**的估算 token ÷ 上下文窗口」。
   * 不用"每步投影"是因为投影是固定值（只取几条），**永远不会超标**。
   *
   * 窗口大小取不到时这条触发自动跳过（不会误触发）。
   * 置 0 关闭。
   */
  shortContextSharePercent?: number

  // ── 自动落库（每条用户消息写哪几层）───────────────────────────────
  //
  // 原本是嵌套的 `autoRecord: { short, long, portable }`。已**拍平到顶层**：
  // 宿主的设置表单（SettingsFormModel）只能寻址单层字段
  // （`sectionValue(field) === snapshot.value?.[field]`），嵌套对象在设置页上
  // 无法逐项开关。拍平后每一项都能单独调。
  /** 每条用户消息写入短期记忆。 */
  autoRecordShort?: boolean
  /** 每条用户消息写入长期记忆（带去重与长度门槛）。 */
  autoRecordLong?: boolean
  /** 每条用户消息追加到会话小黑板（v3 起默认关，改为 brain note 主动更新）。 */
  autoRecordPortable?: boolean
  /**
   * 是否把**助手回答**也落进短期记忆（默认开）。
   *
   * 用户的话是需求与事实，助手的话是结论与产出；两者检索用途不同，所以
   * 用 `by: 'agent'` 标记区分。截断比用户消息更短（240 字），否则单条长回答
   * 会把短期库撑满。
   */
  autoRecordAnswer?: boolean
  /**
   * 是否把**上下文压缩**产生的摘要归档进长期记忆（默认开）。
   *
   * 宿主的 compaction 在上下文约 80% 时压掉旧历史并生成摘要，但那份摘要只留在
   * 会话日志里。开启后它会被写进长期公共记忆（`source: 'compaction'`），
   * 压缩掉的内容之后仍可检索回来——从"扔掉"变成"卸载到仓库"。
   */
  compactionArchive?: boolean

  // ── 向量检索（可选；关掉则走关键词兜底）─────────────────────────
  //
  // 原本是嵌套的 `embedding: {...}`，同样为设置页拍平到顶层。
  /** 是否启用真向量语义检索。关闭时透明回退到关键词/bigram。 */
  embeddingEnabled?: boolean
  /** OpenAI 兼容的 API base，含 `/v1`（LM Studio 默认 1234；llama.cpp 也可）。 */
  embeddingBaseURL?: string
  /** 嵌入模型名。 */
  embeddingModel?: string
  /** API key（本地服务通常留空）。 */
  embeddingApiKey?: string
  /** 单次请求超时（毫秒）。 */
  embeddingTimeoutMs?: number
  /** 余弦相似度命中下限。 */
  embeddingMinScore?: number
  /** 建索引时每次请求塞几条文本。 */
  embeddingBatchSize?: number
  /**
   * 查询侧任务前缀（默认空）。
   *
   * nomic-embed-text 要求 `search_query:`；不加前缀时查询与文档被当成同一种输入，
   * 相似度分不开（实测分离度 -0.0024，加了之后 +0.0290）。
   */
  embeddingQueryPrefix?: string
  /** 文档侧任务前缀（与 query 前缀配对；nomic 用 `search_document:`）。 */
  embeddingDocumentPrefix?: string
  /**
   * 服务不可用后的退避时间（毫秒，默认 10000）。
   *
   * 用"按需起服务"的用法时，这个值决定"服务起来后多久能被认到"。
   * 原默认 60 秒对"用时开、用完关"太慢；10 秒足够且不会频繁打空。
   */
  embeddingCooldownMs?: number
  /**
   * 摘要长度档位（默认 `long`）。
   *
   * `long`（120–160 字）：摘要自己能看懂，带实质内容。
   * `short`（≤60 字）：只取首句当索引，**上下文开销约省一半**，
   *   但可能丢掉关键信息（实测「抗洪牺牲」那种后置细节会丢）。
   *
   * 实测权衡见 README §4 与 `_docs/summary-length-report.md`。
   */
  summaryLength?: 'long' | 'short'
}

/**
 * Schemastery validation for {@link Config}.
 *
 * Every field is `volatile()` so the settings page can change it live — no
 * remount, no restart. (Previously only injectContext / resumeHint were, which
 * meant the rest needed a reload to take effect.)
 */
export const Config: z<Config> = z.object({
  toolMode: z.union([z.const('dispatcher'), z.const('native')]).default('dispatcher'),
  injectContext: z.boolean().default(true).volatile(),
  resumeHint: z.boolean().default(true).volatile(),
  decayIntervalHours: z.number().default(6).volatile(),
  reflectionIntervalHours: z.number().default(24).volatile(),
  shortMaxItems: z.number().default(2000).volatile(),
  shortContextSharePercent: z.number().default(15).volatile(),

  // 拍平后的自动落库开关（原 autoRecord.*）
  autoRecordShort: z.boolean().default(true).volatile(),
  autoRecordLong: z.boolean().default(true).volatile(),
  // 小黑板改为模型在关键时刻用 brain note 更新，不逐条追加。
  autoRecordPortable: z.boolean().default(false).volatile(),
  // 助手回答也落短期（by: 'agent'，截 240 字）。
  autoRecordAnswer: z.boolean().default(true).volatile(),
  // 压缩摘要归档进长期（source: 'compaction'）。
  compactionArchive: z.boolean().default(true).volatile(),

  // 拍平后的向量检索项（原 embedding.*）
  //
  // **默认关闭**：需要单独起一个 embedding 服务（llama.cpp / LM Studio）。
  // 默认 true 的话，新用户装完就挂着一个连不上的服务，每 10 秒探测一次。
  // 想用的人自己在设置页打开——这也符合"用的时候再开"的用法。
  embeddingEnabled: z.boolean().default(false).volatile(),
  embeddingBaseURL: z.string().default('http://127.0.0.1:1234/v1').volatile(),
  embeddingModel: z.string().default('text-embedding-nomic-embed-text-v1.5').volatile(),
  embeddingApiKey: z.string().default('').volatile(),
  embeddingTimeoutMs: z.number().default(5000).volatile(),
  // **默认 0.55 而不是 0.3**：0.3 会把大量无关条目放进结果。
  // nomic 实测：相关中位 0.666 / 无关中位 0.616 —— 阈值要落在这之间。
  // 换模型时不同尺度不同，需要按实测调（见 README §5）。
  embeddingMinScore: z.number().default(0.55).volatile(),
  embeddingBatchSize: z.number().default(16).volatile(),
  embeddingQueryPrefix: z.string().default('').volatile(),
  embeddingDocumentPrefix: z.string().default('').volatile(),
  embeddingCooldownMs: z.number().default(10000).volatile(),
  summaryLength: z.union([z.const('long'), z.const('short')]).default('long').volatile(),
})

/** Resolved defaults. */
export interface ResolvedConfig {
  toolMode: 'dispatcher' | 'native'
  injectContext: boolean
  resumeHint: boolean
  decayIntervalHours: number
  shortMaxItems: number
  shortContextSharePercent: number
  autoRecord: { short: boolean; long: boolean; portable: boolean; answer: boolean; summaryLength: 'long' | 'short' }
  compactionArchive: boolean
  reflectionIntervalHours: number
  embedding: {
    enabled: boolean
    baseURL: string
    model: string
    apiKey: string
    timeoutMs: number
    minScore: number
    batchSize: number
    queryPrefix: string
    documentPrefix: string
    cooldownMs: number
  }
}

/** The `ctx.brainMemory` service: a thin facade over the opened memory store. */
export class MemoryFacility extends Service {
  /** The opened memory store; `undefined` before init completes. */
  opened?: MemoryStore

  /**
   * Brain capabilities indexed by short dispatcher key. Populated during
   * `apply`; the dsh-brain-dispatch plugin routes the single `brain` tool to
   * these. Always built, even in native tool mode.
   */
  capabilities: Map<string, BrainCapability> = new Map()

  constructor(ctx: Context) {
    super(ctx, 'brainMemory')
  }

  /** The opened memory store; `undefined` before init completes. */
  get store(): MemoryStore | undefined {
    return this.opened
  }
}

/**
 * Mount the memory plugin: open the domain, provide the service, register
 * tools and prompt context.
 * @param ctx - registrant context.
 * @param config - validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Volatile fields are references: read them through .get() so a change
  // committed by Loader lands in this snapshot without remounting the plugin.
  const readConfig = (): ResolvedConfig => ({
    toolMode: config.toolMode === 'native' ? 'native' : 'dispatcher',
    injectContext: config.injectContext.get(),
    resumeHint: config.resumeHint.get(),
    decayIntervalHours: config.decayIntervalHours.get(),
    shortMaxItems: config.shortMaxItems.get(),
    shortContextSharePercent: config.shortContextSharePercent.get(),
    // 拍平后的字段同样是 volatile 引用，必须走 .get()。
    autoRecord: {
      short: config.autoRecordShort.get(),
      long: config.autoRecordLong.get(),
      portable: config.autoRecordPortable.get(),
      answer: config.autoRecordAnswer.get(),
      summaryLength: config.summaryLength.get(),
    },
    compactionArchive: config.compactionArchive.get(),
    reflectionIntervalHours: config.reflectionIntervalHours.get(),
    embedding: {
      enabled: config.embeddingEnabled.get(),
      baseURL: config.embeddingBaseURL.get(),
      model: config.embeddingModel.get(),
      apiKey: config.embeddingApiKey.get(),
      timeoutMs: config.embeddingTimeoutMs.get(),
      minScore: config.embeddingMinScore.get(),
      batchSize: config.embeddingBatchSize.get(),
      queryPrefix: config.embeddingQueryPrefix.get(),
      documentPrefix: config.embeddingDocumentPrefix.get(),
      cooldownMs: config.embeddingCooldownMs.get(),
    },
  })

  // Mutable snapshot: every closure below reads it by reference, so a
  // volatile-only update is visible at the next operation.
  const resolved: ResolvedConfig = readConfig()
  ctx.on('loader/volatile-update', () => {
    Object.assign(resolved, readConfig())
    ctx.logger.info(`memory: settings updated live (injectContext=${resolved.injectContext}, resumeHint=${resolved.resumeHint})`)
  })

  const { MemoryStore } = await import('./store.ts')
  const store = await MemoryStore.open(ctx)
  ctx.effect(() => () => store.close(), 'memory.domainClose')

  // Additive real-vector semantic layer. Opens a separate vector domain and a
  // background probe/first-sync; retrieval and tools receive the service and
  // transparently fall back to keywords whenever it is absent or unhealthy.
  let semantic: SemanticService | undefined
  if (resolved.embedding.enabled) {
    const vectors = await VectorStore.open(ctx)
    ctx.effect(() => () => { void vectors.close() }, 'memory.vectorDomainClose')
    const client = createEmbeddingClient({
      baseURL: resolved.embedding.baseURL,
      model: resolved.embedding.model,
      ...(resolved.embedding.apiKey ? { apiKey: resolved.embedding.apiKey } : {}),
      timeoutMs: resolved.embedding.timeoutMs,
      // nomic 等模型要求查询/文档分开加前缀；留空则不加（对不分前缀的模型无害）。
      ...(resolved.embedding.queryPrefix !== '' ? { queryPrefix: resolved.embedding.queryPrefix } : {}),
      ...(resolved.embedding.documentPrefix !== '' ? { documentPrefix: resolved.embedding.documentPrefix } : {}),
    })
    semantic = new SemanticService(client, vectors, {
      minScore: resolved.embedding.minScore,
      batchSize: resolved.embedding.batchSize,
      // 按需起服务时，退避时间决定"服务起来后多久能被认到"。
      cooldownMs: resolved.embedding.cooldownMs,
    })

    // Probe + first index build off the critical path so plugin mount never
    // blocks on the embedding server. A failed probe just leaves keywords on.
    let bootCancelled = false
    ctx.effect(() => () => { bootCancelled = true }, 'memory.semanticBoot')
    setTimeout(() => {
      void (async () => {
        if (bootCancelled || semantic === undefined) return
        if (await semantic.probe()) {
          const r = await semantic.syncIndex(store)
          ctx.logger.info(`memory: semantic index ready (${r.model}, indexed ${r.indexed}, skipped ${r.skipped}, failed ${r.failed}, pruned ${r.pruned})`)
        } else {
          ctx.logger.info('memory: embedding endpoint unavailable; semantic search using keyword fallback')
        }
      })().catch((error: unknown) => {
        ctx.logger.warn(`memory: semantic boot failed: ${String(error)}`)
      })
    }, 1500)
  }

  // The Service constructor registers `ctx.brainMemory` in the current fiber.
  const facility = new MemoryFacility(ctx)
  facility.opened = store
  facility.capabilities = buildMemoryCapabilities(store, semantic, {
    shortMaxItems: resolved.shortMaxItems,
    shortContextSharePercent: resolved.shortContextSharePercent,
  })

  // dispatcher mode (default): register NO per-ability tools — the separate
  // dsh-brain-dispatch plugin serves one lightweight `brain` entry, keeping the
  // full schemas out of every request. native mode restores the original
  // brain_memory_* tool surface as an opt-in fallback.
  if (resolved.toolMode === 'native') {
    registerMemoryTools(ctx, store, semantic)
  } else {
    ctx.logger.info('memory: dispatcher mode — abilities served through the single brain tool')
  }

  // 最近一次看到的上下文窗口（tokens）。由 agent/inbox/claimed 更新。
  // 0 表示"还不知道"——此时占比触发会跳过，只靠 maxItems 那条。
  let lastContextWindow = 0

  // Periodic short-term memory decay (port of decay.js): weight decays
  // exponentially with days since last access; over-age / under-threshold
  // items are archived into public memory. The timer is disposed with the
  // plugin via ctx.effect.
  const decayIntervalMs = resolved.decayIntervalHours * 3_600_000
  if (decayIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void runShortTermDecay(store, {
          maxItems: resolved.shortMaxItems,
          contextSharePercent: resolved.shortContextSharePercent,
          contextWindowTokens: lastContextWindow,
        })
          .then((summary) => {
            const total = summary.daily.archived.length + summary.work.archived.length
            if (total > 0) {
              const byD = summary.daily.triggeredBy
              const byW = summary.work.triggeredBy
              ctx.logger.info(
                `memory: decay archived ${total} short-term item(s) `
                + `(daily ${summary.daily.archived.length}/${byD}, work ${summary.work.archived.length}/${byW})`,
              )
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(`memory: decay failed: ${String(error)}`)
          })
      }, decayIntervalMs)
      return () => clearInterval(timer)
    }, 'memory.decayTimer')
  }

  // Periodic reflection loop (pull → distill → store): pull recent public
  // memories / error fingerprints / proposals / unresolved items, distill
  // deterministic patterns, and append one periodic reflection per day. The
  // model deepens the analysis on demand via the brain_memory_reflect tool. Timer is
  // disposed with the plugin; runs are idempotent within a calendar day.
  const reflectionIntervalMs = resolved.reflectionIntervalHours * 3_600_000
  if (reflectionIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void runPeriodicReflection(store)
          .then((result) => {
            if (!result.skipped && result.record) {
              ctx.logger.info(`memory: periodic reflection stored ${result.record.id}`)
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(`memory: periodic reflection failed: ${String(error)}`)
          })
      }, reflectionIntervalMs)
      return () => clearInterval(timer)
    }, 'memory.reflectionTimer')
  }

  // Auto-record every user exchange into short-term + long-term + the
  // session's portable doc. Short-term is the session's working memory, the
  // long-term copy is deduped and searchable across sessions, and the portable
  // doc keeps its original role (session goal / solved / unresolved).
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    // 顺手记下当前模型的上下文窗口，供定时衰减算"占比触发"用。
    //
    // 为什么在这里取：定时器是全局的、没有 session；而这里能拿到 agent.session。
    // 窗口大小随模型变（32k / 64k / 128k / 1M），取不到就让占比触发静默跳过，
    // 不退化成"永远不触发"。
    try {
      const ctxWindow = agent.session.requestContext()?.contextWindow
      if (typeof ctxWindow === 'number' && ctxWindow > 0) lastContextWindow = ctxWindow
    } catch {
      // requestContext 在某些早期阶段可能不可用——忽略，保持上一次的值。
    }
    if (message.source.kind !== 'user') return
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text.trim() === '') return
    void autoRecordExchange(store, agent.session.id, text, {
      ...resolved.autoRecord,
      // Best-effort: index newly created long-term memories into the vector store.
      ...(semantic !== undefined
        ? { onLongRecord: (entry) => { void semantic?.indexOne(entry).catch(() => {}) } }
        : {}),
    }).catch((error: unknown) => {
      ctx.logger.warn(`memory: auto-record exchange failed: ${String(error)}`)
    })
  })

  // 助手回答也落短期（by: 'agent'）。用 session/event 而不是 inbox：
  // 助手消息不经过 inbox，日志事件才是权威来源。
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      if (!resolved.autoRecord.answer) return
      const content = (event.data as { message?: { content?: unknown } })?.message?.content
      const text = Array.isArray(content)
        ? content
          .filter((b): b is { type: 'text', text: string } => (b as { type?: string })?.type === 'text')
          .map(b => b.text)
          .join('\n')
        : ''
      if (text.trim() === '') return
      void autoRecordAnswer(store, session.id, text, true).catch((error: unknown) => {
        ctx.logger.warn(`memory: auto-record answer failed: ${String(error)}`)
      })
      return
    }

    // 上下文压缩：把摘要归档进长期记忆，让被压掉的历史仍可检索。
    if (event.type === 'compaction/summary') {
      if (!resolved.compactionArchive) return
      const data = event.data as {
        summary?: unknown
        shadowedTokenCount?: unknown
        provider?: unknown
        model?: unknown
      }
      const summaryBlocks = Array.isArray(data?.summary) ? data.summary : []
      const text = summaryBlocks
        .filter((b): b is { type: 'text', text: string } => (b as { type?: string })?.type === 'text')
        .map(b => b.text)
        .join('\n')
      if (text.trim() === '') return
      void archiveCompactionSummary(store, session.id, text, {
        ...(typeof data.shadowedTokenCount === 'number' ? { shadowedTokenCount: data.shadowedTokenCount } : {}),
        ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
        summaryLength: resolved.autoRecord.summaryLength,
      }).catch((error: unknown) => {
        ctx.logger.warn(`memory: compaction archive failed: ${String(error)}`)
      })
    }
  })

  // Registered unconditionally so the two switches take effect without a
  // remount; the provider consults the live values on every assembly.
  registerMemoryContext(ctx, store, {
    injectContext: () => resolved.injectContext,
    resumeHint: () => resolved.resumeHint,
  })
}
