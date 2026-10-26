// 断点续跑（跨会话语义 checkpoint / resume）自测：纯函数 + store 集成，无需 LLM
// 运行：node --import tsx/esm resume-test.mjs（在 dsh-memory 包目录下）
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  MemoryStore,
  docLastActiveMs,
  isResumable,
  selectResumable,
  findResumableSessions,
  renderResumeBrief,
  renderResumeHint,
  renderMemoryContext,
} from '../src/index.ts'
import { rmSync, mkdirSync } from 'node:fs'

const DATA_DIR = 'E:/ys-dsh/dsh-brain-plugins/.test-data/resume-data'
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

const NOW = Date.parse('2026-09-20T12:00:00.000Z')
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()
function doc(p = {}) {
  return {
    sessionId: 's',
    title: '新建对话',
    mode: 'daily',
    goal: '',
    exchangeCount: 1,
    solvedProblems: [],
    unresolvedProblems: [],
    progress: [],
    result: '',
    nextSteps: [],
    summary: '',
    tags: [],
    log: [],
    ...p,
  }
}
const log = (turn, user, ms) => ({ turn, user, time: iso(ms) })

console.log('== 断点续跑（跨会话语义恢复）测试 ==')

console.log('[1] isResumable 保守判定（默认需有未解决问题）')
check('有未解决→可续', isResumable(doc({ unresolvedProblems: ['x'] })) === true)
check('无未解决默认→不可续', isResumable(doc({ goal: 'g' })) === false)
check('放宽后有目标→可续', isResumable(doc({ goal: 'g' }), false) === true)
check('放宽后有进展日志→可续', isResumable(doc({ log: [log(1, 'hi', NOW)] }), false) === true)
check('放宽但全空→不可续', isResumable(doc(), false) === false)

console.log('[2] docLastActiveMs 取最后一条日志时间')
check('取末条时间', docLastActiveMs(doc({ log: [log(1, 'a', NOW - 5 * DAY), log(2, 'b', NOW - DAY)] })) === NOW - DAY)
check('无日志→0', docLastActiveMs(doc()) === 0)

console.log('[3] selectResumable 过滤 / 排序 / 截断')
const docs = [
  doc({ sessionId: 'A', title: '任务A', goal: '修断点', unresolvedProblems: ['持久化没接'], exchangeCount: 4,
        log: [log(1, 'A1', NOW - 2 * DAY), log(2, 'A2', NOW - 1 * DAY)] }),
  doc({ sessionId: 'B', title: '任务B', goal: '查plan', unresolvedProblems: ['plan恢复待测'], exchangeCount: 2,
        log: [log(1, 'B1', NOW - 3 * DAY)] }),
  doc({ sessionId: 'C', title: '已完成闲聊', goal: '', exchangeCount: 6,
        log: [log(1, 'C1', NOW)] }), // 无 unresolved，最活跃但默认不应入选
  doc({ sessionId: 'D', title: '陈旧任务', unresolvedProblems: ['老问题'], exchangeCount: 9,
        log: [log(1, 'D1', NOW - 100 * DAY)] }),
  doc({ sessionId: 'CUR', title: '当前会话', unresolvedProblems: ['我是当前'], exchangeCount: 1,
        log: [log(1, 'CUR1', NOW)] }),
]
const picked = selectResumable(docs, { nowMs: NOW, excludeSessionId: 'CUR', limit: 10 })
const ids = picked.map(c => c.sessionId)
check('默认排除已完成闲聊 C', !ids.includes('C'))
check('排除当前会话 CUR', !ids.includes('CUR'))
check('未完成的 A/B/D 入选', ids.includes('A') && ids.includes('B') && ids.includes('D'), ids.join(','))
check('按最近活动降序（A 最新）', ids[0] === 'A' && ids[1] === 'B' && ids[2] === 'D', ids.join(','))
check('limit 截断到 2', selectResumable(docs, { nowMs: NOW, excludeSessionId: 'CUR', limit: 2 }).length === 2)

console.log('[4] 时间窗 / 模式 / 放宽开关')
const within30 = selectResumable(docs, { nowMs: NOW, excludeSessionId: 'CUR', maxAgeDays: 30 })
check('maxAgeDays=30 排除 100 天前的 D', !within30.map(c => c.sessionId).includes('D')
  && within30.map(c => c.sessionId).includes('A'))
const workOnly = selectResumable(docs, { nowMs: NOW, mode: 'work' })
check('mode=work 过滤（全是 daily）→空', workOnly.length === 0)
const widened = selectResumable(docs, { nowMs: NOW, excludeSessionId: 'CUR', onlyUnresolved: false, limit: 10 })
check('放宽后已完成但活跃的 C 入选', widened.map(c => c.sessionId).includes('C'))
check('放宽后 C 因最活跃排第一', widened[0].sessionId === 'C')

