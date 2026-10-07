export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export interface PlanStep { id: string; goal: string; successCriteria?: string; suggestedTools: string[]; status: PlanStatus }
export interface AgentPlan { summary: string; steps: PlanStep[]; createdAt: number; sourceCommandId: string; planId: string }
export const isWritingMutation = (name: string) => /^(create|set|update|delete|import|generate|revise|replace|edit|plan|assign|add|append|move|reorder|renumber|restore|extract)_/.test(name);
export function stepHasEvidence(step: PlanStep, successfulTools: ReadonlySet<string>): boolean {
  const writes = step.suggestedTools.filter(isWritingMutation);
  return writes.length ? writes.every(tool => successfulTools.has(tool)) : step.suggestedTools.some(tool => successfulTools.has(tool));
}
export interface SessionMetrics {
  promptTokens: number; completionTokens: number; cacheHitTokens: number; measuredRequests: number;
  unknownRequests: number; contextTokens: number; contextBudget: number; compressedAt?: string;
  summary?: string; coveredStepId?: string; coveredDigest?: string;
}
export function strictAction(raw: string): { thought?: string; action: string; args: Record<string, unknown> } | null {
  try {
    const value = JSON.parse(raw.trim());
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string' || !value.action.trim()) return null;
    if (value.thought !== undefined && typeof value.thought !== 'string') return null;
    if (value.args !== undefined && (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))) return null;
    return { thought: value.thought, action: value.action, args: value.args || {} };
  } catch { return null; }
}
export function parsePlan(raw: string, tools: ReadonlySet<string>, sourceCommandId: string, id: string): AgentPlan {
  const value = JSON.parse(raw.trim());
  if (!value || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 2000 || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 16) throw new Error('规划JSON格式无效');
  const ids = new Set<string>();
  const steps: PlanStep[] = value.steps.map((step: Record<string, unknown>, index: number) => {
    if (!step || typeof step.id !== 'string' || !step.id.trim() || step.id.length > 80 || ids.has(step.id) || typeof step.goal !== 'string' || !step.goal.trim() || step.goal.length > 3000) throw new Error('规划步骤无效');
    ids.add(step.id);
    if (step.successCriteria !== undefined && (typeof step.successCriteria !== 'string' || step.successCriteria.length > 2000)) throw new Error('完成标准无效');
    const names = step.suggestedTools === undefined ? [] : step.suggestedTools;
    if (!Array.isArray(names) || names.length > 12 || names.some(name => typeof name !== 'string' || !tools.has(name))) throw new Error('规划包含未知工具');
    return { id: step.id, goal: step.goal, successCriteria: step.successCriteria as string | undefined, suggestedTools: names, status: index === 0 ? 'in_progress' : 'pending' };
  });
  return { summary: value.summary, steps, createdAt: Date.now(), sourceCommandId, planId: id };
}
export function completePlanStep(plan: AgentPlan, expectedId: string, hasCommittedEvidence: boolean): AgentPlan {
  const current = plan.steps.find(step => step.status === 'in_progress');
  if (!current || current.id !== expectedId || !hasCommittedEvidence) throw new Error('只能在实际执行成功或用户通过审核后完成当前步骤');
  let started = false;
  const steps = plan.steps.map(step => {
    if (step.id === expectedId) return { ...step, status: 'completed' as const };
    if (!started && step.status === 'pending') { started = true; return { ...step, status: 'in_progress' as const }; }
    return step;
  });
  return { ...plan, steps };
}
/** Conservative display estimate, not a provider-measured tokenizer count. */
export const estimateTokens = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 2);
export function recordMetrics(previous: SessionMetrics | undefined, usage: {promptTokens?: number; completionTokens?: number; cacheHitTokens?: number} | undefined, budget: number): SessionMetrics {
  const next = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, measuredRequests: 0, unknownRequests: 0, contextTokens: 0, contextBudget: budget, ...previous };
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (valid(usage?.promptTokens) && valid(usage?.cacheHitTokens) && usage!.cacheHitTokens! <= usage!.promptTokens!) {
    next.promptTokens += usage!.promptTokens!; next.cacheHitTokens += usage!.cacheHitTokens!;
    next.completionTokens += valid(usage?.completionTokens) ? usage!.completionTokens! : 0; next.measuredRequests++;
  } else next.unknownRequests++;
  return next;
}
export async function prefixDigest(steps: unknown[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(steps)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
