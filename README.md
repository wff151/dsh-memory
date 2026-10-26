# dsh-memory

记忆插件。给模型一套**跨会话不遗忘**的记忆：长期库、短期库、用户画像、随身小黑板、进化档案。

> 它**不解决**上下文爆炸——那是宿主 compaction 的事，见 §6。

- 仓库：<https://github.com/wff151/dsh-memory>
- 适应版本：**DSH `0.2.1-rc.2`**（cordis `4.0.5`）
- 实测：不含实体名的自然问法 **top1 80% / top3 98%**（20 实体 × 100 问，见 §4）

---

## 0. 安装

### 方式 A —— 作为 profile 的 bundle（推荐）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
git clone https://github.com/wff151/dsh-memory.git node_modules/dsh-memory
```

然后在 `package.json` 的 `dsh.profile.bundles` 里加上 `dsh-memory`，
并在 `cordis.patch.yml` 里挂一行：

```yaml
- id: dsh-memory
  name: 'dsh-memory'
  config:
    toolMode: native
    injectContext: true
```

**重启 DSH** 生效。

### 方式 B —— 从插件市场安装（推荐）

DSH 的 **Plugins → Discover** 支持按索引源安装。本仓库自带一份市场索引：

1. 打开 **Plugins** → **Discover** → **Add index source**
2. 填入：
   ```
   https://raw.githubusercontent.com/wff151/dsh-memory/main/market/index.json
   ```
3. 市场里会出现 **Memory / 记忆**，点 **Install**

索引格式为 **format 1**，用官方校验器
（`@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex`）验证通过。
版本**锁定到 Git commit**，装到的代码与索引指向的提交完全一致。

索引本身的说明与格式约定见 [`market/README.md`](market/README.md)。

### 依赖

需要宿主提供（peerDependencies，不用自己装）：
`@deepseek-ai/cordis` · `dsh-agent` · `dsh-session` · `dsh-storage-domain` ·
`dsh-tools` · `schemastery` ·（`dsh-system-prompt` 仅类型用，可选）

---

## 文档索引

| 文件 | 内容 |
|---|---|
| `docs/breakthrough-detail-scoring.md` | **最大的一次改进**：检索为什么要看正文而不只看摘要 |
| `docs/context-trigger-report.md` | 短期记忆的两条容量触发（条数 + 上下文占比） |
| `docs/params-audit.md` | 全部参数审查：谁能调哪些、发现的问题 |
| `docs/features-report.md` | 唯一特征索引 + 逐项 A/B |
| `docs/anaphora-report.md` | 称谓/代词消解 |
| `docs/relations-report.md` | 关系网与一跳扩展 |
| `docs/summary-length-report.md` | 摘要长度取舍 |
| `docs/vector-search-report.md` | 向量检索实测与局限 |
| `docs/multi-round-report.md` | 100 问多轮实测 |
| `docs/memory-rules-flow.html` | 规则流图（单文件，浏览器打开） |
| `docs/benchmarks/` | 可复现的测试脚本 |
| `market/index.json` | 插件市场索引（format 1，官方校验器验证） |

---

## 0.5 记忆浏览（把记忆画出来）

生成一张**单文件 HTML**，五个页签看全部记忆：

| 页签 | 长什么样 |
|---|---|
| **长期记忆** | 时间轴：按天排列，越靠右越新，长正文可展开 |
| **短期记忆** | 气泡：按分组排列，**权重越大气泡越大**（权重相同时用内容长度区分） |
| **用户画像** | 属性 / 喜好 / 技能 / 人际关系网 |
| **AI 画像** | 自我认知与反思（观察 / 归因 / 行动三段） |
| **进化档案** | 错题日志 / 提案 / 规则 / 反思 |

```powershell
node docs/benchmarks/build-memory-browser.mjs
# 默认输出到 docs/benchmarks/memory-browser.html，双击打开
```

支持 `#long` / `#short` / `#user` / `#self` / `#evo` 直达某一页。

