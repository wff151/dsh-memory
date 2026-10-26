// 记忆系统 v2 升级自测：短期状态/事件/任务上下文 + 防重做 + 反馈回路
// + 长期 taskId + 画像来源时间戳 + autorecord 归一化去重 + 向后兼容。
// 运行：node --import tsx/esm tests/upgrade-test.mjs（纯 Node，无 LLM）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  MemoryStore,
  autoRecordExchange,
  renderShortTermProjection,
  withIdempotency,
  idempotencyKeyOf,
} from '../src/index.ts'

const DATA_DIR = '../../../packages/.test-data/upgrade-data'
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

const store = await MemoryStore.open(ctx)

console.log('== 记忆系统 v2 升级测试 ==')

// 1. 当前状态 upsert
console.log('[1] 当前状态表（kind=state）')
const s1 = await store.upsertState('daily', { key: 'beans_stock', value: '5 袋', summary: '盘点后存量' })
check('状态写入 kind=state', s1.kind === 'state' && s1.entityKey === 'beans_stock')
check('状态 content 渲染', s1.content === 'beans_stock=5 袋')
const s2 = await store.upsertState('daily', { key: 'beans_stock', value: '4 袋', taskId: 'coffee_ops', sourceEventId: 'e_1' })
check('同 key 覆盖值', s2.entityValue === '4 袋')
check('覆盖保留 lastEventId', s2.lastEventId === 'e_1')
check('覆盖提权', s2.weight > s1.weight)
const s3 = await store.upsertState('daily', { key: 'milk_stock', value: '3 盒' })
check('不同 key 独立', s3.entityKey === 'milk_stock' && store.listShortTerm('daily').filter(i => i.kind === 'state').length === 2)

// 2. 事件 + 幂等
console.log('[2] 变更事件（kind=event）与幂等')
const e1 = await store.appendEvent('daily', {
  action: 'consume', target: 'beans_stock', before: '5', after: '4',
  idempotencyKey: idempotencyKeyOf('coffee_ops', 'consume', 'beans_stock'),
  taskId: 'coffee_ops', summary: '消耗 1 袋豆，存量 5→4',
})
check('事件写入 kind=event', e1.item.kind === 'event' && e1.item.eventStatus === 'success')
check('事件 content', e1.item.content === 'consume → beans_stock')
const e2 = await store.appendEvent('daily', {
  action: 'consume', target: 'beans_stock', idempotencyKey: idempotencyKeyOf('coffee_ops', 'consume', 'beans_stock'), summary: '重复',
})
check('同幂等键第二次 skipped', e2.skipped === true)
check('checkIdempotent 命中', store.checkIdempotent('daily', idempotencyKeyOf('coffee_ops', 'consume', 'beans_stock')) !== undefined)

// 3. 幂等执行包装
console.log('[3] withIdempotency 防重执行')
let ran = 0
const r1 = await withIdempotency(store, 'daily', 'op:deploy:pay', async () => { ran++; return 'ok' }, { action: 'deploy', target: 'pay', summary: '部署支付模块' })
const r2 = await withIdempotency(store, 'daily', 'op:deploy:pay', async () => { ran++; return 'ok' }, { action: 'deploy', target: 'pay' })
check('第一次执行', r1.skipped === false && r1.result === 'ok' && ran === 1)
check('第二次跳过', r2.skipped === true && ran === 1)

// 4. 任务上下文
console.log('[4] 任务上下文（kind=task）')
const t1 = await store.updateTaskContext('daily', 'coffee_ops', {
  goal: '维持咖啡店运营', phase: '日常补货',
  pending: ['检查牛奶库存', '决定是否补豆'], completed: ['盘点豆库存'], blockedBy: [],
})
check('任务写入 kind=task', t1.kind === 'task' && t1.entityKey === 'coffee_ops')
check('任务投影文本', t1.content.includes('目标：维持咖啡店运营') && t1.content.includes('待办：检查牛奶库存'))
const t2 = await store.updateTaskContext('daily', 'coffee_ops', { completed: ['盘点豆库存', '消耗 1 袋豆'], pending: ['决定是否补豆'] })
check('任务更新覆盖', !t2.content.includes('检查牛奶库存') && t2.content.includes('已完成：盘点豆库存、消耗 1 袋豆'))

