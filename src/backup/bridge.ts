import type { AgentSession, AgentStepRole } from '../store';
import type { SessionMetrics } from '../agent/agentPolicy';
import { validateWritingArchive } from '../writing/protocol';
import { validateWorkspace } from '../writing/workspace';
import type { WritingArchive, WritingWorkspace } from '../writing/models';
import type { ExportNovelContent, ImportChapterFull, ImportNovelContentInput } from '../services/api';
import { isRecord, validateBundle, type BackupBundle } from './archive';

const EXCLUDED_MAPS = new Set(['kbIndexHashByProject', 'kbStaleByProject', 'summariesByProject', 'novelChatsByProject', 'chaptersByProject']);
export const PC_SETTINGS_FIELDS = ['textModelProfiles', 'activeTextModelProfileId', 'textModelConfig',
  'pollinationsKey', 'imageEngine', 'comfyUIUrl', 'embeddingConfig', 'knowledgeBaseEnabled',
  'summariesEnabled', 'entitiesEnabled', 'theme', 'uiLanguage', 'agentEngine', 'agentReasoningLevel',
  'agentContextBudget', 'agentMaxSteps'] as const;
const AGENT_FIELDS = ['agentSessionMetrics', 'agentSessionContextSummaries'] as const;
export interface BackupSummary {
  projectIdsInBackup: number; projectIdsInStore: number; projectIdsOverlap: number;
  chapterPromosInBackup: number; chaptersInBackup: number; sessionsInBackup: number; hasAppSettings: boolean;
}
function copy<T>(value: T): T { return structuredClone(value); }
function maps(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter(k => k.endsWith('ByProject') && !EXCLUDED_MAPS.has(k));
}
function projectsIn(obj: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const key of [...maps(obj), 'chaptersByProject']) if (isRecord(obj[key])) Object.keys(obj[key]).forEach(id => ids.add(id));
  if (Array.isArray(obj.projects)) for (const p of obj.projects) if (isRecord(p) && typeof p.id === 'string') ids.add(p.id);
  return ids;
}
export function summarizeBackup(bundle: BackupBundle, current: Record<string, unknown>): BackupSummary {
  const incoming = projectsIn(bundle.data), existing = projectsIn(current);
  return { projectIdsInBackup: incoming.size, projectIdsInStore: existing.size,
    projectIdsOverlap: [...incoming].filter(id => existing.has(id)).length,
    chapterPromosInBackup: isRecord(bundle.data.promoByChapter) ? Object.keys(bundle.data.promoByChapter).length : 0,
    chaptersInBackup: isRecord(bundle.data.chaptersByProject) ? Object.values(bundle.data.chaptersByProject).reduce<number>((n, items) => n + (Array.isArray(items) ? items.length : 0), 0) : 0,
    sessionsInBackup: isRecord(bundle.data.agentSessions) ? Object.keys(bundle.data.agentSessions).length : 0,
    // Android settings are opaque extensions, never applied to this device's own configuration.
    hasAppSettings: isRecord(bundle.data.pcSettings) || (/^2\./.test(bundle.appVersion || '') && PC_SETTINGS_FIELDS.some(k => k in bundle.data)) };
}
/** Only known credentials are redacted; story notes, prose and arbitrary `key` fields stay intact. */
function redactSettings(settings: Record<string, unknown>): void {
  for (const key of ['textModelConfig', 'embeddingConfig']) if (isRecord(settings[key])) settings[key].apiKey = '';
  if (Array.isArray(settings.textModelProfiles)) for (const profile of settings.textModelProfiles) if (isRecord(profile)) profile.apiKey = '';
  if ('pollinationsKey' in settings) settings.pollinationsKey = '';
}
function normalizeImages(data: Record<string, unknown>, raw: boolean): void {
  const fix = (value: unknown) => {
    if (!isRecord(value)) return;
    for (const key of ['imageBase64', 'portraitBase64']) if (typeof value[key] === 'string' && value[key]) {
      const image = value[key] as string;
      value[key] = raw ? image.replace(/^data:[^;,]*;base64,/, '') : image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
    }
  };
  for (const key of ['charactersByProject', 'chapterIllustrations']) if (isRecord(data[key])) {
    for (const list of Object.values(data[key])) if (Array.isArray(list)) list.forEach(fix);
  }
  if (isRecord(data.promoByChapter)) Object.values(data.promoByChapter).forEach(fix);
  if (Array.isArray(data.projects)) for (const project of data.projects) if (isRecord(project) && typeof project.cover_images === 'string' && project.cover_images) {
    let covers: unknown;
    try { covers = JSON.parse(project.cover_images); } catch { throw new Error(`项目 ${String(project.id)} 的封面数据损坏，已停止备份`); }
    if (!Array.isArray(covers)) throw new Error('项目封面必须是数组');
    covers.forEach(fix); project.cover_images = JSON.stringify(covers);
  }
}
const androidToPc: Record<string, AgentStepRole> = {
  user: 'user', thought: 'thought', action: 'tool', observation: 'result', message: 'final',
  question: 'ask', answer: 'result', error: 'error', image: 'image', plan: 'thought', context_summary: 'thought',
};
const pcToAndroid: Record<AgentStepRole, string> = { user: 'user', thought: 'thought', tool: 'action', result: 'observation', final: 'message', ask: 'question', error: 'error', image: 'image' };
function importedSession(raw: Record<string, unknown>, id: string): AgentSession {
  if (raw.id !== id || !Array.isArray(raw.steps)) throw new Error(`智能体会话 ${id} 格式不正确`);
  const stepIds = new Set<string>();
  const steps = raw.steps.map(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || (typeof item.text !== 'string' && typeof item.content !== 'string')) throw new Error(`智能体会话 ${id} 的步骤格式不正确`);
    safeId(item.id, '会话步骤'); if (stepIds.has(item.id)) throw new Error('会话步骤 ID 重复'); stepIds.add(item.id);
    for (const key of ['tool', 'image']) if (item[key] !== undefined && typeof item[key] !== 'string') throw new Error(`会话步骤 ${key} 必须是文本`);
    const role = typeof item.role === 'string' && Object.prototype.hasOwnProperty.call(pcToAndroid, item.role)
      ? item.role as AgentStepRole : typeof item.type === 'string' && Object.prototype.hasOwnProperty.call(androidToPc, item.type) ? androidToPc[item.type] : 'result';
    return { ...item, id: item.id, role, content: typeof item.content === 'string' ? item.content : item.text as string,
      ...(item.actionStatus === 'running' ? { actionStatus: 'interrupted' } : {}) };
  });
  const checkpoint = isRecord(raw.runCheckpoint) ? { ...raw.runCheckpoint, phase: 'idle', recoveryPending: false } : raw.runCheckpoint;
  return { ...raw, id, title: typeof raw.title === 'string' ? raw.title : '', createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '', steps,
    lockedProjectId: typeof raw.lockedProjectId === 'string' ? raw.lockedProjectId : null, autoApprove: false,
    runStatus: raw.runStatus === 'running' ? 'interrupted' : typeof raw.runStatus === 'string' ? raw.runStatus : 'idle', runCheckpoint: checkpoint,
    importedFromBackup: true, importedReadOnly: true } as AgentSession;
}
/** Keep Android action IDs, plan IDs, result attribution, review links and future extension fields. */
function exportSession(session: AgentSession, original: unknown): Record<string, unknown> {
  const previous = isRecord(original) ? original : {};
  const raw = session as unknown as Record<string, unknown>;
  const oldSteps = new Map((Array.isArray(previous.steps) ? previous.steps : []).filter(isRecord).map(step => [step.id, step]));
  const steps = session.steps.map(step => {
    const old = oldSteps.get(step.id) || {}, current = step as unknown as Record<string, unknown>;
    // Preserve Android's finer answer/plan step type when its corresponding PC role is unchanged.
    const safeRole: AgentStepRole = Object.prototype.hasOwnProperty.call(pcToAndroid, step.role) ? step.role : 'result';
    const type = typeof current.type === 'string' && (!Object.prototype.hasOwnProperty.call(androidToPc, current.type) || androidToPc[current.type] === safeRole) ? current.type : pcToAndroid[safeRole];
    return { ...old, ...current, type, text: step.content, tool: step.tool || '', image: step.image || '', createdAt: current.createdAt || old.createdAt || '' };
  });
  return { ...previous, ...raw, steps,
    engineMode: raw.engineMode || (raw.engine === 'structured' ? 'dual' : 'classic'),
    reasoningLevel: raw.reasoningLevel || 'medium',
    cacheMetrics: raw.cacheMetrics || previous.cacheMetrics || { observedRequests: 0, hitTokens: 0, missTokens: 0 } };
}
const nonnegative = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function importedMetrics(raw: Record<string, unknown>): SessionMetrics | null {
  if (!isRecord(raw.cacheMetrics)) return null;
  const cache = raw.cacheMetrics;
  const hit = nonnegative(cache.hitTokens), miss = nonnegative(cache.missTokens);
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const known = ['observedRequests', 'hitTokens', 'missTokens'].every(key => typeof cache[key] === 'number' && Number.isSafeInteger(cache[key]) && (cache[key] as number) >= 0) && Number.isSafeInteger(hit + miss);
  return { measuredRequests: known ? nonnegative(cache.observedRequests) : 0, cacheHitTokens: known ? hit : 0,
    promptTokens: known ? hit + miss : 0, completionTokens: 0, unknownRequests: known ? 0 : Math.max(1, nonnegative(cache.observedRequests)),
    contextTokens: 0, contextBudget: 32_000,
    ...(typeof memory.summary === 'string' && memory.summary.length <= 128_000 ? { summary: memory.summary } : {}),
    ...(typeof memory.compactedThroughStepId === 'string' && memory.compactedThroughStepId.length <= 1000 ? { coveredStepId: memory.compactedThroughStepId } : {}),
    ...(typeof memory.compactedPrefixDigest === 'string' && /^[a-f0-9]{64}$/.test(memory.compactedPrefixDigest) ? { coveredDigest: memory.compactedPrefixDigest } : {}) };
}

