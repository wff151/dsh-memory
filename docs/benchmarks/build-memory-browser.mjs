// 生成记忆浏览快照页（单文件 HTML，离线可看）。
//
// 五个页签：
//   长期记忆   —— 时间轴（按 date 排，左旧右新）
//   短期记忆   —— 气泡（按关键词分组，权重越大气泡越大）
//   用户画像   —— 属性/喜好/技能/关系网
//   AI 画像    —— evolution type='self' + 反思
//   进化档案   —— 错题日志/提案/规则/反思
//
// 为什么要快照而不是实时：客户端模块只能拿配置（configForms），
// 拿不到记忆数据。实时渲染需要宿主 typert 协议，另行处理。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA = process.env.DSH_MEMORY_JSON
  ?? `${process.env.USERPROFILE ?? process.env.HOME}/.dsh/storages/brain_memory.json`
// 默认输出到本文件旁边的 memory-browser.html。
// **不提交进仓库**——它含个人记忆内容（对话原文、本机路径）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] ?? path.join(HERE, 'memory-browser.html')

const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'))
const rows = (x) => (Array.isArray(x) ? x : (x?.rows ?? Object.values(x ?? {})))

const pub = rows(raw.tables.public)
const sh = rows(raw.tables.short)
const perm = rows(raw.tables.permanent)[0] ?? { attributes: {}, preferences: {}, skills: [], relationships: [], sources: {} }
const portable = rows(raw.tables.portable)
const evo = rows(raw.tables.evolution)

