import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@store/index';
import type { AgentStep } from '@store/index';
import { Button } from '@components/Button';
import {
  Bot, User, Send, Square, Trash2, Wrench, CheckCircle2, AlertTriangle, ShieldCheck, Footprints,
  Plus, MessageSquarePlus, Pencil, ChevronDown, Play, Loader2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { tx } from '@utils/i18n';
import { uiPrompt, uiConfirm, uiAlert } from '@components/uiDialog';
import { agentRunner } from '../agent/agentRunner';
import { useAgentStream } from '../agent/agentStream';
import { getWorkspaceCandidates } from '../writingUi/workspaceRuntime';
import { WorkspaceCandidateReview } from '../writingUi/WorkspaceCandidateReview';
import type { AgentPlan } from '../agent/agentPolicy';

type Step = AgentStep;

// Per-session scroll position, remembered across page navigations (module-level survives remounts).
const scrollMemory: Record<string, number> = {};

export function AgentPage() {
  const {
    uiLanguage, textModelConfig, projects,
    agentCurrentSessionId, agentSessionOrder, agentSessions,
    agentStatus, agentRunSessionId, agentPendingConfirm,
    ensureAgentSession, newAgentSession, switchAgentSession, deleteAgentSession,
    renameAgentSession, patchAgentSession, getAgentSession,
    agentMaxSteps, setAgentMaxSteps, agentEngine, agentReasoningLevel, agentSessionMetrics,
  } = useAppStore();
  const agentStreamingText = useAgentStream((st) => st.text);
  const navigate = useNavigate();
  const [reviewTarget, setReviewTarget] = useState<{ projectId: string; candidateId: string; sessionId: string } | null>(null);

  const [input, setInput] = useState('');
  const [showSessions, setShowSessions] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamBubbleRef = useRef<HTMLDivElement>(null);
  // Whether the user is parked at the bottom (so live updates keep following) vs scrolled up to read.
  const stickToBottomRef = useRef(true);

  const hasValidTextConfig =
    textModelConfig.apiKey.trim().length > 0 && textModelConfig.apiUrl.trim().length > 0 && textModelConfig.model.trim().length > 0;

  useEffect(() => { ensureAgentSession(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const cur = agentCurrentSessionId;
  const session = cur ? agentSessions[cur] : undefined;
  const steps: Step[] = session?.steps ?? [];
  const autoApprove = session?.autoApprove ?? false;
  const focusId = session?.lockedProjectId ?? null;

  // Run-time status only applies to the view when the running session IS the one being viewed.
  const isRunningSession = !!cur && agentRunSessionId === cur;
  const viewStatus = isRunningSession ? agentStatus : 'idle';
  const otherRunning = !!agentRunSessionId && agentRunSessionId !== cur;
  const running = viewStatus === 'running' || viewStatus === 'awaiting_confirm' || viewStatus === 'awaiting_user';
  // Live streaming text only belongs to the running session's view.
  const streamingText = isRunningSession ? agentStreamingText : '';

  // Remember scroll position per session; track whether we're stuck to the bottom.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !cur) return;
    scrollMemory[cur] = el.scrollTop;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // On entering / switching session, restore the last scroll position (or bottom for a first view).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !cur) return;
    const saved = scrollMemory[cur];
    const target = saved != null ? saved : el.scrollHeight;
    el.scrollTop = target;
    stickToBottomRef.current = el.scrollHeight - target - el.clientHeight < 80;
    // Late layout (images) — re-apply once on the next frame so the restore lands accurately.
    const id = requestAnimationFrame(() => { if (scrollRef.current && saved != null) scrollRef.current.scrollTop = saved; });
    return () => cancelAnimationFrame(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [cur]);

  // Live updates: only auto-follow to the bottom when the user is already parked there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [steps.length, viewStatus]);

  // Keep the streaming bubble pinned to its newest text as it grows.
  useEffect(() => {
    const inner = streamBubbleRef.current;
    if (inner) inner.scrollTop = inner.scrollHeight;
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [streamingText]);

  const focusedTitle = focusId ? (projects.find((p) => p.id === focusId)?.title ?? focusId) : null;
  const metrics = cur ? agentSessionMetrics[cur] : undefined;
  const contextRatio = metrics?.contextBudget ? Math.max(0, Math.min(1, metrics.contextTokens / metrics.contextBudget)) : 0;
  let waitingCandidateId: string | undefined;
  if (viewStatus === 'awaiting_confirm' && !agentPendingConfirm) {
    for (const step of [...steps].reverse()) {
      if (step.role !== 'result') continue;
      try { const marker = JSON.parse(step.content); if (marker.resultKind === 'pending_review' && typeof marker.candidateId === 'string') { waitingCandidateId = marker.candidateId; break; } } catch { /* ordinary tool result */ }
    }
  }
  const sessionCandidates = projects.flatMap(project => getWorkspaceCandidates(project.id).filter(candidate => (candidate.status === 'pending' || candidate.id === waitingCandidateId) && candidate.sessionId === cur));
  const plan = (session as (typeof session & { activePlan?: AgentPlan }))?.activePlan;

  const submit = () => {
    const t = input.trim();
    if (!t || !cur) return;
    if (otherRunning) {
      void uiAlert({ title: tx(uiLanguage, '提示', 'Notice'), message: tx(uiLanguage, '另一个会话正在后台运行，请切换到该会话，或先停止它。', 'Another session is running in the background — switch to it or stop it first.') });
      return;
    }
    setInput('');
    if (isRunningSession && (agentStatus === 'running' || agentStatus === 'awaiting_user' || agentStatus === 'awaiting_confirm')) {
      agentRunner.inject(t);  // answer a question / decline a confirm / inject a new instruction
      return;
    }
    if (!hasValidTextConfig) {
      void uiAlert({ title: tx(uiLanguage, '提示', 'Notice'), message: tx(uiLanguage, '请先在设置中配置文本模型平台。', 'Configure a text model platform in Settings first.') });
      return;
    }
    agentRunner.start(cur, t);
  };

  const continueRun = () => {
    if (!cur || running || otherRunning || steps.length === 0 || !hasValidTextConfig) return;
    agentRunner.continue(cur);
  };

  const clearAll = async () => {
    if (!cur || running) return;
    const ok = await uiConfirm({ title: tx(uiLanguage, '清空会话', 'Clear session'), message: tx(uiLanguage, '清空当前会话的执行链？（保留会话本身）', "Clear this session's steps? (keeps the session)"), danger: true });
    if (!ok) return;
    patchAgentSession(cur, { steps: [], lockedProjectId: null });
  };

  // ── session controls ──
  const handleNewSession = () => { newAgentSession(); setShowSessions(false); };
  const handleSwitch = (id: string) => { switchAgentSession(id); setShowSessions(false); };
  const handleRename = async (id: string) => {
    const meta = getAgentSession(id);
    const name = await uiPrompt({ title: tx(uiLanguage, '重命名会话', 'Rename session'), label: tx(uiLanguage, '会话名称', 'Session name'), defaultValue: meta?.title || '' });
    if (name?.trim()) renameAgentSession(id, name.trim());
  };
  const handleDeleteSession = async (id: string) => {
    const ok = await uiConfirm({ title: tx(uiLanguage, '删除会话', 'Delete session'), message: tx(uiLanguage, '删除这个会话及其全部执行链？', 'Delete this session and all its steps?'), danger: true });
    if (!ok) return;
    if (agentRunSessionId === id) agentRunner.stop();
    deleteAgentSession(id);
    if (useAppStore.getState().agentSessionOrder.length === 0) ensureAgentSession();
  };

  const sessionMetas = agentSessionOrder.map((id) => agentSessions[id]).filter(Boolean);
  const currentTitle = session?.title || tx(uiLanguage, '会话', 'Session');

  return (
    <div className="w-full flex flex-col h-[calc(100vh-7rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0 flex-wrap">
        <div className="w-9 h-9 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
          <Bot className="w-5 h-5 text-purple-600 dark:text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{tx(uiLanguage, '智能体', 'Agent')}</h1>
          <p className="text-xs text-gray-500 truncate">
            {focusedTitle
              ? tx(uiLanguage, `聚焦：《${focusedTitle}》`, `Focused: "${focusedTitle}"`)
              : tx(uiLanguage, '未聚焦项目（智能体可自行创建/聚焦）', 'No focused project (the agent can create/focus one)')}
          </p>
        </div>

        {/* Session switcher */}
        <div className="relative">
          <button
            onClick={() => setShowSessions((v) => !v)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 max-w-[12rem]"
            title={tx(uiLanguage, '切换会话', 'Switch session')}
          >
            <MessageSquarePlus className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">{currentTitle}</span>
            <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
          </button>
          {showSessions && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowSessions(false)} />
              <div className="absolute right-0 mt-1 z-20 w-72 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-1.5">
                <button onClick={handleNewSession} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20">
                  <Plus className="w-4 h-4" />{tx(uiLanguage, '新建会话', 'New session')}
                </button>
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                {sessionMetas.map((sm) => (
                  <div
                    key={sm.id}
                    className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer ${sm.id === cur ? 'bg-purple-50 dark:bg-purple-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
                    onClick={() => handleSwitch(sm.id)}
                  >
                    {agentRunSessionId === sm.id && <Loader2 className="w-3.5 h-3.5 text-purple-500 animate-spin flex-shrink-0" />}
                    <span className="flex-1 min-w-0 text-sm text-gray-700 dark:text-gray-200 truncate">{sm.title}</span>
                    <button onClick={(e) => { e.stopPropagation(); handleRename(sm.id); }} className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-400 hover:text-blue-600" title={tx(uiLanguage, '重命名', 'Rename')}>
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteSession(sm.id); }} className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-400 hover:text-red-600" title={tx(uiLanguage, '删除', 'Delete')}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 select-none" title={tx(uiLanguage, '每轮自动执行的最大步数，达到后自动暂停（可点「继续执行」）', 'Max autonomous steps per run before it pauses (you can Continue)')}>
          <Footprints className="w-3.5 h-3.5" />
          {tx(uiLanguage, '最大步数', 'Max steps')}
          <input
            type="number"
            min={5}
            max={200}
            value={agentMaxSteps}
            onChange={(e) => setAgentMaxSteps(parseInt(e.target.value, 10) || 40)}
            className="w-14 px-1.5 py-0.5 border rounded dark:bg-gray-700 dark:border-gray-600 text-center focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer select-none" title={tx(uiLanguage, '自动批准所有需确认的操作', 'Auto-approve all confirm-gated actions')}>
          <input type="checkbox" checked={autoApprove} onChange={(e) => cur && patchAgentSession(cur, { autoApprove: e.target.checked })} className="accent-purple-600" />
          <ShieldCheck className="w-3.5 h-3.5" />
          {tx(uiLanguage, '自动批准', 'Auto-approve')}
        </label>
        {steps.length > 0 && !running && (
          <button onClick={clearAll} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 transition-colors" title={tx(uiLanguage, '清空', 'Clear')}>
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-3 items-center text-xs mb-3 flex-shrink-0">
        <label className="flex items-center gap-2">{tx(uiLanguage, '智能体引擎', 'Agent engine')}<select disabled={running} value={agentEngine} onChange={e => useAppStore.setState({ agentEngine: e.target.value as 'legacy' | 'structured' })} className="border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600"><option value="legacy">{tx(uiLanguage, '经典执行链', 'Classic')}</option><option value="structured">{tx(uiLanguage, '规划执行引擎', 'Plan and execute')}</option></select></label>
        {focusId && <Button size="sm" variant="outline" onClick={() => navigate(`/workbench/${focusId}`)}>{tx(uiLanguage, '本书工作台', 'Book workbench')}</Button>}
        <div className="ml-auto flex items-center gap-2" title={tx(uiLanguage, '上下文占用为本地估算；接近上限时自动压缩，压缩后保留可追溯会话。', 'Context is a local estimate. Near the limit it is compressed while preserving the conversation.')}>
          <svg viewBox="0 0 40 40" className="w-9 h-9 -rotate-90" role="img" aria-label={tx(uiLanguage, `上下文占用${Math.round(contextRatio * 100)}%`, `Context ${Math.round(contextRatio * 100)}%`)}><circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" className="text-gray-200 dark:text-gray-700" /><circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" pathLength="100" strokeDasharray={`${contextRatio * 100} 100`} className={contextRatio > 0.9 ? 'text-amber-500' : 'text-purple-500'} /></svg>
          <span>{tx(uiLanguage, '上下文', 'Context')} {Math.round(contextRatio * 100)}%<span className="block text-gray-500">{metrics ? `${metrics.contextTokens.toLocaleString()}/${metrics.contextBudget.toLocaleString()}` : tx(uiLanguage, '尚无统计', 'No data')}</span></span>
        </div>
        <span className="text-gray-500">{tx(uiLanguage, '会话缓存命中', 'Session cache hit')} {metrics?.promptTokens && metrics.measuredRequests ? `${Math.round(metrics.cacheHitTokens / metrics.promptTokens * 100)}%` : tx(uiLanguage, '未返回统计', 'Unavailable')}<span className="block">{metrics ? `${metrics.measuredRequests} ${tx(uiLanguage, '已统计', 'measured')} · ${metrics.unknownRequests} ${tx(uiLanguage, '未知', 'unknown')}` : ''}</span></span>
        {metrics?.compressedAt && <details><summary className="cursor-pointer text-purple-600">{tx(uiLanguage, '上下文已压缩', 'Context compressed')}</summary><p className="max-w-xl max-h-32 overflow-auto whitespace-pre-wrap mt-2">{metrics.summary}</p></details>}
      </div>
      {!!sessionCandidates.length && <div className="mb-2 rounded-xl border border-purple-200 dark:border-purple-800 p-3 flex-shrink-0 max-h-40 overflow-auto space-y-2">{sessionCandidates.map(candidate => <div key={candidate.id} className="flex justify-between gap-3 items-center"><span className="text-sm">{candidate.title} · {candidate.status === 'pending' ? tx(uiLanguage, '正文候选待审核，尚未写入章节', 'Candidate awaiting review, not adopted') : tx(uiLanguage, '审核已处理，等待确认结果', 'Review processed; confirmation pending')}</span><Button size="sm" onClick={() => { if (cur) setReviewTarget({ projectId: candidate.projectId, candidateId: candidate.id, sessionId: cur }); }}>{tx(uiLanguage, '预览与审核', 'Preview and review')}</Button></div>)}</div>}

      {/* Background-run banner when viewing a different session */}
      {otherRunning && (
        <div className="mb-2 flex items-center gap-2 text-xs text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg px-3 py-1.5 flex-shrink-0">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span className="flex-1 truncate">{tx(uiLanguage, '另一个会话正在后台运行…', 'Another session is running in the background…')}</span>
          <button
            className="underline hover:text-purple-900 dark:hover:text-purple-100"
            onClick={() => { if (agentRunSessionId) switchAgentSession(agentRunSessionId); }}
          >
            {tx(uiLanguage, '查看', 'View')}
          </button>
        </div>
      )}

      {/* Steps */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto space-y-2 pr-1">
        {steps.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Bot className="w-12 h-12 mx-auto opacity-40 mb-3" />
            <p className="text-sm">{tx(uiLanguage, '告诉智能体你的目标，例如：', 'Tell the agent your goal, e.g.:')}</p>
            <p className="text-xs mt-2 text-gray-400 max-w-md mx-auto">
              {tx(uiLanguage,
                '"新建一部仙侠长篇《问道》，建立境界体系，生成大纲与3个副本，为第一个副本生成弧线并规划前5章，然后写第1章。"',
                '"Create a xianxia long novel, set up a realm system, generate an outline and 3 volumes, generate arcs for the first volume, plan its first 5 chapters, then write chapter 1."')}
            </p>
          </div>
        ) : (
          steps.map((step) => <StepBubble key={step.id} step={step} uiLanguage={uiLanguage} />)
        )}
        {streamingText && (
          <div className="ml-6">
            <div className="flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400 mb-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {tx(uiLanguage, '正在生成…', 'Generating…')}
            </div>
            <div
              ref={streamBubbleRef}
              className="max-h-56 overflow-y-auto px-3 py-2 rounded-lg bg-purple-50/60 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-900/40 text-xs text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words leading-relaxed"
            >
              {streamingText}
            </div>
          </div>
        )}
        {viewStatus === 'running' && !streamingText && (
          <div className="flex items-center gap-2 text-xs text-gray-400 px-2">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            <span>{tx(uiLanguage, '思考中…', 'Thinking…')}</span>
          </div>
        )}
      </div>

      {/* Confirm gate */}
      {viewStatus === 'awaiting_confirm' && agentPendingConfirm && (
        <div className="mt-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 flex-shrink-0">
          <p className="text-sm text-amber-800 dark:text-amber-300 mb-1">
            {tx(uiLanguage, `智能体想执行需确认操作：`, 'The agent wants to run a confirm-gated action: ')}
            <span className="font-mono font-semibold">{agentPendingConfirm.tool}</span>
          </p>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80 font-mono mb-2 max-h-16 overflow-y-auto break-words">
            {Object.entries(agentPendingConfirm.args || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ·  ').slice(0, 400)}
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mb-2">
            {tx(uiLanguage, '（也可直接在下方输入框告诉它改做别的，将自动拒绝本操作并按你的要求继续）', '(Or type a new instruction below — it declines this action and follows your request instead.)')}
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button onClick={() => agentRunner.confirm(true)} className="bg-green-600 hover:bg-green-700 text-sm py-1.5">
              <CheckCircle2 className="w-4 h-4 mr-1.5" />{tx(uiLanguage, '允许', 'Allow')}
            </Button>
            <Button onClick={() => agentRunner.confirm(true, true)} variant="outline" className="text-sm py-1.5">
              {tx(uiLanguage, '允许并不再询问', "Allow & don't ask again")}
            </Button>
            <Button onClick={() => agentRunner.confirm(false)} variant="outline" className="text-sm py-1.5 text-red-600 border-red-300">
              {tx(uiLanguage, '拒绝', 'Reject')}
            </Button>
          </div>
        </div>
      )}

      {/* Continue (resume a session with steps) */}
      {!running && !otherRunning && steps.length > 0 && !steps.some((sp) => sp.role === 'final') && (
        <div className="mt-2 flex-shrink-0">
          <Button onClick={continueRun} variant="outline" className="text-sm py-1.5">
            <Play className="w-4 h-4 mr-1.5" />{tx(uiLanguage, '继续执行', 'Continue')}
          </Button>
        </div>
      )}

      {/* Input — stays enabled while running so you can inject instructions at any time */}
      {plan && <details className="mt-2 rounded-xl border border-purple-200 dark:border-purple-800 px-3 py-2 flex-shrink-0"><summary className="cursor-pointer text-sm text-purple-700 dark:text-purple-300">{tx(uiLanguage, '项目执行计划', 'Project execution plan')} · {plan.steps.filter(step => step.status === 'completed').length}/{plan.steps.length}</summary><p className="text-xs text-gray-500 my-2">{plan.summary}</p><ol className="max-h-48 overflow-y-auto space-y-2 text-sm">{plan.steps.map((step, index) => <li key={step.id} className="flex gap-2"><span>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : step.status === 'blocked' ? '!' : '○'}</span><div><p>{index + 1}. {step.goal}</p>{step.successCriteria && <p className="text-xs text-gray-500">{step.successCriteria}</p>}</div></li>)}</ol></details>}
      <div className="mt-3 flex gap-2 flex-shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          rows={2}
          disabled={otherRunning}
          placeholder={
            otherRunning ? tx(uiLanguage, '另一个会话正在后台运行…', 'Another session is running…')
            : viewStatus === 'awaiting_user' ? tx(uiLanguage, '智能体在等待你的回答…', 'The agent is waiting for your answer…')
            : viewStatus === 'running' ? tx(uiLanguage, '可随时输入以插入新指令…', 'Type any time to inject an instruction…')
            : tx(uiLanguage, '描述你的目标，Enter 发送…', 'Describe your goal — Enter to send…')
          }
          className="flex-1 px-3 py-2 border rounded-xl dark:bg-gray-800 dark:border-gray-600 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm disabled:opacity-60"
        />
        <label className="text-xs flex flex-col justify-center gap-1 text-gray-500">{tx(uiLanguage, '推理级别', 'Reasoning')}<select value={agentReasoningLevel} onChange={e => useAppStore.setState({ agentReasoningLevel: e.target.value as 'low' | 'medium' | 'high' })} className="border rounded px-2 py-2 dark:bg-gray-800 dark:border-gray-600"><option value="low">{tx(uiLanguage, '低', 'Low')}</option><option value="medium">{tx(uiLanguage, '中', 'Medium')}</option><option value="high">{tx(uiLanguage, '高', 'High')}</option></select></label>
        {running && viewStatus !== 'awaiting_user' ? (
          <div className="flex flex-col gap-1">
            <Button onClick={() => agentRunner.stop()} variant="outline" className="px-4 text-red-600 border-red-300">
              <Square className="w-4 h-4" />
            </Button>
            <Button onClick={submit} disabled={!input.trim()} className="bg-purple-600 hover:bg-purple-700 px-4" title={tx(uiLanguage, '插入指令', 'Inject')}>
              <Send className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <Button onClick={submit} disabled={!input.trim() || otherRunning} className="bg-purple-600 hover:bg-purple-700 self-stretch px-4">
            <Send className="w-4 h-4" />
          </Button>
        )}
      </div>
      {reviewTarget && <WorkspaceCandidateReview projectId={reviewTarget.projectId} candidateId={reviewTarget.candidateId} onClose={() => setReviewTarget(null)} onReviewed={async () => { setReviewTarget(null); }} />}
    </div>
  );
}

function StepBubble({ step, uiLanguage }: { step: Step; uiLanguage: 'zh' | 'en' }) {
  if (step.role === 'user') {
    return (
      <div className="flex gap-3 flex-row-reverse">
        <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
          <User className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="max-w-[80%] rounded-2xl px-4 py-2 text-sm bg-blue-600 text-white whitespace-pre-wrap break-words">{step.content}</div>
      </div>
    );
  }
  if (step.role === 'thought') {
    return <p className="text-xs text-gray-500 dark:text-gray-400 italic px-2">💭 {step.content}</p>;
  }
  if (step.role === 'tool') {
    return (
      <div className="flex items-start gap-2 px-2 text-xs">
        <Wrench className="w-3.5 h-3.5 text-purple-500 mt-0.5 flex-shrink-0" />
        <span className="text-purple-700 dark:text-purple-300 font-mono font-semibold">{step.tool}</span>
        <span className="text-gray-400 font-mono truncate">{step.content}</span>
      </div>
    );
  }
  if (step.role === 'result') {
    // Cap height so long results (chapter text, retrieval over 100s of chapters, long lists) stay scrollable.
    return (
      <div className="ml-6 max-h-72 overflow-y-auto px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words">
        {step.content}
      </div>
    );
  }
  if (step.role === 'image') {
    return (
      <div className="ml-6">
        {/* Cap both width and height so tall covers (9:16) can't blow up the chat; aspect ratio preserved. */}
        <img
          src={step.image}
          alt={step.content}
          className="max-w-[10rem] max-h-64 w-auto h-auto object-contain rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"
        />
        <p className="text-[10px] text-gray-400 mt-1">{step.content}</p>
      </div>
    );
  }
  if (step.role === 'ask') {
    return (
      <div className="px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm text-blue-800 dark:text-blue-300">
        ❓ {step.content}
      </div>
    );
  }
  if (step.role === 'error') {
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span className="whitespace-pre-wrap break-words">{step.content}</span>
      </div>
    );
  }
  // final
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center flex-shrink-0">
        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
      </div>
      <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-white dark:bg-gray-800 border border-green-200 dark:border-green-800">
        <div className="prose prose-sm dark:prose-invert max-w-none break-words max-h-80 overflow-y-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.content}</ReactMarkdown>
        </div>
        <p className="text-[10px] text-gray-400 mt-1">{tx(uiLanguage, '✓ 已完成', '✓ Done')}</p>
      </div>
    </div>
  );
}
