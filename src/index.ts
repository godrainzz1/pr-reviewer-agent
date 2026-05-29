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

import { getInput, setFailed } from '@actions/core';
import { getOctokit, context } from '@actions/github';
import { fetchPRDiff, fetchTeamRules, createPRReview } from './tools/github.js';
import { analyzeCode } from './agent/reviewer.js';
import { parseDiff } from './tools/diff-parser.js';
import { logTokenUsage } from './tools/logger.js';

async function run(): Promise<void> {
  try {
    // ─── 1. 获取 GitHub Actions 输入参数 ───
    const githubToken = getInput('github-token', { required: true });
    const openaiKey = getInput('openai-key', { required: true });
    const openaiBaseUrl = getInput('openai-base-url') || 'https://api.deepseek.com';

    // ─── 2. 从 Actions 上下文提取 PR 信息 ───
    const octokit = getOctokit(githubToken);
    const { owner, repo } = context.repo;
    const prNumber = context.issue.number;
    const commitId = context.sha; // PR head commit SHA

    console.log(
      `[index] 🚀 开始审查 PR #${prNumber} (${owner}/${repo}) @ ${commitId.slice(0, 7)}`,
    );

    // ─── 3. 获取 PR 的 unified diff ───
    const diff = await fetchPRDiff(octokit, owner, repo, prNumber);

    // ─── 3.5 解析 diff（文件感知 + 行号映射）───
    const parsedDiff = parseDiff(diff);

    if (parsedDiff.files.size === 0) {
      console.log(
        '[index] ℹ️  PR 仅包含配置文件变更，无需审查',
      );
      return;
    }

    // ─── 4. 加载团队自定义审查规则（轻量级 RAG）───
    const teamRules = await fetchTeamRules(octokit, owner, repo);

    // ─── 5. 调用 AI 引擎执行深度审查 ───
    const result = await analyzeCode(diff, teamRules, openaiKey, parsedDiff, undefined, openaiBaseUrl);

    console.log(
      `[index] 📋 审查完成，共发现 ${result.comments.length} 条意见`,
    );
    if (result.usage) {
      console.log(
        `[index] 💰 Token 用量 — prompt: ${result.usage.promptTokens}, completion: ${result.usage.completionTokens}, total: ${result.usage.totalTokens}`,
      );
      logTokenUsage({
        model: 'deepseek-chat',
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        prNumber,
        repo: `${owner}/${repo}`,
      });
    }

    // ─── 6. 将审查结果发布为行级 PR Review（闭环的最后一步）───
    await createPRReview(octokit, owner, repo, prNumber, result.comments, commitId, result.usage);

    console.log('[index] ✅ 审查流水线全部完成');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[index] ❌ 流水线执行失败: ${message}`);
    setFailed(`PR Review Agent 执行失败: ${message}`);
  }
}

run();
