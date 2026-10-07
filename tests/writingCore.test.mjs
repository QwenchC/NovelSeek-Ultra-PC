import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/writing/index.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false });
const core = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text + '\n//# sourceURL=writing-core-test-bundle.mjs').toString('base64'));
const source = core.makeSourceFingerprint({ chapter: '正文', notes: [] });
const scene = (id = 's1', extra = {}) => ({ id, title: '雨夜', pov: '甲', time: '夜', location: '城门', goal: '找到线索', conflict: '被守卫拦住', turn: '发现钥匙', entryState: '甲不知道凶手', exitState: '拿到钥匙', requiredEvents: ['拿到钥匙'], forbiddenEvents: ['知道凶手'], targetWords: 1_000, ...extra });
const plan = (scenes = [scene()]) => ({ projectId: 'p', chapterId: 'c', sourceFingerprint: source, scenes, updatedAt: 1 });
const checkpoint = (extra = {}) => ({ runId: 'r1', revision: 0, sourceFingerprint: source, plan: plan(), completedScenes: [], status: 'RUNNING', error: null, mode: 'SCENES', requestCount: 0, reviewFindings: [], reviewCompleted: false, updatedAt: 1, chapterTask: '查案', language: 'zh', baselineText: '', ...extra });
const note = (id = 'n1', extra = {}) => ({ id, kind: 'canon', subject: '角色', text: '甲不会读心', sourceChapterId: null, sourceBodyHash: null, knownByCharacterIds: [], payoffChapterId: null, resolved: false, importance: 1, ...extra });
const review = (extra = {}) => ({ sceneId: 's1', category: 'FACT_CONFLICT', severity: 'BLOCKING', quote: '知道凶手', startOffset: 1, endOffset: 5, constraint: '知道凶手', explanation: '违反知情范围', suggestion: '改为不知道', ...extra });
const request = (extra = {}) => ({ projectId: 'p', chapterId: 'c', sourceFingerprint: source, chapterTask: '查案', stableContext: '作者设定', plan: plan(), maxRequests: 12, ...extra });
function persistence(initial = null) {
  let value = initial && structuredClone(initial), savedPlan = initial?.plan ?? null;
  return { load: async () => structuredClone(value), loadPlan: async () => structuredClone(savedPlan),
    savePlan: async p => { if (value?.status === 'RUNNING') return false; savedPlan = structuredClone(p); value = null; return true; },
    compareAndSet: async (expected, next) => { if (core.canonicalJson(value) !== core.canonicalJson(expected) || !core.isValidCheckpointTransition(expected, next)) return false; value = structuredClone(next); savedPlan = structuredClone(next.plan); return true; },
    value: () => structuredClone(value), replace: next => { value = structuredClone(next); } };
}
function pipeline(store, call, extra = {}) { let id = 0; return core.createWritingPipeline({ persistence: store, request: call, now: () => 10, newRunId: () => `run-${++id}`, ...extra }); }

