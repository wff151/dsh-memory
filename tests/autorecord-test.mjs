// dsh-memory auto-record 双写自测：短期 + 长期 + 随身文档
// 运行：node autorecord-test.mjs（在 dsh-memory 包目录下）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore, autoRecordExchange } from '../src/index.ts'

const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/autorecord-test-data'
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

console.log('== auto-record 双写测试 ==')
const store = await MemoryStore.open(ctx)
const sessionId = 'sess_autorecord_test'

// 1. 三条消息：完整消息 / 重复消息（测长期去重+短期提权）/ 过短消息（测长期门槛）
console.log('[1] 注入 3 条用户消息')
const m1 = '用户对 gemma4-v2 本地部署感兴趣，想用小模型做记忆系统测试'
const r1 = await autoRecordExchange(store, sessionId, m1)
const r2 = await autoRecordExchange(store, sessionId, m1) // 重复内容
const r3 = await autoRecordExchange(store, sessionId, '短') // < 20 字符
check('首次消息三写', r1.short === true && r1.long === true && r1.portable === true)
check('重复消息长期去重', r2.long === false)
check('过短消息不写长期', r3.long === false)

// 2. 断言三层落库
console.log('[2] 短期记忆')
const short = store.listShortTerm('daily')
check('短期 2 条（m1 合并 + 短消息）', short.length === 2, `实际 ${short.length}`)
const boosted = short.find(s => s.content.includes('gemma4-v2'))
check('重复消息短期提权 weight=1.3', boosted !== undefined && Math.abs(boosted.weight - 1.3) < 0.01, `实际 ${boosted?.weight.toFixed(2)}`)
check('短期带 auto-record 标签', boosted?.tags.includes('auto-record'))

console.log('[3] 长期公共记忆')
const pub = store.listAllPublicMemories()
check('公共记忆 1 条（去重生效）', pub.length === 1, `实际 ${pub.length}`)
check('公共记忆来源 auto-record', pub[0]?.source === 'auto-record')
check('公共记忆摘要保留内容', pub[0]?.summary.includes('gemma4-v2'))

console.log('[4] 随身文档')
const doc = store.getPortableDoc(sessionId)
check('随身文档存在', doc !== undefined)
check('随身文档 3 次交换', doc?.exchangeCount === 3, `实际 ${doc?.exchangeCount}`)
check('随身文档记录第一条消息', doc?.log.some(l => l.user.includes('gemma4-v2')))

console.log('[5] 分层开关')
await autoRecordExchange(store, 'sess_off_test', '这是一条只写短期的消息内容足够长满足阈值', { long: false, portable: false })
const offShort = store.listShortTerm('daily')
check('关 long+portable 后短期仍写', offShort.length === 3, `实际 ${offShort.length}`)
const offPub = store.listAllPublicMemories()
check('关 long 后公共记忆不增', offPub.length === 1)

await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
