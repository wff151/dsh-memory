// 验证任务前缀的实际收益：同一批查询/文档，加前缀 vs 不加，分开度差多少。
const URL = 'http://127.0.0.1:8081/v1/embeddings'
const MODEL = 'nomic-embed'

async function embed(text) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, model: MODEL }),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return (await r.json()).data[0].embedding
}
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na) * Math.sqrt(nb))
}

// 6 个查询，每个都有正确文档 + 3 个干扰文档
const CASES = [
  { q: '那个在煤矿下井的人', hit: '孙少平是主角，后到铜城大牙湾煤矿当矿工，井下黑暗闷热。', miss: ['田晓霞是省报记者，抗洪牺牲。', '孙兰香考上大学学天体物理。', '贺秀莲患肺癌。'] },
  { q: '女记者怎么死的', hit: '田晓霞是省报记者，在南部抗洪采访中为救落水儿童牺牲。', miss: ['孙少安办砖窑破产。', '孙玉厚是老实农民。', '金波找藏族姑娘。'] },
  { q: '砖窑为什么垮了', hit: '孙少安办砖窑，因技术员失误烧出废砖，破产欠债。', miss: ['田晓霞在省报当记者。', '孙兰香读书好。', '孙少平下矿井。'] },
  { q: '谁得了肺癌', hit: '贺秀莲是孙少安之妻，山西人，后患肺癌。', miss: ['孙少平在煤矿。', '田润叶当教师。', '田福军当地委书记。'] },
  { q: '考大学学物理的是谁', hit: '孙兰香是少平之妹，读书好，考上大学学天体物理。', miss: ['孙少安办砖窑。', '金波当兵。', '李向前车祸截肢。'] },
  { q: '车祸截肢的是谁', hit: '李向前是润叶的丈夫，司机，后因车祸截去双腿。', miss: ['孙少平在煤矿。', '孙兰香上大学。', '田晓霞牺牲。'] },
]

async function run(usePrefix) {
  const qp = usePrefix ? 'search_query: ' : ''
  const dp = usePrefix ? 'search_document: ' : ''
  let hitAbove = 0    // 正确文档高于所有干扰
  let gaps = []
  for (const c of CASES) {
    const qv = await embed(qp + c.q)
    const hv = await embed(dp + c.hit)
    const hScore = cos(qv, hv)
    let maxMiss = -1
    for (const m of c.miss) {
      const mv = await embed(dp + m)
      maxMiss = Math.max(maxMiss, cos(qv, mv))
      await new Promise(r => setTimeout(r, 70))
    }
    if (hScore > maxMiss) hitAbove++
    gaps.push(hScore - maxMiss)
    await new Promise(r => setTimeout(r, 70))
  }
  return { hitAbove, gaps }
}

const plain = await run(false)
const prefix = await run(true)

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
console.log('=== nomic-embed：加前缀 vs 不加 ===')
console.log(`\n不加前缀`)
console.log(`  正确文档胜出（高于全部干扰）: ${plain.hitAbove}/${CASES.length}`)
console.log(`  平均分差(正确-最强干扰): ${avg(plain.gaps).toFixed(4)}`)
console.log(`\n加 search_query:/search_document: 前缀`)
console.log(`  正确文档胜出: ${prefix.hitAbove}/${CASES.length}`)
console.log(`  平均分差: ${avg(prefix.gaps).toFixed(4)}`)
console.log(`\n提升: 胜出 ${plain.hitAbove} → ${prefix.hitAbove}，分差 ${avg(plain.gaps).toFixed(4)} → ${avg(prefix.gaps).toFixed(4)}`)
