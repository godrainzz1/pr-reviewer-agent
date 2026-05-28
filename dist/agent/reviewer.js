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
import OpenAI from 'openai';
// ---------------------------------------------------------------------------
// 常量配置
// ---------------------------------------------------------------------------
/** DeepSeek API 端点（兼容 OpenAI SDK 的 baseURL 覆盖机制） */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** 默认使用 DeepSeek Chat 模型（V4 系列） */
const DEFAULT_MODEL = 'deepseek-chat';
/** Diff 内容的最大字符数，超出部分将被截断以控制 Token 消耗 */
const MAX_DIFF_LENGTH = 50_000;
/** API 调用最大重试次数（不含首次调用） */
const MAX_RETRIES = 2;
// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
/**
 * 根据文本字符数粗略预估 Token 数量。
 *
 * 估算依据：
 * - 纯英文场景: 1 token ≈ 4 字符 → 系数 0.25
 * - 代码/中英混合场景: 1 token ≈ 2-3 字符 → 系数 0.3-0.5
 * - 这里取偏保守的 0.4，避免对中文/Unicode 场景过度乐观
 *
 * @param text - 待估算的文本
 * @returns 预估的 Token 数量（向上取整）
 */
function estimateTokens(text) {
    return Math.ceil(text.length * 0.4);
}
/**
 * 判断 LLM 调用错误是否值得重试。
 *
 * 可重试的错误类型（瞬时故障）：
 * - 网络层: 超时、连接拒绝、连接重置、网络不可达
 * - 服务端: HTTP 5xx、429 速率限制
 *
 * @param error - 捕获的错误对象
 * @returns 如果可以重试返回 true
 */
function isRetryableError(error) {
    const msg = error.message.toLowerCase();
    return (msg.includes('timeout') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('enetunreach') ||
        msg.includes('503') ||
        msg.includes('502') ||
        msg.includes('504') ||
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('internal server error'));
}
/** 异步等待指定毫秒数（用于失败重试的递增延迟） */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ---------------------------------------------------------------------------
// Prompt 构建 —— 系统提示词（核心：RAG 注入 + JSON 防幻觉约束）
// ---------------------------------------------------------------------------
/**
 * 构建发送给 LLM 的系统级提示词。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【RAG 注入过程详解】
 * ══════════════════════════════════════════════════════════════════════
 *
 * 本函数实现了轻量级 RAG（检索增强生成）的核心「增强」环节：
 *
 *   调用方流程:
 *     1. fetchTeamRules() 从目标仓库拉取 .github/REVIEW_RULES.md
 *     2. 将获取的规则文本传入本函数
 *     3. 本函数将规则作为「团队自定义规范」小节注入系统提示词
 *     4. LLM 同时参考通用最佳实践 + 团队规范生成审查意见
 *
 *   RAG 注入位置: 系统提示词末尾的独立小节
 *   RAG 格式: Markdown 原文直接嵌入（无需 chunk/embedding/向量检索）
 *
 * 这种方案的优势：
 *   - 零基础设施依赖（无需向量数据库或 embedding 服务）
 *   - 团队可以通过修改 REVIEW_RULES.md 实时调整审查偏好
 *   - 失败降级优雅（规则不存在时仍可使用通用规则审查）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【JSON 防幻觉策略详解】
 * ══════════════════════════════════════════════════════════════════════
 *
 * LLM 在生成结构化输出时容易出现以下「幻觉」问题：
 *   1. 输出 JSON 外还附带解释性文字（"以下是审查结果：[...]"）
 *   2. 用 Markdown 代码块包裹 JSON（```json ... ```）
 *   3. 杜撰不存在的文件路径
 *   4. 行号使用范围（"42-45"）或描述（"顶部附近"）
 *   5. comment 字段为模糊的赞美（"看起来不错"）
 *
 * 本 Prompt 中的对抗措施（分层防御）：
 *
 *   【第一层 - Prompt 约束】
 *   - 明确要求「仅返回 JSON 数组，不得包含任何其他文字」
 *   - 明确禁止 Markdown 代码块标记
 *   - 强制 file / line / comment 三个字段的语义约束
 *   - 要求 line 必须是纯数字字符串
 *
 *   【第二层 - 输出解析】（见 analyzeCode 函数）
 *   - 正则剥离可能的 Markdown 代码块包裹
 *   - JSON.parse 严格解析
 *   - 数组类型校验
 *
 *   【第三层 - 字段级校验】（见 analyzeCode 函数末尾）
 *   - 逐条检查 file 是否为非空 string
 *   - line 必须通过 /^\d+$/ 正则（纯数字）
 *   - comment 必须为非空 string
 *   - 不合规条目直接丢弃并记录告警日志
 *
 * ══════════════════════════════════════════════════════════════════════
 *
 * @param rules - 团队审查规则文本（从 fetchTeamRules 获取），可为 null
 * @returns 完整的系统提示词字符串
 */
