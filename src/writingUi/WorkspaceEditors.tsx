import { useState, type ReactNode } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { TextArea } from '@components/TextArea';
import type { Chapter, TextModelProfile, UiLanguage } from '@typings/index';
import type { Character } from '@store/index';
import { tx } from '@utils/i18n';
import {
  MAX_SCENES,
  validateScenePlan,
  validateWorkspace,
  type ChapterScenePlan,
  type SceneSpec,
  type StoryNote,
  type StoryNoteKind,
  type WritingWorkspace,
} from '../writing';
import { WorkspaceModal } from './WorkspaceModal';

const controlClass =
  'w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-600 text-sm';
function SelectField({
  label,
  children,
  value,
  onChange,
}: {
  label: string;
  children: ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className={controlClass}
      >
        {children}
      </select>
    </label>
  );
}

export function WritingPreferencesModal({
  workspace,
  profiles,
  language,
  onClose,
  onSave,
}: {
  workspace: WritingWorkspace;
  profiles: TextModelProfile[];
  language: UiLanguage;
  onClose: () => void;
  onSave: (workspace: WritingWorkspace) => Promise<void>;
}) {
  const [draft, setDraft] = useState(workspace),
    [quota, setQuota] = useState(String(workspace.maxRequestsPerRun));
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const modes = {
    quick: tx(language, '快速写作', 'Quick'),
    scene: tx(language, '场景写作', 'Scenes'),
    polish: tx(language, '精修审稿', 'Polished'),
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave(validateWorkspace({ ...draft, maxRequestsPerRun: Number(quota) }));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const roleFields = [
    'planningProfileId',
    'writingProfileId',
    'reviewProfileId',
    'extractionProfileId',
  ] as const;
  const roleLabels = [
    tx(language, '规划模型', 'Planning model'),
    tx(language, '正文模型', 'Writing model'),
    tx(language, '审稿模型', 'Review model'),
    tx(language, '资料提取模型', 'Extraction model'),
  ];
  return (
    <WorkspaceModal
      title={tx(language, '本书写作偏好', 'Writing preferences')}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {tx(language, '取消', 'Cancel')}
            </Button>
            <Button loading={busy} onClick={() => void save()}>
              {tx(language, '保存', 'Save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex gap-2">
          {(Object.keys(modes) as (keyof typeof modes)[]).map(mode => (
            <Button
              key={mode}
              variant={draft.mode === mode ? 'primary' : 'outline'}
              size="sm"
              disabled={busy}
              onClick={() => setDraft({ ...draft, mode })}
            >
              {modes[mode]}
            </Button>
          ))}
        </div>
        <p className="text-sm text-gray-500">
          {tx(
            language,
            '快速模式整章生成；场景模式先规划再逐场写作；精修模式再检查约束与角色知情范围。所有生成结果先进入候选审核。',
            'Quick mode drafts a chapter; scene mode plans and writes each scene; polished mode also reviews constraints and character knowledge. All results await your approval.'
          )}
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <TextArea
            label={tx(language, '叙述人称与视角', 'Narration and viewpoint')}
            value={draft.perspective}
            rows={3}
            maxLength={12000}
            onChange={event => setDraft({ ...draft, perspective: event.target.value })}
          />
          <TextArea
            label={tx(language, '文风与节奏', 'Style and pacing')}
            value={draft.style}
            rows={3}
            maxLength={12000}
            onChange={event => setDraft({ ...draft, style: event.target.value })}
          />
          <TextArea
            label={tx(language, '禁用表达', 'Forbidden expressions')}
            value={draft.forbiddenExpressions}
            rows={3}
            maxLength={12000}
            onChange={event => setDraft({ ...draft, forbiddenExpressions: event.target.value })}
          />
          <TextArea
            label={tx(language, '认可的正文样例', 'Preferred prose sample')}
            value={draft.sampleProse}
            rows={3}
            maxLength={12000}
            onChange={event => setDraft({ ...draft, sampleProse: event.target.value })}
          />
        </div>
        <Input
          type="number"
          min={1}
          max={64}
          label={tx(
            language,
            '单次任务请求上限（规划、续写、重试和审稿均计入）',
            'Requests per run (including planning, continuation, retries and review)'
          )}
          value={quota}
          onChange={event => setQuota(event.target.value)}
        />
        <div className="grid md:grid-cols-2 gap-4">
          {roleFields.map((field, index) => (
            <SelectField
              key={field}
              label={roleLabels[index]}
              value={draft[field] ?? ''}
              onChange={value => setDraft({ ...draft, [field]: value || null })}
            >
              <option value="">{tx(language, '沿用全局模型', 'Use global model')}</option>
              {draft[field] && !profiles.some(profile => profile.id === draft[field]) && (
                <option value={draft[field]!}>
                  {tx(language, '原模型已失效，请重新指定', 'Previous profile unavailable')}
                </option>
              )}
              {profiles.map(profile => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.model}
                </option>
              ))}
            </SelectField>
          ))}
        </div>
      </div>
    </WorkspaceModal>
  );
}

const noteKinds: StoryNoteKind[] = ['canon', 'plan', 'fact', 'belief', 'foreshadowing'];
const labels: Record<StoryNoteKind, [string, string]> = {
  canon: ['作者设定', 'Canon'],
  plan: ['未来计划', 'Plans'],
  fact: ['已发生事实', 'Facts'],
  belief: ['角色认知', 'Beliefs'],
  foreshadowing: ['伏笔', 'Foreshadowing'],
};
export function StoryNotesModal({
  workspace,
  chapters,
  characters,
  sourceStatuses,
  language,
  onClose,
  onSave,
}: {
  workspace: WritingWorkspace;
  chapters: Chapter[];
  characters: Character[];
  sourceStatuses: Record<string, string>;
  language: UiLanguage;
  onClose: () => void;
  onSave: (notes: StoryNote[]) => Promise<void>;
}) {
  const [notes, setNotes] = useState(workspace.notes),
    [kind, setKind] = useState<StoryNoteKind | 'all'>('all');
  const [editing, setEditing] = useState<StoryNote | null>(null),
    [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const filtered = notes.filter(note => kind === 'all' || note.kind === kind);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSave(notes);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const newNote = (): StoryNote => ({
    id: crypto.randomUUID(),
    kind: kind === 'all' ? 'canon' : kind,
    subject: '',
    text: '',
    sourceChapterId: null,
    sourceBodyHash: null,
    knownByCharacterIds: [],
    payoffChapterId: null,
    importance: 1,
    resolved: false,
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / 30));
  return (
    <>
      <WorkspaceModal
        title={tx(language, '故事状态与伏笔', 'Story state and foreshadowing')}
        onClose={onClose}
        busy={busy}
        footer={
          <div className="space-y-2">
            {error && (
              <p role="alert" className="text-red-600 text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {tx(language, '取消', 'Cancel')}
              </Button>
              <Button loading={busy} onClick={() => void save()}>
                {tx(language, '保存故事状态', 'Save story state')}
              </Button>
            </div>
          </div>
        }
      >
        <p className="text-sm text-gray-500 mb-4">
          {tx(
            language,
            '设定和未来计划不代表已经发生，也不代表角色已知。关联来源正文的卡片在正文变化后退出生成上下文，核对后可重新绑定。',
            'Canon and plans are not established facts or character knowledge. Source-linked cards are excluded when the source text changes; verify before rebinding.'
          )}
        </p>
        <div className="flex gap-2 flex-wrap mb-5">
          <Button
            size="sm"
            variant={kind === 'all' ? 'primary' : 'outline'}
            onClick={() => {
              setKind('all');
              setPage(0);
            }}
          >
            {tx(language, '全部', 'All')}
          </Button>
          {noteKinds.map(key => (
            <Button
              key={key}
              size="sm"
              variant={kind === key ? 'primary' : 'outline'}
              onClick={() => {
                setKind(key);
                setPage(0);
              }}
            >
              {tx(language, ...labels[key])}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={notes.length >= 2000}
            onClick={() => setEditing(newNote())}
          >
            {tx(language, '新增卡片', 'New card')}
          </Button>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          {filtered
            .slice(Math.min(page, pageCount - 1) * 30, (Math.min(page, pageCount - 1) + 1) * 30)
            .map(note => (
              <article
                key={note.id}
                className="border dark:border-gray-700 rounded-lg p-4 space-y-2"
              >
                <p className="text-xs text-primary-600">
                  {tx(language, ...labels[note.kind])} ·{' '}
                  {note.importance === 3
                    ? tx(language, '关键', 'Critical')
                    : note.importance === 2
                      ? tx(language, '重要', 'Important')
                      : tx(language, '一般', 'Normal')}
                  {note.resolved ? ` · ${tx(language, '已回收', 'Resolved')}` : ''}
                </p>
                <h3 className="font-medium">{note.subject}</h3>
                <p className="text-sm whitespace-pre-wrap line-clamp-6">{note.text}</p>
                {note.sourceChapterId && (
                  <p className="text-xs text-gray-500">
                    {tx(language, '来源：', 'Source: ')}
                    {chapters.find(chapter => chapter.id === note.sourceChapterId)?.title ??
                      tx(language, '章节已删除', 'Deleted chapter')}
                  </p>
                )}
                {note.sourceChapterId && (
                  <p className="text-xs text-amber-700">
                    {note.sourceBodyHash === null
                      ? tx(language, '保存后绑定当前正文', 'Will bind to current source on save')
                      : sourceStatuses[note.id]}
                  </p>
                )}
                {note.knownByCharacterIds.length > 0 && (
                  <p className="text-xs text-gray-500">
                    {tx(language, '知情：', 'Known by: ')}
                    {note.knownByCharacterIds
                      .map(
                        id =>
                          characters.find(character => character.id === id)?.name ??
                          tx(language, '角色已删除', 'Deleted character')
                      )
                      .join('、')}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(note)}>
                    {tx(language, '编辑', 'Edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setNotes(notes.filter(item => item.id !== note.id))}
                  >
                    {tx(language, '删除', 'Delete')}
                  </Button>
                </div>
              </article>
            ))}
        </div>
        {!filtered.length && (
          <p className="text-gray-500">
            {tx(language, '此类型暂无卡片', 'No cards in this category')}
          </p>
        )}
        {pageCount > 1 && (
          <div className="flex justify-center items-center gap-3 mt-5">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              {tx(language, '上一页', 'Previous')}
            </Button>
            <span>
              {Math.min(page, pageCount - 1) + 1}/{pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              {tx(language, '下一页', 'Next')}
            </Button>
          </div>
        )}
      </WorkspaceModal>
      {editing && (
        <StoryNoteEditor
          key={editing.id}
          note={editing}
          chapters={chapters}
          characters={characters}
          sourceStatus={sourceStatuses[editing.id]}
          language={language}
          onClose={() => setEditing(null)}
          onSave={note => {
            setNotes(current =>
              current.some(item => item.id === note.id)
                ? current.map(item => (item.id === note.id ? note : item))
                : [...current, note]
            );
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function StoryNoteEditor({
  note,
  chapters,
  characters,
  sourceStatus,
  language,
  onClose,
  onSave,
}: {
  note: StoryNote;
  chapters: Chapter[];
  characters: Character[];
  sourceStatus?: string;
  language: UiLanguage;
  onClose: () => void;
  onSave: (note: StoryNote) => void;
}) {
  const [draft, setDraft] = useState(note),
    [error, setError] = useState('');
  const save = () => {
    try {
      validateWorkspace({
        version: 1,
        mode: 'scene',
        style: '',
        perspective: '',
        forbiddenExpressions: '',
        sampleProse: '',
        maxRequestsPerRun: 16,
        planningProfileId: null,
        writingProfileId: null,
        reviewProfileId: null,
        extractionProfileId: null,
        notes: [draft],
      });
      onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const chapterOptions = (
    <>
      <option value="">{tx(language, '不指定', 'Unassigned')}</option>
      {chapters.map(chapter => (
        <option key={chapter.id} value={chapter.id}>
          {chapter.title}
        </option>
      ))}
    </>
  );
  return (
    <WorkspaceModal
      title={tx(language, '编辑故事卡片', 'Edit story card')}
      onClose={onClose}
      footer={
        <div className="space-y-2">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onClose}>
              {tx(language, '取消', 'Cancel')}
            </Button>
            <Button onClick={save}>{tx(language, '保存卡片', 'Save card')}</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <SelectField
          label={tx(language, '类型', 'Category')}
          value={draft.kind}
          onChange={value => setDraft({ ...draft, kind: value as StoryNoteKind })}
        >
          {noteKinds.map(kind => (
            <option key={kind} value={kind}>
              {tx(language, ...labels[kind])}
            </option>
          ))}
        </SelectField>
        <Input
          label={tx(language, '人物、物品或主题', 'Subject')}
          maxLength={256}
          value={draft.subject}
          onChange={event => setDraft({ ...draft, subject: event.target.value })}
        />
        <TextArea
          label={tx(language, '内容', 'Content')}
          rows={5}
          maxLength={12000}
          value={draft.text}
          onChange={event => setDraft({ ...draft, text: event.target.value })}
        />
        <SelectField
          label={
            draft.kind === 'fact'
              ? tx(language, '来源章节（必选）', 'Source chapter (required)')
              : tx(language, '来源章节', 'Source chapter')
          }
          value={draft.sourceChapterId ?? ''}
          onChange={value =>
            setDraft({ ...draft, sourceChapterId: value || null, sourceBodyHash: null })
          }
        >
          {chapterOptions}
        </SelectField>
        {draft.sourceChapterId && (
          <div className="flex gap-3 items-center flex-wrap">
            <span className="text-xs text-amber-700">
              {draft.sourceBodyHash === null
                ? tx(language, '保存后绑定当前正文', 'Will bind to current text on save')
                : sourceStatus}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDraft({ ...draft, sourceBodyHash: null })}
            >
              {tx(language, '已核对当前正文', 'Verified against current text')}
            </Button>
          </div>
        )}
        <SelectField
          label={tx(language, '计划回收章节', 'Payoff chapter')}
          value={draft.payoffChapterId ?? ''}
          onChange={value => setDraft({ ...draft, payoffChapterId: value || null })}
        >
          {chapterOptions}
        </SelectField>
        <SelectField
          label={tx(language, '重要度', 'Importance')}
          value={String(draft.importance)}
          onChange={value => setDraft({ ...draft, importance: Number(value) })}
        >
          <option value="1">{tx(language, '一般', 'Normal')}</option>
          <option value="2">{tx(language, '重要', 'Important')}</option>
          <option value="3">{tx(language, '关键', 'Critical')}</option>
        </SelectField>
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {tx(
              language,
              '知情人物（未选人物不能直接获知）',
              'Characters who know (others may not know)'
            )}
          </p>
          <div className="max-h-48 overflow-y-auto grid sm:grid-cols-2 gap-2 border dark:border-gray-700 rounded p-3">
            {characters.map(character => (
              <label key={character.id} className="flex gap-2 items-center text-sm">
                <input
                  type="checkbox"
                  checked={draft.knownByCharacterIds.includes(character.id)}
                  onChange={event =>
                    setDraft({
                      ...draft,
                      knownByCharacterIds: event.target.checked
                        ? [...draft.knownByCharacterIds, character.id]
                        : draft.knownByCharacterIds.filter(id => id !== character.id),
                    })
                  }
                />
                {character.name}
              </label>
            ))}
          </div>
        </div>
        {draft.kind === 'foreshadowing' && (
          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={draft.resolved}
              onChange={event => setDraft({ ...draft, resolved: event.target.checked })}
            />
            {tx(language, '伏笔已回收', 'Foreshadowing resolved')}
          </label>
        )}
      </div>
    </WorkspaceModal>
  );
}

interface SceneDraft {
  spec: SceneSpec;
  words: string;
  required: string;
  forbidden: string;
}
function freshScene(index: number): SceneDraft {
  return {
    spec: {
      id: crypto.randomUUID(),
      title: `场景 ${index}`,
      pov: '',
      time: '',
      location: '',
      goal: '',
      conflict: '',
      turn: '',
      entryState: '',
      exitState: '',
      requiredEvents: [],
      forbiddenEvents: [],
      targetWords: 1500,
    },
    words: '1500',
    required: '',
    forbidden: '',
  };
}
export function ScenePlanModal({
  plan,
  language,
  onClose,
  onSave,
}: {
  plan: ChapterScenePlan;
  language: UiLanguage;
  onClose: () => void;
  onSave: (plan: ChapterScenePlan) => Promise<void>;
}) {
  const [scenes, setScenes] = useState<SceneDraft[]>(
    plan.scenes.map(spec => ({
      spec,
      words: String(spec.targetWords),
      required: spec.requiredEvents.join('\n'),
      forbidden: spec.forbiddenEvents.join('\n'),
    }))
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const update = (id: string, transform: (scene: SceneDraft) => SceneDraft) =>
    setScenes(current => current.map(item => (item.spec.id === id ? transform(item) : item)));
  const move = (index: number, delta: number) =>
    setScenes(current => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const value = validateScenePlan({
        ...plan,
        updatedAt: Date.now(),
        scenes: scenes.map(item => ({
          ...item.spec,
          targetWords: Number(item.words),
          requiredEvents: item.required
            .split('\n')
            .map(text => text.trim())
            .filter(Boolean),
          forbiddenEvents: item.forbidden
            .split('\n')
            .map(text => text.trim())
            .filter(Boolean),
        })),
      });
      await onSave(value);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const fields: [
    keyof Pick<
      SceneSpec,
      | 'title'
      | 'pov'
      | 'time'
      | 'location'
      | 'goal'
      | 'conflict'
      | 'turn'
      | 'entryState'
      | 'exitState'
    >,
    string,
  ][] = [
    ['title', tx(language, '标题', 'Title')],
    ['pov', tx(language, '视角人物', 'Viewpoint')],
    ['time', tx(language, '时间', 'Time')],
    ['location', tx(language, '地点', 'Location')],
    ['goal', tx(language, '本场目标（必填）', 'Goal (required)')],
    ['conflict', tx(language, '冲突', 'Conflict')],
    ['turn', tx(language, '转折', 'Turning point')],
    ['entryState', tx(language, '入场状态', 'Entry state')],
    ['exitState', tx(language, '结束状态', 'Exit state')],
  ];
  return (
    <WorkspaceModal
      title={tx(language, '章节场景计划', 'Chapter scene plan')}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {tx(language, '取消', 'Cancel')}
            </Button>
            <Button loading={busy} onClick={() => void save()}>
              {tx(language, '保存计划', 'Save plan')}
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-sm text-gray-500 mb-4">
        {tx(
          language,
          '修改顺序与约束后从新任务开始；已保存草稿仍可只读查看。',
          'An edited plan starts a new run. Saved drafts remain available for read-only preview.'
        )}
      </p>
      <div className="space-y-4">
        {scenes.map((item, index) => (
          <details
            key={item.spec.id}
            open={index === 0}
            className="border dark:border-gray-700 rounded-lg p-4"
          >
            <summary className="cursor-pointer font-medium">
              {index + 1}. {item.spec.title}
            </summary>
            <div className="flex gap-2 my-3">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || index === 0}
                onClick={() => move(index, -1)}
              >
                {tx(language, '上移', 'Move up')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || index === scenes.length - 1}
                onClick={() => move(index, 1)}
              >
                {tx(language, '下移', 'Move down')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || scenes.length === 1}
                onClick={() => setScenes(scenes.filter(scene => scene.spec.id !== item.spec.id))}
              >
                {tx(language, '删除此场', 'Delete scene')}
              </Button>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              {fields.map(([field, label]) => (
                <TextArea
                  key={field}
                  label={label}
                  rows={2}
                  maxLength={4000}
                  value={item.spec[field]}
                  onChange={event =>
                    update(item.spec.id, current => ({
                      ...current,
                      spec: { ...current.spec, [field]: event.target.value },
                    }))
                  }
                />
              ))}
              <TextArea
                label={tx(language, '必须发生的事件（每行一条）', 'Required events (one per line)')}
                rows={3}
                value={item.required}
                onChange={event =>
                  update(item.spec.id, current => ({ ...current, required: event.target.value }))
                }
              />
              <TextArea
                label={tx(
                  language,
                  '禁止发生或提前泄露（每行一条）',
                  'Forbidden events or disclosures (one per line)'
                )}
                rows={3}
                value={item.forbidden}
                onChange={event =>
                  update(item.spec.id, current => ({ ...current, forbidden: event.target.value }))
                }
              />
              <Input
                label={tx(language, '目标字数（100–8000）', 'Target length (100–8000)')}
                type="number"
                min={100}
                max={8000}
                value={item.words}
                onChange={event =>
                  update(item.spec.id, current => ({ ...current, words: event.target.value }))
                }
              />
            </div>
          </details>
        ))}
      </div>
      <Button
        className="mt-4"
        variant="outline"
        disabled={busy || scenes.length >= MAX_SCENES}
        onClick={() => setScenes([...scenes, freshScene(scenes.length + 1)])}
      >
        {tx(
          language,
          `新增场景（${scenes.length}/${MAX_SCENES}）`,
          `Add scene (${scenes.length}/${MAX_SCENES})`
        )}
      </Button>
    </WorkspaceModal>
  );
}
