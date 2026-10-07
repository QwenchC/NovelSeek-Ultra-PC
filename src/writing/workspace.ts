import type { StoryNote, WritingWorkspace } from './models';
import { assert } from './protocol';

export function validateStoryNote(note: StoryNote): StoryNote {
  assert(typeof note.id === 'string' && note.id.trim() && note.id.length <= 128, '故事卡片 ID 无效');
  assert(['canon', 'plan', 'fact', 'belief', 'foreshadowing'].includes(note.kind), '故事卡片分类无效');
  assert(typeof note.subject === 'string' && note.subject.length <= 256 && typeof note.text === 'string' && note.text.trim() && note.text.length <= 12_000, '故事卡片内容为空或过长');
  assert(Number.isInteger(note.importance) && note.importance >= 1 && note.importance <= 3 && Array.isArray(note.knownByCharacterIds) && note.knownByCharacterIds.length <= 100 && note.knownByCharacterIds.every(x => typeof x === 'string' && x.trim()), '故事卡片重要程度或知情人无效');
  assert(typeof note.resolved === 'boolean', '伏笔回收状态无效');
  assert(note.sourceChapterId === null || (typeof note.sourceChapterId === 'string' && note.sourceChapterId.trim()), '来源章节无效');
  assert(note.payoffChapterId === null || (typeof note.payoffChapterId === 'string' && note.payoffChapterId.trim()), '回收章节无效');
  assert(note.kind !== 'fact' || note.sourceChapterId, '已发生事实必须关联来源章节');
  assert(note.sourceBodyHash === null || /^[a-f0-9]{64}$/.test(note.sourceBodyHash), '来源正文摘要无效'); return note;
}
export function validateWorkspace(workspace: WritingWorkspace): WritingWorkspace {
  assert(workspace.version === 1 && ['quick', 'scene', 'polish'].includes(workspace.mode), '工作台版本或模式无效');
  assert(Number.isInteger(workspace.maxRequestsPerRun) && workspace.maxRequestsPerRun >= 1 && workspace.maxRequestsPerRun <= 64, '单任务请求上限必须是 1–64');
  [workspace.style, workspace.perspective, workspace.forbiddenExpressions, workspace.sampleProse].forEach(x => assert(typeof x === 'string' && x.length <= 12_000, '写作偏好过长'));
  [workspace.planningProfileId, workspace.writingProfileId, workspace.reviewProfileId, workspace.extractionProfileId].forEach(x => assert(x === null || typeof x === 'string', '模型档案标识无效'));
  assert(Array.isArray(workspace.notes) && workspace.notes.length <= 2_000 && new Set(workspace.notes.map(n => n.id)).size === workspace.notes.length, '故事卡片过多或 ID 重复');
  workspace.notes.forEach(validateStoryNote);
  assert(workspace.notes.reduce((n, x) => n + x.subject.length + x.text.length, 0) <= 300_000, '故事卡片总量超过 30 万字符'); return workspace;
}
/** Model routing, quota and working mode are operational, not story content. */
export function workspaceFingerprintMaterial(workspace: WritingWorkspace): unknown {
  validateWorkspace(workspace);
  return { style: workspace.style, perspective: workspace.perspective, forbiddenExpressions: workspace.forbiddenExpressions,
    sampleProse: workspace.sampleProse, notes: [...workspace.notes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
export function workspacePreferencePrompt(workspace: WritingWorkspace): string {
  return [workspace.style && `文风与节奏：${workspace.style}`, workspace.perspective && `叙述人称与视角：${workspace.perspective}`,
    workspace.forbiddenExpressions && `避免的表达：${workspace.forbiddenExpressions}`, workspace.sampleProse && `作者认可的文风样例（仅学习表达，不复制剧情）：\n${workspace.sampleProse}`].filter(Boolean).join('\n');
}
export interface StoryChapter { id: string; title: string; order_index: number }
export interface SelectedStoryNotes { prompt: string; includedIds: string[]; excludedIds: string[]; exclusionReasons: Record<string, string> }
export function selectStoryNotes(workspace: WritingWorkspace, chapter: StoryChapter, chapters: StoryChapter[], options: {
  maxChars?: number; sourceHashes?: Record<string, string>; characterNames?: Record<string, string>;
} = {}): SelectedStoryNotes {
  validateWorkspace(workspace); const maxChars = options.maxChars ?? 12_000;
  assert(Number.isSafeInteger(maxChars) && maxChars >= 0, '故事卡预算无效');
  const byId = new Map(chapters.map(x => [x.id, x]));
  const result: SelectedStoryNotes = { prompt: '', includedIds: [], excludedIds: [], exclusionReasons: {} };
  const eligible: { note: StoryNote; rendered: string }[] = [];
  const exclude = (n: StoryNote, reason: string) => { result.excludedIds.push(n.id); Object.defineProperty(result.exclusionReasons, n.id, { value: reason, enumerable: true, configurable: true }); };
  for (const note of [...workspace.notes].sort((a, b) => Number(b.payoffChapterId === chapter.id) - Number(a.payoffChapterId === chapter.id) || b.importance - a.importance || a.id.localeCompare(b.id))) {
    const source = note.sourceChapterId ? byId.get(note.sourceChapterId) : undefined;
    const visible = note.kind === 'fact' || note.kind === 'belief' ? source && source.order_index < chapter.order_index : note.kind === 'foreshadowing' ? !note.resolved && (!note.sourceChapterId || (source && source.order_index < chapter.order_index)) : true;
    if (!visible) { exclude(note, '尚未发生、来源缺失或已回收'); continue; }
    if (options.characterNames && note.knownByCharacterIds.some(x => !Object.prototype.hasOwnProperty.call(options.characterNames, x))) { exclude(note, '知情角色已删除，需重新核对'); continue; }
    if (options.sourceHashes && note.sourceChapterId && (!note.sourceBodyHash || note.sourceBodyHash !== options.sourceHashes[note.sourceChapterId])) { exclude(note, '来源正文已变化，需重新核对卡片'); continue; }
    const label = note.kind === 'canon' ? '作者设定（不代表角色已知）' : note.kind === 'plan' ? '未来计划（不能当作已发生事实）' : note.kind === 'fact' ? `已发生事实，来源：${source?.title}` : note.kind === 'belief' ? '角色的认知/误解，不代表客观事实' : '未回收伏笔';
    let rendered = `[${label}] ${note.subject}: ${note.text}\n`;
    if (note.knownByCharacterIds.length) rendered += `知情角色：${note.knownByCharacterIds.map(x => options.characterNames?.[x] ?? x).join('、')}；其他角色不可直接获知\n`;
    if (note.payoffChapterId) rendered += `计划回收章节：${byId.get(note.payoffChapterId)?.title ?? '未知章节'}\n`;
    if (note.payoffChapterId === chapter.id) rendered += '本章应处理此伏笔\n';
    eligible.push({ note, rendered });
  }
  const mandatory = (n: StoryNote) => n.kind === 'canon' || n.payoffChapterId === chapter.id;
  // Reserve all mandatory cards first; an optional high-priority card may not crowd out canon.
  const requiredChars = eligible.filter(x => mandatory(x.note)).reduce((n, x) => n + x.rendered.length, 0);
  assert(requiredChars <= maxChars, '本章必需故事卡片超过上下文预算，请精简设定或扩大上下文');
  let optionalRemaining = maxChars - requiredChars;
  for (const { note, rendered } of eligible) {
    if (!mandatory(note) && rendered.length > optionalRemaining) { exclude(note, '本次可选上下文预算不足'); continue; }
    if (!mandatory(note)) optionalRemaining -= rendered.length;
    result.prompt += rendered; result.includedIds.push(note.id);
  }
  return result;
}