function buildSystemPrompt(rules) {
    // ─── 第一部分: 通用审查规范（所有审查的基线标准）───
    const basePrompt = `你是一名资深 TypeScript / Node.js 代码审查专家，拥有十年以上的大型项目实战经验。

你的任务是对 GitHub Pull Request 的 unified diff 进行深度审查，输出结构化的审查意见。

## 审查关注维度（按优先级排列）

1. **安全漏洞** — 检查是否存在 OWASP Top 10 风险：
   - 命令注入 (exec/spawn 拼接用户输入)
   - SQL/NoSQL 注入 (字符串拼接查询)
   - XSS (innerHTML / dangerouslySetInnerHTML 不经转义)
   - 敏感信息泄露 (硬编码密钥、Token 输出到日志)
   - 路径遍历 (用户输入直接拼入文件路径)

2. **逻辑错误** — 条件判断遗漏、竞态条件 (async/await 时序)、
   边界值处理（空数组、null/undefined、零值）

3. **TypeScript 类型安全** — any 滥用、危险的 as 断言、
   缺少 null 检查、不正确的类型收窄

4. **性能问题** — 循环中的重复计算、未缓存的昂贵操作、
   N+1 查询模式、大对象的不必要深拷贝

5. **可维护性** — 命名不清晰、函数职责过重（>50 行）、
   魔法数字、重复代码块

## 输出格式（严格遵守 —— 这是防幻觉的第一道防线）

你的整个回复必须仅仅是一个 JSON 数组，不要包含:
- 任何开头的解释性文字（如 "以下是审查结果："）
- 任何结尾的总结或礼貌用语
- Markdown 代码块包裹标记（如 \`\`\`json 或 \`\`\`）

数组中每个元素的 schema 如下：
{
  "file": "触发问题的文件路径（从 diff 的 ---/+++ 中提取，相对于仓库根目录）",
  "line": "问题所在行号（纯阿拉伯数字字符串，如 "42"；不确定具体行号时标注函数/块的起始行）",
  "comment": "具体的问题描述 + 可操作的修复建议（引用具体变量名/函数名，给出示例代码片段）"
}

### 输出约束（违反任一条的条目将被自动丢弃）
1. file 必须非空，且必须在 diff 中真实出现。
2. line 必须是纯数字的正则 /^\\d+$/ —— 不接受范围（"42-45"）、
   不接受 "L42"、不接受 "第 42 行" 等任何非纯数字格式。
3. comment 必须具体、可操作，包含:
   - 问题性质（bug / 安全 / 性能 / 风格）
   - 触发条件的简要描述
   - 推荐的修复方案（优先给出代码片段）
4. 如果经过仔细审查后认为代码质量良好、无实质性问题，返回空数组 []。`;
    // ─── 第二部分: RAG 注入 —— 将团队规范追加到系统提示词末尾 ───
    // 这是轻量级 RAG 的核心步骤：
    // 从外部知识源（.github/REVIEW_RULES.md）检索到的规则作为上下文扩展
    // 注入到 Prompt 中，让模型在审查时同时遵守通用规范和团队约定。
    if (rules) {
        const ragSection = [
            '',
            '---',
            '',
            '## ⚡ 团队自定义审查规范（RAG 检索增强）',
            '',
            '以下规则来自目标仓库的 `.github/REVIEW_RULES.md`，由项目团队维护。',
            '请在审查时同样严格遵守这些团队级别的编码约定和架构决策：',
            '',
            rules,
        ].join('\n');
        console.log(`[buildSystemPrompt] ✅ RAG 规则已注入系统提示词（源自目标仓库 .github/REVIEW_RULES.md，长度: ${rules.length} 字符）`);
        return basePrompt + ragSection;
    }
    console.log('[buildSystemPrompt] ℹ️  未检测到团队规则，系统提示词仅包含通用审查规范（无 RAG 增强）');
    return basePrompt;
}
/**
 * 构建用户级提示词 —— 携带待审查的 diff 内容。
 *
 * 如果 diff 超过预设最大长度（MAX_DIFF_LENGTH），对内容进行截断处理：
 * - 保留前半部分（通常包含最重要的核心变更）
 * - 追加截断提示，引导模型优先关注前半部分
 *
 * @param diff - PR 的 unified diff 文本
 * @returns 用户提示词字符串
 */
