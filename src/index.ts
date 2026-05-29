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

import { getInput, setFailed } from '@actions/core';
import { getOctokit, context } from '@actions/github';
import { fetchPRDiff, fetchTeamRules, createReviewComment } from './tools/github.js';
import { analyzeCode } from './agent/reviewer.js';

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

    console.log(
      `[index] 🚀 开始审查 PR #${prNumber} (${owner}/${repo})`,
    );

    // ─── 3. 获取 PR 的 unified diff ───
    const diff = await fetchPRDiff(octokit, owner, repo, prNumber);

    // ─── 4. 加载团队自定义审查规则（轻量级 RAG）───
    const teamRules = await fetchTeamRules(octokit, owner, repo);

    // ─── 5. 调用 AI 引擎执行深度审查 ───
    const result = await analyzeCode(diff, teamRules, openaiKey, undefined, openaiBaseUrl);

    console.log(
      `[index] 📋 审查完成，共发现 ${result.comments.length} 条意见`,
    );
    if (result.usage) {
      console.log(
        `[index] 💰 Token 用量 — prompt: ${result.usage.promptTokens}, completion: ${result.usage.completionTokens}, total: ${result.usage.totalTokens}`,
      );
    }

    // ─── 6. 将审查结果发布为 PR 评论（闭环的最后一步）───
    await createReviewComment(octokit, owner, repo, prNumber, result.comments);

    console.log('[index] ✅ 审查流水线全部完成');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[index] ❌ 流水线执行失败: ${message}`);
    setFailed(`PR Review Agent 执行失败: ${message}`);
  }
}

run();
