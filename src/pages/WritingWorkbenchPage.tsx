import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { save } from '@tauri-apps/api/dialog';
import { writeBinaryFile } from '@tauri-apps/api/fs';
import { BookOpen, FileText, Users, Bot, Settings2, Plus, RefreshCw, Upload } from 'lucide-react';
import { useAppStore } from '@store/index';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { chapterApi, projectApi } from '@services/api';
import { uiConfirm, uiPrompt } from '@components/uiDialog';
import type { Chapter, Project } from '@typings/index';
import { tx } from '@utils/i18n';
import {
  exportBook,
  previewManuscript,
  type ChapterScenePlan,
  type ManuscriptPreview,
  type WritingCheckpoint,
} from '../writing';
import { WorkspaceModal } from '../writingUi/WorkspaceModal';
import { PagedTextPreview, SavedDraftModal } from '../writingUi/WritingReviewModal';
import {
  ScenePlanModal,
  StoryNotesModal,
  WritingPreferencesModal,
} from '../writingUi/WorkspaceEditors';
import { WorkspaceCandidateReview } from '../writingUi/WorkspaceCandidateReview';
import {
  buildWorkspaceSource,
  cancelWorkspaceTask,
  chapterBody,
  generateWorkspaceChapter,
  generateWorkspaceScenePlan,
  getWorkspace,
  getWorkspaceCandidates,
  isWorkspaceActive,
  latestWorkspaceCheckpoint,
  pauseWorkspaceTask,
  saveWorkspace,
  saveWorkspaceScenePlan,
  storyNoteStatuses,
  useWorkspaceJobs,
  workspaceJobKey,
} from '../writingUi/workspaceRuntime';

const panelClass =
  'bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5';
