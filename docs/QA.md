# PR Reviewer Agent — 面试深度 Q&A

> 基于项目源码 `src/`、`action.yml`、`.github/workflows/` 的真实实现逐条作答。
> 项目地址：https://github.com/godrainzz1/pr-reviewer-agent

---

## 1. AI 约束机制 — CLAUDE.md 规则与防过度引入依赖

### Q: CLAUDE.md 里具体写了哪些规则？如何防止 AI 乱引入第三方库？

**CLAUDE.md 核心规则（精简摘录）：**

```markdown
# 角色定位与项目背景
你是一个严谨的高级 TypeScript 架构师和 DevOps 专家。
当前项目处于 Phase 3（流程编排与 GitHub Action 封装阶段）。

# 技术栈约束
- 语言：TypeScript, Node.js (ESM)
- 核心打包工具：@vercel/ncc

# 架构与编码规范
1. src/index.ts 作为程序的绝对起点，流程必须是：
   a. 从 GitHub Actions 环境变量获取输入参数
   b. 调用 github.ts 获取 PR diff 和 RAG 规范
   c. 将 diff 和规范传入 reviewer.ts 获取分析结果
   d. 在 github.ts 中新增 createReviewComment 方法，将 JSON 结果发布为评论

2. 在项目根目录生成 action.yml
3. 使用 ncc build src/index.ts -o dist --source-map 打包
```

**防止乱引入第三方库的机制：**

CLAUDE.md 三行最关键：

```
- 语言：TypeScript, Node.js (ESM)
- 核心打包工具：@vercel/ncc
```

- **语言声明**："TypeScript, Node.js (ESM)"——明确告诉 AI 这是纯 TS 项目，不要 touch Python/Rust/Go
- **打包工具声明**："@vercel/ncc 打包为单文件"——AI 理解每个新增依赖都会增大最终产物尺寸，天然倾向零依赖
- **隐含约束**：GitHub Action 的运行环境是裸 Node.js runner，没有 `pip`、没有 `cargo`、没有 `docker`。AI 知道引入非 JS 依赖等于编译失败，从根本上抑制了跨语言引入库的冲动
- **实操验证**：项目最终只有 3 个运行时依赖——`@actions/core`、`@actions/github`、`openai`，全部是 GitHub Action 生态内的标准选择

---

## 2. 排错能力 — 不熟悉 TypeScript 时如何 Debug 线上故障

### Q: 作为 Python 开发者，TS 代码在 GitHub Actions 线上跑崩了怎么调试？

**调试流程分为三层：**

**第一层：控制台日志（Console-Driven Debugging）**

项目所有关键模块都内嵌了 `console.log` 探针。每步输出带 `[模块名]` 前缀和 emoji 标记的日志。比如 PR review 流水线会打印：

```
[index] 🚀 开始审查 PR #1 (owner/repo)
[fetchPRDiff] ✅ 成功获取 diff，长度: 2340 字符
[fetchTeamRules] ℹ️  未找到 .github/REVIEW_RULES.md（404），降级为通用规则
[buildSystemPrompt] ℹ️  未检测到团队规则，系统提示词仅包含通用审查规范
[analyzeCode] 📊 Token 消耗预估: 系统 ~1200, 用户 ~900, 合计 ~2100
[analyzeCode] 🚀 正在调用 deepseek-chat API（第 1/3 次尝试）...
[analyzeCode] ✅ LLM 响应成功，原始输出长度: 1834 字符
[createReviewComment] 映射结果: 8 条 inline + 0 条通用
[createReviewComment] ✅ 行级 Review 已成功发布
```

**第二层：GitHub Actions 日志界面**

打开 Actions run → 点击具体 job → 展开 step 日志。每个 `[模块名] ❌` 的错误行会精确指出崩溃位置。比如之前遇到过的 `Invalid URL` 错误，日志明确显示：

```
[analyzeCode] ❌ 第 1 次 API 调用失败: Invalid URL
```

