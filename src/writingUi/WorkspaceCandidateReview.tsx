import { useRef } from 'react';
import { useAppStore } from '@store/index';
import { flushWritingPersistence } from '@store/index';
import { SavedDraftModal, WritingReviewModal } from './WritingReviewModal';
import {
  getWorkspaceCandidates,
  reviewWorkspaceCandidate,
  reviseWorkspaceCandidate,
} from './workspaceRuntime';

/** Shared by workbench, either editor, and the agent conversation. */
export function WorkspaceCandidateReview({
  projectId,
  candidateId,
  onClose,
  onReviewed,
}: {
  projectId: string;
  candidateId: string;
  onClose: () => void;
  onReviewed?: (accepted: boolean) => Promise<void> | void;
}) {
  const language = useAppStore(s => s.uiLanguage);
  useAppStore(s => s.backupExtensions);
  const current = getWorkspaceCandidates(projectId).find(c => c.id === candidateId);
  const lastPending = useRef(current);
  if (current?.status === 'pending') lastPending.current = current;
  const candidate = current?.status === 'pending' ? current : lastPending.current;
  // Keep the dialog mounted until durable save and parent completion succeed, so errors remain visible.
  if (!candidate) return null;
  if (candidate.importedReadOnly)
    return (
      <SavedDraftModal
        title={candidate.title}
        body={candidate.body}
        baselineText={candidate.baselineText}
        language={language}
        onClose={onClose}
      />
    );
  const confirmResult = async (accepted: boolean) => {
    await flushWritingPersistence();
    if (candidate.sessionId) {
      const { agentRunner } = await import('../agent/agentRunner');
      await agentRunner.reviewCompleted(candidate.sessionId, accepted, candidate.id);
    }
    await onReviewed?.(accepted);
  };
  return (
    <WritingReviewModal
      language={language}
      candidate={{
        ...candidate,
        findings: candidate.findings.map((finding, index) => ({
          id: String(index),
          title: `${finding.severity} · ${finding.category}`,
          detail: `${finding.explanation}\n${finding.suggestion}`,
          quote: finding.quote,
          blocking: finding.severity === 'BLOCKING',
        })),
      }}
      onClose={onClose}
      completedDecision={
        current?.status === 'accepted' || current?.status === 'rejected'
          ? current.status
          : undefined
      }
      onRetryResult={() => confirmResult(current?.status === 'accepted')}
      onAdopt={async text => {
        const result = await reviewWorkspaceCandidate(projectId, candidateId, 'accept', text);
        await confirmResult(result.accepted);
      }}
      onReject={async () => {
        await reviewWorkspaceCandidate(projectId, candidateId, 'reject');
        await confirmResult(false);
      }}
      onRevise={instruction => reviseWorkspaceCandidate(projectId, candidateId, instruction)}
    />
  );
}
