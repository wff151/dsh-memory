/**
 * Periodic reflection loop: pull → distill → store.
 *
 * 原型（memory-system/src/agent.js）只有手动 writeReflection；这里把它升级为
 * 定时反思循环：
 *   拉 collectReflectionMaterial —— 窗口内的公共记忆 / 短期快照 / 错题指纹 /
 *                                   新提案 / 各随身文档未解决项；
 *   炼 distill  —— 确定性模式提取：新增量、高频标签、失败指纹、悬而未决项
 *                 （深度归因仍交给模型经 brain_memory_reflect 完成，这里不编造）；
 *   存 generatePeriodicReflection —— 追加一条 reflection 进化记录。
 *
 * 幂等：同一天已生成 periodic 自动反思则跳过，不重复刷屏。
 * @module dsh-memory/src/reflection
 */

import type { MemoryStore } from './store.ts'
import type { AgentEvolutionRecord } from './domain.ts'
import type { RecordId } from './types.ts'
import { countErrorFingerprints } from './evolution.ts'

/** 模型手动深度反思时遵循的模板（观察 → 模式 → 归因 → 趋势 → 调整）。 */
export const REFLECTION_TEMPLATE = `反思模板（请按此结构写，不要跳过步骤）
1. 事实观察：这段时间实际发生了什么？引用具体记忆 / 错题 / 任务，不写空话。
2. 模式识别：反复出现的问题、高频标签、重复失败指纹是什么？
3. 根因分析：为什么会这样？区分现象与根因，至少追问一层。
4. 趋势判断：相比上一阶段，在变好还是变坏？依据是什么？
5. 行动调整：下一阶段最优先改变的一件事是什么？给出可执行动作。
规则：第 1、2 步必须基于记忆库中的真实记录；无法判断的部分明确写"证据不足"。`

/** 系统内部标签，统计高频标签时排除。 */
const SYSTEM_TAGS = new Set(['auto-record', 'decay-archive', 'periodic', 'auto'])

/** 反思循环拉取的原始素材。 */
export interface ReflectionMaterial {
  windowDays: number
  /** 窗口内新增的公共记忆（daily + work）。 */
  newPublicCount: number
  /** 当前短期记忆条目总数（快照）。 */
  shortTermCount: number
  /** 窗口内错题指纹计数。 */
  errorFingerprints: Record<string, number>
  /** 窗口内新增的进化提案数。 */
  newProposalCount: number
  /** 各随身文档汇总的未解决问题（去重，截断）。 */
  unresolved: string[]
  /** 窗口内高频主题标签（已排除系统标签）。 */
  topTags: Array<{ tag: string; count: number }>
}

/** collectReflectionMaterial / generatePeriodicReflection 的选项。 */
export interface ReflectionOptions {
  /** 回顾窗口（天），默认 1。 */
  windowDays?: number
  /** 高频标签最多保留数量，默认 5。 */
  topTagsLimit?: number
  /** 未解决问题最多保留数量，默认 5。 */
  unresolvedLimit?: number
}

function withinDays(dateText: string | undefined, cutoff: number): boolean {
  if (!dateText) return false
  const t = new Date(dateText).getTime()
  return !Number.isNaN(t) && t >= cutoff
}

/**
 * 拉取并统计反思素材（"拉 → 炼"的确定性部分）。
 */
export function collectReflectionMaterial(
  store: MemoryStore,
  options: ReflectionOptions = {},
): ReflectionMaterial {
  const windowDays = options.windowDays ?? 1
  const topTagsLimit = options.topTagsLimit ?? 5
  const unresolvedLimit = options.unresolvedLimit ?? 5
  const cutoff = Date.now() - windowDays * 86_400_000

  const pub = [...store.listPublicMemories('daily'), ...store.listPublicMemories('work')]
  const recentPub = pub.filter(m => withinDays(m.date, cutoff))

  const shortTermCount = store.listShortTerm('daily').length + store.listShortTerm('work').length

  const errorFingerprints = countErrorFingerprints(store, windowDays)

  const recentProposals = store
    .listEvolution('proposal')
    .filter(r => withinDays(r.timestamp, cutoff))
    // 只统计真正的提案记录，排除 proposal-status-update 审计事件。
    .filter(r => (r as Record<string, unknown>).triggerFingerprint !== undefined)

  // 标签频次（公共记忆 + 短期记忆，排除系统内部标签）。
  const tagCount = new Map<string, number>()
  const countTags = (tags: string[] | undefined): void => {
    for (const tag of tags ?? []) {
      if (SYSTEM_TAGS.has(tag)) continue
      tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
    }
  }
  for (const m of recentPub) countTags(m.tags)
  for (const mode of ['daily', 'work'] as const) {
    for (const s of store.listShortTerm(mode)) countTags(s.tags)
  }
  const topTags = [...tagCount.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topTagsLimit)

  // 汇总各随身文档的未解决问题（去重）。
  const unresolvedSet: string[] = []
  for (const doc of store.listPortableDocs()) {
    for (const u of doc.unresolvedProblems ?? []) {
      if (!unresolvedSet.includes(u)) unresolvedSet.push(u)
    }
  }

  return {
    windowDays,
    newPublicCount: recentPub.length,
    shortTermCount,
    errorFingerprints,
    newProposalCount: recentProposals.length,
    unresolved: unresolvedSet.slice(0, unresolvedLimit),
    topTags,
  }
}