立刻定位到 `analyzeCode` 模块的 LLM API 调用步骤。

**第三层：本地复现**

GitHub Actions 本质上就是一个远程 Node.js 环境。在本地 `npm run build && npm start` 可以模拟同样的流程。如果是环境变量问题，手动注入同值即可。

**跨语言的排错心态：**

"不懂 TypeScript"并不影响阅读错误堆栈——`TypeError`、`ReferenceError`、`Invalid URL` 这些错误类型和 Python 的同名异常语义完全一致。真正重要的是 IDE 的红色波浪线（TypeScript 编译报错，等同于 Python 的 `pylance` 红线）和清晰的分层日志。

---

## 3. 跨语言边界 — Vibe Coding 的最大风险与人工兜底

### Q: 跨语言 Vibe Coding 的最大风险是什么？如何兜底？

**最大风险：对目标语言运行时行为的盲区。**

举个实战例子——在这个项目里遇到过 `ncc` 打包后 `new OpenAI({ baseURL })` 在线上报 `Invalid URL`。作为 Python 开发者，直觉会认为是 URL 格式问题。但实际排查发现是 ncc 的模块打包机制与 OpenAI SDK 的构造函数参数解构产生了微妙交互。

**人工兜底机制：**

1. **编译时检查（TypeScript 的最大优势）**——`tsconfig.json` 的 `"strict": true` + `"noUnusedLocals": true` + `"noUnusedParameters": true`。每改一次代码，IDE 的红色波浪线是第一道防线。报编译错误 → 不能 build → 不能部署。

2. **最小化代码量**——整个项目核心逻辑约 500 行 TS。代码越少，审计面越小，理解成本越低。

3. **依赖最小化**——只用了 3 个外部包。每多一个包就多一个不理解的黑盒。

4. **GitHub Actions 的天然沙箱**——线上跑崩了不会影响本地环境，不会丢数据。每次 run 都是全新环境。崩溃 → 看日志 → 修代码 → push → 自动重试。

---

## 4. 工程基建 — @vercel/ncc 零依赖打包的价值

### Q: 为什么 GitHub Action 必须零依赖打包？冷启动提速体现在哪里？

**为什么必须打包：**

GitHub Action 的 JavaScript action 通过 `action.yml` 的 `runs.main` 字段指定一个**单个 JS 文件**作为入口。Runner 执行的是 `node dist/index.js`，而不是 `npm install && node src/index.ts`。如果 `dist/index.js` 里的 `import` 语句指向了 `node_modules/`，而 runner 上根本没有 `node_modules/`（因为没有 `npm install` 步骤），直接报 `MODULE_NOT_FOUND` 崩溃。

**ncc 做了什么：**

```
src/index.ts
  ├── import { getOctokit } from '@actions/github'
  ├── import { analyzeCode } from './agent/reviewer.js'
  └── import { fetchPRDiff } from './tools/github.js'
                    ↓  ncc build
          dist/index.js (1675KB, 单文件)
```

ncc 从入口文件出发，递归追踪 `import` 依赖图，把所有被引用的模块源码按正确顺序内联进一个 IIFE（立即执行函数表达式）中。`node_modules` 里的 `@actions/github`（几十个文件、上万行代码）只内联实际被 import 到的代码路径（tree-shaking）。最终产物是一个自包含的 JS 文件。

**对冷启动速度的提升：**

| 操作 | 有 ncc | 无 ncc |
|------|--------|--------|
| 文件 I/O | 读取 1 个文件 | 读取 ~50+ 个文件（递归遍历 node_modules） |
| 模块解析 | 无（已内联） | Node.js 运行时逐文件 import 解析 |
| 磁盘占用 | 1.6MB | 50MB+（node_modules） |
| 启动耗时 | <100ms | 1-3s |

GitHub Actions runner 是临时虚拟机，每次触发都是"冷启动"。节省的 2-3 秒 × 每天数十次触发 = 显著的用户体验差异。

---