export function WritingWorkbenchPage() {
  const { id: projectId = '' } = useParams(),
    navigate = useNavigate(),
    [search] = useSearchParams();
  const language = useAppStore(s => s.uiLanguage),
    chaptersVersion = useAppStore(s => s.chaptersVersion);
  const profiles = useAppStore(s => s.textModelProfiles),
    charactersByProject = useAppStore(s => s.charactersByProject);
  const workspaceMap = useAppStore(s => s.writingWorkspaceByProject),
    archiveMap = useAppStore(s => s.sceneWritingByProject);
  const usageMap = useAppStore(s => s.writingUsageByProject),
    extensions = useAppStore(s => s.backupExtensions);
  const jobs = useWorkspaceJobs(s => s.jobs);
  const [project, setProject] = useState<Project | null>(null),
    [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedId, setSelectedId] = useState(search.get('chapter') ?? ''),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [chapterPage, setChapterPage] = useState(0);
  const [dialog, setDialog] = useState<'preferences' | 'notes' | null>(null),
    [editPlan, setEditPlan] = useState<ChapterScenePlan | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null),
    [savedDraft, setSavedDraft] = useState<{ title: string; text: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ManuscriptPreview | null>(null),
    [importIndex, setImportIndex] = useState(0);
  const [freshness, setFreshness] = useState<'unknown' | 'fresh' | 'stale'>('unknown');
  const fileRef = useRef<HTMLInputElement>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = async () => {
    const [nextProject, nextChapters] = await Promise.all([
      projectApi.getById(projectId),
      chapterApi.getByProject(projectId),
    ]);
    if (!alive.current) return;
    setProject(nextProject);
    setChapters(nextChapters.sort((a, b) => a.order_index - b.order_index));
    setSelectedId(current =>
      nextChapters.some(c => c.id === current)
        ? current
        : (nextChapters.find(c => !chapterBody(c))?.id ?? nextChapters[0]?.id ?? '')
    );
    if (nextProject) useAppStore.getState().setCurrentProject(nextProject);
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([projectApi.getById(projectId), chapterApi.getByProject(projectId)])
      .then(([p, c]) => {
        if (cancelled) return;
        setProject(p);
        setChapters(c.sort((a, b) => a.order_index - b.order_index));
        setSelectedId(current =>
          c.some(x => x.id === current)
            ? current
            : (c.find(x => !chapterBody(x))?.id ?? c[0]?.id ?? '')
        );
        if (p) useAppStore.getState().setCurrentProject(p);
      })
      .catch(f => {
        if (!cancelled) setError(String(f));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, chaptersVersion]);
  const workspace = workspaceMap[projectId] ?? getWorkspace(projectId),
    archive = archiveMap[projectId];
  const noteStatuses = useMemo(
    () => storyNoteStatuses(workspace.notes, chapters),
    [workspace.notes, chapters]
  );
  const chapter = chapters.find(c => c.id === selectedId),
    checkpoint = chapter ? latestWorkspaceCheckpoint(projectId, chapter.id) : null;
  const plan = archive?.plans.find(p => p.chapterId === selectedId),
    job = jobs[workspaceJobKey(projectId, selectedId)];
  const active = isWorkspaceActive(projectId, selectedId) || !!job?.active;
  const candidates = getWorkspaceCandidates(projectId)
    .filter(c => c.status === 'pending')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const rawHistory = extensions.pcWritingDraftHistoryByProject;
  const draftHistory =
    rawHistory && typeof rawHistory === 'object' && !Array.isArray(rawHistory)
      ? (rawHistory as Record<string, unknown>)[projectId]
      : undefined;
  const historicalDrafts = Array.isArray(draftHistory)
    ? draftHistory.filter(
        (x): x is WritingCheckpoint =>
          !!x &&
          typeof x === 'object' &&
          x.plan?.chapterId === selectedId &&
          Array.isArray(x.completedScenes) &&
          x.completedScenes.length > 0
      )
    : [];
  const usage = (usageMap[projectId] ?? [])
    .filter(u => u.chapterId === selectedId)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
  const long = useAppStore.getState().getNovelType(projectId) === 'long';
  const base = long ? `/long-novel/${projectId}` : `/project/${projectId}`;
  const editorPath = (cid: string) =>
    long ? `${base}/editor/${cid}` : `/editor/${projectId}/${cid}`;
  useEffect(() => {
    let cancelled = false;
    setFreshness('unknown');
    if (plan && chapter)
      buildWorkspaceSource(projectId, chapter.id)
        .then(source => {
          if (!cancelled)
            setFreshness(source.sourceFingerprint === plan.sourceFingerprint ? 'fresh' : 'stale');
        })
        .catch(() => {
          if (!cancelled) setFreshness('stale');
        });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedId, plan, chaptersVersion, workspaceMap, charactersByProject]);
  // These subscriptions keep candidate and task badges in sync across pages.
  void extensions;
  const act = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const taskControl = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const addChapter = async () => {
    const title = await uiPrompt({
      title: tx(language, '新章节标题', 'New chapter title'),
      defaultValue: tx(language, `第${chapters.length + 1}章`, `Chapter ${chapters.length + 1}`),
    });
    if (!title?.trim()) return;
    const created = await chapterApi.create({
      project_id: projectId,
      title: title.trim(),
      order_index: Math.max(-1, ...chapters.map(c => c.order_index)) + 1,
    });
    await refresh();
    setSelectedId(created.id);
    useAppStore.getState().bumpChaptersVersion();
  };
  const generate = async (resume = false) => {
    if (!chapter) return;
    if (
      !resume &&
      chapterBody(chapter) &&
      !(await uiConfirm({
        title: tx(language, '生成正文候选', 'Generate candidate'),
        message: tx(
          language,
          '将生成新的正文候选。当前正文不会自动覆盖，需审核通过后采用。继续？',
          'Generate a replacement candidate? Current prose stays unchanged until you approve.'
        ),
      }))
    )
      return;
    const result = await generateWorkspaceChapter(projectId, chapter.id, {
      resumeRunId: resume ? checkpoint?.runId : undefined,
    });
    if (alive.current) setReviewId(result.candidateId);
  };
  const viewSaved = async () => {
    if (!checkpoint) return;
    const runId = checkpoint.runId;
    // Read the exact checkpoint again; never silently substitute a newer run.
    await Promise.resolve();
    const exact = useAppStore
      .getState()
      .sceneWritingByProject[
        projectId
      ]?.checkpoints.find(c => c.runId === runId && c.plan.chapterId === selectedId);
    if (!exact?.completedScenes.length)
      throw new Error(
        tx(language, '此任务的已保存场景不存在', 'No saved scenes exist for this exact run')
      );
    setSavedDraft({
      title: chapter?.title ?? '',
      text: [exact.baselineText, ...exact.completedScenes.map(s => s.body)]
        .filter(Boolean)
        .join('\n\n'),
    });
  };
  const readImport = async (file: File) => {
    if (!/\.(txt|md)$/i.test(file.name))
      throw new Error(
        tx(language, '此入口仅支持 TXT/Markdown', 'This importer supports TXT and Markdown')
      );
    if (file.size > 10 * 1024 * 1024)
      throw new Error(
        tx(language, '文件超过10MiB，请分卷导入', 'File exceeds 10 MiB; import in volumes')
      );
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    const preview = previewManuscript(text);
    setImportIndex(0);
    setImportPreview(preview);
  };
  const confirmImport = async () => {
    if (!importPreview || !project) return;
    if (
      Array.from(Object.entries(jobs)).some(
        ([key, value]) =>
          key.startsWith(JSON.stringify([projectId]).slice(0, -1) + ',') && value.active
      )
    )
      throw new Error(
        tx(language, '请先暂停本书任务后导入书稿', 'Pause this book’s tasks before importing')
      );
    const fresh = await chapterApi.getByProject(projectId),
      start = Math.max(-1, ...fresh.map(c => c.order_index)) + 1;
    await projectApi.importContent({
      projects: [project as unknown as Record<string, unknown>],
      chapters: importPreview.chapters.map((c, i) => ({
        id: crypto.randomUUID(),
        project_id: projectId,
        title: c.title,
        order_index: start + i,
        draft_text: c.body,
        final_text: '',
        status: 'draft',
        word_count: c.body.length,
      })),
    });
    setImportPreview(null);
    await refresh();
    useAppStore.getState().bumpChaptersVersion();
  };
  const downloadBook = async (format: 'epub' | 'docx') => {
    const [freshProject, freshChapters] = await Promise.all([
      projectApi.getById(projectId),
      chapterApi.getByProject(projectId),
    ]);
    if (!freshProject) throw new Error('项目不存在');
    const bytes = exportBook(
      {
        title: freshProject.title,
        author: freshProject.author,
        language: freshProject.language,
        identifier: freshProject.id,
        chapters: freshChapters
          .sort((a, b) => a.order_index - b.order_index)
          .map(c => ({ title: c.title, body: chapterBody(c) })),
        outline: useAppStore.getState().getLongNovelOutline(projectId),
      },
      format
    );
    const filename = `${freshProject.title.replace(/[\\/:*?"<>|]/g, '_')}.${format}`;
    if (Reflect.has(window, '__TAURI_IPC__')) {
      const path = await save({
        defaultPath: filename,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (path) await writeBinaryFile(path, bytes);
    } else {
      const blob = new Blob([new Uint8Array(bytes).buffer], {
        type:
          format === 'epub'
            ? 'application/epub+zip'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  };
  if (loading && !project)
    return <div className="p-6">{tx(language, '正在加载工作台…', 'Loading workbench…')}</div>;
  if (!project)
    return (
      <div className="p-6 space-y-4">
        <p role="alert">{error || tx(language, '项目不存在', 'Project not found')}</p>
        <Button onClick={() => navigate('/long-novels')}>
          {tx(language, '返回项目', 'Back to projects')}
        </Button>
      </div>
    );
  const pages = Math.max(1, Math.ceil(chapters.length / 40));
  const modeName =
    workspace.mode === 'quick'
      ? tx(language, '快速写作', 'Quick')
      : workspace.mode === 'polish'
        ? tx(language, '精修审稿', 'Polished')
        : tx(language, '场景写作', 'Scenes');
  return (
    <div className="max-w-screen-2xl mx-auto p-4 md:p-6 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-primary-600">
            {tx(language, '创作工作台', 'Writing workbench')} · {modeName}
          </p>
          <h1 className="text-2xl font-semibold mt-1">{project.title}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {tx(
              language,
              '计划 → 场景写作 → 审稿 → 采用；旧结构页始终保留',
              'Plan → scenes → review → adopt. The original structure pages remain available.'
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void act(refresh)}>
            <RefreshCw className="w-4 h-4 mr-1" />
            {tx(language, '刷新', 'Refresh')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDialog('preferences')}>
            <Settings2 className="w-4 h-4 mr-1" />
            {tx(language, '本书偏好', 'Preferences')}
          </Button>
        </div>
      </header>
      <nav className="flex gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={() => navigate(`${base}/outline`)}>
          <FileText className="w-4 h-4 mr-1" />
          {tx(language, '大纲', 'Outline')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => navigate(`${base}/characters`)}>
          <Users className="w-4 h-4 mr-1" />
          {tx(language, '角色', 'Characters')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDialog('notes')}>
          <BookOpen className="w-4 h-4 mr-1" />
          {tx(language, '故事卡', 'Story cards')} ({workspace.notes.length})
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const sessionId = useAppStore.getState().ensureAgentSession();
            useAppStore.getState().patchAgentSession(sessionId, { lockedProjectId: projectId });
            navigate('/agent');
          }}
        >
          <Bot className="w-4 h-4 mr-1" />
          {tx(language, '智能体', 'Agent')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => navigate(base)}>
          {tx(language, '原结构页', 'Original structure')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="w-4 h-4 mr-1" />
          {tx(language, '导入 TXT / MD', 'Import TXT / MD')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => navigate(`${base}/export`)}>
          {tx(language, '导出书稿', 'Export manuscript')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => downloadBook('epub'))}
        >
          EPUB
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => downloadBook('docx'))}
        >
          DOCX
        </Button>
      </nav>
      <input
        ref={fileRef}
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void act(() => readImport(file));
        }}
      />
      {error && (
        <div
          className="p-3 rounded border border-red-300 text-red-600 whitespace-pre-wrap"
          role="alert"
        >
          {error}
        </div>
      )}
      <div className="grid xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.8fr)] gap-5 items-start">
        <section className={panelClass}>
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold">
              {tx(language, '章节', 'Chapters')} ({chapters.length})
            </h2>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act(addChapter)}
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <div className="space-y-2 max-h-[65vh] overflow-auto">
            {chapters.slice(chapterPage * 40, chapterPage * 40 + 40).map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={`text-left w-full p-3 rounded-lg border ${selectedId === c.id ? 'border-primary-500 bg-primary-50 dark:bg-gray-800' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
              >
                <div className="font-medium">{c.title}</div>
                <p className="text-xs text-gray-500 mt-1">
                  {c.status} · {c.word_count || chapterBody(c).length.toLocaleString()}{' '}
                  {tx(language, '字', 'chars')}
                  {candidates.some(x => x.chapterId === c.id)
                    ? ` · ${tx(language, '待审核', 'Review pending')}`
                    : ''}
                </p>
                {c.outline_goal && (
                  <p className="text-sm line-clamp-2 mt-1 text-gray-500">{c.outline_goal}</p>
                )}
              </button>
            ))}
            {!chapters.length && (
              <p className="text-gray-500 text-sm">
                {tx(
                  language,
                  '先创建章节，再规划场景或生成候选。',
                  'Create a chapter to plan scenes or generate a candidate.'
                )}
              </p>
            )}
          </div>
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <Button
                size="sm"
                variant="outline"
                disabled={chapterPage === 0}
                onClick={() => setChapterPage(p => p - 1)}
              >
                ←
              </Button>
              <span>
                {chapterPage + 1}/{pages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={chapterPage >= pages - 1}
                onClick={() => setChapterPage(p => p + 1)}
              >
                →
              </Button>
            </div>
          )}
        </section>
        <div className="space-y-5">
          <section className={panelClass}>
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <h2 className="font-semibold text-lg">
                  {chapter?.title ?? tx(language, '开始创作', 'Start writing')}
                </h2>
                <p className="text-sm text-gray-500 mt-2 whitespace-pre-wrap">
                  {chapter?.outline_goal ||
                    tx(
                      language,
                      '在大纲中填写本章目标，有助于规划准确的场景。',
                      'Add a chapter goal in the outline for more accurate scenes.'
                    )}
                </p>
              </div>
              {chapter && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(editorPath(chapter.id))}
                >
                  {tx(language, '编辑当前正文', 'Edit current prose')}
                </Button>
              )}
            </div>
            <div className="flex gap-2 flex-wrap mt-5">
              <Button
                disabled={!chapter || active || busy}
                loading={busy && active}
                onClick={() => void act(() => generate())}
              >
                {tx(language, '生成正文候选', 'Generate candidate')}
              </Button>
              <Button
                variant="outline"
                disabled={!chapter || active || busy}
                onClick={() =>
                  void act(async () => {
                    if (chapter)
                      setEditPlan(await generateWorkspaceScenePlan(projectId, chapter.id));
                  })
                }
              >
                {tx(
                  language,
                  plan ? '重新规划场景' : '规划场景',
                  plan ? 'Replan scenes' : 'Plan scenes'
                )}
              </Button>
              {checkpoint && checkpoint.status !== 'COMPLETED' && (
                <Button
                  variant="outline"
                  disabled={active || busy}
                  onClick={() => void act(() => generate(true))}
                >
                  {tx(language, '诊断并恢复任务', 'Check and resume')}
                </Button>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-3">
              {tx(
                language,
                `本次最多 ${workspace.maxRequestsPerRun} 个 API 请求；规划、续写、格式纠正、审稿与修订均计入。`,
                `Up to ${workspace.maxRequestsPerRun} API requests, including planning, continuation, corrections, review and revisions.`
              )}
            </p>
          </section>
          {(job || checkpoint) && (
            <section className={panelClass}>
              <div className="flex flex-wrap gap-3 justify-between">
                <h2 className="font-semibold">{tx(language, '任务进度', 'Task progress')}</h2>
                <span className="text-sm text-gray-500">{job?.stage ?? checkpoint?.status}</span>
              </div>
              {checkpoint && (
                <p className="mt-3 text-sm">
                  {checkpoint.completedScenes.length}/{checkpoint.plan.scenes.length}{' '}
                  {tx(language, '场景已保存', 'scenes saved')} · {checkpoint.requestCount}{' '}
                  {tx(language, '个请求', 'requests')}
                </p>
              )}
              {checkpoint?.status === 'RUNNING' && !active && (
                <p className="text-amber-600 text-sm mt-2">
                  {tx(
                    language,
                    '页面显示运行但没有对应请求：任务已经中断。恢复前将检查当前来源与已保存场景。',
                    'The saved run has no active request. It is interrupted; resume verifies its sources and saved scenes.'
                  )}
                </p>
              )}
              {(job?.error || checkpoint?.error) && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-red-600">
                    {tx(language, '查看中断/失败原因', 'Show interruption or failure reason')}
                  </summary>
                  <p className="whitespace-pre-wrap mt-2">{job?.error || checkpoint?.error}</p>
                </details>
              )}
              {job?.preview && (
                <p className="mt-3 whitespace-pre-wrap text-sm max-h-40 overflow-auto">
                  {job.preview}
                </p>
              )}
              <div className="flex gap-2 mt-4 flex-wrap">
                {active && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void taskControl(() => pauseWorkspaceTask(projectId, selectedId))
                      }
                    >
                      {tx(language, '暂停', 'Pause')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void taskControl(() => cancelWorkspaceTask(projectId, selectedId))
                      }
                    >
                      {tx(language, '停止任务', 'Stop')}
                    </Button>
                  </>
                )}
                {checkpoint?.status === 'RUNNING' && !active && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void taskControl(() => pauseWorkspaceTask(projectId, selectedId))
                    }
                  >
                    {tx(language, '标记中断，保留草稿', 'Mark interrupted, keep draft')}
                  </Button>
                )}
                {!!checkpoint?.completedScenes.length && (
                  <Button size="sm" variant="outline" onClick={() => void act(viewSaved)}>
                    {tx(language, '查看已保存场景（只读）', 'Saved scenes (read-only)')}
                  </Button>
                )}
              </div>
              {usage && (
                <p className="text-xs text-gray-500 mt-4">
                  {usage.model} · {usage.requestCount} {tx(language, '请求', 'requests')} ·{' '}
                  {tx(language, '输入/输出', 'Input/output')} {usage.promptTokens ?? '—'}/
                  {usage.completionTokens ?? '—'} · {tx(language, '缓存命中', 'Cache hit')}{' '}
                  {usage.cacheHitTokens !== null && usage.promptTokens
                    ? `${Math.round((usage.cacheHitTokens / usage.promptTokens) * 100)}%`
                    : tx(language, '未返回统计', 'Unavailable')}
                  {usage.failedRequests
                    ? ` · ${usage.failedRequests} ${tx(language, '失败请求', 'failed requests')}`
                    : ''}
                </p>
              )}
            </section>
          )}
          {plan && (
            <section className={panelClass}>
              <div className="flex justify-between gap-3">
                <h2 className="font-semibold">
                  {tx(language, '场景计划', 'Scene plan')} ({plan.scenes.length})
                </h2>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={active}
                  onClick={() => setEditPlan(plan)}
                >
                  {tx(language, '编辑约束', 'Edit constraints')}
                </Button>
              </div>
              {freshness === 'stale' && (
                <p className="text-sm text-amber-600 mt-2">
                  {tx(
                    language,
                    '计划来源已变化。可以查看旧约束，但请重新规划后生成。',
                    'Sources changed. Old constraints are viewable, but replan before generating.'
                  )}
                </p>
              )}
              <ol className="space-y-3 mt-4">
                {plan.scenes.map((s, i) => (
                  <li key={s.id} className="text-sm">
                    <p className="font-medium">
                      {i + 1}. {s.title} · {s.targetWords} {tx(language, '字', 'chars')}
                    </p>
                    <p className="text-gray-500 mt-1">{s.goal}</p>
                    <p className="text-gray-500">
                      {s.pov} · {s.location}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {!!candidates.length && (
            <section className={panelClass}>
              <h2 className="font-semibold mb-3">
                {tx(language, '待审核正文', 'Candidates awaiting review')}
              </h2>
              <div className="space-y-3 max-h-80 overflow-auto">
                {candidates.map(c => (
                  <div key={c.id} className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{c.title}</p>
                      <p className="text-xs text-gray-500">
                        {c.body.length.toLocaleString()}{' '}
                        {tx(language, '字 · 未写入章节', 'chars · not adopted')}
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setReviewId(c.id)}>
                      {tx(language, '预览与审核', 'Preview and review')}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}
          {!!historicalDrafts.length && (
            <section className={panelClass}>
              <h2 className="font-semibold mb-3">
                {tx(
                  language,
                  '历史场景草稿（来源可能过期）',
                  'Previous scene drafts (sources may be stale)'
                )}
              </h2>
              <div className="space-y-2 max-h-64 overflow-auto">
                {historicalDrafts
                  .slice(-40)
                  .reverse()
                  .map(draft => (
                    <div
                      key={`${draft.runId}-${draft.revision}`}
                      className="flex gap-3 justify-between items-center"
                    >
                      <span className="text-xs text-gray-500">
                        {new Date(draft.updatedAt).toLocaleString()} ·{' '}
                        {draft.completedScenes.length} {tx(language, '场景', 'scenes')}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setSavedDraft({
                            title: chapter?.title ?? '',
                            text: [
                              draft.baselineText,
                              ...draft.completedScenes.map(scene => scene.body),
                            ]
                              .filter(Boolean)
                              .join('\n\n'),
                          })
                        }
                      >
                        {tx(language, '只读查看', 'Read-only preview')}
                      </Button>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>
      </div>
      {dialog === 'preferences' && (
        <WritingPreferencesModal
          language={language}
          workspace={workspace}
          profiles={profiles}
          onClose={() => setDialog(null)}
          onSave={next => saveWorkspace(projectId, next)}
        />
      )}
      {dialog === 'notes' && (
        <StoryNotesModal
          language={language}
          workspace={workspace}
          chapters={chapters}
          characters={charactersByProject[projectId] ?? []}
          sourceStatuses={noteStatuses}
          onClose={() => setDialog(null)}
          onSave={notes => saveWorkspace(projectId, { ...workspace, notes })}
        />
      )}
      {editPlan && (
        <ScenePlanModal
          language={language}
          plan={editPlan}
          onClose={() => setEditPlan(null)}
          onSave={saveWorkspaceScenePlan}
        />
      )}
      {reviewId && (
        <WorkspaceCandidateReview
          projectId={projectId}
          candidateId={reviewId}
          onClose={() => setReviewId(null)}
          onReviewed={() => {
            setReviewId(null);
            void act(refresh);
          }}
        />
      )}
      {savedDraft && (
        <SavedDraftModal
          language={language}
          title={savedDraft.title}
          body={savedDraft.text}
          baselineText=""
          onClose={() => setSavedDraft(null)}
        />
      )}
      {importPreview && (
        <WorkspaceModal
          title={tx(language, '书稿导入预览', 'Manuscript import preview')}
          busy={busy}
          onClose={() => setImportPreview(null)}
          footer={
            <div className="space-y-2">
              {error && (
                <p className="text-red-600 text-sm" role="alert">
                  {error}
                </p>
              )}
              <p className="text-sm text-gray-500">
                {tx(
                  language,
                  '确认后追加为新章节，不替换已有正文。',
                  'Confirm appends new chapters without replacing existing prose.'
                )}
              </p>
              <div className="flex justify-end gap-3">
                <Button variant="outline" disabled={busy} onClick={() => setImportPreview(null)}>
                  {tx(language, '取消', 'Cancel')}
                </Button>
                <Button loading={busy} onClick={() => void act(confirmImport)}>
                  {tx(language, '确认导入', 'Confirm import')}
                </Button>
              </div>
            </div>
          }
        >
          <p className="mb-3">
            {importPreview.chapters.length} {tx(language, '章', 'chapters')} ·{' '}
            {importPreview.totalCharacters.toLocaleString()} {tx(language, '字符', 'characters')}
          </p>
          <Input
            type="number"
            min={1}
            max={importPreview.chapters.length}
            label={tx(language, '预览第几章', 'Preview chapter number')}
            value={importIndex + 1}
            onChange={e =>
              setImportIndex(
                Math.max(
                  0,
                  Math.min(importPreview.chapters.length - 1, Number(e.target.value) - 1 || 0)
                )
              )
            }
          />
          <h3 className="font-semibold my-4">{importPreview.chapters[importIndex].title}</h3>
          <PagedTextPreview text={importPreview.chapters[importIndex].body} language={language} />
        </WorkspaceModal>
      )}
    </div>
  );
}
