// 两条容量触发的验证：条数上限 与 窗口占比，取更严者。
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const { runShortTermDecay } = await import(pathToFileURL(path.join(SRC, 'decay.ts')).href)

function makeStore(items) {
  let current = items
  return {
    listShortTerm: (m) => (m === 'daily' ? current : []),
    replaceShortTerm: async (m, next) => { current = next },
    get items() { return current },
  }
}

const DAY = 86_400_000
const ago = (d) => new Date(Date.now() - d * DAY).toISOString()
let seq = 0
function makeItem(weight = 1.0, ageDays = 1, len = 60) {
  const id = `i${seq++}`
  return {
    id, mode: 'daily', tags: [],
    // 中文 1 字 = 1 token；这里造 len 字，使每条约 len tokens
    content: '字'.repeat(len),
    summary: '字'.repeat(len),
    title: '',
    weight, accessCount: 0,
    createdAt: ago(ageDays), lastAccess: ago(ageDays),
  }
}

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? '  —— ' + detail : ''}`) }
}

const noop = async () => {}

// ── 1. 只有条数上限时：按条数触发 ─────────────────────────────
{
  const items = Array.from({ length: 20 }, () => makeItem())
  const store = makeStore(items)
  const r = await runShortTermDecay(store, {
    maxItems: 10, contextSharePercent: 0, archive: noop,
  })
  check('条数触发：剩 10 条', r.daily.remaining === 10, `实际 ${r.daily.remaining}`)
  check('条数触发：标记为 items', r.daily.triggeredBy === 'items', `实际 ${r.daily.triggeredBy}`)
}

// ── 2. 只有窗口占比时：按占比触发 ─────────────────────────────
{
  // 100 条 × 60 token = 6000 tokens。窗口 20000 → 占 30%。
  // 阈值 10% → 允许 2000 tokens ≈ 33 条。
  const items = Array.from({ length: 100 }, () => makeItem(1.0, 1, 60))
  const store = makeStore(items)
  const r = await runShortTermDecay(store, {
    maxItems: 0, contextSharePercent: 10, contextWindowTokens: 20000, archive: noop,
  })
  check('占比触发：确实裁剪了', r.daily.remaining < 100 && r.daily.remaining > 0, `实际 ${r.daily.remaining}`)
  check('占比触发：标记为 context', r.daily.triggeredBy === 'context', `实际 ${r.daily.triggeredBy}`)
  check('占比触发：结果约 33 条（±3）', Math.abs(r.daily.remaining - 33) <= 3, `实际 ${r.daily.remaining}`)
  check('占比触发：报告了裁剪前的占比', Math.abs((r.daily.contextShareBefore ?? 0) - 30) < 0.5, `实际 ${r.daily.contextShareBefore}`)
}

// ── 3. 两条都配：取更严的那个 ────────────────────────────────
{
  // 100 条 × 60 token = 6000。窗口 20000，阈值 10% → 33 条。
  // 同时 maxItems = 80。更严的是 33 条（占比）。
  const items = Array.from({ length: 100 }, () => makeItem(1.0, 1, 60))
  const store = makeStore(items)
  const r = await runShortTermDecay(store, {
    maxItems: 80, contextSharePercent: 10, contextWindowTokens: 20000, archive: noop,
  })
  check('两条都配：取更严的（约 33 条）', r.daily.remaining <= 35, `实际 ${r.daily.remaining}`)
  check('两条都配：标记为 context', r.daily.triggeredBy === 'context', `实际 ${r.daily.triggeredBy}`)
}

// ── 4. 条数上限更严时，走条数 ────────────────────────────────
{
  // 100 条 × 60 token = 6000。窗口 1000000，阈值 15% → 150000 token ≈ 2500 条（不触发）。
  // maxItems = 50 → 条数上限更严。
  const items = Array.from({ length: 100 }, () => makeItem(1.0, 1, 60))
  const store = makeStore(items)
  const r = await runShortTermDecay(store, {
    maxItems: 50, contextSharePercent: 15, contextWindowTokens: 1000000, archive: noop,
  })
  check('条数更严：剩 50 条', r.daily.remaining === 50, `实际 ${r.daily.remaining}`)
  check('条数更严：标记为 items', r.daily.triggeredBy === 'items', `实际 ${r.daily.triggeredBy}`)
}

// ── 5. 拿不到窗口时：占比触发跳过，不误伤 ─────────────────────
{
  const items = Array.from({ length: 100 }, () => makeItem(1.0, 1, 60))
  const store = makeStore(items)
  const r = await runShortTermDecay(store, {
    maxItems: 0, contextSharePercent: 15, contextWindowTokens: 0, archive: noop,
  })
  check('无窗口：不裁剪', r.daily.remaining === 100, `实际 ${r.daily.remaining}`)
  check('无窗口：标记为 none', r.daily.triggeredBy === 'none', `实际 ${r.daily.triggeredBy}`)
}

// ── 6. 低于阈值时不触发 ──────────────────────────────────────
{
  // 10 条 × 60 = 600 tokens。窗口 32000 → 1.9%。阈值 15% 不触发。
  const items = Array.from({ length: 10 }, () => makeItem(1.0, 1, 60))
  const store = makeStore(items)
  const r = await runShortTermDecay(store, {
    maxItems: 2000, contextSharePercent: 15, contextWindowTokens: 32000, archive: noop,
  })
  check('占比低于阈值：不裁剪', r.daily.remaining === 10, `实际 ${r.daily.remaining}`)
}

// ── 7. 裁剪时保留权重高的 ────────────────────────────────────
{
  const items = []
  for (let i = 0; i < 10; i++) items.push(makeItem(1.0, 1, 60))   // 10 条高权重
  for (let i = 0; i < 40; i++) items.push(makeItem(0.2, 1, 60))   // 40 条低权重（0.2 不会低于阈值 0.15... 会，衰减后更低）
  const store = makeStore(items)
  const r = await runShortTermDecay(store, {
    maxItems: 20, contextSharePercent: 0, archive: noop,
  })
  const kept = store.items.map(x => x.weight)
  check('裁剪保留高权重', kept.filter(w => w > 0.15).length > 0, kept.map(w => w.toFixed(2)).join(','))
  check('裁剪后不超上限', r.daily.remaining <= 20, `实际 ${r.daily.remaining}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
