# PR Reviewer Agent — 深度技术 Q&A

> 基于项目源码 (`src/`、`action.yml`、`.github/workflows/`) 的真实实现逐条作答。

---

## 1. TypeScript 类型系统与运行时安全

### Q: 如何定义 Type/Interface？有没有使用泛型？

**有明确定义的 Interface，没有使用泛型。**

核心类型定义在 `src/agent/reviewer.ts:31-50`：

```typescript
export interface ReviewComment {
  file: string;      // 文件路径
  line: string;      // 纯数字字符串，如 "42"
  comment: string;   // 审查意见
}

export interface AnalysisResult {
  comments: ReviewComment[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

另外 `src/tools/logger.ts:17-30` 定义了 `TokenUsageEntry`，`src/tools/github.ts:24` 通过 `InstanceType<typeof GitHub>` 推导 Octokit 类型。整个项目没有自定义泛型。

### Q: 如果 DeepSeek 返回的 JSON 少了一个字段，TS 运行时会报错吗？

**TypeScript 不会在运行时保护你。** TS 的类型在编译后完全擦除，`interface` 不会生成任何运行时代码。

但本项目通过 **第三层防线（字段级校验）** 来兜底。在 `src/agent/reviewer.ts:402-423`，`parseAndValidateResponse()` 对每一项逐字段检查类型：

```typescript
const fileValid   = typeof file === 'string' && file.trim().length > 0;
const lineValid   = typeof line === 'string' && /^\d+$/.test(line);
const commentValid = typeof comment === 'string' && comment.trim().length > 0;

if (fileValid && lineValid && commentValid) {
  validComments.push({ file: file.trim(), line, comment: comment.trim() });
} else {
  // 记录失败原因，丢弃该条目
}
```

所以少字段不会导致崩溃，而是该条目被丢弃 + 打印 warn 日志。

---

## 2. @vercel/ncc 打包机制

### Q: ncc 是怎么把 node_modules 压成单文件的？

`@vercel/ncc` 的工作流程：

1. **入口分析**：从 `src/index.ts` 开始，构建完整的 `import`/`require` 依赖图。
2. **静态追踪**：使用 Webpack 风格的模块解析器，跟踪每个被引用的模块，只包含实际被 `import` 的代码路径（tree-shaking）。
3. **内联打包**：将所有 JS/TS 模块的源码按正确的依赖顺序拼接进一个 IIFE（立即执行函数表达式）中，生成独立的 `dist/index.js`。
4. **去重**：`node_modules` 中的共享依赖只打包一次。
5. **polyfill 注入**：为 Node.js built-in 模块（如 `fs`、`path`）生成运行时的 `require` 桥接，而非内联 Node.js 核心库。

最终产物 `dist/index.js` 是一个自包含的 JS 文件，无需 `node_modules` 即可直接在 Node.js 20 上运行。

### Q: 如果有原生 C++ Addon（如某些加解密库），ncc 还能正常工作吗？

**不能。** ncc 只能打包纯 JavaScript/TypeScript 代码。原生 `.node` 文件（C++ Addon）是编译后的二进制，ncc 无法内联它们。

如果项目依赖了原生模块，需要采用以下策略：
- 将 `.node` 文件复制到 `dist/` 目录，并在运行时通过 `require()` 加载。
- 或者将该依赖标记为 `externals`（不打包），并在 GitHub Action 的 runner 上执行 `npm install`。
- 或者选择纯 JS 替代方案（如将 `bcrypt` 换成 `bcryptjs`）。

本项目的三个运行时依赖（`@actions/core`、`@actions/github`、`openai`）都是纯 JS 包，不存在此问题。

---

## 3. GitHub Actions 事件机制

### Q: `synchronize` 事件具体是指什么？

定义在 `.github/workflows/test-agent.yml:4`：

```yaml
on:
  pull_request:
    types: [opened, synchronize]
