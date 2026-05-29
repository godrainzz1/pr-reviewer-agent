# PR Reviewer Agent — 项目文件说明书

## 项目概览

`pr-reviewer-agent` 是一个 **GitHub Action**，当有人向仓库提交 Pull Request 时，它会自动触发 AI 代码审查流水线，并将审查结果以评论形式发布到 PR 下方。

核心能力：
- 获取 PR 的代码变更（unified diff）
- 加载目标仓库的团队自定义审查规则（轻量级 RAG）
- 调用 DeepSeek V4（兼容 OpenAI 协议）进行深度代码审查
- 将结构化审查意见自动发布为 PR 评论

---

## 文件清单与说明

### 根目录 — 项目配置层

#### `package.json`
**作用**: npm 包清单文件，定义项目元数据和依赖。

关键字段：
- `"type": "module"` — 启用 ESM 模块系统（`import`/`export` 语法）
- `scripts.build` — 使用 `@vercel/ncc` 将 TypeScript 源码编译打包为单文件 `dist/index.js`，供 GitHub Action 的 Node.js 运行时直接执行（无需 `node_modules`）
- `scripts.dev` — 一键构建 + 运行，用于本地调试
- **dependencies**: `@actions/core`（Action 输入/输出）、`@actions/github`（Octokit GitHub API 客户端）、`openai`（调用 DeepSeek API）
- **devDependencies**: `typescript`（编译器）、`@vercel/ncc`（打包器）、`@types/node`（Node 类型定义）

**为什么存在**: Node.js 项目的标配，让 `npm install` / `npm run build` 能够工作。

---

#### `package-lock.json`
**作用**: 锁定依赖树的精确版本号。

**为什么存在**: 确保 CI 环境和任何开发者的本机安装到完全相同的依赖版本，避免"我这能跑，CI 炸了"的问题。由 npm 自动生成，**不应手动编辑**。

---

#### `tsconfig.json`
**作用**: TypeScript 编译器配置。

关键设定：
- `target: "ES2022"` — 输出现代 JS（支持 top-level await、private fields 等）
- `module: "NodeNext"` — 使用 Node.js 原生 ESM 模块解析
- `strict: true` — 开启所有严格模式检查（最高类型安全级别）
- `noUnusedLocals: true` — 未使用的局部变量视为编译错误，保持代码整洁
- `declaration: true` — 生成 `.d.ts` 类型声明文件
- `rootDir: "src"` — 源码根目录，编译器只编译 `src/` 下的文件

**为什么存在**: 确保团队所有成员使用相同的 TS 编译规则，避免因配置差异导致的编译不一致。

---

#### `action.yml`
**作用**: GitHub Action 的描述文件（自定义 Action 的入口）。当其他仓库在 workflow 中写 `uses: username/pr-reviewer-agent@v1` 时，GitHub 就是通过这个文件知道该 Action 需要什么参数、运行什么命令。

定义的三个输入参数：
| 参数 | 必填 | 说明 |
|---|---|---|
| `github-token` | 是 | 用于读取 PR 内容和发布评论的 GitHub 令牌 |
| `openai-key` | 是 | DeepSeek（或任何 OpenAI 兼容服务）的 API 密钥 |
| `openai-base-url` | 否 | API 端点地址，默认指向 DeepSeek |

运行入口：`dist/index.js`（即 ncc 打包后的产物）。

**为什么存在**: 没有这个文件，GitHub Actions 平台无法识别这是一个可以被 `uses:` 引用的 Action。

---

#### `.gitignore`
**作用**: 告诉 git 哪些文件/目录不需要纳入版本控制。

忽略内容：
- `node_modules/` — npm 依赖（由 `package-lock.json` 锁定版本，CI 中通过 `npm ci` 安装）
- `*.tsbuildinfo` — TypeScript 增量编译缓存
- `.env` / `.env.local` — 环境变量文件（可能包含 API 密钥等敏感信息）

**为什么存在**: 防止将本地生成的、环境相关的或包含机密的文件误提交到仓库。

---

### `src/` — 核心源码

#### `src/index.ts` — 流程编排入口
**作用**: 整个程序的 **绝对起点**，也是 GitHub Action 运行时的入口文件。它串联了完整的审查流水线。

执行流程（6 步）：
1. 从 `@actions/core` 获取 GitHub Actions 传入的 `github-token`、`openai-key`、`openai-base-url`
2. 通过 `@actions/github` 获取当前 PR 的上下文（owner / repo / PR 编号）
3. 调用 `fetchPRDiff()` 获取 PR 的代码变更文本
4. 调用 `fetchTeamRules()` 加载目标仓库的团队审查规范（RAG 知识源）
5. 调用 `analyzeCode()` 将 diff + 规范一起发给 DeepSeek V4 进行分析，得到结构化审查意见
6. 调用 `createReviewComment()` 将结果格式化为 Markdown 并发布为 PR 评论

