# 插件市场索引

本目录是一份 **DSH 插件市场索引（format 1）**，让本插件能被
**Plugins → Discover** 列出并安装。

## 怎么用（用户侧）

1. 打开 DSH 的 **Plugins** 页面 → **Discover** 标签
2. 点 **Add index source**（添加索引源）
3. 填入本索引的原始地址：

```
https://raw.githubusercontent.com/wff151/dsh-memory/main/market/index.json
```

4. 市场里就会出现 **Memory / 记忆**，点 **Install** 即可

索引里的版本**锁定到一个 Git commit**，所以装到的内容和这个索引指向的代码完全一致。

## 格式约定（改这份文件时要注意）

格式由 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 校验。
几个容易踩的点（都是**官方校验器**拒绝过的）：

| 规则 | 说明 |
|---|---|
| `format` 必须是 `1` | 数字，不是字符串 |
| **语言 id 必须小写** | `zh-cn` ✅ / `zh-CN` ❌（正则 `^[a-z]{2,8}(-[a-z0-9]{1,8})*$`） |
| 每种多语言文案必须有 `en` | 缺 `en` 直接报错 |
| `publishTimestamp` | Unix **秒**，整数，`[0, 10^11)` |
| `version` | 严格 SemVer，`0.2.0` ✅ / `v0.2.0` ❌ |
| Git 源必须给 `commit` | **40 位小写 hex**，不能用分支名或 tag |
| `engines.dsh` | 必须是 SemVer **范围**，不能是 `workspace:` |
| `category` / `labels` / `sortKeys` 的 id | 必须先在上面 `metadata` 里声明过 |
| 图标 | 相对路径会按索引 URL 解析；`http:` 图标只在索引本身是 `http:` 时可用 |

## 改了插件代码之后

索引里的 `source.commit` 是**写死的**。发了新代码之后必须：

```powershell
node E:\project\test1\th\_tools\build-market-index.mjs   # 重新生成（读当前 HEAD）
git add market/index.json
git commit -m "chore: 索引指向新版本"
git push
```

否则市场装到的还是旧 commit 的代码。

## 设计选择：Git 源而不是 npm 包

| | Git 源（当前） | npm 包 |
|---|---|---|
| 能否锁定代码 | ✅ commit SHA | ✅ 版本号 |
| 需要发布到 npm | ❌ 不需要 | ✅ 需要 |
| 装的是源码还是产物 | 源码（宿主打包） | 通常也是源码 |
| 索引体积 | 小 | 小 |

选 Git 是因为**不需要往公共 npm 发东西**，用户的 pnpm 直接从 GitHub 拉。
代价是每个版本要在索引里加一条 `versions` 记录（commit 各不相同）。
