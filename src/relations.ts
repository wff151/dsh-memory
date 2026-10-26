/**
 * 关系图一跳扩展：解决"跨实体推理"的检索失败。
 *
 * 实测问题（见 anaphora-report §4）：
 *   「他喜欢的那个姑娘是谁」——话题是「孙少平」，
 *   但答案在「田晓霞」那条记忆里。代词消解只能把「他」换成「孙少平」，
 *   指不到「孙少平喜欢的那个人」。
 *
 * 解法：记忆条目带**关系边**（`relatedTo`）。检索命中「孙少平」后，
 * 沿边走到「田晓霞」，把她那条也纳入候选。
 *
 * 设计克制：
 *   - 只走**一跳**（不做多跳，避免跑偏到整张图）
 *   - 关系词与查询意图**匹配才走**（问"姑娘"才走"爱慕"，问"弟弟"才走"兄弟"）
 *   - 走了多少条要能审计（trace）
 * @module dsh-memory/src/relations
 */

/** 一条关系边。 */
export interface RelationEdge {
  /** 关系类型，如 爱慕 / 兄弟 / 父子 / 夫妻。 */
  relation: string
  /** 目标实体名。 */
  target: string
}

/**
 * 关系词 → 查询里可能出现的意图词。
 *
 * 用途：只有当查询提到了这类意图时，才沿对应的边扩展。
 * 否则问"他后来怎么样了"也会把所有关系人捞进来 —— 那是噪音。
 */
const RELATION_CUES: Record<string, string[]> = {
  爱慕: ['姑娘', '喜欢', '爱', '相恋', '女朋友', '对象', '恋', '娶', '夫人'],
  夫妻: ['妻子', '老公', '丈夫', '媳妇', '老婆', '嫂子', '结婚', '婚'],
  兄弟: ['弟弟', '哥哥', '兄', '弟', '兄弟', '哥'],
  父子: ['父亲', '母亲', '儿子', '女儿', '爹', '娘', '爸', '妈'],
  亲属: ['叔叔', '舅舅', '姑姑', '姨', '亲戚', '叔', '舅'],
  仇敌: ['仇', '敌人', '对手', '冲突', '恨'],
  上下级: ['上司', '领导', '下属', '手下', '上级'],
}

/**
 * 从一条记忆的关系边里，挑出**与查询意图相符**的目标。
 *
 * @param edges - 该条记忆的关系边。
 * @param query - 用户查询。
 * @returns 应该扩展过去的目标实体名（可能为空）。
 */
export function pickRelated(edges: readonly RelationEdge[] | undefined, query: string): string[] {
  if (edges === undefined || edges.length === 0) return []
  const q = String(query ?? '')
  if (q === '') return []

  const picked: string[] = []
  for (const edge of edges) {
    const cues = RELATION_CUES[edge.relation]
    // 关系类型不在表里 → 保守起见不扩展（宁可不救，不可乱救）。
    if (cues === undefined) continue
    if (!cues.some(c => q.includes(c))) continue
    if (!picked.includes(edge.target)) picked.push(edge.target)
  }
  return picked
}

/** 扩展结果，带溯源信息以便审计。 */
export interface RelationExpansion {
  /** 额外命中的实体名。 */
  targets: string[]
  /** 从哪个源实体走过去的（诊断用）。 */
  via: Array<{ from: string, relation: string, to: string }>
  /**
   * 这次扩展是否"关系人就是答案"。
   *
   * 判断依据：查询里出现的是**关系意图词**（姑娘/嫂子/弟弟），
   * 而不是实体本身。此时答案应该是**邻居**，不是源实体——
   * 例如「他喜欢的那个姑娘是谁」答案是田晓霞，不是孙少平。
   *
   * 为 true 时，调用方应把邻居提升到源实体**之上**，而不是放在后面。
   */
  neighbourIsAnswer: boolean
}

/** 查询是否在问"关系人"（而不是在问源实体本身）。 */
export function asksAboutRelation(query: string): boolean {
  const q = String(query ?? '')
  if (q === '') return false
  for (const cues of Object.values(RELATION_CUES)) {
    if (cues.some(c => q.includes(c))) return true
  }
  return false
}

/**
 * 目标名与条目名的匹配。
 *
 * 从正文抽出来的往往是**名**（"少平之兄"里的"少平"），而条目 title 是**全名**
 * （"孙少平"）。要求完全相等会把大多数边都判成没匹配。
 *
 * 规则：完全相等，或一方是另一方的后缀（"少平" ⊂ "孙少平"）。
 * 后缀匹配要求长度 ≥ 2，避免「平」这种单字乱配。
 */
