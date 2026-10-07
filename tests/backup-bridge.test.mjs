import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/backup/bridge.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { buildBackupBundle, prepareBackupImport, summarizeBackup } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const workspace = () => ({ version: 1, mode: 'scene', style: '古风', perspective: '第三人称', forbiddenExpressions: '', sampleProse: '', maxRequestsPerRun: 16, planningProfileId: null, writingProfileId: null, reviewProfileId: null, extractionProfileId: null, notes: [] });
const plan = () => ({ projectId: 'p', chapterId: 'c', sourceFingerprint: 'android-original-source-hash', updatedAt: 1,
  scenes: [{ id: 's1', title: '第一场', pov: '主角', time: '夜', location: '山', goal: '寻人', conflict: '雨', turn: '发现足迹', entryState: '入山', exitState: '发现足迹', requiredEvents: [], forbiddenEvents: [], targetWords: 100 }] });
const fixture = () => ({ version: 1, exportedAt: '2026-10-07T00:00:00Z', appVersion: '1.6.0', data: {
  projects: [{ id: 'p', title: '中文小说', futureProjectField: '保留' }], chaptersByProject: { p: [{ id: 'c', project_id: 'old', title: '第一章', order_index: 0, word_count: 4, arcId: 'arc', futureChapterField: true }] },
  chapterBodies: { c: { draft: '草稿😀', final: '已审核正文', futureBodyField: '必须保留' } }, chapterIllustrations: { c: [{ id: 'img', imageBase64: 'aGVsbG8=', futureImageField: true }] },
  charactersByProject: { p: [{ id: 'hero', name: '主角', portraitBase64: 'aGVsbG8=' }] },
  writingWorkspaceByProject: { p: workspace() }, writingUsageByProject: { p: [{ runId: 'r', model: 'deepseek', completedAt: '', requestCount: 1, promptTokens: 4, completionTokens: 2, cacheHitTokens: 3, failedRequests: 0, chapterId: 'c', parentRunId: null }] },
  sceneWritingByProject: { p: { version: 1, plans: [plan()], checkpoints: [{ runId: 'run-original', revision: 6, sourceFingerprint: plan().sourceFingerprint, plan: plan(), completedScenes: [], status: 'RUNNING', error: null, mode: 'SCENES', requestCount: 1, reviewFindings: [], reviewCompleted: false, updatedAt: 1, chapterTask: '生成', language: 'zh', baselineText: '' }] } },
  generationRunsByProject: { p: [{ id: 'generation', projectId: 'p', chapterId: 'c', status: 'running', candidates: [{ id: 'candidate', body: '候选😀' }], sourceHash: 'original' }] },
  textModelProfiles: [{ id: 'android-only', apiKey: 'ANDROID-SECRET', model: 'deepseek-chat' }], textModelConfig: { apiKey: 'ANDROID-TEXT-SECRET' }, embeddingConfig: { apiKey: 'ANDROID-EMBED-SECRET' }, pollinationsKey: 'ANDROID-IMAGE-SECRET',
  androidSettings: { textModelConfig: { apiKey: 'NESTED-SECRET' } },
  unknownAndroidByProject: { p: { key: 'this is story data', narrative: 'API key is a plot clue' } },
  agentIndex: { currentId: 'session', items: [{ id: 'session', title: '原会话', createdAt: '' }], futureIndexField: true },
  agentSessions: { session: { id: 'session', title: '原会话', createdAt: '', lockedProjectId: 'p', autoApprove: true, engineMode: 'dual', reasoningLevel: 'high',
    runStatus: 'running', runCheckpoint: { runToken: 'old', recoveryPending: true, phase: 'streaming' },
    cacheMetrics: { observedRequests: 3, hitTokens: 40, missTokens: 60 }, memory: { summary: '会话摘要', compactedThroughStepId: 'a', compactedPrefixDigest: 'old-digest' },
    activePlan: { planId: 'identity', steps: [{ id: 'p1' }] }, pendingReview: { projectId: 'p', chapterId: 'c', runId: 'run-original', candidateId: 'candidate', actionId: 'a' },
    steps: [{ id: 'a', type: 'action', text: '{"action":"generate"}', tool: 'generate_chapter', planId: 'identity', planStepId: 'p1', argsJson: '{}', actionStatus: 'running', resolvedProjectId: 'p' },
      { id: 'o', type: 'observation', text: '候选已生成', resultForActionId: 'a', resultKind: 'pending_review' }], futureSessionField: { preserve: true } } },
} });
const state = () => ({ projects: [], charactersByProject: {}, writingWorkspaceByProject: {}, writingUsageByProject: {}, sceneWritingByProject: {}, generationRunsByProject: {}, promoByChapter: {}, novelChatsByProject: {}, backupExtensions: {}, folders: [], agentSessions: {}, agentSessionOrder: [], agentCurrentSessionId: null, agentSessionMetrics: {}, agentSessionContextSummaries: {}, textModelProfiles: [{ id: 'local', apiKey: 'LOCAL-SECRET' }], textModelConfig: { apiKey: 'LOCAL-TEXT' }, embeddingConfig: { apiKey: 'LOCAL-EMBED' }, pollinationsKey: 'LOCAL-IMAGE', agentEngine: 'legacy', agentReasoningLevel: 'medium', agentContextBudget: 32000 });
function exportedContent(prepared) { return { projects: prepared.content.projects, chapters: prepared.content.chapters }; }
test('Android import keeps local settings, interrupts foreign runs and keeps original source identity', () => {
  const bundle = fixture(), snapshot = structuredClone(bundle), prepared = prepareBackupImport(bundle, state(), true);
  assert.equal(prepared.metadata.textModelConfig, undefined);
  assert.equal(prepared.metadata.sceneWritingByProject.p.checkpoints[0].status, 'INTERRUPTED');
  assert.equal(prepared.metadata.sceneWritingByProject.p.checkpoints[0].runId, 'run-original');
  assert.equal(prepared.metadata.sceneWritingByProject.p.checkpoints[0].revision, 6);
  assert.equal(prepared.metadata.sceneWritingByProject.p.checkpoints[0].sourceFingerprint, 'android-original-source-hash');
  assert.equal(prepared.metadata.generationRunsByProject.p[0].status, 'cancelled');
  assert.equal(prepared.content.chapters[0].project_id, 'p');
  assert.equal(prepared.content.chapters[0].final_text, '已审核正文');
  assert.deepEqual(bundle, snapshot, 'preview/preparation may not mutate supplied backup');
});
test('agent step dual mapping retains plan/action/review attribution and disables automatic execution', () => {
  const imported = prepareBackupImport(fixture(), state()).metadata;
  const session = imported.agentSessions.session;
  assert.equal(session.steps[0].role, 'tool'); assert.equal(session.steps[0].type, 'action');
  assert.equal(session.steps[1].role, 'result'); assert.equal(session.steps[1].resultForActionId, 'a');
  assert.equal(session.steps[0].actionStatus, 'interrupted'); assert.equal(session.autoApprove, false);
  assert.equal(session.importedReadOnly, true); assert.equal(session.runCheckpoint.recoveryPending, false);
  assert.equal(session.runStatus, 'interrupted'); assert.equal(session.activePlan.planId, 'identity');
  assert.equal(session.pendingReview.candidateId, 'candidate');
  assert.equal(imported.agentSessionMetrics.session.measuredRequests, 3);
  assert.equal(imported.agentSessionMetrics.session.promptTokens, 100);
  assert.equal(imported.agentSessionMetrics.session.cacheHitTokens, 40);
});
test('Android → PC → Android retains text, illustrations, identities and unknown fields, excluding all known secrets', () => {
  const prepared = prepareBackupImport(fixture(), state()), merged = { ...state(), ...prepared.metadata };
  const bundle = buildBackupBundle(merged, exportedContent(prepared));
  const serialized = JSON.stringify(bundle);
  for (const secret of ['ANDROID-SECRET', 'ANDROID-TEXT-SECRET', 'ANDROID-EMBED-SECRET', 'ANDROID-IMAGE-SECRET', 'NESTED-SECRET', 'LOCAL-SECRET', 'LOCAL-TEXT', 'LOCAL-EMBED', 'LOCAL-IMAGE']) assert.ok(!serialized.includes(secret), secret);
  assert.equal(bundle.data.chapterBodies.c.draft, '草稿😀'); assert.equal(bundle.data.chapterBodies.c.futureBodyField, '必须保留');
  assert.equal(bundle.data.chapterIllustrations.c[0].imageBase64, 'aGVsbG8='); assert.equal(bundle.data.chapterIllustrations.c[0].futureImageField, true);
  assert.equal(bundle.data.projects[0].futureProjectField, '保留'); assert.equal(bundle.data.chaptersByProject.p[0].futureChapterField, true);
  assert.equal(bundle.data.agentSessions.session.steps[0].planId, 'identity'); assert.equal(bundle.data.agentSessions.session.futureSessionField.preserve, true);
  assert.deepEqual(bundle.data.unknownAndroidByProject, fixture().data.unknownAndroidByProject);
  assert.equal(bundle.data.agentIndex.futureIndexField, true);
  assert.equal(prepared.metadata.backupExtensions.chapterBodies.c.draft, undefined, 'metadata must not duplicate all SQLite body text');
  assert.equal(prepared.metadata.backupExtensions.chapterIllustrations, undefined, 'images are owned by SQLite');
});
test('explicit include-secrets exports secrets, and only desktop settings may replace PC settings', () => {
  const prepared = prepareBackupImport(fixture(), state()), merged = { ...state(), ...prepared.metadata };
  const bundle = buildBackupBundle(merged, exportedContent(prepared), true);
  assert.equal(bundle.data.textModelProfiles[0].apiKey, 'ANDROID-SECRET');
  assert.equal(bundle.data.pcSettings.textModelConfig.apiKey, 'LOCAL-TEXT');
  const desktop = { ...bundle, data: { pcSettings: { textModelConfig: { apiKey: 'selected-key' }, theme: 'dark' } } };
  assert.equal(prepareBackupImport(desktop, state()).metadata.textModelConfig, undefined);
  assert.equal(prepareBackupImport(desktop, state(), true).metadata.textModelConfig.apiKey, 'selected-key');
});
test('invalid content, orphan body, duplicate chapter/session IDs and damaged illustrations fail preflight/export', () => {
  const invalid = fixture(); invalid.data.chapterBodies.c.draft = 7;
  assert.throws(() => prepareBackupImport(invalid, state()), /文本/);
  const orphan = fixture(); orphan.data.chapterBodies.orphan = { draft: 'lost text' };
  assert.throws(() => prepareBackupImport(orphan, state()), /缺少章节/);
  const duplicate = fixture(); duplicate.data.chaptersByProject.p.push({ ...duplicate.data.chaptersByProject.p[0] });
  assert.throws(() => prepareBackupImport(duplicate, state()), /重复/);
  const session = fixture(); session.data.agentSessions.session.id = 'not-session';
  assert.throws(() => prepareBackupImport(session, state()), /会话/);
  const prepared = prepareBackupImport(fixture(), state()); prepared.content.chapters[0].illustrations = '{broken';
  assert.throws(() => buildBackupBundle({ ...state(), ...prepared.metadata }, exportedContent(prepared)), /插图数据损坏/);
});
test('invalid scene archives fail without rebinding their hashes; legacy metadata may omit bodies', () => {
  const invalid = fixture(); invalid.data.sceneWritingByProject.p.checkpoints[0].sourceFingerprint = 'different';
  assert.throws(() => prepareBackupImport(invalid, state()), /来源/);
  const metadataOnly = fixture(); delete metadataOnly.data.chapterBodies; delete metadataOnly.data.chapterIllustrations;
  const prepared = prepareBackupImport(metadataOnly, state()); assert.equal(prepared.content.chapters[0].draft_text, null);
});
test('unknown desktop candidate extension survives both formats but is imported read-only', () => {
  const incoming = fixture(); incoming.data.pcWritingCandidatesByProject = { p: [{ schema: 'pc-workspace-candidate.v1', id: 'candidate', body: '尚未审核', status: 'generating' }] };
  const prepared = prepareBackupImport(incoming, state());
  assert.equal(prepared.metadata.backupExtensions.pcWritingCandidatesByProject.p[0].status, 'pending');
  assert.equal(prepared.metadata.backupExtensions.pcWritingCandidatesByProject.p[0].importedReadOnly, true);
  const bundle = buildBackupBundle({ ...state(), ...prepared.metadata }, exportedContent(prepared));
  assert.equal(bundle.data.pcWritingCandidatesByProject.p[0].body, '尚未审核');
  assert.equal(bundle.data.generationRunsByProject.p[0].id, 'generation');
});
test('preview summary counts content and overlaps; Android settings do not advertise overwrite', () => {
  const summary = summarizeBackup(fixture(), { ...state(), projects: [{ id: 'p', title: '已有' }] });
  assert.equal(summary.projectIdsInBackup, 1); assert.equal(summary.projectIdsOverlap, 1);
  assert.equal(summary.chaptersInBackup, 1); assert.equal(summary.sessionsInBackup, 1); assert.equal(summary.hasAppSettings, false);
});
test('malformed explicit PC metrics cannot replace sanitized Android cache observations or crash the UI', () => {
  for (const metric of [{}, { promptTokens: -1 }, { promptTokens: 1, completionTokens: 0, cacheHitTokens: 2, measuredRequests: 1, unknownRequests: 0, contextTokens: 1, contextBudget: 32000 }]) {
    const incoming = fixture(); incoming.data.agentSessionMetrics = { session: metric };
    assert.throws(() => prepareBackupImport(incoming, state()), /会话/);
  }
  const incoming = fixture(); incoming.appVersion = '2.1.0'; incoming.data.pcSettings = { theme: 'not-a-theme' };
  assert.throws(() => prepareBackupImport(incoming, state(), true), /桌面设置/);
});
test('legacy camel-case chapter aliases retain target, order, timestamps and arc when restoring SQLite', () => {
  const incoming = fixture(); incoming.data.chaptersByProject.p = [{ id: 'c', title: '历史章', orderIndex: 8, outlineGoal: '保留目标', wordCount: 20, createdAt: 'created', updatedAt: 'updated', arcId: 'arc' }];
  const chapter = prepareBackupImport(incoming, state()).content.chapters[0];
  assert.equal(chapter.order_index, 8); assert.equal(chapter.outline_goal, '保留目标');
  assert.equal(chapter.word_count, 20); assert.equal(chapter.created_at, 'created'); assert.equal(chapter.updated_at, 'updated'); assert.equal(chapter.arc_id, 'arc');
});
test('partial Android cache hit/miss observations remain unknown rather than becoming a false 100 percent hit', () => {
  const incoming = fixture(); delete incoming.data.agentSessions.session.cacheMetrics.missTokens;
  const metric = prepareBackupImport(incoming, state()).metadata.agentSessionMetrics.session;
  assert.equal(metric.measuredRequests, 0); assert.equal(metric.unknownRequests, 3); assert.equal(metric.cacheHitTokens, 0);
  assert.equal(metric.coveredDigest, undefined, 'invalid legacy digest remains raw evidence, not an active PC compaction digest');
});
test('prototype-like and unknown step role/type cannot become executable PC roles', () => {
  for (const malicious of ['constructor', '__proto__', 'toString', 'future-kind']) {
    const incoming = fixture(); incoming.data.agentSessions.session.steps[0].role = malicious; incoming.data.agentSessions.session.steps[0].type = malicious;
    const prepared = prepareBackupImport(incoming, state());
    assert.equal(prepared.metadata.agentSessions.session.steps[0].role, 'result');
    const output = buildBackupBundle({ ...state(), ...prepared.metadata }, exportedContent(prepared));
    assert.equal(output.data.agentSessions.session.steps[0].type, malicious, 'opaque original type must survive without being trusted as a PC role');
  }
});
