// dsh-memory 真向量语义检索端到端自测
// 依赖一个 OpenAI 兼容 /v1/embeddings 服务：
//   EMBED_BASE / EMBED_MODEL 可覆盖；默认本机 8081 的 qwen2-0.5b（--embedding --pooling mean）
// 运行：node vector-test.mjs（在 dsh-memory 包目录下）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  MemoryStore, VectorStore, createEmbeddingClient, SemanticService,
  searchPublicMemory, searchPublicMemoryVector,
} from '../src/index.ts'
import { rmSync, mkdirSync } from 'node:fs'

const BASE = process.env.EMBED_BASE ?? 'http://127.0.0.1:8081/v1'
const MODEL = process.env.EMBED_MODEL ?? 'qwen2-0.5b-embed'
const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/vector-test-data'
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

const ctx = new Context()
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: DATA_DIR })
await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })

console.log('== 真向量语义检索测试 ==')
console.log(`embedding: ${BASE} model=${MODEL}`)
const store = await MemoryStore.open(ctx)
const vectors = await VectorStore.open(ctx)

// ── 4 条主题可区分的公共记忆 ──────────────────────────────
const A = await store.recordPublicMemory({ mode: 'daily', title: '偏振水下图像增强', summary: '偏振去散射算法提升水下图像对比度', tags: ['视觉测量'] })
const B = await store.recordPublicMemory({ mode: 'daily', title: '清洗鱼缸', summary: '周末清洗鱼缸更换过滤棉', tags: ['家务'] })
const C = await store.recordPublicMemory({ mode: 'daily', title: '双目视觉测距', summary: '双目视觉测距在强逆光下测量误差变大', tags: ['视觉测量'] })
const D = await store.recordPublicMemory({ mode: 'work', title: '显卡驱动花屏', summary: '安装新的显卡驱动解决花屏问题', tags: ['电脑'] })
const id = e => e.memory_id

const client = createEmbeddingClient({ baseURL: BASE, model: MODEL, timeoutMs: 20000 })
const sem = new SemanticService(client, vectors, { minScore: 0.3, batchSize: 8, cooldownMs: 5000 })

console.log('[1] 健康探测')
const healthy = await sem.probe()
check('embedding 服务可用', healthy === true)
if (!healthy) {
  console.log('  ! embedding 服务不可用，跳过向量断言（仅验证不崩溃）')
  await vectors.close(); await store.close()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
}

console.log('[2] 全量建索引')
const s1 = await sem.syncIndex(store)
check('首次索引 4 条', s1.indexed === 4, `indexed=${s1.indexed}`)
check('服务可用标记', s1.available === true)
check('向量表 4 条', vectors.list().length === 4)
const dims = new Set(vectors.list().map(v => v.vector.length))
check('所有向量等长且非空', dims.size === 1 && vectors.list()[0].vector.length > 100, `dims=${[...dims]}`)
check('记录了 embedding 模型', vectors.list()[0].model === MODEL)

console.log('[3] 索引幂等（内容 hash）')
const s2 = await sem.syncIndex(store)
check('二次无重建', s2.indexed === 0, `indexed=${s2.indexed}`)
check('二次全部跳过', s2.skipped === 4, `skipped=${s2.skipped}`)
const reOk = await sem.indexOne(C)
check('单条重复索引成功（覆盖）', reOk === true)
check('向量表仍 4 条', vectors.list().length === 4)

console.log('[4] 真语义 vs 关键词（关键对照）')
// Q2：问测距/阳光，字面与"双目/逆光/测距"几无 bigram 重合
const Q2 = '想测物体距离但阳光太强不准'
const kw2 = searchPublicMemory(store, Q2)
check('关键词对 Q2 零召回', kw2.results.length === 0, `kw=${kw2.results.length}`)
const v2 = await searchPublicMemoryVector(store, Q2, { semantic: sem })
check('Q2 走向量路径', v2.usedVectors === true)
check('Q2 向量正确召回', v2.results.length > 0)
check('Q2 top1 = 双目测距（语义近）', v2.results[0]?.item.memory_id === id(C),
  `top1=${v2.results[0]?.item.title}`)
check('Q2 top1 带向量分', typeof v2.results[0]?.scores.vector === 'number' && v2.results[0].scores.vector > 0)

// Q3：问鱼/清理，字面与"清洗鱼缸/过滤棉"无 bigram 重合
const Q3 = '家里养的鱼多久清理一次'
const kw3 = searchPublicMemory(store, Q3)
check('关键词对 Q3 零召回', kw3.results.length === 0, `kw=${kw3.results.length}`)
const v3 = await searchPublicMemoryVector(store, Q3, { semantic: sem })
check('Q3 top1 = 清洗鱼缸（语义近）', v3.results[0]?.item.memory_id === id(B),
  `top1=${v3.results[0]?.item.title}`)
// 不相关项不应排到最前
check('Q3 显卡条不在 top1', v3.results[0]?.item.memory_id !== id(D))

console.log('[5] 标签/时间精确命中仍保留（与向量融合）')
const Q4 = '视觉测量'
const v4 = await searchPublicMemoryVector(store, Q4, { semantic: sem, topK: 4 })
const topTags = new Set([v4.results[0]?.item.memory_id, v4.results[1]?.item.memory_id])
check('标签精确命中把视觉测量两条顶到前二', topTags.has(id(A)) && topTags.has(id(C)),
  `前二=${[...topTags].map(x => x).join(',')}`)

console.log('[6] 优雅回退（死端点）')
const dead = new SemanticService(
  createEmbeddingClient({ baseURL: 'http://127.0.0.1:59999/v1', model: 'x', timeoutMs: 800 }),
  vectors, { minScore: 0.3, cooldownMs: 1000 },
)
check('死端点探测失败', (await dead.probe()) === false)
const fb = await searchPublicMemoryVector(store, '鱼缸 过滤', { semantic: dead })
check('死端点回退关键词（usedVectors=false）', fb.usedVectors === false)
check('回退仍能靠字面召回鱼缸条', fb.results.some(r => r.item.memory_id === id(B)),
  `n=${fb.results.length}`)

console.log('[7] 孤儿向量清理')
await vectors.put({ memory_id: 'mem_orphan_xxx', model: MODEL, hash: 'dead', vector: [0.1, 0.2, 0.3] })
check('放入孤儿后 5 条', vectors.list().length === 5)
const s3 = await sem.syncIndex(store)
check('清理孤儿 1 条', s3.pruned === 1, `pruned=${s3.pruned}`)
check('回到 4 条', vectors.list().length === 4)

console.log('[8] 无 semantic 时退化为纯关键词')
const plain = await searchPublicMemoryVector(store, '显卡 花屏')
check('未传 semantic：usedVectors=false', plain.usedVectors === false)
check('字面召回显卡条', plain.results.some(r => r.item.memory_id === id(D)))

await vectors.close()
await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
