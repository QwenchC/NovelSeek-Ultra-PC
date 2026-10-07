import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/agent/agentPolicy.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const policy = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
test('actions reject prose, fences and extra objects', () => {
  assert.equal(policy.strictAction('说明 {"action":"final"}'), null);
  assert.equal(policy.strictAction('```json\n{"action":"final"}\n```'), null);
  assert.equal(policy.strictAction('{"action":"final","args":[]}'), null);
  assert.equal(policy.strictAction('{"action":"final"}').action, 'final');
});
test('plan runtime owns identity/status and requires evidence', () => {
  const raw = JSON.stringify({summary:'写作',steps:[{id:'p1',goal:'生成',suggestedTools:['generate_chapter']},{id:'p2',goal:'审核'}]});
  const plan = policy.parsePlan(raw, new Set(['generate_chapter']), 'command', 'runtime-id');
  assert.equal(plan.planId, 'runtime-id');
  assert.throws(() => policy.completePlanStep(plan, 'p1', false));
  const next = policy.completePlanStep(plan, 'p1', true);
  assert.equal(next.steps[1].status, 'in_progress');
  assert.equal(plan.steps[0].status, 'in_progress');
});
test('missing provider cache usage remains unknown', () => {
  const next = policy.recordMetrics(undefined, {promptTokens:100}, 32000);
  assert.equal(next.measuredRequests, 0); assert.equal(next.unknownRequests, 1);
  const known = policy.recordMetrics(next, {promptTokens:100,cacheHitTokens:25}, 32000);
  assert.equal(known.cacheHitTokens / known.promptTokens, 0.25);
});
