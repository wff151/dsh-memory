/**
 * Pure types of the dsh-memory domain: memory entry schemas, projection-key
 * declarations, and payload types, free of host-side value imports.
 * @module dsh-memory/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
export type { SessionId }

/** Branded memory record id. */
export type MemoryId = string & { readonly __brand: 'MemoryId' }

/** Branded evolution record id. */
export type RecordId = string & { readonly __brand: 'RecordId' }

/** Memory mode: daily (personal) or work (professional). */
export type MemoryMode = 'daily' | 'work'

/** Memory type classification. */
export type MemoryType = 'public' | 'short_term' | 'permanent' | 'portable_doc' | 'agent_evolution'

/** Agent evolution record type. */
export type EvolutionType = 'error-log' | 'proposal' | 'shadow-test' | 'rule' | 'reflection'

/** One public memory entry (long-term, dated, tagged). */
export interface PublicMemory {
  memory_id: MemoryId
  mode: MemoryMode
  date: string
  time: string
  title: string
  summary: string
  tags: string[]
  goal: string
  unresolved: string[]
  result: string
  source: string
  /** 关联任务 id（v2 可选）。 */
  taskId?: string
  /** 所属任务阶段（v2 可选）。 */
  taskPhase?: string
  /** 被检索/被引用计数（反馈回路，v2 可选）。 */
  refCount?: number
}

/** One short-term memory item (weighted, decaying). */
export interface ShortTermItem {
  id: string
  mode: MemoryMode
  content: string
  tags: string[]
  weight: number
  accessCount: number
  createdAt: string
  lastAccess: string
  // ── v2 可选字段 ──
  kind?: 'fact' | 'state' | 'event' | 'task' | 'relation'
  entityKey?: string
  entityValue?: string
  idempotencyKey?: string
  eventStatus?: 'pending' | 'success' | 'failed'
  phase?: string
  summary?: string
  relatedTask?: string
  refCount?: number
  lastEventId?: string
  ttlHours?: number
}

/** Permanent user profile (user portrait). */
export interface PermanentProfile {
  attributes: Record<string, unknown>
  preferences: Record<string, unknown>
  skills: string[]
  relationships: string[]
  /** v2：字段来源与时间戳，覆盖不丢历史。 */
  sources?: Record<string, unknown>
}

/** One portable document (per-session working memory). */
export interface PortableDoc {
  sessionId: SessionId
  title: string
  mode: MemoryMode
  goal: string
  exchangeCount: number
  solvedProblems: string[]
  unresolvedProblems: string[]
  summary: string
  tags: string[]
  log: PortableDocLogEntry[]
}

export interface PortableDocLogEntry {
  turn: number
  user: string
  time: string
}

/** One agent evolution record (error log, proposal, rule, etc.). */
export interface AgentEvolutionRecord {
  type: EvolutionType
  id: string
  timestamp: string
  [key: string]: unknown
}

/** Memory domain global state. */
export interface MemoryDomainState {
  memoryCount: number
  lastWriteAt?: string
}

/** Triple retrieval result. */
export interface RetrievalResult {
  public: PublicMemory[]
  shortTerm: ShortTermItem[]
  profile: PermanentProfile | null
  portable: PortableDoc | null
}