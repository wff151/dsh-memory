// 容量上限验证：不依赖 cordis，直接构造假的 store 驱动 runShortTermDecay。
//
// 要验证三件事：
//   1. 超限时按"权重最低先走，同权重最老先走"裁剪
//   2. 恰好等于上限时不裁剪
//   3. maxItems=0 表示不限制
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const { runShortTermDecay } = await import(pathToFileURL(path.join(SRC, 'decay.ts')).href)

/** 造一个最小 store：只实现衰减用到的几个方法。 */
function makeStore(items, mode = 'daily') {
  let current = items
  const archivedWrites = []
  return {
    listShortTerm: (m) => (m === mode ? current : []),
    replaceShortTerm: async (m, next) => { current = next },
    // decay.ts 的 defaultArchive 会调 recordPublicMemory，这里直接注入 archive 回调，
    // 所以不需要实现它。
    get items() { return current },
    get archivedWrites() { return archivedWrites },
  }
}

const DAY = 86_400_000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()

function makeItem(id, weight, ageDays) {
  return {
    id,
    mode: 'daily',
    content: `内容 ${id}`,
    tags: [],
    weight,
    accessCount: 0,
    createdAt: ago(ageDays),
    lastAccess: ago(ageDays),
  }
}

let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  —— ' + detail : ''}`) }
}

// ── 1. 超限裁剪：权重低先走 ────────────────────────────────────
{
  // 10 条：id 0–4 权重 1.0（新），5–9 权重 0.9（也新，但比 1.0 低）
  // 用 0.9 而不是 0.3：0.3 在 20 天年龄下衰减后是 0.11 < 阈值 0.15，
  // 会被**衰减正常归档**，混进来就测不出"容量裁剪"了（这个坑踩过）。
  const items = []
  for (let i = 0; i < 5; i++) items.push(makeItem(`hi${i}`, 1.0, 1))
  for (let i = 0; i < 5; i++) items.push(makeItem(`lo${i}`, 0.9, 1))

  const store = makeStore(items)
  const archive = async () => {}
  const r = await runShortTermDecay(store, { maxItems: 6, archive })

  check('超限后剩余 = maxItems', r.daily.remaining === 6, `实际 ${r.daily.remaining}`)
  check('归档了 4 条', r.daily.archived.length === 4, `实际 ${r.daily.archived.length}`)
  const kept = store.items.map(x => x.id)
  check('权重高的 5 条全部留下', ['hi0', 'hi1', 'hi2', 'hi3', 'hi4'].every(id => kept.includes(id)), kept.join(','))
  check('权重低的走了 4 条（留下 1 条）', kept.filter(id => id.startsWith('lo')).length === 1, kept.join(','))
}

// ── 2. 同权重时最老的先走 ─────────────────────────────────────
{
  const items = []
  for (let i = 0; i < 6; i++) items.push(makeItem(`t${i}`, 1.0, i === 0 ? 1 : 10 + i)) // t0 最新，其余越来越老
  const store = makeStore(items)
  const r = await runShortTermDecay(store, { maxItems: 3, archive: async () => {} })
  const kept = store.items.map(x => x.id)
  check('同权重时保留最新的 3 条', kept.includes('t0') && kept.includes('t1') && kept.includes('t2'), kept.join(','))
  check('最老的被裁掉', !kept.includes('t5'), kept.join(','))
}

// ── 3. 恰好等于上限不裁剪 ─────────────────────────────────────
{
  const items = []
  for (let i = 0; i < 5; i++) items.push(makeItem(`e${i}`, 1.0, 1))
  const store = makeStore(items)
  const r = await runShortTermDecay(store, { maxItems: 5, archive: async () => {} })
  check('恰好等于上限：不裁剪', r.daily.remaining === 5 && r.daily.archived.length === 0, `剩 ${r.daily.remaining}，归档 ${r.daily.archived.length}`)
}

// ── 4. maxItems = 0 表示不限制 ────────────────────────────────
{
  const items = []
  for (let i = 0; i < 20; i++) items.push(makeItem(`n${i}`, 1.0, 1))
  const store = makeStore(items)
  const r = await runShortTermDecay(store, { maxItems: 0, archive: async () => {} })
  check('maxItems=0 不裁剪', r.daily.remaining === 20, `剩 ${r.daily.remaining}`)
}

// ── 5. 未超限时不影响原有衰减逻辑 ─────────────────────────────
{
  // 一条极老的（超过硬上限 90×2=180 天）必归档
  const items = [makeItem('ancient', 1.0, 200), makeItem('fresh', 1.0, 1)]
  const store = makeStore(items)
  const r = await runShortTermDecay(store, { maxItems: 100, archive: async () => {} })
  check('超龄条目仍被归档（原逻辑未破）', r.daily.archived.some(x => x.id === 'ancient'), JSON.stringify(r.daily.archived.map(x => x.id)))
  check('年轻条目保留', store.items.some(x => x.id === 'fresh'))
}

// ── 6. 权重衰减仍生效 ────────────────────────────────────────
{
  const items = [makeItem('w', 1.0, 10)]
  const store = makeStore(items)
  await runShortTermDecay(store, { maxItems: 100, archive: async () => {} })
  const w = store.items[0]?.weight ?? 0
  check('权重按 exp(-0.05*10) 衰减', Math.abs(w - Math.exp(-0.5)) < 0.02, `实际 ${w.toFixed(4)}，期望 ${Math.exp(-0.5).toFixed(4)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
