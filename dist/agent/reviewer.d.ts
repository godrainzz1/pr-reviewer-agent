/**
 * src/agent/reviewer.ts
 * ── AI 引擎层 ──
 *
 * 职责：
 * 1. 构建系统提示词（集成 RAG 注入 + JSON 防幻觉约束）
 * 2. 文件感知的 diff 截断与优先级排序
 * 3. 调用 DeepSeek V4（兼容 OpenAI SDK）执行智能代码审查
 * 4. 对 LLM 输出进行严格的 JSON schema 校验 + diff 行号真实性验证
 *
 * Phase 4 增强：
 * - 文件感知截断：按代码文件优先，排除配置文件，Token 预算控制
 * - 行号真实性校验：LLM 输出必须存在于 parsedDiff 中
 */
import type { ParsedDiff } from '../tools/diff-parser.js';
/** 单条审查意见 */
export interface ReviewComment {
    file: string;
    line: string;
    comment: string;
    /** diff position（1-based），null 表示降级为通用评论 */
    position?: number;
}
export interface AnalysisResult {
    comments: ReviewComment[];
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}
export declare function analyzeCode(diff: string, teamRules: string | null, apiKey: string, parsedDiff: ParsedDiff, model?: string, baseUrl?: string): Promise<AnalysisResult>;
