/**
 * Retrieval budget allocation by importance — the upward "recall" channel of
 * the design draft (§4.2, §5.4): retrieval budget *is* short-term memory
 * budget. What gets recalled has to fit into the now/working-memory window, so
 * more important questions may spend more budget.
 *
 *   high   → exhaustive: cross-mode, low threshold, large window (recall over
 *            precision — "rather over-recall than miss").
 *   normal → conditional cascade: start strict, then relax on zero hits
 *            (drop time → drop keywords / keep semantics → full fallback).
 *   low    → minimal: small window, high precision threshold, and if nothing
 *            is found, give up (the satisficing principle — a wrong recall just
 *            wastes attention).
 *
 * The attention layer (dsh-conduct) maps the current task onto an importance
 * level; the model can also pass `importance` explicitly to brain_memory_search.
 * @module dsh-memory/src/budget
 */

import type { MemoryStore } from './store.ts'
import type { MemoryMode, MemoryId } from './types.ts'
import type { PublicMemoryRecord, ShortTermItemRecord } from './domain.ts'
import type { SemanticService } from './semantic.ts'
import type { ScoredResult, TimeIntent } from './retrieval.ts'
import { resolvePronoun } from './anaphora.ts'
import {
  parseTimeIntent,
  matchTime,
  collectKnownTags,
  extractTags,
  tagScore,
  tokenize,
  semanticScore,
  searchShortTerm,
} from './retrieval.ts'

/** Task / question importance — drives how much retrieval budget is spent. */
export type Importance = 'high' | 'normal' | 'low'

/** Which retrieval signals a cascade pass may use. */
export interface SignalGates {
  time: boolean
  tag: boolean
  keyword: boolean
  vector: boolean
}

/** One resolved budget profile. */
export interface RetrievalBudget {
  importance: Importance
  /** Starting mode; high forces 'both' for exhaustive recall. */
  mode: MemoryMode | 'both'
  topK: number
  /** Short-term-memory items carried alongside the public-memory recall. */
  shortTopK: number
  /** Hard short-term-memory ceiling in (estimated) tokens for the rendered block. */
  maxTokens: number
  /** Minimum fused score for an entry to survive (precision floor). */
  roundMin: number
  /** Whether zero-hit passes relax into broader ones. */
  cascade: boolean
  /** Whether an empty result is accepted immediately (satisficing). */
  giveUpWhenEmpty: boolean
  signals: SignalGates
}

export type ImportanceInput = Importance | undefined

/** Static profiles per importance (the cascade relaxes these per pass). */
export const BUDGET_PROFILES: Record<Importance, Omit<RetrievalBudget, 'mode'>> = {
  high: {
    importance: 'high',
    topK: 8,
    shortTopK: 6,
    maxTokens: 1400,
    roundMin: 0.05,
    cascade: false,
    giveUpWhenEmpty: false,
    signals: { time: true, tag: true, keyword: true, vector: true },
  },
  normal: {
    importance: 'normal',
    topK: 5,
    shortTopK: 4,
    maxTokens: 900,
    roundMin: 0.15,
    cascade: true,
    giveUpWhenEmpty: false,
    signals: { time: true, tag: true, keyword: true, vector: true },
  },
  low: {
    importance: 'low',
    topK: 3,
    shortTopK: 2,
    maxTokens: 400,
    roundMin: 0.4,
    cascade: false,
    giveUpWhenEmpty: true,
    signals: { time: true, tag: true, keyword: true, vector: true },
  },
}

/** Cue words that force the attention gate wide open (safety / irreversible). */
const HIGH_CUES = [
  '必须', '务必', '一定要', '千万', '关键', '紧急', '危急', '危险', '安全', '不可逆',
  '救命', '无论如何', '最重要', '底线', '红线', '最高优先', '事故', '致命', '报错',
  '崩溃', '失败', '丢失', '删除', '无法恢复',
]

/** Cue words that mark a question as optional (satisficing is fine). */
const LOW_CUES = [
  '随便', '看看', '也许', '如果有', '有没有都行', '不重要', '有空', '顺带', '顺便',
  '可能的话', '无聊', '有没有什么',
]

/**
 * Infer a default importance from phrasing when the caller did not state one.
 * Safety / irreversibility cues win over optional cues. This only supplies a
 * default — an explicit `importance` always overrides it.
 */
