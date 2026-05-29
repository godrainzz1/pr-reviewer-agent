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

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { logTokenUsage } from '../tools/logger.js';
import type { ParsedDiff } from '../tools/diff-parser.js';
import { validateLocation, mapLineToPosition } from '../tools/diff-parser.js';

// ---------------------------------------------------------------------------
// 导出类型定义
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 常量配置
// ---------------------------------------------------------------------------

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

/** 最大 Token 预算（prompt 部分），DeepSeek V4 128K context，留 28K 给输出 */
const MAX_PROMPT_TOKENS = 90_000;

/** API 调用最大重试次数 */
const MAX_RETRIES = 2;

/** 审查优先级：先审查源码文件 */
const PRIORITY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.4);
}

function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enetunreach') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('internal server error')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Prompt 构建
// ---------------------------------------------------------------------------

function buildSystemPrompt(rules: string | null): string {
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

    console.log(
      `[buildSystemPrompt] ✅ RAG 规则已注入系统提示词（源自目标仓库 .github/REVIEW_RULES.md，长度: ${rules.length} 字符）`,
    );
    return basePrompt + ragSection;
  }

  console.log(
    '[buildSystemPrompt] ℹ️  未检测到团队规则，系统提示词仅包含通用审查规范（无 RAG 增强）',
  );
  return basePrompt;
}

/**
 * 构建文件感知的用户提示词。
 *
 * 从 parsedDiff 提取代码文件，按优先级排列，在 Token 预算内构造 Prompt。
 *
 * @param rawDiff    - 原始 unified diff 文本
 * @param parsedDiff - diff 解析结果
 * @returns 用户提示词字符串
 */
function buildUserPrompt(rawDiff: string, parsedDiff: ParsedDiff): string {
  const fileSections = splitDiffByFile(rawDiff);

  // 分离优先级文件和普通文件
  const priority: string[] = [];
  const normal: string[] = [];

  for (const [path, content] of fileSections) {
    if (!parsedDiff.files.has(path)) continue; // 跳过被过滤的文件
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (PRIORITY_EXTENSIONS.includes(ext)) {
      priority.push(content);
    } else {
      normal.push(content);
    }
  }

  const orderedSections = [...priority, ...normal];
  const totalFiles = orderedSections.length;

  if (totalFiles === 0) {
    console.warn('[buildUserPrompt] ⚠️  无代码文件需要审查');
    return '本次 PR 仅包含配置文件变更，无可审查的源代码文件。';
  }

  // Token 预算控制：从头累积文件，超出则截断
  const prefix = `以下是本次 PR 的代码变更（共 ${parsedDiff.files.size} 个代码文件，此处展示 ${totalFiles} 个）：\n\n`;
  let body = prefix;
  let budget = MAX_PROMPT_TOKENS - estimateTokens(prefix);
  let included = 0;
  let truncated = false;

  for (const section of orderedSections) {
    const sectionTokens = estimateTokens(section);
    if (budget - sectionTokens < 0) {
      truncated = true;
      break;
    }
    body += section;
    budget -= sectionTokens;
    included++;
  }

  if (truncated && included < totalFiles) {
    body += `\n\n[... Token 预算限制，省略 ${totalFiles - included} 个文件。以上 ${included} 个文件为按优先级排列的源码文件 ...]\n`;
  }

  console.log(
    `[buildUserPrompt] 📊 文件感知 Prompt: ${included}/${totalFiles} 个文件，预估 ~${estimateTokens(body)} tokens`,
  );

  return body + '\n请严格按照系统提示词中的 JSON 数组格式返回你的审查结果。';
}

/**
 * 将 raw diff 按文件切分为 (filePath, fileSection) 对。
 */
function splitDiffByFile(rawDiff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = rawDiff.split('\n');

  let currentPath: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    // 检测文件头：diff --git a/... b/...
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      if (currentPath && currentLines.length > 0) {
        sections.set(currentPath, currentLines.join('\n'));
      }
      currentPath = fileMatch[2];
      currentLines = [line];
      continue;
    }

    if (currentPath) {
      currentLines.push(line);
    }
  }

  // 最后一个文件
  if (currentPath && currentLines.length > 0) {
    sections.set(currentPath, currentLines.join('\n'));
  }

  return sections;
}

