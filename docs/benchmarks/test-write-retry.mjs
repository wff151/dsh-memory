// 验证写重试：模拟 EPERM 几次后成功，确认退避重试能救回来。
//
// 复刻 store.ts 里 withRetry 的逻辑（不含 TS 类型）。
function withRetry(op, what, attempts = 6) {
  let lastError
  return (async () => {
    for (let i = 0; i < attempts; i++) {
      try {
        return await op()
      } catch (error) {
        const code = error?.code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
        lastError = error
        await new Promise(r => setTimeout(r, Math.min(320, 20 * 2 ** i)))
      }
    }
    throw lastError
  })()
}

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  —— ' + detail : ''}`) }
}

const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' })

// ── 1. 一次成功 ────────────────────────────────────────────────
{
  let calls = 0
  const r = await withRetry(async () => { calls++; return 'ok' }, 't')
  check('无错时直接成功', r === 'ok' && calls === 1, `calls=${calls}`)
}

// ── 2. 连失败 3 次后成功（模拟读句柄很快释放）────────────────────
{
  let calls = 0
  const r = await withRetry(async () => {
    calls++
    if (calls <= 3) throw eperm()
    return 'recovered'
  }, 't')
  check('失败 3 次后重试成功', r === 'recovered', `r=${r}`)
  check('总尝试 4 次', calls === 4, `calls=${calls}`)
}

// ── 3. 一直失败 → 最终抛出（不无限重试）──────────────────────────
{
  let calls = 0
  let threw = false
  try {
    await withRetry(async () => { calls++; throw eperm() }, 't', 4)
  } catch (e) {
    threw = e.code === 'EPERM'
  }
  check('持续失败会抛出', threw)
  check('只尝试了 4 次', calls === 4, `calls=${calls}`)
}

// ── 4. 非 EPERM 错误立即抛（不吞真问题）─────────────────────────
{
  let calls = 0
  let threw = false
  try {
    await withRetry(async () => { calls++; throw Object.assign(new Error('x'), { code: 'ENOSPC' }) }, 't')
  } catch (e) {
    threw = e.code === 'ENOSPC'
  }
  check('非 EPERM 立即抛出', threw)
  check('只尝试 1 次（没有无谓重试）', calls === 1, `calls=${calls}`)
}

// ── 5. 退避总时长合理（约 0.6 秒内）─────────────────────────────
{
  const t0 = Date.now()
  try { await withRetry(async () => { throw eperm() }, 't', 6) } catch { /* 预期 */ }
  const ms = Date.now() - t0
  check('6 次退避总耗时 < 1.5s', ms < 1500, `${ms}ms`)
  check('6 次退避总耗时 > 0.3s（确实等了）', ms > 300, `${ms}ms`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
