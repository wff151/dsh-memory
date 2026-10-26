// 交互宿主：dsh-memory（0.2.1 源码直跑） + 本地 llama-server(8081) 的 REPL 测试
// 运行：node --import tsx/esm tests/interactive-host.mjs
// 命令：/help 帮助，/memory 查看记忆，/resume 查看历史任务，/quit 退出
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore } from '../src/index.ts'
import { autoRecordExchange } from '../src/autorecord.ts'
import { renderShortTermProjection } from '../src/state.ts'
import { searchPublicMemory } from '../src/retrieval.ts'
import { findResumableSessions, renderResumeBrief } from '../src/resume.ts'

const MODEL_URL = process.env.MODEL_URL ?? 'http://127.0.0.1:8081'
const DATA_DIR = '../../../packages/.test-data/interactive-host'
const SESSION_ID = 'interactive-session'

// ── 存储环境（与测试套件同构） ────────────────────────────────
const ctx = new Context()
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: DATA_DIR })
await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })
const store = await MemoryStore.open(ctx)

// ── 模型探测 ──────────────────────────────────────────────────
let model = 'unknown'
try {
  const m = await fetch(`${MODEL_URL}/v1/models`).then((r) => r.json())
  model = m?.data?.[0]?.id ?? 'unknown'
  console.log(`[host] 模型在线：${model}（${MODEL_URL}）`)
} catch (e) {
  console.error(`[host] 模型离线（${MODEL_URL}）：${String(e)}`)
  console.error('[host] 请先启动 llama-server（start_ternary-bonsai-2-27b-64k-q8 - 副本.bat）')
  process.exit(1)
}

async function chat(system, user) {
  const res = await fetch(`${MODEL_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-no-key' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: 1024,
    }),
  })
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`)
  const j = await res.json()
  return j?.choices?.[0]?.message?.content ?? '(无回复)'
}

// ── 每轮：记忆投影 → LLM → 写回 ───────────────────────────────
async function turn(text) {
  const short = renderShortTermProjection(store, 'daily')
  const long = searchPublicMemory(store, text, { topK: 4 })
  const longText = long.results.length
    ? long.results.map((r) => `- ${r.item.title}：${r.item.summary}`).join('\n')
    : '(无相关长期记忆)'
  const brief = renderResumeBrief(findResumableSessions(store))
  const system = [
    '你是带记忆的助手。下面是你当前能看到的记忆状态：',
    `【短期投影（当前任务/状态/最近变更）】\n${short || '(空)'}`,
    `【相关长期记忆】\n${longText}`,
    `【历史任务摘要】\n${brief}`,
    '',
    '回答用户。记忆有相关信息就基于记忆回答；记忆无关就正常回答。',
  ].join('\n')
  const reply = await chat(system, text)
  console.log(`\n[模型] ${reply}`)
  const w = await autoRecordExchange(store, SESSION_ID, text, {})
  console.log(`[记忆] 已写入 short=${w.short} long=${w.long} portable=${w.portable}`)
}

function showMemory() {
  const short = renderShortTermProjection(store, 'daily')
  const longAll = store.listPublicMemories('daily')
  console.log('── 短期投影 ──')
  console.log(short || '(空)')
  console.log('── 长期记忆（全部） ──')
  console.log(longAll.length ? longAll.map((m) => `- [${m.mode}] ${m.title}：${m.summary}`).join('\n') : '(空)')
}

// ── REPL ───────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout })
console.log('[host] dsh-memory 0.2.1 交互宿主已就绪。输入消息测试，/help 查看命令。')
function prompt() { rl.setPrompt('你> ') ; rl.prompt() }
prompt()
rl.on('line', async (raw) => {
  const line = raw.trim()
  if (!line) { prompt(); return }
  if (line === '/quit') { rl.close(); return }
  if (line === '/help') {
    console.log('/help 帮助 /memory 查看记忆 /resume 查看历史任务 /quit 退出')
    prompt(); return
  }
  if (line === '/memory') { showMemory(); prompt(); return }
  if (line === '/resume') {
    const b = renderResumeBrief(findResumableSessions(store))
    console.log(b)
    prompt(); return
  }
  try {
    await turn(line)
  } catch (e) {
    console.error(`[host] 出错：${String(e)}`)
  }
  prompt()
})
rl.on('close', () => { console.log('\n[host] 再见'); process.exit(0) })
