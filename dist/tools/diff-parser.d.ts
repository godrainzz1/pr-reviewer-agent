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
export declare function parseDiff(rawDiff: string): ParsedDiff;
export declare function mapLineToPosition(parsedDiff: ParsedDiff, filePath: string, physicalLine: number): number | null;
export declare function validateLocation(parsedDiff: ParsedDiff, filePath: string, line: string): 'valid' | 'file_only' | 'invalid';
