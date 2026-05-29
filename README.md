
<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/typescript-%5E6.0-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node.js" />
  <img src="https://img.shields.io/badge/AI-DeepSeek%20V4-8A2BE2" alt="DeepSeek V4" />
  <img src="https://img.shields.io/badge/build-ncc-black" alt="ncc bundled" />
</p>

<h1 align="center">PR Reviewer Agent</h1>

<p align="center">
  <strong>让 <em>DeepSeek V4</em> 成为你的 Code Review 副驾驶 —— 零数据库、零幻觉、零延迟。</strong>
  <br />
  一个基于 LLM 的极简 GitHub Action，在你每一次提交 PR 时自动审查代码、注入团队规范，并将结构化意见直接贴在 PR 评论区。
</p>

---

## 一句话概述

**PR Reviewer Agent** 是一个 GitHub Action，它会在 Pull Request 创建或更新时自动触发，拉取代码 diff，结合你仓库中的自定义审查规范（Zero-DB RAG），调用 DeepSeek V4 进行深度代码审查，最终将结构化的审查意见作为评论发布到 PR 下方 —— 全程无需人工介入。

---

## 核心特性

### Zero-DB 轻量级 RAG —— 团队规范自动注入

每个团队都有自己独特的编码约定。本项目的 RAG（检索增强生成）无需向量数据库，也无需 Embedding 服务：

- **检（Retrieval）**：从目标仓库自动拉取 `.github/REVIEW_RULES.md`
- **增（Augmentation）**：将规则文本直接嵌入 LLM 系统提示词
- **生（Generation）**：DeepSeek V4 同时参考通用最佳实践 + 你的团队规范，生成定制化审查意见

不存在该文件时，自动降级为纯通用规则审查，不阻断流程。

### 三层 JSON 防幻觉机制 —— 强制结构化输出

LLM 在生成 JSON 时容易出现"幻觉"（杜撰文件路径、非纯数字行号、Markdown 代码块包裹等）。本项目设计了完备的三层防御体系：

| 防线 | 位置 | 策略 |
|------|------|------|
| **第一层** | Prompt | 明确要求"仅输出 JSON 数组，不得包含任何其他文字"，强制 file/line/comment 字段约束 |
| **第二层** | 解析器 | 自动剥离可能的 Markdown 代码块包裹，正则提取 JSON 数组片段，严格 `JSON.parse` |
| **第三层** | 校验器 | 逐条检查：file 非空字符串、line 通过 `/^\d+$/` 正则、comment 含可操作建议 —— 不合规条目直接丢弃并告警 |

三层防护确保最终输出的每一条审查意见都是**真问题、真文件、真行号**。

### 极低成本

- **DeepSeek V4**：API 价格约为 GPT-4 的 1/50，单次 PR 审查通常仅消耗 2000-5000 tokens，折合人民币 **不到 1 分钱**
- **单文件分发**：通过 `@vercel/ncc` 将所有依赖打包为单个 JS 文件，无需安装依赖，冷启动极快
- **零数据库**：RAG 方案不依赖任何外部存储或向量计算服务

### 完整闭环

```
GitHub PR 事件 → 拉取 diff → 加载团队规范 → AI 深度审查 → 结构化 JSON → Markdown 评论
```

每一步都有详细的控制台日志输出，方便在 GitHub Actions 日志中追踪。

---

## 快速开始

### 1. 准备工作

