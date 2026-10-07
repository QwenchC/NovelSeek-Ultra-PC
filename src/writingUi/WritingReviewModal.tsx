import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { TextArea } from '@components/TextArea';
import type { UiLanguage } from '@typings/index';
import { tx } from '@utils/i18n';
import { WorkspaceModal } from './WorkspaceModal';
import { assembledReviewText, diffParagraphs, textChunks } from './textReview';

export interface ReviewUiFinding {
  id: string;
  title: string;
  detail: string;
  quote?: string;
  blocking?: boolean;
}
export interface ReviewUiCandidate {
  id: string;
  chapterId: string;
  title: string;
  body: string;
  baselineText: string;
  findings: ReviewUiFinding[];
}

/** Pages bound DOM and text layout size; the complete source remains available without truncation. */
export function PagedTextPreview({
  text,
  language,
  pageChunks = 8,
}: {
  text: string;
  language: UiLanguage;
  pageChunks?: number;
}) {
  const chunks = useMemo(() => textChunks(text), [text]);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(chunks.length / pageChunks));
  useEffect(() => setPage(0), [text]);
  const current = Math.min(page, pages - 1);
  return (
    <div className="space-y-3">
      {pages > 1 && (
        <div className="flex gap-3 items-center text-sm flex-wrap">
          <Button
            variant="outline"
            size="sm"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            {tx(language, '上一页', 'Previous')}
          </Button>
          <span>
            {current + 1} / {pages} · {text.length} {tx(language, '字符', 'characters')}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={current + 1 === pages}
            onClick={() => setPage(current + 1)}
          >
            {tx(language, '下一页', 'Next')}
          </Button>
        </div>
      )}
      {!text && <p className="text-sm text-gray-500">{tx(language, '暂无正文', 'No text')}</p>}
      {chunks.slice(current * pageChunks, (current + 1) * pageChunks).map((chunk, index) => (
        <p
          key={`${current}-${index}`}
          className="whitespace-pre-wrap break-words leading-8 font-serif"
        >
          {chunk}
        </p>
      ))}
    </div>
  );
}

