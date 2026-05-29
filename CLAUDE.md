# 角色定位与项目背景
你是一个严谨的高级 TypeScript 架构师和 DevOps 专家。
当前项目 `pr-reviewer-agent` 处于 Phase 4（工程健壮性增强阶段）。Phase 3 已完成基础闭环，Phase 4 聚焦于将 MVP 提升为生产级质量。

# 技术栈约束
- 语言：TypeScript, Node.js (ESM)
- 核心打包工具：`@vercel/ncc` (用于将多文件编译为单文件供 GitHub Action 运行)
- 零新增依赖：所有新功能使用 Node.js 内置模块或已有依赖实现

# 架构与编码规范 (Phase 4)

## 1. 【Diff 解析引擎】新增 `src/tools/diff-parser.ts`
a. 解析 unified diff 格式，提取所有被修改的文件路径（从 `---/+++` 行）。
b. 解析每个文件的 hunk header（`@@ -old,count +new,count @@`），确定新增侧起始物理行号。
c. 对每个 hunk 逐行遍历，构建 `物理行号 → diff position` 映射表（position 从 hunk header 起算）。
d. 返回结构化数据：`ParsedDiff { files: Map<filePath, FileHunk[]> }`，供 reviewer 校验和 github 发布使用。
e. 排除纯配置文件和不需审查的文件（如 `*.json`、`*.lock`、`*.yml`、`*.yaml`、`*.md`、`dist/*`），仅对代码文件进行审查。

## 2. 【文件感知截断】改造 `reviewer.ts` 的 diff 处理
a. 废弃 `MAX_DIFF_LENGTH = 50_000` 的简单头截断策略。
b. 调用 diff-parser 解析 diff，按文件拆分。
c. 过滤策略：排除配置文件（`*.json`、`*.lock`、`*.yml`、`*.yaml`、`*.md`）和构建产物（`dist/*`）。
d. 优先级排序：先审查核心逻辑文件（`.ts`、`.js` 源码），再审查其他文件。
e. Token 预算控制：按文件估算 Token，确保总输入不超过模型上限（目标 ~100K tokens）。超出的文件追加截断提示。
f. 每个文件的 diff 块带上文件名标注，帮助 LLM 定位。

## 3. 【行号真实性校验】强化 `reviewer.ts` 的第三层防线
a. 在 `parseAndValidateResponse` 中新增参数 `parsedDiff: ParsedDiff`。
b. 校验 LLM 输出的 `file` 字段是否在 diff 解析结果中真实存在。
c. 校验 LLM 输出的 `line` 是否在对应文件的 hunk 中有新增行（以 `+` 开头的行）。
d. 不合规条目 → 降级为 General Comment（仅文件名，不绑定行号），而非直接丢弃。
e. 完全捏造的文件路径 → 丢弃该条目。

## 4. 【Inline Review Comment + diff position 映射】改造 `github.ts`
a. 废弃 `issues.createComment`（通用评论），改用 `pulls.createReview` 发布行级 Review。
b. 实现 `mapLineToDiffPosition(filePath, physicalLine, parsedDiff)` 函数，将 LLM 输出的物理行号映射为 diff position。
c. 发布时：有效 position 的条目 → 行级 inline comment；无效 position 的条目 → review body 中的通用评论。
d. Review event 使用 `COMMENT`（不强制 APPROVE/REQUEST_CHANGES）。

## 5. 【指数退避重试】为 GitHub API 调用添加重试
a. 在 `github.ts` 的所有 API 调用（fetchPRDiff、fetchTeamRules、createReviewComment）中添加指数退避重试。
b. 策略：初始延迟 1s，指数增长（1s → 2s → 4s → 8s），最多 4 次重试。
c. 只重试可恢复错误：429（Rate Limit）、5xx、网络超时/拒绝。
d. 429 错误额外读取 `Retry-After` 响应头并遵守其等待时间。
e. 不可恢复错误（401、403 非限流、404 非 RAG）不重试，直接抛出。

## 6. 【重复评论防护】防止同一 PR 多次触发产生冗余评论
a. 在发布新 Review 前，查询该 PR 是否已有本 Bot 发布的历史 Review。
b. Bot 标识：通过 Review body 中的 `<!-- pr-reviewer-agent-bot -->` HTML 注释标记。
c. 如果存在旧的 Bot Review 且状态为 "未提交"（PENDING），则先删除旧 Review 的评论。
d. 然后发布新 Review。

## 7. 【并发控制】在 workflow 中显式声明
a. 在 `.github/workflows/test-agent.yml` 中添加 `concurrency` 配置。
b. `group: pr-review-${{ github.event.pull_request.number }}`。
c. `cancel-in-progress: true`。

# 沟通规则
执行前请务必确认你理解了整体的流水线（Pipeline）闭环逻辑，并在终端告诉我你要修改哪些文件。
修改完成后运行 `npm run build` 确保编译通过，然后 `git add` 并 `git commit`。
