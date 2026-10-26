// 选阈值：算不同百分比在不同窗口下对应多少条短期记忆。
import fs from 'node:fs'

function est(s) {
  if (!s) return 0
  const runs = s.match(/[A-Za-z0-9]+/g) ?? []
  let n = 0
  for (const r of runs) n += Math.max(1, Math.ceil(r.length / 4))
  n += (s.match(/[\u4e00-\u9fff]/g) ?? []).length
  return n
}

const raw = JSON.parse(fs.readFileSync(`${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME}/.dsh`}/storages/brain_memory.json`, 'utf8'))
const rows = (x) => (Array.isArray(x) ? x : (x?.rows ?? Object.values(x ?? {})))
const sh = rows(raw.tables.short)
const allTokens = est(sh.map(x => `${x.title ?? ''} ${x.summary ?? x.content ?? ''}`).join(''))
const perItem = sh.length > 0 ? allTokens / sh.length : 60

console.log(`短期库 ${sh.length} 条，共 ~${allTokens} tokens，平均 ${perItem.toFixed(1)} tokens/条\n`)
console.log(`阈值     32k窗口        64k窗口        128k窗口`)
for (const pct of [5, 10, 15, 20, 25, 30]) {
  const cells = [32000, 64000, 128000].map((w) => {
    const cap = w * pct / 100
    const items = Math.floor(cap / perItem)
    return `${String(Math.round(cap)).padStart(5)} tok ≈ ${String(items).padStart(3)} 条`.padEnd(20)
  })
  console.log(`  ${String(pct).padStart(2)}%   ${cells.join('')}`)
}

console.log(`\n当前实际：${Math.round(allTokens)} tokens`)
console.log(`若阈值 15%：32k 窗口在 ~${Math.round(32000 * 0.15)} tokens 触发（当前已 ${Math.round(allTokens)} = 超标 ${(allTokens / (32000 * 0.15) * 100).toFixed(0)}%）`)
