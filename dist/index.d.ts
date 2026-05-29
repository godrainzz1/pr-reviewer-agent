/**
 * src/index.ts
 * ── 流程编排入口 ──
 *
 * 职责：
 * 作为 GitHub Action 的绝对起点，串联整个审查流水线：
 *   输入参数 → 获取 PR diff → 解析 diff → 加载 RAG 规则 → AI 审查 → 发布行级 Review
 *
 * Phase 4 增强：
 * - 引入 diff-parser 实现文件感知截断 + 行号校验
 * - 使用 createPRReview 替代通用评论，支持行级 inline comment
 */
export {};
