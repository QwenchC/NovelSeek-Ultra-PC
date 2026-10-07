import type { ChapterScenePlan, CompletedScene, ReviewFinding, SceneSpec, WritingArchive, WritingCheckpoint } from './models';
import { WritingError } from './models';
import { canonicalJson } from './hash';

export const MAX_SCENES = 8;
export const MAX_SCENE_WORDS = 8_000;
export const MAX_CHAPTER_WORDS = 30_000;
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WritingError(message, 'protocol');
}
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), '必须是 JSON 对象');
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  assert(Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value, k)), '字段缺失或包含未声明字段');
}
function text(value: unknown, name: string): string { assert(typeof value === 'string', `${name} 必须是字符串`); return value; }
function integer(value: unknown, name: string): number { assert(Number.isSafeInteger(value), `${name} 必须是整数`); return value as number; }

/** Reject duplicate keys too: JSON.parse alone silently accepts the last duplicate value. */
export function strictJson(raw: string, maxChars = 128_000): unknown {
  assert(typeof raw === 'string' && raw.length <= maxChars, 'JSON 超过长度上限');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new WritingError('只能输出完整严格 JSON，不能附解释或代码围栏', 'protocol'); }
  let cursor = 0;
  const ws = () => { while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < raw.length) { if (raw[cursor++] === '"') return JSON.parse(raw.slice(start, cursor)) as string; if (raw[cursor - 1] === '\\') cursor++; }
    throw new WritingError('JSON 字符串不完整', 'protocol');
  };
  const visit = (depth: number): void => {
    assert(depth < 64, 'JSON 嵌套过深'); ws();
    if (raw[cursor] === '{') {
      cursor++; ws(); const keys = new Set<string>();
      if (raw[cursor] === '}') { cursor++; return; }
      while (cursor < raw.length) {
        const key = string(); assert(!keys.has(key), `JSON 字段重复：${key}`); keys.add(key);
        ws(); cursor++; visit(depth + 1); ws();
        if (raw[cursor++] === '}') return; ws();
      }
    } else if (raw[cursor] === '[') {
      cursor++; ws(); if (raw[cursor] === ']') { cursor++; return; }
      while (cursor < raw.length) { visit(depth + 1); ws(); if (raw[cursor++] === ']') return; }
    } else if (raw[cursor] === '"') string();
    else { while (cursor < raw.length && !/[\s,}\]]/.test(raw[cursor])) cursor++; }
  };
  visit(0); return parsed;
}
const sceneKeys = ['id', 'title', 'pov', 'time', 'location', 'goal', 'conflict', 'turn', 'entryState', 'exitState', 'requiredEvents', 'forbiddenEvents', 'targetWords'];
function sceneFrom(value: unknown): SceneSpec {
  const v = object(value); exactKeys(v, sceneKeys);
  sceneKeys.slice(0, 10).forEach(k => text(v[k], k));
  ['requiredEvents', 'forbiddenEvents'].forEach(k => { assert(Array.isArray(v[k]), `${k} 必须是数组`); (v[k] as unknown[]).forEach(x => text(x, k)); });
  integer(v.targetWords, 'targetWords'); return v as unknown as SceneSpec;
}
export function parseScenePlan(raw: string, projectId: string, chapterId: string, sourceFingerprint: string, updatedAt = Date.now()): ChapterScenePlan {
  const root = object(strictJson(raw)); exactKeys(root, ['scenes']); assert(Array.isArray(root.scenes), 'scenes 必须是数组');
  return validateScenePlan({ projectId, chapterId, sourceFingerprint, updatedAt, scenes: root.scenes.map(sceneFrom) });
}
export function validateScenePlan(plan: ChapterScenePlan): ChapterScenePlan {
  assert(typeof plan.projectId === 'string' && plan.projectId.trim() && typeof plan.chapterId === 'string' && plan.chapterId.trim(), '项目或章节标识为空');
  assert(typeof plan.sourceFingerprint === 'string' && plan.sourceFingerprint.trim(), '场景来源为空');
  assert(Number.isSafeInteger(plan.updatedAt) && plan.updatedAt >= 0, '场景更新时间无效');
  assert(Array.isArray(plan.scenes) && plan.scenes.length >= 1 && plan.scenes.length <= MAX_SCENES, '场景数量必须在 1–8 之间');
  const ids = new Set<string>(); let words = 0;
  plan.scenes.forEach(s => {
    sceneFrom(s); assert(s.id.trim() && s.id === s.id.trim() && s.id.length <= 128 && !ids.has(s.id), '场景 ID 为空、过长或重复'); ids.add(s.id);
    assert(s.title.trim() && s.goal.trim(), '场景标题和目标不能为空');
    sceneKeys.slice(1, 10).forEach(k => assert((s[k as keyof SceneSpec] as string).length <= 4_000, '场景约束过长'));
    assert(s.targetWords >= 100 && s.targetWords <= MAX_SCENE_WORDS, '场景目标字数超出限制'); words += s.targetWords;
    [s.requiredEvents, s.forbiddenEvents].forEach(events => {
      assert(events.length <= 16 && events.every(x => x.trim() && x.length <= 1_000) && new Set(events).size === events.length, '事件约束为空、过长或重复');
    });
    assert(!s.requiredEvents.some(x => s.forbiddenEvents.includes(x)), '必需与禁止事件矛盾');
  });
  assert(words <= MAX_CHAPTER_WORDS && JSON.stringify(plan).length <= 80_000, '场景计划超过总预算'); return plan;
}
export function isUnicodeBoundary(value: string, offset: number): boolean {
  return offset <= 0 || offset >= value.length || !(value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff && value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff);
}
const reviewKeys = ['sceneId', 'category', 'severity', 'quote', 'startOffset', 'endOffset', 'constraint', 'explanation', 'suggestion'];
export function parseReview(raw: string, plan: ChapterScenePlan, completed: CompletedScene[]): ReviewFinding[] {
  const root = object(strictJson(raw, 96_000)); exactKeys(root, ['findings']); assert(Array.isArray(root.findings), 'findings 必须是数组');
  return validateReview(root.findings as ReviewFinding[], plan, completed);
}
export function validateReview(findings: ReviewFinding[], plan: ChapterScenePlan, completed: CompletedScene[]): ReviewFinding[] {
  assert(Array.isArray(findings) && findings.length <= 48, '审稿意见数量超过限制');
  for (const f of findings) {
    const v = object(f); exactKeys(v, reviewKeys);
    reviewKeys.filter(k => k !== 'startOffset' && k !== 'endOffset').forEach(k => text(v[k], k));
    integer(f.startOffset, 'startOffset'); integer(f.endOffset, 'endOffset');
    assert(['FACT_CONFLICT', 'KNOWLEDGE_LEAK', 'MISSING_EVENT', 'STYLE', 'PACING', 'OTHER'].includes(f.category) && ['BLOCKING', 'WARNING', 'SUGGESTION'].includes(f.severity), '审稿分类或级别无效');
    const spec = plan.scenes.find(s => s.id === f.sceneId); const scene = completed.find(s => s.sceneId === f.sceneId);
    assert(spec && scene, '审稿引用未知或未完成场景');
    assert(f.quote.trim() && f.quote.length <= 2_000 && f.startOffset >= 0 && f.endOffset > f.startOffset && f.endOffset <= scene.body.length, '审稿证据位置无效');
    assert(isUnicodeBoundary(scene.body, f.startOffset) && isUnicodeBoundary(scene.body, f.endOffset) && scene.body.slice(f.startOffset, f.endOffset) === f.quote, '审稿证据与正文不匹配');
    assert(f.explanation.trim() && f.suggestion.trim() && f.explanation.length <= 4_000 && f.suggestion.length <= 4_000 && f.constraint.length <= 4_000, '审稿说明为空或过长');
    if (['STYLE', 'PACING', 'OTHER'].includes(f.category)) assert(f.severity === 'SUGGESTION', '文学偏好不能阻断采用');
    if (f.severity === 'BLOCKING') assert(f.constraint.trim() && [...spec.requiredEvents, ...spec.forbiddenEvents, spec.entryState, spec.exitState].includes(f.constraint), '阻断意见必须逐字引用明确约束');
  }
  return findings;
}
export function validateCheckpoint(c: WritingCheckpoint): WritingCheckpoint {
  validateScenePlan(c.plan);
  assert(typeof c.runId === 'string' && c.runId.trim() && Number.isSafeInteger(c.revision) && c.revision >= 0 && Number.isSafeInteger(c.requestCount) && c.requestCount >= 0, '任务标识或计数无效');
  assert(c.sourceFingerprint === c.plan.sourceFingerprint, '任务来源与计划不匹配');
  assert(['FAST', 'SCENES', 'POLISHED'].includes(c.mode) && ['PLANNED', 'RUNNING', 'INTERRUPTED', 'FAILED', 'COMPLETED'].includes(c.status), '任务模式或状态无效');
  assert(Array.isArray(c.completedScenes) && c.completedScenes.length <= c.plan.scenes.length, '场景草稿数量无效');
  let length = 0;
  c.completedScenes.forEach((s, i) => {
    assert(s.sceneId === c.plan.scenes[i].id && typeof s.body === 'string' && s.body.trim() && s.body.length <= 256_000 && s.exitState === c.plan.scenes[i].exitState && Number.isSafeInteger(s.completedAt) && s.completedAt >= 0, '已完成草稿必须是连续计划前缀'); length += s.body.length;
  });
  assert(length <= 1_000_000 && (c.status !== 'COMPLETED' || c.completedScenes.length === c.plan.scenes.length), '完成任务缺少场景或正文过长');
  assert(c.error === null || (typeof c.error === 'string' && c.error.length <= 2_000), '任务错误文本无效');
  assert(typeof c.chapterTask === 'string' && c.chapterTask.length <= 128_000 && typeof c.language === 'string' && c.language.trim() && c.language.length <= 32 && typeof c.baselineText === 'string' && c.baselineText.length <= 1_000_000, '任务原始输入无效');
  assert(typeof c.reviewCompleted === 'boolean' && (c.reviewCompleted || c.reviewFindings.length === 0), '未完成审稿含意见');
  assert(Number.isSafeInteger(c.updatedAt) && c.updatedAt >= 0, '任务更新时间无效');
  validateReview(c.reviewFindings, c.plan, c.completedScenes); return c;
}
/** Android archives can be inspected/imported, but retain their old hash and cannot silently resume. */
export function validateWritingArchive(archive: WritingArchive, projectId?: string): WritingArchive {
  assert(archive.version === 1 && Array.isArray(archive.plans) && Array.isArray(archive.checkpoints), '写作备份版本或结构无效');
  const plans = new Map<string, ChapterScenePlan>(); const runs = new Set<string>();
  for (const p of archive.plans) { validateScenePlan(p); assert(!projectId || p.projectId === projectId, '计划属于其他项目'); const key = JSON.stringify([p.projectId, p.chapterId]); assert(!plans.has(key), '重复场景计划'); plans.set(key, p); }
  const chapters = new Set<string>();
  for (const c of archive.checkpoints) { validateCheckpoint(c); const key = JSON.stringify([c.plan.projectId, c.plan.chapterId]); assert(!chapters.has(key) && !runs.has(c.runId), '重复场景任务'); chapters.add(key); runs.add(c.runId); assert(plans.has(key) && canonicalJson(plans.get(key)) === canonicalJson(c.plan), '任务缺少计划或计划不匹配'); }
  return archive;
}