console.log('[5] 候选投影：目标 / 待解决 / 最近进展（只取日志尾部）')
const a = picked.find(c => c.sessionId === 'A')
check('goal 投影', a.goal === '修断点')
check('待解决投影', a.unresolvedProblems[0] === '持久化没接')
check('recentUserInputs 取尾部且为真实记录', a.recentUserInputs.length === 2 && a.recentUserInputs[1] === 'A2')
const tailed = selectResumable(docs, { nowMs: NOW, excludeSessionId: 'CUR', recentLogCount: 1 }).find(c => c.sessionId === 'A')
check('recentLogCount=1 只留最后一条', tailed.recentUserInputs.length === 1 && tailed.recentUserInputs[0] === 'A2')

console.log('[5b] progressEntries 投影：空串过滤 → cap 截尾（append-only 全量语义）')
const progDoc = doc({ sessionId: 'P', goal: 'g', unresolvedProblems: ['u'], progress: ['a', '', 'b', 'c', 'd', 'e'] })
const prog = selectResumable([progDoc], { nowMs: NOW, excludeSessionId: 'X', progressCap: 3 }).find(c => c.sessionId === 'P')
check('先过滤空串、再取尾部 cap 条', JSON.stringify(prog.progressEntries) === JSON.stringify(['c', 'd', 'e']), JSON.stringify(prog.progressEntries))
const progAll = selectResumable([progDoc], { nowMs: NOW, excludeSessionId: 'X' }).find(c => c.sessionId === 'P')
check('cap 默认 20 → 全量不过滤（5 条全保留）', progAll.progressEntries.length === 5, String(progAll.progressEntries.length))
const progOne = selectResumable([doc({ sessionId: 'Q', goal: 'g', unresolvedProblems: ['u'], progress: ['x'] })], { nowMs: NOW, excludeSessionId: 'X' }).find(c => c.sessionId === 'Q')
check('仅 1 条下限：不崩、原样保留', progOne.progressEntries.length === 1 && progOne.progressEntries[0] === 'x')
const progNone = selectResumable([doc({ sessionId: 'R', goal: 'g', unresolvedProblems: ['u'], progress: [] })], { nowMs: NOW, excludeSessionId: 'X' }).find(c => c.sessionId === 'R')
check('空 progress → 空数组', progNone.progressEntries.length === 0)

console.log('[6] renderResumeBrief 只读现场 + 引导确认（不自动重放）')
const brief = renderResumeBrief(picked)
check('空候选有明确文案', renderResumeBrief([]).includes('没有检测到'))
check('含标题与待解决', brief.includes('任务A') && brief.includes('持久化没接'))
check('含会话 id（便于精确接续）', brief.includes('A'))
check('含“先确认/不自动重放”引导', brief.includes('确认') && brief.includes('不要自动重放'))
check('无 progress 的候选不渲染“最近进展”行', !brief.includes('最近进展'))

console.log('[6b] renderResumeBrief 渲染 progressEntries（最近进展）')
const briefP = renderResumeBrief([prog])
check('含最近进展标题与内容', briefP.includes('最近进展') && briefP.includes('· c') && briefP.includes('· e'))
const briefLong = renderResumeBrief([selectResumable(
  [doc({ sessionId: 'L', goal: 'g', unresolvedProblems: ['u'], progress: ['x'.repeat(200)] })],
  { nowMs: NOW, excludeSessionId: 'X' },
).find(c => c.sessionId === 'L')])
check('单条 >120 截断加省略号', briefLong.includes('最近进展') && briefLong.includes('…'))
const briefOne = renderResumeBrief([progOne])
check('仅 1 条 progress 正常渲染', briefOne.includes('· x'))

console.log('[7] renderResumeHint 新会话轻提示')
check('无候选→空串', renderResumeHint(0) === '')
const hint = renderResumeHint(2)
check('含数量与 action=resume', hint.includes('2') && hint.includes('action=resume'))
check('提示不自动开始', hint.includes('不要自动开始'))

console.log('[8] store 集成：recordExchange 写入的未解决项可跨会话被发现')
const ctx = new Context()
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: DATA_DIR })
await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })
const store = await MemoryStore.open(ctx)
await store.recordExchange('old-session', '帮我迁移记忆系统', { refinedGoal: '迁移记忆到0.1.6', unresolved: ['断点续传没做'] })
await store.recordExchange('old-session', '继续', {})
await store.recordExchange('another-done', '随便聊聊天气', {})
const found = findResumableSessions(store, { excludeSessionId: 'brand-new' })
check('发现旧会话未收尾任务', found.length === 1 && found[0].sessionId === 'old-session')
check('闲聊会话不作为未收尾任务', !found.some(c => c.sessionId === 'another-done'))

console.log('[9] renderMemoryContext：全新会话给提示，本会话已有文档则不打扰')
const hintCtx = renderMemoryContext(store, 'brand-new', { resumeHint: true })
check('全新会话注入断点续跑提示', hintCtx.includes('断点续跑') && hintCtx.includes('action=resume'))
const selfCtx = renderMemoryContext(store, 'old-session', { resumeHint: true })
check('本会话已有小黑板→展示小黑板而非提示', selfCtx.includes('[项目小黑板]') && !selfCtx.includes('[断点续跑]'))
const offCtx = renderMemoryContext(store, 'brand-new', { resumeHint: false })
check('开关关闭→全新会话也不提示', !offCtx.includes('断点续跑'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
