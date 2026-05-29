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

export interface ParsedHunk {
  header: string;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface HunkLine {
  content: string;
  diffPosition: number;
  physicalLine: number;
  kind: '+' | '-' | ' ';
}

export interface ParsedFile {
  path: string;
  hunks: ParsedHunk[];
  lines: HunkLine[];
  addedLines: Set<number>;
  lineToPosition: Map<number, number>;
}

export interface ParsedDiff {
  files: Map<string, ParsedFile>;
}

// ---------------------------------------------------------------------------
// 常量
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

// 下一个 hunk header 或文件开始标记
const NEXT_SECTION_RE = /^@@|^diff --git|^$/;

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

export function parseDiff(rawDiff: string): ParsedDiff {
  const files = new Map<string, ParsedFile>();
  const lines = rawDiff.split('\n');

  let currentFile: ParsedFile | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── 文件头行 ──
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (newFileMatch) {
      const filePath = newFileMatch[1];

      if (shouldSkipFile(filePath)) {
        currentFile = null;
        i++;
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
      i++;
      continue;
    }

    if (!currentFile) {
      i++;
      continue;
    }

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
      i++; // 移到 hunk 内容第一行

      // 消费 hunk 内容行（while 循环避免重复处理）
      while (i < lines.length) {
        const hunkLine = lines[i];

        // 遇到下一个 section 则停止
        if (NEXT_SECTION_RE.test(hunkLine) && !hunkLine.startsWith('+') && !hunkLine.startsWith('-') && hunkLine !== ' ' && hunkLine !== '') {
          break;
        }

        // 空行：可能是 diff 末尾
        if (hunkLine === '') {
          i++;
          continue;
        }

        const kind: '+' | '-' | ' ' = hunkLine.startsWith('+')
          ? '+'
          : hunkLine.startsWith('-')
            ? '-'
            : ' ';

        const hl: HunkLine = {
          content: hunkLine.slice(1),
          diffPosition: i + 1,
          physicalLine: kind !== '-' ? physicalLine : -(physicalLine - 1),
          kind,
        };

        hunk.lines.push(hl);
        currentFile.lines.push(hl);

        if (kind === '+') {
          currentFile.addedLines.add(physicalLine);
        }
        currentFile.lineToPosition.set(physicalLine, i + 1);

        if (kind !== '-') physicalLine++;
        i++;
      }

      continue; // 重回外层 while，不额外 i++
    }

    i++;
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

export function mapLineToPosition(
  parsedDiff: ParsedDiff,
  filePath: string,
  physicalLine: number,
): number | null {
  const file = parsedDiff.files.get(filePath);
  if (!file) return null;
  return file.lineToPosition.get(physicalLine) ?? null;
}

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

  const inHunk = file.hunks.some((h) => {
    return lineNum >= h.newStart && lineNum < h.newStart + h.newCount;
  });

  return inHunk ? 'file_only' : 'file_only';
}