test('SHA-256 UTF-8 matches Node including supplementary and malformed Unicode', () => {
  for (const text of ['', 'abc', '中文🌙', 'x'.repeat(100_000), '\ud800']) assert.equal(core.hashText(text), createHash('sha256').update(text).digest('hex'));
});
test('canonical source namespaces keys and excludes operational workspace settings', () => {
  const a = core.defaultWritingWorkspace(); const b = { ...a, mode: 'polish', maxRequestsPerRun: 64, planningProfileId: 'different', writingProfileId: 'other' };
  assert.equal(core.makeSourceFingerprint(core.workspaceFingerprintMaterial(a)), core.makeSourceFingerprint(core.workspaceFingerprintMaterial(b)));
  assert.equal(core.makeSourceFingerprint({ a: 1, b: 2 }), core.makeSourceFingerprint({ b: 2, a: 1 }));
  assert.notEqual(core.makeSourceFingerprint({ baselineText: '旧' }), core.makeSourceFingerprint({ baselineText: '新' }));
  assert.equal(core.isPcSourceFingerprint('a'.repeat(64)), false);
});
test('strict scene JSON rejects explanation, code fences, unknown/missing root and duplicate keys', () => {
  const raw = JSON.stringify({ scenes: [scene()] });
  assert.equal(core.parseScenePlan(raw, 'p', 'c', source, 1).scenes[0].id, 's1');
  for (const bad of ['解释' + raw, '```json\n' + raw + '\n```', raw + '尾注', JSON.stringify({ scenes: [scene()], info: '' }), '{"scenes":[],"scenes":[' + JSON.stringify(scene()) + ']}']) assert.throws(() => core.parseScenePlan(bad, 'p', 'c', source));
});
test('strict scene JSON rejects quoted budget, empty scenes, extra scene fields and duplicate ids', () => {
  for (const scenes of [[], [scene(), scene()], [scene('s1', { targetWords: '1500' })], [scene('s1', { explanation: '额外说明' })], Array.from({ length: 9 }, (_, i) => scene(String(i)))]) assert.throws(() => core.parseScenePlan(JSON.stringify({ scenes }), 'p', 'c', source));
});
test('scene validation rejects contradictory and oversized constraints', () => {
  for (const s of [scene('s1', { forbiddenEvents: ['拿到钥匙'] }), scene('s1', { targetWords: 99 }), scene('s1', { targetWords: 8_001 }), scene('s1', { goal: '' }), scene('s1', { requiredEvents: ['', ''] })]) assert.throws(() => core.validateScenePlan(plan([s])));
  assert.throws(() => core.validateScenePlan(plan(Array.from({ length: 4 }, (_, i) => scene(String(i), { targetWords: 8_000 })))));
});
test('review is evidence located; literary taste cannot block or warn', () => {
  const completed = [{ sceneId: 's1', body: '甲知道凶手。', exitState: '拿到钥匙', completedAt: 1 }];
  assert.equal(core.parseReview(JSON.stringify({ findings: [review()] }), plan(), completed).length, 1);
  for (const f of [review({ quote: '原文不存在' }), review({ startOffset: '1' }), review({ category: 'STYLE' }), review({ category: 'STYLE', severity: 'WARNING' }), review({ constraint: '模型猜测' }), review({ sceneId: '未来' })]) assert.throws(() => core.parseReview(JSON.stringify({ findings: [f] }), plan(), completed));
  assert.equal(core.parseReview(JSON.stringify({ findings: [review({ category: 'STYLE', severity: 'SUGGESTION', constraint: '' })] }), plan(), completed).length, 1);
});
test('review offsets must not split surrogate pairs', () => {
  const completed = [{ sceneId: 's1', body: '🌙知道凶手', exitState: '拿到钥匙', completedAt: 1 }];
  assert.throws(() => core.parseReview(JSON.stringify({ findings: [review({ quote: '\udf19', startOffset: 1, endOffset: 2 })] }), plan(), completed));
});
test('checkpoint/archive rejects unfinished completed task and non-prefix drafts', () => {
  assert.throws(() => core.validateCheckpoint(checkpoint({ status: 'COMPLETED' })));
  assert.throws(() => core.validateCheckpoint(checkpoint({ completedScenes: [{ sceneId: 'other', body: '正文', exitState: '拿到钥匙', completedAt: 1 }] })));
  assert.throws(() => core.validateWritingArchive({ version: 1, plans: [plan(), plan()], checkpoints: [] }));
  assert.throws(() => core.validateWritingArchive({ version: 1, plans: [], checkpoints: [checkpoint()] }));
});
test('Android source hash is inspectable/importable but not rebound to PC', () => {
  const p = { ...plan(), sourceFingerprint: 'a'.repeat(64) }; const c = checkpoint({ sourceFingerprint: p.sourceFingerprint, plan: p, status: 'INTERRUPTED' });
  assert.equal(core.validateWritingArchive({ version: 1, plans: [p], checkpoints: [c] }).checkpoints[0].sourceFingerprint, p.sourceFingerprint);
});
test('story facts only come from earlier unchanged chapters, beliefs remain beliefs', () => {
  const chapters = [{ id: 'old', title: '旧章', order_index: 0 }, { id: 'now', title: '本章', order_index: 1 }, { id: 'future', title: '后章', order_index: 2 }];
  const workspace = { ...core.defaultWritingWorkspace(), notes: [note('good', { kind: 'fact', sourceChapterId: 'old', sourceBodyHash: core.hashText('old') }), note('stale', { kind: 'fact', sourceChapterId: 'old', sourceBodyHash: core.hashText('stale') }), note('future', { kind: 'fact', sourceChapterId: 'future' }), note('belief', { kind: 'belief', sourceChapterId: 'old', sourceBodyHash: core.hashText('old'), knownByCharacterIds: ['actor'] }), note('gone', { knownByCharacterIds: ['deleted'] })] };
  const selected = core.selectStoryNotes(workspace, chapters[1], chapters, { sourceHashes: { old: core.hashText('old') }, characterNames: { actor: '甲' } });
  assert.deepEqual(new Set(selected.includedIds), new Set(['good', 'belief'])); assert.match(selected.prompt, /误解.*不代表客观事实/); assert.match(selected.prompt, /知情角色：甲/);
  assert.equal(selected.excludedIds.length, 3);
});
test('required story cards reserve budget and never truncate; current payoff mandatory', () => {
  const chapter = { id: 'c', title: '本章', order_index: 2 };
  const workspace = { ...core.defaultWritingWorkspace(), notes: [note('optional', { kind: 'plan', text: 'x'.repeat(80), importance: 3 }), note('required', { text: '设定' })] };
  const mandatoryLength = core.selectStoryNotes({ ...workspace, notes: [workspace.notes[1]] }, chapter, [chapter]).prompt.length;
  assert.deepEqual(core.selectStoryNotes(workspace, chapter, [chapter], { maxChars: mandatoryLength }).includedIds, ['required']);
  assert.throws(() => core.selectStoryNotes(workspace, chapter, [chapter], { maxChars: mandatoryLength - 1 }));
  assert.throws(() => core.selectStoryNotes({ ...workspace, notes: [note('payoff', { kind: 'foreshadowing', payoffChapterId: 'c' })] }, chapter, [chapter], { maxChars: 1 }));
});
test('manuscript handles BOM/mixed newlines/no-space Chinese/Markdown/preface/empty headings', () => {
  const preview = core.previewManuscript('\uFEFF前言\r\n第一章雨夜\r  内容\n# Empty\n## Chapter 2\n  新章\r第三章空\n');
  assert.deepEqual(preview.chapters, [{ title: '序章', body: '前言' }, { title: '第一章雨夜', body: '  内容' }, { title: 'Chapter 2', body: '  新章' }]);
  assert.throws(() => core.previewManuscript('\uFEFF\r\n'));
  assert.throws(() => core.previewManuscript('第一章\n第二章'));
  assert.throws(() => core.previewManuscript('x'.repeat(5_000_001)));
});
test('manuscript chapter count capped and text is never HTML executed', () => {
  assert.throws(() => core.previewManuscript(Array.from({ length: 2_001 }, (_, i) => `# ${i}\n正文`).join('\n')));
  assert.equal(core.previewManuscript('<script>alert(1)</script>').chapters[0].body, '<script>alert(1)</script>');
});
test('UTF-16 ranges advance and previews reconstruct exact original', () => {
  const text = '甲🌙乙\n尾声'; const first = core.readTextRange(text, 1, 1); assert.equal(first.text, '🌙'); assert.equal(first.nextOffset, 3);
  assert.equal(core.readTextRange(text, 2, 2).offset, 1); assert.equal(core.chapterReviewTextChunks(text, 2).join(''), text);
  assert.equal(core.readTextRange(text, text.length).nextOffset, null); assert.throws(() => core.readTextRange(text, -1));
});
test('search is literal, paginated, case-fold offsets stay original', () => {
  const sources = [{ id: 'c', title: '章', kind: 'body', text: '🌙a.b 🌙a.b İa.b' }];
  const page = core.searchText(sources, 'a.b', { offset: 1, limit: 1 }); assert.equal(page.total, 3); assert.equal(page.hits[0].offset, 8); assert.equal(page.nextOffset, 2);
  assert.equal(core.searchText(sources, 'A.B', { ignoreCase: true }).hits[2].offset, 13);
  assert.throws(() => core.searchText(sources, '\ud800'));
});
test('bounded diff preserves both sides exactly for repeated/reordered/long/emoji paragraphs', () => {
  for (const [before, after] of [['A\nB\nA\n', 'A\nC\nA\n'], ['A\nB\nC\n', 'C\nA\nB\n'], ['🌙'.repeat(20_000), '🌙'.repeat(10_000) + '修改'], ['a\n'.repeat(50_000), 'b\n'.repeat(50_000)], ['', '新增'], ['旧', '']]) {
    const blocks = core.chapterReviewDiff(before, after, 50, 10);
    assert.equal(core.applyReviewDiff(blocks, []), before); assert.equal(core.applyReviewDiff(blocks, blocks.map(x => x.id)), after);
    assert.ok(blocks.length <= 101); assert.equal(blocks.map(x => x.baselineText).join(''), before); assert.equal(blocks.map(x => x.candidateText).join(''), after);
  }
});
test('scene run reserves requests and emits only candidate, preserves baseline', async () => {
  const store = persistence(); let calls = 0;
  const result = await pipeline(store, async (_system, _user, role, _signal, purpose, format) => { calls++; assert.equal(store.value().requestCount, calls); assert.equal(role, 'writing'); assert.equal(purpose, 'scene_draft'); assert.equal(format, 'text'); return ' 新正文 '; }).run(request({ baselineText: '原正文' }), new AbortController().signal);
  assert.equal(result.fullBody, '原正文\n\n新正文'); assert.equal(result.checkpoint.status, 'COMPLETED'); assert.equal(result.checkpoint.requestCount, 1);
});
test('cancel retains completed scene prefix and resume skips it with new lease', async () => {
  const store = persistence(), controller = new AbortController(); const p = plan([scene(), scene('s2')]); let calls = 0;
  await assert.rejects(pipeline(store, async () => ++calls === 1 ? '第一场' : '第二场').run(request({ plan: p, baselineText: '原文' }), controller.signal, progress => { if (progress.stage === 'scene_completed') controller.abort(); }), e => e.name === 'AbortError');
  const old = store.value(); assert.equal(old.status, 'INTERRUPTED'); assert.equal(old.completedScenes.length, 1);
  const resumed = await pipeline(store, async (_system, user) => { assert.match(user, /计划结束约束（不是事实核验结论）/); assert.match(user, /第一场/); return '第二场'; }, { newRunId: () => 'resumed-lease' }).run(request({ plan: p, resumeRunId: old.runId, chapterTask: '临时更改', baselineText: '不得替换原文' }), new AbortController().signal);
  assert.equal(resumed.fullBody, '原文\n\n第一场\n\n第二场'); assert.equal(resumed.checkpoint.chapterTask, '查案'); assert.equal(resumed.checkpoint.requestCount, 2); assert.equal(resumed.checkpoint.runId, 'resumed-lease');
});
test('transport failure has no automatic retries and retains completed drafts', async () => {
  const store = persistence(); let calls = 0;
  await assert.rejects(pipeline(store, async () => { if (++calls === 1) return '第一场'; throw new Error('断网'); }).run(request({ plan: plan([scene(), scene('s2')]), maxRetries: 2 }), new AbortController().signal), /断网/);
  assert.equal(calls, 2); assert.equal(store.value().status, 'FAILED'); assert.equal(store.value().completedScenes.length, 1);
});
test('source change after network response rejects write, never rebinds draft', async () => {
  const store = persistence(); let hash = source;
  await assert.rejects(pipeline(store, async () => { hash = core.makeSourceFingerprint('changed'); return '不能采用'; }).run(request({ currentSourceFingerprint: () => hash }), new AbortController().signal), e => e.code === 'source_changed');
  assert.equal(store.value().sourceFingerprint, source); assert.equal(store.value().completedScenes.length, 0); assert.equal(store.value().status, 'FAILED');
});
test('Android or changed source cannot resume and makes no API call', async () => {
  const p = { ...plan(), sourceFingerprint: 'a'.repeat(64) }; const c = checkpoint({ plan: p, sourceFingerprint: p.sourceFingerprint, status: 'INTERRUPTED' }); let calls = 0;
  await assert.rejects(pipeline(persistence(c), async () => { calls++; return '文本'; }).run(request({ plan: null, resumeRunId: c.runId }), new AbortController().signal), e => e.code === 'source_changed');
  assert.equal(calls, 0);
});
test('late writer cannot overwrite reclaimed run, including its failure status', async () => {
  const store = persistence();
  await assert.rejects(pipeline(store, async () => { const c = store.value(); store.replace({ ...c, runId: 'new-lease', revision: c.revision + 1 }); return '过期'; }).run(request(), new AbortController().signal), e => e.code === 'stale_run');
  assert.equal(store.value().runId, 'new-lease'); assert.equal(store.value().status, 'RUNNING'); assert.equal(store.value().completedScenes.length, 0);
});
test('quota counts failed attempt and resume quota is cumulative', async () => {
  const store = persistence(); let calls = 0;
  await assert.rejects(pipeline(store, async () => { calls++; return '完成'; }).run(request({ plan: plan([scene(), scene('s2')]), maxRequests: 1 }), new AbortController().signal), e => e.code === 'quota');
  const c = store.value(); assert.equal(c.completedScenes.length, 1);
  await assert.rejects(pipeline(store, async () => { calls++; return '不应调用'; }, { newRunId: () => 'quota-resume' }).run(request({ plan: c.plan, resumeRunId: c.runId, maxRequests: 1 }), new AbortController().signal), e => e.code === 'quota'); assert.equal(calls, 1);
});
test('strict JSON planning correction is bounded, standalone never touches checkpoint', async () => {
  const existing = checkpoint({ status: 'INTERRUPTED' }); const store = persistence(existing); let calls = 0;
  const p = await pipeline(store, async (_system, _user, role, _signal, purpose, format) => { calls++; assert.equal(role, 'planning'); assert.equal(format, 'json'); assert.equal(purpose, 'scene_plan'); return calls === 1 ? '说明：{}' : JSON.stringify({ scenes: [scene()] }); }).plan(request({ plan: null }), new AbortController().signal);
  assert.equal(p.scenes.length, 1); assert.equal(calls, 2); assert.deepEqual(store.value(), existing);
});
test('JSON truncation is not retried as valid plan and transport is not correction-retried', async () => {
  let calls = 0; await assert.rejects(pipeline(persistence(), async () => { calls++; return { text: '{"scenes":[]}', finishReason: 'length' }; }).plan(request({ plan: null, maxRetries: 2 }), new AbortController().signal), e => e.code === 'output_limit'); assert.equal(calls, 1);
  calls = 0; await assert.rejects(pipeline(persistence(), async () => { calls++; throw new Error('connection'); }).plan(request({ plan: null, maxRetries: 2 }), new AbortController().signal)); assert.equal(calls, 1);
});
test('length continuation deduplicates exact overlap, full plan and prior context retained', async () => {
  const store = persistence(); let count = 0;
  const overlap = '🌙这里是至少十二字符的衔接尾部';
  const result = await pipeline(store, async (_system, user, _role, _signal, purpose) => { count++; if (count === 1) return { text: '前文' + overlap, finishReason: 'length' }; assert.equal(purpose, 'scene_continue'); assert.match(user, /完整场景计划JSON/); assert.match(user, /作者设定/); return { text: overlap + '后文', finishReason: 'stop' }; }).run(request(), new AbortController().signal);
  assert.equal(result.body, '前文' + overlap + '后文'); assert.equal(result.checkpoint.requestCount, 2);
});
test('short coincidences are not deleted from continuation', () => {
  assert.equal(core.mergeTextContinuation('他说：好', '好吧。'), '他说：好好吧。');
});
test('persistent truncation leaves no allegedly completed partial scene', async () => {
  const store = persistence(); await assert.rejects(pipeline(store, async () => ({ text: '不完整', finishReason: 'length' })).run(request({ maxContinuationsPerScene: 0 }), new AbortController().signal), e => e.code === 'output_limit');
  assert.equal(store.value().completedScenes.length, 0); assert.equal(store.value().status, 'FAILED');
});
test('optional review is a strict JSON phase and style suggestion remains advisory', async () => {
  const store = persistence(); let count = 0;
  const result = await pipeline(store, async (_system, _user, role, _signal, purpose, format) => { count++; if (count === 1) return '甲知道凶手。'; assert.equal(role, 'review'); assert.equal(purpose, 'scene_review'); assert.equal(format, 'json'); return JSON.stringify({ findings: [review({ category: 'STYLE', severity: 'SUGGESTION', constraint: '' })] }); }).run(request({ mode: 'POLISHED' }), new AbortController().signal);
  assert.equal(result.body, '甲知道凶手。'); assert.equal(result.findings.length, 1); assert.equal(result.checkpoint.reviewCompleted, true);
});
test('budget rejects complete mandatory context without a network call or truncation', async () => {
  const store = persistence(); let calls = 0; await assert.rejects(pipeline(store, async () => { calls++; return '正文'; }).run(request({ maxInputCharacters: 100 }), new AbortController().signal), e => e.code === 'budget'); assert.equal(calls, 0); assert.equal(store.value().status, 'FAILED');
});
test('abort after preview but before scene commit preserves no unconfirmed partial scene', async () => {
  const store = persistence(), controller = new AbortController();
  await assert.rejects(pipeline(store, async () => '尚未提交正文').run(request(), controller.signal, p => { if (p.preview) controller.abort(); }), e => e.name === 'AbortError');
  assert.equal(store.value().status, 'INTERRUPTED'); assert.equal(store.value().completedScenes.length, 0); assert.equal(store.value().requestCount, 1);
});
test('failed review keeps all scenes and resume runs only review, not drafting', async () => {
  const store = persistence(); let calls = 0;
  await assert.rejects(pipeline(store, async () => { if (++calls === 1) return '甲知道凶手。'; throw new Error('review offline'); }).run(request({ mode: 'POLISHED' }), new AbortController().signal), /review offline/);
  const old = store.value(); assert.equal(old.completedScenes.length, 1); assert.equal(old.reviewCompleted, false);
  const result = await pipeline(store, async (_system, _user, role) => { assert.equal(role, 'review'); return '{"findings":[]}'; }, { newRunId: () => 'review-resume' }).run(request({ mode: 'POLISHED', resumeRunId: old.runId }), new AbortController().signal);
  assert.equal(result.body, '甲知道凶手。'); assert.equal(result.checkpoint.requestCount, 3);
});
test('JSON correction retry quota bounded and successful planning counts toward drafting quota', async () => {
  let calls = 0;
  await assert.rejects(pipeline(persistence(), async () => { calls++; return '{}'; }).plan(request({ plan: null, maxRetries: 2 }), new AbortController().signal)); assert.equal(calls, 3);
  const store = persistence(); calls = 0;
  await assert.rejects(pipeline(store, async () => { calls++; return JSON.stringify({ scenes: [scene()] }); }).run(request({ plan: null, maxRequests: 1 }), new AbortController().signal), e => e.code === 'quota');
  assert.equal(calls, 1); assert.equal(store.value().requestCount, 1); assert.equal(store.value().completedScenes.length, 0);
});
test('persistence failure while preserving cancellation never masks original abort', async () => {
  const store = persistence(), controller = new AbortController(); const save = store.compareAndSet;
  store.compareAndSet = async (expected, next) => { if (next.status === 'INTERRUPTED') throw new Error('disk full'); return save(expected, next); };
  await assert.rejects(pipeline(store, async () => { controller.abort(new Error('original cancellation')); return '正文'; }).run(request(), controller.signal), /original cancellation/);
});
test('completed result cannot be demoted by a later UI progress failure', async () => {
  const store = persistence(); await assert.rejects(pipeline(store, async () => '正文').run(request(), new AbortController().signal, p => { if (p.stage === 'completed') throw new Error('UI progress failure'); }), /UI progress failure/);
  assert.equal(store.value().status, 'COMPLETED'); assert.equal(store.value().completedScenes[0].body, '正文');
});
test('CAS transition protects original prefix/source and completed task immutability', () => {
  const c = checkpoint(); const next = { ...c, revision: 1, completedScenes: [{ sceneId: 's1', body: '原正文', exitState: '拿到钥匙', completedAt: 1 }] };
  assert.equal(core.isValidCheckpointTransition(c, next), true); assert.equal(core.isValidCheckpointTransition(next, { ...next, revision: 2, completedScenes: [{ ...next.completedScenes[0], body: '替换' }] }), false);
  assert.equal(core.isValidCheckpointTransition(c, { ...c, revision: 1, sourceFingerprint: 'changed' }), false);
  assert.equal(core.isValidCheckpointTransition({ ...next, status: 'COMPLETED' }, { ...next, revision: 2 }), false);
});

