/** Wire values and UTF-16 offsets match Android 1.6.0 writing archives. */
export type WritingMode = 'FAST' | 'SCENES' | 'POLISHED';
export type WritingStatus = 'PLANNED' | 'RUNNING' | 'INTERRUPTED' | 'FAILED' | 'COMPLETED';
export interface SceneSpec {
  id: string; title: string; pov: string; time: string; location: string;
  goal: string; conflict: string; turn: string; entryState: string; exitState: string;
  requiredEvents: string[]; forbiddenEvents: string[]; targetWords: number;
}
export interface ChapterScenePlan {
  projectId: string; chapterId: string; sourceFingerprint: string; scenes: SceneSpec[]; updatedAt: number;
}
/** exitState is a design constraint, never a claim about what the generated prose actually did. */
export interface CompletedScene { sceneId: string; body: string; exitState: string; completedAt: number }
export type ReviewCategory = 'FACT_CONFLICT' | 'KNOWLEDGE_LEAK' | 'MISSING_EVENT' | 'STYLE' | 'PACING' | 'OTHER';
export type ReviewSeverity = 'BLOCKING' | 'WARNING' | 'SUGGESTION';
export interface ReviewFinding {
  sceneId: string; category: ReviewCategory; severity: ReviewSeverity; quote: string;
  startOffset: number; endOffset: number; constraint: string; explanation: string; suggestion: string;
}
export interface WritingCheckpoint {
  runId: string; revision: number; sourceFingerprint: string; plan: ChapterScenePlan;
  completedScenes: CompletedScene[]; status: WritingStatus; error: string | null;
  mode: WritingMode; requestCount: number; reviewFindings: ReviewFinding[];
  reviewCompleted: boolean; updatedAt: number; chapterTask: string; language: string; baselineText: string;
}
export interface WritingArchive { version: 1; plans: ChapterScenePlan[]; checkpoints: WritingCheckpoint[] }
export type StoryNoteKind = 'canon' | 'plan' | 'fact' | 'belief' | 'foreshadowing';
export interface StoryNote {
  id: string; kind: StoryNoteKind; subject: string; text: string; sourceChapterId: string | null;
  sourceBodyHash: string | null; knownByCharacterIds: string[]; payoffChapterId: string | null;
  resolved: boolean; importance: number;
}
export interface WritingWorkspace {
  version: 1; mode: 'quick' | 'scene' | 'polish'; style: string; perspective: string;
  forbiddenExpressions: string; sampleProse: string; maxRequestsPerRun: number;
  planningProfileId: string | null; writingProfileId: string | null;
  reviewProfileId: string | null; extractionProfileId: string | null; notes: StoryNote[];
}
export function defaultWritingWorkspace(): WritingWorkspace {
  return { version: 1, mode: 'scene', style: '', perspective: '', forbiddenExpressions: '', sampleProse: '',
    maxRequestsPerRun: 16, planningProfileId: null, writingProfileId: null, reviewProfileId: null,
    extractionProfileId: null, notes: [] };
}
export interface WritingUsageEntry {
  runId: string; model: string; completedAt: string; requestCount: number;
  promptTokens: number | null; completionTokens: number | null; cacheHitTokens: number | null;
  failedRequests: number; chapterId: string | null; parentRunId: string | null;
}
export type WritingRole = 'planning' | 'writing' | 'review';
export type WritingPurpose = 'scene_plan' | 'scene_review' | 'scene_draft' | 'scene_continue' | 'quick_draft';
export interface WritingResponse {
  text: string; finishReason?: 'stop' | 'length';
  usage?: { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number; model?: string };
}
export type WritingRequestCallback = (system: string, user: string, role: WritingRole,
  signal: AbortSignal, purpose?: WritingPurpose, format?: 'json' | 'text') => Promise<string | WritingResponse>;
/** The host must implement compareAndSet atomically; a plain asynchronous get/set is not sufficient. */
export interface WritingPersistence {
  load(projectId: string, chapterId: string): Promise<WritingCheckpoint | null>;
  loadPlan?(projectId: string, chapterId: string): Promise<ChapterScenePlan | null>;
  savePlan(plan: ChapterScenePlan): Promise<boolean | void>;
  compareAndSet(expected: WritingCheckpoint | null, next: WritingCheckpoint): Promise<boolean>;
}
export interface WritingRequest {
  projectId: string; chapterId: string; sourceFingerprint: string; chapterTask: string; stableContext: string;
  mode?: WritingMode; plan?: ChapterScenePlan | null; resumeRunId?: string | null; optionalReview?: boolean;
  targetWords?: number; language?: string; maxRequests?: number; maxRetries?: number;
  maxContinuationsPerScene?: number; baselineText?: string; maxInputCharacters?: number;
  currentSourceFingerprint?: () => string | Promise<string>;
}
export interface WritingProgress {
  stage: 'planning' | 'writing' | 'scene_completed' | 'reviewing' | 'completed';
  checkpoint: WritingCheckpoint | null; sceneId?: string; preview?: string;
}
export interface WritingResult {
  body: string; fullBody: string; findings: ReviewFinding[]; checkpoint: WritingCheckpoint;
}
export class WritingError extends Error {
  constructor(message: string, readonly code: 'protocol' | 'source_changed' | 'stale_run' | 'quota' | 'budget' | 'output_limit') {
    super(message); this.name = 'WritingError';
  }
}