// ── 工具 ─────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const dayOf = (iso) => String(iso ?? '').slice(0, 10)
const fmtTime = (iso) => {
  const s = String(iso ?? '')
  if (s.length < 16) return s
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`
}

/** 估算 token（与插件内 estimateTokens 同口径）。 */
function estTokens(s) {
  const str = String(s ?? '')
  let n = 0
  for (const r of str.match(/[a-z0-9_]+/gi) ?? []) n += Math.max(1, Math.ceil(r.length / 4))
  n += (str.match(/[\u4e00-\u9fff]/g) ?? []).length
  return n
}

// ── 长期记忆：按时间轴 ────────────────────────────────────────────
const longByDay = new Map()
for (const m of pub) {
  const d = dayOf(m.time ?? m.date)
  if (!longByDay.has(d)) longByDay.set(d, [])
  longByDay.get(d).push(m)
}
const longDays = [...longByDay.keys()].sort()

// ── 短期记忆：按标签分组，权重决定气泡大小 ────────────────────────
// 主标签：answer > auto-record > 其他；这样能把"我说的话"和"我说的话（回答）"分开
function primaryTag(item) {
  const tags = item.tags ?? []
  if (tags.includes('answer')) return '回答'
  if (tags.includes('auto-record')) return '消息'
  const custom = tags.filter(t => t !== 'auto-record' && t !== 'answer')
  return custom[0] ?? '未分类'
}

const bubbleGroups = new Map()
for (const s of sh) {
  const g = primaryTag(s)
  if (!bubbleGroups.has(g)) bubbleGroups.set(g, [])
  bubbleGroups.get(g).push(s)
}
// 每组内按权重降序
for (const [, list] of bubbleGroups) list.sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))

const maxWeight = Math.max(...sh.map(s => s.weight ?? 1), 1)

// ── 统计 ────────────────────────────────────────────────────────
const stats = {
  public: pub.length,
  short: sh.length,
  portable: portable.length,
  evolution: evo.length,
  longTokens: pub.reduce((a, m) => a + estTokens(`${m.title} ${m.summary}`), 0),
  shortTokens: sh.reduce((a, m) => a + estTokens(m.content), 0),
}
const attrs = Object.keys(perm.attributes ?? {}).length
const prefs = Object.keys(perm.preferences ?? {}).length
const rels = (perm.relationships ?? []).length

// ── 渲染 ────────────────────────────────────────────────────────
const TABS = [
  { id: 'long', label: '长期记忆', desc: '跨会话不遗忘。按时间轴排列，越靠右越新。' },
  { id: 'short', label: '短期记忆', desc: '会衰减的工作记忆。按分组排列，权重越大气泡越大。' },
  { id: 'user', label: '用户画像', desc: '关于你的稳定信息：属性、喜好、技能、人际关系。' },
  { id: 'self', label: 'AI 画像', desc: '关于我自己的：自我认知、教训、工作方式。' },
  { id: 'evo', label: '进化档案', desc: '错题日志、改进提案、规则、反思。' },
]

function renderLong() {
  if (longDays.length === 0) return '<p class="empty">还没有长期记忆。</p>'
  const lanes = longDays.map((d) => {
    const items = longByDay.get(d)
    const cards = items.map((m) => {
      const body = esc(m.summary)
      // 超过 120 字才折叠，短的直接展开
      const isLong = String(m.summary ?? '').length > 120
      return `
      <div class="tl-card">
        <div class="tl-title">${esc(m.title)}</div>
        <div class="tl-meta">${esc(fmtTime(m.time))} · ${esc(m.mode)} ${(m.tags ?? []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <div class="tl-body${isLong ? ' long' : ''}">${body}</div>
        ${isLong ? `<button class="tl-toggle">展开</button>` : ''}
        ${m.detail ? `<details><summary>详情</summary><pre>${esc(m.detail)}</pre></details>` : ''}
      </div>`
    }).join('')
    return `
      <div class="tl-day">
        <div class="tl-date">${esc(d)}<span class="tl-count">${items.length} 条</span></div>
        <div class="tl-items">${cards}</div>
      </div>`
  }).join('')
  return `<div class="timeline">${lanes}</div>`
}

function renderShort() {
  if (sh.length === 0) return '<p class="empty">还没有短期记忆。</p>'
  // 权重分布提示：如果几乎全是同一个值，说明"按权重"看不出差别，
  // 需要在页面上说清楚，否则会被误以为是渲染 bug。
  const weights = sh.map(s => s.weight ?? 1)
  const uniqW = new Set(weights.map(w => w.toFixed(2)))
  const weightNote = uniqW.size <= 2
    ? `<p class="desc" style="color:#c2410c">注意：本库 ${sh.length} 条里有 ${sh.length} 条的权重几乎相同（只有 ${uniqW.size} 种取值），
       所以气泡大小主要按**内容长度**区分。这是历史数据未真正衰减的结果——
       插件已修好该 bug，新产生的记忆会正常衰减。</p>`
    : ''
  const groups = [...bubbleGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, list]) => {
      const bubbles = list.slice(0, 120).map((s) => {
        const w = s.weight ?? 1
        // 气泡半径 = 权重 + 信息量。
        //
        // 只用权重会变成一片同样大的圆：实测 616 条里 615 条权重都是 1.0
        // （因为"衰减后权重从没写回存储"那个 bug，历史上从没真正衰减过）。
        // 权重相同时用**内容长度**做次级区分，至少让"说了很多"和"只说一句"能分开。
        const len = String(s.content ?? '').length
        const lenNorm = Math.min(1, len / 200)
        const wNorm = Math.min(1, w / maxWeight)
        const size = 44 + wNorm * 50 + lenNorm * 22
        const text = String(s.title ?? s.summary ?? s.content ?? '').slice(0, 40)
        return `<div class="bubble" style="width:${size}px;height:${size}px;font-size:${Math.max(9, 13 - (size - 44) / 16).toFixed(1)}px"
             title="权重 ${w.toFixed(2)} · ${len} 字&#10;${esc(s.content).slice(0, 400)}">
             <span>${esc(text)}</span>
           </div>`
      }).join('')
      const more = list.length > 120 ? `<div class="more">…另有 ${list.length - 120} 条</div>` : ''
      return `<div class="bgroup"><h3>${esc(name)} <span class="gcount">${list.length} 条</span></h3><div class="bubbles">${bubbles}${more}</div></div>`
    }).join('')
  return weightNote + groups
}

function renderUser() {
  const a = Object.entries(perm.attributes ?? {})
  const p = Object.entries(perm.preferences ?? {})
  const sk = perm.skills ?? []
  const rl = perm.relationships ?? []
  if (a.length + p.length + sk.length + rl.length === 0) {
    return `<p class="empty">用户画像还是空的。<br><small>它由 <code>brain profile</code> 写入；目前还没有人调用过。</small></p>`
  }
  const block = (title, body) => `<div class="pf-block"><h3>${title}</h3>${body}</div>`
  return [
    a.length ? block('属性', `<dl>${a.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>`) : '',
    p.length ? block('喜好', `<dl>${p.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>`) : '',
    sk.length ? block('技能', `<ul>${sk.map(s => `<li>${esc(typeof s === 'object' ? JSON.stringify(s) : s)}</li>`).join('')}</ul>`) : '',
    rl.length ? block('人际关系', `<ul>${rl.map((r) => {
      if (typeof r === 'string') return `<li>${esc(r)}</li>`
      return `<li><b>${esc(r.from)}</b> 的 ${esc(r.relation)} 是 <b>${esc(r.to)}</b>${r.note ? `（${esc(r.note)}）` : ''}</li>`
    }).join('')}</ul>`) : '',
  ].join('')
}

function renderSelf() {
  const selves = evo.filter(e => e.type === 'self')
  const reflections = evo.filter(e => e.type === 'reflection')
  if (selves.length + reflections.length === 0) {
    return `<p class="empty">AI 画像还是空的。<br><small>它由 <code>brain self</code> 与定期反思写入。</small></p>`
  }
  const cards = [...selves, ...reflections].map((e) => `
    <div class="ev-card">
      <div class="ev-head"><span class="ev-type">${esc(e.type)}</span> <span class="ev-time">${esc(fmtTime(e.timestamp))}</span></div>
      ${e.observation ? `<p><b>观察</b> ${esc(e.observation)}</p>` : ''}
      ${e.analysis ? `<p><b>归因</b> ${esc(e.analysis)}</p>` : ''}
      ${e.action ? `<p><b>行动</b> ${esc(e.action)}</p>` : ''}
    </div>`).join('')
  return cards
}

function renderEvo() {
  if (evo.length === 0) return '<p class="empty">进化档案还是空的。</p>'
  const byType = new Map()
  for (const e of evo) {
    const t = e.type ?? '未分类'
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t).push(e)
  }
  return [...byType.entries()].map(([t, list]) => `
    <div class="pf-block"><h3>${esc(t)} <span class="gcount">${list.length} 条</span></h3>
      ${list.map((e) => `
        <div class="ev-card">
          <div class="ev-head"><span class="ev-time">${esc(fmtTime(e.timestamp))}</span> ${(e.tags ?? []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>
          ${e.observation ? `<p>${esc(e.observation)}</p>` : ''}
          ${e.analysis ? `<p>${esc(e.analysis)}</p>` : ''}
          ${e.action ? `<p>${esc(e.action)}</p>` : ''}
        </div>`).join('')}
    </div>`).join('')
}

const portableNote = portable.length > 0
  ? `<div class="pf-block"><h3>随身小黑板</h3>${portable.map((d) => `
      <div class="ev-card">
        <div class="ev-head"><b>${esc(d.title)}</b> <span class="ev-time">${esc(d.sessionId)}</span></div>
        ${d.goal ? `<p><b>目标</b> ${esc(d.goal)}</p>` : ''}
        ${(d.progress ?? []).length ? `<p><b>进展</b> ${esc(d.progress.join(' / '))}</p>` : ''}
        ${(d.unresolvedProblems ?? []).length ? `<p><b>待解决</b> ${esc(d.unresolvedProblems.join(' / '))}</p>` : ''}
      </div>`).join('')}</div>`
  : ''

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆浏览 · dsh-memory</title>
<style>
  :root{
    --bg:#fbfaf7;--ink:#1f2328;--dim:#6b7280;--line:#d8d4cc;--card:#fff;
    --accent:#7c5cff;--accent2:#0f9d8f;--chip:#f2efe9;
  }
  @media (prefers-color-scheme: dark){
    :root{--bg:#15171a;--ink:#e6e4e0;--dim:#9aa0a6;--line:#33383e;--card:#1c1f23;
      --accent:#a78bfa;--accent2:#2dd4bf;--chip:#23272c;}
  }
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--ink);
    font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:21px;margin:0 0 2px}
  .sub{color:var(--dim);font-size:12px;margin:0 0 18px}
  .tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:6px;flex-wrap:wrap}
  .tab{padding:8px 14px;border:none;background:none;color:var(--dim);cursor:pointer;
    font:inherit;font-size:13px;border-bottom:2px solid transparent;border-radius:6px 6px 0 0}
  .tab:hover{background:var(--chip)}
  .tab.on{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
  .tab .n{font-size:11px;color:var(--dim);margin-left:5px}
  .panel{display:none;padding-top:12px}
  .panel.on{display:block}
  .desc{color:var(--dim);font-size:12px;margin:0 0 14px}
  .empty{padding:40px;text-align:center;color:var(--dim);background:var(--chip);border-radius:10px}
  .empty small{font-size:12px}
  /* 时间轴 */
  .timeline{border-left:2px solid var(--line);margin-left:8px;padding-left:18px}
  .tl-day{position:relative;margin-bottom:20px}
  .tl-day::before{content:"";position:absolute;left:-25px;top:6px;width:10px;height:10px;
    border-radius:50%;background:var(--accent);border:2px solid var(--bg)}
  .tl-date{font-weight:600;font-size:13px;margin-bottom:8px}
  .tl-count{color:var(--dim);font-weight:400;font-size:11px;margin-left:8px}
  .tl-items{display:flex;flex-direction:column;gap:8px}
  .tl-card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
  .tl-title{font-weight:600;font-size:13px;margin-bottom:3px}
  .tl-meta{color:var(--dim);font-size:11px;margin-bottom:5px}
  /* 正文默认折叠：有些条目的 summary 本身是整篇长文，
     不折叠会把时间轴拉成几屏高，翻起来像在滚文章而不是看时间轴。 */
  .tl-body{color:var(--dim);font-size:12px;line-height:1.6;white-space:pre-wrap;
    max-height:4.8em;overflow:hidden;position:relative}
  .tl-body.long::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1.6em;
    background:linear-gradient(transparent,var(--card))}
  .tl-body.expanded{max-height:none}
  .tl-body.expanded::after{display:none}
  .tl-toggle{background:none;border:none;color:var(--accent);font:inherit;font-size:11px;
    cursor:pointer;padding:2px 0;margin-top:2px}
  .tl-card details{margin-top:6px}
  .tl-card summary{cursor:pointer;font-size:11px;color:var(--accent)}
  .tl-card pre{white-space:pre-wrap;font-size:11px;background:var(--chip);padding:8px;border-radius:6px;margin:6px 0 0}
  .tag{display:inline-block;font-size:10px;padding:0 5px;border-radius:999px;
    border:1px solid var(--line);color:var(--dim);margin-left:4px}
  /* 气泡 */
  .bgroup{margin-bottom:22px}
  .bgroup h3{font-size:13px;margin:0 0 10px}
  .gcount{color:var(--dim);font-weight:400;font-size:11px;margin-left:6px}
  .bubbles{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .bubble{display:flex;align-items:center;justify-content:center;text-align:center;
    border-radius:50%;border:1px solid var(--line);background:var(--card);
    padding:6px;overflow:hidden;cursor:default;transition:transform .12s}
  .bubble:hover{transform:scale(1.06);border-color:var(--accent)}
  .bubble span{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;
    overflow:hidden;line-height:1.25;color:var(--dim)}
  .more{color:var(--dim);font-size:11px;align-self:center}
  /* 画像 */
  .pf-block{margin-bottom:20px}
  .pf-block h3{font-size:13px;margin:0 0 8px}
  .pf-block dl{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:6px 14px;font-size:13px}
  .pf-block dt{color:var(--dim)}
  .pf-block ul{margin:0;padding-left:18px;font-size:13px}
  /* 进化 */
  .ev-card{background:var(--card);border:1px solid var(--line);border-radius:8px;
    padding:10px 12px;margin-bottom:8px}
  .ev-head{font-size:11px;color:var(--dim);margin-bottom:5px}
  .ev-type{color:var(--accent2);font-weight:600}
  .ev-card p{margin:4px 0;font-size:12.5px;line-height:1.6}
  code{background:var(--chip);padding:1px 5px;border-radius:4px;font-size:.9em}
</style>
</head>
<body>
<div class="wrap">
  <h1>记忆浏览</h1>
  <p class="sub">
    ${stats.public} 条长期 · ${stats.short} 条短期 · ${stats.evolution} 条进化档案
    · 用户画像 ${attrs + prefs + rels} 项
    · 快照时间 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}
  </p>

  <div class="tabs">
    ${TABS.map((t, i) => {
      const n = t.id === 'long' ? stats.public
        : t.id === 'short' ? stats.short
          : t.id === 'evo' ? stats.evolution
            : t.id === 'user' ? attrs + prefs + rels
              : evo.filter(e => e.type === 'self' || e.type === 'reflection').length
      return `<button class="tab${i === 0 ? ' on' : ''}" data-tab="${t.id}">${t.label}<span class="n">${n}</span></button>`
    }).join('')}
  </div>

  ${TABS.map((t, i) => `
    <div class="panel${i === 0 ? ' on' : ''}" id="p-${t.id}">
      <p class="desc">${t.desc}</p>
      ${t.id === 'long' ? renderLong()
        : t.id === 'short' ? renderShort()
          : t.id === 'user' ? renderUser() + portableNote
            : t.id === 'self' ? renderSelf()
              : renderEvo()}
    </div>`).join('')}
</div>
<script>
  const tabs = [...document.querySelectorAll('.tab')]
  const panels = [...document.querySelectorAll('.panel')]

  function activate(id) {
    for (const t of tabs) t.classList.toggle('on', t.dataset.tab === id)
    for (const p of panels) p.classList.toggle('on', p.id === 'p-' + id)
    // 同步到 URL hash，方便分享/收藏到某一页
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id)
  }

  for (const tab of tabs) tab.addEventListener('click', () => activate(tab.dataset.tab))

  // 展开/收起长正文
  for (const btn of document.querySelectorAll('.tl-toggle')) {
    btn.addEventListener('click', () => {
      const body = btn.parentElement.querySelector('.tl-body')
      const on = body.classList.toggle('expanded')
      btn.textContent = on ? '收起' : '展开'
    })
  }

  // 初始页：URL hash 优先
  const want = location.hash.slice(1)
  if (want !== '' && document.getElementById('p-' + want) !== null) activate(want)
</script>
</body>
</html>
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html, 'utf8')
console.log('写出:', OUT)
console.log(`  长期 ${stats.public} · 短期 ${stats.short} · 进化 ${stats.evolution} · 画像 ${attrs + prefs + rels} 项`)
console.log(`  长期 ~${stats.longTokens} tokens · 短期 ~${stats.shortTokens} tokens`)
console.log(`  文件大小 ${(html.length / 1024).toFixed(1)} KB`)
