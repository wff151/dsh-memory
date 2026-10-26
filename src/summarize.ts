/**
 * 摘要层：把"硬截断"换成"真摘要"。
 *
 * 背景：原实现是 `text.slice(0, 200)`——直接砍掉后半段。用户的要求是
 * 短期/长期都存**总结**而不是截断，并且长期归档另存一份**详细文档**：
 *   · 摘要 = 索引，用来快速判断"这是不是我要找的"
 *   · 详情 = 正文，真正回忆时的依据（xx 事件、做了 xx、下一时间点又做 xx）
 *
 * 两套摘要并存：
 *   1. **确定性摘要**（默认）——零成本、零延迟、可预测。用于每一条消息/回答
 *      （一次会话里助手消息可能上千条，调模型做摘要完全不可接受）。
 *   2. **模型摘要**（可选）——质量更高，只用在**长期归档**这种低频、重要的场合。
 *
 * 本模块只做第 1 种（纯函数，零模型可单测）；第 2 种的调用点在 index.ts，
 * 由 llm 服务惰性驱动，服务缺失时自动回退到确定性摘要。
 * @module dsh-memory/src/summarize
 */

/** 摘要策略。 */
export type SummaryStrategy = 'deterministic' | 'model'

/**
 * 摘要长度的两种档位。
 *
 * 实测权衡（《平凡的世界》100 问，见 `_docs/summary-length-report.md`）：
 *
 * | 档位 | 摘要中位 | top1 | top3 |
 * |---|---|---|---|
 * | `long`  | 107 字 | 89% | 99% |
 * | `short` |  50 字 | 93% | 99% |
 *
 * `long` 的摘要**自己能看懂**（120–160 字，带实质内容）；
 * `short` 只取首句，上下文开销小约 **1/2**，且名字命中更稳（噪声少）。
 *
 * **默认 `long`**：那 89% / 93% 只在《平凡的世界》这一份数据上测过，
 * 别的领域（代码、工单、聊天）没有验证过。长摘要在没验证的场景里更安全——
 * 它至少不会把关键信息丢掉。想省上下文再切 `short`。
 */
export type SummaryLength = 'long' | 'short'

/** 确定性摘要的目标长度（字符）。 */
export const DETERMINISTIC_MAX_CHARS = 160

/** `short` 档的目标长度：只取首句，够判断"这条讲什么"就行。 */
export const SHORT_MAX_CHARS = 60

/** 一句话短于此数才视为"没有信息量"，需要向后扩展。 */
const MIN_USEFUL_CHARS = 8

/**
 * 按档位生成摘要 —— 调用方只需要给 `length`，不用记具体字数。
 *
 * @param text - 原文。
 * @param length - `long`（默认，120–160 字，能自己看懂）/ `short`（≤60 字，只作索引）。
 */
export function summarizeByLength(text: string, length: SummaryLength = 'long'): string {
  return length === 'short'
    ? deterministicSummary(text, SHORT_MAX_CHARS)
    : deterministicSummary(text, DETERMINISTIC_MAX_CHARS)
}

/**
 * 把一个过长的正文压成**确定性摘要**。
 *
 * 策略：**首句打底 + 后续句子按顺序补**，填到接近 maxChars 为止。
 *
 * 改前是"只取首句"。实测（`_tools/measure-summary-length.mjs`，89 条真实记忆）：
 *   · 摘要上限 160 字，**实际中位只有 50 字**
 *   · **只有 12% 的摘要填到上限的 90%**
 *   · 摘要/原文 = 63.8%
 *
 * 所以问题不是"上限太小"，而是**取首句太粗**。典型例子：
 *   原文 500 字 → 摘要 27 字：「你是「游戏Agent项目」的执行层实验员。」
 *   首句只是个身份标签，后面 473 字的实质内容全丢了。
 *
 * 现在按句顺序累加，直到：
 *   · 再加一句会超过 maxChars → 停（不硬塞半句）
 *   · 已经用了 ≥ 60% 且下一句会明显超出 → 停
 *
 * @param text - 原文。
 * @param maxChars - 目标上限，默认 160。
 * @returns 摘要（永不为空，除非入参为空）。
 */
