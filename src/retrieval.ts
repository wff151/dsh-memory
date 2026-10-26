/**
 * Triple retrieval: time filter → tag match → semantic search → fused ranking.
 *
 * First pass: time filter (outermost) — parse time intent from the query.
 * Second pass: tag match (exact strike) — match query entities/intent against
 * structured tags. Third pass: semantic search (fuzzy coverage) — keyword
 * scoring with Chinese bigrams as the fallback.
 *
 * Fused ranking: exact tag + explicit time > exact tag + fuzzy time >
 * high semantic + time weight > pure semantic.
 * @module dsh-memory/src/retrieval
 */

import type { MemoryMode } from './types.ts'
import type { MemoryId } from './types.ts'
import type { MemoryStore } from './store.ts'
import type { PublicMemoryRecord, ShortTermItemRecord } from './domain.ts'
import type { SemanticService } from './semantic.ts'
import { expandKinshipAndRole, resolvePronoun } from './anaphora.ts'
import { expandOneHop, sameEntity } from './relations.ts'
import { detectAnswerKind, kindMatches } from './intent.ts'
import { computeFeatures, featureScore } from './features.ts'

// ─── time filter ─────────────────────────────────────────────────────────

export interface TimeIntent {
  type: string
  value: { year?: number; month?: number; rel?: string }
}

/** Regex capture for patterns only reached after a match; '' defensively if absent. */
const cap = (m: RegExpMatchArray, i: number): string => m[i] ?? ''

const TIME_PATTERNS: { re: RegExp; type: string; get: (m: RegExpMatchArray) => { year?: number; month?: number; rel?: string } }[] = [
  { re: /(20\d{2})年?[-年](\d{1,2})月?/, type: 'year-month', get: m => ({ year: +cap(m, 1), month: +cap(m, 2) }) },
  { re: /(20\d{2})年/, type: 'year', get: m => ({ year: +cap(m, 1) }) },
  { re: /(昨天|今天|前天)/, type: 'relative', get: m => ({ rel: cap(m, 1) }) },
  { re: /(上个月|这个月|上上个月)/, type: 'month-rel', get: m => ({ rel: cap(m, 1) }) },
  { re: /(去年|今年|前年)/, type: 'year-rel', get: m => ({ rel: cap(m, 1) }) },
  { re: /(上周|这周|上上周)/, type: 'week-rel', get: m => ({ rel: cap(m, 1) }) },
]

export function parseTimeIntent(query: string): TimeIntent | null {
  for (const p of TIME_PATTERNS) {
    const m = query.match(p.re)
    if (m) return { type: p.type, value: p.get(m) }
  }
  return null
}

export function matchTime(entry: PublicMemoryRecord, intent: TimeIntent | null): number {
  if (!intent) return 0
  const [y, mo] = entry.date.split('-').map(Number)
  const now = new Date()
  const ny = now.getFullYear()
  const nm = now.getMonth() + 1
  const nd = now.getDate()

  switch (intent.type) {
    case 'year-month':
      return y === intent.value.year && mo === intent.value.month ? 1 : 0
    case 'year':
      return y === intent.value.year ? 1 : 0
    case 'relative': {
      const target = {
        '今天': `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`,
        '昨天': new Date(now.getTime() - 86400000).toISOString().slice(0, 10),
        '前天': new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10),
      }[intent.value.rel ?? '']
      return entry.date === target ? 1 : 0
    }
    case 'month-rel': {
      let targetMonth = nm
      if (intent.value.rel === '上个月') targetMonth = nm - 1
      if (intent.value.rel === '上上个月') targetMonth = nm - 2
      if (targetMonth < 1) targetMonth += 12
      return y === ny && mo === targetMonth ? 1 : 0
    }
    case 'year-rel': {
      const targetYear = { '今年': ny, '去年': ny - 1, '前年': ny - 2 }[intent.value.rel ?? '']
      return y === targetYear ? 1 : 0
    }
    case 'week-rel': {
      const day = 86400000
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const dow = (today.getDay() + 6) % 7 // Monday = 0
      const thisMonday = today.getTime() - dow * day
      const offsets: Record<string, number> = { '这周': 0, '上周': 7, '上上周': 14 }
      const start = thisMonday - (offsets[intent.value.rel ?? ''] ?? 0) * day
      const end = start + 7 * day
      const t = new Date(entry.date).getTime()
      return t >= start && t < end ? 1 : 0
    }
    default:
      return 0
  }
}

