// dsh-memory 失败指纹阈值→提案 自测（原型 countErrorFingerprints/createProposal 移植）
// 运行：node evolution-test.mjs（在 dsh-memory 包目录下）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore, countErrorFingerprints, maybeCreateProposals } from '../src/index.ts'

const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/evolution-test-data'
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

console.log('== 失败指纹阈值 → 提案（evolution 移植）测试 ==')
const store = await MemoryStore.open(ctx)

// 1. 写入错题日志：指纹A × 3，指纹B × 1
console.log('[1] 写入错题日志')
for (let i = 0; i < 3; i++) {
  await store.appendEvolution({
    type: 'error-log',
    id: `ERR_${Date.now().toString(36)}_${i}`,
    timestamp: new Date().toISOString(),
    task: '双目测距',
    fingerprint: '流程遗漏:视觉测量:光照条件',
    detail: `第 ${i + 1} 次光照条件未记录`,
  })
}
await store.appendEvolution({
  type: 'error-log',
  id: `ERR_${Date.now().toString(36)}_b`,
  timestamp: new Date().toISOString(),
  task: '清洗鱼缸',
  fingerprint: '操作遗漏:设备:电源未关',
  detail: '一次偶然失败',
})
check('错题日志 4 条', store.listEvolution('error-log').length === 4)

// 2. 指纹计数
console.log('[2] countErrorFingerprints（90 天窗口）')
const counts = countErrorFingerprints(store, 90)
check('指纹A 计数 3', counts['流程遗漏:视觉测量:光照条件'] === 3, `实际 ${counts['流程遗漏:视觉测量:光照条件']}`)
check('指纹B 计数 1', counts['操作遗漏:设备:电源未关'] === 1, `实际 ${counts['操作遗漏:设备:电源未关']}`)

// 3. 阈值升级（threshold=2）
console.log('[3] maybeCreateProposals（threshold=2, windowDays=90）')
const r1 = await maybeCreateProposals(store, { threshold: 2, windowDays: 90 })
check('生成 1 条提案（仅指纹A）', r1.proposals.length === 1, `实际 ${r1.proposals.length}`)
check('跳过 0 个指纹', r1.skipped.length === 0)
const prop = r1.proposals[0]
check('提案类型 proposal', prop?.type === 'proposal')
check('提案 triggerFingerprint 正确', prop?.triggerFingerprint === '流程遗漏:视觉测量:光照条件')
check('提案状态 pending', prop?.status === 'pending')
check('提案描述含计数', String(prop?.description).includes('3 次'))

// 4. 重复扫描：不重复生成
console.log('[4] 重复扫描（已有未处理提案）')
const r2 = await maybeCreateProposals(store, { threshold: 2, windowDays: 90 })
check('不重复生成', r2.proposals.length === 0, `实际 ${r2.proposals.length}`)
check('指纹A 被跳过', r2.skipped.includes('流程遗漏:视觉测量:光照条件'))

// 5. 阈值=1 时指纹B 也触发
console.log('[5] 阈值=1（指纹B 也应触发）')
const r3 = await maybeCreateProposals(store, { threshold: 1, windowDays: 90 })
check('指纹B 生成提案', r3.proposals.length === 1 && r3.proposals[0]?.triggerFingerprint === '操作遗漏:设备:电源未关')

await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
