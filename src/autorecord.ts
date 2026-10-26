/**
 * Auto-record: user exchanges landed into every memory tier at once.
 *
 * 现状（before）：index.ts 的 agent/inbox/claimed 钩子只写随身文档（portable
 * doc），对话内容只活在会话内。
 *
 * 双写（after）：一次用户消息同时落三层——
 *   1. 短期记忆（writeShortTerm）：当前工作记忆，重复内容自动提权；
 *   2. 长期公共记忆（recordPublicMemory）：跨会话可检索，带去重与长度门槛，
 *      避免每条消息都污染长期库；
 *   3. 随身文档（recordExchange）：保留原有行为，维持会话内目标/解决清单。
 *
 * 每层可用 autoRecord 配置独立开关，默认全开；内容各自截断，防止长消息
 * 撑爆短期窗口与长期库。
 * @module dsh-memory/src/autorecord
 */

import type { MemoryStore } from './store.ts'
import type { PublicMemoryRecord } from './domain.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildDetailDoc, summarizeByLength } from './summarize.ts'
import { inferRelations } from './relations.ts'

/** 每层独立开关；默认全开。 */
export interface AutoRecordOptions {
  /** 写入短期记忆，默认 true。 */
  short?: boolean
  /**
   * 写入长期公共记忆（带去重与门槛）。**默认 false**：长期库只收用户稳定信息与
   * 显式 remember 的项目记录，不做逐句倾倒。
   */
  long?: boolean
  /** 写入随身文档（原有行为），默认 true。 */
  portable?: boolean
  /** 长期写入的最小文本长度（字符），默认 20。 */
  longMinChars?: number
  /**
   * 摘要长度档位，默认 `long`。
   *
   * `long`（120–160 字）：摘要自己能看懂。
   * `short`（≤60 字）：只当索引，**上下文开销约省一半**，但可能丢后置细节。
   * 权衡数据见 README §4。
   */
  summaryLength?: 'long' | 'short'
  /**
   * Hook fired once for each newly written long-term memory (deduped writes do
   * not fire). Used to best-effort index the new memory into the semantic
   * vector store. Must never throw back into the recorder.
   */
  onLongRecord?: (entry: PublicMemoryRecord) => void
}

const TITLE_MAX_CHARS = 40

/** 归一化标题：去空白/标点/全半角统一，用于去重比较。 */
function normalizeTitle(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000，。！？、；：""''（）【】《》.,!?;:()[\]{}'"<>-]+/g, '')
}

/** 提取标题：取首句（句号/换行前），≤40 字；空则退回前 40 字。 */
function extractTitle(text: string): string {
  const firstSentence = text.split(/[。！？\n]/)[0] ?? ''
  const t = firstSentence.trim().slice(0, TITLE_MAX_CHARS)
  return t !== '' ? t : text.slice(0, TITLE_MAX_CHARS)
}

/**
 * 把一次用户消息落入全部记忆层。
 * @param store - 打开的 memory store。
 * @param sessionId - 所属会话。
 * @param text - 用户消息文本（已去掉空白的原文）。
 * @param options - 分层开关与门槛。
 */
export async function autoRecordExchange(
  store: MemoryStore,
  sessionId: SessionId,
  text: string,
  options: AutoRecordOptions = {},
): Promise<{ short: boolean; long: boolean; portable: boolean }> {
  const short = options.short ?? true
  // v3：默认**不再**把每条用户消息灌进长期库。
  // 长期记忆只收用户本人稳定信息（画像，走 profile）与显式 remember 的项目记录，
  // 项目/问题/结果由模型在收尾时用 remember 带标题写入，而不是逐句倾倒。
  const long = options.long ?? false
  const portable = options.portable ?? true
  const longMinChars = options.longMinChars ?? 20

  const trimmed = text.trim()

  if (short && trimmed !== '') {
    // 短期：**存全文**（content），另配一份确定性摘要（summary）。
    //
    // 改前是 `trimmed.slice(0, 200)` —— 直接砍掉后半段，后半段的信息永久丢失。
    // 改后：正文完整保留，摘要只用于**投影展示**（每步注入时只看摘要），
    // 需要细节时从 content 读。这才符合"存储不该丢信息、展示才要压缩"。
    await store.writeShortTerm('daily', trimmed, ['auto-record'], 1, 'fact', {
      by: 'user',
      sessionId: String(sessionId),
      title: extractTitle(trimmed),
      summary: summarizeByLength(trimmed, options.summaryLength ?? 'long'),
    })
  }

  if (portable && trimmed !== '') {
    await store.recordExchange(sessionId, trimmed)
  }

  let longWritten = false
  if (long && trimmed.length >= longMinChars) {
    const title = extractTitle(trimmed)
    const norm = normalizeTitle(title)
    const recent = store.listPublicMemories('daily')
    // 去重：归一化标题相同，且内容长度高度接近（<20% 差）才算同一内容重复。
    // 同前缀不同内容（标题相同但摘要差异大）不再被吞。
    const dup = recent.some((m) => {
      if (normalizeTitle(m.title) !== norm) return false
      const len = Math.max(1, m.summary.length, trimmed.length)
      return Math.abs(m.summary.length - trimmed.length) / len < 0.2
    })
    if (!dup) {
      // 关系边：从正文里半自动抽（「与 X 相恋」「A 是 B 之兄」）。
      // 抽不到就不写 —— 可选字段，标了能救跨实体推理，不标退回当前水平。
      const relations = inferRelations(title, trimmed)
      const entry = await store.recordPublicMemory({
        mode: 'daily',
        title,
        // 摘要 = 索引（判断"要不要翻"），短而便宜。
        summary: summarizeByLength(trimmed, options.summaryLength ?? 'long'),
        // 详情 = 正文（真正回忆时的依据），按时间线条目排列，保留原文。
        detail: buildDetailDoc(trimmed, {
          title,
          when: new Date().toISOString(),
          source: 'auto-record',
        }),
        ...(relations.length > 0 ? { relatedTo: relations } : {}),
        tags: ['auto-record'],
        source: 'auto-record',
      })
      longWritten = true
      if (options.onLongRecord !== undefined) {
        try {
          options.onLongRecord(entry)
        } catch {
          // Additive indexing must never break the recorded exchange.
        }
      }
    }
  }

  return { short, long: longWritten, portable }
}

