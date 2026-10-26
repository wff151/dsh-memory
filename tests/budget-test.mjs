// dsh-memory 检索预算分级（按重要性分配注意力/短期内存预算）自测
// 默认走纯关键词路径保证断言确定；若本机 8081 embedding 在线，追加向量路径断言。
// 运行：node budget-test.mjs（在 dsh-memory 包目录下）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  MemoryStore, createEmbeddingClient, SemanticService,
  estimateTokens, inferImportance, resolveBudget,
  searchWithBudget, renderBudgetedContext,
} from '../src/index.ts'
import { rmSync, mkdirSync } from 'node:fs'

const BASE = process.env.EMBED_BASE ?? 'http://127.0.0.1:8081/v1'
const MODEL = process.env.EMBED_MODEL ?? 'qwen2-0.5b-embed'
const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/budget-test-data'
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

console.log('== 检索预算分级测试 ==')
const store = await MemoryStore.open(ctx)

// 主题记忆
const M1 = await store.recordPublicMemory({ mode: 'daily', title: '偏振去散射实验', summary: '偏振片旋转正交消除水体后向散射提升清晰度', tags: ['视觉测量', '偏振', '水下'] })
const M2 = await store.recordPublicMemory({ mode: 'daily', title: '双目相机标定', summary: '棋盘格标定双目内外参用于测距', tags: ['视觉测量', '标定', '相机'] })
await store.recordPublicMemory({ mode: 'daily', title: '周末做饭记录', summary: '尝试做了红烧肉和清炒时蔬', tags: ['家务', '烹饪'] })
const W1 = await store.recordPublicMemory({ mode: 'work', title: '服务器部署脚本', summary: '编写 pm2 守护与日志切割部署流程', tags: ['运维', '部署'] })
// 级联专用：标签词不出现在正文，只能靠标签弱命中（tag=1/3 → 融合≈0.10）
const T1 = await store.recordPublicMemory({ mode: 'daily', title: '阿尔法事项', summary: '一些与标签字面无关的内容描述甲', tags: ['分类甲'] })
await store.recordPublicMemory({ mode: 'daily', title: '贝塔事项', summary: '一些与标签字面无关的内容描述乙', tags: ['分类乙'] })
await store.recordPublicMemory({ mode: 'daily', title: '伽马事项', summary: '一些与标签字面无关的内容描述丙', tags: ['分类丙'] })
// 截断专用：4 条强相关长摘要
for (let i = 0; i < 4; i++) {
  await store.recordPublicMemory({
    mode: 'daily', title: `截断探针记录${i}`,
    summary: `截断探针专项内容，这是一段用于撑满短期内存预算的较长中文描述，编号${i}，包含足够多的字符以超过很小的 token 上限。`,
    tags: ['截断'],
  })
}

console.log('[1] estimateTokens（确定性近似）')
check('中文按字 + 英文 ceil(L/4)', estimateTokens('你好world') === 2 + Math.ceil(5 / 4), `得 ${estimateTokens('你好world')}`)
check('纯英文 8 字符 = 2', estimateTokens('abcdefgh') === 2)
check('空串 0', estimateTokens('') === 0)

console.log('[2] inferImportance（措辞推断默认档）')
check('不可逆+必须 → high', inferImportance('这个删除操作不可逆，必须先备份') === 'high')
check('随便看看 → low', inferImportance('随便看看有没有有趣的') === 'low')
check('普通技术问题 → normal', inferImportance('如何配置 eslint 规则') === 'normal')
check('安全线索优先于随意措辞', inferImportance('紧急处理一下，顺便带杯咖啡') === 'high')

console.log('[3] resolveBudget（三档预算）')
const bh = resolveBudget('high', 'daily')
check('high 强制跨模式 both', bh.mode === 'both', `mode=${bh.mode}`)
check('high topK=8 召回优先', bh.topK === 8)
check('high 不放弃', bh.giveUpWhenEmpty === false)
const bn = resolveBudget('normal', 'work')
check('normal 尊重指定模式 work', bn.mode === 'work')
check('normal 开启级联', bn.cascade === true && bn.topK === 5)
const bl = resolveBudget('low')
check('low 高阈值/小窗/可放弃', bl.roundMin === 0.4 && bl.topK === 3 && bl.giveUpWhenEmpty === true && bl.maxTokens === 400)