```

- **`opened`**：PR 被创建时触发。
- **`synchronize`**：当 PR 的源分支有新的 commit 被 push（包括 force-push）、或 PR 的目标分支有更新时触发。简单说就是 **"PR 的内容发生了变更"**。

### Q: 开发者又 push 了代码，旧 Action 进程会被自动取消吗？

**默认行为：会。** GitHub Actions 对同一 PR 的同一 workflow 有默认的并发策略（concurrency group 为 `github.workflow` + `github.ref`），同一 PR 上的旧 job 会被自动取消。

但本项目的工作流没有显式配置 `concurrency`，因此完全依赖 GitHub 的默认策略。更健壮的做法是显式声明：

```yaml
concurrency:
  group: pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

### Q: 如何避免重复评论？

当前代码对此没有处理。`createReviewComment`（`src/tools/github.ts:214-246`）无条件地追加一条新评论。如果同一 PR 被多次触发（如 push 了多次），就会产生多条评论。

可能的改进方案：
1. **在发新评论前，先查找并删除/隐藏 bot 之前的评论**（通过 `octokit.rest.issues.listComments` + `deleteComment`）。
2. **使用 Review Comment 而非 Issue Comment**（`octokit.rest.pulls.createReview`），因为 Review 的 event 可以是 `COMMENT`，且同一次 review 的评论可以批量提交。

---

## 4. CLAUDE.md 核心规则与纠偏机制

### Q: CLAUDE.md 里写了什么核心规则？

完整内容见项目根目录 `CLAUDE.md`。核心规则摘录：

```markdown
# 角色定位
你是一个严谨的高级 TypeScript 架构师和 DevOps 专家。
当前项目处于 Phase 3（流程编排与 GitHub Action 封装阶段）。

# 架构与编码规范
1. 【编排入口】src/index.ts 作为程序绝对起点，流程：
   a. 从 GitHub Actions 环境变量获取输入参数
   b. 调用 github.ts 获取 PR diff 和 RAG 规范
   c. 将 diff 和规范传入 reviewer.ts 获取分析结果 (JSON)
   d. 在 github.ts 中新增 createReviewComment 方法，将 JSON 转成评论

2. 【Action 描述文件】根目录生成 action.yml

3. 【构建脚本】使用 ncc build src/index.ts -o dist --source-map 打包
```

### Q: 如果 AI 强行偏离了规则（比如偷偷用了 any 类型），怎么纠正？

纠偏依赖多层机制：

1. **编译时检查**——`tsconfig.json` 启用了 `"strict": true`、`"noUnusedLocals": true`、`"noUnusedParameters": true`。如果 AI 写了 `any` 且 `strict` 不能直接捕获显式 `any`，但通过 ESLint 规则（如配置 `@typescript-eslint/no-explicit-any`）可拦截。

2. **代码审查闭环**——本项目本质上就是一个 "用 AI 审查代码" 的工具。如果 AI 在生成这个工具时写了 `any`，你可以在 PR 中看到它自己的审查报告。这是一种 **自噬性测试（dogfooding）**：Agent 能审查出自己的类型问题。

3. **人工 Code Review**——CLAUDE.md 只能约束 AI 的行为方向，最终的安全网仍然是开发者在 PR 合并前的 code review。CLAUDE.md 不是编译器，它是一份 "给 AI 的语境说明书"。

4. **逐步调试**——如果 AI 偏离了，最有效的方式是在 CLAUDE.md 中追加明确的反例和约束，或在对话中直接指出（"不要用 any，用 unknown + type guard"），AI 会在后续代码中遵守。

---

## 5. Diff 解析与超大文件处理

### Q: 如何精准提取出只被修改过的行？

**当前代码并没有做 diff 解析。** 在 `src/tools/github.ts:56-62`，`fetchPRDiff` 直接获取整个 raw unified diff 文本：

```typescript
const response = await octokit.rest.pulls.get({
  owner, repo, pull_number: prNumber,
  mediaType: { format: 'diff' },
});
const diff = response.data as unknown as string;
```

获取的是完整 raw diff（含上下文行），然后**原封不动地传给 LLM**。系统依赖 LLM 自身的语言理解能力，从 diff 格式中识别哪些行是新增/修改的（以 `+` 开头），哪些是上下文行。

