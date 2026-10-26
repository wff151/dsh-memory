/**
 * Failure-fingerprint → proposal escalation.
 *
 * 原型（memory-system/src/agent.js + demo.js）：
 *   countErrorFingerprints(windowDays) → { fingerprint: count }
 *   任一指纹计数 ≥ 阈值 → createProposal({ fingerprint, description, newRule,
 *   status: 'shadow-testing', errorIds })
 *
 * 移植到 dsh-memory：从 evolution 档案的 error-log 记录统计指纹，达到阈值的
 * 指纹自动生成 proposal 记录（不会重复生成，直到既有提案被处理）。
 * @module dsh-memory/src/evolution
 */

import type { MemoryStore } from './store.ts'
import type { AgentEvolutionRecord } from './domain.ts'
import type { RecordId } from './types.ts'

/** 指纹 → 计数（windowDays 时间窗口内）。 */
export function countErrorFingerprints(store: MemoryStore, windowDays = 30): Record<string, number> {
  const cutoff = Date.now() - windowDays * 86_400_000
  const counts: Record<string, number> = {}
  for (const record of store.listEvolution('error-log')) {
    const ts = new Date(record.timestamp ?? '').getTime()
    if (Number.isNaN(ts) || ts < cutoff) continue
    const fp = String((record as Record<string, unknown>).fingerprint || 'unknown')
    counts[fp] = (counts[fp] ?? 0) + 1
  }
  return counts
}

/** Escalation options. */
export interface EscalationOptions {
  /** 触发阈值：同一指纹在窗口内出现 ≥ 该次数即生成提案，默认 2。 */
  threshold?: number
  /** 统计窗口（天），默认 90（原型 demo 口径）。 */
  windowDays?: number
  /** 新提案初始状态，默认 pending（原型 demo 用 shadow-testing；pending 更保守）。 */
  status?: string
}

/** 一次升级扫描的结果。 */
export interface EscalationResult {
  /** 指纹计数（窗口内）。 */
  counts: Record<string, number>
  /** 本次新建的提案记录。 */
  proposals: AgentEvolutionRecord[]
  /** 已达阈值但被跳过的指纹（已有未处理提案）。 */
  skipped: string[]
}

/**
 * 扫描失败指纹，达到阈值的指纹自动生成进化提案（不重复生成）。
 *
 * 重复判断：存在同一 triggerFingerprint 且 status 为 pending/shadow-testing
 * 的既有提案时跳过（该失败模式仍在处理中）。
 * 提案的 newRule 留空——具体规则应由模型基于失败详情补全，这里不编造内容。
 */
export async function maybeCreateProposals(
  store: MemoryStore,
  options: EscalationOptions = {},
): Promise<EscalationResult> {
  const threshold = options.threshold ?? 2
  const windowDays = options.windowDays ?? 90
  const status = options.status ?? 'pending'

  const counts = countErrorFingerprints(store, windowDays)
  const existingProposals = store.listEvolution('proposal')
  const inFlight = new Set(
    existingProposals
      .filter(r => ['pending', 'shadow-testing'].includes(String((r as Record<string, unknown>).status)))
      .map(r => String((r as Record<string, unknown>).triggerFingerprint)),
  )

  const proposals: AgentEvolutionRecord[] = []
  const skipped: string[] = []
  for (const [fp, count] of Object.entries(counts)) {
    if (count < threshold) continue
    if (inFlight.has(fp)) {
      skipped.push(fp)
      continue
    }
    const now = new Date().toISOString()
    const record: AgentEvolutionRecord = {
      type: 'proposal',
      id: `PROPOSAL_${now.slice(0, 10)}_${Math.random().toString(36).slice(2, 6)}` as RecordId,
      timestamp: now,
      triggerFingerprint: fp,
      errorIds: [],
      description: `失败指纹“${fp}”在近 ${windowDays} 天内出现 ${count} 次，建议针对该失败模式新增或修订规则。`,
      newRule: '',
      status,
      createdAt: now,
      updatedAt: now,
    }
    const stored = await store.appendEvolution(record)
    proposals.push(stored)
    inFlight.add(fp)
  }
  return { counts, proposals, skipped }
}