console.log('[4] high：跨模式全量召回')
const rh = await searchWithBudget(store, '部署', { importance: 'high', mode: 'daily' })
check('high 即使指定 daily 也召回 work 条', rh.results.some(r => r.item.memory_id === W1.memory_id))
check('single 全量轮', rh.matchedPass === 'high-exhaustive' && rh.passes.length === 1)
check('无向量时 usedVectors=false', rh.usedVectors === false)

console.log('[5] low：最小预算 + 满足性放弃')
const rl0 = await searchWithBudget(store, '火星殖民经济学', { importance: 'low' })
check('完全不相关 → 空结果', rl0.results.length === 0)
check('gaveUp=true', rl0.gaveUp === true)
check('low 单轮不级联', rl0.passes.length === 1 && rl0.matchedPass === 'low-minimal')
const rl1 = await searchWithBudget(store, '偏振', { importance: 'low' })
check('强相关在高阈下仍能命中（非一律空）', rl1.results.some(r => r.item.memory_id === M1.memory_id),
  `n=${rl1.results.length}`)

console.log('[6] normal：未命中逐级放宽，全量兜底')
const rn = await searchWithBudget(store, '分类甲 分类乙 分类丙 如何排序', { importance: 'normal', mode: 'daily' })
check('strict 轮零命中（0.10 < 0.15）', rn.passes[0].stage === 'strict' && rn.passes[0].hits === 0)
check('no-time 轮仍零命中', rn.passes[1].hits === 0)
check('最终在全量兜底轮召回', rn.matchedPass === 'full-fallback' && rn.results.length > 0,
  `matched=${rn.matchedPass}, n=${rn.results.length}`)
check('级联跑满 4 轮', rn.passes.length === 4)
check('兜底命中含 T1', rn.results.some(r => r.item.memory_id === T1.memory_id))

console.log('[7] token 预算硬顶（短期内存预算，软顶：至少保留最强 1 条）')
const rt = await searchWithBudget(store, '截断探针', { importance: 'high', maxTokens: 30 })
check('4 条候选受 30-token 顶约束只留 1 条', rt.results.length === 1, `留 ${rt.results.length}`)
check('truncated=true（其余候选被预算挡住）', rt.truncated === true)
check('tokensUsed 已报告（首条为软顶保留，用量已超顶）', rt.tokensUsed >= 30, `used=${rt.tokensUsed}`)

console.log('[8] 渲染审计行')
const th = renderBudgetedContext(rh)
check('high 文本标注全量召回与命中轮次', th.includes('高·全量召回') && th.includes('high-exhaustive'))
const tl = renderBudgetedContext(rl0)
check('low 空结果标注满足性原则', tl.includes('满足性'))

console.log('[9] 可选：真实 embedding 在线时走向量路径')
const probeClient = createEmbeddingClient({ baseURL: BASE, model: MODEL, timeoutMs: 30000 })
const probeSem = new SemanticService(probeClient, await (async () => {
  // 复用一个轻量向量库：直接打开独立域
  const { VectorStore } = await import('../src/index.ts')
  return VectorStore.open(ctx)
})(), { minScore: 0.3, batchSize: 4, cooldownMs: 2000 })
if (await probeSem.probe()) {
  await probeSem.syncIndex(store)
  const rv = await searchWithBudget(store, '想测物体距离但阳光太强不准', { importance: 'normal', semantic: probeSem })
  check('向量路径 usedVectors=true', rv.usedVectors === true)
  check('语义近邻被召回', rv.results.length > 0)
  check('语义检索命中双目/测距相关条', rv.results.some(r => r.item.memory_id === M2.memory_id),
    `top=${rv.results[0]?.item.title}`)
} else {
  console.log('  - embedding 服务不可用，跳过向量断言')
}

await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