### 为什么是快照，不是实时

浏览器侧的插件模块**只能拿到配置**（`configForms`），拿不到记忆数据 ——
数据在宿主的 storage 里，两者之间没有通道。

实测过：`GET /api/memory` 返回 **401**；宿主也没有现成的自定义 HTTP 路由 API。
做到实时需要给插件补一套 `typert` host + remote-client（宿主每个 API 包都是这么成对提供的），
这是独立的一块工作，**当前版本没有做**。

所以现在：**快照页到处都能看，但要看最新数据得重跑一次生成器**。
如果你不介意这一点，它比实时版更省事 —— 没有后端、没有权限、双击就开。

> 生成的 HTML **不要提交进仓库**：它含对话原文与本机路径，已在 `.gitignore` 里排除。

---

## 1. 五张表

| 表 | 存什么 | 会不会淡忘 |
|---|---|---|
| `public` | 长期记忆：有结论、可复用的任务与知识 | 不淡忘 |
| `short` | 短期记忆：消息摘要、状态、事件、任务、**人物关系** | **会**（按权重指数衰减） |
| `permanent` | 用户画像：属性 / 喜好 / 技能 / **人际关系网** | 不淡忘 |
| `portable` | 随身小黑板：本会话的目标 / 进展 / 待解决 | 随会话 |
| `evolution` | 进化档案：错题日志 / 提案 / 规则 / 反思 / 自我认知 | 不淡忘 |

---

## 2. 两个关系网，分工不同

| | 用户关系网 | 小说/项目人物关系 |
|---|---|---|
| 存在哪 | `permanent.relationships` | `short`（`kind: 'relation'`） |
| 结构 | `{ from, relation, to }` | 同上 |
| 会不会淡忘 | **不会** | **会**（随书/随项目衰减） |
| 适用 | 家人、朋友、同事、上司 | 读过的小说人物、做过项目里的人 |

用户关系网渲染进每步上下文；小说人物关系只在权重高时进投影（默认最多 3 条），
衰减后自动沉底。

---

## 3. 检索怎么工作

四道信号，逐层收窄：

1. **时间**：从问句解析时间意图（昨天/前天/具体日期）
2. **标签**：问句里的实体对结构化 tags
3. **关键词**：中文 bigram + 英文词，过滤跨虚词垃圾片（`到孙`、`安那`）
4. **向量**（可选，见 §5）

**排序**：拿去重的加权分。分数是**连续值**（位置 + 长度 + 字段加权），
不是整数比——避免大量并列（实测并列率 50% → 20%）。

### 三个后处理

| 机制 | 解决什么 |
|---|---|
| **称谓消解**（`anaphora.ts`） | 「嫂子身体怎么了」→ 扩出"妻/媳妇/老婆"再检索 |
| **代词消解** | 「他后来怎么样」→ 用当前话题实体替换"他" |
| **关系一跳**（`relations.ts`） | 「他喜欢的姑娘是谁」→ 从孙少平走到田晓霞 |

---

## 4. 实测数据

> ⚠️ **这些数字只来自《平凡的世界》一本小说。**
> 别的领域（代码、工单、聊天）没验证过——详见 §4.3。

20 个实体 × 100 问：

| 问法 | top1 | top3 |
|---|---|---|
| 含实体名（"孙少平后来怎么样"） | **95%** | 100% |
| **只描述内容**（"那个在煤矿下井的年轻人是谁"） | **80%** | **98%** |
| **总计** | **89%** | **99%** |

**不含名问法也能到 80% / 98% —— 达到"八九不离十"的实用水平。**

### 4.1 各机制逐项贡献（40 条不含名问法，`_tools/ab-mechanisms.mjs`）