### Q: 如果开发者改了一个 5000 行的 JSON 配置文件，会传给大模型吗？

**会。** 但有两道防线：

1. **截断保护** — `src/agent/reviewer.ts:63` 定义 `MAX_DIFF_LENGTH = 50_000` 字符，`buildUserPrompt`（第 270-291 行）对超长 diff 做硬截断：

```typescript
const diffContent = truncated
  ? diff.slice(0, MAX_DIFF_LENGTH) + '\n\n[... diff 已被截断，请优先审查前半部分 ...]'
  : diff;
```

2. **Token 预估日志** — 每次调用前会打印预估 Token 消耗（第 532-544 行），方便事后排查。

所以 5000 行 JSON 如果总字符数在 50000 以内会全部传入；超出则只传前 50000 字符。**没有按文件粒度拆分或跳过特定文件的逻辑。**

---

## 6. 行号 → Diff Position 映射

### Q: 如何把大模型输出的物理行号映射回 GitHub API 需要的 diff position？

**当前代码没有做这个映射。** 原因在于使用的是 **Issue Comment API** 而非 **Pull Request Review API**。

在 `src/tools/github.ts:228-233`：

```typescript
await octokit.rest.issues.createComment({
  owner, repo,
  issue_number: prNumber,
  body,
});
```

这创建的是 PR Conversation 标签页下的**通用评论**（类似在 PR 下打字），不绑定到具体代码行。大模型输出的 `line` 字段仅用于在 Markdown 评论正文中展示（如 `` `file.ts` — 第 45 行 ``），不传给任何需要 position 参数的 API。

如果需要真正的 **inline review comment**（带行级标注），需要改用 `octokit.rest.pulls.createReview`，并传入 `comments` 数组，其中每条需要：
- `path`：文件路径
- `position`：diff 中的相对行号（从 diff 头部算起，不是物理行号）

物理行号 → diff position 的映射需要解析 unified diff 格式。核心算法：
1. 解析 diff 的 hunk header（`@@ -oldStart,oldCount +newStart,newCount @@`）获取新增侧起始行号。
2. 遍历 hunk 内容，逐行计算 position（diff 中从 `@@` 起算的行偏移量）。
3. 建立 `物理行号 → position` 的映射表。
4. 用 LLM 返回的物理行号查表。

本项目选择 Issue Comment 而不是 Review Comment，是一个简化的工程决策——牺牲了行级标注能力，换取了实现的简洁性。

---

## 7. Zero-DB RAG 降级策略

### Q: 如果 `.github/REVIEW_RULES.md` 存在但权限不足，是抛异常还是降级？

**降级（返回 null），不抛异常。**

实现在 `src/tools/github.ts:115-192`。关键逻辑：

```typescript
try {
  const response = await octokit.rest.repos.getContent({ owner, repo, path: rulesPath });
  // ... 正常解析 Base64 内容并返回
} catch (error: unknown) {
  // 明确区分 404 和其他错误
  if (error.status === 404) {
    return null;  // 文件不存在 → 正常降级
  }
  // 权限不足、网络错误等 → 同样返回 null，记录日志
  console.error(`获取团队规则时发生异常: ${message}`);
  console.error('RAG 加载失败，审查将继续使用纯通用规则执行');
  return null;
}
```

**用的是 try-catch，不是 `fs.existsSync`。** 这是因为读取远程仓库文件必须走 GitHub API，无本地文件系统可用。`fs.existsSync` 只能检查当前 runner 工作目录下的文件，无法检查目标 PR 所在仓库的内容。

任何非 404 的异常（包括 403 权限不足、401 认证失败、网络超时）都会：
1. 打印详细错误日志（供运维排查）。
2. 返回 `null`。
3. 审查继续以 "纯通用规则" 模式运行。

这个设计的哲学是：**审查功能本身不应因 RAG 失败而被阻断。**

---

## 8. 超长上下文与截断策略