## 5. 感知层设计 — Diff 去冗余与 Token 截断

### Q: 如何处理 diff 中的冗余上下文？Token 超限怎么办？

**当前策略：完整 diff + 硬截断。**

代码直接拉取 GitHub API 返回的 raw unified diff，**不做 diff 语法级别的行过滤**（即不区分 `+`/`-`/上下文行）。送到 LLM 之前，在 `buildUserPrompt` 中做了一道长度门控：

```typescript
const MAX_DIFF_LENGTH = 50_000; // 字符数

if (diff.length > MAX_DIFF_LENGTH) {
    diffContent = diff.slice(0, MAX_DIFF_LENGTH) +
        '\n\n[... diff 已被截断，请优先审查前半部分的逻辑变更和安全问题 ...]';
}
```

50,000 字符 ≈ 20,000 Token（按 0.4 系数估算），DeepSeek V4 的 128K context window 完全装得下。

**设计理由：依赖 LLM 的语言理解力。** unified diff 格式（`+++`/`---`/hunk header）本身就是一种"微语言"，LLM 经过训练后能正确理解哪些行是新增/修改、哪些是上下文。自己写 parser 去过滤上下文行反而有风险——比如一个 bug 可能跨越多行，只给 `+` 行会丢失关键上下文。

**Token 超限时的行为：硬截断保留前半部分，不崩溃。** 并追加提示让模型优先关注已有内容。这是有意为之的简单策略——对大多数 PR（<10 个文件），50K 字符绰绰有余。对于大型 PR，可以后续升级为按文件优先级分批审查。

---

## 6. 推理层设计 — 系统级 Prompt 的分层设计

### Q: 系统 Prompt 是怎么设计的？有侧重点吗？

**有明确的优先级分层。** 系统 Prompt 定义了 5 层审查维度，按严重程度从高到低排列：

```markdown
1. 安全漏洞（优先级最高）—— OWASP Top 10：
   命令注入、SQL/NoSQL 注入、XSS、敏感信息泄露、路径遍历

2. 逻辑错误 —— 竞态条件、边界值、null/undefined

3. TypeScript 类型安全 —— any 滥用、危险断言、缺少 null 检查

4. 性能问题 —— N+1 查询、循环重复计算

5. 可维护性（优先级最低）—— 命名、函数长度、魔法数字
```

**设计理念：**

- **安全优先**——作为自动审查的底线。miss 掉一个可维护性问题只是技术债，miss 掉一个 SQL 注入是安全事故
- **维度递减权重**——通过列表顺序暗示 LLM 优先关注安全/逻辑，可维护性排在最后
- **具体化而非抽象化**——每个维度都给了具体子项和代码示例，而非只说"检查安全问题"。这是因为 LLM 对具体指令的遵守度远超抽象指令
- **"如果没有问题，返回空数组"**——防止 LLM 强行瞎编

---

## 7. 行动层闭环 — 缺乏过滤阈值的设计缺陷（诚实承认）

### Q: 如果大模型找出 10 个缩进问题发 10 条评论，怎么过滤？

**坦白说：当前实现没有"严重程度分级"或"过滤阈值"机制。**

现状是 LLM 返回的所有通过 JSON 解析且通过字段格式校验的条目，都会被发布为行级评论。这确实是当前架构的一个局限性。

**如果设计过滤机制，方案如下：**

1. **Prompt 层约束**（零成本）——在系统 Prompt 中要求模型为每条意见输出一个 `severity` 字段（`critical`/`warning`/`info`），只有 `critical` 和 `warning` 级别的评论才通过过滤
2. **规则层过滤**（低成本）——维护一个"忽略模式"列表。比如 `comment` 中只含缩进/空格/换行的意见自动丢弃
3. **置信度过滤**（中成本）——要求 LLM 为每条意见输出 `confidence`（0-1），低于 0.6 的丢弃
4. **批量合并**——对同类型、同严重程度的意见，合并为一条 Review，而非逐条发

