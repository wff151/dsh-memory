// 干净 A/B：在同一批数据上，分别关掉/打开每个机制，看各自贡献。
// 目的：搞清楚「特征索引」到底有没有用，而不是继续盲调。
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const { deterministicSummary } = await import(pathToFileURL(path.join(SRC, 'summarize.ts')).href)
const { tokenize, semanticScore, isPlausibleToken } = await import(pathToFileURL(path.join(SRC, 'retrieval.ts')).href)
const { resolvePronoun, expandKinshipAndRole } = await import(pathToFileURL(path.join(SRC, 'anaphora.ts')).href)
const { expandOneHop, sameEntity, inferRelations } = await import(pathToFileURL(path.join(SRC, 'relations.ts')).href)
const { detectAnswerKind, kindMatches, inferEntryKind } = await import(pathToFileURL(path.join(SRC, 'intent.ts')).href)
const { computeFeatures, featureScore } = await import(pathToFileURL(path.join(SRC, 'features.ts')).href)

const RAW = [
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
  ['郝红梅', '孙少平在学校时与郝红梅有过一段朦胧情愫。后来郝红梅与顾养民相好。'],
  ['惠英嫂', '惠英嫂是矿上师傅的妻子。丈夫矿难死后，孙少平照顾她和孩子。'],
  ['双水村', '双水村隶属于原西县。原西县属黄原地区，黄原地区在陕西省。'],
  ['砖窑', '少安的砖窑买了村里第一台拖拉机。后因技术员失误烧出废砖破产欠债。'],
  ['煤矿', '铜城大牙湾煤矿井下黑暗闷热煤尘大。少平下井上来脸全黑只剩眼白。'],
  ['黑面馍', '开头是黄土高原的雨雪天。孙少平在县高中吃黑面馍，躲着同学吃，穷得只剩自尊。'],
  ['零工', '孙少平在黄原城东关大桥头蹲着等零工。扛石头背水泥，脊背磨烂。'],
  ['影院', '田晓霞在黄原影院门口与孙少平重逢。两人确立恋情。'],
  ['拖拉机', '少安砖窑致富后买了村里第一台拖拉机，是村里第一个买机器的人。'],
  ['黄土高原', '故事发生在黄土高原上的陕北农村。一年到头风沙大，地干裂，人靠天吃饭。'],
]

const MEMORY = RAW.map(([key, body], i) => ({
  id: `m${i}`, key, body,
  title: key,
  summary: deterministicSummary(body, 160),
  edges: inferRelations(key, body),
  kind: inferEntryKind(key, body),
}))

const FEATURES = computeFeatures(MEMORY.map(m => ({ id: m.key, text: `${m.title} ${m.summary}` })))

// 不含实体名的问法（困难场景）
const HARD = {
  孙少平: ['那个在煤矿下井的年轻人是谁？', '主角后来去哪打工了？'],
  田晓霞: ['那个当记者的姑娘怎么牺牲的？', '在抗洪里救人死的是谁？'],
  孙少安: ['办砖窑的那个人是谁？', '生产队长后来怎么样了？'],
  贺秀莲: ['少安的媳妇得的什么病？', '那个山西来的女人最后怎样？'],
  田润叶: ['那个当老师的女人嫁给谁了？', '少安的青梅竹马是谁？'],
  李向前: ['出车祸截肢的那个司机是谁？', '润叶的丈夫后来怎么了？'],
  孙玉厚: ['那个老实巴交的老汉是谁？', '少平的父亲是个什么样的人？'],
  孙兰香: ['考上大学学物理的那个女孩是谁？', '孙家最小的孩子后来怎样？'],
  金波: ['当兵时爱上藏族姑娘的那个人是谁？', '少平那个好朋友叫什么？'],
  田福军: ['那个地委书记是谁？', '润叶的叔叔当什么官？'],
  郝红梅: ['高中时跟少平有点情愫的那个女生是谁？', '后来跟顾养民好的是谁？'],
  惠英嫂: ['矿上那个寡妇是谁？', '丈夫矿难死后被少平照顾的女人是谁？'],
  双水村: ['故事发生在哪个村？', '原西县下面那个村子叫什么？'],
  砖窑: ['烧出废砖破产的那档子事是怎么回事？', '买了第一台拖拉机的营生是什么？'],
  煤矿: ['井下上来脸全黑只剩眼白的地方是哪？', '铜城那个矿叫什么？'],
  黑面馍: ['开头那个躲着同学吃饭的场景是怎么回事？', '穷得只吃得起黑面馍的是谁？'],
  零工: ['蹲在桥头等活扛石头的是谁？', '脊背磨烂那段写的是什么？'],
  影院: ['两人在影院门口重逢是怎么回事？', '黄原哪个地方重逢的？'],
  拖拉机: ['村里第一台机器是谁买的？', '少安致富后买了什么？'],
  黄土高原: ['故事发生在什么地形上？', '风沙大、地干裂的地方是哪儿？'],
}