// ─── tag match ───────────────────────────────────────────────────────────

export function collectKnownTags(entries: PublicMemoryRecord[]): string[] {
  const set = new Set<string>()
  for (const e of entries) {
    for (const t of e.tags ?? []) set.add(t)
  }
  return [...set]
}

export function extractTags(query: string, knownTags: string[]): string[] {
  return knownTags.filter(tag => query.includes(tag))
}

export function tagScore(entry: PublicMemoryRecord, queryTags: string[]): number {
  if (queryTags.length === 0) return 0
  const entryTags = new Set(entry.tags ?? [])
  const hit = queryTags.filter(t => entryTags.has(t))
  if (hit.length === 0) return 0
  return hit.length / queryTags.length
}

// ─── semantic search (keywords + Chinese bigrams) ────────────────────────

/**
 * Tokenize: English words, then Chinese runs as whole segments (≤4 chars)
 * plus bigrams. Bigrams lift fuzzy Chinese matching ("看深度的相机" → "相机").
 */
export function tokenize(text: string): string[] {
  const str = String(text ?? '').toLowerCase()
  const tokens = new Set<string>()
  for (const w of str.match(/[a-z][a-z0-9_]{1,}/g) ?? []) {
    tokens.add(w)
  }
  const cnRuns = str.match(/[\u4e00-\u9fa5]+/g) ?? []
  for (const run of cnRuns) {
    if (run.length <= 4) tokens.add(run)
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2))
    }
  }
  return [...tokens]
}

/**
 * 中文虚词 / 功能字。跨过它们拼出的 bigram（如「到孙」「安那」「样了」）
 * 不可能是词，留在分母里只会稀释分数。
 *
 * **只放改造后仍是虚词的字。** 曾把方位字（上中下里前后）也放进来，
 * 结果「下井」被判成垃圾片丢掉——而"下井"是这部小说的核心场景词之一。
 * 那一次过度过滤是不含名问法 top1 只有 53% 的隐形原因之一。
 */
const CN_FUNCTION_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或',
  '这', '那', '个', '些', '什', '么', '怎', '样', '哪', '谁', '吗', '呢', '吧',
  '把', '被', '给', '让', '对', '从', '我', '你', '他', '她', '它', '们',
  '有', '没', '不', '很', '太', '会', '能',
])

/**
 * 这个 token 是否是「可能是词」的中文片段。
 *
 * 判据刻意简单：bigram 里只要含一个功能字，就基本不构成实词。
 * 英文 token 一律保留（不适用此规则）。
 */
export function isPlausibleToken(token: string): boolean {
  if (!/[\u4e00-\u9fa5]/.test(token)) return true // 英文/数字
  if (token.length !== 2) return true // 整段（≤4 字）保留
  const [a, b] = token
  return !CN_FUNCTION_CHARS.has(a) && !CN_FUNCTION_CHARS.has(b)
}

/**
 * 关键词/语义分数（改进版）。
 *
 * 改前是 `命中数 / token 总数` —— 纯整数比，取值离散（14 个槽），
 * 实测 50% 的查询 top1 出现并列，排序退化成遍历顺序。见测试报告 §4.6。
 *
 * 改后三处调整：
 *   1. **过滤不可疑片段**：`到孙` / `安那` 这种跨虚词拼出的 bigram 不计入分母；
 *   2. **位置加权**：命中出现在 title 前部（前 30%）权重更高 ——
 *      条目通常把人名/主题写在开头；
 *   3. **长度加权**：更长的 token 更具体（4 字片段 > 2 字 bigram）。
 *
 * 结果不再落在少数几个离散值上，并列大幅减少。
 */
