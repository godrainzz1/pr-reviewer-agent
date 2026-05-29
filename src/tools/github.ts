/**
 * src/tools/github.ts
 * ── Git 工具层 ──
 *
 * 职责：
 * 1. 从 GitHub API 获取 PR 的 unified diff 文本
 * 2. 从目标仓库拉取团队自定义审查规则（轻量级 RAG 知识源）
 * 3. 将审查结果发布为行级 PR Review（inline comments）
 *
 * Phase 4 增强：
 * - 指数退避重试（Exponential Backoff）用于所有 API 调用
 * - 重复评论防护（查找并覆盖旧的 Bot Review）
 * - diff position 映射支持行级 inline comment
 */

import type { GitHub } from '@actions/github/lib/utils';
import type { ReviewComment } from '../agent/reviewer.js';

// ---------------------------------------------------------------------------
// 类型别名
// ---------------------------------------------------------------------------

type Octokit = InstanceType<typeof GitHub>;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 最大重试次数（不含首次调用） */
const MAX_RETRIES = 4;

/** 初始退避延迟（毫秒） */
const BASE_DELAY_MS = 1000;

/** Bot 标识 HTML 注释，用于查找和识别自家的 Review */
const BOT_MARKER = '<!-- pr-reviewer-agent-bot -->';

// ---------------------------------------------------------------------------
// 指数退避重试工具
// ---------------------------------------------------------------------------

/**
 * 判断错误是否可重试。
 * - 429 Rate Limit → 重试（遵守 Retry-After）
 * - 5xx 服务端错误 → 重试
 * - 网络层错误（timeout, ECONNREFUSED, etc.）→ 重试
 * - 401/403/404 → 不重试（404 在 fetchTeamRules 中特殊处理）
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('enetunreach') ||
      msg.includes('socket hang up')
    ) {
      return true;
    }
  }

  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: number }).status;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }

  return false;
}

/**
 * 从错误对象中提取 Retry-After 响应头（用于 429 限流）。
 */
function extractRetryAfter(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error
  ) {
    const response = (error as { response?: { headers?: Record<string, string> } }).response;
    if (response?.headers) {
      const header = response.headers['retry-after'];
      if (header) {
        const seconds = parseInt(header, 10);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = Date.parse(header);
        if (!isNaN(date)) return Math.max(0, date - Date.now());
      }
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 对异步操作执行指数退避重试。
 *
 * 策略：初始延迟 1s → 2s → 4s → 8s（最多 4 次重试）。
 * 429 错误的 Retry-After 头优先于计算延迟。
 *
 * @param fn       - 要执行的异步函数
 * @param label    - 日志标签
 * @param maxRetries - 最大重试次数
 * @returns 函数返回值
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries: number = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !isRetryableError(error)) {
        break;
      }

      // 遵守 429 Retry-After
      const retryAfter = extractRetryAfter(error);
      const computedDelay = BASE_DELAY_MS * Math.pow(2, attempt);
      const delayMs = retryAfter ?? computedDelay;

      console.warn(
        `[${label}] ⏳ 第 ${attempt + 1} 次调用失败，${delayMs}ms 后重试 (${attempt + 2}/${maxRetries + 1})...`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// fetchPRDiff — 获取 PR 的 diff 文本
// ---------------------------------------------------------------------------

export async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  return withRetry(async () => {
    console.log(`[fetchPRDiff] 正在获取 PR #${prNumber} 的 diff 文本...`);

    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });

    const diff = response.data as unknown as string;

    if (typeof diff !== 'string' || diff.length === 0) {
      throw new Error('GitHub API 返回的 diff 为空或类型异常');
    }

    console.log(`[fetchPRDiff] ✅ 成功获取 diff，长度: ${diff.length} 字符`);
    return diff;
  }, 'fetchPRDiff');
}

// ---------------------------------------------------------------------------
// fetchTeamRules — 轻量级 RAG 知识源加载
// ---------------------------------------------------------------------------

