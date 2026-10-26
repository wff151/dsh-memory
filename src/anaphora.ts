// 称谓 / 关系词消解：把"嫂子 / 哥哥 / 叔叔 / 他"这类间接说法
// 扩展成候选实体名，让检索能命中。
//
// 分两类：
//   1. **词表类**（不需要上下文）：嫂子→妻/媳妇，哥哥→兄，叔叔→叔父…
//      这类在任何情况下都成立，可以纯函数实现。
//   2. **代词类**（需要上下文）：他/她/那个 —— 依赖"当前话题实体"。
//      本模块只提供接口，由调用方传入会话上下文。
//
// 设计原则：**扩展查询，不改写条目**。检索时把查询词扩展，比改存储更安全。

/** 亲属/关系称谓 → 可能的正式表述。 */
const KINSHIP = new Map([
  ['嫂子', ['妻', '媳妇', '老婆', '之妻']],
  ['媳妇', ['妻', '老婆', '之妻']],
  ['老婆', ['妻', '媳妇', '之妻']],
  ['妻子', ['妻', '媳妇', '之妻']],
  ['哥哥', ['兄', '之兄', '大哥']],
  ['弟弟', ['弟', '之弟']],
  ['妹妹', ['妹', '之妹']],
  ['姐姐', ['姐', '之姐']],
  ['父亲', ['父', '之父']],
  ['母亲', ['母', '之母']],
  ['儿子', ['子', '之子']],
  ['女儿', ['女', '之女']],
  ['叔叔', ['叔', '之叔']],
  ['舅舅', ['舅']],
  ['丈夫', ['夫', '之夫']],
  ['老公', ['夫', '丈夫']],
  ['老爷子', ['父', '之父', '农民']],
])

/** 职业 / 身份描述 → 可能对应的角色词。 */
const ROLE = new Map([
  ['当兵的', ['军人', '兵', '当兵', '复员']],
  ['当老师的', ['教师', '老师', '教书']],
  ['老师', ['教师', '教书']],
  ['记者', ['记者', '报社', '省报']],
  ['寡妇', ['寡', '遗孀', '丈夫', '矿难']],
  ['司机', ['司机', '开车']],
  ['矿工', ['矿工', '下井', '煤矿', '矿井']],
  ['农民', ['农民', '种地', '刨食']],
  ['干部', ['干部', '书记', '主任']],
])

/**
 * 把查询里的称谓/身份词扩展成候选正式表述。
 *
 * @param query - 原始查询。
 * @param limit - 每个原词最多扩展几个候选（默认 3），防止查询膨胀。
 * @returns 扩展后的**额外 token**（不含原查询已有的词）。
 */
export function expandKinshipAndRole(query: string, limit = 3): string[] {
  const q = String(query ?? '')
  const extra: string[] = []
  const seen = new Set<string>()

  const push = (t: string) => {
    const s = t.trim()
    if (s === '' || seen.has(s) || q.includes(s)) return
    seen.add(s)
    extra.push(s)
  }

  for (const [word, aliases] of KINSHIP) {
    if (!q.includes(word)) continue
    for (const a of aliases.slice(0, limit)) push(a)
  }
  for (const [word, aliases] of ROLE) {
    if (!q.includes(word)) continue
    for (const a of aliases.slice(0, limit)) push(a)
  }
  return extra
}

/** 代词：需要上下文才知道指谁。 */
export const PRONOUNS = ['他', '她', '它', '他们', '她们'] as const

/**
 * 查询里是否含代词（需要会话上下文才能消解）。
 * 注意：中文里"其他"、"他们"都可能误判，所以要求代词前后是边界或标点。
 */
export function containsPronoun(query: string): boolean {
  const q = String(query ?? '')
  return PRONOUNS.some(p => {
    const at = q.indexOf(p)
    if (at < 0) return false
    // "其他"里也有"他"，排除
    if (at > 0 && q[at - 1] === '其') return false
    return true
  })
}

/**
 * 用"当前话题实体"补全代词查询。
 *
 * 这是会话级能力：调用方要告诉本函数"现在聊的是谁"。
 * 本插件里没有会话话题追踪，所以按"最近写入的记忆标题"近似。
 *
 * @param query - 原始查询（含代词）。
 * @param topic - 当前话题实体名（从会话/最近记忆里取）。
 * @returns 补全后的查询；无代词或无话题则原样返回。
 */
export function resolvePronoun(query: string, topic: string | null): string {
  const q = String(query ?? '')
  if (topic === null || topic.trim() === '') return q
  if (!containsPronoun(q)) return q
  // 把代词替换成话题实体（只替换第一个，避免过度改写）
  for (const p of PRONOUNS) {
    const at = q.indexOf(p)
    if (at < 0) continue
    if (at > 0 && q[at - 1] === '其') continue
    return q.slice(0, at) + topic + q.slice(at + p.length)
  }
  return q
}
