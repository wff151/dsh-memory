// 量摘要的真实长度分布：上限 vs 实际，看是"上限太小"还是"没填满"。
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const { deterministicSummary, DETERMINISTIC_MAX_CHARS } = await import(
  pathToFileURL(path.join(SRC, 'summarize.ts')).href
)

// 用真实记忆库里的条目（这是最有说服力的数据）
import fs from 'node:fs'
const raw = JSON.parse(fs.readFileSync(`${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME}/.dsh`}/storages/brain_memory.json`, 'utf8'))
const rows = (x) => (Array.isArray(x) ? x : (x?.rows ?? Object.values(x ?? {})))
const pub = rows(raw.tables.public)

console.log(`=== 真实库：${pub.length} 条长期记忆 ===\n`)
console.log(`摘要上限 DETERMINISTIC_MAX_CHARS = ${DETERMINISTIC_MAX_CHARS}\n`)

const lens = []
let keepRatio = 0
for (const p of pub) {
  const summary = String(p.summary ?? '')
  const detail = String(p.detail ?? '')
  const body = detail !== '' ? detail : summary
  if (body.length < 20) continue
  const regenerated = deterministicSummary(body, DETERMINISTIC_MAX_CHARS)
  lens.push({ orig: summary.length, bodyLen: body.length, regen: regenerated.length })
  keepRatio += regenerated.length / Math.max(1, body.length)
}

if (lens.length === 0) { console.log('没有可用样本'); process.exit(0) }

const nums = (arr) => arr.slice().sort((a, b) => a - b)
const med = (arr) => arr[Math.floor(arr.length / 2)]
const p90 = (arr) => arr[Math.floor((arr.length - 1) * 0.9)]

const regen = nums(lens.map(x => x.regen))
const body = nums(lens.map(x => x.bodyLen))

console.log(`原文长度   中位 ${med(body)}   p90 ${p90(body)}   max ${body.at(-1)}`)
console.log(`摘要是文长  ${(keepRatio / lens.length * 100).toFixed(1)}%  （平均保留比例）`)
console.log(`实际摘要长 中位 ${med(regen)}   p90 ${p90(regen)}   max ${regen.at(-1)}`)

console.log(`\n=== 关键判断 ===`)
const pctAtCap = regen.filter(l => l >= DETERMINISTIC_MAX_CHARS * 0.9).length
console.log(`  达到上限 90% 以上的摘要: ${pctAtCap}/${regen.length}  (${((pctAtCap / regen.length) * 100).toFixed(0)}%)`)
console.log(pctAtCap < regen.length * 0.2
  ? `  → 绝大多数**远没填满**上限：问题不是"上限太小"，是"取首句"太短`
  : `  → 多数摘要已接近上限：问题可能是"上限太小"`)

console.log(`\n=== 抽样 8 条看形状 ===`)
for (const p of pub.slice(0, 8)) {
  const detail = String(p.detail ?? '')
  const src = detail !== '' ? detail : String(p.summary ?? '')
  if (src.length < 30) continue
  const s = deterministicSummary(src, DETERMINISTIC_MAX_CHARS)
  console.log(`  原文 ${String(src.length).padStart(4)} 字 → 摘要 ${String(s.length).padStart(3)} 字`)
  console.log(`     ${s.slice(0, 70)}${s.length > 70 ? '…' : ''}`)
}
