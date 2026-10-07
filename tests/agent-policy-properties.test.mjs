import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/agent/agentPolicy.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const policy = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=agent-policy-properties-bundle.mjs').toString('base64'));

test('property: full plan completion is a monotone prefix with exactly one next active step', () => {
  for (let size = 1; size <= 16; size++) {
    const raw = { summary: '任务', steps: Array.from({ length: size }, (_, i) => ({ id: `s${i}`, goal: `目标${i}`, suggestedTools: ['inspect'], status: 'completed' })) };
    let plan = policy.parsePlan(JSON.stringify(raw), new Set(['inspect']), 'command', 'owned-plan');
    const original = structuredClone(plan);
    for (let index = 0; index < size; index++) {
      const previous = plan, before = structuredClone(plan); plan = policy.completePlanStep(plan, `s${index}`, true);
      assert.deepEqual(previous, before); // API leaves its previous version reviewable.
      assert.deepEqual(plan.steps.map(s => s.status), Array.from({ length: size }, (_, i) => i <= index ? 'completed' : i === index + 1 ? 'in_progress' : 'pending'));
      assert.equal(plan.steps.filter(s => s.status === 'in_progress').length, index + 1 === size ? 0 : 1);
      assert.equal(plan.planId, 'owned-plan'); assert.equal(plan.sourceCommandId, 'command');
    }
    assert.deepEqual(original.steps.map(s => s.status), Array.from({ length: size }, (_, i) => i ? 'pending' : 'in_progress'));
  }
});

test('property: rejected model plan cannot smuggle a tool outside its host catalog', () => {
  for (let size = 1; size <= 16; size++) {
    const steps = Array.from({ length: size }, (_, i) => ({ id: `s${i}`, goal: '检查', suggestedTools: ['inspect'] }));
    for (let index = 0; index < size; index++) {
      const poisoned = structuredClone(steps); poisoned[index].suggestedTools.push('unapproved_external_write');
      assert.throws(() => policy.parsePlan(JSON.stringify({ summary: '检查', steps: poisoned }), new Set(['inspect']), 'command', 'owned'));
    }
  }
});

test('property: cache ratio derives only from complete measured request pairs, unknowns cannot dilute it', () => {
  let metrics; let prompt = 0, hit = 0, known = 0, unknown = 0;
  for (let i = 0; i < 80; i++) {
    const previous = metrics, before = metrics && structuredClone(metrics);
    const usage = i % 4 === 0 ? { promptTokens: 100 + i, cacheHitTokens: i } : i % 4 === 1 ? { promptTokens: 100 + i } : i % 4 === 2 ? { promptTokens: 100 + i, cacheHitTokens: 101 + i } : undefined;
    if (i % 4 === 0) { prompt += usage.promptTokens; hit += usage.cacheHitTokens; known++; } else unknown++;
    metrics = policy.recordMetrics(metrics, usage, 32_000);
    assert.equal(metrics.promptTokens, prompt); assert.equal(metrics.cacheHitTokens, hit); assert.equal(metrics.measuredRequests, known); assert.equal(metrics.unknownRequests, unknown);
    if (before) { assert.equal(before.measuredRequests + before.unknownRequests, i); assert.deepEqual(previous, before); assert.notEqual(metrics, previous); }
    assert.ok(metrics.cacheHitTokens <= metrics.promptTokens);
  }
});

test('property: summary digest is stable for the same prefix but invalidates any evidence change', async () => {
  const steps = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, role: i % 2 ? 'result' : 'user', content: `证据${i}`, tool: i % 2 ? 'inspect' : undefined }));
  const original = await policy.prefixDigest(steps);
  assert.equal(original, await policy.prefixDigest(structuredClone(steps)));
  for (const index of [0, 1, 19, 39]) { const changed = structuredClone(steps); changed[index].content += ' altered'; assert.notEqual(original, await policy.prefixDigest(changed)); }
  assert.notEqual(original, await policy.prefixDigest(steps.slice(0, -1)));
});

test('property: every planned mutation needs its own success; unrelated reads never substitute', () => {
  const mutations = ['generate_chapter', 'update_character', 'set_outline', 'create_volume', 'delete_arc'];
  for (let size = 1; size <= mutations.length; size++) {
    const writes = mutations.slice(0, size);
    const step = { id: 's', goal: '完成已列出的修改', suggestedTools: ['list_projects', ...writes], status: 'in_progress' };
    assert.equal(policy.stepHasEvidence(step, new Set(['list_projects', 'get_overview'])), false);
    assert.equal(policy.stepHasEvidence(step, new Set(writes)), true);
    for (const missing of writes) assert.equal(policy.stepHasEvidence(step, new Set(['list_projects', ...writes.filter(w => w !== missing)])), false);
  }
});
