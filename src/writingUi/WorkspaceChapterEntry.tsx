import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@store/index';
import { Button } from '@components/Button';
import { tx } from '@utils/i18n';
import { WorkspaceCandidateReview } from './WorkspaceCandidateReview';
import { getWorkspaceCandidates } from './workspaceRuntime';

export function WorkspaceChapterEntry({
  projectId,
  chapterId,
  canReview = true,
  onReviewed,
}: {
  projectId: string;
  chapterId?: string;
  canReview?: boolean;
  onReviewed?: (accepted: boolean) => void;
}) {
  const navigate = useNavigate(),
    language = useAppStore(s => s.uiLanguage);
  useAppStore(s => s.backupExtensions);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const pending = getWorkspaceCandidates(projectId)
    .filter(c => c.chapterId === chapterId && c.status === 'pending')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!canReview}
        title={
          !canReview
            ? tx(
                language,
                '请先保存正文并停止编辑器生成任务',
                'Save prose and stop editor generation first'
              )
            : undefined
        }
        onClick={() =>
          navigate(
            `/workbench/${projectId}${chapterId ? `?chapter=${encodeURIComponent(chapterId)}` : ''}`
          )
        }
      >
        {tx(language, '创作工作台', 'Writing workbench')}
      </Button>
      {pending && (
        <Button size="sm" disabled={!canReview} onClick={() => setReviewId(pending.id)}>
          {tx(language, '审核正文候选', 'Review candidate')}
        </Button>
      )}
      {reviewId && (
        <WorkspaceCandidateReview
          projectId={projectId}
          candidateId={reviewId}
          onClose={() => setReviewId(null)}
          onReviewed={accepted => {
            onReviewed?.(accepted);
            setReviewId(null);
          }}
        />
      )}
    </>
  );
}
