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
type Octokit = InstanceType<typeof GitHub>;
export declare function fetchPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string>;
export declare function fetchTeamRules(octokit: Octokit, owner: string, repo: string): Promise<string | null>;
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
export declare function createPRReview(octokit: Octokit, owner: string, repo: string, prNumber: number, comments: ReviewComment[], commitId?: string): Promise<void>;
export {};
