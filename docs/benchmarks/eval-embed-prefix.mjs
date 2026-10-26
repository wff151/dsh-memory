// nomic-embed-text 需要任务前缀（search_query: / search_document:）。
// 不加前缀，分数会塌成一片 —— 这正是上一版测试的结果。
// 这个脚本对比「加前缀 vs 不加前缀」。
const URL = 'http://127.0.0.1:8081/v1/embeddings'
const MODEL = 'nomic-embed'

async function embed(text) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, model: MODEL }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).data[0].embedding
}
const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na) * Math.sqrt(nb))
}

const CLUSTERS = {
  小说: [
    '孙少平在铜城大牙湾煤矿当矿工，井下黑暗闷热',
    '田晓霞是省报记者，在抗洪采访中为救落水儿童牺牲',
    '孙少安办砖窑，因技术员失误烧出废砖破产',
  ],
  技术: [
    '用 esbuild 把 TypeScript 打包成 ESM 模块',
    '这个 bug 是因为路径分隔符在 Windows 上没归一化',
    '单测覆盖了 12 个分支，全部通过',
  ],
  烹饪: [
    '把牛肉焯水去腥，再加冰糖炒糖色',
    '面粉和水的比例大概三比一，揉到表面光滑',
    '烤箱预热到 180 度，中层烤 25 分钟',
  ],
}

async function run(mode) {
  const vecs = {}
  for (const [k, arr] of Object.entries(CLUSTERS)) {
    vecs[k] = []
    for (const t of arr) {
      const input = mode === 'prefix' ? `search_document: ${t}` : t
      vecs[k].push(await embed(input))
      await new Promise(r => setTimeout(r, 90))
    }
  }
  const intra = [], cross = []
  for (const [, v] of Object.entries(vecs)) {
    for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) intra.push(cosine(v[i], v[j]))
  }
  const ks = Object.keys(vecs)
  for (let a = 0; a < ks.length; a++) for (let b = a + 1; b < ks.length; b++) {
    for (const x of vecs[ks[a]]) for (const y of vecs[ks[b]]) cross.push(cosine(x, y))
  }
  intra.sort((x, y) => x - y); cross.sort((x, y) => x - y)
  const sep = intra[0] > cross.at(-1)
  // 分离度：同主题中位 - 跨主题中位
  const med = (arr) => arr[Math.floor(arr.length / 2)]
  return {
    intraMin: intra[0], intraMed: med(intra), crossMax: cross.at(-1), crossMed: med(cross),
    gap: med(intra) - med(cross), sep, intra, cross,
  }
}

for (const mode of ['plain', 'prefix']) {
  const r = await run(mode)
  const tag = mode === 'plain' ? '不加前缀' : '加 search_document: 前缀'
  console.log(`\n=== ${tag} ===`)
  console.log(`  同主题 min ${r.intraMin.toFixed(4)}  中位 ${r.intraMed.toFixed(4)}`)
  console.log(`  跨主题 max ${r.crossMax.toFixed(4)}  中位 ${r.crossMed.toFixed(4)}`)
  console.log(`  中位差(分离度): ${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(4)}`)
  console.log(`  完全可分: ${r.sep ? '是' : '否'}`)
}
