/**
 * 唯一特征索引：让每个条目能回答"凭什么是它，而不是同类"。
 *
 * 为什么需要（见 multi-round-report §五之三）：
 *   不含实体名的问法 top1 只有 **53%**，失败模式的根因是——
 *   「煤矿」这个词在 3 条以上记忆里都有（孙少平、煤矿那条、井下那条），
 *   **它不是区分特征，是共同词**。于是「那个在煤矿下井的年轻人是谁」
 *   检索不到「孙少平」，因为"煤矿"指向所有和煤矿有关的条目。
 *
 * 解法：写入时算出每条记忆的**独有特征词**（相对同期其它条目而言），
 * 检索时命中的独有特征权重更高。
 *
 * 三个关键决定：
 *   1. **特征不是"关键词"，是"区别于同类的词"** —— 必须对比语料整体算 IDF
 *   2. **写入时冻结**，不随语料变化重算 —— 否则历史条目的特征会漂移
 *   3. **只在条目自己的文本里出现过才算** —— 不做跨条目拼接
 * @module dsh-memory/src/features
 */

/**
 * 从文本里抽"可能是特征"的词。
 *
 * 分两档，**完整短语优先**：
 *   · 按标点切出的短语（"农村青年"、"铜城大牙湾煤矿当矿工"）—— 语义完整
 *   · 短语内的 2–4 字滑窗 —— 兜底，质量低，只在不与短语重复时保留
 *
 * 不做滑窗优先的原因：滑窗会产出「农村青」「村青年」「矿当矿」这类碎片，
 * 它们能命中，但命中时提供不了语义信息，还会挤掉真正有用的完整短语。
 */
function candidateTerms(text: string): { strong: string[], weak: string[] } {
  const s = String(text ?? '').toLowerCase()
  const strong = new Set<string>()
  const weak = new Set<string>()

  // 英文词一律算强特征
  for (const w of s.match(/[a-z][a-z0-9_]{2,}/g) ?? []) strong.add(w)

  const phrases = s.match(/[\u4e00-\u9fa5]{2,12}/g) ?? []
  for (const p of phrases) {
    // **完整短语只在 2–6 字时才当强特征**。
    // 太长的短语（"办砖窑先致富后破产"）不可能被用户原样说出来，
    // 留着它只会占名额、挤掉"砖窑"这种真会被说出来的词。
    if (p.length >= 2 && p.length <= 6) strong.add(p)
    // 2–4 字滑窗：既覆盖长短语里的实体，也提供短词。
    for (const n of [2, 3, 4]) {
      for (let i = 0; i + n <= p.length; i++) weak.add(p.slice(i, i + n))
    }
  }

  const weakOnly = [...weak].filter(w => ![...strong].some(st => st.includes(w)))
  return { strong: [...strong], weak: weakOnly }
}

/** 中文虚词：含这些字的短片段不可能是特征。 */
const FUNCTION_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或',
  '这', '那', '个', '些', '什', '么', '怎', '样', '哪', '谁', '吗', '呢', '吧',
  '把', '被', '给', '让', '对', '从', '到', '后', '前', '里', '上', '下', '中',
  '我', '你', '他', '她', '它', '们', '有', '没', '不', '很', '太', '会', '能',
])

/** 这个候选词是否够格当特征。 */
function isFeatureWorthy(term: string): boolean {
  if (term.length < 2) return false
  if (!/[\u4e00-\u9fa5]/.test(term)) return true // 英文词放行
  for (const ch of term) {
    if (FUNCTION_CHARS.has(ch)) return false
  }
  return true
}

/**
 * 计算一批条目的**独有特征词**。
 *
 * 做法：把每条条目的候选词算出来，统计每个词在**多少条**里出现。
 * 出现得越少越有区分度：
 *   · 只在该条目出现（df = 1）→ 强特征
 *   · 出现在半数以上（df ≥ 50%）→ 无区分度，丢弃
 *
 * @param docs - 每条 `{ id, text }`。
 * @param maxFeatures - 每条最多保留几个特征（默认 8）。
 * @returns `id → 特征词数组`（按区分度从高到低）。
 */