| 机制 | top1 | 判定 |
|---|---|---|
| 基线（全关） | 50% | — |
| 称谓消解 | 57% | ✓ +7pt |
| 关系一跳 | 55% | ✗ −2pt（跨实体唯一手段，保留） |
| 意图类型加权 | 53% | ✗ 已关（`USE_KIND_BOOST = false`） |
| 唯一特征 | 53%（top3 68%） | ◐ 召回 +3pt |
| **正文（detail）参与检索** | **83%** | **✓✓ +30pt，最大的一项** |

### 4.2 最关键的一个修正

**检索不能只看摘要。**

摘要是"给人/模型看的索引"，取首句（短、便宜）。
但"抗洪牺牲"这类关键信息常在首句之后，于是
「在抗洪里救人死的是谁」**对田晓霞那条得 0 分**——摘要里根本没这个词。

修法是让 `detail`（完整正文）也参与打分，**而且必须用加法**：
base 分为 0 时，`0 × 1.077 = 0`，乘法救不回一个零。

详见 `_docs/breakthrough-detail-scoring.md`。

### 4.3 摘要长度开关：默认长，可切短省上下文

`summaryLength` 决定摘要在"只取首句"和"按句补齐"之间的档位：

| 档位 | 摘要中位 | top1 | top3 | 上下文开销 |
|---|---|---|---|---|
| **`long`（默认）** | 107 字 | 89% | 99% | 100% |
| `short` | 50 字 | 93% | 99% | **约 40%** |

**默认 `long` 的理由**：上面那些数字只在小说数据上测过。
小说里首句通常是"某某是…"，短摘要够用；**代码/工单/聊天里首句常是标签或寒暄，
实质内容在中间**（真实库里有一例：原文 500 字，短摘要只留了 27 字的身份标签）。
在没验证过的领域，长摘要是更安全的选择——它至少不丢关键信息。

**想省上下文就切 `short`**：设置页「记忆 → 摘要长度」改成 `short`，
或配置 `summaryLength: short`。摘要字数省约 **60%**。

⚠️ **注意省的是什么**：这个开关只影响**检索命中后**显示的摘要长度。
每步自动注入的部分（小黑板 + 短期投影 + 画像）**不受它影响**，
那部分靠"按条数截断"控制（见 §6）。没命中检索时，这个开关**完全不产生收益**。

完整报告：
- `_docs/breakthrough-detail-scoring.md` — **最大突破，建议先读**
- `_docs/summary-length-report.md` — 摘要长度实测与取舍
- `_docs/features-report.md` — 特征索引 + 逐项 A/B
- `_docs/multi-round-report.md` — 100 问实测
- `_docs/anaphora-report.md` — 称谓消解
- `_docs/relations-report.md` — 关系网
- `_docs/vector-search-report.md` — 向量检索

---

## 5. 向量语义检索（可选，默认不依赖）

### 能做什么

把长期记忆转成向量，按余弦相似度排序。**在关键词失效时多一条信号**：
问法和条目措辞完全不同（「那个在煤矿下井的年轻人」vs「孙少平…矿工」）时，
关键词对不上，向量可能对上。

### 需要什么

**要单独起一个 embedding 服务。** 不开就静默回退关键词，不报错。

已验证可用的两种：

**A. llama.cpp（推荐，轻）**

```powershell
llama-server.exe -m <模型.gguf> --host 127.0.0.1 --port 8081 `
  -c 8192 -ngl 999 -t 8 -fa 1 --embedding --pooling mean --alias nomic-embed