export function semanticScore(entry: PublicMemoryRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0

  // 1) 只保留"可能是词"的 token 作为分母
  const tokens = queryTokens.filter(isPlausibleToken)
  if (tokens.length === 0) return 0

  const titleText = String(entry.title ?? '').toLowerCase()
  const bodyText = [
    entry.summary,
    entry.goal,
    entry.result,
    (entry.unresolved ?? []).join(' '),
  ].join(' ').toLowerCase()

  let weightedHits = 0
  let weightedTotal = 0

  for (const tok of tokens) {
    // 3) 长度加权：2 字 = 1.0，3 字 = 1.3，4 字 = 1.5
    const weight = tok.length <= 2 ? 1 : tok.length === 3 ? 1.3 : 1.5
    weightedTotal += weight

    const inTitle = titleText.includes(tok)
    const inBody = bodyText.includes(tok)
    if (!inTitle && !inBody) continue

    // 2) 位置/字段加权：命中在 title 前 30% ↔ 1.0；title 其他位置 ↔ 0.9；
    //    仅命中正文 ↔ 0.85。
    //
    //    正文权重刻意给得高：用户常拿"内容里的词"来问（比如用「砖窑」找孙少安），
    //    这时命中不在 title 里。曾经把正文压到 0.6，结果"
    //    查到正确内容反而比查到名字分低"——那是负优化，已改回来。
    let credit = 0
    if (inTitle) {
      const at = titleText.indexOf(tok)
      const lead = at >= 0 && at <= Math.max(4, Math.floor(titleText.length * 0.3))
      credit = Math.max(credit, lead ? 1.0 : 0.9)
    }
    if (inBody) credit = Math.max(credit, 0.85)

    weightedHits += credit * weight
  }

  return weightedTotal === 0 ? 0 : weightedHits / weightedTotal
}

// ─── fused ranking ───────────────────────────────────────────────────────

export interface ScoredResult<T> {
  item: T
  scores: { time: number; tag: number; semantic: number; vector?: number }
  score: number
}

/** The three deterministic retrieval signals for one public memory. */
interface Signals {
  t: number
  tag: number
  kw: number
}

/** Existing keyword/bigram fusion (unchanged behaviour, used as fallback). */
function keywordFusedScore(s: Signals): number {
  const { t, tag, kw } = s
  if (tag > 0 && t > 0) return 1.0 * tag + 0.8 * t + 0.3 * kw
  if (tag > 0) return 0.8 * tag + 0.4 * kw
  if (kw > 0 && t > 0) return 0.6 * kw + 0.5 * t
  return 0.5 * kw
}

/**
 * Vector-led fusion: cosine is the primary semantic signal, while exact tag
 * and explicit time hits keep their precision. Entries without a vector (not
 * yet indexed) still surface via keywords at a lower weight, so enabling
 * embeddings never removes keyword recall.
 */
function vectorFusedScore(s: Signals, vec: number): number {
  const { t, tag, kw } = s
  if (vec > 0) return 0.55 * vec + 0.2 * tag + 0.1 * t + 0.15 * kw
  const kwOnly = 0.45 * kw + 0.3 * tag + 0.15 * t
  return kwOnly > 0 ? kwOnly : 0
}

interface PublicSearchParams {
  store: MemoryStore
  query: string
  mode: MemoryMode | 'both'
  topK: number
}

function collectSearchBase(params: PublicSearchParams): {
  entries: PublicMemoryRecord[]
  timeIntent: TimeIntent | null
  queryTags: string[]
  queryTokens: string[]
} {
  const { store, query, mode } = params
  const entries = mode === 'both'
    ? store.listAllPublicMemories()
    : store.listPublicMemories(mode)
  const timeIntent = parseTimeIntent(query)
  const knownTags = collectKnownTags(entries)
  const queryTags = extractTags(query, knownTags)
  const queryTokens = tokenize(query)
  return { entries, timeIntent, queryTags, queryTokens }
}

