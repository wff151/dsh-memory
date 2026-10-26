/**
 * Short-term memory decay: time-exponential weight decay + archival.
 *
 * 权重按 `weight * exp(-lambda * 距今天数)` 衰减。超过 maxAgeDays 的条目
 * 直接归档；权重衰减到 threshold 以下的条目归档。归档行为是写入公共记忆
 * （软删除，不丢信息）。
 *
 * 接入方式：插件 apply 里用 `setInterval` 周期触发 {@link runShortTermDecay}；
 * 也提供 `brain_memory_decay` 工具手动触发。
 * @module dsh-memory/src/decay
 */

import type { ShortTermItemRecord } from './domain.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryMode } from './types.ts'
import { estimateTokens } from './budget.ts'

/** 衰减速率（每天）。 */
const DEFAULT_LAMBDA = 0.05
/** 归档阈值：权重低于此值则归档。 */
const DEFAULT_THRESHOLD = 0.15
/** 最长保留天数（约一个季度）。 */
const DEFAULT_MAX_AGE_DAYS = 90
/** 重复使用最多把衰减放慢到几倍——延长，但不无限延长。 */
const SLOW_CAP = 4
/** 硬上限：无论多常用，最多保留 maxAgeDays 的这么多倍，到点必归档。 */
const HARD_AGE_MULT = 2
/**
 * 每个 mode 的短期记忆默认条数上限。
 *
 * 2000 条大约占多少上下文？**不占**——短期投影每步只取固定的几条
 * （状态 3 + 事件 3 + 关系 3），条数上限影响的是**存储与检索遍历量**，
 * 不是每步注入量。所以这个值可以放宽；收紧它的收益是检索更快、
 * 特征索引覆盖更完整（索引只取前 300 条）。
 */
const DEFAULT_MAX_ITEMS = 2000
/**
 * 短期记忆占用上下文的默认上限百分比。
 *
 * 15% 的来历（实测 613 条 / 27331 tokens / 平均 44.6 tokens 条）：
 *
 * | 窗口 | 15% 对应 | 换算条数 |
 * |---|---|---|
 * | 32k  | 4800 tok | ~107 条 |
 * | 64k  | 9600 tok | ~215 条 |
 * | 128k | 19200 tok | ~430 条 |
 *
 * 为什么不取更小：5% 在 32k 上只有 35 条，正常用一天就会一直触发，
 * 等于把有用的近记忆反复扫掉。
 * 为什么不取更大：20% 在 32k 上是 143 条，已经接近容量上限（2000 条里的
 * 32k 场景根本用不到那么多），两条触发条件就重叠了。
 */
const DEFAULT_CONTEXT_SHARE_PERCENT = 15

/** Decay 可调参数；全部可选，默认与原型一致。 */
export interface DecayOptions {
  /** 衰减速率（每天），默认 0.05。 */
  lambda?: number
  /** 归档阈值，默认 0.15。 */
  threshold?: number
  /** 最长保留天数，默认 90。 */
  maxAgeDays?: number
  /**
   * 每个 mode 保留的短期记忆**条数上限**，默认 2000。
   *
   * 为什么要有：`autoRecordShort` + `autoRecordAnswer` 每轮至少写 2 条，
   * 实测一天能到 143–311 条。衰减只按**权重**清、不按条数清 ——
   * 于是短期库会无限增长（实测已到 611 条）。
   *
   * 后果不只是存储：**唯一特征索引只取前 300 条**，
   * 超过 300 的部分拿不到特征加成，检索能力被截断。
   *
   * 超限时清理顺序：**权重最低的先走；权重相同则最老的先走**。
   * 置 0 或负数表示不限制（不推荐）。
   */
  maxItems?: number
  /**
   * 短期记忆占用上下文的上限**百分比**（默认 15）。
   *
   * 与 `maxItems` 是**两个独立触发条件，谁先满足谁算**：
   *   · `maxItems` —— 条数上限（固定，不随模型变）
   *   · `contextSharePercent` —— 按**上下文窗口比例**算上限（随模型变）
   *
   * 为什么需要后者：`maxItems: 2000` 在 1M 窗口的模型上永远不触发，
   * 但在 32k 窗口上可能早就太占地方了。按比例算才是"随模型自适应"的。
   *
   * **度量口径必须说清**：这里算的是「短期库**全部条目**的估算 token 数
   * ÷ 上下文窗口」。选择这个口径而不是"每步投影"，因为：
   *   · 投影是**固定值**（只取 状态3 + 事件3 + 关系3），条数再多也不变大，
   *     用它做触发条件**永远不会超标**，等于没做；
   *   · 全部正文虽然从不完整进入上下文，但它诚实地反映"这个库有多大"，
   *     而库越大 → 检索遍历越慢、特征索引覆盖越差（索引只取前 300 条）。
   *
   * 窗口大小由调用方传入（`contextWindowTokens`）；**拿不到窗口就跳过这条触发**，
   * 不让它退化成"永远不触发"或"永远触发"。
   *
   * 置 0 或负数表示关闭这条触发。
   */
  contextSharePercent?: number
  /**
   * 当前模型的上下文窗口（tokens）。由调用方从 session 上取。
   * 未提供时 `contextSharePercent` 这条触发**不生效**。
   */
  contextWindowTokens?: number
  /**
   * 归档回调，默认把条目写入公共记忆（软删除）。返回 Promise 时等待完成。
   */
  archive?: (item: ShortTermItemRecord, mode: MemoryMode) => void | Promise<void>
}