### Q: 100 个文件的 PR 超过 Token 上限，是崩溃还是截断？

**截断，但不是智能分组。** 代码在 `src/agent/reviewer.ts:63` 和第 270-291 行：

- `MAX_DIFF_LENGTH = 50_000` 字符（约 ~20,000 Token，按 0.4 系数估算）。
- 超过后：**保留前 50000 字符，丢弃剩余全部内容**，并追加提示。
- 没有对文件进行分组、优先级排序或分批审查。

```typescript
const diffContent = truncated
  ? diff.slice(0, MAX_DIFF_LENGTH) + '\n\n[... diff 已被截断，请优先审查前半部分 ...]'
  : diff;
```

这是一个粗糙但务实的策略。更优的方案可以：
1. 按文件 diff 大小排序，优先审查核心逻辑文件。
2. 对文件分片，每批独立调用 LLM，最后合并结果。
3. 对纯配置/JSON/锁文件直接过滤，不占 Token 配额。
4. 使用 DeepSeek V4 的 128K context window，调大 `MAX_DIFF_LENGTH`。

实际上 DeepSeek V4 有 128K 的 context，50000 字符（~20K tokens）是一个保守的限制，还有很大余量。

---

## 9. JSON 正则提取机制（第二层防线）

### Q: 正则表达式具体是什么？能处理嵌套 JSON 中的 `]` 或 `}` 吗？

解析在 `src/agent/reviewer.ts:327-370`。两层正则：

**Step 1 — 剥离 Markdown 代码块**（第 333 行）：
```typescript
const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
```
- `[\s\S]*?` — 非贪婪匹配任意字符（包括换行），匹配到第一个 `` ``` `` 即停止。
- 如果 LLM 输出 `` ```json\n[{...}]\n``` ``，会正确提取中间的 `[{...}]`。

**Step 2 — 正则提取 JSON 数组**（第 354 行）：
```typescript
const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
```
- `[\s\S]*` — **贪婪匹配**，从第一个 `[` 匹配到最后一个 `]`。
- **存在的问题**：如果 LLM 输出了 `[{"a":1}] some garbage text [{"b":2}]`，贪婪模式会从第一个 `[` 匹配到最后一个 `]`，中间包含非法内容，导致 `JSON.parse` 失败。

**能处理嵌套吗？** 不能可靠处理。如果审查意见的 `comment` 字段中包含 `]` 或 `}`（例如建议的代码片段 `arr[0]`），正则可能提前截断或过度匹配。这是一种工程权衡：在 "极大概率 LLM 会输出干净 JSON 数组" 的前提下，用简单的正则做最后一搏。更稳健的方案是使用 JSON5 解析器或流式 JSON parser。

---

## 10. 幻觉校验：行号是否真实存在于 Diff

### Q: 如何校验 LLM 输出的行号确实存在于本次 PR 的 Diff 改动中？

**当前代码不校验行号的真实性。**

第三层防线（`src/agent/reviewer.ts:398-423`）只做**形式校验**：
- `file` 是非空字符串 ✅
- `line` 是纯数字（`/^\d+$/`）✅
- `comment` 是非空字符串 ✅

不检查的：
- `file` 是否真的出现在 diff 的 `---/+++` 行中 ❌
- `line` 是否真的在 diff 中被修改了（即该行在 hunk 中）❌
- `comment` 是否针对实际代码（而非泛泛而谈）❌

### Q: 如果 LLM 捏造了行号，是丢弃还是作为 General Comment？

**不丢弃——它会被正常发布为通用评论。** 因为当前使用的是 `issues.createComment`（通用评论），行号仅用于 Markdown 展示。即使行号是捏造的，评论也会照常发出。

如果未来升级到 `pulls.createReview`（inline comment），就需要严谨的行号验证了。可行的方案：
1. 解析 diff 获得所有被修改文件的真实路径集合。
2. 解析每个文件的 hunk 获得被修改行的行号范围。
3. 将 LLM 输出的 `file` 和 `line` 与真实数据进行交叉验证。
4. 不匹配的条目 → 降级为 General Comment（只提文件名，不绑定行号），或直接丢弃。

---

## 11. 模型选择：DeepSeek V4 vs GPT-4o vs Claude

### Q: 为什么选择 DeepSeek V4？

根据 README 和项目设计：

1. **成本**：DeepSeek V4 定价约为 GPT-4o 的 1/50。对于按 PR 频率自动触发的代码审查，Token 消耗是持续成本，选择性价比最高的模型是合理的。
2. **兼容性**：DeepSeek API 完全兼容 OpenAI SDK 格式，只需改 `baseURL` 即可无缝切换（`src/agent/reviewer.ts:547-550`）。
3. **能力**：DeepSeek V4 在代码理解和结构化输出方面表现不错，对于标准化的代码审查任务（寻找已知模式的安全/性能问题）足够胜任。

### Q: DeepSeek 和 Claude 在代码审查上的差异？

- **Claude**：在逻辑推理和深层代码语义理解方面更强，能发现微妙的竞态条件、异步时序问题。但测试成本较高。
- **DeepSeek**：在模式匹配和规则检查方面足够好，但可能在复杂跨文件逻辑分析上不如 Claude。适合做 "第一道过滤"——发现明显的安全问题和代码规范违规。

### Q: Base URL 设计是否考虑兼容 Ollama 本地小模型？

**是的。** `openai-base-url` 参数（`action.yml:12-15` + `src/index.ts:23`）设计为完全可配置：

```yaml
openai-base-url:
  description: 'Base URL for the OpenAI-compatible API endpoint'
  required: false
  default: 'https://api.deepseek.com'