export function inferImportance(query: string): Importance {
  const q = String(query ?? '')
  if (HIGH_CUES.some(cue => q.includes(cue))) return 'high'
  if (LOW_CUES.some(cue => q.includes(cue))) return 'low'
  return 'normal'
}

/**
 * Deterministic, tokenizer-free token estimate used as the short-term-memory
 * budget meter: each CJK ideograph counts ~1 token; a run of latin/digits of
 * length L counts ~ceil(L/4). Punctuation/whitespace are free. Approximate by
 * design (the budget is a heuristic ceiling, not a billable count).
 */
export function estimateTokens(text: string): number {
  const s = String(text ?? '')
  let tokens = 0
  const runs = s.match(/[a-z0-9_]+/gi) ?? []
  for (const run of runs) tokens += Math.max(1, Math.ceil(run.length / 4))
  const cjk = s.match(/[一-鿿㐀-䶿]/g) ?? []
  tokens += cjk.length
  return tokens
}

/** Resolve the effective budget for an importance and an optional mode hint. */
export function resolveBudget(importance: Importance, modeHint?: MemoryMode | 'both'): RetrievalBudget {
  const profile = BUDGET_PROFILES[importance]
  // High always goes exhaustive across both modes; others respect the hint.
  const mode: MemoryMode | 'both' = importance === 'high' ? 'both' : (modeHint ?? 'both')
  return { ...profile, mode, signals: { ...profile.signals } }
}

/** Audit row for one cascade pass. */
export interface BudgetPass {
  stage: string
  mode: MemoryMode | 'both'
  signals: SignalGates
  roundMin: number
  hits: number
}

/** Result of a budgeted retrieval. */
export interface BudgetSearchResult {
  results: ScoredResult<PublicMemoryRecord>[]
  shortTerm: ScoredResult<ShortTermItemRecord>[]
  importance: Importance
  budget: RetrievalBudget
  usedVectors: boolean
  /** Every pass attempted, strictest first. */
  passes: BudgetPass[]
  /** Stage that produced the returned rows ('high-single' / 'low-single' / pass name). */
  matchedPass: string
  tokensUsed: number
  /** Whether rows were dropped to honour the token ceiling. */
  truncated: boolean
  /** True for a low-budget query whose minimal pass found nothing. */
  gaveUp: boolean
  query: string
}

export interface BudgetSearchOptions {
  /** Explicit importance; inferred from the query when omitted. */
  importance?: Importance
  mode?: MemoryMode | 'both'
  topK?: number
  /** Override the profile's short-term-memory token ceiling. */
  maxTokens?: number
  semantic?: SemanticService
  /**
   * 当前话题实体，用于代词消解（"他/她/那个"→ 具体名字）。
   * 省略时由 {@link inferTopicFromRecent} 从最近记忆推断。
   */
  topic?: string | null
}

/** Entries visible for a mode. */
function entriesForMode(store: MemoryStore, mode: MemoryMode | 'both'): PublicMemoryRecord[] {
  return mode === 'both' ? store.listAllPublicMemories() : store.listPublicMemories(mode)
}

/** Fuse one entry under a pass's signal gates and optional vector scores. */
function scoreEntry(
  entry: PublicMemoryRecord,
  ctx: {
    intent: TimeIntent | null
    queryTags: string[]
    queryTokens: string[]
    vecFor: (id: MemoryId) => number
    vectorEnabled: boolean
  },
  gates: SignalGates,
): ScoredResult<PublicMemoryRecord> {
  const t = gates.time ? matchTime(entry, ctx.intent) : 0
  const tag = gates.tag ? tagScore(entry, ctx.queryTags) : 0
  const kw = gates.keyword ? semanticScore(entry, ctx.queryTokens) : 0
  const rawVec = gates.vector && ctx.vectorEnabled ? ctx.vecFor(entry.memory_id) : 0
  const vec = Number.isFinite(rawVec) ? rawVec : 0
  let score: number
  if (vec > 0) {
    score = 0.55 * vec + 0.20 * tag + 0.10 * t + 0.15 * kw
  } else {
    const kwOnly = 0.45 * kw + 0.30 * tag + 0.15 * t
    score = kwOnly > 0 ? kwOnly : 0
  }
  return { item: entry, scores: { time: t, tag, semantic: vec > 0 ? vec : kw, ...(vec > 0 ? { vector: vec } : {}) }, score }
}

