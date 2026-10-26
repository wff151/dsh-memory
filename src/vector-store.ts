/**
 * Typed handle over the dedicated {@link vectorDomainSpec} domain. Stores one
 * embedding vector per public memory id. It is a sibling of {@link MemoryStore},
 * not a part of it, so the semantic index can be disabled, rebuilt or wiped
 * without affecting any memory record.
 * @module dsh-memory/src/vector-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { vectorDomainSpec } from './domain.ts'
import type { MemoryId } from './types.ts'
import type { VectorIndexRecord } from './domain.ts'

/** Read/write handle to the vector table. */
export class VectorStore {
  private domain: Domain<typeof vectorDomainSpec> | undefined
  private table: KvTable<MemoryId, VectorIndexRecord> | undefined

  private constructor() {}

  /** Open the vector domain and resolve its table handle. */
  static async open(ctx: Context): Promise<VectorStore> {
    const store = new VectorStore()
    const domain = await ctx.storageDomain.open(vectorDomainSpec)
    store.domain = domain
    store.table = domain.table('vectors')
    return store
  }

  /** Close the domain, draining queued writes. Idempotent. */
  async close(): Promise<void> {
    await this.domain?.close()
    this.domain = undefined
    this.table = undefined
  }

  private requireTable(): KvTable<MemoryId, VectorIndexRecord> {
    if (this.table === undefined) throw new Error('dsh-memory vector store is not open')
    return this.table
  }

  /** Read one indexed vector, or `undefined` when absent. */
  get(memoryId: MemoryId): VectorIndexRecord | undefined {
    return this.requireTable().get(memoryId)
  }

  /** Upsert one vector index entry. */
  async put(record: VectorIndexRecord): Promise<void> {
    await this.requireTable().put(record.memory_id, record)
  }

  /** Remove one vector (e.g. when its source memory is deleted). */
  async delete(memoryId: MemoryId): Promise<void> {
    await this.requireTable().delete(memoryId)
  }

  /** Enumerate every stored vector. */
  list(): VectorIndexRecord[] {
    return [...this.requireTable().entries()].map(([, record]) => record)
  }

  /** Number of indexed vectors. */
  get size(): number {
    return this.list().length
  }
}