```

只要服务端实现了 OpenAI 兼容的 `/v1/chat/completions` 端点，就可以接入。包括：
- Ollama（`http://localhost:11434/v1`）
- vLLM
- LocalAI
- 任何自部署的 OpenAI 兼容 proxy

但需要注意：本地小模型的代码审查能力可能明显不如 DeepSeek V4，且项目 Prompt 中带有强 JSON 格式约束，小模型遵守格式要求的能力参差不齐，可能触发更多的第二层/第三层防线过滤。

---

## 12. 感知-推理-行动闭环：错误重试与退避

### Q: Agent 有自动退避重试（Exponential Backoff）吗？

**LLM 调用有线性重试，但没有指数退避。GitHub API 调用没有重试。**

**LLM API 调用重试**（`src/agent/reviewer.ts:561-626`）：
- 最多重试 `MAX_RETRIES = 2` 次（共 3 次尝试）。
- 延迟策略：**线性递增** `(attempt + 1) * 1000` ms → 1s, 2s（不是指数退避）。
- 只重试可恢复错误（网络超时、5xx、429），不可恢复错误直接跳出。

```typescript
if (attempt < MAX_RETRIES && isRetryableError(lastError)) {
  const waitMs = (attempt + 1) * 1000;  // 线性，非指数
  await sleep(waitMs);
  continue;
}
```

**GitHub API 调用（diff 获取、评论发布）完全没有重试。**

特别是 `createReviewComment`（`src/tools/github.ts:214-246`），如果 GitHub 返回 403 rate limit，它会直接 `throw error`，由 `src/index.ts:64-68` 的外层 `try-catch` 捕获并调用 `setFailed()`，整个流水线终止。

### Q: Rate Limit 403 场景怎么处理？

当前：**直接失败，无重试，无退避。** 这是一个已知的工程欠账。更完善的方案需要：
1. 检测 `x-ratelimit-remaining` 响应头。
2. 如果即将耗尽，等待 `x-ratelimit-reset` 指定的时间。
3. 对 403 实施指数退避重试（1s → 2s → 4s → 8s ...）。

---

## 13. 架构重构：从 GitHub Action 到 GitHub App SaaS

### Q: 要做成像 Codecov 那样的独立 SaaS，架构需要哪些重大改变？

当前架构：**GitHub Action 运行在客户 runner 里，同步执行，无状态。**