function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const entries = new Map(); let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0); assert.equal(view.getUint16(offset + 28, true), 0);
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
    const data = bytes.slice(offset + 30 + nameLength, offset + 30 + nameLength + length); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    assert.equal((crc ^ 0xffffffff) >>> 0, view.getUint32(offset + 14, true));
    entries.set(name, new TextDecoder().decode(data)); offset += 30 + nameLength + length;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50); assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50); return entries;
}
test('EPUB package MIME is first STORED, nav/manifest/spine correct and XML escaped', () => {
  const zip = core.exportEpub({ title: '书&名', author: '作者', chapters: [{ title: '第一章', body: '<正文>🌙\u0001\ud800' }], outline: '大纲', language: 'zh-CN', identifier: 'fixed' });
  const entries = unzipStored(zip); assert.equal(entries.keys().next().value, 'mimetype'); assert.equal(entries.get('mimetype'), 'application/epub+zip');
  assert.match(entries.get('EPUB/package.opf'), /<spine>.*doc-2/); assert.match(entries.get('EPUB/nav.xhtml'), /chapter-1.xhtml/); assert.match(entries.get('EPUB/chapter-1.xhtml'), /&lt;正文&gt;🌙��/); assert.match(entries.get('EPUB/package.opf'), /书&amp;名/);
});
test('DOCX required relationships/styles/page breaks and whitespace included; unsafe zip paths denied', () => {
  const entries = unzipStored(core.exportDocx({ title: '书', chapters: [{ title: '一', body: '  正文\n第二段' }] }));
  for (const path of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) assert.ok(entries.has(path));
  assert.match(entries.get('word/document.xml'), /xml:space="preserve">  正文/); assert.match(entries.get('word/document.xml'), /<w:pageBreakBefore\/>/); assert.throws(() => core.createStoredZip([{ path: '../escape', text: 'x' }]));
});
