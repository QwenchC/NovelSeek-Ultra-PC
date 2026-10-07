import { applyReviewDiff, chapterReviewDiff, chapterReviewTextChunks } from '../writing';

export interface ParagraphChange {
  id: number;
  before: string;
  after: string;
  changed: boolean;
}

/** Share the bounded, Unicode-safe lossless implementation covered by core tests. */
export function textChunks(text: string, maxChars = 2400): string[] {
  return chapterReviewTextChunks(text, maxChars);
}
export function diffParagraphs(beforeText: string, afterText: string): ParagraphChange[] {
  return chapterReviewDiff(beforeText, afterText).map(block => ({
    id: block.id,
    before: block.baselineText,
    after: block.candidateText,
    changed: block.changed,
  }));
}
export function assembledReviewText(blocks: ParagraphChange[], selected: Set<number>): string {
  return applyReviewDiff(
    blocks.map(block => ({
      id: block.id,
      baselineText: block.before,
      candidateText: block.after,
      changed: block.changed,
    })),
    selected
  );
}