/** Search public memories across one or both modes (keyword path). */
export function searchPublicMemory(
  store: MemoryStore,
  query: string,
  options: { mode?: MemoryMode | 'both'; topK?: number; topic?: string | null } = {},
): { results: ScoredResult<PublicMemoryRecord>[]; timeIntent: TimeIntent | null; queryTags: string[] } {
  const mode = options.mode ?? 'both'
  const topK = options.topK ?? 5
  // 代词消解（需要调用方给话题）；称谓/身份扩展（不需要上下文，纯词表）。
  const resolved = resolvePronoun(query, options.topic ?? null)
  const base = collectSearchBase({ store, query: resolved, mode, topK })

  // 把称谓扩展出的候选词并进 token —— 只扩查询，不改条目。
  const extra = expandKinshipAndRole(resolved)
  const queryTokens = extra.length === 0
    ? base.queryTokens
    : [...new Set([...base.queryTokens, ...tokenize(extra.join(' '))])]

  // 提问意图 → 期望答案类型。判出来就按类型加权/收窄候选。
  const answerKind = detectAnswerKind(resolved)

  // 唯一特征索引：**每次检索时现算**（不落库）。
  // 特征是"相对同期语料的稀有度"，语料一变就该重算；冻结会漂移。
  // 实测 100 条量级，计算开销可忽略。
  const featureIndex = computeFeatures(
    base.entries.slice(0, 300).map(e => ({
      id: String(e.memory_id),
      text: `${e.title} ${e.summary ?? ''}`,
    })),
  )

  const scored = base.entries.map((entry) => {
    const s: Signals = {
      t: matchTime(entry, base.timeIntent),
      tag: tagScore(entry, base.queryTags),
      kw: semanticScore(entry, queryTokens),
    }
    let score = keywordFusedScore(s)
    // 类型加权：**刻意不用**（实测负贡献，见 _docs/features-report.md §五）。
    // 判断"这条讲什么类型"和"这条能不能回答问题"不是一回事。
    const USE_KIND_BOOST = false
    if (USE_KIND_BOOST && answerKind !== 'unknown' && entry.kind !== undefined) {
      score *= kindMatches(answerKind, entry.kind) ? 2.2 : 0.35
    }
    // 唯一特征加成：命中"这条独有的词"才加分。
    // 「那个在煤矿下井的年轻人是谁」——"煤矿"是共同词（多条都有，不加分），
    // "农村青年"是孙少平独有，命中它才说明找对了人。
    //
    // **必须按比例加（score × (1 + ft)），不能加绝对值**：
    // 试过 score += ft * 0.8，结果含名问法从 100% 掉到 90%——
    // 特征多的长条目靠"命中一堆弱特征"就能压过"名字精确命中"。
    const ft = featureScore(queryTokens, featureIndex.get(String(entry.memory_id)))
    if (ft > 0) score *= 1 + ft * 0.5

    // **详情也要参与打分**（重要修正）。
    //
    // 发现过程：问「在抗洪里救人死的是谁」，田晓霞那条得 0 分。
    // 原因不是没词，而是 `deterministicSummary` 取首句——
    // 「田晓霞是润叶堂妹，省报记者。」后面那段"抗洪牺牲"**被摘要截掉了**，
    // 而检索只搜 title+summary，于是这条关键信息在检索时等于不存在。
    //
    // 摘要当**索引**没问题（短、便宜、给模型看），但**检索不能只看摘要**。
    //
    // **这里必须用加法，不能用乘法**：base 分可能是 0（摘要完全不含查询词），
    // `0 * 任何数` 还是 0，乘法救不回来。加法才能让"正文命中"单独成立。
    if (entry.detail !== undefined && entry.detail !== '') {
      const detailScore = semanticScore(
        { title: '', summary: entry.detail, tags: [], date: '', time: '' } as PublicMemoryRecord,
        queryTokens,
      )
      // 系数 0.55：正文命中确实说明相关，但正文长、噪声多，不该与 title 等价。
      if (detailScore > 0) score += detailScore * 0.55
    }

    return { item: entry, scores: { time: s.t, tag: s.tag, semantic: s.kw }, score }
  })

  const ranked = scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)

  // 关系一跳：命中的条目若带与查询意图匹配的关系边，把目标条目也拉进来。
  // 解决「他喜欢的姑娘是谁」这类**跨实体推理**（见 relations.ts）。
  const expansion = expandOneHop(
    ranked.slice(0, 3).map(r => ({
      title: String(r.item.title ?? ''),
      ...(r.item.relatedTo !== undefined ? { edges: r.item.relatedTo } : {}),
    })),
    resolved,
  )
  if (expansion.targets.length > 0) {
    const have = new Set(ranked.map(r => String(r.item.title ?? '')))
    const topScore = ranked[0]?.score ?? 0
    // 问的是"关系人"时，邻居就是答案 —— 它要排在源实体**之前**（1.05 倍）；
    // 否则只是"顺藤摸到"的补充（0.7 倍）。
    const neighbourScore = expansion.neighbourIsAnswer ? topScore * 1.05 : topScore * 0.7
    for (const target of expansion.targets) {
      if (have.has(target)) continue
      const neighbour = base.entries.find(e => sameEntity(target, String(e.title ?? '')))
      if (neighbour === undefined) continue
      ranked.push({ item: neighbour, scores: { time: 0, tag: 0, semantic: 0 }, score: neighbourScore })
    }
    ranked.sort((a, b) => b.score - a.score)
  }

  const results = ranked.slice(0, topK)
  return { results, timeIntent: base.timeIntent, queryTags: base.queryTags }
}