异常处理：顶层 `try/catch` 捕获所有未处理异常，通过 `setFailed()` 让 GitHub Actions 将该次运行标记为失败。

**为什么存在**: 这相当于程序的 `main()` 函数。它是 Phase 3 的核心交付物，将所有模块串联为一个闭环。

---

#### `src/tools/github.ts` — GitHub API 交互层
**作用**: 封装所有与 GitHub REST API 的交互逻辑。提供三个核心函数：

| 函数 | 职责 | 失败策略 |
|---|---|---|
| `fetchPRDiff()` | 获取指定 PR 的 unified diff 文本（通过 `mediaType.format = 'diff'` 让 API 直接返回纯文本而非 JSON） | 直接抛出异常，阻断流水线 |
| `fetchTeamRules()` | 从目标仓库读取 `.github/REVIEW_RULES.md` 作为 RAG 知识源。这是轻量级 RAG 的 **检索（Retrieval）** 环节 | 文件不存在（404）→ 返回 `null`，优雅降级；其他错误 → 返回 `null`，不阻断主流程 |
| `createReviewComment()` | 将审查意见格式化为 Markdown 并发布到 PR 的 Conversation 标签页。这是流水线的 **闭环最后一环** | 直接抛出异常 |

关于轻量级 RAG（Retrieval-Augmented Generation）：
- 本项目采用**最简实现**：直接通过 GitHub Content API 读取一个 Markdown 文件作为知识源，无需向量数据库或 Embedding
- 文件名固定为 `.github/REVIEW_RULES.md`，由各仓库自行维护
- 这种方案适合单文件、轻量级的场景，零基础设施依赖

**为什么存在**: 将网络 I/O 和 API 调用细节与业务逻辑分离。如果将来需要支持 GitLab 或其他平台，只需替换本文件即可。

---

#### `src/agent/reviewer.ts` — AI 审查引擎
**作用**: 封装与 DeepSeek V4 模型交互的全部逻辑。这是整个系统中最复杂的模块。

核心设计三大支柱：

**1. RAG 注入（`buildSystemPrompt`）**
- 将 `fetchTeamRules()` 获取的团队规范追加到系统提示词末尾
- 使 LLM 在审查时同时遵守通用最佳实践和项目特定约定
- 没有规则时降级为纯通用模式

**2. JSON 防幻觉（三层防御体系）**
- **第一层 — Prompt 约束**: 系统提示词中严格限定输出格式（仅返回 JSON 数组、禁用 Markdown 代码块、字段级语义约束）
- **第二层 — 输出清洗**: 正则剥离可能出现的 Markdown 代码块标记；JSON.parse 严格解析；解析失败时正则提取数组片段重试
- **第三层 — 字段级校验**: 逐条检查 `file`（非空字符串）、`line`（纯数字正则 `/^\d+$/`）、`comment`（非空字符串），不合规条目直接丢弃

**3. 调用可靠性**
- 失败自动重试（最多 2 次），递增延迟（1s → 2s）
- 仅对瞬态错误（超时、5xx、429 速率限制）重试，确定性错误直接失败
- Token 消耗预估日志，方便成本监控

关键配置常量：
| 常量 | 值 | 说明 |
|---|---|---|
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 默认 API 端点 |
| `DEFAULT_MODEL` | `deepseek-chat` | DeepSeek V4 模型标识 |
| `MAX_DIFF_LENGTH` | 50,000 字符 | 超出部分的 diff 会被截断，控制 Token 消耗 |
| `MAX_RETRIES` | 2 | 首次调用之外的重试次数 |

**为什么存在**: 负责将"代码审查能力"这一核心价值封装为可调用的函数。它屏蔽了 Prompt 工程、JSON 防幻觉、错误重试等复杂性，对外只暴露 `analyzeCode(diff, rules, key)` 一个干净接口。

---

### `dist/` — 构建产物目录

**作用**: 存放 `@vercel/ncc` 打包后的单文件输出。

`dist/index.js` 是将 `src/` 下所有 TypeScript 源码及其 `node_modules` 依赖编译并打包成一个自包含的 JavaScript 文件。GitHub Action 的 Node.js 运行时直接执行这个文件，**不需要** `npm install`。

**为什么存在**: GitHub Action 要求入口是一个可直接运行的 JS 文件。ncc 打包让 Action 的消费者无需安装任何依赖，且大幅缩短 Action 的启动时间。