// 5. 短期投影渲染
console.log('[5] 短期投影（renderShortTermProjection）')
const projection = renderShortTermProjection(store, 'daily')
check('投影含任务', projection.includes('[当前任务]'))
check('投影含状态', projection.includes('[当前状态]') && projection.includes('beans_stock=4 袋'))
check('投影含事件', projection.includes('[最近变更]') && projection.includes('消耗 1 袋豆'))
const projectionEmpty = renderShortTermProjection(store, 'work')
check('无内容返回空串', projectionEmpty === '')

// 6. 反馈回路
console.log('[6] 反馈回路（引用提权）')
const stBefore = s2.weight
const bumped = await store.bumpShortRefCount(s2.id, 1)
check('短期 refCount 提升', bumped?.refCount === 1)
check('短期提权', bumped !== undefined && bumped.weight > stBefore)
const pubBefore = await store.recordPublicMemory({ mode: 'daily', title: '反馈回路测试', summary: '用于 bumpPublicRefCount 验证', tags: ['test'] })
const pubBumped = await store.bumpPublicRefCount(pubBefore.memory_id)
check('长期 refCount 提升', pubBumped?.refCount === 1)

// 7. 长期记忆 taskId
console.log('[7] 长期记忆 taskId 关联')
const taskRec = await store.recordPublicMemory({
  mode: 'work', title: '支付模块迁移', summary: '阶段一完成，双写校验通过', tags: ['支付'],
  taskId: 'task_pay_migrate', taskPhase: 'stage1',
})
check('taskId 写入', taskRec.taskId === 'task_pay_migrate' && taskRec.taskPhase === 'stage1')
check('taskId 可检索', store.listPublicMemories('work').some(m => m.taskId === 'task_pay_migrate'))

// 8. 画像来源时间戳
console.log('[8] 用户画像来源与时间戳')
const p1 = await store.setPermanent('daily', 'preferences.喜欢', '本地大模型')
check('画像 sources 记录', p1.sources?.['preferences.喜欢']?.updatedAt !== undefined)
const p2 = await store.setPermanent('daily', 'preferences.喜欢', '推理模型')
const src2 = p2.sources?.['preferences.喜欢']
check('覆盖保留旧值链', Array.isArray(src2?.prev) && src2.prev.length === 1)
check('覆盖后当前值为新值', p2.preferences['喜欢'] === '推理模型')
check('历史值仍可从 prev 找回', src2.prev[0].value === '本地大模型')

// 9. autorecord 归一化去重
console.log('[9] autorecord：归一化去重（不误吞同标题不同内容）')
const a1 = await autoRecordExchange(store, 'sess-a', '把数据导出功能做好，用户只给了需求，未给格式。', { short: true, long: true, portable: false })
check('首次写入长期', a1.long === true)
const a2 = await autoRecordExchange(store, 'sess-a', '把数据导出功能做好，用户只给了需求，未给格式。', { short: true, long: true, portable: false })
check('同内容重复被去重', a2.long === false)
const a3 = await autoRecordExchange(store, 'sess-a', '把数据导出功能做好，但用户补充了 CSV 与 JSON 两种格式，接口走内部 API。', { short: true, long: true, portable: false })
check('同标题不同内容不误吞', a3.long === true)
check('短期写入带 kind=fact', store.listShortTerm('daily').some(i => i.kind === 'fact'))

// 10. 向后兼容：旧格式（无 kind 字段）条目可读
console.log('[10] 向后兼容（旧记录无新字段）')
// writeShortTerm 不传 kind 即产生旧格式条目（kind 缺省 undefined）
const legacy = await store.writeShortTerm('daily', '旧格式消息副本', ['old'])
check('旧条目可读', legacy !== undefined && legacy.kind === undefined)
const projectionAfterLegacy = renderShortTermProjection(store, 'daily')
check('旧条目不进投影', !projectionAfterLegacy.includes('旧格式消息副本'))

await store.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