改造为 GitHub App SaaS 的核心变化：

| 维度 | 当前（Action） | 目标（GitHub App SaaS） |
|------|--------------|---------------------|
| **运行环境** | 客户 runner（GitHub 提供或自托管） | 你自己的服务器 |
| **密钥管理** | 客户配置 Secrets，消耗客户配额 | 服务端统一管理，客户只需安装 App |
| **触发方式** | Workflow YAML 手动配置 | Webhook 自动订阅 `pull_request` 事件 |
| **认证方式** | `GITHUB_TOKEN`（短期令牌） | GitHub App Installation Token + JWT |
| **状态管理** | 无状态（每次运行独立） | 需要数据库（PR 记录、审查历史、Token 日志） |
| **并发控制** | GitHub Actions 默认并发 | 自己管理队列，防重复审查 |
| **计费** | 不涉及 | 需要用户/组织维度的计费系统 |

核心架构改造步骤：

1. **Webhook 接收层**：部署一个 HTTP server 接收 GitHub Webhook，解析 `pull_request.opened` / `pull_request.synchronize` 事件。
2. **认证层**：配置 GitHub App，生成 JWT 换取 Installation Token，使用 Token 调用 GitHub API。
3. **审查引擎**：保留现有 `analyzeCode` 核心，但改为异步任务队列（如 BullMQ + Redis）。
4. **评论发布**：使用 `pulls.createReview` API（App 支持行级 Review Comment），通过 Installation Token 鉴权。
5. **持久化**：引入数据库（PostgreSQL），存储 PR 审查状态、结果、Token 用量。
6. **用户面**：提供 Dashboard 查看审查历史、配置规则。注册流程只需用户安装 GitHub App 并选择仓库。
7. **多租户隔离**：按 GitHub App Installation ID 隔离配置和审查规则。

---

## 14. 知识库演进：Zero-DB RAG → Vector DB RAG

### Q: 团队规范有 10 万字，如何升级为基于向量检索的动态 RAG 系统？

当前架构的问题：
- 单文件 `.github/REVIEW_RULES.md`，全量注入 Prompt → Token 浪费。
- 没有相关性筛选 → 前端规范对后端 PR 毫无帮助却被全部加载。
- 没有语义理解 → 关键规则可能被截断丢弃。

### 升级方案

#### 架构总览

```
PR diff (变更文件列表 + 代码内容)
         │
         ▼
┌─────────────────────┐
│  Query Builder      │  ← 从 diff 中提取语言、框架、变更类型作为查询语义
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Embedding Service  │  ← 将 query 向量化（可选服务: text-embedding-3-small, bge-large 等）
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Vector DB          │  ← pgvector / Chroma / Qdrant / Pinecone
│  (知识库索引)        │     存储预先 chunked + embedded 的规范文档
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Reranker           │  ← 对召回结果精排（Cohere Rerank / bge-reranker）
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Prompt Assembler   │  ← Top-K 相关规范 + 通用基线 Prompt → 最终系统提示词
└────────┬────────────┘
         │
         ▼
     LLM 审查
```

#### 具体步骤

**1. 文档预处理（离线）**

将 10 万字规范文档拆分为语义 chunks：
- 每 500-1000 字符为一个 chunk，按 Markdown 标题层级划分。
- 在每个 chunk 上标记元数据：`{ language: "typescript", area: "security", severity: "critical" }`。
- 通过 Embedding 模型（如 `text-embedding-3-small`）为每个 chunk 生成向量。
- 存入向量数据库（推荐 `pgvector`，可以利用已有的 PostgreSQL）。

**2. Query 构建（在线）**

从 PR 信息中提取搜索语义：
```typescript
const queryContext = [
  `Files: ${prFiles.join(', ')}`,
  `Languages: ${detectedLanguages.join(', ')}`,
  `Change types: addition=${additions}, deletion=${deletions}`,
].join('; ');
```

**3. 向量检索 + 混合过滤**