/** flags: { kinship, relation, intent, feature } */
function run(flags) {
  let hit1 = 0, hit3 = 0, n = 0
  for (const m of MEMORY) {
    for (const q of HARD[m.key] ?? []) {
      n++
      const resolved = flags.kinship ? resolvePronoun(q, null) : q
      const extra = flags.kinship ? expandKinshipAndRole(resolved) : []
      const tokens = extra.length === 0
        ? tokenize(resolved)
        : [...new Set([...tokenize(resolved), ...tokenize(extra.join(' '))])]

      const answerKind = flags.intent ? detectAnswerKind(resolved) : 'unknown'
      const ranked = MEMORY
        .map((x) => {
          let s = semanticScore({ title: x.title, summary: x.summary, tags: [], date: '', time: '' }, tokens)
          if (flags.intent && answerKind !== 'unknown' && x.kind !== 'unknown') {
            s *= kindMatches(answerKind, x.kind) ? 2.2 : 0.35
          }
          if (flags.feature) {
            const ft = featureScore(tokens, FEATURES.get(x.key))
            if (ft > 0) s *= 1 + ft * 0.5
          }
          return { m: x, s }
        })
        .filter(r => r.s > 0)
        .sort((a, b) => b.s - a.s)

      if (flags.relation) {
        const exp = expandOneHop(ranked.slice(0, 3).map(r => ({ title: r.m.title, edges: r.m.edges })), resolved)
        const top = ranked[0]?.s ?? 0
        for (const t of exp.targets) {
          if (ranked.some(r => sameEntity(t, r.m.key))) continue
          const nb = MEMORY.find(x => sameEntity(t, x.key))
          if (nb) ranked.push({ m: nb, s: top * (exp.neighbourIsAnswer ? 1.05 : 0.7) })
        }
        ranked.sort((a, b) => b.s - a.s)
      }

      const rank = ranked.findIndex(r => r.m.key === m.key)
      if (rank === 0) hit1++
      if (rank >= 0 && rank < 3) hit3++
    }
  }
  return { n, hit1, hit3 }
}

const p = (a, b) => `${((a / b) * 100).toFixed(0)}%`
const configs = [
  ['基线（全关）', { kinship: false, relation: false, intent: false, feature: false }],
  ['+称谓消解', { kinship: true, relation: false, intent: false, feature: false }],
  ['+关系一跳', { kinship: true, relation: true, intent: false, feature: false }],
  ['+意图类型', { kinship: true, relation: true, intent: true, feature: false }],
  ['+唯一特征（全开）', { kinship: true, relation: true, intent: true, feature: true }],
]

console.log('=== 逐项叠加（不含名问法 40 条）===\n')
console.log('  配置                  top1    top3')
for (const [label, flags] of configs) {
  const r = run(flags)
  console.log(`  ${label.padEnd(20)} ${p(r.hit1, r.n).padStart(5)}  ${p(r.hit3, r.n).padStart(5)}`)
}