/** Run one cascade pass over a mode and return survivors above the floor. */
function runPass(
  store: MemoryStore,
  query: string,
  mode: MemoryMode | 'both',
  topK: number,
  roundMin: number,
  gates: SignalGates,
  vecScores: Map<MemoryId, number> | null,
  stage: string,
): { rows: ScoredResult<PublicMemoryRecord>[]; pass: BudgetPass } {
  const entries = entriesForMode(store, mode)
  const intent = parseTimeIntent(query)
  const knownTags = collectKnownTags(entries)
  const queryTags = extractTags(query, knownTags)
  const queryTokens = tokenize(query)
  const vecFor = (id: MemoryId): number => vecScores?.get(id) ?? 0
  const rows = entries
    .map(entry => scoreEntry(entry, { intent, queryTags, queryTokens, vecFor, vectorEnabled: vecScores !== null }, gates))
    .filter(r => r.score >= roundMin)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
  return {
    rows,
    pass: { stage, mode, signals: { ...gates }, roundMin, hits: rows.length },
  }
}

/** Estimate the injected text size of one recalled entry. */
function entryTokens(e: PublicMemoryRecord): number {
  return estimateTokens([e.title, e.summary, e.goal, e.result, (e.unresolved ?? []).join(' ')].join(' '))
}

/** Trim survivors to the token ceiling, strongest first. */
function applyTokenBudget(
  rows: ScoredResult<PublicMemoryRecord>[],
  maxTokens: number,
): { rows: ScoredResult<PublicMemoryRecord>[]; tokensUsed: number; truncated: boolean } {
  const kept: ScoredResult<PublicMemoryRecord>[] = []
  let used = 0
  for (const r of rows) {
    const cost = entryTokens(r.item)
    if (used + cost > maxTokens && kept.length > 0) {
      return { rows: kept, tokensUsed: used, truncated: true }
    }
    used += cost
    kept.push(r)
    if (used >= maxTokens) {
      return { rows: kept, tokensUsed: used, truncated: rows.indexOf(r) < rows.length - 1 }
    }
  }
  return { rows: kept, tokensUsed: used, truncated: false }
}

/**
 * Search public memory under an importance-allocated budget. High is a single
 * exhaustive pass; low a single precise pass that may give up; normal cascades
 * from strict to broad on zero hits. The query is embedded at most once.
 */
export async function searchWithBudget(
  store: MemoryStore,
  query: string,
  options: BudgetSearchOptions = {},
): Promise<BudgetSearchResult> {
  // 代词消解：把"他/她/那个"换成当前话题实体。称谓扩展在 retrieval 里做。
  const topic = options.topic ?? inferTopicFromRecent(store)
  const resolvedQuery = resolvePronoun(query, topic)

  const importance: Importance = options.importance ?? inferImportance(resolvedQuery)
  const base = resolveBudget(importance, options.mode)
  const budget: RetrievalBudget = {
    ...base,
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  }

  // Embed the query once (if vectors are enabled); a failed/absent endpoint
  // degrades every pass to keyword signals but never aborts the search.
  const semantic = options.semantic
  const useVector = budget.signals.vector && semantic !== undefined
  const vecScores = useVector && semantic?.isAvailable()
    ? await semantic.scoreQuery(resolvedQuery)
    : null
  const usedVectors = vecScores !== null

  const passes: BudgetPass[] = []
  let chosen: { rows: ScoredResult<PublicMemoryRecord>[]; stage: string } | null = null

  if (importance === 'high' || importance === 'low') {
    const { rows, pass } = runPass(
      store, resolvedQuery, budget.mode, budget.topK, budget.roundMin, budget.signals,
      usedVectors ? vecScores : null,
      importance === 'high' ? 'high-exhaustive' : 'low-minimal',
    )
    passes.push(pass)
    chosen = { rows, stage: pass.stage }
  } else {
    // normal cascade: strict → drop time → keep semantic/tag → full fallback
    const startMode = budget.mode
    const cascadeSpecs: Array<{ stage: string; mode: MemoryMode | 'both'; gates: SignalGates; roundMin: number }> = [
      { stage: 'strict', mode: startMode, gates: { ...budget.signals }, roundMin: 0.15 },
      { stage: 'relax-no-time', mode: startMode, gates: { ...budget.signals, time: false }, roundMin: 0.12 },
      { stage: 'relax-semantic', mode: startMode, gates: { time: false, tag: true, keyword: false, vector: true }, roundMin: 0.1 },
      { stage: 'full-fallback', mode: 'both', gates: { time: true, tag: true, keyword: true, vector: true }, roundMin: 0.05 },
    ]
    for (const spec of cascadeSpecs) {
      const { rows, pass } = runPass(
        store, resolvedQuery, spec.mode, budget.topK, spec.roundMin, spec.gates,
        usedVectors ? vecScores : null, spec.stage,
      )
      passes.push(pass)
      if (rows.length > 0) {
        chosen = { rows, stage: spec.stage }
        break
      }
    }
    if (chosen === null) chosen = { rows: [], stage: 'full-fallback' }
  }

  const gaveUp = importance === 'low' && chosen.rows.length === 0
  const { rows: budgeted, tokensUsed, truncated } = applyTokenBudget(chosen.rows, budget.maxTokens)

  const shortMode: MemoryMode | 'both' = importance === 'high' ? 'both' : budget.mode
  const shortTerm = shortMode === 'both'
    ? [...searchShortTerm(store, 'daily', query, budget.shortTopK), ...searchShortTerm(store, 'work', query, budget.shortTopK)]
      .sort((a, b) => b.score - a.score).slice(0, budget.shortTopK)
    : searchShortTerm(store, shortMode, query, budget.shortTopK)

  return {
    results: budgeted,
    shortTerm,
    importance,
    budget,
    usedVectors,
    passes,
    matchedPass: chosen.stage,
    tokensUsed,
    truncated,
    gaveUp,
    query,
  }
}

