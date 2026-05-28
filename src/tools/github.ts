/**
 * src/tools/github.ts
 * ── Git 工具层 ──
 *
 * 职责：
 * 1. 从 GitHub API 获取 PR 的 unified diff 文本
 * 2. 从目标仓库拉取团队自定义审查规则（轻量级 RAG 知识源）
 *
 * 所有网络调用均包含异常兜底处理，并通过 console.log 输出关键状态，
 * 便于在 GitHub Actions 日志中追踪执行过程。
 */

import type { GitHub } from '@actions/github/lib/utils';

// ---------------------------------------------------------------------------
// 类型别名
// ---------------------------------------------------------------------------

/**
 * 已认证的 Octokit 实例类型。
 * 调用方通过 @actions/github 的 getOctokit(token) 创建并传入。
 */
type Octokit = InstanceType<typeof GitHub>;

// ---------------------------------------------------------------------------
// fetchPRDiff — 获取 PR 的 diff 文本
// ---------------------------------------------------------------------------

/**
 * 获取指定 Pull Request 的完整 unified diff 文本。
 *
 * 通过设置 mediaType 为 `diff` 格式，GitHub REST API 会直接返回
 * 纯文本 diff（而非 JSON 对象），这正是后续 LLM 审查所需的输入格式。
 *
 * @param octokit  - 已认证的 GitHub Octokit 实例
 * @param owner    - 仓库所有者（组织名或用户名）
 * @param repo     - 仓库名称
 * @param prNumber - Pull Request 编号
 * @returns PR 的完整 diff 文本字符串
 * @throws  当网络异常或 PR 不存在时抛出错误
 */
export async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  try {
    console.log(
      `[fetchPRDiff] 正在获取 PR #${prNumber} 的 diff 文本...`,
    );

    // GitHub REST API: get a pull request
    // 通过 mediaType.format = 'diff' 让 API 返回纯文本 diff 而非 JSON
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff',
      },
    });

    // 当 mediaType 为 diff 时，response.data 在运行时为 string，
    // 但 TS 类型推断仍基于默认 JSON schema，因此需要显式断言。
    const diff = response.data as unknown as string;

    if (typeof diff !== 'string' || diff.length === 0) {
      throw new Error('GitHub API 返回的 diff 为空或类型异常');
    }

    console.log(
      `[fetchPRDiff] ✅ 成功获取 diff，长度: ${diff.length} 字符`,
    );
    return diff;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[fetchPRDiff] ❌ 获取 PR diff 失败: ${message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// fetchTeamRules — 轻量级 RAG 知识源加载
// ---------------------------------------------------------------------------

/**
 * 尝试从目标仓库读取团队自定义审查规则文件。
 *
 * ── 轻量级 RAG 机制说明 ──
 *
 * 本项目的 RAG（Retrieval-Augmented Generation）采用最简实现：
 * 1. 【检索（Retrieval）】: 从目标仓库拉取 `.github/REVIEW_RULES.md`
 *    作为外部知识文档。该文件由各仓库的团队自行维护，包含项目特定的
 *    编码约定（如：命名规范、目录结构约定、禁用模式等）。
 * 2. 【增强（Augmented）】: 将该文件内容作为上下文注入到 LLM 的
 *    系统提示词中（见 src/agent/reviewer.ts 的 buildSystemPrompt）。
 * 3. 【生成（Generation）】: LLM 同时参考「通用审查最佳实践」和
 *    「团队特定规范」生成最终的审查意见。
 *
 * 这种方案无需向量数据库或 Embedding，适合单文件、轻量级的场景。
 *
 * 异常处理策略：
 * - 文件不存在（404）→ 返回 null，审查继续，仅使用通用规则
 * - 其他网络/鉴权错误 → 返回 null，记录日志，不阻断主审查流程
 * - 只有调用方明确需要 RAG 且获取失败时才抛异常
 *
 * @param octokit - 已认证的 GitHub Octokit 实例
 * @param owner   - 仓库所有者
 * @param repo    - 仓库名称
 * @returns 规则文件的 Markdown 文本内容，或 null（表示未找到/获取失败）
 */
export async function fetchTeamRules(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string | null> {
  const rulesPath = '.github/REVIEW_RULES.md';

  try {
    console.log(
      `[fetchTeamRules] 正在尝试加载团队审查规则 (${rulesPath})...`,
    );

    // 调用 GitHub Content API 读取仓库中的文件内容
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: rulesPath,
    });

    const data = response.data;

    // getContent 对目录返回数组，对文件返回单个对象
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

    // GitHub Content API 对文件内容使用 Base64 编码
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
  } catch (error: unknown) {
    // ── 404 处理：文件不存在是合法的业务状态 ──
    // GitHub API 在文件不存在时返回 404，此时不应抛异常，
    // 而是返回 null 让上层优雅降级为「无 RAG 增强」模式。
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

    // ── 其他异常（网络超时、鉴权失败等）──
    // 记录详细错误日志供运维排查，但不阻断主审查流程。
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(
      `[fetchTeamRules] ❌ 获取团队规则时发生异常: ${message}`,
    );
    console.error(
      '[fetchTeamRules] ⚠️  RAG 加载失败，审查将继续使用纯通用规则执行',
    );
    return null;
  }
}
