import { create } from 'zustand';
import { flushWritingPersistence, useAppStore } from '@store/index';
import { chapterApi, projectApi } from '@services/api';
import { adoptChapterCandidate, requestWriting } from '@services/writingApi';
import type { Chapter, TextModelConfig } from '@typings/index';
import {
  canonicalJson,
  createWritingPipeline,
  defaultWritingWorkspace,
  hashText,
  isValidCheckpointTransition,
  makeSourceFingerprint,
  selectStoryNotes,
  validateScenePlan,
  validateWorkspace,
  workspaceFingerprintMaterial,
  workspacePreferencePrompt,
  type ChapterScenePlan,
  type ReviewFinding,
  type StoryNote,
  type WritingArchive,
  type WritingCheckpoint,
  type WritingPersistence,
  type WritingRequest,
  type WritingRole,
  type WritingUsageEntry,
  type WritingWorkspace,
} from '../writing';

/** PC-specific candidates are preserved as a backup extension, not invalid Android GenerationRuns. */
export interface WorkspaceCandidate {
  schema: 'pc-workspace-candidate.v1';
  id: string;
  runId: string;
  projectId: string;
  chapterId: string;
  title: string;
  body: string;
  baselineText: string;
  expectedDraft: string;
  expectedFinal: string;
  sourceFingerprint: string;
  planHash?: string;
  findings: ReviewFinding[];
  status: 'generating' | 'pending' | 'accepted' | 'rejected';
  updatedAt: number;
  revisionRequests: number;
  sessionId?: string;
  adoptedText?: string;
  importedReadOnly?: boolean;
}
export interface WorkspaceJob {
  stage: string;
  preview: string;
  error?: string;
  active: boolean;
}
export const useWorkspaceJobs = create<{ jobs: Record<string, WorkspaceJob> }>(() => ({
  jobs: {},
}));
const controllers = new Map<string, AbortController>();
const reviewLocks = new Set<string>();
export function hasActiveWorkspaceTasks(): boolean {
  return controllers.size > 0 || reviewLocks.size > 0;
}
const keyOf = (pid: string, cid: string) => JSON.stringify([pid, cid]);
const emptyArchive = (): WritingArchive => ({ version: 1, plans: [], checkpoints: [] });
export const chapterBody = (chapter: Chapter): string =>
  chapter.final_text || chapter.draft_text || '';
export function getWorkspace(pid: string): WritingWorkspace {
  return useAppStore.getState().writingWorkspaceByProject[pid] ?? defaultWritingWorkspace();
}
export function getWorkspaceCandidates(pid: string): WorkspaceCandidate[] {
  const map = useAppStore.getState().backupExtensions.pcWritingCandidatesByProject;
  const list = map && typeof map === 'object' ? (map as Record<string, unknown>)[pid] : undefined;
  return Array.isArray(list)
    ? list.filter(
        (x): x is WorkspaceCandidate =>
          !!x &&
          x.schema === 'pc-workspace-candidate.v1' &&
          typeof x.id === 'string' &&
          typeof x.body === 'string' &&
          typeof x.expectedDraft === 'string' &&
          typeof x.expectedFinal === 'string' &&
          typeof x.sourceFingerprint === 'string' &&
          Array.isArray(x.findings)
      )
    : [];
}
function putCandidate(candidate: WorkspaceCandidate) {
  useAppStore.setState(state => {
    if (state.backupImportPending) throw new Error('备份导入中，暂不更新任务');
    const original = state.backupExtensions.pcWritingCandidatesByProject;
    const map =
      original && typeof original === 'object' && !Array.isArray(original)
        ? (original as Record<string, unknown>)
        : {};
    const list = Array.isArray(map[candidate.projectId])
      ? (map[candidate.projectId] as unknown[])
      : [];
    return {
      backupExtensions: {
        ...state.backupExtensions,
        pcWritingCandidatesByProject: {
          ...map,
          [candidate.projectId]: [
            ...list.filter(
              x => !x || typeof x !== 'object' || (x as { id?: string }).id !== candidate.id
            ),
            candidate,
          ],
        },
      },
    };
  });
}
function latest(archive: WritingArchive, cid: string): WritingCheckpoint | null {
  return (
    archive.checkpoints
      .filter(x => x.plan.chapterId === cid)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)[0] ?? null
  );
}
export function latestWorkspaceCheckpoint(pid: string, cid: string): WritingCheckpoint | null {
  return latest(useAppStore.getState().sceneWritingByProject[pid] ?? emptyArchive(), cid);
}
export function isWorkspaceActive(pid: string, cid: string) {
  return controllers.has(keyOf(pid, cid));
}
function setJob(pid: string, cid: string, job: WorkspaceJob) {
  useWorkspaceJobs.setState(s => ({ jobs: { ...s.jobs, [keyOf(pid, cid)]: job } }));
}
export function workspaceJobKey(pid: string, cid: string) {
  return keyOf(pid, cid);
}

