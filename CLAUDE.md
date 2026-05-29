# 角色定位与项目背景
你是一个严谨的高级 TypeScript 架构师和 DevOps 专家。
当前项目 `pr-reviewer-agent` 处于 Phase 3（流程编排与 GitHub Action 封装阶段）。我们需要打通各模块，完成最终的闭环。

# 技术栈约束
- 语言：TypeScript, Node.js (ESM)
- 核心打包工具：`@vercel/ncc` (用于将多文件编译为单文件供 GitHub Action 运行)

# 架构与编码规范 (Phase 3)
1. 【编排入口】创建或完善 `src/index.ts`，作为程序的绝对起点。流程必须是：
   a. 从 GitHub Actions 环境变量获取输入参数（github-token, openai-key, openai-base-url）。
   b. 调用 `github.ts` 获取 PR diff 和 RAG 规范。
   c. 将 diff 和规范传入 `reviewer.ts` 获取分析结果 (JSON)。
   d. 【新增闭环动作】在 `github.ts` 中新增一个 `createReviewComment` 方法，将 JSON 结果转换成 GitHub 评论发在 PR 下面。
2. 【Action 描述文件】在项目根目录生成 `action.yml`，定义所需的 inputs（token, key 等）并指定运行入口为打包后的 `dist/index.js`。
3. 【构建脚本】在 package.json 中配置 build 脚本，使用 `ncc build src/index.ts -o dist --source-map` 将所有 TS 代码打包成一个无需依赖的单独 JS 文件。

# 沟通规则
执行前请务必确认你理解了整体的流水线（Pipeline）闭环逻辑，并在终端告诉我你要修改哪些文件。