function buildUserPrompt(diff) {
    const truncated = diff.length > MAX_DIFF_LENGTH;
    if (truncated) {
        console.warn(`[buildUserPrompt] ⚠️  diff 长度 (${diff.length} 字符) 超过 ${MAX_DIFF_LENGTH} 限制，将被截断处理`);
    }
    const diffContent = truncated
        ? diff.slice(0, MAX_DIFF_LENGTH) +
            '\n\n[... diff 已被截断，请优先审查前半部分的逻辑变更和安全问题 ...]'
        : diff;
    return [
        '以下是本次 Pull Request 的代码变更（unified diff 格式）：',
        '',
        diffContent,
        '',
        '请严格按照系统提示词中的 JSON 数组格式返回你的审查结果。',
    ].join('\n');
}
// ---------------------------------------------------------------------------
// JSON 清洗与校验 —— 防幻觉的第二 & 第三道防线
// ---------------------------------------------------------------------------
/**
 * 对 LLM 返回的原始文本进行清洗、解析和字段级校验。
 *
 * ── 分层防御流程 ──
 *
 *   原始文本 (LLM 返回)
 *     │
 *     ▼
 *   【第二层】清洗 & JSON 解析
 *     ├── 剥离可能的 Markdown 代码块标记（```json ... ```）
 *     ├── 尝试 JSON.parse
 *     ├── 若失败 → 正则提取 JSON 数组片段再试
 *     └── 仍然失败 → 抛出异常
 *     │
 *     ▼
 *   【第三层】字段级逐条校验
 *     ├── 必须是数组
 *     ├── 每项必须是 object
 *     ├── file: 非空 string
 *     ├── line: string 且通过 /^\d+$/ 正则
 *     ├── comment: 非空 string
 *     └── 不合规条目 → 丢弃 + console.warn
 *     │
 *     ▼
 *   返回干净的 ReviewComment[]
 *
 * @param rawContent - LLM 的原始响应文本
 * @returns 通过全部校验的审查意见数组
 * @throws 当无法从响应中提取有效 JSON 数组时
 */
