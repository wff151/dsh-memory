# 向量语义检索 · 实测报告

> 测的是**这个功能在本机能不能用、用了有没有收益**。
> 时间：2026-10-25 · 环境：llama.cpp + nomic-embed-text-v1.5 Q4_K_M

---

## 一、结论先行

| 问题 | 答案 |
|---|---|
| 链路能通吗？ | **能**。HTTP 200，nomic 768 维，qwen2-0.5b 896 维 |
| 服务怎么起？ | `start_embed-qwen05b.bat` 或手工起 llama-server（见 §2） |
| 配置怎么改？ | `embeddingEnabled: true` + baseURL 改成 `8081` + 加任务前缀 |
| **分辨率够吗？** | **不够**。正确文档只在 2/6 个用例里胜过全部干扰 |
| 有收益吗？ | **有，但很小**。加前缀后分差 0.0070 → 0.0168（2.4 倍），仍不足以稳定排序 |

**一句话：链路可用，模型不够强。**

---

## 二、怎么起服务（可复现）

```powershell
$exe = '~\AppData\Local\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\llama-server.exe'
$m   = '~\.lmstudio\.internal\bundled-models\nomic-ai\nomic-embed-text-v1.5-GGUF\nomic-embed-text-v1.5.Q4_K_M.gguf'
Start-Process -FilePath $exe -ArgumentList @(
  '-m',$m,'--host','127.0.0.1','--port','8081',
  '-c','8192','-ngl','999','-t','8','-fa','1',
  '--embedding','--pooling','mean','--alias','nomic-embed'
) -WindowStyle Hidden
```

**踩过的坑**：
- 不能用 `| Select-Object -First 30` 接管输出 —— 读满就关管道，**进程会被杀死**。
  用 `Start-Process -RedirectStandardError <log>` 分离输出。
- 并发请求会把小服务打崩（ECONNRESET）。**串行发，间隔 70–120ms。**
- `llama-server.exe` 只有 9216 B 是转发器，真现在 `llama-server-impl.dll`，别以为下错了。

### 配置（profile 层 patch）

```yaml
embeddingEnabled: true
embeddingBaseURL: http://127.0.0.1:8081/v1
embeddingModel: nomic-embed
embeddingTimeoutMs: 8000
embeddingMinScore: 0.62          # nomic 实测：相关中位 0.666 / 无关中位 0.616
embeddingQueryPrefix: "search_query: "
embeddingDocumentPrefix: "search_document: "
```

---

## 三、两个模型的对比

| | qwen2-0.5b-instruct | nomic-embed-text-v1.5 |
|---|---|---|
| 维度 | 896 | 768 |
| 大小 | 379 MB | 84 MB |
| 定位（注释原文） | "链路验证/轻量占位模型" | "追求语义质量请用这个" |
| **相关 vs 无关能否分开** | **完全重叠** | **部分重叠** |

### qwen2-0.5b 的实测（不可用）

```
相关   min 0.8420  中位 0.9078  max 0.9627
无关   min 0.7812  中位 0.8967  max 0.9488
相关里低于「无关最高分」的条数: 5/6
```

**相关的最低分比无关的最高分还低 → 无法用任何阈值分开。**

### nomic 的实测（部分可用）

查询↔文档配对：

```
相关   0.6752 / 0.5715 / 0.7497     平均 0.6655
无关   0.5880 / 0.6545 / 0.6065     平均 0.6163
```

有分离，但只有 3 条相关里 1 条低于无关最高分。**能分，但不稳。**

---

## 四、发现并修掉的三个问题

### 4.1 任务前缀缺失（真 bug）

记忆系统调 embedding **不加任何前缀**。而 nomic 明确要求
`search_query:` / `search_document:` 区分查询与文档。

**实测影响**：

| | 正确文档胜出 | 平均分差 |
|---|---|---|
| 不加前缀 | 2/6 | **0.0070** |
| 加前缀 | 2/6 | **0.0168** |

分差提升 **2.4 倍**。已改为可配置项（`embeddingQueryPrefix` / `embeddingDocumentPrefix`）。

### 4.2 默认 minScore 0.3 太低

nomic 实测分布：相关中位 0.666、无关中位 0.616。
`0.3` 会把大量无关条目放进结果。已改成 **0.62**。

### 4.3 端口与模型名对不上

默认配置写的是 `1234`（LM Studio 约定）+ `text-embedding-nomic-embed-text-v1.5`。
本机实际是 llama.cpp 的 `8081` + alias `nomic-embed`。已改。

---

## 五、为什么分辨率不够（诚实分析）

**不是代码问题，是任务难度 + 模型规格。**

1. **同质语料**：三个"无关"文档都出自同一本小说，都讲孙家的人物。
   语义上它们确实相近 —— 这不是模型错，是内容本身就近。
2. **0.5B 级别的模型**：nomic-embed-text-v1.5 是 137M 参数级别。
   它在**跨主题**（小说 vs 代码 vs 烹饪）上能分开，但在**同主题细粒度**上吃力。
3. **中文**：nomic 主要针对英文训练，中文语义空间没那么多训练信号。

**实测佐证**：跨主题（小说/技术/烹饪）时，同主题配对的分离度明显好于同书内配对。

---

## 六、建议

| 场景 | 建议 |
|---|---|
| 想稳定提升排序 | **优先做称谓消解**（消灭 27% 的「他/嫂子/哥哥」失败），比换 embedding 模型收益大 |
| 真想用向量 | 换更强的 embedding 模型（bge-m3、gte-large-zh 等中文/多语模型） |
| 保持现状 | 让向量只作为**补充信号**（`vectorFusedScore` 已经这么做：余弦为主但标签/时间仍参与），关键词打底 |

**当前配置已经打开向量检索，且服务在线。** 效果是"锦上添花"，不是"雪中送炭"。

---

## 七、代码改动清单

| 文件 | 改动 |
|---|---|
| `embedding.ts` | 加 `queryPrefix` / `documentPrefix` 配置 + `EmbedPurpose` 参数 |
| `semantic.ts` | `embed()` 接受 purpose；`scoreQuery` 走 query，`syncIndex` 走 document |
| `index.ts` | 新增 `embeddingQueryPrefix` / `embeddingDocumentPrefix` 两个配置项并透传 |
| `retrieval.ts` | （另一件事）分数加连续项 + 过滤跨词垃圾片 |