/** Render a budgeted recall as injected context text, with a compact audit line. */
export function renderBudgetedContext(r: BudgetSearchResult): string {
  const lines = ['[记忆检索] 在回答用户问题前，你可以参考以下从记忆中检索到的相关信息：']
  const importanceLabel = r.importance === 'high' ? '高·全量召回' : r.importance === 'low' ? '低·最小预算' : '常规·逐级放宽'
  const route = r.usedVectors ? '语义向量' : '关键词'
  lines.push(`（检索预算：${importanceLabel}｜${route}｜命中于 ${r.matchedPass}｜约 ${r.tokensUsed} tokens${r.truncated ? '｜已按预算截断' : ''}${r.gaveUp ? '｜最小预算未命中，放弃召回' : ''}）`)
  for (const x of r.results) {
    const e = x.item
    lines.push(`[${e.date} - ${e.title}]（${e.mode === 'work' ? '工作' : '日常'}）`)
    lines.push(`  摘要：${e.summary}`)
    if (e.unresolved?.length) lines.push(`  未解决：${e.unresolved.join('；')}`)
    if (e.result) lines.push(`  结果：${e.result}`)
  }
  for (const x of r.shortTerm) {
    lines.push(`[短期记忆] ${x.item.content}`)
  }
  if (r.results.length === 0 && r.shortTerm.length === 0) {
    lines.push(r.gaveUp ? '（低优先级问题，最小预算未检索到相关记忆，按满足性原则不再扩大检索）' : '（未检索到相关记忆）')
  }
  return lines.join('\n')
}

/** Convenience: budgeted search + render in one await (used by brain_memory_search). */
export async function renderRetrievedContextBudgeted(
  store: MemoryStore,
  query: string,
  options: BudgetSearchOptions = {},
): Promise<{ text: string; result: BudgetSearchResult }> {
  // 代词消解需要"当前话题"。这里从**最近写入的短期记忆标题**推断——
  // 那就是"刚才在聊什么"。取不到就让检索按原样处理（不硬猜）。
  const topic = options.topic ?? inferTopicFromRecent(store)
  const result = await searchWithBudget(store, query, { ...options, topic })
  return { text: renderBudgetedContext(result), result }
}

/**
 * 从最近写入的短期记忆推断当前话题实体。
 *
 * 判据克制：只取**最近一条带 title 的记忆**，且 title 要像"人名/主题"
 * （≤ 12 字、无问号）。宁可取不到（返回 null），也不硬猜一个错的话题——
 * 错了会把代词替换成无关实体，比不消解更坏。
 */
export function inferTopicFromRecent(store: MemoryStore): string | null {
  for (const mode of ['daily', 'work'] as const) {
    const items = store.listShortTerm(mode)
    for (let i = items.length - 1; i >= 0; i--) {
      const title = String(items[i]?.title ?? '').trim()
      if (title === '' || title.length > 12) continue
      if (/[？?！!]/.test(title)) continue
      return title
    }
  }
  return null
}