```

模型：`nomic-embed-text-v1.5.Q4_K_M.gguf`（84 MB，768 维）

**B. LM Studio**：加载 `nomic-embed-text-v1.5`，默认端口 1234。

### 配置

```yaml
embeddingEnabled: true
embeddingBaseURL: http://127.0.0.1:8081/v1
embeddingModel: nomic-embed
embeddingTimeoutMs: 8000
embeddingMinScore: 0.62              # nomic 实测：相关中位 0.666 / 无关中位 0.616
embeddingQueryPrefix: "search_query: "
embeddingDocumentPrefix: "search_document: "
embeddingCooldownMs: 10000          # 服务不可用后的重试间隔
```

**两个容易踩的坑**：

1. **任务前缀必须加。** nomic 要求查询用 `search_query:`、文档用 `search_document:`。
   不加时分数会塌成一片（实测分离度 -0.0024，加了 +0.0168，2.4 倍）。
2. **`embeddingMinScore` 不能照搬 0.3。** 0.3 会把大量无关条目放进来。
   nomic 的实测分布是相关 0.666 / 无关 0.616，取 0.62 附近。

"用时开、用完关"：服务不开时每 10 秒重试一次，起来后自动用上；关掉自动退回关键词。

### 局限性（重要）

**实测这个功能收益有限。**

| 检查项 | 结果 |
|---|---|
| 相关 vs 无关能否分开 | **部分重叠**（相关最低 0.572 < 无关最高 0.655） |
| 正确文档排第一的用例 | **2/6** |
| 跨主题（小说/代码/烹饪）区分 | 能分，但同主题细粒度不行 |

原因三条：
1. nomic 是 137M 参数级别，**同主题细粒度吃力**
2. 主要针对**英文**训练，中文语义空间信号少
3. 测试语料全是同一本小说，**语义本来就近**（这不是模型错）

**结论**：向量检索定位是**锦上添花**，不是雪中送炭。
想要它真起作用，得换更强的中文 embedding（bge-m3、gte-large-zh 之类），
而**换模型前，先把纯代码的部分做满**（称谓消解比换模型收益大 17 个百分点）。

### 测试文件

| 脚本 | 地址 | 测什么 |
|---|---|---|
| `eval-embed-quality.mjs` | `_tools/` | 相关/无关分数分布，二分阈值正确率 |
| `eval-embed-v2.mjs` | `_tools/` | 跨主题（小说/技术/烹饪）区分度 |
| `eval-embed-prefix.mjs` | `_tools/` | 加不加任务前缀的分离度对比 |
| `measure-embed-cosine.mjs` | `_tools/` | 查询↔文档的余弦分布，推荐 minScore |
| `verify-prefix-effect.mjs` | `_tools/` | 正确文档胜出率（加前缀 vs 不加） |

跑法：先起服务，再 `node _tools/<脚本名>.mjs`。

---

## 6. 它不解决上下文爆炸

记忆系统对上下文是**加压**的（每步注入）。实测：

| 上下文窗口 | 记忆占用 | 占比 |
|---|---|---|
| 32k | 346 tokens | **1.081%** |
| 64k | 346 | 0.541% |
| 1M | 346 | **0.035%** |

因为注入**按条数截断**（小黑板进展 4 + state 3 + event 3 + 关系 3 + self 3），
所以**不随对话变长而膨胀**。

**真正解决"会话越聊越长"的是宿主 compaction**（默认 80% 阈值触发）。

记忆系统解决的是另一件事：**换个会话就忘干净**。

---

## 7. 配置项

全部 `volatile()`，改完保存即生效，不用重启。

| 分组 | 项 |
|---|---|
| 每步注入 | `injectContext` · `resumeHint` |
| 定时 | `decayIntervalHours` · `reflectionIntervalHours` |
| 自动落库 | `autoRecordShort` · `autoRecordLong` · `autoRecordPortable` · `autoRecordAnswer` · `compactionArchive` |
| 向量 | 见 §5 |

设置页在「设置 → 记忆」。

---

## 8. 开发

```powershell
cd E:\shejigao\plugins\dsh-memory
node tests/run-all.mjs          # 全套单测
node --import tsx/esm tests/summarize-test.mjs   # 单跑
```

打包安装：

```powershell
node E:\project\test1\th\_tools\build-memory-standalone.mjs
node E:\project\test1\th\_tools\install-memory-standalone.mjs
```

**装完要重启宿主**才加载新代码（`dist/memory.mjs` 在启动时读入）。