function parseAndValidateResponse(rawContent) {
    let jsonStr = rawContent;
    // ─── 第二层 Step 1: 剥离 Markdown 代码块标记 ───
    // 即使 Prompt 明确禁止使用 ```json```，部分模型仍可能添加。
    // 使用正则提取代码块内的内容，作为第一道清洗。
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
        console.log('[parseAndValidateResponse] 检测到 Markdown 代码块包裹，已自动剥离（模型未完全遵守格式约束）');
    }
    // ─── 第二层 Step 2: JSON.parse ───
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    }
    catch (firstError) {
        // 直接解析失败时，尝试从文本中提取 JSON 数组片段（容错处理）
        console.warn(`[parseAndValidateResponse] 首次 JSON.parse 失败: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
        console.warn('[parseAndValidateResponse] 尝试从输出中正则提取 JSON 数组片段...');
        const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
        if (!arrayMatch) {
            throw new Error(`无法从 LLM 输出中提取有效的 JSON 数组。原始输出前 500 字符: ${rawContent.slice(0, 500)}`);
        }
        try {
            parsed = JSON.parse(arrayMatch[0]);
            console.log('[parseAndValidateResponse] ✅ 从文本中成功提取 JSON 数组');
        }
        catch (secondError) {
            throw new Error(`JSON 数组片段解析仍然失败: ${secondError instanceof Error ? secondError.message : String(secondError)}。` +
                `数组片段前 200 字符: ${arrayMatch[0].slice(0, 200)}`);
        }
    }
    // ─── 第二层 Step 3: 根类型校验（必须是数组）───
    if (!Array.isArray(parsed)) {
        throw new Error(`LLM 返回的 JSON 根类型不是数组，而是 "${typeof parsed}"。` +
            `这是明显的幻觉输出，缺乏有效的结构化数据。` +
            `原始内容: ${rawContent.slice(0, 300)}`);
    }
    // ─── 第三层: 逐条字段级校验与过滤 ───
    const validComments = [];
    const skippedItems = [];
    for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        // 基础类型检查：必须是非 null 对象，排除数组、基本类型
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            skippedItems.push(`[${i}] 类型异常: ${JSON.stringify(item)}`);
            continue;
        }
        const record = item;
        const file = record.file;
        const line = record.line;
        const comment = record.comment;
        // ── 字段级严格校验 ──
        // 每个字段都必须存在、类型正确、内容非空
        const fileValid = typeof file === 'string' && file.trim().length > 0;
        const lineValid = typeof line === 'string' &&
            /^\d+$/.test(line); // 正则: 仅纯阿拉伯数字
        const commentValid = typeof comment === 'string' && comment.trim().length > 0;
        if (fileValid && lineValid && commentValid) {
            validComments.push({
                file: file.trim(),
                line, // 保留原始数字字符串，不做类型转换
                comment: comment.trim(),
            });
        }
        else {
            // 记录具体哪一项不满足要求，方便排查模型行为
            const failures = [];
            if (!fileValid)
                failures.push(`file 无效: ${JSON.stringify(file)}`);
            if (!lineValid)
                failures.push(`line 非纯数字: ${JSON.stringify(line)}`);
            if (!commentValid)
                failures.push(`comment 无效: ${JSON.stringify(comment)}`);
            skippedItems.push(`[${i}] ${failures.join('; ')}`);
        }
    }
    // 输出字段级过滤的统计信息
    if (skippedItems.length > 0) {
        console.warn(`[parseAndValidateResponse] ⚠️  从 ${parsed.length} 条原始输出中过滤掉 ${skippedItems.length} 条不合规条目:`);
        skippedItems.forEach((s) => console.warn(`  - ${s}`));
    }
    console.log(`[parseAndValidateResponse] 🎯 JSON 防幻觉校验完成: ${parsed.length} 条输入 → ${validComments.length} 条通过`);
    return validComments;
}
// ---------------------------------------------------------------------------
// 核心导出函数: analyzeCode
// ---------------------------------------------------------------------------
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
export async function analyzeCode(diff, teamRules, apiKey, model = DEFAULT_MODEL) {
    // ─── 1. 前置校验 ───
    if (!diff || diff.trim().length === 0) {
        console.warn('[analyzeCode] diff 为空，跳过 LLM 审查调用');
        return { comments: [] };
    }
    if (!apiKey || apiKey.trim().length === 0) {
        throw new Error('[analyzeCode] API Key 未提供或为空，无法调用 DeepSeek API。请检查环境变量配置。');
    }
    // ─── 2. 构建 Prompt（含 RAG 注入）───
    const systemPrompt = buildSystemPrompt(teamRules);
    const userPrompt = buildUserPrompt(diff);
    // ─── 3. Token 消耗预估 ───
    const estimatedSystem = estimateTokens(systemPrompt);
    const estimatedUser = estimateTokens(userPrompt);
    const estimatedTotal = estimatedSystem + estimatedUser;
    console.log(`[analyzeCode] 📊 Token 消耗预估:`);
    console.log(`  - 系统提示词: ~${estimatedSystem} tokens (${systemPrompt.length} 字符)`);
    console.log(`  - 用户提示词: ~${estimatedUser} tokens (${userPrompt.length} 字符)`);
    console.log(`  - 预估合计:   ~${estimatedTotal} tokens`);
    // ─── 4. 初始化 OpenAI 客户端（指向 DeepSeek API）───
    // DeepSeek 的 API 与 OpenAI SDK 完全兼容，只需修改 baseURL 即可。
    const client = new OpenAI({
        apiKey,
        baseURL: DEEPSEEK_BASE_URL,
    });
    // ─── 5. 构建消息 ───
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
    // ─── 6. 调用 LLM（带重试逻辑）───
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`[analyzeCode] 🚀 正在调用 ${model} API（第 ${attempt + 1}/${MAX_RETRIES + 1} 次尝试）...`);
            const completion = await client.chat.completions.create({
                model,
                messages,
                temperature: 0.1, // 低温度: 提高输出确定性，减少随机幻觉
                max_tokens: 4096,
            });
            const rawContent = completion.choices[0]?.message?.content?.trim() ?? '';
            console.log(`[analyzeCode] ✅ LLM 响应成功，原始输出长度: ${rawContent.length} 字符`);
            console.log(`[analyzeCode] 实际 Token 用量 — prompt: ${completion.usage?.prompt_tokens ?? 'N/A'}, completion: ${completion.usage?.completion_tokens ?? 'N/A'}, total: ${completion.usage?.total_tokens ?? 'N/A'}`);
            // ─── 7. JSON 防幻觉校验（第二层 + 第三层防线）───
            const validComments = parseAndValidateResponse(rawContent);
            return {
                comments: validComments,
                usage: completion.usage
                    ? {
                        promptTokens: completion.usage.prompt_tokens,
                        completionTokens: completion.usage.completion_tokens,
                        totalTokens: completion.usage.total_tokens,
                    }
                    : undefined,
            };
        }
        catch (error) {
            lastError =
                error instanceof Error ? error : new Error(String(error));
            console.error(`[analyzeCode] ❌ 第 ${attempt + 1} 次 API 调用失败: ${lastError.message}`);
            // 判断是否需要重试
            if (attempt < MAX_RETRIES && isRetryableError(lastError)) {
                const waitMs = (attempt + 1) * 1000; // 递增延迟: 1s, 2s
                console.log(`[analyzeCode] ⏳ 检测到可重试错误，${waitMs}ms 后进行第 ${attempt + 2} 次尝试...`);
                await sleep(waitMs);
                continue;
            }
            // 不可重试的错误直接跳出
            break;
        }
    }
    // ─── 8. 所有重试均失败 ───
    throw new Error(`[analyzeCode] LLM 调用在 ${MAX_RETRIES + 1} 次尝试后仍然失败。` +
        `最后错误: ${lastError?.message ?? '未知错误'}`);
}
//# sourceMappingURL=reviewer.js.map