/**
 * Search public memories with real embeddings. When `semantic` is absent,
 * unhealthy, or the query embedding fails, this resolves to the byte-identical
 * keyword ranking — callers can always await it unconditionally.
 */
export async function searchPublicMemoryVector(
  store: MemoryStore,
  query: string,
  options: { mode?: MemoryMode | 'both'; topK?: number; semantic?: SemanticService; topic?: string | null } = {},
): Promise<{ results: ScoredResult<PublicMemoryRecord>[]; timeIntent: TimeIntent | null; queryTags: string[]; usedVectors: boolean }> {
  const mode = options.mode ?? 'both'
  const topK = options.topK ?? 5
  const semantic = options.semantic
  // 与关键词路径一致的消解：代词按话题补全，称谓按词表扩展。
  const resolved = resolvePronoun(query, options.topic ?? null)
  const base = collectSearchBase({ store, query: resolved, mode, topK })
  const extra = expandKinshipAndRole(resolved)
  const queryTokens = extra.length === 0
    ? base.queryTokens
    : [...new Set([...base.queryTokens, ...tokenize(extra.join(' '))])]

  const fallback = searchPublicMemory(store, query, { mode, topK, topic: options.topic ?? null })

  const vecScores = semantic?.isAvailable() ? await semantic.scoreQuery(resolved) : null
  if (semantic === undefined || vecScores === null) {
    return { ...fallback, usedVectors: false }
  }

  const scored = base.entries.map((entry) => {
    const s: Signals = {
      t: matchTime(entry, base.timeIntent),
      tag: tagScore(entry, base.queryTags),
      kw: semanticScore(entry, queryTokens),
    }
    const vec = vecScores.get(entry.memory_id as MemoryId) ?? 0
    return {
      item: entry,
      scores: { time: s.t, tag: s.tag, semantic: vec > 0 ? vec : s.kw, vector: vec },
      score: vectorFusedScore(s, vec),
    }
  })

  const results = scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
  return { results, timeIntent, queryTags, usedVectors: true }
}

