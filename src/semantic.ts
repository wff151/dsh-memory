/**
 * Semantic index service: turns public memories into dense vectors and scores
 * a query against them by cosine similarity. Sits beside (never inside) the
 * memory store — when the embedding endpoint is missing or fails, every method
 * degrades to `null` / zero-work so the keyword retriever stays authoritative.
 * @module dsh-memory/src/semantic
 */

import type { MemoryStore } from './store.ts'
import type { VectorStore } from './vector-store.ts'
import type { MemoryId, MemoryMode } from './types.ts'
import type { PublicMemoryRecord, VectorIndexRecord } from './domain.ts'
import type { EmbeddingClient } from './embedding.ts'
import { contentHash, cosineSimilarity } from './embedding.ts'

/** Tunables for the semantic service. */
export interface SemanticOptions {
  /** Minimum cosine for a vector to count as a hit. Default 0.3. */
  minScore?: number
  /** Texts per embedding request while (re)building the index. Default 16. */
  batchSize?: number
  /** Cooldown after a failed endpoint call before retries are attempted. Default 60s. */
  cooldownMs?: number
}

/** Compose the text embedded for one public memory (stable field order). */
export function memoryEmbeddingText(e: PublicMemoryRecord): string {
  return [
    e.title,
    e.summary,
    e.goal,
    e.result,
    (e.unresolved ?? []).join(' '),
    (e.tags ?? []).join(' '),
  ]
    .map(s => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

/** Result of a (re)index pass. */
export interface SyncResult {
  /** Vectors newly written or rebuilt. */
  indexed: number
  /** Entries already up to date. */
  skipped: number
  /** Entries whose embedding call failed (left for the next pass). */
  failed: number
  /** Orphan vectors whose source memory no longer exists (removed). */
  pruned: number
  /** Whether the endpoint answered at least one call. */
  available: boolean
  model: string
}

/**
 * Additive semantic index over public memories.
 */
export class SemanticService {
  private health: 'unknown' | 'up' | 'down' = 'unknown'
  private downUntil = 0
  readonly minScore: number
  readonly batchSize: number
  readonly cooldownMs: number

  constructor(
    private readonly client: EmbeddingClient,
    private readonly vectors: VectorStore,
    options: SemanticOptions = {},
  ) {
    this.minScore = options.minScore ?? 0.3
    this.batchSize = Math.max(1, options.batchSize ?? 16)
    this.cooldownMs = options.cooldownMs ?? 60_000
  }

  /** Embedding model id (also the rebuild key). */
  get model(): string {
    return this.client.model
  }

  /** Whether the endpoint is currently believed healthy (cooldown-aware). */
  isAvailable(): boolean {
    if (this.health === 'down' && Date.now() < this.downUntil) return false
    return this.health === 'up'
  }

  private markDown(): void {
    this.health = 'down'
    this.downUntil = Date.now() + this.cooldownMs
  }

  /** One cheap end-to-end probe; flips the health flag. Never throws. */
  async probe(): Promise<boolean> {
    try {
      const [v] = await this.client.embed(['healthcheck'])
      if (v && v.length > 0) {
        this.health = 'up'
        return true
      }
      this.markDown()
      return false
    } catch {
      this.markDown()
      return false
    }
  }

  /**
   * Embed arbitrary text, returning `null` on any failure (and backing off).
   *
   * `purpose` 决定套哪个任务前缀：查询与文档必须分开（nomic 等模型的要求），
   * 否则两者被当成同一种输入，相似度分不开。
   */
  private async embed(text: string, purpose: 'query' | 'document' = 'document'): Promise<number[] | null> {
    if (this.health === 'down' && Date.now() < this.downUntil) return null
    try {
      const [v] = await this.client.embed([text], purpose)
      if (v && v.length > 0) {
        this.health = 'up'
        return v
      }
      this.markDown()
      return null
    } catch {
      this.markDown()
      return null
    }
  }

  /** Index a single memory (used right after a new public memory is written). */
  async indexOne(entry: PublicMemoryRecord): Promise<boolean> {
    const text = memoryEmbeddingText(entry)
    if (!text) return false
    const vec = await this.embed(text)
    if (vec === null) return false
    await this.vectors.put({
      memory_id: entry.memory_id,
      model: this.model,
      hash: contentHash(text),
      vector: vec,
    })
    return true
  }

  /**
   * Bring the whole index in sync with the public memory table: build missing
   * vectors, rebuild entries whose content hash or model changed, and prune
   * orphans. Batched; a failed batch is retried one-by-one so one bad row does
   * not abort the pass.
   */
  async syncIndex(
    store: MemoryStore,
    options: { mode?: MemoryMode | 'both' } = {},
  ): Promise<SyncResult> {
    const mode = options.mode ?? 'both'
    const entries = mode === 'both'
      ? store.listAllPublicMemories()
      : store.listPublicMemories(mode)

    const result: SyncResult = { indexed: 0, skipped: 0, failed: 0, pruned: 0, available: false, model: this.model }
    const existing = new Map(this.vectors.list().map(v => [v.memory_id, v]))
    const liveIds = new Set(entries.map(e => e.memory_id))

    // Prune orphans first.
    for (const id of existing.keys()) {
      if (!liveIds.has(id)) {
        await this.vectors.delete(id)
        result.pruned++
      }
    }

    const pending = entries.filter((e) => {
      const text = memoryEmbeddingText(e)
      if (!text) return false
      const v = existing.get(e.memory_id)
      return v === undefined || v.model !== this.model || v.hash !== contentHash(text)
    })
    result.skipped = entries.length - pending.length

    for (let i = 0; i < pending.length; i += this.batchSize) {
      const batch = pending.slice(i, i + this.batchSize)
      const texts = batch.map(memoryEmbeddingText)
      let vecs: number[][] | null = null
      try {
        // 建索引 = 文档侧，套 document 前缀
        vecs = await this.client.embed(texts, 'document')
        result.available = true
      } catch {
        vecs = null
      }

      if (vecs === null) {
        // Retry one-by-one so a single problematic text doesn't fail the batch.
        for (const entry of batch) {
          if (await this.indexOne(entry)) {
            result.indexed++
            result.available = true
          } else {
            result.failed++
          }
        }
        continue
      }

      for (let j = 0; j < batch.length; j++) {
        const vec = vecs[j]
        const entry = batch[j]
        const text = texts[j]
        if (!vec || vec.length === 0 || !entry || typeof text !== 'string') {
          result.failed++
          continue
        }
        await this.vectors.put({
          memory_id: entry.memory_id,
          model: this.model,
          hash: contentHash(text),
          vector: vec,
        })
        result.indexed++
      }
    }

    if (result.available) this.health = 'up'
    return result
  }

  /**
   * Embed the query and score every stored vector. Returns a memoryId→cosine
   * map (only hits ≥ minScore), or `null` when the endpoint is unavailable.
   */
  async scoreQuery(query: string): Promise<Map<MemoryId, number> | null> {
    // 查询侧必须套 query 前缀，与索引时的 document 前缀配对
    const qv = await this.embed(String(query ?? ''), 'query')
    if (qv === null) return null
    const all: VectorIndexRecord[] = this.vectors.list()
    if (all.length === 0) return new Map()
    const scores = new Map<MemoryId, number>()
    for (const v of all) {
      const cos = cosineSimilarity(qv, v.vector)
      if (cos >= this.minScore) scores.set(v.memory_id, cos)
    }
    return scores
  }
}
