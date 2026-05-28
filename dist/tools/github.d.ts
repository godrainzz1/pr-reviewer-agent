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
import type { ReviewComment } from '../agent/reviewer.js';
/**
 * 已认证的 Octokit 实例类型。
 * 调用方通过 @actions/github 的 getOctokit(token) 创建并传入。
 */
type Octokit = InstanceType<typeof GitHub>;
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
export declare function fetchPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string>;
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
export declare function fetchTeamRules(octokit: Octokit, owner: string, repo: string): Promise<string | null>;
/**
 * 将 AI 审查的结构化结果格式化为 Markdown 并发布为 PR 评论。
 *
 * 这是整个流水线的最后一环（闭环动作），将 JSON 结果转换为人类可读的
 * 评论直接展示在 PR 的 Conversation 标签页中。
 *
 * 当审查意见为空时，发布一条正向反馈评论（告知团队未发现问题），
 * 避免审查静默通过造成的困惑。
 *
 * @param octokit  - 已认证的 GitHub Octokit 实例
 * @param owner    - 仓库所有者
 * @param repo     - 仓库名称
 * @param prNumber - Pull Request 编号
 * @param comments - 通过校验的审查意见列表
 */
export declare function createReviewComment(octokit: Octokit, owner: string, repo: string, prNumber: number, comments: ReviewComment[]): Promise<void>;
export {};
