import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@store/index';
import { projectApi } from '@services/api';
import { Button } from '@components/Button';
import { uiAlert } from '@components/uiDialog';
import { Plus, BookOpen, Calendar, TrendingUp, Trash2, ScrollText } from 'lucide-react';
import { formatDate, formatWordCount, calculateProgress, confirmDialog } from '@utils/index';
import { clearProjectPageCache } from '@utils/projectPageCache';
import { tx } from '@utils/i18n';
import type { Project } from '@typings/index';

export function HomePage() {
  const navigate = useNavigate();
  const { projects, setProjects, uiLanguage, novelTypeByProject, closeProjectTab } = useAppStore();
  // Render instantly if zustand has cached projects from a previous mount in this session.
  // Only show the "Loading..." splash on a truly cold start.
  const [loading, setLoading] = useState(projects.length === 0);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Short novel home only shows short novels
  const shortProjects = projects.filter(
    (p) => !novelTypeByProject[p.id] || novelTypeByProject[p.id] === 'short'
  );

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      // Step 1: fast initial load — render as soon as this returns.
      const data = await projectApi.getAll();
      setProjects(data);
      setLoading(false);

      // Step 2: defensive word-count recalc in the background, in parallel.
      // Per-project errors are isolated so one bad row never blocks the batch.
      const { invoke } = await import('@tauri-apps/api/tauri');
      await Promise.all(
        data.map((project) =>
          invoke('recalculate_project_word_count', { projectId: project.id }).catch((error) => {
            console.error('Failed to update word count for', project.id, error);
          })
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

  const handleCreateProject = () => {
    setShowCreateModal(true);
  };

  const handleDeleteProject = async (projectId: string) => {
    const confirmed = await confirmDialog(
      tx(
        uiLanguage,
        '确定要删除这个项目吗？删除后无法恢复！',
        'Delete this project? This action cannot be undone.'
      ),
      tx(uiLanguage, '删除项目', 'Delete Project')
    );
    if (!confirmed) return;

    try {
      await projectApi.delete(projectId);
      closeProjectTab(projectId);      // drop its Topbar tab
      clearProjectPageCache(projectId); // and its stale landing-page cache
      loadProjects();
    } catch (error) {
      console.error('Failed to delete project:', error);
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
            <ScrollText className="w-7 h-7 text-primary-600" />
            {tx(uiLanguage, '短篇小说', 'Short Stories')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1 text-sm md:text-base">
            {tx(uiLanguage, '管理你的短篇小说创作项目', 'Manage your short story projects')}
          </p>
        </div>
        <Button onClick={handleCreateProject} className="whitespace-nowrap self-start sm:self-auto">
          <Plus className="w-4 h-4 mr-2" />
          {tx(uiLanguage, '新建短篇项目', 'New Short Story')}
        </Button>
      </div>

      {shortProjects.length === 0 ? (
        <div className="text-center py-20">
          <BookOpen className="w-16 h-16 mx-auto text-gray-400 mb-4" />
          <h3 className="text-xl font-medium text-gray-700 dark:text-gray-300 mb-2">
            {tx(uiLanguage, '还没有项目', 'No projects yet')}
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            {tx(
              uiLanguage,
              '创建你的第一个小说项目开始创作吧！',
              'Create your first novel project to get started.'
            )}
          </p>
          <Button onClick={handleCreateProject}>
            <Plus className="w-4 h-4 mr-2" />
            {tx(uiLanguage, '创建项目', 'Create Project')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {shortProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              uiLanguage={uiLanguage}
              onClick={() => navigate(`/workbench/${project.id}`)}
              onDelete={() => handleDeleteProject(project.id)}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onSuccess={(novelType, projectId) => {
            setShowCreateModal(false);
            if (novelType === 'long') {
              navigate(`/workbench/${projectId}`);
            } else {
              loadProjects();
            }
          }}
        />
      )}
    </div>
  );
}

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/[-*]\s+/g, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

interface ProjectCardProps {
  project: Project;
  uiLanguage: 'zh' | 'en';
  onClick: () => void;
  onDelete: () => void;
}

function ProjectCard({ project, uiLanguage, onClick, onDelete }: ProjectCardProps) {
  const progress = project.target_word_count
    ? calculateProgress(project.current_word_count, project.target_word_count)
    : 0;

  const getDefaultCoverSrc = (proj: Project): string | null => {
    if (!proj.cover_images) return null;
    try {
      const parsed = JSON.parse(proj.cover_images);
      if (!Array.isArray(parsed)) return null;

      const items = parsed
        .map((item, index) => {
          if (typeof item === 'string') {
            return { id: `idx-${index}`, imageBase64: item };
          }
          if (item && typeof item === 'object') {
            const rawItem = item as Record<string, unknown>;
            const imageBase64 =
              (rawItem.imageBase64 as string | undefined) ||
              (rawItem.image_base64 as string | undefined) ||
              (rawItem.image as string | undefined) ||
              (rawItem.base64 as string | undefined);
            if (!imageBase64 || typeof imageBase64 !== 'string') return null;
            return {
              id: typeof rawItem.id === 'string' && rawItem.id ? rawItem.id : `idx-${index}`,
              imageBase64,
            };
          }
          return null;
        })
        .filter((item): item is { id: string; imageBase64: string } => Boolean(item));

      if (!items.length) return null;
      const defaultId = proj.default_cover_id;
      const matched = defaultId ? items.find((item) => item.id === defaultId) : null;
      return matched?.imageBase64 || items[0].imageBase64;
    } catch {
      return null;
    }
  };

  const coverSrc = getDefaultCoverSrc(project);
  const outlinePreview = project.description ? stripMarkdown(project.description) : '';

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    onDelete();
  };

  return (
    <div
      onClick={onClick}
      className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 hover:shadow-lg transition-shadow cursor-pointer relative group"
    >
      <button
        onClick={handleDelete}
        className="absolute top-3 right-3 p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 text-red-600"
        title={tx(uiLanguage, '删除项目', 'Delete project')}
      >
        <Trash2 className="w-4 h-4" />
      </button>

      <div className="flex gap-4">
        <div className="flex-shrink-0">
          <div
            className="rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600"
            style={{ width: 108, height: 192 }}
          >
            {coverSrc ? (
              <img src={coverSrc} alt="cover-preview" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
                {tx(uiLanguage, '暂无封面', 'No cover')}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between mb-4 pr-8">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white line-clamp-2">
              {project.title}
            </h3>
            {project.genre && (
              <span className="ml-2 px-2 py-1 text-xs font-medium rounded-full bg-primary-100 text-primary-800 dark:bg-primary-900/30 dark:text-primary-400 flex-shrink-0">
                {project.genre}
              </span>
            )}
          </div>

          {outlinePreview && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 line-clamp-2">
              {outlinePreview}
            </p>
          )}

          <div className="space-y-2 mb-4">
            <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
              <TrendingUp className="w-4 h-4 mr-2" />
              <span>
                {formatWordCount(project.current_word_count)}
                {project.target_word_count && ` / ${formatWordCount(project.target_word_count)}`}
              </span>
            </div>
            <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
              <Calendar className="w-4 h-4 mr-2" />
              <span>{formatDate(project.updated_at)}</span>
            </div>
          </div>

          {project.target_word_count && (
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-primary-600 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface CreateProjectModalProps {
  onClose: () => void;
  onSuccess: (novelType: 'short' | 'long', projectId: string) => void;
}

function CreateProjectModal({ onClose, onSuccess }: CreateProjectModalProps) {
  const uiLanguage = useAppStore((state) => state.uiLanguage);
  const { setNovelType } = useAppStore();
  const [novelType, setNovelTypeLocal] = useState<'short' | 'long'>('short');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [genre, setGenre] = useState('');
  const [description, setDescription] = useState('');
  const [targetWordCount, setTargetWordCount] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);

    try {
      const project = await projectApi.create({
        title,
        author: author || undefined,
        genre: genre || undefined,
        description: description || undefined,
        language: uiLanguage,
        target_word_count: targetWordCount ? parseInt(targetWordCount, 10) : undefined,
      });
      setNovelType(project.id, novelType);
      onSuccess(novelType, project.id);
    } catch (error) {
      console.error('Failed to create project:', error);
      void uiAlert({ title: tx(uiLanguage, '提示', 'Notice'), message: tx(uiLanguage, '创建项目失败', 'Failed to create project') });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
          {tx(uiLanguage, '创建新项目', 'Create New Project')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Novel type selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {tx(uiLanguage, '小说类型 *', 'Novel Type *')}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setNovelTypeLocal('short')}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                  novelType === 'short'
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400'
                    : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500'
                }`}
              >
                <ScrollText className="w-8 h-8" />
                <div className="text-center">
                  <div className="font-semibold text-sm">{tx(uiLanguage, '短篇小说', 'Short Story')}</div>
                  <div className="text-xs opacity-70 mt-0.5">{tx(uiLanguage, '固定章节结构', 'Fixed chapter structure')}</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setNovelTypeLocal('long')}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                  novelType === 'long'
                    ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                    : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500'
                }`}
              >
                <BookOpen className="w-8 h-8" />
                <div className="text-center">
                  <div className="font-semibold text-sm">{tx(uiLanguage, '长篇小说', 'Long Novel')}</div>
                  <div className="text-xs opacity-70 mt-0.5">{tx(uiLanguage, '剧情弧线推进', 'Story arc progression')}</div>
                </div>
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '书名 *', 'Title *')}
            </label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
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
              onChange={(event) => setAuthor(event.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '题材', 'Genre')}
            </label>
            <input
              type="text"
              value={genre}
              onChange={(event) => setGenre(event.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
              placeholder={tx(uiLanguage, '例如：玄幻、都市、科幻', 'e.g. Fantasy, Urban, Sci-Fi')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '简介', 'Description')}
            </label>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 h-24 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {tx(uiLanguage, '目标字数', 'Target Word Count')}
            </label>
            <input
              type="number"
              value={targetWordCount}
              onChange={(event) => setTargetWordCount(event.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
              placeholder={novelType === 'long' ? '1000000' : '100000'}
            />
          </div>

          <div className="flex space-x-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1">
              {tx(uiLanguage, '取消', 'Cancel')}
            </Button>
            <Button type="submit" loading={loading} className="flex-1">
              {tx(uiLanguage, '创建', 'Create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