/** 一次衰减的结果。 */
export interface DecayResult {
  /** 被归档（从短期记忆中移除）的条目。 */
  archived: ShortTermItemRecord[]
  /** 衰减后仍保留的条目数。 */
  remaining: number
  /**
   * 裁剪前的短期库占上下文窗口的百分比（拿不到窗口时为 0）。
   * 用于诊断"到底是哪条触发在起作用"。
   */
  contextShareBefore?: number
  /**
   * 实际生效的是哪条触发：`items`（条数上限）/ `context`（窗口占比）/
   * `none`（没触发）。
   */
  triggeredBy?: 'items' | 'context' | 'none'
}

/** 两次衰减的总结果（daily + work）。 */
export interface DecaySummary {
  daily: DecayResult
  work: DecayResult
}

/** 距离今天的天数；无效时间按 0 处理（当天新条目不受衰减）。 */
function daysSince(iso: string | undefined): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 86_400_000
}

/** 默认归档：把条目写入公共记忆，保留标签与内容，注明来源为短期记忆归档。 */
function defaultArchive(store: MemoryStore) {
  return async (item: ShortTermItemRecord, mode: MemoryMode): Promise<void> => {
    await store.recordPublicMemory({
      mode,
      title: `短期记忆归档：${item.content.slice(0, 24)}`,
      summary: item.content,
      tags: [...(item.tags ?? []), 'decay-archive'],
      source: 'decay',
    })
  }
}

/**
 * 对一个 mode 执行一次短期记忆衰减：
 * 1. 超过 maxAgeDays 的条目直接归档；
 * 2. 其余按 weight *= exp(-lambda * age) 衰减，低于 threshold 的归档；
 * 3. 有归档发生时用 replaceShortTerm 落盘剩余条目。
 * @param store - 打开的 memory store。
 * @param mode - daily 或 work。
 * @param options - 可调参数与归档回调。
 */