/** Search short-term memory by weight order plus keyword filtering. */
export function searchShortTerm(
  store: MemoryStore,
  mode: MemoryMode,
  query: string,
  topK = 5,
  topic: string | null = null,
): ScoredResult<ShortTermItemRecord>[] {
  const items = store.listShortTerm(mode)
  // 与公开记忆同一套消解策略
  const resolved = resolvePronoun(query, topic)
  const extra = expandKinshipAndRole(resolved)
  const tokens = extra.length === 0
    ? tokenize(resolved)
    : [...new Set([...tokenize(resolved), ...tokenize(extra.join(' '))])]

  const picked = items
    .map((item) => {
      // 改前只搜 content，**摘要完全没用上**（而投影里用的是摘要）。
      // 正文 + 摘要 + 标题都该参与匹配。
      const sem = semanticScore(
        {
          title: item.title ?? item.content,
          summary: `${item.summary ?? ''} ${item.content}`.trim(),
          tags: [],
          date: '',
          time: '',
        } as PublicMemoryRecord,
        tokens,
      )
      return { item, scores: { time: 0, tag: 0, semantic: sem }, score: item.weight * (0.5 + sem) }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
  // 常用不衰减：被检索命中 = 真的用上了。续 lastAccess 并 +refCount，
  // decay 会按 refCount 折算有效年龄（见 decay.ts）。
  for (const r of picked) {
    void store.bumpShortRefCount(r.item.id).catch(() => {})
  }
  return picked
}

/** Compose the retrieved memory context text injected before each step. */
export function renderRetrievedContext(
  store: MemoryStore,
  query: string,
  options: { mode?: MemoryMode | 'both'; topK?: number } = {},
): string {
  const mode = options.mode ?? 'both'
  const pub = searchPublicMemory(store, query, { ...options, mode })
  const short = mode === 'both'
    ? [...searchShortTerm(store, 'daily', query), ...searchShortTerm(store, 'work', query)]
    : searchShortTerm(store, mode, query)
  return formatRetrievedContext(pub.results, short)
}

/**
 * Async variant: uses real embeddings when a healthy semantic service is
 * present, otherwise renders the exact keyword result. `usedVectors` reports
 * which path produced the output (surfaced to the model as a marker).
 */
export async function renderRetrievedContextAsync(
  store: MemoryStore,
  query: string,
  options: { mode?: MemoryMode | 'both'; topK?: number; semantic?: SemanticService } = {},
): Promise<{ text: string; usedVectors: boolean }> {
  const mode = options.mode ?? 'both'
  const pub = await searchPublicMemoryVector(store, query, { ...options, mode })
  const short = mode === 'both'
    ? [...searchShortTerm(store, 'daily', query), ...searchShortTerm(store, 'work', query)]
    : searchShortTerm(store, mode, query)
  return { text: formatRetrievedContext(pub.results, short, pub.usedVectors), usedVectors: pub.usedVectors }
}

/** Shared renderer for the two retrieval entry points. */
function formatRetrievedContext(
  pub: ScoredResult<PublicMemoryRecord>[],
  short: ScoredResult<ShortTermItemRecord>[],
  usedVectors = false,
): string {
  const lines = ['[记忆检索] 在回答用户问题前，你可以参考以下从记忆中检索到的相关信息：']
  if (usedVectors) lines.push('（本次长期记忆按语义向量相似度排序）')
  for (const r of pub) {
    const e = r.item
    lines.push(`[${e.date} - ${e.title}]（${e.mode === 'work' ? '工作' : '日常'}）`)
    lines.push(`  摘要：${e.summary}`)
    if (e.unresolved?.length) lines.push(`  未解决：${e.unresolved.join('；')}`)
    if (e.result) lines.push(`  结果：${e.result}`)
  }
  for (const r of short) {
    lines.push(`[短期记忆] ${r.item.content}`)
  }
  if (pub.length === 0 && short.length === 0) {
    lines.push('（未检索到相关记忆）')
  }
  return lines.join('\n')
}