**为什么不现在做：** MVP 阶段优先验证闭环通路。过滤阈值是锦上添花，不应该在验证阶段过早优化。

---

## 8. 状态管理 — 同一 PR 多次 push 的重复评论问题

### Q: 开发者连续 push 两次，会不会对同一个 Bug 重复评论？

**当前状态：PR Review（行级评论）本身具有幂等性。**

使用 `pulls.createReview` 发布的是 GitHub **Review**，而非 **Issue Comment**。GitHub Review 有独特的提交机制：
- Review 发布后，如果 PR 有新的 commit push 进来，之前的 Review 状态自动变为 `outdated`
- 新的 `synchronize` 事件触发新 Review
- 旧 Review 仍然可见但标记为过时

**但 Issue Comment（降级路径）存在重复风险。** 如果 inline Review 失败降级到 `issues.createComment`，每次 `synchronize` 都会追加一条新评论，导致 Conversation 中出现重复内容。

**当前止损措施：**

1. `concurrency: cancel-in-progress` 确保同一 PR 同一时间只有一个 job 在跑
2. 降级路径是异常情况（line-level review 失败），不是常态
3. 如果需要完全去重，可以在发评论前调用 `listReviews` 查找 Bot 之前的评论并删除——这个逻辑在 Phase 4 探索中已经实现过原型

---

## 9. Zero-DB RAG 原理

### Q: "Zero-DB RAG" 是什么意思？工作流是什么？

**定义：** 不依赖向量数据库、不依赖 Embedding 服务、不依赖外部存储的轻量级 RAG。

**工作流（三步）：**

```
1. 检索（Retrieval）
   fetchTeamRules() → octokit.rest.repos.getContent('.github/REVIEW_RULES.md')
   → 从 GitHub API 直接拉取文件内容（Base64 解码 → UTF-8 文本）

2. 增强（Augmentation）
   buildSystemPrompt(teamRules) → 将规则文本作为独立小节拼接到系统提示词末尾
   "## ⚡ 团队自定义审查规范（RAG 检索增强）\n{teamRules}"

3. 生成（Generation）
   LLM 同时参考通用审查基线 + 团队特定规范 → 输出结构化审查意见
```

**为什么不需要向量数据库：**

向量数据库解决的是"从 10 万份文档中找到最相关的 3 份"的问题。当知识源只有一个文件（`REVIEW_RULES.md`，通常几百到几千字），**全文注入 Prompt 的成本远低于引入一套向量检索基础设施的成本**。

**适用量级：** 单一知识源、<5000 字、<2000 Token 的团队规范。超过这个量级再考虑升级到 Vector DB。

---

## 10. RAG 平滑降级

### Q: 如果 `.github/REVIEW_RULES.md` 不存在或读取失败，Agent 怎么处理？

**不罢工，静默降级为"纯通用规则"模式。**

```typescript
try {
    const response = await octokit.rest.repos.getContent({ ... });
    if (response.status === 200) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
    }
} catch (error) {
    // 404：文件不存在 → 正常业务状态
    if (error.status === 404) {
        console.log('未找到 REVIEW_RULES.md（404），降级为通用规则');
        return null;  // ← 不抛异常，返回 null
    }
    // 403/500 等：权限错误/服务端错误 → 记录日志，同样降级
    console.error('RAG 加载异常，降级为通用规则');
    return null;  // ← 同样不阻断主流程
}
```

**设计哲学：审查功能本身不应因规范文件缺失而中断。** 宁可少一点团队规范的建议，也不能让 PR review 静默失败（开发者以为通过了审查，实际上什么都没跑）。

---

## 11. 防幻觉 — 格式约束（反序列化校验）

### Q: 如何剥离 LLM 输出的 ```json Markdown 标记？

**三层防线：**

**第一层 — Prompt 约束：**
```
你的整个回复必须仅仅是一个 JSON 数组，不要包含 Markdown 代码块标记
```

**第二层 — 正则剥离 + JSON.parse + 数组提取：**

