// 量 nomic-embed 的余弦分布，判断 minScore: 0.3 是否合适。
// nomic-embed-text 与 qwen2-0.5b 的分数尺度不同，不能照搬默认值。
const URL = 'http://127.0.0.1:8081/v1/embeddings'
const MODEL = 'nomic-embed'

async function embed(text) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, model: MODEL }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  return j.data[0].embedding
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// 三个"应该相关"的查询 / 文档对，和三个"应该无关"的
const pairs = [
  ['孙少平在煤矿的日子', '孙少平是主角，农村青年。后到铜城大牙湾煤矿当矿工，井下黑暗闷热。', 'related'],
  ['那个女记者牺牲了', '田晓霞是省报记者，在南部抗洪采访中为救落水儿童牺牲。', 'related'],
  ['砖窑为什么破产', '孙少安办砖窑，因技术员失误烧出废砖，破产欠债。', 'related'],
  ['孙少平在煤矿的日子', '田晓霞是省报记者，在抗洪采访中牺牲。', 'unrelated'],
  ['砖窑为什么破产', '孙兰香读书好，考上大学学天体物理。', 'unrelated'],
  ['那个女记者牺牲了', '贺秀莲是孙少安之妻，山西人，后患肺癌。', 'unrelated'],
]

console.log('=== nomic-embed 余弦分布 ===\n')
const rel = [], unrel = []
for (const [q, doc, kind] of pairs) {
  const qe = await embed(q); await new Promise(r=>setTimeout(r,120)); const de = await embed(doc)
  const c = cosine(qe, de)
  console.log(`${kind.padEnd(10)} ${c.toFixed(4)}  「${q}」 vs 「${doc.slice(0, 24)}…」`)
  ;(kind === 'related' ? rel : unrel).push(c)
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
console.log(`\n相关平均   : ${avg(rel).toFixed(4)}  (min ${Math.min(...rel).toFixed(4)})`)
console.log(`无关平均   : ${avg(unrel).toFixed(4)}  (max ${Math.max(...unrel).toFixed(4)})`)
console.log(`\n建议 minScore = ${((Math.min(...rel) + Math.max(...unrel)) / 2).toFixed(2)}  （相关下限与无关上限的中点）`)
console.log(`默认 0.3 是否合适: ${Math.min(...rel) > 0.3 ? '偏低（会放进太多无关）' : Math.max(...unrel) > 0.3 ? '偏高（会漏掉相关）' : '大致可用'}`)
