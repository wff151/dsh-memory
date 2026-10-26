// 先验证：特征索引能不能把「煤矿」这种共同词和「主角」这种唯一特征分开。
// 不接进生产路径，先看算法本身有没有用。
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const { computeFeatures, featureScore } = await import(pathToFileURL(path.join(SRC, 'features.ts')).href)
const { tokenize } = await import(pathToFileURL(path.join(SRC, 'retrieval.ts')).href)

const DOCS = [
  ['孙少平', '孙少平是主角，农村青年。后到铜城大牙湾煤矿当矿工，井下黑暗闷热。与田晓霞相恋。'],
  ['田晓霞', '田晓霞是润叶堂妹，省报记者。与孙少平相恋，在抗洪采访中为救落水儿童牺牲。'],
  ['孙少安', '孙少安是少平之兄，双水村生产队长。与贺秀莲结婚，办砖窑先致富后破产。'],
  ['贺秀莲', '贺秀莲是孙少安之妻，山西人，勤劳能干。后患肺癌，书末病重。'],
  ['田润叶', '田润叶是少安青梅竹马，当教师。爱少安但被家里逼嫁给李向前。'],
  ['李向前', '李向前是润叶的丈夫，司机。后因车祸截去双腿，润叶回头照顾他。'],
  ['孙玉厚', '孙玉厚是少平少安之父，老实农民。一辈子在土里刨食，独自撑起一家。'],
  ['孙兰香', '孙兰香是少平之妹，读书好。后考上大学学天体物理，是孙家走出农村的希望。'],
  ['金波', '金波是孙少平好友。当兵时爱上一位藏族姑娘，复员后回去寻找未果。'],
  ['田福军', '田福军是润叶之叔，原西县革委会副主任。后升黄原地区地委书记，改革派干部。'],
  ['双水村', '双水村隶属于原西县。原西县属黄原地区，黄原地区在陕西省。'],
  ['砖窑', '少安的砖窑买了村里第一台拖拉机。后因技术员失误烧出废砖破产欠债。'],
  ['煤矿', '铜城大牙湾煤矿井下黑暗闷热煤尘大。少平下井上来脸全黑只剩眼白。'],
  ['黑面馍', '开头是黄土高原的雨雪天。孙少平在县高中吃黑面馍，躲着同学吃，穷得只剩自尊。'],
]

const docs = DOCS.map(([key, body]) => ({ id: key, text: `${key} ${body}` }))
const feats = computeFeatures(docs, 10)

console.log('=== 每条记忆的"唯一特征" ===\n')
for (const [id, fs] of feats) {
  console.log(`  ${id.padEnd(6)} → ${fs.join(' · ') || '(无)'}`)
}

console.log('\n=== 关键检验：共同词有没有被排除 ===')
for (const bad of ['煤矿', '少平', '少安']) {
  let hit = 0
  for (const [, fs] of feats) if (fs.includes(bad)) hit++
  console.log(`  "${bad}" 出现在 ${hit} 条的特征里 ${hit === 0 ? '✓ 已被排除（是共同词）' : '✗ 仍被当成特征'}`)
}

console.log('\n=== 检索测试：不含实体名的问题 ===')
const QUERIES = [
  ['那个在煤矿下井的年轻人是谁？', '孙少平'],
  ['在抗洪里救人死的是谁？', '田晓霞'],
  ['办砖窑的那个人是谁？', '孙少安'],
  ['考上大学学物理的那个女孩是谁？', '孙兰香'],
  ['当兵时爱上藏族姑娘的那个人是谁？', '金波'],
  ['那个地委书记是谁？', '田福军'],
  ['烧出废砖破产的那档子事', '砖窑'],
  ['开头躲着同学吃黑面馍的是谁？', '黑面馍'],
]

let pureHit = 0, featHit = 0
for (const [q, expect] of QUERIES) {
  const qt = tokenize(q)
  // 纯关键词
  const pure = DOCS.map(([key, body]) => {
    const terms = tokenize(`${key} ${body}`)
    const hits = qt.filter(t => terms.some(x => x.includes(t))).length
    return { key, s: hits / Math.max(1, qt.length) }
  }).sort((a, b) => b.s - a.s)

  // 关键词 + 特征
  const withFeat = DOCS.map(([key, body]) => {
    const terms = tokenize(`${key} ${body}`)
    const hits = qt.filter(t => terms.some(x => x.includes(t))).length
    const kw = hits / Math.max(1, qt.length)
    const ft = featureScore(qt, feats.get(key))
    // 特征权重给 1.2：它比关键词更该决胜负
    return { key, s: kw + ft * 1.2 }
  }).sort((a, b) => b.s - a.s)

  const pRank = pure.findIndex(r => r.key === expect)
  const fRank = withFeat.findIndex(r => r.key === expect)
  if (pRank === 0) pureHit++
  if (fRank === 0) featHit++

  console.log(`  ${q}`)
  console.log(`     纯关键词 top1=${pure[0]?.key ?? '-'}  期望=${expect} ${pRank === 0 ? '✓' : '✗'} (rank ${pRank})`)
  console.log(`     加特征   top1=${withFeat[0]?.key ?? '-'}  ${fRank === 0 ? '✓' : '✗'} (rank ${fRank})`)
}

console.log(`\n=== 结果 ===`)
console.log(`纯关键词 top1: ${pureHit}/${QUERIES.length}`)
console.log(`加特征   top1: ${featHit}/${QUERIES.length}`)