export async function decayShortTerm(
  store: MemoryStore,
  mode: MemoryMode,
  options: DecayOptions = {},
): Promise<DecayResult> {
  const lambda = options.lambda ?? DEFAULT_LAMBDA
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
  const contextShare = options.contextSharePercent ?? DEFAULT_CONTEXT_SHARE_PERCENT
  const contextWindow = options.contextWindowTokens ?? 0
  const archive = options.archive ?? defaultArchive(store)

  const items = store.listShortTerm(mode)
  if (items.length === 0) return { archived: [], remaining: 0 }

  const archived: ShortTermItemRecord[] = []
  const remaining: ShortTermItemRecord[] = []

  for (const item of items) {
    const age = daysSince(item.lastAccess ?? item.createdAt)
    const refs = item.refCount ?? 0
    // 重复使用**只延长归档时间，不豁免归档**：
    //   1. 每次命中都会重置 lastAccess，所以 age 从「最近一次使用」算起；
    //   2. refCount 让有效年龄打折（衰减变慢），但最多慢 SLOW_CAP 倍；
    //   3. 再常用也有硬上限 HARD_AGE_MULT × maxAgeDays，到点必归档——
    //      项目结束后不再调用的信息，不能靠历史 refCount 永远赖在短期里。
    const slow = Math.min(1 + 0.5 * refs, SLOW_CAP)
    const effAge = age / slow
    if (age > maxAgeDays * HARD_AGE_MULT) {
      archived.push(item)
      await archive(item, mode)
      continue
    }
    const next: ShortTermItemRecord = {
      ...item,
      weight: item.weight * Math.exp(-lambda * effAge),
    }
    if (next.weight < threshold) {
      archived.push(item)
      await archive(item, mode)
      continue
    }
    remaining.push(next)
  }

  // ── 两条独立的容量触发，取**更严**的那一个 ──────────────────────
  //
  //   ① maxItems        —— 条数上限（固定值，不随模型变）
  //   ② contextShare    —— 按上下文窗口百分比换算出的条数（随模型变）
  //
  // 为什么需要 ②：`maxItems: 2000` 在 1M 窗口的模型上几乎永不触发，
  // 但在 32k 窗口上可能早就过大了。按比例算才"随模型自适应"。
  // 两条同时配置时取**更小**的那个，即"谁先满谁生效"。
  let finalRemaining = remaining
  let overflowArchived: ShortTermItemRecord[] = []

  // ② 换算：当前库占窗口的百分比 → 允许保留多少条
  let contextCapItems = Number.POSITIVE_INFINITY
  let contextShareNow = 0
  if (contextShare > 0 && contextWindow > 0 && remaining.length > 0) {
    const tokensNow = remaining.reduce(
      (sum, item) => sum + estimateTokens(`${item.title ?? ''} ${item.summary ?? item.content ?? ''}`),
      0,
    )
    contextShareNow = (tokensNow / contextWindow) * 100
    if (contextShareNow > contextShare) {
      // 按比例反推：超出阈值时该留多少条。
      // 用**当前平均 token/条**折算，而不是硬编码——库的内容密度会变。
      const perItem = tokensNow / remaining.length
      const capTokens = (contextWindow * contextShare) / 100
      contextCapItems = perItem > 0 ? Math.max(1, Math.floor(capTokens / perItem)) : remaining.length
    }
  }

  // 取更严的那个上限
  const effectiveCap = Math.min(
    maxItems > 0 ? maxItems : Number.POSITIVE_INFINITY,
    contextCapItems,
  )

  if (Number.isFinite(effectiveCap) && remaining.length > effectiveCap) {
    const cap = Math.max(1, Math.floor(effectiveCap))
    const sorted = [...remaining].sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight // 权重高的在前
      return b.lastAccess < a.lastAccess ? -1 : 1 // 同权重时近的在前
    })
    const keep = sorted.slice(0, cap)
    overflowArchived = sorted.slice(cap)
    for (const item of overflowArchived) {
      await archive(item, mode)
    }
    finalRemaining = keep
  }

  // 写回存储 —— **不能只在有归档时才写**。
  //
  // 原实现是 `if (archived.length > 0) replaceShortTerm(...)`，
  // 于是"这一轮没有任何条目被归档"时，**衰减后的权重就被丢掉了**：
  // 权重只在内存里算了一遍，没落盘。结果短期条目几乎永远不衰减，
  // 权重一直停在 1.0，容量上限也就永远压不住。
  //
  // 这个 bug 是 `_tools/test-short-capacity.mjs` 第 6 项抓到的
  // （期望 0.6065，实际 1.0000）。
  //
  // 现在：只要权重有变化就写回。用长度不等或任一权重变化作为判据，
  // 避免每 6 小时做一次无意义的整表写入。
  const weightChanged = finalRemaining.length === items.length
    ? finalRemaining.some((item, i) => items[i]?.weight !== item.weight || items[i]?.id !== item.id)
    : true

  if (archived.length > 0 || overflowArchived.length > 0 || weightChanged) {
    await store.replaceShortTerm(mode, finalRemaining)
  }
  const triggeredBy: 'items' | 'context' | 'none'
    = overflowArchived.length === 0
      ? 'none'
      : contextCapItems < (maxItems > 0 ? maxItems : Number.POSITIVE_INFINITY)
        ? 'context'
        : 'items'

  return {
    archived: [...archived, ...overflowArchived],
    remaining: finalRemaining.length,
    contextShareBefore: contextShareNow,
    triggeredBy,
  }
}

/**
 * 对 daily 与 work 两个 mode 各执行一次衰减。
 * @param store - 打开的 memory store。
 * @param options - 可调参数与归档回调。
 */
export async function runShortTermDecay(store: MemoryStore, options: DecayOptions = {}): Promise<DecaySummary> {
  const daily = await decayShortTerm(store, 'daily', options)
  const work = await decayShortTerm(store, 'work', options)
  return { daily, work }
}