- 一个 **DeepSeek API Key**（在 [DeepSeek 开放平台](https://platform.deepseek.com) 获取，兼容任何 OpenAI 格式的 API）
- 在你的 GitHub 仓库 **Settings → Secrets and variables → Actions** 中添加 secret：`OPENAI_API_KEY`

### 2. 添加团队规范（可选但推荐）

在你的仓库根目录创建 `.github/REVIEW_RULES.md`，写入团队编码约定：

```markdown
## 命名规范
- 所有 React 组件文件使用 PascalCase（如 `UserProfile.tsx`）
- 工具函数文件使用 camelCase（如 `formatDate.ts`）

## 禁止模式
- 禁止使用 `any` 类型
- 禁止在 useEffect 中直接写 async 函数
- 禁止使用 `dangerouslySetInnerHTML`
```

审查时 Agent 会自动读取并代入这些规则。

### 3. 创建工作流文件

在你的仓库中创建 `.github/workflows/pr-review.yml`：

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run PR Reviewer Agent
        uses: rain/pr-reviewer-agent@main   # 替换为你的 fork 地址
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-key: ${{ secrets.OPENAI_API_KEY }}
          openai-base-url: "https://api.deepseek.com"   # 可选，默认即为此值
```

### 4. 提一个 PR，见证魔法

提交一个 Pull Request，几秒后你会看到 Agent 自动在评论区发布审查报告。

---

## 输入参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `github-token` | 是 | — | GitHub 令牌（建议使用 `${{ secrets.GITHUB_TOKEN }}`） |
| `openai-key` | 是 | — | LLM API Key（DeepSeek 或任何 OpenAI 兼容提供商） |
| `openai-base-url` | 否 | `https://api.deepseek.com` | OpenAI 兼容 API 的基础 URL |

---

## 项目架构

```
pr-reviewer-agent/
├── .github/
│   └── workflows/
│       └── test-agent.yml          # 狗粮测试：Action 审查自己的 PR
├── src/
│   ├── index.ts                    # 编排入口 —— 流水线总指挥
│   ├── agent/
│   │   └── reviewer.ts             # AI 引擎 —— Prompt 构建 + JSON 防幻觉 + LLM 调用
│   └── tools/
│       └── github.ts               # GitHub 工具层 —— diff 获取 + 规范拉取 + 评论发布
├── dist/                           # ncc 编译产物（单文件，可直接在 Action 中运行）
├── action.yml                      # GitHub Action 描述文件
├── tsconfig.json
├── package.json
├── CLAUDE.md                       # Vibe Coding 指令书（见下方说明）
└── README.md
```

### 数据流

```
                      ┌──────────────────┐
                      │   src/index.ts   │  ← 编排入口
                      └──────┬───────┬───┘
                             │       │
              ┌──────────────┘       └──────────────┐
              ▼                                      ▼
   ┌──────────────────┐                    ┌──────────────────┐
   │ tools/github.ts  │                    │ agent/reviewer.ts │
   │                  │                    │                  │
   │ · fetchPRDiff()  │ ──── diff ───────→ │ · buildPrompt()  │
   │ · fetchTeamRules │ ──── rules ──────→ │   (RAG 注入)     │
   │ · createComment  │ ←── comments ──── │ · analyzeCode()  │
   └──────────────────┘                    │ · parseValidate()│
                                           └──────────────────┘
                                                    │
                                                    ▼
                                           DeepSeek V4 API
```

---

## Vibe Coding：我是如何用 CLAUDE.md 指导大模型完成这个项目的

> 这个项目的独特之处在于：**我几乎没有写任何一行代码。** 我做的唯一事情是不断迭代 `CLAUDE.md`。

### 什么是 Vibe Coding？

Vibe Coding 是一种全新的开发范式：你不是在写代码，而是在**用自然语言描述项目的架构、约束和意图**，让大模型来完成实际的编码工作。CLAUDE.md 就是这个过程的"指令书"。

### Phase 1：种子（commit `20fd0be`）

```
chore: initial project setup, dependencies, and CLAUDE.md via DeepSeek V4 Agent
```

我做的第一件事不是 `npm init`，而是写了一个 `CLAUDE.md`，告诉模型：

> _"你是一个严谨的高级 TypeScript 架构师。当前项目处于初始化阶段。"_

然后我把技术栈约束、模块划分、ESM 规范写进去，模型自己创建了 `tsconfig.json`、`package.json` 和项目骨架。

### Phase 2：核心引擎（commit `53e3030`）

```
feat: implement lightweight RAG engine and DeepSeek review logic with strict JSON output
```

我在 `CLAUDE.md` 中加入了更具体的需求描述：

- _"构建系统提示词时必须将团队规范作为 RAG 注入"_
- _"对 LLM 输出进行三层 JSON 防幻觉处理"_
- _"支持失败重试、Token 预估、diff 截断"_

模型理解了"三层防幻觉"这个概念，并实现了从 Prompt 约束到正则清洗再到字段级校验的完整链路 —— **我在这个阶段写的代码行数为 0**。

### Phase 3：编排闭环（commit `1fcd34d`）

```
feat: orchestrate agent pipeline, add comment action, and configure ncc build
```

我在 `CLAUDE.md` 中定义了完整的流水线闭环逻辑：

> _"入口是 src/index.ts，流程必须是：获取参数 → 拉取 diff → 加载规范 → AI 审查 → 发布评论。"_

同时要求生成 `action.yml` 和配置 `@vercel/ncc` 构建脚本。模型自己理解了 GitHub Actions 的 `getInput` / `setFailed` 约定，以及 `mediaType: 'diff'` 的 GitHub API 细节。

### Phase 4：狗粮测试（commit `621f30b`）

```
ci: add dogfooding workflow to test agent
```

我在 `CLAUDE.md` 中没有任何关于 CI 的指令，但模型在创建 `.github/workflows/test-agent.yml` 时自己采用了"狗粮（dogfooding）"模式 —— **Action 审查自己的 PR**，确保每次修改都会先被自己审查一遍。

### 最终产物

| 文件 | 代码行数 | 我写的行数 |
|------|----------|------------|
| `src/index.ts` | 63 | 0 |
| `src/agent/reviewer.ts` | 622 | 0 |
| `src/tools/github.ts` | 298 | 0 |
| `action.yml` | 23 | 0 |
| `.github/workflows/test-agent.yml` | 15 | 0 |
| **合计** | **~1020** | **0** |

> 我所做的就是不断告诉 CLAUDE.md："你是谁、你要做什么、你不能做什么、你要按什么顺序做"。
> 
> 然后代码自己长出来了。

### CLAUDE.md 的演进哲学

回顾整个过程，`CLAUDE.md` 经历了三次关键演进：

1. **角色定位**：从 "你是 TypeScript 工程师" 到 "你是高级 TypeScript 架构师和 DevOps 专家" —— 角色越具体，输出越精准
2. **约束递增**：从 "使用 TypeScript" 到 "必须使用 ESM、必须 ncc 打包、必须三层防幻觉、必须 50k 字符截断" —— 每个约束都是上一次测试中发现的缺口
3. **闭环思维**：从 "做一个审查工具" 到 "做一个零人工介入的完整 Action，包含获取→分析→评论→降级" —— 告诉模型最终交付物是什么，而不是每一步怎么做

如果你也想尝试 Vibe Coding，记住这条黄金法则：

> **不要告诉模型怎么写代码，告诉它你要交付什么产品。**

---

## 本地开发

```bash
# 安装依赖
npm install

# 编译（通过 ncc 打包为单文件）
npm run build

# 产物在 dist/index.js，可直接在 GitHub Actions 中运行
```

---

## License

MIT © Rain

---

<p align="center">
  <sub>Built with ❤️ using Vibe Coding — 0 lines of human code, 100% CLAUDE.md driven.</sub>
</p>