export function deterministicSummary(text: string, maxChars = DETERMINISTIC_MAX_CHARS): string {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (src === '') return ''
  if (src.length <= maxChars) return src

  const sentences = splitSentences(src)
  if (sentences.length === 0) return cutAtClause(src, maxChars)

  // 第一句：太短（如"好的。"）就跳过，不值得当摘要主体。
  let out = ''
  let idx = 0
  const first = sentences[0] ?? ''
  if (first.length < MIN_USEFUL_CHARS && sentences.length > 1) {
    // 首句没信息量 → 直接从第二句开始累加，但保留首句作为"上下文尾巴"
    idx = 1
  } else {
    out = first
    idx = 1
  }

  // 后续句子按顺序补，能整句放下就放，放不下就停。
  for (; idx < sentences.length; idx++) {
    const s = sentences[idx]
    if (s === undefined) break
    const next = out === '' ? s : `${out}${s}`
    if (next.length <= maxChars) {
      out = next
      continue
    }
    // 整句放不下：
    //   · 若已有内容够用（≥ 60% 上限），就停 —— 不要把句子砍半。
    //   · 若内容还太少，用 cutAtClause 补到上限，保证摘要不至于只有几个字。
    if (out.length >= maxChars * 0.6) break
    const filled = cutAtClause(out === '' ? s : `${out}${s}`, maxChars)
    return filled.length > out.length ? filled : out
  }

  if (out === '') {
    // 所有句子都异常短 → 退化成按子句截
    return cutAtClause(src, maxChars)
  }
  // **最后兜底截断**：只有一句的长文本（如 80 字不分段）在上面循环里
  // 一段都不会补（idx 从 1 开始就结束了），out 会保持全句长度，超过上限。
  // 单测 `maxChars 可以调小` 抓到的就是这个。
  if (out.length > maxChars) return cutAtClause(out, maxChars)
  return out
}

/**
 * 按句切分（中文句末标点 + 换行）。保留句末标点。
 *
 * 与 `splitFirstSentence` 的区别：这个返回**全部**句子，供累加使用。
 */
function splitSentences(text: string): string[] {
  // 在句末标点后切开，标点保留在句子里
  const parts = text.split(/(?<=[。！？!?])/u)
  return parts
    .map(p => p.trim())
    .filter(p => p !== '')
}

/** 取第一句（含句末标点）。没有句末标点则整段。 */
function splitFirstSentence(text: string): string {
  const m = text.match(/^[^。！？!?\n]*[。！？!?]/)
  if (m !== null && m[0].length > 0) return m[0].trim()
  const nl = text.indexOf('\n')
  if (nl > 0) return text.slice(0, nl).trim()
  return text
}

/**
 * 在子句边界（逗号 / 分号 / 顿号 / 破折号 / 英文逗号分号）处截断，
 * 尽量保留一个完整的语义单元。找不到合适边界才硬砍。
 */
function cutAtClause(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const window = text.slice(0, maxChars)
  const boundary = Math.max(
    window.lastIndexOf('，'),
    window.lastIndexOf('；'),
    window.lastIndexOf('、'),
    window.lastIndexOf('—'),
    window.lastIndexOf(', '),
    window.lastIndexOf('; '),
  )
  // 边界不能太靠前，否则摘要会退化成几个字。
  if (boundary >= Math.floor(maxChars * 0.5)) {
    return `${window.slice(0, boundary).trim()}…`
  }
  return `${window.trim()}…`
}

/**
 * 把一段正文压成**详情文档**：保留完整内容，但加上结构化的时间线头。
 *
 * 用户要的样子是：
 *   「xx 事件，做了 xx 内容，下个时间点又做 xx 内容」
 * 也就是：**按发生顺序排列的事实条目**，而不是一大段散文。
 *
 * 这里做的是从原文里按行/句切出条目，编号排列，保留原文。
 * 不做语义改写——改写那是模型摘要的活。
 *
 * @param text - 原文（可含换行）。
 * @param opts.title - 文档标题（通常是事件名）。
 * @param opts.when - 时间点（ISO 或可读时间）。
 * @param opts.maxChars - 上限，默认 4000（详情可以长，但要防一条撑爆存储）。
 */
export function buildDetailDoc(
  text: string,
  opts: { title?: string, when?: string, source?: string, maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 4000
  const raw = String(text ?? '').trim()
  if (raw === '') return ''

  const lines: string[] = []
  if (opts.title !== undefined && opts.title !== '') lines.push(`# ${opts.title}`)
  const meta: string[] = []
  if (opts.when !== undefined && opts.when !== '') meta.push(`时间：${opts.when}`)
  if (opts.source !== undefined && opts.source !== '') meta.push(`来源：${opts.source}`)
  if (meta.length > 0) lines.push(meta.join(' · '))

  // 把正文按行切；没有换行就按句切。逐条编号，形成时间线。
  const pieces = raw.includes('\n')
    ? raw.split(/\r?\n/)
    : raw.split(/(?<=[。！？])/u)

  const items = pieces.map(p => p.trim()).filter(p => p !== '')
  if (items.length === 0) return lines.join('\n')

  lines.push('')
  items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item}`)
  })

  let doc = lines.join('\n')
  if (doc.length > maxChars) {
    doc = `${doc.slice(0, maxChars).trim()}\n…（已截断，原长 ${raw.length} 字）`
  }
  return doc
}