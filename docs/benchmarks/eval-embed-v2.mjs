// 修正版评估：无关配对必须是**真跨主题**，不能是同一本书的相邻人物。
// 上一版把「孙少平 vs 孙兰香」当无关 —— 但两人都是孙家人、同一部小说，
// 语义本来就近。那是测试设计错误，不是模型的问题。
const URL = 'http://127.0.0.1:8081/v1/embeddings'
const MODEL = process.argv[2] ?? 'nomic-embed'

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

// 三个主题簇：小说(平凡的世界) / 技术(代码) / 烹饪
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

// 每簇内部互相关 = 相关；跨簇配对 = 无关
const intra = [], cross = []
const e = {}
for (const [k, arr] of Object.entries(CLUSTERS)) {
  e[k] = []
  for (const t of arr) {
    e[k].push(await embed(t))
    await new Promise(r => setTimeout(r, 90))
  }
}

for (const [k, vecs] of Object.entries(e)) {
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) intra.push({ c: cosine(vecs[i], vecs[j]), k })
  }
}
const keys = Object.keys(e)
for (let a = 0; a < keys.length; a++) {
  for (let b = a + 1; b < keys.length; b++) {
    for (const va of e[keys[a]]) for (const vb of e[keys[b]]) {
      cross.push({ c: cosine(va, vb), a: keys[a], b: keys[b] })
    }
  }
}

const nums = (arr) => arr.map(x => x.c).sort((x, y) => x - y)
const iS = nums(intra), cS = nums(cross)
const fmt = (n) => n.toFixed(4)

console.log(`=== ${MODEL} · 跨主题区分度 ===`)
console.log(`同主题配对   ${intra.length} 组   min ${fmt(iS[0])}  中位 ${fmt(iS[Math.floor(iS.length / 2)])}  max ${fmt(iS.at(-1))}`)
console.log(`跨主题配对   ${cross.length} 组   min ${fmt(cS[0])}  中位 ${fmt(cS[Math.floor(cS.length / 2)])}  max ${fmt(cS.at(-1))}`)

const overlap = iS.filter(x => x < cS.at(-1)).length
console.log(`\n同主题里低于「跨主题最高分」的: ${overlap}/${iS.length}`)

let best = { t: 0, correct: 0, tp: 0, tn: 0 }
for (let t = 0.3; t <= 0.99; t += 0.005) {
  const tp = iS.filter(x => x >= t).length
  const tn = cS.filter(x => x < t).length
  if (tp + tn > best.correct) best = { t, correct: tp + tn, tp, tn }
}
const total = iS.length + cS.length
console.log(`\n最佳阈值 ${fmt(best.t)} → ${best.correct}/${total} (${((best.correct / total) * 100).toFixed(0)}%)`)
console.log(`  同主题判对 ${best.tp}/${iS.length}   跨主题判对 ${best.tn}/${cS.length}`)

console.log('\n=== 判定 ===')
const ok = iS[0] > cS.at(-1)
console.log(ok
  ? `✓ 可区分：同主题最低 ${fmt(iS[0])} > 跨主题最高 ${fmt(cS.at(-1))}`
  : `✗ 有重叠：同主题最低 ${fmt(iS[0])} < 跨主题最高 ${fmt(cS.at(-1))}`)