/** A failed SQLite read must reject before a download can be produced. */
export function buildBackupBundle(state: Record<string, unknown>, content: ExportNovelContent, includeSecrets = false): BackupBundle {
  const extensions = isRecord(state.backupExtensions) ? state.backupExtensions : {};
  const data = copy(extensions);
  for (const key of maps(state)) if (isRecord(state[key])) data[key] = copy(state[key]);
  for (const key of ['promoByChapter', 'folders', ...AGENT_FIELDS]) if (state[key] !== undefined) data[key] = copy(state[key]);
  if (isRecord(state.novelChatsByProject)) data.novelChats = copy(state.novelChatsByProject);
  const settings: Record<string, unknown> = {};
  for (const key of PC_SETTINGS_FIELDS) if (state[key] !== undefined) settings[key] = copy(state[key]);
  data.pcSettings = settings;
  data.pcBackupVersion = 1;
  data.projects = content.projects.map(project => {
    const original = Array.isArray(extensions.projects) ? extensions.projects.find(p => isRecord(p) && p.id === project.id) : undefined;
    return { ...(isRecord(original) ? original : {}), ...copy(project) };
  });
  const chaptersByProject: Record<string, unknown[]> = Object.create(null), chapterBodies: Record<string, unknown> = Object.create(null), chapterIllustrations: Record<string, unknown> = Object.create(null);
  const previousMeta = isRecord(extensions.chaptersByProject) ? extensions.chaptersByProject : {};
  const previousBodies = isRecord(extensions.chapterBodies) ? extensions.chapterBodies : {};
  for (const chapter of content.chapters) {
    const oldList = previousMeta[chapter.project_id];
    const old = Array.isArray(oldList) ? oldList.find(item => isRecord(item) && item.id === chapter.id) : undefined;
    const { draft_text: _draft, final_text: _final, illustrations: _illustrations, ...meta } = chapter;
    (chaptersByProject[chapter.project_id] ||= []).push({ ...(isRecord(old) ? old : {}), ...meta, arcId: chapter.arc_id ?? null });
    const previousBody = previousBodies[chapter.id];
    chapterBodies[chapter.id] = { ...(isRecord(previousBody) ? previousBody : {}), draft: chapter.draft_text || '', final: chapter.final_text || '' };
    if (chapter.illustrations) {
      let illustrations: unknown;
      try { illustrations = JSON.parse(chapter.illustrations); } catch { throw new Error(`章节 ${chapter.title} 的插图数据损坏，已停止备份`); }
      if (!Array.isArray(illustrations)) throw new Error(`章节 ${chapter.title} 的插图必须是数组`);
      chapterIllustrations[chapter.id] = illustrations;
    } else chapterIllustrations[chapter.id] = [];
  }
  data.chaptersByProject = chaptersByProject; data.chapterBodies = chapterBodies; data.chapterIllustrations = chapterIllustrations;
  if (isRecord(state.agentSessions)) {
    const sessions = state.agentSessions;
    const original = isRecord(extensions.agentSessions) ? extensions.agentSessions : {};
    data.agentSessions = Object.fromEntries(Object.entries(state.agentSessions).map(([id, session]) => [id, exportSession(session as AgentSession, original[id])]));
    const order = Array.isArray(state.agentSessionOrder) ? state.agentSessionOrder : Object.keys(state.agentSessions);
    const ids = [...new Set([...order, ...Object.keys(sessions)])].filter((id): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(sessions, id));
    const metrics = isRecord(state.agentSessionMetrics) ? state.agentSessionMetrics : {};
    for (const [id, wire] of Object.entries(data.agentSessions as Record<string, Record<string, unknown>>)) {
      const metric = metrics[id];
      if (isRecord(metric)) wire.cacheMetrics = { ...(isRecord(wire.cacheMetrics) ? wire.cacheMetrics : {}),
        observedRequests: nonnegative(metric.measuredRequests), hitTokens: nonnegative(metric.cacheHitTokens),
        missTokens: Math.max(0, nonnegative(metric.promptTokens) - nonnegative(metric.cacheHitTokens)) };
    }
    data.agentIndex = { ...(isRecord(extensions.agentIndex) ? extensions.agentIndex : {}), currentId: state.agentCurrentSessionId || null,
      items: ids.map(id => { const session = (state.agentSessions as Record<string, AgentSession>)[id]; return { id, title: session.title, createdAt: session.createdAt }; }) };
  }
  if (!includeSecrets) {
    redactSettings(data); redactSettings(settings);
    for (const field of ['androidSettings', 'appSettings', 'desktopSettings']) if (isRecord(data[field])) redactSettings(data[field]);
  }
  normalizeImages(data, true);
  return { version: 1, exportedAt: new Date().toISOString(), appVersion: '2.1.0', data };
}
function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 1000 || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error(`${label} ID 无效`);
  return value;
}
function asMap(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  return value;
}
function text(value: unknown, label: string, fallback: string | null = null): string | null {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error(`${label} 必须是文本`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} 必须是非负整数`);
  return value as number;
}
function validatePcSettings(settings: Record<string, unknown>): void {
  const enums: Record<string, string[]> = { theme: ['light', 'dark'], uiLanguage: ['zh', 'en'],
    imageEngine: ['pollinations', 'comfyui'], agentEngine: ['legacy', 'structured'], agentReasoningLevel: ['low', 'medium', 'high'] };
  for (const [key, allowed] of Object.entries(enums)) if (settings[key] !== undefined && !allowed.includes(String(settings[key]))) throw new Error(`桌面设置 ${key} 无效`);
  for (const key of ['pollinationsKey', 'comfyUIUrl', 'activeTextModelProfileId']) if (settings[key] !== undefined && typeof settings[key] !== 'string') throw new Error(`桌面设置 ${key} 必须是文本`);
  for (const key of ['knowledgeBaseEnabled', 'summariesEnabled', 'entitiesEnabled']) if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new Error(`桌面设置 ${key} 必须是开关`);
  for (const [key, maximum] of [['agentContextBudget', 2_000_000], ['agentMaxSteps', 200]] as const) if (settings[key] !== undefined && (integer(settings[key], key) < (key === 'agentContextBudget' ? 2000 : 5) || (settings[key] as number) > maximum)) throw new Error(`桌面设置 ${key} 超出范围`);
  const modelConfig = (value: unknown) => {
    if (!isRecord(value)) throw new Error('桌面模型配置必须是对象');
    for (const key of ['apiKey', 'apiUrl', 'model']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`模型 ${key} 必须是文本`);
    if (value.provider !== undefined && !['deepseek', 'openai', 'openrouter', 'gemini', 'custom'].includes(String(value.provider))) throw new Error('模型提供商无效');
    if (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) throw new Error('模型温度无效');
  };
  for (const key of ['textModelConfig', 'embeddingConfig']) if (settings[key] !== undefined) modelConfig(settings[key]);
  if (settings.textModelProfiles !== undefined) {
    if (!Array.isArray(settings.textModelProfiles) || settings.textModelProfiles.length > 1000) throw new Error('模型档案列表无效');
    const ids = new Set<string>();
    for (const profile of settings.textModelProfiles) {
      modelConfig(profile); const raw = profile as Record<string, unknown>, id = safeId(raw.id, '模型档案');
      if (ids.has(id) || typeof raw.name !== 'string') throw new Error('模型档案 ID 重复或名称无效'); ids.add(id);
    }
    if (settings.activeTextModelProfileId !== undefined && !ids.has(settings.activeTextModelProfileId as string)) throw new Error('当前模型档案不存在');
  }
}
export interface PreparedBackupImport { content: ImportNovelContentInput; metadata: Record<string, unknown> }
/** Validation and detached preparation are pure: caller must confirm before invoking any writes. */
export function prepareBackupImport(bundle: BackupBundle, state: Record<string, unknown>, includePcSettings = false): PreparedBackupImport {
  validateBundle(bundle);
  const incoming = copy(bundle.data); normalizeImages(incoming, false);
  const projects = incoming.projects === undefined ? [] : incoming.projects;
  if (!Array.isArray(projects)) throw new Error('projects 必须是数组');
  const projectIds = new Set<string>(), chapterIds = new Set<string>();
  for (const project of projects) {
    if (!isRecord(project)) throw new Error('项目格式不正确');
    const id = safeId(project.id, '项目'); if (projectIds.has(id)) throw new Error('项目 ID 重复'); projectIds.add(id);
    if (typeof project.title !== 'string') throw new Error('项目标题必须是文本');
  }
  const existingIds = projectsIn(state), metas = asMap(incoming.chaptersByProject, 'chaptersByProject'), bodies = asMap(incoming.chapterBodies, 'chapterBodies'), illustrations = asMap(incoming.chapterIllustrations, 'chapterIllustrations');
  const chapters: ImportChapterFull[] = [];
  for (const [owner, list] of Object.entries(metas)) {
    safeId(owner, '项目'); if (!projectIds.has(owner) && !existingIds.has(owner)) throw new Error(`章节属于缺失的项目 ${owner}`);
    if (!Array.isArray(list)) throw new Error('章节列表必须是数组');
    for (const raw of list) {
      if (!isRecord(raw)) throw new Error('章节格式不正确');
      const id = safeId(raw.id, '章节'); if (chapterIds.has(id)) throw new Error('章节 ID 重复'); chapterIds.add(id);
      const body = asMap(bodies[id], `章节 ${id} 正文`), images = illustrations[id];
      if (images !== undefined && !Array.isArray(images)) throw new Error(`章节 ${id} 插图必须是数组`);
      chapters.push({ id, project_id: owner, title: text(raw.title, '章节标题', '')!, order_index: integer(raw.order_index ?? raw.orderIndex, '章节顺序'),
        outline_goal: text(raw.outline_goal ?? raw.outlineGoal, '章节目标'), conflict: text(raw.conflict, '冲突'), twist: text(raw.twist, '转折'), cliffhanger: text(raw.cliffhanger, '悬念'),
        draft_text: text(body.draft, '草稿'), final_text: text(body.final, '正文'), illustrations: images ? JSON.stringify(images) : null,
        word_count: integer(raw.word_count ?? raw.wordCount, '字数'), status: text(raw.status, '章节状态'), created_at: text(raw.created_at ?? raw.createdAt, '创建时间'), updated_at: text(raw.updated_at ?? raw.updatedAt, '更新时间'), arc_id: text(raw.arcId ?? raw.arc_id, '剧情弧线') });
    }
  }
  for (const id of [...Object.keys(bodies), ...Object.keys(illustrations)]) if (!chapterIds.has(id)) throw new Error(`附件正文或插图缺少章节索引：${id}`);
  const metadata: Record<string, unknown> = {};
  for (const key of maps(incoming)) {
    const map = asMap(incoming[key], key);
    for (const id of Object.keys(map)) safeId(id, key);
    // Unknown Android maps remain in backupExtensions instead of disappearing at partialize().
    if (isRecord(state[key])) metadata[key] = { ...state[key], ...map };
  }
  if (incoming.promoByChapter !== undefined) metadata.promoByChapter = { ...asMap(state.promoByChapter, '现有摘要'), ...asMap(incoming.promoByChapter, '摘要') };
  if (incoming.novelChats !== undefined) metadata.novelChatsByProject = { ...asMap(state.novelChatsByProject, '现有问答'), ...asMap(incoming.novelChats, '问答') };
  if (incoming.folders !== undefined) {
    if (!Array.isArray(incoming.folders)) throw new Error('folders 必须是数组');
    const merged = new Map((Array.isArray(state.folders) ? state.folders : []).filter(isRecord).map(folder => [folder.id, folder]));
    for (const folder of incoming.folders) { if (!isRecord(folder)) throw new Error('文件夹格式不正确'); merged.set(safeId(folder.id, '文件夹'), folder); }
    metadata.folders = [...merged.values()];
  }
  if (isRecord(incoming.sceneWritingByProject)) {
    for (const [id, archive] of Object.entries(incoming.sceneWritingByProject)) {
      if (!isRecord(archive) || archive.version !== 1 || !Array.isArray(archive.plans) || !Array.isArray(archive.checkpoints)) throw new Error(`场景档案 ${id} 版本或结构不支持`);
      archive.checkpoints = archive.checkpoints.map(checkpoint => {
        if (!isRecord(checkpoint)) throw new Error('场景检查点无效');
        return checkpoint.status === 'RUNNING' ? { ...checkpoint, status: 'INTERRUPTED', error: checkpoint.error || '由备份导入，原设备任务未继续运行' } : checkpoint;
      });
      validateWritingArchive(archive as unknown as WritingArchive, id);
    }
    metadata.sceneWritingByProject = { ...asMap(state.sceneWritingByProject, '现有场景档案'), ...incoming.sceneWritingByProject };
  }
  if (isRecord(incoming.writingWorkspaceByProject)) for (const workspace of Object.values(incoming.writingWorkspaceByProject)) {
    validateWorkspace(workspace as WritingWorkspace);
  }
  if (isRecord(incoming.generationRunsByProject)) {
    for (const [id, runs] of Object.entries(incoming.generationRunsByProject)) {
      if (!Array.isArray(runs)) throw new Error(`生成记录 ${id} 必须是数组`);
      incoming.generationRunsByProject[id] = runs.map(run => {
        if (!isRecord(run)) throw new Error('生成记录无效');
        return ['running', 'pending', 'RUNNING', 'PENDING'].includes(String(run.status)) ? { ...run, status: 'cancelled', error: run.error || '由备份导入，原设备任务未继续运行' } : run;
      });
    }
    metadata.generationRunsByProject = { ...asMap(state.generationRunsByProject, '现有生成记录'), ...incoming.generationRunsByProject };
  }
  if (incoming.agentSessions !== undefined) {
    const sessions = asMap(incoming.agentSessions, '智能体会话');
    const converted: Record<string, AgentSession> = Object.create(null);
    const metricMap: Record<string, SessionMetrics> = {};
    for (const [id, raw] of Object.entries(sessions)) {
      safeId(id, '会话'); if (!isRecord(raw)) throw new Error('会话格式不正确'); converted[id] = importedSession(raw, id);
      const metric = importedMetrics(raw); if (metric) metricMap[id] = metric;
    }
    metadata.agentSessionMetrics = { ...asMap(state.agentSessionMetrics, '现有会话指标'), ...metricMap };
    metadata.agentSessions = { ...asMap(state.agentSessions, '现有会话'), ...converted };
    metadata.agentSessionOrder = [...new Set([...Object.keys(converted), ...(Array.isArray(state.agentSessionOrder) ? state.agentSessionOrder : [])])];
    // Current local focus is retained; imported pendingReview is evidence, not an executable gate.
  }
  for (const key of AGENT_FIELDS) if (incoming[key] !== undefined) {
    const map = asMap(incoming[key], key);
    for (const [id, item] of Object.entries(map)) {
      safeId(id, '会话指标');
      if (key === 'agentSessionContextSummaries') { if (typeof item !== 'string') throw new Error('会话摘要必须是文本'); }
      else {
        if (!isRecord(item)) throw new Error('会话指标必须是对象');
        for (const field of ['promptTokens', 'completionTokens', 'cacheHitTokens', 'measuredRequests', 'unknownRequests', 'contextTokens', 'contextBudget']) {
          if (!Number.isSafeInteger(item[field]) || (item[field] as number) < 0) throw new Error(`会话指标 ${field} 必须是非负整数`);
        }
        if ((item.contextBudget as number) <= 0 || (item.cacheHitTokens as number) > (item.promptTokens as number)) throw new Error('会话上下文预算或缓存命中量无效');
        for (const field of ['summary', 'coveredStepId', 'coveredDigest', 'compressedAt']) if (item[field] !== undefined && (typeof item[field] !== 'string' || (item[field] as string).length > (field === 'summary' ? 128_000 : 1000))) throw new Error('会话压缩记忆字段无效');
        if (item.coveredDigest && !/^[a-f0-9]{64}$/.test(item.coveredDigest as string)) throw new Error('会话压缩摘要指纹无效');
      }
    }
    metadata[key] = { ...asMap(metadata[key] ?? state[key], key), ...map };
  }
  if (includePcSettings) {
    const settings = isRecord(incoming.pcSettings) ? incoming.pcSettings : /^2\./.test(bundle.appVersion || '') ? incoming : {};
    validatePcSettings(settings);
    for (const key of PC_SETTINGS_FIELDS) if (settings[key] !== undefined) metadata[key] = settings[key];
  }
  if (isRecord(incoming.pcWritingCandidatesByProject)) for (const [id, candidates] of Object.entries(incoming.pcWritingCandidatesByProject)) {
    if (!Array.isArray(candidates)) throw new Error(`桌面候选 ${id} 必须是数组`);
    incoming.pcWritingCandidatesByProject[id] = candidates.map(candidate => {
      if (!isRecord(candidate)) throw new Error('桌面候选格式无效');
      return { ...candidate, ...(candidate.status === 'generating' ? { status: 'pending' } : {}), importedReadOnly: true };
    });
  }
  // Full detached Android originals make unknown properties and attachment extensions round-trip.
  const extensions: Record<string, unknown> = Object.assign(Object.create(null), asMap(state.backupExtensions, '兼容数据'));
  for (const [key, value] of Object.entries(incoming)) extensions[key] = isRecord(value) && isRecord(extensions[key]) ? { ...extensions[key], ...value } : value;
  // SQLite already owns full chapter bodies/images. Preserve only unmapped body extensions here,
  // not a second all-book text/base64 copy in the metadata journal and IndexedDB.
  if (isRecord(incoming.chapterBodies)) extensions.chapterBodies = Object.fromEntries(Object.entries(incoming.chapterBodies).map(([id, body]) => {
    if (!isRecord(body)) throw new Error('章节正文格式无效');
    const { draft: _draft, final: _final, ...unknownFields } = body;
    return [id, unknownFields];
  }));
  delete extensions.chapterIllustrations;
  metadata.backupExtensions = extensions;
  return { content: { projects: projects as Record<string, unknown>[], chapters }, metadata };
}