两步筛选确保相关性：
- **语义检索**：`query embedding` 与知识库向量做余弦相似度搜索，Top-K=20。
- **元数据过滤**：只保留与 PR 语言/模块匹配的规范（如 TypeScript 规范对 TypeScript PR，Java 规范直接排除）。
- **Rerank**：用 Cohere Rerank 或 bge-reranker 对 20 条候选做精排，取 Top-5。
- **Token 预算控制**：Top-5 chunks 总计约 2500-5000 字符，远小于全量 10 万字。

**4. Prompt 注入**

将 Top-5 最相关规范注入系统提示词（替换当前的全文注入）。
- 每条规范带来源标注，LLM 知道这是 "特定领域的团队规范"。
- Token 消耗从 "全量 10 万字" 降低到 "最相关的 2500 字"，节省 ~97%。

**5. 闭环反馈**

- 开发者对误报评论添加 Reaction（👎）→ 记录对应规范 chunk，降低其在未来检索中的权重。
- 开发者编辑规范后触发 re-embedding pipeline。

---

## 15. Vibe Coding 供应链安全与审计

### Q: 如何保证 AI 生成的代码中不包含恶意窃取 API Key 的逻辑？

这是一个层次化的安全问题，需要从多个维度防御：

### 第一层：代码可见性

**AI 生成的代码是透明的。** 这是 Vibe Coding 与传统依赖管理的最大区别——你可以且必须逐行审查每一段代码。本项目的源码量总计约 1000 行（`reviewer.ts` ~634 行 + `github.ts` ~299 行 + `index.ts` ~73 行 + `logger.ts` ~75 行），完全适合人工逐行审计。

具体的审计点：
- 检查所有网络出口：`openai` SDK（指向 `baseURL`）、`octokit`（GitHub API）。没有第三方未知 endpoint。
- `baseURL` 通过环境变量传入，无法被代码硬编码劫持。
- `apiKey` 只传递给 `new OpenAI({ apiKey, baseURL })`，没有任何日志输出或文件写入。

### 第二层：CI/CD 隔离

GitHub Actions 的 Secret 机制（`${{ secrets.OPENAI_API_KEY }}`）确保：
- API Key 不会出现在日志中（GitHub 自动脱敏）。
- 即使代码中有 `console.log(apiKey)`，其输出也会被 GitHub 替换为 `***`。
- Secret 只在 workflow 运行期间存在于内存中，运行结束即销毁。

### 第三层：最小权限原则

项目的 Action 只申请了 `github-token` 和 `openai-key`，没有额外的文件系统写入权限或网络出口权限。GitHub Actions 运行在隔离的 runner 环境内。

### 在团队中推广 Vibe Coding 的安全审计建议

1. **硬规则：所有 PR 必须有人类 Reviewer 批准。** AI 生成的代码是初始输入，不是最终状态。PR Review 是强制性的安全门。

2. **Diff 必须小到可审。** 如果一次 AI 生成 5000 行代码，人类 reviewer 基本不可能逐行审计。鼓励小步提交，每次 < 300 行。

3. **重点审计网络出口和敏感数据处理。** 不是每行代码都要看，但以下必须逐行审计：
   - 所有 HTTP 请求（`fetch`、`axios`、SDK 调用）。
   - 环境变量/Secret 的读取和使用。
   - 文件系统写入。
   - 子进程调用（`exec`、`spawn`）。
   - `eval`、`new Function`、`vm` 模块。

4. **用 Vibe Coding 生成的代码审查工具去审查 Vibe Coding 生成的代码。** 这就是本项目 dogfooding 的思路——让 AI 审查 AI，形成闭环。

5. **依赖审计。** `npm audit` 检查第三方依赖的已知漏洞。AI 不会引入恶意依赖，但可能会引入有漏洞的版本。

6. **确定性构建。** 使用 lockfile 和 `ncc` 打包确保构建产物可复现。任何人可以 `npm ci && npm run build` 验证 `dist/index.js` 与官方分发版本一致。

7. **签署 Commits。** 配置 GPG 签名或 GitHub 的 vigilant mode，确保 commit 来源可追溯。
