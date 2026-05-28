/**
 * src/index.ts
 * ── 流程编排入口 ──
 *
 * 职责：
 * 作为 GitHub Action 的绝对起点，串联整个审查流水线：
 *   输入参数 → 获取 PR diff → 加载 RAG 规则 → AI 审查 → 发布评论
 *
 * 这是 Phase 3 的核心交付物，将 Phase 1-2 的各模块打通为完整闭环。
 */
export {};