/** 把素材渲染成 observation 文本（确定性摘要，不含编造的归因）。 */
export function renderReflectionObservation(m: ReflectionMaterial): string {
  const lines = [`[自动反思 · 近 ${m.windowDays} 天]`]
  lines.push(`新增公共记忆 ${m.newPublicCount} 条；当前短期记忆 ${m.shortTermCount} 条；新增进化提案 ${m.newProposalCount} 条。`)
  if (m.topTags.length > 0) {
    lines.push(`高频主题：${m.topTags.map(t => `${t.tag}×${t.count}`).join('、')}。`)
  }
  const fps = Object.entries(m.errorFingerprints)
  if (fps.length > 0) {
    lines.push(`失败指纹：${fps.map(([fp, c]) => `${fp}×${c}`).join('、')}。`)
  } else {
    lines.push('窗口内无错题记录。')
  }
  if (m.unresolved.length > 0) {
    lines.push(`悬而未决：${m.unresolved.join('；')}。`)
  }
  return lines.join('\n')
}

/** 周期反思生成结果。 */
export interface PeriodicReflectionResult {
  /** true 表示今天已生成过，本次跳过。 */
  skipped: boolean
  /** 跳过原因或生成说明。 */
  reason: string
  /** 新写入的反思记录（跳过时为 undefined）。 */
  record?: AgentEvolutionRecord
  /** 本次使用的素材（跳过时也返回，便于观察）。 */
  material: ReflectionMaterial
}

/** 今天是否已有 periodic 自动反思（幂等）。 */
function hasPeriodicReflectionToday(store: MemoryStore): boolean {
  const today = new Date().toISOString().slice(0, 10)
  return store.listEvolution('reflection').some((r) => {
    const tags = (r as Record<string, unknown>).tags
    const tagList = Array.isArray(tags) ? (tags as string[]) : []
    return tagList.includes('periodic') && (r.timestamp ?? '').slice(0, 10) === today
  })
}

/**
 * 执行一次周期反思：拉取素材 → 确定性提炼 → 存入进化档案。
 *
 * 自动反思只沉淀"发生了什么"的可复核观察（observation）；analysis 留空，
 * 深度归因由模型调用 brain_memory_reflect 补充。同一天重复调用会跳过。
 */
export async function runPeriodicReflection(
  store: MemoryStore,
  options: ReflectionOptions = {},
): Promise<PeriodicReflectionResult> {
  const material = collectReflectionMaterial(store, options)

  // 无新增素材时不制造空反思（错题/提案/新记忆/未解决项全无）。
  const hasSignal = material.newPublicCount > 0
    || material.newProposalCount > 0
    || Object.keys(material.errorFingerprints).length > 0
    || material.unresolved.length > 0
    || material.topTags.length > 0
  if (!hasSignal) {
    return { skipped: true, reason: '窗口内无新增素材，跳过', material }
  }

  if (hasPeriodicReflectionToday(store)) {
    return { skipped: true, reason: '今天已生成周期反思，跳过', material }
  }

  const now = new Date().toISOString()
  const record: AgentEvolutionRecord = {
    type: 'reflection',
    id: `REFL_${Date.now().toString(36)}` as RecordId,
    timestamp: now,
    observation: renderReflectionObservation(material),
    analysis: '',
    tags: ['auto', 'periodic'],
  }
  const stored = await store.appendEvolution(record)
  return { skipped: false, reason: '已生成周期反思', record: stored, material }
}