export function sameEntity(target: string, title: string): boolean {
  const a = String(target ?? '').trim()
  const b = String(title ?? '').trim()
  if (a === '' || b === '') return false
  if (a === b) return true
  if (a.length < 2 || b.length < 2) return false
  return b.endsWith(a) || a.endsWith(b)
}

/**
 * 给定已命中的条目集合，沿关系边一跳扩展。
 *
 * @param hits - 第一轮命中的条目 `{ title, edges }`。
 * @param query - 用户查询（决定走哪类边）。
 * @returns 要额外纳入检索的目标名 + 溯源。
 */
export function expandOneHop(
  hits: ReadonlyArray<{ title: string, edges?: readonly RelationEdge[] }>,
  query: string,
): RelationExpansion {
  const targets: string[] = []
  const via: RelationExpansion['via'] = []

  for (const hit of hits) {
    const picked = pickRelated(hit.edges, query)
    for (const target of picked) {
      const relation = hit.edges?.find(e => e.target === target)?.relation ?? ''
      via.push({ from: hit.title, relation, to: target })
      if (!targets.includes(target)) targets.push(target)
    }
  }
  return { targets, via, neighbourIsAnswer: asksAboutRelation(query) }
}

/**
 * 从正文里**半自动抽取**关系边（辅助标注入，不是替代人工）。
 *
 * 只认几种确定性高的句式：
 *   「A 是 B 之兄/之弟/之妻/之父/之女」→ 兄弟/夫妻/父子
 *   「A 与 B 相恋 / A 爱 B」          → 爱慕
 *
 * 抽不到就返回空数组（不猜）。
 *
 * @param title - 条目主体（通常是人名）。
 * @param text - 条目正文。
 */
export function inferRelations(title: string, text: string): RelationEdge[] {
  const t = String(title ?? '').trim()
  const body = String(text ?? '')
  if (t === '' || body === '') return []

  const edges: RelationEdge[] = []
  const push = (relation: string, target: string) => {
    if (target === '' || target === t) return
    if (edges.some(e => e.relation === relation && e.target === target)) return
    edges.push({ relation, target })
  }

  // 「A 是 B 之兄/之弟/之妻/之父/之女/之子/之妹/之姐」
  // B 可能是全名也可能只是名（"少平之兄"里的"少平"），所以两种都试。
  const kinPattern = new RegExp(`${t}\\s*是\\s*([\\u4e00-\\u9fa5]{2,4})\\s*之\\s*(兄|弟|妻|父|母|子|女|妹|姐|叔)`)
  const kin = body.match(kinPattern)
  if (kin !== null) {
    const [, whom, rel] = kin
    const mapped = rel === '兄' || rel === '弟' ? '兄弟'
      : rel === '妻' ? '夫妻'
        : rel === '父' || rel === '母' || rel === '子' || rel === '女' ? '父子'
          : '亲属'
    push(mapped, whom)
  }

  // 「A 与 B 相恋/相爱/结婚」——**不限位置**：正文常写「与田晓霞相恋」，
  // 主语省略了。只要正文里出现「与<人名>相恋」，就以本条 title 为主体建边。
  //
  // 注意：这里必须是**捕获组** `(相恋|相爱|结婚)`。
  // 曾写成非捕获组 `(?:...)`，导致 love[2] 永远是 undefined，
  // "结婚"被错标成"爱慕"（关系类型错了，问"老婆"就匹配不到）。
  const love = body.match(/与\s*([\u4e00-\u9fa5]{2,4})\s*(相恋|相爱|结婚)/)
  if (love !== null) {
    push(love[2] === '结婚' ? '夫妻' : '爱慕', love[1])
  }

  // 「A 爱 B」
  const loves = body.match(new RegExp(`${t}\\s*爱\\s*([\\u4e00-\\u9fa5]{2,4})`))
  if (loves !== null) push('爱慕', loves[1])

  // 「A 的妻子/丈夫/弟弟/哥哥 是 B」这类反向句式：「…之妻 B」以外的常见写法
  const spouseOf = body.match(/([\u4e00-\u9fa5]{2,4})\s*(?:的)?\s*(妻子|丈夫|弟弟|哥哥|妹妹|姐姐|父亲|母亲)\s*(?:是|叫)\s*([\u4e00-\u9fa5]{2,4})/)
  if (spouseOf !== null) {
    const [, , rel, target] = spouseOf
    const mapped = rel === '妻子' || rel === '丈夫' ? '夫妻'
      : rel === '弟弟' || rel === '哥哥' ? '兄弟'
        : rel === '妹妹' || rel === '姐姐' ? '兄弟'
          : '父子'
    push(mapped, target)
  }

  return edges
}
