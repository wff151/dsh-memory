// dsh-memory 反思循环（拉→炼→存）自测
// 运行：node reflection-test.mjs（在 dsh-memory 包目录下）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore, collectReflectionMaterial, runPeriodicReflection, REFLECTION_TEMPLATE } from '../src/index.ts'

const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/reflection-test-data'
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

console.log('== 反思循环（拉→炼→存）测试 ==')
const store = await MemoryStore.open(ctx)

// 1. 空库：无素材应跳过
console.log('[1] 空库周期反思')
const r0 = await runPeriodicReflection(store)
check('无素材时跳过', r0.skipped === true)
check('无反思记录写入', store.listEvolution('reflection').length === 0)

// 2. 造素材
console.log('[2] 构造近 1 天素材')
await store.recordPublicMemory({ mode: 'daily', title: '双目测距光照记录A', summary: '户外强光下测距偏差', tags: ['视觉测量'] })
await store.recordPublicMemory({ mode: 'daily', title: '双目测距光照记录B', summary: '调整曝光后改善', tags: ['视觉测量', '光照'] })
await store.recordPublicMemory({ mode: 'work', title: '清洗鱼缸维护', summary: '周末清理过滤设备', tags: ['家务'] })
await store.writeShortTerm('daily', '用户关注偏振去散射', ['视觉测量'])
await store.writeShortTerm('work', '待校准相机参数', ['视觉测量'])
for (let i = 0; i < 2; i++) {
  await store.appendEvolution({
    type: 'error-log', id: `ERR_t_${i}`, timestamp: new Date().toISOString(),
    task: '双目测距', fingerprint: '流程遗漏:视觉测量:光照条件', detail: `第${i + 1}次`,
  })
}
await store.appendEvolution({
  type: 'proposal', id: `PROP_t_1`, timestamp: new Date().toISOString(),
  triggerFingerprint: '流程遗漏:视觉测量:光照条件', status: 'pending', description: '建议先查光照', newRule: '',
})
await store.recordExchange('sess_refl_1', '今天在做测距实验', { unresolved: ['相机曝光参数尚未固定'] })

// 3. 拉取素材
console.log('[3] collectReflectionMaterial（windowDays=1）')
const m = collectReflectionMaterial(store, { windowDays: 1 })
check('新增公共记忆 3 条', m.newPublicCount === 3, `实际 ${m.newPublicCount}`)
check('短期记忆快照 2 条', m.shortTermCount === 2, `实际 ${m.shortTermCount}`)
check('失败指纹计数 2', m.errorFingerprints['流程遗漏:视觉测量:光照条件'] === 2)
check('新增提案 1 条', m.newProposalCount === 1, `实际 ${m.newProposalCount}`)
check('未解决项汇总', m.unresolved.includes('相机曝光参数尚未固定'))
const vt = m.topTags.find(t => t.tag === '视觉测量')
check('高频标签 视觉测量 居首且计数 4', vt !== undefined && vt.count === 4, `实际 ${JSON.stringify(m.topTags)}`)
check('系统标签已排除', !m.topTags.some(t => ['auto-record', 'periodic', 'auto'].includes(t.tag)))

// 4. 周期反思落库
console.log('[4] runPeriodicReflection')
const r1 = await runPeriodicReflection(store, { windowDays: 1 })
check('生成反思（未跳过）', r1.skipped === false && r1.record !== undefined)
check('记录类型 reflection', r1.record?.type === 'reflection')
check('带 periodic+auto 标签', r1.record?.tags.includes('periodic') && r1.record.tags.includes('auto'))
check('observation 含新增量', String(r1.record?.observation).includes('新增公共记忆 3 条'))
check('observation 含失败指纹', String(r1.record?.observation).includes('光照条件'))
check('observation 含未解决项', String(r1.record?.observation).includes('相机曝光参数尚未固定'))
check('analysis 留空（不编造归因）', r1.record?.analysis === '')

// 5. 幂等：当天重复跳过
console.log('[5] 当天幂等')
const r2 = await runPeriodicReflection(store, { windowDays: 1 })
check('重复调用跳过', r2.skipped === true)
check('仍只有 1 条反思', store.listEvolution('reflection').length === 1)

// 6. 模板常量存在且含五步骤
console.log('[6] 反思模板')
check('模板含 5 个步骤', ['1.', '2.', '3.', '4.', '5.'].every(s => REFLECTION_TEMPLATE.includes(s)))
check('模板要求基于真实记录', REFLECTION_TEMPLATE.includes('真实记录'))

await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