/** All checkpoint CAS comparisons happen inside one synchronous Zustand update. */
export function createWorkspacePersistence(deferPlan = false): WritingPersistence {
  return {
    async load(pid, cid) {
      return latestWorkspaceCheckpoint(pid, cid);
    },
    async loadPlan(pid, cid) {
      return (
        useAppStore.getState().sceneWritingByProject[pid]?.plans.find(p => p.chapterId === cid) ??
        null
      );
    },
    async savePlan(plan) {
      if (deferPlan) return true; // Publish the generated plan atomically with its first checkpoint.
      let saved = false;
      useAppStore.setState(state => {
        if (state.backupImportPending) return state;
        const archive = state.sceneWritingByProject[plan.projectId] ?? emptyArchive();
        if (latest(archive, plan.chapterId)?.status === 'RUNNING') return state;
        saved = true;
        const replaced = archive.checkpoints.filter(
          c => c.plan.chapterId === plan.chapterId && canonicalJson(c.plan) !== canonicalJson(plan)
        );
        const rawHistory = state.backupExtensions.pcWritingDraftHistoryByProject;
        const history =
          rawHistory && typeof rawHistory === 'object' && !Array.isArray(rawHistory)
            ? (rawHistory as Record<string, unknown[]>)
            : {};
        return {
          sceneWritingByProject: {
            ...state.sceneWritingByProject,
            [plan.projectId]: {
              ...archive,
              plans: [
                ...archive.plans.filter(p => p.chapterId !== plan.chapterId),
                validateScenePlan(plan),
              ],
              checkpoints: archive.checkpoints.filter(
                c => !replaced.some(old => old.runId === c.runId)
              ),
            },
          },
          ...(replaced.length
            ? {
                backupExtensions: {
                  ...state.backupExtensions,
                  pcWritingDraftHistoryByProject: {
                    ...history,
                    [plan.projectId]: [
                      ...(Array.isArray(history[plan.projectId]) ? history[plan.projectId] : []),
                      ...replaced,
                    ],
                  },
                },
              }
            : {}),
        };
      });
      if (saved) await flushWritingPersistence();
      return saved;
    },
    async compareAndSet(expected, next) {
      let accepted = false;
      useAppStore.setState(state => {
        if (state.backupImportPending) return state;
        const pid = next.plan.projectId,
          cid = next.plan.chapterId;
        const archive = state.sceneWritingByProject[pid] ?? emptyArchive();
        if (
          canonicalJson(latest(archive, cid)) !== canonicalJson(expected) ||
          !isValidCheckpointTransition(expected, next)
        )
          return state;
        accepted = true;
        const old = latest(archive, cid);
        const rawHistory = state.backupExtensions.pcWritingDraftHistoryByProject;
        const history =
          rawHistory && typeof rawHistory === 'object' && !Array.isArray(rawHistory)
            ? (rawHistory as Record<string, unknown[]>)
            : {};
        return {
          sceneWritingByProject: {
            ...state.sceneWritingByProject,
            [pid]: {
              ...archive,
              plans: [...archive.plans.filter(p => p.chapterId !== cid), next.plan],
              checkpoints: [...archive.checkpoints.filter(c => c.plan.chapterId !== cid), next],
            },
          },
          ...(old && old.runId !== next.runId
            ? {
                backupExtensions: {
                  ...state.backupExtensions,
                  pcWritingDraftHistoryByProject: {
                    ...history,
                    [pid]: [...(Array.isArray(history[pid]) ? history[pid] : []), old],
                  },
                },
              }
            : {}),
        };
      });
      if (accepted) await flushWritingPersistence();
      return accepted;
    },
  };
}
function modelFor(workspace: WritingWorkspace, role: WritingRole): TextModelConfig {
  const state = useAppStore.getState();
  const id =
    role === 'planning'
      ? workspace.planningProfileId
      : role === 'review'
        ? workspace.reviewProfileId
        : workspace.writingProfileId;
  const profile = id ? state.textModelProfiles.find(p => p.id === id) : state.textModelConfig;
  if (!profile) throw new Error('指定的分工模型已删除，请在本书偏好中重新选择');
  if (!profile.model.trim() || !profile.apiUrl.trim())
    throw new Error('请先在设置中配置文本生成模型');
  return {
    provider: profile.provider,
    apiKey: profile.apiKey,
    apiUrl: profile.apiUrl,
    model: profile.model,
    temperature: profile.temperature,
  };
}
export async function buildWorkspaceSource(pid: string, cid: string) {
  const [project, all] = await Promise.all([projectApi.getById(pid), chapterApi.getByProject(pid)]);
  if (!project) throw new Error('项目不存在');
  const chapters = [...all].sort(
    (a, b) => a.order_index - b.order_index || a.id.localeCompare(b.id)
  );
  const chapter = chapters.find(c => c.id === cid);
  if (!chapter) throw new Error('章节不存在');
  const state = useAppStore.getState(),
    workspace = validateWorkspace(getWorkspace(pid));
  const characters = state.getCharacters(pid);
  const sourceHashes = Object.fromEntries(chapters.map(c => [c.id, hashText(chapterBody(c))]));
  const cards = selectStoryNotes(workspace, chapter, chapters, {
    sourceHashes,
    characterNames: Object.fromEntries(characters.map(c => [c.id, c.name])),
  });
  const previous = chapters.filter(c => c.order_index < chapter.order_index);
  const last = previous[previous.length - 1];
  const metadata = {
    project: {
      id: project.id,
      title: project.title,
      genre: project.genre,
      description: project.description,
      language: project.language,
    },
    outline: state.longNovelOutlineByProject[pid] ?? '',
    world: state.getWorldSetting(pid),
    timeline: state.getTimeline(pid),
    characters,
    arcs: state.plotArcsByProject[pid] ?? [],
    volumes: state.volumesByProject[pid] ?? [],
    realms: state.cultivationRealmsByProject[pid] ?? [],
  };
  const stableContext = [
    canonicalJson(metadata),
    workspacePreferencePrompt(workspace),
    cards.prompt,
    `已完成前章目录：${canonicalJson(previous.map(c => ({ title: c.title, goal: c.outline_goal, conflict: c.conflict, twist: c.twist })))}`,
    last
      ? `紧邻前章尾段（只用于衔接，不复制）：\n${chapterBody(last).slice(-6000)}`
      : '本章是开篇。',
  ].join('\n\n');
  const chapterTask = canonicalJson({
    title: chapter.title,
    goal: chapter.outline_goal || '按照本书大纲推进本章剧情',
    conflict: chapter.conflict,
    twist: chapter.twist,
    cliffhanger: chapter.cliffhanger,
  });
  const sourceFingerprint = makeSourceFingerprint({
    projectId: pid,
    chapterId: cid,
    chapterTask,
    stableContext,
    expectedDraft: chapter.draft_text ?? '',
    expectedFinal: chapter.final_text ?? '',
    previousSources: previous.map(c => [c.id, sourceHashes[c.id]]),
    workspace: workspaceFingerprintMaterial(workspace),
  });
  return {
    chapter,
    project,
    chapters,
    workspace,
    stableContext,
    chapterTask,
    sourceFingerprint,
    cards,
  };
}
export async function saveWorkspace(pid: string, workspace: WritingWorkspace) {
  if (useAppStore.getState().backupImportPending) throw new Error('备份导入中');
  const chapters = await chapterApi.getByProject(pid),
    ids = new Set(chapters.map(c => c.id));
  const characterIds = new Set(
    useAppStore
      .getState()
      .getCharacters(pid)
      .map(c => c.id)
  );
  const notes = workspace.notes.map(note => {
    if (note.sourceChapterId && !ids.has(note.sourceChapterId))
      throw new Error('故事卡的来源章节已删除，请重新指定');
    if (note.payoffChapterId && !ids.has(note.payoffChapterId))
      throw new Error('伏笔的回收章节已删除，请重新指定');
    if (note.knownByCharacterIds.some(id => !characterIds.has(id)))
      throw new Error('故事卡的知情角色已删除，请重新核对');
    const source = chapters.find(c => c.id === note.sourceChapterId);
    return source && !note.sourceBodyHash
      ? { ...note, sourceBodyHash: hashText(chapterBody(source)) }
      : note;
  });
  useAppStore.setState(state => {
    if (state.backupImportPending) throw new Error('备份导入中');
    return {
      writingWorkspaceByProject: {
        ...state.writingWorkspaceByProject,
        [pid]: validateWorkspace({ ...workspace, notes }),
      },
    };
  });
  await flushWritingPersistence();
}
export function storyNoteStatuses(notes: StoryNote[], chapters: Chapter[]): Record<string, string> {
  const hashes = Object.fromEntries(chapters.map(c => [c.id, hashText(chapterBody(c))]));
  return Object.fromEntries(
    notes.map(n => [
      n.id,
      n.sourceChapterId
        ? !hashes[n.sourceChapterId]
          ? '来源已删除'
          : !n.sourceBodyHash || n.sourceBodyHash !== hashes[n.sourceChapterId]
            ? '来源正文已变化，需核对后重新绑定'
            : '已绑定当前正文'
        : '作者维护，无正文来源',
    ])
  );
}
function usageRecorder(pid: string, cid: string, runId: string, parentRunId: string | null = null) {
  const entry: WritingUsageEntry = {
    runId,
    chapterId: cid,
    parentRunId,
    model: '',
    completedAt: new Date().toISOString(),
    requestCount: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
  };
  const publish = () =>
    useAppStore.setState(state => ({
      writingUsageByProject: {
        ...state.writingUsageByProject,
        [pid]: [
          ...(state.writingUsageByProject[pid] ?? []).filter(e => e.runId !== runId),
          { ...entry, completedAt: new Date().toISOString() },
        ],
      },
    }));
  return async (
    system: string,
    user: string,
    role: WritingRole,
    signal: AbortSignal,
    onDelta?: (delta: string) => void,
    format?: 'json' | 'text'
  ) => {
    const config = modelFor(getWorkspace(pid), role);
    entry.requestCount++;
    entry.model = config.model;
    try {
      const result = await requestWriting({
        system,
        user,
        textConfig: config,
        signal,
        onDelta,
        responseFormat: format,
        reasoningLevel: useAppStore.getState().agentReasoningLevel,
      });
      for (const field of ['promptTokens', 'completionTokens', 'cacheHitTokens'] as const) {
        const count = result.usage?.[field];
        entry[field] = entry[field] === null || count === undefined ? null : entry[field]! + count;
      }
      publish();
      return result;
    } catch (failure) {
      entry.failedRequests++;
      publish();
      throw failure;
    }
  };
}
function begin(pid: string, cid: string, external?: AbortSignal) {
  const key = keyOf(pid, cid);
  if (useAppStore.getState().backupImportPending) throw new Error('备份导入中，不能启动任务');
  if (controllers.has(key)) throw new Error('本章任务正在运行');
  if (external?.aborted) throw new DOMException('已中断', 'AbortError');
  const controller = new AbortController();
  controllers.set(key, controller);
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  setJob(pid, cid, { stage: '准备资料', preview: '', active: true });
  return {
    controller,
    finish: () => {
      external?.removeEventListener('abort', abort);
      if (controllers.get(key) === controller) controllers.delete(key);
      useWorkspaceJobs.setState(state => ({
        jobs: { ...state.jobs, [key]: { ...state.jobs[key], active: false } },
      }));
    },
  };
}
function requestFor(source: Awaited<ReturnType<typeof buildWorkspaceSource>>): WritingRequest {
  return {
    projectId: source.project.id,
    chapterId: source.chapter.id,
    chapterTask: source.chapterTask,
    stableContext: source.stableContext,
    sourceFingerprint: source.sourceFingerprint,
    mode:
      source.workspace.mode === 'quick'
        ? 'FAST'
        : source.workspace.mode === 'polish'
          ? 'POLISHED'
          : 'SCENES',
    language: source.project.language ?? 'zh',
    maxRequests: source.workspace.maxRequestsPerRun,
    baselineText: '',
    currentSourceFingerprint: async () =>
      (await buildWorkspaceSource(source.project.id, source.chapter.id)).sourceFingerprint,
  };
}
export async function generateWorkspaceScenePlan(
  pid: string,
  cid: string
): Promise<ChapterScenePlan> {
  if (latestWorkspaceCheckpoint(pid, cid)?.status === 'RUNNING')
    throw new Error('请先暂停或诊断本章已有任务，再重新规划');
  const job = begin(pid, cid),
    runId = crypto.randomUUID();
  try {
    const source = await buildWorkspaceSource(pid, cid),
      request = usageRecorder(pid, cid, runId);
    const pipeline = createWritingPipeline({
      request: (system, user, role, signal, _purpose, format) =>
        request(system, user, role, signal, undefined, format),
      persistence: createWorkspacePersistence(),
    });
    const plan = await pipeline.plan(requestFor(source), job.controller.signal);
    if (!(await createWorkspacePersistence().savePlan(plan)))
      throw new Error('计划未保存；请先暂停已有任务再重新规划');
    setJob(pid, cid, { stage: '场景计划已保存', active: false, preview: '' });
    return plan;
  } catch (failure) {
    setJob(pid, cid, { stage: '规划中断', active: false, preview: '', error: String(failure) });
    throw failure;
  } finally {
    job.finish();
  }
}
export async function saveWorkspaceScenePlan(plan: ChapterScenePlan) {
  if (isWorkspaceActive(plan.projectId, plan.chapterId))
    throw new Error('运行期间不能修改场景计划');
  const current = await buildWorkspaceSource(plan.projectId, plan.chapterId);
  if (current.sourceFingerprint !== plan.sourceFingerprint)
    throw new Error('计划来源已过期，请重新规划；旧计划不会强行绑定新资料');
  if (
    !(await createWorkspacePersistence().savePlan({
      ...validateScenePlan(plan),
      updatedAt: Date.now(),
    }))
  )
    throw new Error('计划未保存，请稍后重试');
}
export async function generateWorkspaceChapter(
  pid: string,
  cid: string,
  options: {
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
    initiator?: string;
    sessionId?: string;
    resumeRunId?: string;
  } = {}
): Promise<WorkspaceCandidate & { candidateId: string }> {
  const job = begin(pid, cid, options.signal),
    runId = crypto.randomUUID();
  let record: WorkspaceCandidate | undefined;
  try {
    const source = await buildWorkspaceSource(pid, cid),
      request = usageRecorder(pid, cid, runId, options.resumeRunId ?? null);
    const saved = options.resumeRunId ? latestWorkspaceCheckpoint(pid, cid) : null;
    if (options.resumeRunId && (!saved || saved.runId !== options.resumeRunId))
      throw new Error('待恢复的确切任务已不存在，请刷新后选择新任务；不会静默重新生成');
    const requestInput = requestFor(source);
    if (saved) {
      requestInput.mode = saved.mode;
      requestInput.plan = saved.plan;
      requestInput.resumeRunId = options.resumeRunId;
    }
    record = {
      schema: 'pc-workspace-candidate.v1',
      id: crypto.randomUUID(),
      runId,
      projectId: pid,
      chapterId: cid,
      title: source.chapter.title,
      expectedDraft: source.chapter.draft_text ?? '',
      expectedFinal: source.chapter.final_text ?? '',
      baselineText: chapterBody(source.chapter),
      body: '',
      sourceFingerprint: source.sourceFingerprint,
      findings: [],
      status: 'generating',
      updatedAt: Date.now(),
      revisionRequests: 0,
      sessionId: options.sessionId,
    };
    putCandidate(record);
    await flushWritingPersistence();
    const pipeline = createWritingPipeline({
      request: (system, user, role, signal, _purpose, format) =>
        request(system, user, role, signal, options.onDelta, format),
      persistence: createWorkspacePersistence(true),
      newRunId: () => runId,
    });
    const result = await pipeline.run(requestInput, job.controller.signal, progress => {
      setJob(pid, cid, {
        stage: progress.stage,
        active: true,
        preview: progress.preview?.slice(-2400) ?? '',
      });
    });
    record = {
      ...record,
      runId: result.checkpoint.runId,
      planHash: hashText(canonicalJson(result.checkpoint.plan)),
      body: result.fullBody,
      findings: result.findings,
      status: 'pending',
      updatedAt: Date.now(),
    };
    putCandidate(record);
    await flushWritingPersistence();
    setJob(pid, cid, { stage: '候选已完成，等待审核', active: false, preview: '' });
    return { ...record, candidateId: record.id };
  } catch (failure) {
    if (record) putCandidate({ ...record, status: 'rejected', updatedAt: Date.now() });
    setJob(pid, cid, {
      stage: job.controller.signal.aborted ? '已暂停，已完成场景仍保留' : '任务失败',
      active: false,
      preview: '',
      error: failure instanceof Error ? failure.message : String(failure),
    });
    throw failure;
  } finally {
    job.finish();
  }
}
export async function pauseWorkspaceTask(pid: string, cid: string) {
  const controller = controllers.get(keyOf(pid, cid));
  if (controller) {
    controller.abort();
    return;
  }
  const current = latestWorkspaceCheckpoint(pid, cid);
  if (current?.status === 'RUNNING') {
    const next = {
      ...current,
      status: 'INTERRUPTED' as const,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      error: '进程中没有对应运行请求，任务已标记为中断；可显式恢复',
    };
    if (!(await createWorkspacePersistence().compareAndSet(current, next)))
      throw new Error('任务已变化，请刷新后重试');
  }
}
export async function cancelWorkspaceTask(pid: string, cid: string) {
  await pauseWorkspaceTask(pid, cid);
  setJob(pid, cid, { stage: '已停止；场景草稿保留，只读可查看', active: false, preview: '' });
}
export async function reviewWorkspaceCandidate(
  pid: string,
  candidateId: string,
  decision: 'accept' | 'reject',
  selectedText?: string
): Promise<{ accepted: boolean; rejected: boolean; candidateId: string }> {
  const candidate = getWorkspaceCandidates(pid).find(c => c.id === candidateId);
  if (!candidate) throw new Error('候选已不存在');
  if (candidate.importedReadOnly)
    throw new Error('外来或恢复的候选仅供只读核对，请根据当前资料重新生成');
  if (candidate.status === 'accepted' && decision === 'accept') {
    await flushWritingPersistence();
    return { accepted: true, rejected: false, candidateId };
  }
  if (candidate.status === 'rejected' && decision === 'reject') {
    await flushWritingPersistence();
    return { accepted: false, rejected: true, candidateId };
  }
  if (candidate.status !== 'pending') throw new Error('候选已经处理，不能重复审核');
  if (reviewLocks.has(candidateId)) throw new Error('候选正在处理');
  reviewLocks.add(candidateId);
  try {
    if (decision === 'reject') {
      putCandidate({ ...candidate, status: 'rejected', updatedAt: Date.now() });
      await flushWritingPersistence();
      return { accepted: false, rejected: true, candidateId };
    }
    const body = selectedText ?? candidate.body;
    if (!body.trim() || body === candidate.baselineText) throw new Error('没有可采用的正文变化');
    if (body.length > 1_000_000) throw new Error('候选正文过长');
    const source = await buildWorkspaceSource(pid, candidate.chapterId);
    if (source.sourceFingerprint !== candidate.sourceFingerprint)
      throw new Error('章节正文或创作资料已变化，不能覆盖当前版本；请重新生成或手动核对');
    const plan = useAppStore
      .getState()
      .sceneWritingByProject[pid]?.plans.find(p => p.chapterId === candidate.chapterId);
    if (candidate.planHash && (!plan || hashText(canonicalJson(plan)) !== candidate.planHash))
      throw new Error('生成时的场景计划已被修改，请根据新计划重新生成');
    if (
      canonicalJson(getWorkspaceCandidates(pid).find(c => c.id === candidateId)) !==
      canonicalJson(candidate)
    )
      throw new Error('候选已处理或修订，请重新审核');
    await adoptChapterCandidate({
      projectId: pid,
      chapterId: candidate.chapterId,
      expectedDraft: candidate.expectedDraft,
      expectedFinal: candidate.expectedFinal,
      body,
    });
    putCandidate({ ...candidate, status: 'accepted', adoptedText: body, updatedAt: Date.now() });
    useAppStore.getState().bumpChaptersVersion();
    await flushWritingPersistence();
    return { accepted: true, rejected: false, candidateId };
  } finally {
    reviewLocks.delete(candidateId);
  }
}
export async function reviseWorkspaceCandidate(
  pid: string,
  candidateId: string,
  instruction: string
) {
  const candidate = getWorkspaceCandidates(pid).find(c => c.id === candidateId);
  if (!candidate || candidate.status !== 'pending' || candidate.importedReadOnly)
    throw new Error('候选已处理、只读或不存在');
  if (reviewLocks.has(candidateId)) throw new Error('候选正在审核或修订');
  if (!instruction.trim() || instruction.length > 4000)
    throw new Error('请填写不超过4000字的修改意见');
  const job = begin(pid, candidate.chapterId);
  reviewLocks.add(candidateId);
  try {
    const source = await buildWorkspaceSource(pid, candidate.chapterId);
    if (source.sourceFingerprint !== candidate.sourceFingerprint)
      throw new Error('来源已变化，请重新生成');
    const currentPlan = useAppStore
      .getState()
      .sceneWritingByProject[pid]?.plans.find(plan => plan.chapterId === candidate.chapterId);
    if (
      candidate.planHash &&
      (!currentPlan || hashText(canonicalJson(currentPlan)) !== candidate.planHash)
    )
      throw new Error('场景计划已经改变，不能继续修订旧候选，请重新生成');
    const spent = latestWorkspaceCheckpoint(pid, candidate.chapterId)?.requestCount ?? 0;
    if (
      source.stableContext.length +
        source.chapterTask.length +
        candidate.body.length +
        instruction.length >
      120_000
    )
      throw new Error('完整修订输入超过当前预算，请缩小章节或使用局部编辑；不会截去正文');
    if (spent + candidate.revisionRequests >= source.workspace.maxRequestsPerRun)
      throw new Error('本次任务请求配额已用完，可提高配额后重试');
    const reserved = { ...candidate, revisionRequests: candidate.revisionRequests + 1 };
    putCandidate(reserved);
    await flushWritingPersistence();
    const request = usageRecorder(pid, candidate.chapterId, crypto.randomUUID(), candidate.runId);
    const result = await request(
      '你是小说正文修订编辑。只返回完整修订后的正文，不附说明、JSON或代码围栏。不删除未要求修改的内容，遵守作者设定与角色知情边界。',
      `${source.stableContext}\n本章任务：${source.chapterTask}\n作者修改意见：${instruction}\n待修订完整候选：\n${candidate.body}`,
      'writing',
      job.controller.signal
    );
    if (result.finishReason === 'length')
      throw new Error('修订正文被截断，原候选保持不变；请缩小修改范围或调整模型输出限制');
    if (!result.text.trim() || result.text.length > 1_000_000)
      throw new Error('修订结果为空或过长');
    if (
      (await buildWorkspaceSource(pid, candidate.chapterId)).sourceFingerprint !==
      candidate.sourceFingerprint
    )
      throw new Error('修订期间来源变化，原候选保持不变');
    if (getWorkspaceCandidates(pid).find(c => c.id === candidateId)?.status !== 'pending')
      throw new Error('候选已被处理');
    putCandidate({ ...reserved, body: result.text, findings: [], updatedAt: Date.now() });
    await flushWritingPersistence();
    setJob(pid, candidate.chapterId, {
      stage: '修订候选待审核（未经再次约束审稿）',
      active: false,
      preview: '',
    });
  } catch (failure) {
    setJob(pid, candidate.chapterId, {
      stage: '修订失败',
      active: false,
      preview: '',
      error: String(failure),
    });
    throw failure;
  } finally {
    job.finish();
    reviewLocks.delete(candidateId);
  }
}
