// 算清"短期记忆占上下文百分之几"到底指什么。
//
// 三种可能的度量，含义完全不同：
//   A. 短期**全部正文** / 上下文窗口 —— 但这个从没全进过上下文
//   B. 短期**投影**（每步注入的那几条）/ 上下文窗口 —— 这个才是真实占用
//   C. 短期**检索返回**（top3 条摘要）/ 上下文窗口
//
// 要设计"占 x% 就归档"的触发条件，必须站对度量。这里把三个都算出来。
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

const states = sh.filter(x => x.kind === 'state')
const events = sh.filter(x => x.kind === 'event')
const rels = sh.filter(x => x.kind === 'relation')
const facts = sh.filter(x => (x.kind ?? 'fact') === 'fact')

console.log(`=== 短期库实测：${sh.length} 条 ===`)
console.log(`  fact ${facts.length} 条 · state ${states.length} · event ${events.length} · relation ${rels.length}`)

const allTokens = est(sh.map(x => x.content || '').join(''))
const projSources = [...states.slice(0, 3), ...events.slice(0, 3), ...rels.slice(0, 3)]
const projTokens = est(projSources.map(x => x.summary || x.content).join(''))
const top3 = sh.slice(0, 3)
const retrieveTokens = est(top3.map(x => x.summary || x.content).join(''))

console.log(`\n三种度量：`)
console.log(`  A 全部正文      ~${allTokens} tokens`)
console.log(`  B 每步投影(3+3+3) ~${projTokens} tokens  ← 固定，不随条数增长`)
console.log(`  C 检索返回(top3)  ~${retrieveTokens} tokens`)

console.log(`\n占比（按不同窗口）：`)
console.log(`  窗口      A全部     B投影     C检索`)
for (const w of [32000, 64000, 128000, 1000000]) {
  const p = (n) => `${((n / w) * 100).toFixed(2)}%`.padStart(7)
  console.log(`  ${String(w).padStart(8)}  ${p(allTokens)}  ${p(projTokens)}  ${p(retrieveTokens)}`)
}

console.log(`\n=== 结论 ===`)
console.log(`B（投影）是固定值 —— 条数再多也不会变大，所以**不能用它做触发**（永远不会超标）。`)
console.log(`A（全部正文）从来不全进上下文 —— 用它算会让阈值意义失真，但对"库有多大"是诚实的度量。`)
console.log(`C（检索返回）随命中的摘要长度变化，是真正会撑上下文的那部分。`)
