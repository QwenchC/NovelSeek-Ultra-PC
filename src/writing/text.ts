import { hashText } from './hash';
import { assert, isUnicodeBoundary } from './protocol';

export interface TextRange { offset: number; endOffset: number; total: number; nextOffset: number | null; sourceHash: string; text: string; unit: 'UTF-16' }
export function readTextRange(text: string, offset = 0, limit = 8_000): TextRange {
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length && Number.isSafeInteger(limit) && limit >= 1 && limit <= 12_000, '文本分片偏移或长度无效');
  const start = isUnicodeBoundary(text, offset) ? offset : offset - 1;
  let end = Math.min(text.length, start + limit); if (!isUnicodeBoundary(text, end)) end--;
  if (end === start && start < text.length) end = start + 2;
  return { offset: start, endOffset: end, total: text.length, nextOffset: end < text.length ? end : null, sourceHash: hashText(text), text: text.slice(start, end), unit: 'UTF-16' };
}
export function chapterReviewTextChunks(text: string, maxChars = 2_400): string[] {
  assert(Number.isSafeInteger(maxChars) && maxChars >= 2, '预览分片长度必须不少于2'); const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + maxChars, text.length); if (!isUnicodeBoundary(text, end)) end--;
    if (end < text.length) { const newline = text.lastIndexOf('\n', end - 1); if (newline >= start + (end - start) / 2) end = newline + 1; }
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}
export interface TextSource { id: string; title: string; kind: string; text: string }
export interface TextSearchHit { sourceId: string; title: string; kind: string; offset: number; endOffset: number; contextOffset: number; context: string; total: number; sourceHash: string }
export interface TextSearchPage { query: string; offset: number; total: number; nextOffset: number | null; hits: TextSearchHit[]; unit: string }
export function searchText(sources: Iterable<TextSource>, query: string, options: { offset?: number; limit?: number; contextLength?: number; ignoreCase?: boolean } = {}): TextSearchPage {
  const { offset = 0, limit = 10, contextLength = 120, ignoreCase = false } = options;
  assert(query.trim() && query.length <= 500 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(query), '搜索词为空、过长或Unicode不完整');
  assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 30 && Number.isSafeInteger(contextLength) && contextLength >= 0 && contextLength <= 300, '搜索分页参数无效');
  const hits: TextSearchHit[] = []; let total = 0;
  // Regex case-folding retains source offsets; lowercasing can change UTF-16 length (e.g. İ).
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const source of sources) {
    const regex = new RegExp(escaped, ignoreCase ? 'giu' : 'gu'); let match: RegExpExecArray | null; let sourceHash: string | null = null;
    while ((match = regex.exec(source.text))) {
      const index = match.index, endOffset = index + match[0].length;
      if (total >= offset && hits.length < limit) {
        let start = Math.max(0, index - contextLength), end = Math.min(source.text.length, endOffset + contextLength);
        if (!isUnicodeBoundary(source.text, start)) start--; if (!isUnicodeBoundary(source.text, end)) end++;
        sourceHash ??= hashText(source.text);
        hits.push({ sourceId: source.id, title: source.title, kind: source.kind, offset: index, endOffset, contextOffset: start, context: source.text.slice(start, end), total: source.text.length, sourceHash });
      }
      total++;
    }
  }
  return { query, offset, total, nextOffset: offset + hits.length < total ? offset + hits.length : null, hits, unit: 'UTF-16; search offset/nextOffset count matches' };
}
export interface ChapterReviewDiffBlock { id: number; baselineText: string; candidateText: string; changed: boolean }
function paragraphs(text: string, maxParagraphs: number, maxChars: number): string[] {
  const minimum = Math.max(1, Math.ceil(text.length / maxParagraphs)); const items: string[] = [];
  for (let start = 0; start < text.length;) {
    let next = text.indexOf('\n', start); let end = next < 0 ? text.length : next + 1;
    while (end - start < minimum && end < text.length) { next = text.indexOf('\n', end); end = next < 0 ? text.length : next + 1; }
    end = Math.min(end, start + Math.max(maxChars, minimum)); if (!isUnicodeBoundary(text, end)) end--;
    // A minimum of one character must still advance across a supplementary character.
    if (end === start) end = Math.min(start + 2, text.length);
    items.push(text.slice(start, end)); start = end;
  }
  if (items.length <= maxParagraphs) return items;
  const group = Math.ceil(items.length / maxParagraphs); const result: string[] = [];
  for (let i = 0; i < items.length; i += group) result.push(items.slice(i, i + group).join(''));
  return result;
}
/** Unique paragraph anchors + LIS: bounded memory, no quadratic edit matrix, lossless whitespace. */
export function chapterReviewDiff(baseline: string, candidate: string, maxParagraphs = 1_200, maxParagraphChars = 2_400): ChapterReviewDiffBlock[] {
  assert(Number.isSafeInteger(maxParagraphs) && maxParagraphs > 0 && Number.isSafeInteger(maxParagraphChars) && maxParagraphChars >= 2, '差异分片参数无效');
  if (baseline === candidate) return baseline ? [{ id: 0, baselineText: baseline, candidateText: candidate, changed: false }] : [];
  const before = paragraphs(baseline, maxParagraphs, maxParagraphChars), after = paragraphs(candidate, maxParagraphs, maxParagraphChars);
  const counts = (items: string[]) => { const map = new Map<string, number>(); for (const x of items) map.set(x, (map.get(x) ?? 0) + 1); return map; };
  const bc = counts(before), ac = counts(after), ai = new Map(after.map((x, i) => [x, i])); const possible: [number, number][] = [];
  before.forEach((x, i) => { if (bc.get(x) === 1 && ac.get(x) === 1) possible.push([i, ai.get(x)!]); });
  const tails: number[] = [], predecessors: number[] = [];
  possible.forEach((pair, i) => { let low = 0, high = tails.length; while (low < high) { const middle = (low + high) >>> 1; if (possible[tails[middle]][1] < pair[1]) low = middle + 1; else high = middle; } predecessors[i] = low ? tails[low - 1] : -1; tails[low] = i; });
  const anchors: [number, number][] = []; for (let i = tails[tails.length - 1]; i !== undefined && i >= 0; i = predecessors[i]) anchors.push(possible[i]); anchors.reverse();
  const blocks: ChapterReviewDiffBlock[] = []; let b = 0, a = 0;
  const append = (left: string, right: string) => { if (left || right) blocks.push({ id: blocks.length, baselineText: left, candidateText: right, changed: left !== right }); };
  for (const [bi, aj] of anchors) { append(before.slice(b, bi).join(''), after.slice(a, aj).join('')); append(before[bi], after[aj]); b = bi + 1; a = aj + 1; }
  append(before.slice(b).join(''), after.slice(a).join('')); return blocks;
}
export function applyReviewDiff(blocks: ChapterReviewDiffBlock[], selectedIds: Iterable<number>): string {
  const ids = new Set(selectedIds); return blocks.map(b => !b.changed || ids.has(b.id) ? b.candidateText : b.baselineText).join('');
}
export interface ImportedChapter { title: string; body: string }
export interface ManuscriptPreview { chapters: ImportedChapter[]; totalCharacters: number }
export function previewManuscript(text: string): ManuscriptPreview {
  assert(text.length <= 5_000_000, '书稿超过500万字符，请分卷导入');
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); assert(normalized.trim(), '书稿为空');
  const heading = /^(?:#{1,3}\s+(.{1,250})|((?:第[零〇一二三四五六七八九十百千万两0-9]+[章节回卷部].{0,200}|Chapter\s+\d+(?:[\s：:、.．].{0,200})?)))$/i;
  const chapters: ImportedChapter[] = []; let title = '序章'; let lines: string[] = [];
  const flush = () => { const body = lines.join('\n').replace(/^\n+|\n+$/g, ''); if (body.trim()) chapters.push({ title, body }); lines = []; assert(chapters.length <= 2_000, '章节超过2000个，请分卷导入'); };
  for (const line of normalized.split('\n')) { const match = heading.exec(line.trim()); if (match) { flush(); title = (match[1] || match[2]).trim(); } else lines.push(line); }
  flush(); assert(chapters.length > 0, '没有可导入的正文'); return { chapters, totalCharacters: normalized.length };
}