```typescript
// Step 1: 剥离可能的 ```json ... ``` 包裹
const codeBlockMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();  // 只取代码块内内容
}

// Step 2: 直接 JSON.parse
try {
    return JSON.parse(jsonStr);
} catch {
    // Step 3: 失败了？用贪婪正则提取 [...] 数组片段再试
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    return JSON.parse(arrayMatch[0]);
}
```

正则 `\[[\s\S]*\]` 解释：`[\s\S]*` 匹配任意字符（包括换行），贪婪模式从第一个 `[` 匹配到最后一个 `]`。能处理 JSON 嵌套中的 `]`。

**第三层 — 根类型校验：**
```typescript
if (!Array.isArray(parsed)) {
    throw new Error(`LLM 返回的不是数组，而是 "${typeof parsed}"`);
}
```

---

## 12. 防幻觉 — 逻辑约束（行号验证）

### Q: 如何防止 LLM 捏造不存在的行号？

**当前实现通过 diff position 映射做了"事实校验"。**

LLM 审查的是 unified diff，输出的 `line` 是新增文件的物理行号。在发布评论前：

```typescript
// 构建 (文件, 物理行号) → diff position 的映射表
const positionMap = buildPositionMap(diff);

for (const comment of reviewComments) {
    const filePositions = positionMap.get(comment.file);
    if (filePositions) {
        const pos = filePositions.get(parseInt(comment.line));
        if (pos) {
            // ✅ 行号真实存在 → 发 inline comment
            inlineComments.push({ path: comment.file, position: pos, body: comment.comment });
            continue;
        }
    }
    // ❌ 行号不存在于 diff 中 → 降级为 body 通用评论（不绑定行号）
    generalComments.push(comment);
}
```

**效果：** LLM 捏造的行号不会导致 API 422 错误（因为不会被放到 `comments` 数组里），而是作为不绑行号的通用评论发在 PR Conversation 中。虽然不能完全阻断虚假意见，但至少不会因行号错误导致整个 Review 崩溃。

---

## 13. 模型选型与成本

### Q: 为什么选 DeepSeek V4？暴露 Base URL 的好处是什么？

**选 DeepSeek V4 的原因：**

| 维度 | DeepSeek V4 | GPT-4o | Opus 4.7 |
|------|-------------|--------|----------|
| 单价 | ~$0.14/1M tokens (输入) | ~$2.50/1M tokens | ~$15/1M tokens |
| 代码审查能力 | 足够胜任模式匹配和安全检查 | 略强于 DeepSeek | 最强逻辑推理 |
| API 兼容性 | 完全兼容 OpenAI SDK | 原生 | 需 Anthropic SDK |
| Context Window | 128K | 128K | 200K |

PR review 是高频、自动化场景——每次 push 都可能触发。成本是第一考量。DeepSeek 约是 GPT-4o 的 1/18 价格，每次审查约消耗 0.001-0.005 美元，对于个人开源项目/小团队完全可承受。

**暴露 Base URL 的设计价值：**

```yaml
# action.yml
inputs:
  openai-base-url:
    description: 'Base URL for the OpenAI-compatible API endpoint'
    required: false
    default: 'https://api.deepseek.com'
```

- **不锁定供应商**——用户可以把 URL 指向 Ollama（`http://localhost:11434/v1`）、vLLM、或任何 OpenAI 兼容的代理
- **隐私敏感场景**——公司内网可以部署本地模型，URL 指向内网地址，代码数据不出公司
- **降级灵活性**——DeepSeek 挂掉时可以临时切到其他提供商，改 workflow 变量即可，无需改代码

---

## 14. 痛点反思 — 最大的瓶颈在哪里

### Q: 当前 LLM 做自动化 Code Review，最大的瓶颈是模型能力还是 Diff 解析？

**回答：两个都不是。最大瓶颈是"事实校验"——即验证 LLM 输出是否对应真实的代码问题。**

具体来说：