/**
 * 把一次**上下文压缩**产生的摘要归档进长期记忆。
 *
 * 为什么要做：宿主的 compaction 在上下文用到约 80% 时把旧历史压成摘要，
 * 但那份摘要**只留在会话日志里**——压缩掉的内容等于从模型视野里消失，
 * 且不会进长期库。于是"压缩"实际是"扔掉"，而不是"卸载到仓库"。
 *
 * 这个钩子把摘要写进长期公共记忆（`source: 'compaction'`），压缩掉的历史
 * 之后仍能被 `search` 检索回来。
 *
 * @param store - 打开的 memory store。
 * @param sessionId - 所属会话。
 * @param summary - 摘要正文（已从 ContentBlock[] 提纯为文本）。
 * @param meta - 被压掉的 token 数等元信息，用于标记与诊断。
 * @returns 是否真的写入（空摘要不写）。
 */
export async function archiveCompactionSummary(
  store: MemoryStore,
  sessionId: SessionId,
  summary: string,
  meta: {
    shadowedTokenCount?: number
    provider?: string
    model?: string
    /** 摘要长度档位，默认 long。 */
    summaryLength?: 'long' | 'short'
  } = {},
): Promise<boolean> {
  const trimmed = String(summary ?? '').trim()
  if (trimmed === '') return false

  const size = meta.shadowedTokenCount !== undefined
    ? `（压缩 ${meta.shadowedTokenCount} tokens）`
    : ''

  await store.recordPublicMemory({
    mode: 'daily',
    title: extractTitle(trimmed),
    // 摘要：索引用（这条压缩记录讲的是什么，值不值得翻）。
    summary: summarizeByLength(trimmed, meta.summaryLength ?? 'long'),
    // 详情：压缩掉的原始摘要全文，按条目排列——真正回忆时的依据。
    detail: buildDetailDoc(trimmed, {
      title: extractTitle(trimmed),
      when: new Date().toISOString(),
      source: 'compaction',
    }),
    tags: ['compaction-archive', 'session-archive'],
    source: 'compaction',
    ...(size === '' ? {} : { goal: `上下文压缩归档${size}，会话 ${String(sessionId)}` }),
  })
  return true
}

/**
 * 把一次**助手回答**落入短期记忆。
 *
 * 与用户消息分开的原因：用户的话是"需求/事实"，助手的话是"结论/产出"，
 * 两者在检索时的用途不同，所以用 `by: 'agent'` 区分来源。
 *
 * 截断比用户消息更短（默认 240 字）：回答通常更长，整段塞进短期库会迅速
 * 把它填满，而短期库是要在每步注入里被投影的。
 *
 * @param store - 打开的 memory store。
 * @param sessionId - 所属会话。
 * @param text - 助手回答的纯文本（已去空白）。
 * @param enabled - 开关（来自 autoRecordAnswer 配置）。
 */
export async function autoRecordAnswer(
  store: MemoryStore,
  sessionId: SessionId,
  text: string,
  enabled = true,
): Promise<boolean> {
  if (!enabled) return false
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return false
  // 与用户消息同策：**正文完整存**，摘要单独存一份供投影。
  // （改前是 slice(0, 240)，会把长回答的后半段永久丢掉。）
  await store.writeShortTerm('daily', trimmed, ['auto-record', 'answer'], 1, 'fact', {
    by: 'agent',
    sessionId: String(sessionId),
    title: extractTitle(trimmed),
    summary: summarizeByLength(trimmed, options.summaryLength ?? 'long'),
  })
  return true
}
