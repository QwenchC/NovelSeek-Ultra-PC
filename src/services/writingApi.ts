import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import type { TextModelConfig } from '@typings/index';

export interface WritingTokenUsage { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number }
export interface WritingAIResult { text: string; finishReason: 'stop' | 'length'; usage?: WritingTokenUsage }
export interface WritingAIRequest {
  system: string; user: string; textConfig: TextModelConfig; maxTokens?: number;
  reasoningLevel?: 'low' | 'medium' | 'high'; signal?: AbortSignal; onDelta?: (delta: string) => void;
  responseFormat?: 'json' | 'text';
}
export function adoptChapterCandidate(input: { projectId: string; chapterId: string; expectedDraft: string; expectedFinal: string; body: string }) {
  return invoke<void>('adopt_chapter_candidate', { input });
}
export async function requestWriting(request: WritingAIRequest): Promise<WritingAIResult> {
  const { signal, onDelta, ...fields } = request;
  if (signal?.aborted) throw new DOMException('已中断', 'AbortError');
  const requestId = crypto.randomUUID();
  const cancel = () => { void invoke('cancel_scoped_ai', { requestId }).catch(() => undefined); };
  const unlisten = onDelta ? await listen<{ requestId: string; delta: string }>('writing-stream', ({ payload }) => {
    if (payload.requestId === requestId && !signal?.aborted) onDelta(payload.delta);
  }) : () => {};
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new DOMException('已中断', 'AbortError');
    const result = await invoke<WritingAIResult>('request_scoped_ai', { input: { requestId, ...fields } });
    if (signal?.aborted) throw new DOMException('已中断', 'AbortError');
    return result;
  } finally { signal?.removeEventListener('abort', cancel); unlisten(); }
}