**维护规则**: 每次修改 `src/` 源码后，必须运行 `npm run build` 重新生成 `dist/index.js`。**dist 目录已纳入版本控制**（在 `.gitignore` 中没有被忽略），因为 Action 的消费者依赖它。

---

### `.github/workflows/` — CI/CD 配置

#### `.github/workflows/test-agent.yml`
**作用**: **Dogfooding 工作流**（用自己的 Action 审查自己的 PR）。当本项目自身收到 PR 时，自动运行 AI Reviewer 进行审查并发布评论。

触发条件：
- `pull_request: [opened, synchronize]` — PR 新建时和追加提交时触发

工作内容：
1. `actions/checkout@v4` 拉取代码
2. `uses: ./` 使用本仓库根目录的 `action.yml` 定义（即自己审查自己）
3. 传入 `GITHUB_TOKEN`（GitHub 自动提供）和 `OPENAI_API_KEY`（在仓库 Secrets 中配置）

**为什么存在**: 验证 Action 本身能否正常工作。每次给本项目提 PR 时，AI Reviewer 会自动运行——如果它成功发布了评论，说明 Action 是好的；如果失败了，说明需要修。

---

### `.claude/` — Claude Code 本地配置

#### `.claude/settings.local.json`
**作用**: Claude Code（AI 编码助手）的项目级本地权限配置。本项目中允许了 `npx tsc`（TypeScript 编译检查）、`npm install`、`npm run build` 等命令在无需逐次确认的情况下执行。

**为什么存在**: 减少开发过程中反复确认权限的摩擦。这是 Claude Code 的专属配置文件，与项目业务逻辑无关。**此文件在 `.gitignore` 中**（因为它在 `node_modules/` 同级路径且通常不应提交），但当前项目选择将其纳入版本控制以共享权限配置。

---

### 文档层

#### `CLAUDE.md`
**作用**: 给 AI 编码助手（Claude Code）阅读的项目说明文档。它告诉 AI：
- 项目当前处于 Phase 3（流程编排阶段）
- 技术栈约束（TypeScript / ESM / ncc 打包）
- 架构规范（入口文件、GitHub Action 封装要求）
- 编码规范（流水线闭环逻辑）

**为什么存在**: 让 AI 助手在协助开发时自动理解项目的架构约定和当前阶段，减少每次沟通的成本。**面向 AI 而非人类**。

---

#### `README.md`
**作用**: 给**人类开发者**阅读的项目说明文档（AI 自动生成的）。包含项目介绍、使用方式、配置说明等。

**为什么存在**: 开源项目标配，让第一次看到这个仓库的人能快速理解它是什么、怎么用。

---

## 数据流全景图

```
GitHub PR 事件 (opened / synchronize)
        │
        ▼
.github/workflows/test-agent.yml   ← CI 触发器
        │
        ▼
action.yml                          ← Action 定义（参数声明）
        │
        ▼
dist/index.js                       ← ncc 打包后的入口文件
        │
        ▼
src/index.ts                        ← 流程编排 (run 函数)
        │
        ├── (1) 获取输入参数: github-token, openai-key, openai-base-url
        │
        ├── (2) src/tools/github.ts :: fetchPRDiff()
        │        └── GitHub REST API → PR unified diff 文本
        │
        ├── (3) src/tools/github.ts :: fetchTeamRules()
        │        └── GitHub Content API → .github/REVIEW_RULES.md (或 null)
        │
        ├── (4) src/agent/reviewer.ts :: analyzeCode(diff, rules, key)
        │        ├── buildSystemPrompt(rules)    ← RAG 注入
        │        ├── buildUserPrompt(diff)       ← diff 截断
        │        ├── DeepSeek V4 API 调用        ← 带重试
        │        └── parseAndValidateResponse()  ← JSON 防幻觉
        │
        └── (5) src/tools/github.ts :: createReviewComment()
                 └── GitHub Issues API → PR 评论 (闭环)
```

---

## 新人上手步骤

1. **`npm install`** — 安装依赖
2. **阅读本文件**（你正在做的）— 理解每个文件的存在意义
3. **阅读 `src/index.ts`** — 理解流水线的整体运转逻辑（这是最好的起点）
4. **阅读 `src/agent/reviewer.ts`** — 理解 AI 审查引擎的 RAG 注入和防幻觉机制
5. **阅读 `src/tools/github.ts`** — 理解 GitHub API 交互细节和轻量级 RAG 检索
6. **`npm run build`** — 确认可以成功打包
7. **试着修改一个 `.ts` 文件，然后发一个 PR** — 观察 dogfooding workflow 是否正常运行
