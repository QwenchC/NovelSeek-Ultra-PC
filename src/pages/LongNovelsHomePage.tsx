import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@store/index';
import { projectApi, chapterApi } from '@services/api';
import { Button } from '@components/Button';
import { uiAlert } from '@components/uiDialog';
import { Plus, BookOpen, Calendar, TrendingUp, Trash2, Layers } from 'lucide-react';
import { formatDate, formatWordCount, calculateProgress, confirmDialog } from '@utils/index';
import { clearProjectPageCache } from '@utils/projectPageCache';
import { tx } from '@utils/i18n';
import type { Project } from '@typings/index';

export function LongNovelsHomePage() {
  const navigate = useNavigate();
  const { projects, setProjects, uiLanguage, novelTypeByProject, setNovelType, plotArcsByProject, volumesByProject, closeProjectTab } =
    useAppStore();
  // Render instantly if zustand has cached projects from a previous mount in this session.
  const [loading, setLoading] = useState(projects.length === 0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // pid → chapter count (loaded lazily; cards show the count once available).
  const [chapterCounts, setChapterCounts] = useState<Record<string, number>>({});

  const longProjects = projects.filter((p) => novelTypeByProject[p.id] === 'long');

  useEffect(() => {
    loadProjects();
    loadChapterCounts();
  }, []);

  const loadChapterCounts = async () => {
    try {
      const rows = await chapterApi.getCounts();
      const map: Record<string, number> = {};
      for (const r of rows) map[r.project_id] = r.count;
      setChapterCounts(map);
    } catch (error) {
      console.error('Failed to load chapter counts:', error);
    }
  };

  const loadProjects = async () => {
    try {
      // Step 1: fast initial load — render as soon as this returns.
      const data = await projectApi.getAll();
      setProjects(data);
      setLoading(false);

      // Step 2: defensive word-count recalc in the background, in parallel.
      const { invoke } = await import('@tauri-apps/api/tauri');
      await Promise.all(
        data.map((project) =>
          invoke('recalculate_project_word_count', { projectId: project.id }).catch(() => {})
        )
      );

      // Step 3: silent refresh with the corrected counts.
      const updatedData = await projectApi.getAll();
      setProjects(updatedData);
    } catch (error) {
      console.error('Failed to load projects:', error);
      setLoading(false);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    const confirmed = await confirmDialog(
      tx(uiLanguage, '确定要删除这个项目吗？删除后无法恢复！', 'Delete this project? This action cannot be undone.'),
      tx(uiLanguage, '删除项目', 'Delete Project')
    );
    if (!confirmed) return;
    try {
      await projectApi.delete(projectId);
      closeProjectTab(projectId);      // drop its Topbar tab
      clearProjectPageCache(projectId); // and its stale landing-page cache
      loadProjects();
    } catch {
      void uiAlert({ title: tx(uiLanguage, '提示', 'Notice'), message: tx(uiLanguage, '删除项目失败', 'Failed to delete project') });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">{tx(uiLanguage, '加载中...', 'Loading...')}</div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 md:mb-8">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <BookOpen className="w-7 h-7 text-purple-600" />
            {tx(uiLanguage, '长篇小说', 'Long Novels')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1 text-sm md:text-base">
            {tx(uiLanguage, '以剧情弧线推进，无限续写你的故事', 'Story arc progression — write your story without limits')}
          </p>
        </div>
        <Button
          onClick={() => setShowCreateModal(true)}
          className="whitespace-nowrap self-start sm:self-auto bg-purple-600 hover:bg-purple-700"
        >
          <Plus className="w-4 h-4 mr-2" />
          {tx(uiLanguage, '新建长篇项目', 'New Long Novel')}
        </Button>
      </div>

      {longProjects.length === 0 ? (
        <div className="text-center py-20">
          <BookOpen className="w-16 h-16 mx-auto text-gray-400 mb-4" />
          <h3 className="text-xl font-medium text-gray-700 dark:text-gray-300 mb-2">
            {tx(uiLanguage, '还没有长篇小说项目', 'No long novel projects yet')}
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            {tx(uiLanguage, '创建你的第一部长篇小说，以剧情弧线驱动无限续写！', 'Create your first long novel with story arc progression!')}
          </p>
          <Button
            onClick={() => setShowCreateModal(true)}
            className="bg-purple-600 hover:bg-purple-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            {tx(uiLanguage, '创建长篇项目', 'Create Long Novel')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {longProjects.map((project) => (
            <LongNovelCard
              key={project.id}
              project={project}
              arcs={plotArcsByProject[project.id] || []}
              volumeCount={(volumesByProject[project.id] || []).length}
              chapterCount={chapterCounts[project.id] ?? null}
              uiLanguage={uiLanguage}
              onClick={() => navigate(`/workbench/${project.id}`)}
              onDelete={() => handleDeleteProject(project.id)}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateLongNovelModal
          onClose={() => setShowCreateModal(false)}
          onSuccess={(projectId) => {
            setShowCreateModal(false);
            setNovelType(projectId, 'long');
            navigate(`/workbench/${projectId}`);
          }}
        />
      )}
    </div>
  );
}

// ── Long Novel Card ────────────────────────────────────────────
interface LongNovelCardProps {
  project: Project;
  arcs: import('@store/index').PlotArc[];
  volumeCount: number;
  chapterCount: number | null;
  uiLanguage: 'zh' | 'en';
  onClick: () => void;
  onDelete: () => void;
}

function LongNovelCard({ project, arcs, volumeCount, chapterCount, uiLanguage, onClick, onDelete }: LongNovelCardProps) {
  const progress = project.target_word_count
    ? calculateProgress(project.current_word_count, project.target_word_count)
    : 0;

  const activeArc = arcs.find((a) => a.status === 'active' || a.status === 'ending');

  const getDefaultCoverSrc = (proj: Project): string | null => {
    if (!proj.cover_images) return null;
    try {
      const parsed = JSON.parse(proj.cover_images);
      if (!Array.isArray(parsed)) return null;
      const items = parsed
        .map((item, index) => {
          if (typeof item === 'string') return { id: `idx-${index}`, imageBase64: item };
          if (item && typeof item === 'object') {
            const r = item as Record<string, unknown>;
            const imageBase64 =
              (r.imageBase64 as string | undefined) ||
              (r.image_base64 as string | undefined) ||
              (r.image as string | undefined) ||
              (r.base64 as string | undefined);
            if (!imageBase64 || typeof imageBase64 !== 'string') return null;
            return { id: typeof r.id === 'string' && r.id ? r.id : `idx-${index}`, imageBase64 };
          }
          return null;
        })
        .filter((item): item is { id: string; imageBase64: string } => Boolean(item));
      if (!items.length) return null;
      const matched = proj.default_cover_id ? items.find((item) => item.id === proj.default_cover_id) : null;
      return matched?.imageBase64 || items[0].imageBase64;
    } catch {
      return null;
    }
  };

  const coverSrc = getDefaultCoverSrc(project);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  const cleanDescription = (project.description || '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\n/g, ' ')
    .trim();

  return (
    <div
      onClick={onClick}
      className="h-[340px] flex flex-col bg-white dark:bg-gray-800 rounded-xl border-2 border-purple-100 dark:border-purple-900/30 p-5 hover:shadow-lg hover:border-purple-300 dark:hover:border-purple-700 transition-all cursor-pointer relative group overflow-hidden"
    >
      {/* Type badge */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 text-xs font-medium">
        <BookOpen className="w-3 h-3" />
        {tx(uiLanguage, '长篇', 'Long Novel')}
      </div>

      <button
        onClick={handleDelete}
        className="absolute top-3 right-3 z-10 p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 text-red-600"
        title={tx(uiLanguage, '删除项目', 'Delete project')}
      >
        <Trash2 className="w-4 h-4" />
      </button>

      <div className="mt-7 flex gap-4 flex-1 min-h-0">
        {/* Cover image — fills the card height for a uniform look */}
        <div className="flex-shrink-0 w-[108px] h-full">
          <div className="w-full h-full rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600">
            {coverSrc ? (
              <img src={coverSrc} alt="cover-preview" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
                {tx(uiLanguage, '暂无封面', 'No cover')}
              </div>
            )}
          </div>
        </div>

        {/* Content — fixed-height sections so every card lines up */}
        <div className="flex-1 min-w-0 flex flex-col h-full">
          {/* Title + genre (reserves 2 lines) */}
          <div className="flex items-start justify-between gap-2 h-[3.25rem] shrink-0 pr-6">
            <h3 className="text-lg font-semibold leading-snug text-gray-900 dark:text-white line-clamp-2">
              {project.title}
            </h3>
            {project.genre && (
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 flex-shrink-0">
                {project.genre}
              </span>
            )}
          </div>

          {/* Description — always reserves exactly 3 lines (leading-5 × 3 = 3.75rem) so the
              line-clamp ellipsis lands on line 3 and can never spill onto a 4th line. */}
          <p className="mt-1 h-[3.75rem] shrink-0 overflow-hidden text-sm leading-5 text-gray-600 dark:text-gray-400 line-clamp-3">
            {cleanDescription}
          </p>

          {/* Arc progress — fixed-height box; overflow scrolls with the wheel */}
          <div className="mt-2 h-[5.5rem] shrink-0 flex flex-col rounded-lg bg-purple-50 dark:bg-purple-900/20 p-2">
            <div className="flex items-center gap-2 mb-1 shrink-0">
              <Layers className="w-3.5 h-3.5 text-purple-600" />
              <span className="text-xs font-medium text-purple-700 dark:text-purple-300">
                {tx(uiLanguage, '剧情进度', 'Story Progress')}
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1" onWheel={(e) => e.stopPropagation()}>
              {arcs.length > 0 ? (
                <>
                  <div className="flex gap-1.5 flex-wrap">
                    {arcs.map((arc) => (
                      <span
                        key={arc.id}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          arc.status === 'completed'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : arc.status === 'active'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : arc.status === 'ending'
                            ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                            : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                        }`}
                      >
                        {arc.title}
                      </span>
                    ))}
                  </div>
                  {activeArc && (
                    <p className="text-xs text-purple-600 dark:text-purple-400 mt-1.5">
                      {activeArc.status === 'ending'
                        ? tx(uiLanguage, `结尾阶段：还剩 ${activeArc.chaptersUntilEnd ?? '?'} 章`, `Ending phase: ${activeArc.chaptersUntilEnd ?? '?'} chapters left`)
                        : tx(uiLanguage, `当前弧线：${activeArc.title}`, `Current arc: ${activeArc.title}`)}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-gray-400">{tx(uiLanguage, '暂无剧情弧线', 'No plot arcs yet')}</p>
              )}
            </div>
          </div>

          {/* Spacer pushes the stats block to the bottom of the card */}
          <div className="flex-1 min-h-0" />

          {/* Word count + 副本/弧线/章节 counts on one row */}
          <div className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-400 shrink-0">
            <span className="flex items-center gap-1 min-w-0 truncate">
              <TrendingUp className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">
                {formatWordCount(project.current_word_count)}
                {project.target_word_count && ` / ${formatWordCount(project.target_word_count)}`}
              </span>
            </span>
            <span className="flex items-center gap-1 flex-shrink-0 text-gray-500 dark:text-gray-400">
              <span>{tx(uiLanguage, '副本', 'Vol')} {volumeCount}</span>
              <span className="opacity-50">·</span>
              <span>{tx(uiLanguage, '弧线', 'Arc')} {arcs.length}</span>
              <span className="opacity-50">·</span>
              <span>{tx(uiLanguage, '章', 'Ch')} {chapterCount ?? '…'}</span>
            </span>
          </div>

          {/* Date */}
          <div className="flex items-center text-xs text-gray-500 dark:text-gray-400 mt-1.5 shrink-0">
            <Calendar className="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
            <span className="truncate">{formatDate(project.updated_at)}</span>
          </div>

          {/* Progress bar */}
          {project.target_word_count ? (
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 mt-2 shrink-0">
              <div
                className="bg-purple-600 h-1.5 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          ) : (
            <div className="h-1.5 mt-2 shrink-0" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Create Long Novel Modal ────────────────────────────────────
interface CreateLongNovelModalProps {
  onClose: () => void;
  onSuccess: (projectId: string) => void;
}

function CreateLongNovelModal({ onClose, onSuccess }: CreateLongNovelModalProps) {
  const uiLanguage = useAppStore((state) => state.uiLanguage);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [genre, setGenre] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const project = await projectApi.create({
        title,
        author: author || undefined,
        genre: genre || undefined,
        description: description || undefined,
        language: uiLanguage,
      });
      onSuccess(project.id);
    } catch {
      void uiAlert({ title: tx(uiLanguage, '提示', 'Notice'), message: tx(uiLanguage, '创建项目失败', 'Failed to create project') });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
          {tx(uiLanguage, '新建长篇小说', 'New Long Novel')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {tx(uiLanguage, '创建后可生成故事大纲和剧情弧线', 'Generate story outline and plot arcs after creation')}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '书名 *', 'Title *')}
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '作者笔名', 'Author')}
            </label>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '题材', 'Genre')}
            </label>
            <input
              type="text"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500"
              placeholder={tx(uiLanguage, '例如：玄幻、都市、科幻', 'e.g. Fantasy, Urban, Sci-Fi')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '故事简介', 'Story Description')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 h-28 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
              placeholder={tx(uiLanguage, '简要描述故事背景、核心矛盾、主要角色...', 'Briefly describe the story background, core conflict, main characters...')}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1">
              {tx(uiLanguage, '取消', 'Cancel')}
            </Button>
            <Button
              type="submit"
              loading={loading}
              className="flex-1 bg-purple-600 hover:bg-purple-700 border-purple-600"
            >
              {tx(uiLanguage, '创建', 'Create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
