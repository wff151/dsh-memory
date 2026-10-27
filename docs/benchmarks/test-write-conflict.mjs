// 验证：并发读写同一文件时，rename 会不会 EPERM。
//
// 假设：插件在宿主进程内写回时，宿主另一个部分正持有该文件的读句柄，
// 导致 rename 失败。用并发测试验证这个机制。
import { open, rename, rm, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const TARGET = 'C:/Users/525yy/.dsh/storages/brain_memory.json'

async function writeAtomic(path, data) {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  const h = await open(tmp, 'wx', 0o600)
  try { await h.writeFile(data, 'utf8'); await h.sync() } finally { await h.close() }
  await rename(tmp, path)
}

const data = await readFile(TARGET, 'utf8')

// 场景 1：目标文件正被一个读句柄持有（模拟宿主在读）
{
  const holder = await open(TARGET, 'r')   // 保持打开
  try {
    await writeAtomic(TARGET, data)
    console.log('场景1（有读句柄持有）：rename 成功')
  } catch (e) {
    console.log('场景1（有读句柄持有）：失败', e.code)
  } finally {
    await holder.close()
  }
}

// 场景 2：两个写入并发
{
  const results = await Promise.allSettled([
    writeAtomic(TARGET, data),
    writeAtomic(TARGET, data),
  ])
  const failed = results.filter(r => r.status === 'rejected')
  console.log(`场景2（两个并发写）：成功 ${results.length - failed.length}/${results.length}`)
  for (const f of failed) console.log('  失败:', f.reason?.code)
}
