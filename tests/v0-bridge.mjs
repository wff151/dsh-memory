// v0-bridge.mjs — V0 存储接入桥（通道 B：最小 cordis ctx）
// 模式照抄 tests/mem-test.mjs（已在 dsh-memory 包内验证可跑）：
//   new Context() + Storage + StorageJson + StorageDomain → MemoryStore.open(ctx)
// 本桥在 dsh-memory 包目录下，import 相对路径可正确解析 node_modules 依赖。
// 运行：由 multi-agent/v0/run.mjs 以绝对路径 import（tsx 转译 TS 源码）。
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore } from '../src/index.ts'
import { selectResumable, renderResumeBrief } from '../src/resume.ts'

/**
 * 打开一个最小 cordis ctx + 真实 JSON 落盘的 MemoryStore。
 * @param {string} dataDir 数据目录（跑前清空重建，保证 trace 间隔离）
 */
export async function openStore(dataDir) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: dataDir })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })
  const store = await MemoryStore.open(ctx)
  return { ctx, store }
}

/** 关闭 store 与 ctx（幂等）。 */
export async function closeStore({ store, ctx }) {
  try { await store.close() } catch { /* already closed */ }
  try { await ctx.dispose() } catch { /* already disposed */ }
}

/**
 * 把模型声明的 memory_writes 逐条写入真实 store。
 * note → updateNotebook（portable，黑板读回走这里）
 * remember → recordPublicMemory（public，声明了也写，但 V0 判据不依赖它）
 * @param {MemoryStore} store
 * @param {string} sessionId 每条 trace 独立 session，避免污染
 * @param {Array<{tool: string, params: object}>} writes
 */
export async function applyMemoryWrites(store, sessionId, writes) {
  for (const w of writes) {
    const p = w.params ?? {}
    if (w.tool === 'note') {
      await store.updateNotebook(sessionId, {
        goal: typeof p.goal === 'string' ? p.goal : undefined,
        issues: Array.isArray(p.issues) ? p.issues : undefined,
        result: typeof p.result === 'string' ? p.result : undefined,
        tags: Array.isArray(p.tags) ? p.tags : undefined,
      })
    } else if (w.tool === 'remember') {
      // 声明块 schema 无 mode 字段；V0 任务均为工作场景，固定 work。
      await store.recordPublicMemory({
        mode: 'work',
        title: (typeof p.goal === 'string' ? p.goal : 'v0-task').slice(0, 40),
        summary: (typeof p.result === 'string' ? p.result : typeof p.goal === 'string' ? p.goal : '').slice(0, 300),
        tags: Array.isArray(p.tags) ? p.tags : [],
        goal: typeof p.goal === 'string' ? p.goal : undefined,
        unresolved: Array.isArray(p.issues) ? p.issues : [],
        result: typeof p.result === 'string' ? p.result : undefined,
      })
    }
    // 其它 tool 值忽略（声明块协议只允许 note|remember）
  }
}

/**
 * 用真实 resume 渲染逻辑读回指定会话。
 * selectResumable / renderResumeBrief 是纯函数（无 ctx 依赖）。
 * @returns {{found: boolean, unresolved: string[], brief: string}}
 */
export function readResume(store, sessionId) {
  const doc = store.getPortableDoc(sessionId)
  if (doc === undefined) return { found: false, unresolved: [], brief: '' }
  const candidates = selectResumable([doc], { onlyUnresolved: true, limit: 1, recentLogCount: 3 })
  return {
    found: true,
    unresolved: [...doc.unresolvedProblems],
    brief: renderResumeBrief(candidates),
  }
}
