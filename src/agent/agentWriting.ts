import { useAppStore, flushWritingPersistence } from '../store';
import { requestWriting } from '../services/writingApi';
import { buildWorkspaceSource, getWorkspaceCandidates, type WorkspaceCandidate } from '../writingUi/workspaceRuntime';
import type { Chapter } from '../types';
import type { AgentToolCtx } from './agentTools';

/** Every agent prose change is a source-bound candidate. Even an exact replacement is reviewed. */
export async function proposeAgentBody(pid: string, chapter: Chapter, ctx: AgentToolCtx, bodyOrInstruction: string, revise = false): Promise<string> {
  if (ctx.signal?.aborted) throw new DOMException('已中断', 'AbortError');
  const source = await buildWorkspaceSource(pid, chapter.id);
  if ((source.chapter.draft_text || '') !== (chapter.draft_text || '') || (source.chapter.final_text || '') !== (chapter.final_text || '')) throw new Error('正文已变化，请重读后再修改');
  let body = bodyOrInstruction;
  const runId = crypto.randomUUID();
  if (revise) {
    if (!bodyOrInstruction.trim() || bodyOrInstruction.length > 12_000) throw new Error('修订意见为空或过长');
    const state = useAppStore.getState();
    const profileId = source.workspace.reviewProfileId;
    const config = profileId ? state.textModelProfiles.find(profile => profile.id === profileId) : state.textModelConfig;
    if (!config) throw new Error('审稿模型已删除，请在本书偏好重新选择');
    const result = await requestWriting({
      system: '按作者意见修订小说正文。严格遵循创作资料，不改变未被要求修改的情节；只输出完整修订正文，无解释。',
      user: `${source.stableContext}\n本章任务：${source.chapterTask}\n作者意见：${bodyOrInstruction}\n正文：\n${source.chapter.final_text || source.chapter.draft_text || ''}`,
      textConfig: config, signal: ctx.signal, reasoningLevel: state.agentReasoningLevel, responseFormat: 'text',
    });
    useAppStore.setState(current => ({ writingUsageByProject: { ...current.writingUsageByProject,
      [pid]: [...(current.writingUsageByProject[pid] || []), { runId, model: config.model, completedAt: new Date().toISOString(), requestCount: 1,
        promptTokens: result.usage?.promptTokens ?? null, completionTokens: result.usage?.completionTokens ?? null, cacheHitTokens: result.usage?.cacheHitTokens ?? null,
        failedRequests: 0, chapterId: chapter.id, parentRunId: null }] } }));
    if (result.finishReason !== 'stop') throw new Error('修订输出被截断，未覆盖正文；请拆分修订范围');
    body = result.text;
  }
  if (ctx.signal?.aborted) throw new DOMException('已中断', 'AbortError');
  if (!body.trim() || body.length > 1_000_000) throw new Error('候选正文为空或过长；整章删除请使用专门的删除操作');
  if ((await buildWorkspaceSource(pid, chapter.id)).sourceFingerprint !== source.sourceFingerprint) throw new Error('生成期间正文或设定变化，未写入候选');
  const record: WorkspaceCandidate = { schema: 'pc-workspace-candidate.v1', id: crypto.randomUUID(), runId,
    projectId: pid, chapterId: chapter.id, title: chapter.title, body, baselineText: chapter.final_text || chapter.draft_text || '',
    expectedDraft: chapter.draft_text || '', expectedFinal: chapter.final_text || '', sourceFingerprint: source.sourceFingerprint,
    findings: [], status: 'pending', updatedAt: Date.now(), revisionRequests: revise ? 1 : 0, sessionId: ctx.sessionId };
  useAppStore.setState(state => {
    if (state.backupImportPending) throw new Error('备份正在恢复，候选未提交');
    const raw = state.backupExtensions.pcWritingCandidatesByProject;
    const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return { backupExtensions: { ...state.backupExtensions, pcWritingCandidatesByProject: { ...map, [pid]: [...getWorkspaceCandidates(pid), record] } } };
  });
  await flushWritingPersistence();
  return JSON.stringify({ resultKind: 'pending_review', projectId: pid, chapterId: chapter.id, runId, candidateId: record.id, message: '修改候选已保存，等待用户审核，正文未覆盖。' });
}
