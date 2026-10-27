// 验证上下文窗口的三条触发：定时 / 换模型 / 闲置后。
//
// 复刻 index.ts 里 noteContextWindow 的判定逻辑并逐条测试。
// 这段逻辑不依赖 cordis，所以可以脱离宿主单测。
import fs from 'node:fs'

/** 与 index.ts 中 noteContextWindow 完全一致的判定逻辑。 */
function makeProber(opts) {
  const probeMs = opts.probeHours * 3_600_000
  const idleMs = opts.idleHours * 3_600_000
  let probed = 0
  let lastAt = 0
  let lastKey = ''
  const log = []
  return {
    note(win, provider, model, now) {
      const key = `${provider}/${model}`
      const modelChanged = lastKey !== '' && lastKey !== key
      const dueByTime = lastAt === 0 || now - lastAt >= probeMs
      const dueByIdle = lastAt !== 0 && now - lastAt >= idleMs
      const firstTime = probed === 0
      if (!firstTime && !modelChanged && !dueByTime && !dueByIdle) return false
      probed = win
      lastAt = now
      lastKey = key
      const reason = firstTime
        ? '首次'
        : modelChanged
          ? '模型已换'
          : dueByTime
            ? '定时'
            : '闲置后'
      log.push({ win, reason, key })
      return true
    },
    get value() { return probed },
    get log() { return log },
  }
}

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  —— ' + detail : ''}`) }
}

const H = 3_600_000
const T0 = 1_700_000_000_000

// ── 1. 首次一定采纳 ─────────────────────────────────────────────
{
  const p = makeProber({ probeHours: 12, idleHours: 12 })
  check('首次采纳', p.note(65536, 'deepseek', 'v3', T0) === true)
  check('首次值正确', p.value === 65536, `实际 ${p.value}`)
  check('原因为首次', p.log[0].reason === '首次')
}

// ── 2. 同一模型、间隔不足 → 不覆盖 ───────────────────────────────
{
  const p = makeProber({ probeHours: 12, idleHours: 12 })
  p.note(65536, 'deepseek', 'v3', T0)
  check('间隔 1h 不覆盖', p.note(99999, 'deepseek', 'v3', T0 + 1 * H) === false)
  check('值未变', p.value === 65536, `实际 ${p.value}`)
}

// ── 3. 定时触发（超过 probeHours）────────────────────────────────
{
  const p = makeProber({ probeHours: 12, idleHours: 12 })
  p.note(65536, 'deepseek', 'v3', T0)
  check('间隔 13h 覆盖', p.note(131072, 'deepseek', 'v3', T0 + 13 * H) === true)
  check('值已更新', p.value === 131072, `实际 ${p.value}`)
  check('原因为定时', p.log[1].reason === '定时', p.log[1].reason)
}

// ── 4. 换模型 → 立即覆盖（不受间隔限制）──────────────────────────
{
  const p = makeProber({ probeHours: 12, idleHours: 12 })
  p.note(65536, 'deepseek', 'v3', T0)
  check('换模型即时覆盖', p.note(1000000, 'openai', 'gpt', T0 + 1 * H) === true)
  check('值已更新为 1M', p.value === 1000000, `实际 ${p.value}`)
  check('原因为模型已换', p.log[1].reason === '模型已换', p.log[1].reason)
}

// ── 5. 闲置后触发 ──────────────────────────────────────────────
// probeHours 设得很长（48h），只让 idle 触发（12h）
{
  const p = makeProber({ probeHours: 48, idleHours: 12 })
  p.note(65536, 'deepseek', 'v3', T0)
  check('闲置 13h 触发（probe 还没到）', p.note(131072, 'deepseek', 'v3', T0 + 13 * H) === true)
  check('原因为闲置后', p.log[1].reason === '闲置后', p.log[1].reason)
}

// ── 6. 窗口值非法时不采纳 ───────────────────────────────────────
// （这条测的是"过滤在调用方"，这里模拟调用方的守卫）
{
  const p = makeProber({ probeHours: 12, idleHours: 12 })
  const guard = (win) => (typeof win === 'number' && win > 0 ? p.note(win, 'a', 'b', T0) : false)
  check('window=0 不采纳', guard(0) === false)
  check('window=undefined 不采纳', guard(undefined) === false)
  check('值仍为 0', p.value === 0, `实际 ${p.value}`)
}

// ── 7. 手动模式优先于探测 ──────────────────────────────────────
{
  const effective = (manual, probed) => (manual > 0 ? manual : probed)
  check('手动 > 0 时用手动', effective(32768, 131072) === 32768)
  check('手动 = 0 时用探测', effective(0, 131072) === 131072)
  check('都为 0 → 返回 0（占比触发会跳过）', effective(0, 0) === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
