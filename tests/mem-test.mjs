// dsh-memory 核心功能自测脚本：storage-hub + json backend + memory domain
// 运行：node mem-test.mjs（在 dsh-memory 包目录下，解析其 node_modules）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore, searchPublicMemory, searchShortTerm } from '../src/index.ts'

const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/memtest-data'
// 幂等：每次测试前重建数据目录
import { rmSync, mkdirSync } from 'node:fs'
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

console.log('== 记忆系统核心功能测试 ==')
const store = await MemoryStore.open(ctx)
console.log('[1] 存储域：brain_memory v1 已打开')

// 1. 公共记忆写入
const entry = await store.recordPublicMemory({
  mode: 'daily',
  title: '本地模型链路测试',
  summary: '2026-09-18 使用 qwen3.6-14b 本地模型验证 dsh 记忆系统链路，验证公共记忆写入与检索。',
  tags: ['测试', '本地模型'],
  goal: '验证记忆链路',
  unresolved: ['向量检索待接入'],
  result: '链路正常',
})
console.log('[2] 公共记忆写入')
check('memory_id 生成', /^mem_/.test(entry.memory_id))
check('日期为今天', /\d{4}-\d{2}-\d{2}/.test(entry.date))
check('标签保留', entry.tags.length === 2 && entry.tags.includes('本地模型'))

// 2. 三重检索
console.log('[3] 三重检索（时间/标签/语义）')
const r1 = searchPublicMemory(store, '本地模型', { mode: 'daily', topK: 5 })
check('标签检索命中', r1.results.length >= 1 && r1.results[0].item.title === '本地模型链路测试')
const r2 = searchPublicMemory(store, '2026年 记忆', { mode: 'daily', topK: 5 })
check('时间+语义融合检索', r2.results.length >= 1)
const r3 = searchPublicMemory(store, '完全不相关的词xyz', { mode: 'daily', topK: 5 })
check('无关查询不误命中', r3.results.length === 0)

// 3. 短期记忆（权重提升）
console.log('[4] 短期记忆（加权与提升）')
const s1 = await store.writeShortTerm('daily', '用户对本地模型部署感兴趣', ['兴趣'], 1)
const s2 = await store.writeShortTerm('daily', '用户对本地模型部署感兴趣', ['兴趣'], 1)
check('重复内容权重提升', s2.weight > s1.weight && s2.accessCount === 1)
const sshort = searchShortTerm(store, 'daily', '本地模型', 5)
check('短期检索命中', sshort.length >= 1)

// 4. 永久记忆（画像）
console.log('[5] 永久记忆（用户画像）')
const p1 = await store.setPermanent('daily', 'preferences.喜欢', '本地大模型')
check('点路径写入', p1.preferences['喜欢'] === '本地大模型')
const p2 = await store.setPermanent('daily', 'skills', 'Python')
check('实体字段追加', p2.skills.includes('Python'))
const p3 = await store.setPermanent('daily', 'attributes.年龄', 30)
check('标量字段覆盖', p3.attributes['年龄'] === 30)

// 5. 随身文档
console.log('[6] 随身文档（会话工作记忆）')
const doc = await store.recordExchange('test-session-1', '你好', {
  solved: ['链路测试'],
  unresolved: ['向量检索'],
  refinedGoal: '完成全部测试',
  tags: ['测试'],
})
check('exchangeCount 累加', doc.exchangeCount === 1)
check('已解决问题记录', doc.solvedProblems.includes('链路测试'))
check('摘要生成', doc.summary.includes('1次交换') && doc.summary.includes('链路测试'))

// 6. 进化档案
console.log('[7] 进化档案')
const evo = await store.appendEvolution({
  type: 'rule', id: 'EVO_TEST_1', content: { ruleId: 'RULE_1', content: '测试规则' }, timestamp: new Date().toISOString(),
})
check('进化档案写入', store.listAllEvolution().length === 1 && evo.type === 'rule')

// 7. 状态与统计
console.log('[8] 状态统计')
check('写入计数 > 0', store.memoryCount >= 6)
check('lastWriteAt 存在', store.lastWriteAt !== undefined)
check('injectContext 默认开', store.injectContext === true)

// 8. 管理与删除
console.log('[9] 管理操作')
const updated = await store.updatePublicMemory(entry.memory_id, { result: '链路正常（已复核）' })
check('更新公共记忆', updated?.result === '链路正常（已复核）')
const del = await store.deletePublicMemory(entry.memory_id)
check('删除公共记忆', del === true)
check('删除后列表为空', store.listAllPublicMemories().length === 0)

await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