export async function fetchTeamRules(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string | null> {
  const rulesPath = '.github/REVIEW_RULES.md';

  try {
    return await withRetry(async () => {
      console.log(
        `[fetchTeamRules] 正在尝试加载团队审查规则 (${rulesPath})...`,
      );

      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: rulesPath,
      });

      const data = response.data;

      if (Array.isArray(data)) {
        console.warn(
          `[fetchTeamRules] ⚠️  ${rulesPath} 是一个目录而非文件，跳过 RAG 加载`,
        );
        return null;
      }

      if (data.type !== 'file') {
        console.warn(
          `[fetchTeamRules] ⚠️  ${rulesPath} 的类型为 "${data.type}"，非预期的文件类型`,
        );
        return null;
      }

      const content = Buffer.from(data.content, 'base64').toString('utf-8').trim();

      if (content.length === 0) {
        console.log(
          `[fetchTeamRules] ⚠️  ${rulesPath} 文件为空，本次审查将仅使用内置规则`,
        );
        return null;
      }

      console.log(
        `[fetchTeamRules] ✅ 成功加载 RAG 规则 (${rulesPath})，内容长度: ${content.length} 字符`,
      );
      return content;
    }, 'fetchTeamRules');
  } catch (error: unknown) {
    // 404 是合法状态——文件不存在，降级到纯通用规则模式
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status: number }).status === 404
    ) {
      console.log(
        `[fetchTeamRules] ℹ️  未找到 ${rulesPath}（404），本次审查将仅使用内置通用规则`,
      );
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fetchTeamRules] ❌ 获取团队规则时发生异常: ${message}`);
    console.error('[fetchTeamRules] ⚠️  RAG 加载失败，审查将继续使用纯通用规则执行');
    return null;
  }
}

// ---------------------------------------------------------------------------
// createPRReview — 将审查结果发布为行级 PR Review
// ---------------------------------------------------------------------------

/**
 * 构建 Review body（Markdown 格式）。
 * 包含 Bot 标记、意见摘要和通用评论。
 */
function buildReviewBody(generalComments: ReviewComment[], totalInline: number): string {
  const header = [
    `${BOT_MARKER}`,
    '## 🤖 PR Review Agent — AI 代码审查报告',
    '',
  ];

  const total = generalComments.length + totalInline;

  if (total === 0) {
    return [
      ...header,
      '✅ **审查完成，未发现需要关注的问题。**',
      '',
      '系统已对本次 PR 的代码变更进行了安全检查、逻辑审查和代码质量评估，',
      '未检测到安全漏洞、逻辑错误或明显的代码质量问题。',
      '',
      '> 本评论由 PR Reviewer Agent 自动生成，基于 DeepSeek V4 模型分析。',
    ].join('\n');
  }

  const summary = [
    `本次审查共发现 **${total}** 条意见（${totalInline} 条行级 + ${generalComments.length} 条通用），请逐条确认并修改：`,
    '',
  ];

  // 通用评论（无行号的）
  let generalSection = '';
  if (generalComments.length > 0) {
    generalSection = [
      '---',
      '',
      '### 📝 通用评论（未绑定具体代码行）',
      '',
      ...generalComments.map((c, i) => {
        return [
          `**${i + 1}. \`${c.file}\` — 第 ${c.line} 行**`,
          '',
          c.comment,
          '',
        ].join('\n');
      }),
      '---',
      '',
    ].join('\n');
  }

  const footer = [
    '> ⚡ 本评论由 PR Reviewer Agent 自动生成。如有误报请忽略或在 `.github/REVIEW_RULES.md` 中调整审查规则。',
  ];

  return [...header, ...summary, generalSection, ...footer].join('\n');
}

/**
 * 查找该 PR 上 Bot 之前发布的 Review ID。
 * 返回第一个匹配的 Review（按时间倒序）。
 */
async function findPreviousBotReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const reviews = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 50,
  });

  for (const review of reviews.data) {
    if (review.body && review.body.includes(BOT_MARKER)) {
      // 如果之前的 Review 是 PENDING 状态，先 dismiss 掉
      if (review.state === 'PENDING') {
        try {
          await octokit.rest.pulls.dismissReview({
            owner,
            repo,
            pull_number: prNumber,
            review_id: review.id,
            message: 'Bot 已重新审查，此 Review 将被更新覆盖。',
          });
          console.log(
            `[createPRReview] 已 dismiss 旧的 PENDING Review #${review.id}`,
          );
        } catch (e) {
          console.warn(
            `[createPRReview] 无法 dismiss Review #${review.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return review.id;
    }
  }

  return null;
}

/**
 * 将审查结果发布为 PR Review（使用 pulls.createReview 支持行级 inline comment）。
 *
 * Phase 4 核心改进：
 * 1. 使用 pulls.createReview 替代 issues.createComment，支持行级评论
 * 2. 根据 position 分离 inline 评论和 body 通用评论
 * 3. 提交前先查找并清除旧的 Bot Review（防重复）
 * 4. 带指数退避重试
 *
 * @param octokit  - 已认证的 GitHub Octokit 实例
 * @param owner    - 仓库所有者
 * @param repo     - 仓库名称
 * @param prNumber - Pull Request 编号
 * @param comments - 通过校验的审查意见列表（含 position）
 * @param commitId - 当前 PR head commit SHA（用于绑定 review 到特定 commit）
 */
export async function createPRReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  comments: ReviewComment[],
  commitId?: string,
): Promise<void> {
  // 分离 inline 和 general 评论
  const inlineComments = comments.filter((c) => c.position != null);
  const generalComments = comments.filter((c) => c.position == null);

  const body = buildReviewBody(generalComments, inlineComments.length);

  // 构建 GitHub API 所需的 inline comment 格式
  const reviewComments = inlineComments.map((c) => ({
    path: c.file,
    position: c.position!,
    body: c.comment,
  }));

  await withRetry(async () => {
    // ── 去重：查找并 dismiss 旧的 Bot pending Review ──
    await findPreviousBotReview(octokit, owner, repo, prNumber);

    console.log(
      `[createPRReview] 正在发布 PR Review: ${reviewComments.length} 条 inline + ${generalComments.length} 条 general`,
    );

    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      body,
      event: 'COMMENT',
      comments: reviewComments,
    });

    console.log(
      `[createPRReview] ✅ Review 已成功发布（${reviewComments.length} inline + ${generalComments.length} general）`,
    );
  }, 'createPRReview');
}
