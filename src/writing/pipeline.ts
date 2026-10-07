import type { ChapterScenePlan, WritingCheckpoint, WritingPersistence, WritingProgress, WritingPurpose, WritingRequest, WritingRequestCallback, WritingResponse, WritingResult, WritingRole } from './models';
import { WritingError } from './models';
import { assert, isUnicodeBoundary, parseReview, parseScenePlan, validateCheckpoint, validateScenePlan } from './protocol';
import { canonicalJson, isPcSourceFingerprint } from './hash';

const PLAN_SYSTEM = `你是小说场景规划编辑。区分作者知识、角色知识、已发生事实与未来计划。只返回严格JSON对象，根字段仅scenes，禁止说明或代码围栏。
每场完整字段：{"id":"s1","title":"场景标题","pov":"视角人物","time":"时间","location":"地点","goal":"场景目标","conflict":"冲突","turn":"转折","entryState":"入场状态与知情范围","exitState":"结束状态与知情范围","requiredEvents":[],"forbiddenEvents":[],"targetWords":1500}。
id唯一，title/goal非空；每场100到8000字，总计不超过30000字；最多8场。不发明与作者资料冲突的设定，不提前发生后场事件。`;
const DRAFT_SYSTEM = `你是小说正文作者，按照完整场景计划逐场写正文。资料与计划优先于临时发挥。保持视角、角色动机、时间地点与知情边界。
满足本场必需事件；禁止泄露角色未知信息或提前发生未来剧情。只输出本场可读正文，不附解释、JSON、Markdown围栏、场景标题，不重复既有正文。`;
const REVIEW_SYSTEM = `你是小说审稿编辑，只审阅提供的正文和明确场景约束。输出严格JSON：{"findings":[]}，最多48项，不修改正文。
每项完整字段：{"sceneId":"s1","category":"FACT_CONFLICT","severity":"BLOCKING","quote":"证据原文","startOffset":0,"endOffset":4,"constraint":"本场明确约束原文","explanation":"问题说明","suggestion":"局部修订建议"}。
startOffset/endOffset是对应scene body的UTF-16索引，quote必须逐字匹配。category只允许FACT_CONFLICT/KNOWLEDGE_LEAK/MISSING_EVENT/STYLE/PACING/OTHER，severity只允许BLOCKING/WARNING/SUGGESTION。
STYLE/PACING/OTHER只能SUGGESTION。BLOCKING须逐字引用requiredEvents/forbiddenEvents/entryState/exitState中的一条明确约束。没有证据不输出，文学偏好不能伪装成阻断。`;
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('任务已暂停', 'AbortError');
}
function prefix(text: string, max: number): string { let end = Math.min(text.length, max); if (!isUnicodeBoundary(text, end)) end--; return text.slice(0, end); }
function suffix(text: string, max: number): string { let start = Math.max(0, text.length - max); if (!isUnicodeBoundary(text, start)) start++; return text.slice(start); }
/** Exact repeated cutoff prefixes only; short coincidental matches are NOT silently removed. */
export function mergeTextContinuation(previous: string, continuation: string): string {
  if (!previous || !continuation) return previous + continuation;
  const max = Math.min(previous.length, continuation.length, 32_768); const pattern = continuation.slice(0, max); const table = new Uint32Array(max);
  for (let i = 1; i < max; i++) { let matched = table[i - 1]; while (matched && pattern[i] !== pattern[matched]) matched = table[matched - 1]; if (pattern[i] === pattern[matched]) matched++; table[i] = matched; }
  let matched = 0;
  for (let i = previous.length - max; i < previous.length; i++) {
    while (matched && previous[i] !== pattern[matched]) matched = table[matched - 1];
    if (previous[i] === pattern[matched]) matched++;
    if (matched === max && i !== previous.length - 1) matched = table[matched - 1];
  }
  const overlap = matched >= 12 && isUnicodeBoundary(previous, previous.length - matched) && isUnicodeBoundary(continuation, matched) ? matched : 0;
  return previous + continuation.slice(overlap);
}
function result(c: WritingCheckpoint): WritingResult {
  const body = c.completedScenes.map(x => x.body).join('\n\n');
  return { body, fullBody: [c.baselineText, body].filter(x => x.length).join('\n\n'), findings: c.reviewFindings, checkpoint: c };
}
/** Host-side CAS validators can use this to stop stale results, invalid takeover, and prefix replacement. */
export function isValidCheckpointTransition(expected: WritingCheckpoint | null, next: WritingCheckpoint): boolean {
  try {
    validateCheckpoint(next);
    if (!expected) return next.revision === 0 && next.status === 'RUNNING' && next.completedScenes.length === 0;
    validateCheckpoint(expected);
    if (expected.plan.projectId !== next.plan.projectId || expected.plan.chapterId !== next.plan.chapterId) return false;
    if (expected.runId !== next.runId) {
      if (next.status !== 'RUNNING') return false;
      if (next.revision === 0) return expected.status !== 'RUNNING' && next.completedScenes.length === 0;
      return expected.status !== 'COMPLETED' && next.revision === expected.revision + 1 && same(next.plan, expected.plan) && next.mode === expected.mode && next.sourceFingerprint === expected.sourceFingerprint && next.chapterTask === expected.chapterTask && next.language === expected.language && next.baselineText === expected.baselineText && next.requestCount === expected.requestCount && same(next.completedScenes, expected.completedScenes) && same(next.reviewFindings, expected.reviewFindings) && next.reviewCompleted === expected.reviewCompleted;
    }
    return expected.status === 'RUNNING' && next.revision === expected.revision + 1 && same(next.plan, expected.plan) && next.sourceFingerprint === expected.sourceFingerprint && next.mode === expected.mode && next.chapterTask === expected.chapterTask && next.language === expected.language && next.baselineText === expected.baselineText && next.requestCount >= expected.requestCount && next.completedScenes.length >= expected.completedScenes.length && same(next.completedScenes.slice(0, expected.completedScenes.length), expected.completedScenes) && (!expected.reviewCompleted || (next.reviewCompleted && same(next.reviewFindings, expected.reviewFindings)));
  } catch { return false; }
}
export function createWritingPipeline(options: {
  request: WritingRequestCallback; persistence: WritingPersistence; now?: () => number; newRunId?: () => string;
}) {
  const now = options.now ?? Date.now;
  const newRunId = options.newRunId ?? (() => crypto.randomUUID());
  function normalize(request: WritingRequest): Required<Omit<WritingRequest, 'currentSourceFingerprint'>> & Pick<WritingRequest, 'currentSourceFingerprint'> {
    const r = { mode: 'SCENES' as const, plan: null, resumeRunId: null, optionalReview: request.mode === 'POLISHED', targetWords: 3_000,
      language: 'zh', maxRequests: 32, maxRetries: 1, maxContinuationsPerScene: 2, baselineText: '', maxInputCharacters: 120_000, ...request };
    assert(r.projectId.trim() && r.chapterId.trim() && r.chapterTask.trim() && r.chapterTask.length <= 128_000, '项目、章节或任务为空/过长');
    if (!isPcSourceFingerprint(r.sourceFingerprint)) throw new WritingError('旧平台来源摘要不能直接续写；请按当前资料重新规划，旧草稿保留', 'source_changed');
    assert(['FAST', 'SCENES', 'POLISHED'].includes(r.mode) && r.language.trim() && r.language.length <= 32, '写作模式或语言无效');
    assert(Number.isInteger(r.targetWords) && r.targetWords >= 100 && r.targetWords <= 30_000, '目标字数无效');
    assert(Number.isInteger(r.maxRequests) && r.maxRequests >= 1 && r.maxRequests <= 64 && Number.isInteger(r.maxRetries) && r.maxRetries >= 0 && r.maxRetries <= 2 && Number.isInteger(r.maxContinuationsPerScene) && r.maxContinuationsPerScene >= 0 && r.maxContinuationsPerScene <= 4, '请求/重试上限无效');
    assert(r.baselineText.length <= 1_000_000 && r.stableContext.length <= 1_000_000 && Number.isInteger(r.maxInputCharacters) && r.maxInputCharacters >= 1 && r.maxInputCharacters <= 1_000_000, '输入资料或上下文预算无效');
    if (r.plan) binding(r, r.plan); return r;
  }
  type Request = ReturnType<typeof normalize>;
  function binding(r: Request, p: ChapterScenePlan): void {
    validateScenePlan(p); assert(p.projectId === r.projectId && p.chapterId === r.chapterId, '计划属于其他章节');
    if (p.sourceFingerprint !== r.sourceFingerprint) throw new WritingError('场景计划来源已过期，请重新规划', 'source_changed');
  }
  class Session {
    checkpoint: WritingCheckpoint | null = null; requestCount = 0;
    constructor(readonly request: Request, readonly signal: AbortSignal) {}
    async checkSource(): Promise<void> {
      if (this.request.currentSourceFingerprint && await this.request.currentSourceFingerprint() !== this.request.sourceFingerprint) throw new WritingError('正文或设定在任务期间改变，旧来源草稿已保留，请重新规划', 'source_changed');
    }
    async commit(change: (c: WritingCheckpoint) => WritingCheckpoint): Promise<void> {
      abort(this.signal); await this.checkSource(); const current = this.checkpoint!;
      const next = { ...change(current), revision: current.revision + 1, updatedAt: now() };
      validateCheckpoint(next); assert(isValidCheckpointTransition(current, next), '不允许替换已完成草稿或任务来源');
      if (!await options.persistence.compareAndSet(current, next)) throw new WritingError('任务已被恢复或替换，过期结果不会写入', 'stale_run'); this.checkpoint = next;
    }
    async call(system: string, user: string, role: WritingRole, purpose: WritingPurpose, format: 'json' | 'text'): Promise<WritingResponse> {
      abort(this.signal); await this.checkSource();
      if (system.length + user.length > this.request.maxInputCharacters) throw new WritingError('完整计划、证据与正文超过上下文预算；请精简资料或使用更大上下文模型', 'budget');
      const used = this.checkpoint?.requestCount ?? this.requestCount;
      if (used >= this.request.maxRequests) throw new WritingError(`达到本任务 ${this.request.maxRequests} 次请求上限，已完成场景保留`, 'quota');
      if (this.checkpoint) await this.commit(c => ({ ...c, requestCount: used + 1 }));
      this.requestCount = used + 1;
      const response = await options.request(system, user, role, this.signal, purpose, format);
      abort(this.signal); await this.checkSource();
      const v = typeof response === 'string' ? { text: response, finishReason: 'stop' as const } : response;
      assert(typeof v.text === 'string' && (v.finishReason === undefined || v.finishReason === 'stop' || v.finishReason === 'length'), '模型回复缺少完成文本');
      return v;
    }
    async json<T>(system: string, user: string, purpose: 'scene_plan' | 'scene_review', parse: (raw: string) => T): Promise<T> {
      let nextUser = user;
      for (let attempt = 0; attempt <= this.request.maxRetries; attempt++) {
        const response = await this.call(system, nextUser, purpose === 'scene_plan' ? 'planning' : 'review', purpose, 'json');
        if (response.finishReason === 'length') throw new WritingError('JSON 被输出上限截断，请提高规划/审稿输出额度', 'output_limit');
        try { return parse(response.text); } catch (error) {
          if (!(error instanceof WritingError) || error.code !== 'protocol' || attempt === this.request.maxRetries) throw error;
          nextUser = `${user}\n上一个JSON不符合协议：${prefix(error.message, 600)}。错误回复片段：${prefix(response.text, 4_096)}\n重新输出完整严格JSON对象，所有字段不可省略，不能有解释或代码围栏。`;
        }
      }
      throw new WritingError('JSON 格式无效', 'protocol');
    }
    async preserve(error: unknown): Promise<void> {
      const c = this.checkpoint; if (!c || c.status === 'COMPLETED') return;
      const cancelled = this.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const next = { ...c, revision: c.revision + 1, updatedAt: now(), status: cancelled ? 'INTERRUPTED' as const : 'FAILED' as const,
        error: cancelled ? '任务已暂停，已完成场景可继续' : prefix(error instanceof Error ? error.message : String(error), 2_000) };
      // Never mask the original failure, check the live hash, or bind old drafts to changed sources here.
      try { if (await options.persistence.compareAndSet(c, next)) this.checkpoint = next; } catch { /* host can surface its persistence health separately */ }
    }
  }
  async function generatePlan(r: Request, session: Session): Promise<ChapterScenePlan> {
    const user = `作者设定与上下文资料：\n${r.stableContext}\n写作语言：${r.language}\n章节任务：${r.chapterTask}\n章节目标字数：${r.targetWords}；拆分为1到8场，各场合计不超过30000字。仅输出JSON。`;
    return session.json(PLAN_SYSTEM, user, 'scene_plan', raw => parseScenePlan(raw, r.projectId, r.chapterId, r.sourceFingerprint, now()));
  }
  return {
    /** Standalone planning does not overwrite an existing run/checkpoint. The UI explicitly saves accepted plans. */
    async plan(request: WritingRequest, signal: AbortSignal): Promise<ChapterScenePlan> {
      const r = normalize(request); return generatePlan(r, new Session(r, signal));
    },
    async run(request: WritingRequest, signal: AbortSignal, onProgress: (p: WritingProgress) => void | Promise<void> = () => {}): Promise<WritingResult> {
      const r = normalize(request); const session = new Session(r, signal); abort(signal); await session.checkSource();
      const existing = await options.persistence.load(r.projectId, r.chapterId); if (existing) validateCheckpoint(existing);
      if (!r.resumeRunId && existing?.status === 'RUNNING') throw new WritingError('本章已有运行任务，请先暂停或恢复', 'stale_run');
      const saved = r.resumeRunId ? existing : null;
      if (r.resumeRunId && (!saved || saved.runId !== r.resumeRunId)) throw new WritingError('待恢复任务不存在或已被替换', 'stale_run');
      if (saved && (saved.sourceFingerprint !== r.sourceFingerprint || !isPcSourceFingerprint(saved.sourceFingerprint))) throw new WritingError('旧来源草稿不能盲目续写，请重新规划', 'source_changed');
      if (saved) { assert(saved.mode === r.mode && (!r.plan || same(saved.plan, r.plan)), '恢复时不能修改原模式或计划'); if (saved.status === 'COMPLETED') return result(saved); }
      const effective = saved && saved.chapterTask.trim() ? { ...r, chapterTask: saved.chapterTask, language: saved.language, baselineText: saved.baselineText } : r;
      let plan = saved?.plan ?? r.plan;
      if (!plan && r.mode === 'FAST') plan = { projectId: r.projectId, chapterId: r.chapterId, sourceFingerprint: r.sourceFingerprint, updatedAt: now(),
        scenes: [{ id: 'chapter', title: '整章快速草稿', pov: '', time: '', location: '', goal: r.chapterTask, conflict: '', turn: '', entryState: '', exitState: '', requiredEvents: [], forbiddenEvents: [], targetWords: Math.min(r.targetWords, 8_000) }] };
      if (!plan) {
        await onProgress({ stage: 'planning', checkpoint: null });
        const reusable = existing?.mode === 'FAST' ? null : await options.persistence.loadPlan?.(r.projectId, r.chapterId);
        plan = reusable?.sourceFingerprint === r.sourceFingerprint ? reusable : await generatePlan(r, session);
      }
      binding(r, plan); assert(r.mode !== 'FAST' || plan.scenes.length === 1, '快速写作只能使用单场景计划');
      abort(signal); await session.checkSource();
      const next: WritingCheckpoint = saved ? { ...saved, runId: newRunId(), revision: saved.revision + 1, status: 'RUNNING', error: null, updatedAt: now() } : {
        runId: newRunId(), revision: 0, sourceFingerprint: r.sourceFingerprint, plan, completedScenes: [], status: 'RUNNING', error: null, mode: r.mode,
        requestCount: session.requestCount, reviewFindings: [], reviewCompleted: false, updatedAt: now(), chapterTask: effective.chapterTask, language: effective.language, baselineText: effective.baselineText };
      validateCheckpoint(next);
      if (!await options.persistence.compareAndSet(existing, next)) throw new WritingError('本章任务在规划期间已变化，请重新读取', 'stale_run'); session.checkpoint = next;
      try {
        await onProgress({ stage: 'writing', checkpoint: next });
        for (const scene of plan.scenes.slice(next.completedScenes.length)) {
          const completed = session.checkpoint!.completedScenes;
          const stable = `作者设定与上下文资料：\n${r.stableContext}\n完整场景计划JSON：\n${JSON.stringify(plan)}\n`;
          const tail = suffix(completed[completed.length - 1]?.body ?? effective.baselineText, 6_000);
          const user = `${stable}写作语言：${effective.language}\n章节任务：${effective.chapterTask}\n当前只写场景：${scene.id}（${scene.title}），目标约${scene.targetWords}字。\n此前已完成场景及其计划结束约束（不是事实核验结论）：\n${completed.map(x => `已完成${x.sceneId}；计划结束约束：${x.exitState}`).join('\n')}\n上一场/原正文尾部用于衔接：\n${tail}\n未来场景尚未发生，只写本场，不复述既有正文。`;
          let body = ''; let requestUser = user;
          for (let count = 0; count <= r.maxContinuationsPerScene; count++) {
            const response = await session.call(DRAFT_SYSTEM, requestUser, 'writing', count ? 'scene_continue' : r.mode === 'FAST' ? 'quick_draft' : 'scene_draft', 'text');
            const piece = response.text;
            if (!count) body = piece;
            else { const merged = mergeTextContinuation(body, piece); assert(merged.length > body.length, '续写没有新增正文，不能把截断场景标记为完成'); body = merged; }
            assert(body.length <= 256_000, '场景正文过长，已暂停以保护内存');
            await onProgress({ stage: 'writing', checkpoint: session.checkpoint, sceneId: scene.id, preview: body });
            if (response.finishReason !== 'length') break;
            if (count === r.maxContinuationsPerScene) throw new WritingError('本场输出仍被截断，保留已完成场景，请提高输出额度后恢复', 'output_limit');
            assert(piece.trim(), '截断回复没有新增正文');
            requestUser = `${user}\n本场尚未写完，前一次因输出上限中断；只续写以下正文尾部之后的文字，禁止重写已写部分。\n截断尾部：\n${suffix(body, 6_000)}`;
          }
          body = body.trim(); assert(body, '场景正文为空');
          await session.commit(c => ({ ...c, completedScenes: [...c.completedScenes, { sceneId: scene.id, body, exitState: scene.exitState, completedAt: now() }] }));
          await onProgress({ stage: 'scene_completed', checkpoint: session.checkpoint, sceneId: scene.id });
        }
        if (r.optionalReview && !session.checkpoint!.reviewCompleted) {
          await onProgress({ stage: 'reviewing', checkpoint: session.checkpoint }); const c = session.checkpoint!;
          const findings = await session.json(REVIEW_SYSTEM, `作者设定与上下文资料：\n${r.stableContext}\n审稿语言：${effective.language}\n场景计划JSON：\n${JSON.stringify(plan)}\n已完成场景JSON（body是证据原文）：\n${JSON.stringify(c.completedScenes)}\n仅输出findings JSON。`, 'scene_review', raw => parseReview(raw, plan!, c.completedScenes));
          await session.commit(c => ({ ...c, reviewFindings: findings, reviewCompleted: true }));
        }
        await session.commit(c => ({ ...c, status: 'COMPLETED', error: null }));
        await onProgress({ stage: 'completed', checkpoint: session.checkpoint }); return result(session.checkpoint!);
      } catch (error) { await session.preserve(error); throw error; }
    },
  };
}