// ---------------------------------------------------------------------------
// JSON 清洗与校验 —— 防幻觉的第二 & 第三道防线
// ---------------------------------------------------------------------------

/**
 * 对 LLM 返回的原始文本进行清洗、解析和字段级校验。
 *
 * Phase 4 新增：对验证通过的条目，通过 parsedDiff 验证 file + line 的真实性。
 * - 'valid' → 保留并附带 diff position（用于 inline comment）
 * - 'file_only' → 保留但 position=null（降级为 review body 通用评论）
 * - 'invalid' → 丢弃
 *
 * @param rawContent - LLM 的原始响应文本
 * @param parsedDiff - diff 解析结果，用于行号真实性校验
 * @returns 通过校验的审查意见数组
 */
function parseAndValidateResponse(
  rawContent: string,
  parsedDiff: ParsedDiff,
): ReviewComment[] {
  let jsonStr = rawContent;

  // ─── 第二层 Step 1: 剥离 Markdown 代码块标记 ───
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
    console.log(
      '[parseAndValidateResponse] 检测到 Markdown 代码块包裹，已自动剥离',
    );
  }

  // ─── 第二层 Step 2: JSON.parse ───
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (firstError) {
    console.warn(
      `[parseAndValidateResponse] 首次 JSON.parse 失败: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
    );
    console.warn(
      '[parseAndValidateResponse] 尝试从输出中正则提取 JSON 数组片段...',
    );

    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      throw new Error(
        `无法从 LLM 输出中提取有效的 JSON 数组。原始输出前 500 字符: ${rawContent.slice(0, 500)}`,
      );
    }

    try {
      parsed = JSON.parse(arrayMatch[0]);
      console.log('[parseAndValidateResponse] ✅ 从文本中成功提取 JSON 数组');
    } catch (secondError) {
      throw new Error(
        `JSON 数组片段解析仍然失败: ${secondError instanceof Error ? secondError.message : String(secondError)}。` +
          `数组片段前 200 字符: ${arrayMatch[0].slice(0, 200)}`,
      );
    }
  }

  // ─── 第二层 Step 3: 根类型校验 ───
  if (!Array.isArray(parsed)) {
    throw new Error(
      `LLM 返回的 JSON 根类型不是数组。原始内容: ${rawContent.slice(0, 300)}`,
    );
  }

  // ─── 第三层: 逐条字段级校验 + diff 行号真实性验证 ───
  const validComments: ReviewComment[] = [];
  const skippedItems: string[] = [];
  let discardedCount = 0;
  let generalCount = 0;

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skippedItems.push(`[${i}] 类型异常: ${JSON.stringify(item)}`);
      continue;
    }

    const record = item as Record<string, unknown>;
    const file = record.file;
    const line = record.line;
    const comment = record.comment;

    const fileValid = typeof file === 'string' && file.trim().length > 0;
    const lineValid = typeof line === 'string' && /^\d+$/.test(line);
    const commentValid = typeof comment === 'string' && comment.trim().length > 0;

    if (!fileValid || !lineValid || !commentValid) {
      const failures: string[] = [];
      if (!fileValid) failures.push(`file 无效: ${JSON.stringify(file)}`);
      if (!lineValid) failures.push(`line 非纯数字: ${JSON.stringify(line)}`);
      if (!commentValid) failures.push(`comment 无效: ${JSON.stringify(comment)}`);
      skippedItems.push(`[${i}] ${failures.join('; ')}`);
      continue;
    }

    const cleanFile = (file as string).trim();
    const cleanLine = line as string;
    const cleanComment = (comment as string).trim();

    // ── Phase 4: diff 行号真实性校验 ──
    const locationStatus = validateLocation(parsedDiff, cleanFile, cleanLine);

    if (locationStatus === 'invalid') {
      // 文件不存在于 diff 中 → 丢弃
      skippedItems.push(
        `[${i}] 文件不存在于 diff: ${cleanFile} (LLM 幻觉)`,
      );
      discardedCount++;
      continue;
    }

    const position = mapLineToPosition(
      parsedDiff,
      cleanFile,
      parseInt(cleanLine, 10),
    );

    if (locationStatus === 'file_only') {
      // 文件存在但行号不是新增行 → 降级为通用评论
      validComments.push({
        file: cleanFile,
        line: cleanLine,
        comment: cleanComment,
        // position 为 null/undefined，github.ts 会将其作为 body 评论
      });
      generalCount++;
    } else {
      // 有效行号 → inline comment
      validComments.push({
        file: cleanFile,
        line: cleanLine,
        comment: cleanComment,
        position: position ?? undefined,
      });
    }
  }

  if (skippedItems.length > 0) {
    console.warn(
      `[parseAndValidateResponse] ⚠️  过滤 ${skippedItems.length} 条: ${discardedCount} 丢弃 + ${generalCount} 降级为通用`,
    );
    skippedItems.forEach((s) => console.warn(`  - ${s}`));
  }

  console.log(
    `[parseAndValidateResponse] 🎯 校验完成: ${parsed.length} 条输入 → ${validComments.length} 条通过 (${validComments.filter((c) => c.position).length} inline + ${generalCount} general)`,
  );

  return validComments;
}

// ---------------------------------------------------------------------------
// 核心导出函数: analyzeCode
// ---------------------------------------------------------------------------

export async function analyzeCode(
  diff: string,
  teamRules: string | null,
  apiKey: string,
  parsedDiff: ParsedDiff,
  model: string = DEFAULT_MODEL,
  baseUrl: string = DEEPSEEK_BASE_URL,
): Promise<AnalysisResult> {
  if (!diff || diff.trim().length === 0) {
    console.warn('[analyzeCode] diff 为空，跳过 LLM 审查调用');
    return { comments: [] };
  }

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      '[analyzeCode] API Key 未提供或为空，无法调用 DeepSeek API。请检查环境变量配置。',
    );
  }

  if (parsedDiff.files.size === 0) {
    console.log('[analyzeCode] 无代码文件需要审查（仅包含配置文件变更）');
    return { comments: [] };
  }

  const systemPrompt = buildSystemPrompt(teamRules);
  const userPrompt = buildUserPrompt(diff, parsedDiff);

  const estimatedSystem = estimateTokens(systemPrompt);
  const estimatedUser = estimateTokens(userPrompt);

  console.log('[analyzeCode] 📊 Token 消耗预估:');
  console.log(`  - 系统提示词: ~${estimatedSystem} tokens`);
  console.log(`  - 用户提示词: ~${estimatedUser} tokens`);
  console.log(`  - 预估合计:   ~${estimatedSystem + estimatedUser} tokens`);

  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[analyzeCode] 🚀 正在调用 ${model} API（第 ${attempt + 1}/${MAX_RETRIES + 1} 次尝试）...`,
      );

      const completion = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 4096,
      });

      const rawContent = completion.choices[0]?.message?.content?.trim() ?? '';

      console.log(
        `[analyzeCode] ✅ LLM 响应成功，原始输出长度: ${rawContent.length} 字符`,
      );
      console.log(
        `[analyzeCode] 实际 Token 用量 — prompt: ${completion.usage?.prompt_tokens ?? 'N/A'}, completion: ${completion.usage?.completion_tokens ?? 'N/A'}, total: ${completion.usage?.total_tokens ?? 'N/A'}`,
      );

      if (completion.usage) {
        logTokenUsage({
          model,
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        });
      }

      const validComments = parseAndValidateResponse(rawContent, parsedDiff);

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
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `[analyzeCode] ❌ 第 ${attempt + 1} 次 API 调用失败: ${lastError.message}`,
      );

      if (attempt < MAX_RETRIES && isRetryableError(lastError)) {
        const waitMs = (attempt + 1) * 1000;
        console.log(
          `[analyzeCode] ⏳ 检测到可重试错误，${waitMs}ms 后进行第 ${attempt + 2} 次尝试...`,
        );
        await sleep(waitMs);
        continue;
      }

      break;
    }
  }

  throw new Error(
    `[analyzeCode] LLM 调用在 ${MAX_RETRIES + 1} 次尝试后仍然失败。` +
      `最后错误: ${lastError?.message ?? '未知错误'}`,
  );
}
