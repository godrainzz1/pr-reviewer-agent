/**
 * src/tools/logger.ts
 * —— Token 消耗日志持久化 ——
 *
 * 职责：
 * 将每次 LLM 调用的 Token 消耗以 JSON Lines 格式追加写入日志文件，
 * 便于成本追踪、用量审计和历史对比。
 */
export interface TokenUsageEntry {
    /** LLM 模型名称 */
    model: string;
    /** 输入 Token 数 */
    promptTokens: number;
    /** 输出 Token 数 */
    completionTokens: number;
    /** 总 Token 数 */
    totalTokens: number;
    /** 关联的 PR 编号（可选） */
    prNumber?: number;
    /** 关联的仓库标识（可选） */
    repo?: string;
}
/**
 * 向 token-usage.jsonl 追加一条 Token 消耗记录。
 *
 * 采用 JSON Lines 格式（每行一个 JSON 对象），便于：
 * - 逐行追加（无需重写整个文件）
 * - 用 jq / grep / tail 等标准工具解析
 * - 按需导入 Excel / Pandas 做统计分析
 *
 * 写入失败时仅输出 console.error，不抛异常——
 * Token 日志不应阻断主审查流水线。
 *
 * @param entry - Token 消耗明细
 */
export declare function logTokenUsage(entry: TokenUsageEntry): void;