1. **模型推理能力**其实够用——DeepSeek V4 能稳定识别 SQL 注入、命令注入、硬编码密钥等安全漏洞，这些是模式匹配型任务，模型足够胜任

2. **Diff 解析精度**也不是瓶颈——通过 `buildPositionMap` 映射物理行号到 diff position，行级评论定位精准

3. **真正的瓶颈：LLM 有时会"过度审查"或"捏造问题"**
   - 对 Python 代码说 "第 42 行有一个 TypeScript 类型问题"
   - 把正常的 Python 语法误判为 bug
   - 实际测试中，LLM 对跨语言代码的审查能力参差不齐

**这个瓶颈的根因：** 系统 Prompt 定义了 "你是 TypeScript 审查专家"，但实际审查的文件可能是 Python、Go、Rust。LLM 会尝试用 TS 的思维模式审查非 TS 代码，产生错位判断。

**改进方向：** 在 Prompt 中让 LLM 先识别文件类型，再选择合适的审查规则集——或者更进一步，根据文件扩展名动态切换 Prompt。

---

## 15. 演进方向 — 从"查 Bug"到"自动修复"

### Q: 如果想扩展为"自动生成 Fix PR"，架构怎么改？

**在现有架构上新增一个 `Fixer` 模块，形成新的流水线：**

```
现有：PR diff → Reviewer → 行级评论
扩展：PR diff → Reviewer → Fixer → 自动创建 Fix PR
```

**具体步骤：**

**Step 1 — Prompt 扩展**
在系统 Prompt 中要求 LLM 为每条意见输出一个 `fix` 字段，包含具体的修复代码片段（diff 格式）：

```json
{
  "file": "test_code.py",
  "line": "14",
  "comment": "MD5 已被破解，应使用 bcrypt",
  "fix": "-    return hashlib.md5(password.encode()).hexdigest()\n+    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()"
}
```

**Step 2 — Fix Aggregator（`src/agent/fixer.ts`）**
- 收集所有 `fix` 建议
- 调用 GitHub API `createBlob` 为每个修改文件创建新 blob
- 调用 `createTree` 构建新文件树
- 调用 `createCommit` 创建修复 commit

**Step 3 — Fix PR 发布（`src/tools/github.ts` 新增）**
- 调用 `pulls.create` 以 `bot/fix-pr-{prNumber}` 分支创建新 PR
- PR body 中列出所有修复内容

**Step 4 — 人类确认环节**
- Fix PR 仍然需要人类 review 和 approve
- 不直接 merge——AI 生成的修复代码可能是错的

**需要新增的文件：**
```
src/agent/fixer.ts      ← 修复聚合器
src/tools/github.ts     ← 新增 createFixPR 方法
```

**不需要新增的：** 数据库、消息队列、新的第三方服务。整个扩展在现有 GitHub Actions 架构内完成。

---

## 补充：作为 Python 开发者的跨语言 Vibe Coding 反思

### Q: 不懂 TypeScript，怎么用 Claude 做完这个项目？

**核心策略：把 TypeScript 当作"高级伪代码"。**

- **编译时类型系统 = 免费测试**——TS 的 `strict: true` 在 build 阶段就能捕获 80% 的类型错误，比 Python 的运行时 `TypeError` 早反馈
- **CLAUDE.md = 项目宪法**——用自然语言约束 AI 的行为边界，本质上是把软件架构知识翻译成 AI 能理解的指令集
- **GitHub Actions = 免费 CI**——每次 push 自动在 GitHub 的服务器上跑一遍，不需要本地配环境
- **Dependency 最小化**——3 个外部库，每个都是 GitHub Action 生态的标准件。依赖越少，跨语言的认知负担越轻

**给 Python 开发者的建议：**
"在陌生语言中做 Vibe Coding，关键不是懂语法，而是懂运行时。知道代码会在哪里跑（GitHub Actions runner）、怎么跑（`node dist/index.js`）、失败时怎么报错（Actions 日志）。这三点搞清楚了，语言本身只是工具。"
