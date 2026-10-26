// Aggregates the dsh-memory algorithm self-tests.
//
// Run from the package dir:  node --import tsx/esm tests/run-all.mjs
// Pure-Node, no LLM. Only vector-test.mjs needs the OpenAI-compatible
// /v1/embeddings service (default http://127.0.0.1:8081, model alias
// qwen2-0.5b-embed); when it is offline that ONE suite is reported as skipped
// instead of faking a pass — start the embedding server and re-run to include
// it. Every other suite (including budget's keyword path) runs offline.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const healthUrl = process.env.EMBED_HEALTH ?? 'http://127.0.0.1:8081/health'

async function embeddingUp () {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const needsEmbedding = new Set(['vector-test.mjs'])
const files = readdirSync(here).filter(f => f.endsWith('-test.mjs')).sort()
const up = await embeddingUp()

let passedSuites = 0
let failedSuites = 0
const skipped = []

for (const file of files) {
  if (needsEmbedding.has(file) && !up) {
    skipped.push(`${file} (embedding offline: ${healthUrl})`)
    continue
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(here, file)], { stdio: 'inherit' })
  if (result.status === 0) passedSuites++
  else failedSuites++
}

console.log('\n== run-all summary ==')
console.log(`suites passed: ${passedSuites}, failed: ${failedSuites}, skipped: ${skipped.length}`)
for (const note of skipped) console.log(`  skip: ${note}`)
process.exit(failedSuites === 0 ? 0 : 1)
