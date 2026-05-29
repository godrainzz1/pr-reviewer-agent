/**
 * src/tools/diff-parser.ts
 * ── Diff 解析引擎 ──
 *
 * 职责：
 * 1. 解析 unified diff 格式，提取文件路径和 hunk 信息
 * 2. 构建物理行号 → diff position 映射表
 * 3. 提供文件/行号级别的查询接口供 reviewer 校验使用
 * 4. 过滤无需审查的配置文件
 */

// ---------------------------------------------------------------------------
// 导出类型定义
// ---------------------------------------------------------------------------

/** 单个 hunk 的解析结果 */
export interface ParsedHunk {
  /** hunk header 原文，如 "@@ -10,5 +12,7 @@" */
  header: string;
  /** 新增侧起始物理行号（+ 后面的数字） */
  newStart: number;
  /** 新增侧行数 */
  newCount: number;
  /** hunk 内所有行的文本（含 diff 标记符） */
  lines: HunkLine[];
}

/** hunk 中的单行 */
export interface HunkLine {
  /** 行内容（不含开头的 + / - / 空格标记符） */
  content: string;
  /** 在 unified diff 中的绝对位置（1-based，从 diff 第一行起算） */
  diffPosition: number;
  /** 物理行号（新增侧），上下文行和删除行也有对应的旧侧行号 */
  physicalLine: number;
  /** 行类型标记：+ 新增、- 删除、' ' 上下文 */
  kind: '+' | '-' | ' ';
}

/** 单个文件的 diff 解析结果 */
export interface ParsedFile {
  /** 相对于仓库根目录的文件路径 */
  path: string;
  /** 文件的所有 hunk */
  hunks: ParsedHunk[];
  /** 该文件在 diff 中的所有行（合并所有 hunk） */
  lines: HunkLine[];
  /** 新增/修改行的物理行号集合 */
  addedLines: Set<number>;
  /** 物理行号 → diff position 快速映射 */
  lineToPosition: Map<number, number>;
}

/** 完整 diff 的解析结果 */
export interface ParsedDiff {
  /** filePath → ParsedFile */
  files: Map<string, ParsedFile>;
}

// ---------------------------------------------------------------------------
// 常量：不带审查的文件模式
// ---------------------------------------------------------------------------

const SKIP_PATTERNS = [
  /\.json$/i,
  /\.lock$/i,
  /\.yml$/i,
  /\.yaml$/i,
  /\.md$/i,
  /^dist\//,
  /^\.github\//,
];

function shouldSkipFile(filePath: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(filePath));
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 解析 unified diff 文本，提取所有文件的 hunk 信息。
 *
 * 仅处理代码文件（排除 .json / .lock / .yml / .yaml / .md / dist / .github）。
 *
 * @param rawDiff - 原始 unified diff 文本
 * @returns 结构化的 diff 解析结果
 */
export function parseDiff(rawDiff: string): ParsedDiff {
  const files = new Map<string, ParsedFile>();
  const lines = rawDiff.split('\n');

  let currentFile: ParsedFile | null = null;
  let diffPosition = 0;

  for (const line of lines) {
    diffPosition++;

    // ── 文件头行：提取新增侧文件路径 ──
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (newFileMatch) {
      const filePath = newFileMatch[1];

      // 跳过不需要审查的文件
      if (shouldSkipFile(filePath)) {
        currentFile = null;
        continue;
      }

      currentFile = {
        path: filePath,
        hunks: [],
        lines: [],
        addedLines: new Set(),
        lineToPosition: new Map(),
      };
      files.set(filePath, currentFile);
      continue;
    }

    if (!currentFile) continue;

    // ── hunk header ──
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] || '1', 10);

      const hunk: ParsedHunk = {
        header: line,
        newStart,
        newCount,
        lines: [],
      };
      currentFile.hunks.push(hunk);

      let physicalLine = newStart;
      // 遍历 hunk 内的行
      for (const hunkLine of lines.slice(diffPosition)) {
        diffPosition++;

        if (hunkLine.startsWith('@@') && !hunkLine.startsWith(line)) {
          // 下一个 hunk 开始了，回退 diffPosition
          diffPosition--;
          break;
        }

        // 跳过空行（diff 末尾）
        if (hunkLine === '') {
          // 如果是文件末尾的空行，可能是下一个文件分隔符
          continue;
        }

        const kind = hunkLine.startsWith('+')
          ? '+'
          : hunkLine.startsWith('-')
            ? '-'
            : ' ';

        const hl: HunkLine = {
          content: hunkLine.slice(1),
          diffPosition,
          physicalLine: kind !== '-' ? physicalLine : -(physicalLine - 1),
          kind,
        };

        hunk.lines.push(hl);
        currentFile!.lines.push(hl);

        if (kind === '+') {
          currentFile!.addedLines.add(physicalLine);
        }
        currentFile!.lineToPosition.set(physicalLine, diffPosition);

        if (kind !== '-') physicalLine++;

        // 检测下一个 hunk header 或文件头或 EOF
        // (在下一次循环时处理)
      }

      // 由于内层循环已经消费了 hunk 内容，需要调整 diffPosition
      // 使得外层循环能正确继续
      diffPosition--;
      continue;
    }

    // 非文件头、非 hunk header 的行被跳过
    // 更新 diffPosition tracking
  }

  console.log(
    `[parseDiff] ✅ 解析完成: ${files.size} 个代码文件需要审查`,
  );
  for (const [path, file] of files) {
    console.log(
      `  - ${path}: ${file.hunks.length} hunks, ${file.addedLines.size} 行新增`,
    );
  }

  return { files };
}

/**
 * 将 LLM 输出的物理行号映射为 GitHub API 所需的 diff position。
 *
 * @param parsedDiff - diff 解析结果
 * @param filePath   - 文件路径
 * @param physicalLine - 物理行号（数字字符串）
 * @returns diff position（1-based），找不到映射则返回 null
 */
export function mapLineToPosition(
  parsedDiff: ParsedDiff,
  filePath: string,
  physicalLine: number,
): number | null {
  const file = parsedDiff.files.get(filePath);
  if (!file) return null;
  return file.lineToPosition.get(physicalLine) ?? null;
}

/**
 * 校验 LLM 输出的文件+行号是否在真实 diff 中存在。
 *
 * @returns 校验结果：
 *   - 'valid'  → 文件存在且行号是实际新增/修改的行
 *   - 'file_only' → 文件存在但行号不是新增行（可降级为 General Comment）
 *   - 'invalid' → 文件不存在于 diff 中（应丢弃）
 */
export function validateLocation(
  parsedDiff: ParsedDiff,
  filePath: string,
  line: string,
): 'valid' | 'file_only' | 'invalid' {
  const file = parsedDiff.files.get(filePath);
  if (!file) return 'invalid';

  const lineNum = parseInt(line, 10);
  if (isNaN(lineNum)) return 'file_only';

  if (file.addedLines.has(lineNum)) return 'valid';

  // 检查是否在 hunk 范围内（上下文行/删除行）
  const inHunk = file.hunks.some((h) => {
    return lineNum >= h.newStart && lineNum < h.newStart + h.newCount;
  });

  return inHunk ? 'file_only' : 'file_only';
}
