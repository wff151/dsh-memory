// summarize-test: 确定性摘要 + 详情文档。纯函数，零模型。
//
// 这两个函数的职责必须分清：
//   摘要 = 索引（短，用于判断"要不要翻"）
//   详情 = 正文（按时间线条目排列，真正回忆时的依据）
import assert from 'node:assert/strict'
import { deterministicSummary, buildDetailDoc } from '../src/summarize.ts'

let checks = 0
function ok(name, fn) {
  try {
    fn()
    checks++
    console.log(`  ok   ${name}`)
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}

// ── 短文本不压缩 ─────────────────────────────────────────────
ok('短文本原样返回', () => {
  const t = '目标目录为空'
  assert.equal(deterministicSummary(t), t)
})

ok('空输入返回空', () => {
  assert.equal(deterministicSummary(''), '')
  assert.equal(deterministicSummary('   '), '')
})

// ── 多句累加（策略变更 2026-10-26）──────────────────────────────
// 旧行为：只取首句。实测摘要中位只有 50 字（上限 160），仅 12% 填满；
// 且首句常是"身份标签"（"你是…实验员。"），后面实质内容全丢。
// 新行为：首句打底 + 后续句子按顺序补到上限。
ok('长文本取首句并向后补句', () => {
  const t = '第一句话说完了这件事。第二句在这里啰嗦很多很多内容，完全不需要保留这一部分。'
  const s = deterministicSummary(t)
  assert.ok(s.startsWith('第一句话说完了这件事。'), `首句丢了：${s}`)
  assert.ok(s.includes('第二句'), `没有向后补句：${s}`)
})

ok('补句不会超过上限', () => {
  const t = '一句话。'.repeat(100)
  const s = deterministicSummary(t, 60)
  assert.ok(s.length <= 60, `超长：${s.length}`)
})

ok('首句太短时向后扩展，避免摘要无信息量', () => {
  const t = '好的。后面才是真正的内容，这里有很多值得保留的信息，不能只留三个字。'
  const s = deterministicSummary(t)
  assert.ok(s.length > 3, `摘要太短：${s}`)
  assert.ok(s.includes('后面才是真正的内容'), `没有向后扩展：${s}`)
})

// ── 子句边界截断（不砍在半个词上）──────────────────────────────
ok('首句过长时按逗号截断，保留完整语义单元', () => {
  const t = `${'甲'.repeat(80)}，${'乙'.repeat(80)}，${'丙'.repeat(80)}。`
  const s = deterministicSummary(t, 120)
  assert.ok(s.length <= 130, `超长：${s.length}`)
  assert.ok(s.endsWith('…'), `应标记还有后文：${s}`)
  // 断点应落在逗号处（值边界），而不是砍掉半个字符序列
  assert.ok(s.startsWith('甲'), `开头丢了：${s}`)
})

ok('maxChars 可以调小', () => {
  const t = '一二三四五六七八九十，'.repeat(20)
  const s = deterministicSummary(t, 40)
  assert.ok(s.length <= 50, `超长：${s.length}`)
})

// ── 详情文档：时间线条目 ──────────────────────────────────────
ok('详情按行编号，形成时间线', () => {
  const t = '收到报警\n排查日志\n定位到连接池泄漏\n已修复并观察'
  const doc = buildDetailDoc(t, { title: '线上故障', when: '2026-10-25', source: 'test' })
  assert.ok(doc.includes('# 线上故障'), '缺标题')
  assert.ok(doc.includes('时间：2026-10-25'), '缺时间')
  assert.ok(doc.includes('来源：test'), '缺来源')
  assert.ok(doc.includes('1. 收到报警'), '条目编号错')
  assert.ok(doc.includes('3. 定位到连接池泄漏'), '条目丢了')
})

ok('详情无换行时按句切分', () => {
  const t = '做了甲。又做了乙。最后做了丙。'
  const doc = buildDetailDoc(t, { title: '过程' })
  assert.ok(doc.includes('1. 做了甲。'), `首条缺失：\n${doc}`)
  assert.ok(doc.includes('3.'), '句数不足')
})

ok('详情保留原文措辞，不做改写', () => {
  const t = '用户说要保留原话，不要总结'
  const doc = buildDetailDoc(t)
  assert.ok(doc.includes('用户说要保留原话，不要总结'), '原文被改写了')
})

ok('详情超长时截断并标注原长', () => {
  const t = '很长的一行内容，'.repeat(500)
  const doc = buildDetailDoc(t, { maxChars: 200 })
  assert.ok(doc.length < 400, `没截断：${doc.length}`)
  assert.ok(doc.includes('已截断'), '缺截断标记')
})

ok('详情空输入返回空', () => {
  assert.equal(buildDetailDoc(''), '')
  assert.equal(buildDetailDoc('   '), '')
})

// ── 摘要与详情是两个不同的东西 ────────────────────────────────
ok('同一份正文：摘要短、详情长且含原文', () => {
  const body = '这是一段很长的记录。'.repeat(30)
  const s = deterministicSummary(body)
  const d = buildDetailDoc(body, { title: 'T' })
  assert.ok(s.length < d.length, '摘要必须比详情短')
  assert.ok(s.length <= 200, `摘要超长：${s.length}`)
  assert.ok(d.includes('这是一段很长的记录'), '详情必须含原文')
})

console.log(`\nsummarize-test: ${checks} checks`)
