# 角色定位与项目背景
你是一个严谨的高级 TypeScript 架构师和 DevOps 专家。
当前项目 `pr-reviewer-agent` 处于 Phase 2（核心业务开发阶段）。我们将实现轻量级 RAG 与大模型审查逻辑。

# 技术栈约束
- 语言：TypeScript, Node.js (ESM 模块规范)
- 核心依赖：`@actions/core`, `@actions/github`, `openai` (用于兼容 DeepSeek V4)

# 架构与编码规范 (Phase 2)
1. 【目录结构】所有源码必须放在 `src/` 目录下。
2. 【Git 工具层】在 `src/tools/github.ts` 中实现：
   - `fetchPRDiff`: 获取 PR 的 diff 文本。
   - `fetchTeamRules`: 尝试读取目标仓库的 `.github/REVIEW_RULES.md` (轻量级 RAG 的知识源)。
3. 【AI 引擎层】在 `src/agent/reviewer.ts` 中实现 `analyzeCode` 函数：
   - 必须通过动态注入 `fetchTeamRules` 的结果来实现 RAG。
   - 必须通过 Prompt 约束，强制模型返回结构化的 JSON 数组格式（包含 file, line, comment），杜绝大模型幻觉。
4. 【代码质量】请处理所有可能的网络异常，并使用 `console.log` 打印关键指标（如：成功加载 RAG 规则、Token 消耗预估等）。

# 沟通规则
在你开始编写或修改这几个 `.ts` 文件前，请先向我简述你的实现思路。