export function WritingReviewModal({
  candidate,
  language,
  onClose,
  onAdopt,
  onReject,
  onRevise,
  completedDecision,
  onRetryResult,
}: {
  candidate: ReviewUiCandidate;
  language: UiLanguage;
  onClose: () => void;
  onAdopt: (text: string) => Promise<void>;
  onReject: () => Promise<void>;
  onRevise: (instruction: string) => Promise<void>;
  completedDecision?: 'accepted' | 'rejected';
  onRetryResult?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<'candidate' | 'diff' | 'findings'>(
    candidate.baselineText ? 'diff' : 'candidate'
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [instruction, setInstruction] = useState(''),
    [showInstruction, setShowInstruction] = useState(false);
  const blocks = useMemo(
    () => diffParagraphs(candidate.baselineText, candidate.body),
    [candidate.baselineText, candidate.body]
  );
  const changes = useMemo(() => blocks.filter(block => block.changed), [blocks]);
  const allChangedIds = useMemo(() => new Set(changes.map(block => block.id)), [changes]);
  const [selection, setSelection] = useState(() => ({ blocks, ids: allChangedIds }));
  // A newly revised candidate must never reuse selections from a previous diff, even for one render.
  const selected = selection.blocks === blocks ? selection.ids : allChangedIds;
  const setSelected = (update: Set<number> | ((current: Set<number>) => Set<number>)) =>
    setSelection(current => ({
      blocks,
      ids:
        typeof update === 'function'
          ? update(current.blocks === blocks ? current.ids : allChangedIds)
          : update,
    }));
  const [diffPage, setDiffPage] = useState(0);
  useEffect(() => {
    setDiffPage(0);
  }, [changes]);
  const assembled = useMemo(() => assembledReviewText(blocks, selected), [blocks, selected]);
  const canAdopt = !!assembled.trim() && assembled !== candidate.baselineText;
  const action = async (operation: () => Promise<void>, close = true) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
      if (close) onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const diffPages = Math.max(1, Math.ceil(changes.length / 8));
  return (
    <WorkspaceModal
      title={tx(
        language,
        `审稿与修订 · ${candidate.title}`,
        `Review and revise · ${candidate.title}`
      )}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-3">
          {error && (
            <p role="alert" className="text-sm text-red-600 whitespace-pre-wrap">
              {error}
            </p>
          )}
          {completedDecision ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <p className="text-sm text-gray-500">
                {completedDecision === 'accepted'
                  ? tx(
                      language,
                      '正文已采用；确认后智能体才能继续。',
                      'Prose adopted; confirmation lets the agent continue.'
                    )
                  : tx(
                      language,
                      '候选已拒绝；确认后智能体才能继续。',
                      'Candidate rejected; confirmation lets the agent continue.'
                    )}
              </p>
              <Button
                loading={busy}
                disabled={busy || !onRetryResult}
                onClick={() => {
                  if (onRetryResult) void action(onRetryResult);
                }}
              >
                {tx(language, '重试确认审核结果', 'Retry review confirmation')}
              </Button>
            </div>
          ) : (
            <>
              {showInstruction ? (
                <div className="space-y-2">
                  <TextArea
                    value={instruction}
                    onChange={event => setInstruction(event.target.value)}
                    rows={3}
                    maxLength={4000}
                    disabled={busy}
                    label={tx(language, '修改意见', 'Revision instructions')}
                    placeholder={tx(
                      language,
                      '例如：保留开场，重写结尾；主角此时还不知道真相。',
                      'Preserve the opening, revise the ending; the protagonist does not know the truth yet.'
                    )}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setShowInstruction(false)}
                    >
                      {tx(language, '收起', 'Collapse')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !instruction.trim()}
                      onClick={() => void action(() => onRevise(instruction.trim()), false)}
                    >
                      {tx(language, '按意见修订', 'Request revision')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setShowInstruction(true)}
                >
                  {tx(language, '提出修改意见', 'Add revision instructions')}
                </Button>
              )}
              <div className="flex justify-end gap-3 flex-wrap">
                <Button variant="outline" disabled={busy} onClick={() => void action(onReject)}>
                  {tx(language, '拒绝候选稿', 'Reject candidate')}
                </Button>
                <Button
                  loading={busy}
                  disabled={!canAdopt || busy}
                  onClick={() => void action(() => onAdopt(assembled))}
                >
                  {selected.size === changes.length
                    ? tx(language, '通过并采用', 'Approve and adopt')
                    : tx(language, '采用所选修改', 'Adopt selected changes')}
                </Button>
              </div>
            </>
          )}
        </div>
      }
    >
      <div className="flex gap-2 mb-5 flex-wrap">
        {(['candidate', 'diff', 'findings'] as const).map(key => (
          <Button
            key={key}
            size="sm"
            variant={tab === key ? 'primary' : 'outline'}
            onClick={() => setTab(key)}
          >
            {key === 'candidate'
              ? tx(language, '候选正文', 'Candidate')
              : key === 'diff'
                ? tx(language, '修改对比', 'Changes')
                : tx(language, '审稿意见', 'Findings')}
          </Button>
        ))}
      </div>
      {tab === 'candidate' && <PagedTextPreview text={candidate.body} language={language} />}
      {tab === 'findings' && (
        <div className="space-y-4">
          {candidate.findings.length ? (
            candidate.findings.map(finding => (
              <div key={finding.id} className="p-4 rounded border dark:border-gray-700">
                <h3 className={finding.blocking ? 'font-medium text-red-600' : 'font-medium'}>
                  {finding.title}
                </h3>
                <p className="text-sm whitespace-pre-wrap mt-2">{finding.detail}</p>
                {finding.quote && (
                  <p className="text-sm text-gray-500 whitespace-pre-wrap mt-2">
                    “{finding.quote}”
                  </p>
                )}
              </div>
            ))
          ) : (
            <p className="text-gray-500">
              {tx(
                language,
                '暂无审稿意见，可直接提出修改要求。',
                'No findings. You can provide revision instructions.'
              )}
            </p>
          )}
        </div>
      )}
      {tab === 'diff' && (
        <div className="space-y-5">
          <p className="text-xs text-gray-500">
            {tx(
              language,
              '按唯一段落锚点对比；重复或移动段落合并显示。两版正文完整保留。',
              'Uses unique paragraph anchors; repeated or moved paragraphs are grouped. Both versions are preserved in full.'
            )}
          </p>
          <div className="flex gap-3 items-center flex-wrap">
            <span className="text-sm">
              {selected.size}/{changes.length} {tx(language, '处修改已选', 'changes selected')}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                setSelected(
                  selected.size === changes.length
                    ? new Set()
                    : new Set(changes.map(block => block.id))
                )
              }
            >
              {selected.size === changes.length
                ? tx(language, '全部保留原文', 'Keep all original')
                : tx(language, '全部采用', 'Select all')}
            </Button>
            {diffPages > 1 && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={diffPage === 0}
                  onClick={() => setDiffPage(diffPage - 1)}
                >
                  {tx(language, '上一组', 'Previous group')}
                </Button>
                <span>
                  {diffPage + 1}/{diffPages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={diffPage + 1 === diffPages}
                  onClick={() => setDiffPage(diffPage + 1)}
                >
                  {tx(language, '下一组', 'Next group')}
                </Button>
              </>
            )}
          </div>
          {!changes.length && (
            <p className="text-gray-500">
              {tx(language, '候选稿与原文相同。', 'Candidate matches the original.')}
            </p>
          )}
          {changes.slice(diffPage * 8, (diffPage + 1) * 8).map((block, index) => (
            <section key={block.id} className="space-y-3 border-t dark:border-gray-700 pt-4">
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.has(block.id)}
                  onChange={event =>
                    setSelected(current => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(block.id);
                      else next.delete(block.id);
                      return next;
                    })
                  }
                />
                {tx(
                  language,
                  `采用修改 ${diffPage * 8 + index + 1}`,
                  `Adopt change ${diffPage * 8 + index + 1}`
                )}
              </label>
              <div className="grid lg:grid-cols-2 gap-4">
                <div className="bg-red-50 dark:bg-red-950/20 rounded p-3">
                  <p className="text-xs text-red-600 mb-2">{tx(language, '原文', 'Original')}</p>
                  <PagedTextPreview text={block.before} language={language} pageChunks={2} />
                </div>
                <div className="bg-green-50 dark:bg-green-950/20 rounded p-3">
                  <p className="text-xs text-green-700 mb-2">{tx(language, '候选', 'Candidate')}</p>
                  <PagedTextPreview text={block.after} language={language} pageChunks={2} />
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
    </WorkspaceModal>
  );
}

export function SavedDraftModal({
  title,
  body,
  baselineText,
  language,
  onClose,
}: {
  title: string;
  body: string;
  baselineText: string;
  language: UiLanguage;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'draft' | 'baseline'>('draft');
  return (
    <WorkspaceModal
      title={tx(language, `未采用的场景草稿 · ${title}`, `Unadopted scene draft · ${title}`)}
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          {tx(language, '关闭', 'Close')}
        </Button>
      }
    >
      <p className="text-sm text-amber-700 dark:text-amber-400 mb-4">
        {tx(
          language,
          '来源可能已过期。这里只读展示已保存场景，不会写入正式正文。',
          'The source may be stale. Saved scenes are read-only and will not modify the chapter.'
        )}
      </p>
      <div className="flex gap-2 mb-4">
        <Button
          size="sm"
          variant={tab === 'draft' ? 'primary' : 'outline'}
          onClick={() => setTab('draft')}
        >
          {tx(language, '已保存草稿', 'Saved draft')}
        </Button>
        <Button
          size="sm"
          variant={tab === 'baseline' ? 'primary' : 'outline'}
          onClick={() => setTab('baseline')}
        >
          {tx(language, '生成起点正文', 'Original baseline')}
        </Button>
      </div>
      <PagedTextPreview text={tab === 'draft' ? body : baselineText} language={language} />
    </WorkspaceModal>
  );
}
