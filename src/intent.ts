/**
 * 提问意图识别：从问句里判断**用户想知道什么类型的东西**。
 *
 * 为什么需要（见 multi-round-report §4）：
 *   问「那个在煤矿下井的年轻人**是谁**」→ 答案是一个**人物**
 *   问「故事发生在**哪个村**」        → 答案是一个**地点**
 *   问「烧出废砖破产的那档子事**是什么**」→ 答案是一个**事件**
 *
 * 但检索时不知道这个区别，于是"煤矿"这个词同时命中人物、地点、事件三条，
 * 分不出主次。先判意图，再按类型收窄候选，能砍掉 2/3 的干扰。
 *
 * 本模块只做判断，不改存储 —— 类型信息由调用方决定怎么用。
 * @module dsh-memory/src/intent
 */

/** 用户想知道的对象类型。 */
export type AnswerKind = 'person' | 'place' | 'event' | 'time' | 'unknown'

/** 各类型的判断词（按优先级从具体到宽泛）。 */
const PATTERNS: Array<{ kind: AnswerKind, cues: string[] }> = [
  // 「谁」「哪个人」「什么人」「是谁」→ 人物
  { kind: 'person', cues: ['是谁', '谁', '哪个人', '什么人', '哪位', '叫什么名字', '那人'] },
  // 「哪」「哪里」「什么地方」「在哪儿」→ 地点
  { kind: 'place', cues: ['哪个村', '哪个地方', '哪里', '哪儿', '什么地方', '在哪', '什么地形'] },
  // 「什么时候」「哪一年」「多久」→ 时间
  { kind: 'time', cues: ['什么时候', '哪一年', '哪年', '多久', '几月', '几年'] },
  // 「什么事」「怎么回事」「发生了什么」「那档子事」→ 事件
  { kind: 'event', cues: ['什么事', '怎么回事', '发生了什么', '那档子事', '那件事', '经过'] },
]

/**
 * 判断提问想要什么类型。
 *
 * 顺序很重要：**先判人物/地点/时间这些具体的**，最后才判事件
 * （"怎么回事"太宽泛，容易吃掉别人）。
 *
 * @param query - 用户问句。
 * @returns 期望的答案类型；判断不出返回 `unknown`。
 */
export function detectAnswerKind(query: string): AnswerKind {
  const q = String(query ?? '').trim()
  if (q === '') return 'unknown'

  // 人物 / 地点 / 时间按顺序检查（越具体的先判）
  for (const { kind, cues } of PATTERNS) {
    if (kind === 'event') continue // 事件最后判
    if (cues.some(c => q.includes(c))) return kind
  }
  // 事件
  const eventPattern = PATTERNS.find(p => p.kind === 'event')
  if (eventPattern !== undefined && eventPattern.cues.some(c => q.includes(c))) return 'event'
  return 'unknown'
}

/**
 * 条目类型 → 能回答哪类提问。
 *
 * 映射故意**放宽**：人物条目也常含地点/事件信息（"孙少平在煤矿"），
 * 所以 person 条目对 place 提问也算"可能相关"，只是优先级低。
 */
export function kindMatches(answerKind: AnswerKind, entryKind: string): boolean {
  if (answerKind === 'unknown') return true // 判不出就不收窄
  switch (answerKind) {
    case 'person':
      return entryKind === 'person'
    case 'place':
      return entryKind === 'place' || entryKind === 'person'
    case 'time':
      return true // 时间信息散落在各类条目里，不收窄
    case 'event':
      return entryKind === 'event' || entryKind === 'person'
    default:
      return true
  }
}

/**
 * 从条目文本里猜它的类型（写入时用，或老条目补标注时用）。
 *
 * 判据克制：靠 title/summary 里的特征词，不猜太多。
 */
export function inferEntryKind(title: string, text: string): 'person' | 'place' | 'event' | 'unknown' {
  const t = String(title ?? '').trim()
  const body = `${t} ${String(text ?? '')}`

  // **先判人名**：2–4 个汉字的 title 且正文提到人物特征词，就是人。
  // 必须放在地点前面 —— 否则「孙少平是主角…煤矿矿工」会被正文里的"煤矿"判成地点
  // （这个错踩过一次：20 个条目里 4 个人物被判成 place，含名问法从 100% 掉到 85%）。
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(t)) {
    const personCues = /(主角|是.*之|相爱|相恋|牺牲|结婚|后来|父亲|母亲|之妻|之兄|之妹|好友|队长|记者|矿工|教师|司机|农民|干部|书记)/
    if (personCues.test(body)) return 'person'
  }

  // 地点：title 后缀明显，或正文明确在讲地点层级
  if (/[村镇县市省山河矿城]$/.test(t)) return 'place'
  if (/(隶属于|位于|在.*省|村|县城|矿区)/.test(body)) return 'place'

  // 事件：动宾结构或含"事件/事故/行动/计划"
  if (/(事件|事故|行动|计划|战役|破产|爆发|重逢|牺牲)/.test(body)) return 'event'

  return 'unknown'
}
