/**
 * src/agent/reviewer.ts
 * ── AI 引擎层 ──
 *
 * 职责：
 * 1. 构建系统提示词（集成 RAG 注入 + JSON 防幻觉约束）
 * 2. 调用 DeepSeek V4（兼容 OpenAI SDK）执行智能代码审查
 * 3. 对 LLM 输出进行严格的 JSON schema 校验与清洗
 *
 * 核心设计：
 * - RAG（检索增强生成）: 将团队审查规则作为系统提示词扩展注入
 * - JSON 防幻觉策略: Prompt 约束 + 多层级解析 + 字段级校验 + 不合规过滤
 */
/**
 * 单条审查意见 —— 严格对应 LLM Prompt 中要求的 JSON 输出结构。
 *
 * 每个字段都是必填的 string 类型，防止模型返回 null / 缺失字段 / 错误类型。
 * - file: 必须从 diff 的 ---/+++ 行中提取真实路径，杜绝杜撰
 * - line: 必须是纯阿拉伯数字字符串（如 "42"），不接受范围或描述
 * - comment: 必须包含可操作的具体建议，不接受笼统评价
 */
export interface ReviewComment {
    /** 触发问题的文件路径（相对于仓库根目录） */
    file: string;
    /** 问题所在行号，纯数字字符串，如 "42" */
    line: string;
    /** 具体审查意见与修复建议 */
    comment: string;
}
/** analyzeCode 函数的聚合返回结果 */
export interface AnalysisResult {
    /** 有效的审查意见列表（已通过 schema 校验） */
    comments: ReviewComment[];
    /** 模型返回的 Token 实际用量（来自 API response 的 usage 字段） */
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}
/**
 * 使用大模型对 PR diff 进行智能代码审查。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 完整调用流程（含 RAG 注入和 JSON 防幻觉的全链路）
 * ══════════════════════════════════════════════════════════════════════
 *
 *   输入:
 *     diff ───────────────┐
 *     teamRules ──────────┤
 *     apiKey ─────────────┤
 *                          ▼
 *     ┌────────────────────────────────────────┐
 *     │ 1. 参数校验 / Token 预估 / 日志输出     │
 *     └────────────────────────────────────────┘
 *                          │
 *                          ▼
 *     ┌────────────────────────────────────────┐
 *     │ 2. buildSystemPrompt(teamRules)        │
 *     │    ├── 通用审查规范                     │
 *     │    └── RAG 注入: 团队规范 → 系统提示词  │
 *     └────────────────────────────────────────┘
 *                          │
 *                          ▼
 *     ┌────────────────────────────────────────┐
 *     │ 3. buildUserPrompt(diff)               │
 *     │    └── diff 内容 → 用户提示词           │
 *     └────────────────────────────────────────┘
 *                          │
 *                          ▼
 *     ┌────────────────────────────────────────┐
 *     │ 4. OpenAI SDK → DeepSeek V4 API       │
 *     │    ├── temperature=0.1 (低温度抗幻觉)   │
 *     │    ├── max_tokens=4096                 │
 *     │    └── 失败自动重试 (最多 2 次)         │
 *     └────────────────────────────────────────┘
 *                          │
 *                          ▼
 *     ┌────────────────────────────────────────┐
 *     │ 5. parseAndValidateResponse()          │
 *     │    ├── 第二层: 清洗 + JSON.parse       │
 *     │    └── 第三层: 逐条字段校验 & 过滤      │
 *     └────────────────────────────────────────┘
 *                          │
 *                          ▼
 *     ┌────────────────────────────────────────┐
 *     │ 6. 返回 AnalysisResult { comments,     │
 *     │                         usage }         │
 *     └────────────────────────────────────────┘
 *
 * ══════════════════════════════════════════════════════════════════════
 *
 * @param diff      - 从 fetchPRDiff() 获取的 PR unified diff 文本
 * @param teamRules - 从 fetchTeamRules() 获取的团队审查规则（可为 null）
 * @param apiKey    - DeepSeek API Key（通过环境变量传入，不硬编码）
 * @param model     - 可选模型名，默认 "deepseek-chat"（DeepSeek V4）
 * @returns 结构化审查结果，包含通过校验的审查意见列表和 Token 用量
 * @throws 当 LLM 调用经全部重试后仍失败时
 */
export declare function analyzeCode(diff: string, teamRules: string | null, apiKey: string, model?: string, baseUrl?: string): Promise<AnalysisResult>;
