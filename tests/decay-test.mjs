// dsh-memory 短期记忆衰减自测：decay.js 移植验证
// 运行：node decay-test.mjs（在 dsh-memory 包目录下）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore, runShortTermDecay } from '../src/index.ts'

const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/decay-test-data'
import { rmSync, mkdirSync } from 'node:fs'
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()

const ctx = new Context()
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: DATA_DIR })
await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })

console.log('== 短期记忆衰减（decay.js 移植）测试 ==')
const store = await MemoryStore.open(ctx)

// 1. 构造 4 条不同年龄/权重的短期记忆
console.log('[1] 构造测试数据（4 条 daily 短期记忆）')
const a = await store.writeShortTerm('daily', '昨天的条目：本地模型部署', ['部署'], 1)
await store.updateShortTerm(a.id, { lastAccess: daysAgo(1) })
const b = await store.writeShortTerm('daily', '30天前的条目：记忆检索设计', ['检索'], 1)
await store.updateShortTerm(b.id, { lastAccess: daysAgo(30) })
const c = await store.writeShortTerm('daily', '100天前的条目：过期项目笔记', ['旧项目'], 1)
await store.updateShortTerm(c.id, { lastAccess: daysAgo(100) })
const d = await store.writeShortTerm('daily', '10天前的低权重条目', ['低权重'], 0.1)
await store.updateShortTerm(d.id, { lastAccess: daysAgo(10) })
check('写入 4 条', store.listShortTerm('daily').length === 4)

// 2. 执行衰减
console.log('[2] 执行 runShortTermDecay（默认参数 lambda=0.05 / threshold=0.15 / maxAge=90）')
const summary = await runShortTermDecay(store)
console.log(`  归档 ${summary.daily.archived.length} 条，保留 ${summary.daily.remaining} 条`)

// 3. 断言
console.log('[3] 断言')
check('归档 2 条（超龄 100 天 + 低权重 0.1）', summary.daily.archived.length === 2, `实际 ${summary.daily.archived.length}`)
check('保留 2 条（昨天 + 30 天）', summary.daily.remaining === 2, `实际 ${summary.daily.remaining}`)

const left = store.listShortTerm('daily')
const leftA = left.find(i => i.id === a.id)
const leftB = left.find(i => i.id === b.id)
check('昨天条目保留', leftA !== undefined)
check('昨天条目权重衰减 ≈ 0.951', leftA !== undefined && Math.abs(leftA.weight - Math.exp(-0.05)) < 0.01, `实际 ${leftA?.weight.toFixed(4)}`)
check('30天条目保留', leftB !== undefined)
check('30天条目权重衰减 ≈ 0.223', leftB !== undefined && Math.abs(leftB.weight - Math.exp(-0.05 * 30)) < 0.01, `实际 ${leftB?.weight.toFixed(4)}`)
check('100天条目已移除', left.find(i => i.id === c.id) === undefined)
check('低权重条目已移除', left.find(i => i.id === d.id) === undefined)

// 4. 归档落库：公共记忆新增（source=decay）
const archivedMemories = store.listAllPublicMemories().filter(m => m.source === 'decay')
console.log('[4] 归档落库检查')
check('公共记忆新增 2 条归档', archivedMemories.length === 2, `实际 ${archivedMemories.length}`)
check('归档带 decay-archive 标签', archivedMemories.every(m => m.tags.includes('decay-archive')))
check('归档保留原内容', archivedMemories.some(m => m.summary.includes('过期项目笔记')) && archivedMemories.some(m => m.summary.includes('低权重')))

await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