export function computeFeatures(
  docs: ReadonlyArray<{ id: string, text: string }>,
  maxFeatures = 8,
): Map<string, string[]> {
  const df = new Map<string, number>()
  const perDoc = new Map<string, { strong: string[], weak: string[] }>()

  for (const doc of docs) {
    const { strong, weak } = candidateTerms(doc.text)
    const s = [...new Set(strong)].filter(isFeatureWorthy)
    const w = [...new Set(weak)].filter(isFeatureWorthy)
    perDoc.set(doc.id, { strong: s, weak: w })
    for (const t of [...s, ...w]) df.set(t, (df.get(t) ?? 0) + 1)
  }

  const n = docs.length
  // 出现在超过 40% 条目里的词，没有区分度（"煤矿"就是典型）。
  const dfCap = Math.max(2, Math.floor(n * 0.4))

  const result = new Map<string, string[]>()
  for (const [id, { strong, weak }] of perDoc) {
    const scoreOf = (t: string, tier: 'strong' | 'weak') => {
      const d = df.get(t) ?? 1
      const idf = Math.log((n + 1) / (d + 0.5)) + 1
      // 长度加成；**强特征额外 1.5 倍**，保证完整短语压过滑窗碎片。
      const lenBoost = t.length >= 4 ? 1.4 : t.length === 3 ? 1.15 : 1
      return idf * lenBoost * (tier === 'strong' ? 1.5 : 1)
    }

    const all = [
      ...strong.map(t => ({ t, s: scoreOf(t, 'strong'), d: df.get(t) ?? 1 })),
      ...weak.map(t => ({ t, s: scoreOf(t, 'weak'), d: df.get(t) ?? 1 })),
    ]
      .filter(x => x.d <= dfCap)
      .sort((a, b) => b.s - a.s)
      // 去掉"被更长的已选特征包含"的碎片（选了"黄土高原"就不要"土高原"）
      .filter((x, _i, arr) => !arr.some(o => o !== x && o.t.length > x.t.length && o.t.includes(x.t) && o.s >= x.s))

    // 分两半选：**前半取高分长短语，后半取短词**（2 字实体名/关键动宾）。
    // 只按分数取会让 2 字的"砖窑"被长短语全挤掉，而它恰恰是用户会用的查询词。
    const half = Math.ceil(maxFeatures / 2)
    const byScore = all.slice(0, half)
    const byShort = [...all]
      .filter(x => !byScore.includes(x) && x.t.length <= 3)
      .sort((a, b) => b.s - a.s)
      .slice(0, maxFeatures - byScore.length)

    const picked = [...byScore, ...byShort].map(x => x.t)
    result.set(id, picked)
  }
  return result
}

/**
 * 计算一组候选特征词的匹配分。
 *
 * 匹配用**双向包含**：
 *   · 查询词 ⊇ 特征（"那个在煤矿下井的年轻人" ⊇ "煤矿"）→ 命中
 *   · 特征 ⊇ 查询词（特征"双水村生产队长" ⊇ 查询"生产队长"）→ 命中
 *
 * 关键是**单向不够**：特征的完整短语常常比查询长，只判 query ⊇ feature 会全落空。
 *
 * @param queryTerms - 已切好的查询词。
 * @param features - 该条目的特有特征词。
 * @returns 0–1。
 */
export function featureScore(queryTerms: readonly string[], features: readonly string[] | undefined): number {
  if (features === undefined || features.length === 0) return 0
  if (queryTerms.length === 0) return 0
  // 滑窗碎片（"湾煤矿当""水村生产"）不该享有和真词同等权重：
  // 它们能命中纯属字符重叠，不提供语义。这里把它们降权。
  const isFragment = (t: string) => /[\u4e00-\u9fa5]{3,}/.test(t) && looksLikeFragment(t)

  let hit = 0
  let total = 0
  for (const f of features) {
    const w = (f.length >= 4 ? 1.5 : f.length === 3 ? 1.2 : 1) * (isFragment(f) ? 0.4 : 1)
    total += w
    const matched = queryTerms.some((q) => {
      if (q.length < 2) return false
      return q.includes(f) || f.includes(q)
    })
    if (matched) hit += w
  }
  return total === 0 ? 0 : hit / total
}

/**
 * 粗略判断一个中文串是不是"滑窗碎片"。
 *
 * 判据：首尾字是虚词/动作词就多半是切出来的碎片
 * （"湾煤矿当"以"当"结尾、"水村生产"以"产"结尾）。
 * 这是启发式，会误伤少数真词，但它们本来权重也低。
 */
function looksLikeFragment(t: string): boolean {
  const head = t[0] as string
  const tail = t[t.length - 1] as string
  const fragmentEnds = '当的了是在和与也就都而及或把被给让对从到后前里上中'
  const fragmentStarts = '的了是在和与也就都而及或把被给让对从'
  return fragmentEnds.includes(tail) || fragmentStarts.includes(head)
}
