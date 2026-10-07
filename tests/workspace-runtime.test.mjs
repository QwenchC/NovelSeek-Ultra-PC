import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// No native app or paid model calls: exercise the actual adapter with atomic store/native mocks.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/writingUi/workspaceRuntime.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  plugins: [
    {
      name: 'workspace-mocks',
      setup(builder) {
        builder.onResolve(
          { filter: /^@store\/index$|^@services\/api$|^@services\/writingApi$/ },
          args => ({ path: args.path, namespace: 'mock' })
        );
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({
          contents:
            args.path === '@store/index'
              ? `
      export const useAppStore = { getState: () => globalThis.__workspaceTest.state,
        setState(update) { const current=globalThis.__workspaceTest.state; const patch=typeof update==='function'?update(current):update; globalThis.__workspaceTest.state={...current,...patch}; } };
      export async function flushWritingPersistence() { globalThis.__workspaceTest.flushes++; if(globalThis.__workspaceTest.failFlush)throw new Error('disk unavailable'); }
    `
              : args.path === '@services/api'
                ? `
      export const projectApi={getById:async()=>globalThis.__workspaceTest.project};
      export const chapterApi={getByProject:async()=>structuredClone(globalThis.__workspaceTest.chapters)};
    `
                : `
      export async function requestWriting(request){globalThis.__workspaceTest.requests.push(request);return globalThis.__workspaceTest.respond(request);}
      export async function adoptChapterCandidate(input){const x=globalThis.__workspaceTest;const chapter=x.chapters.find(c=>c.id===input.chapterId);if((chapter.draft_text||'')!==input.expectedDraft||(chapter.final_text||'')!==input.expectedFinal)throw new Error('source changed');x.adoptions.push(input);chapter.draft_text=input.body;chapter.final_text=input.body;}
    `,
          loader: 'js',
        }));
      },
    },
  ],
});
const runtime = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);
const loadCore = await build({
  entryPoints: [fileURLToPath(new URL('../src/writing/index.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
});
const core = await import(
  'data:text/javascript;base64,' + Buffer.from(loadCore.outputFiles[0].text).toString('base64')
);
const scene = {
  id: 's1',
  title: '雨夜',
  pov: '甲',
  time: '夜',
  location: '城门',
  goal: '找线索',
  conflict: '守卫阻拦',
  turn: '得到钥匙',
  entryState: '不知道真相',
  exitState: '得到钥匙',
  requiredEvents: ['拿到钥匙'],
  forbiddenEvents: [],
  targetWords: 1000,
};
function setup() {
  globalThis.__workspaceTest = {
    flushes: 0,
    requests: [],
    adoptions: [],
    failFlush: false,
    project: { id: 'p', title: '测试书', language: 'zh' },
    chapters: [
      {
        id: 'c',
        project_id: 'p',
        title: '第一章',
        order_index: 0,
        draft_text: '原稿',
        final_text: '',
        outline_goal: '找线索',
      },
    ],
    respond: async () => ({
      text: '新候选正文。🌙',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 4 },
    }),
    state: {
      backupImportPending: false,
      writingWorkspaceByProject: { p: { ...core.defaultWritingWorkspace(), mode: 'quick' } },
      sceneWritingByProject: {},
      writingUsageByProject: {},
      backupExtensions: {},
      textModelProfiles: [],
      textModelConfig: {
        provider: 'custom',
        model: 'mock',
        apiUrl: 'local',
        apiKey: '',
        temperature: 0.5,
      },
      agentReasoningLevel: 'medium',
      getCharacters: () => [],
      getWorldSetting: () => '',
      getTimeline: () => '',
      longNovelOutlineByProject: {},
      plotArcsByProject: {},
      volumesByProject: {},
      cultivationRealmsByProject: {},
      bumpChaptersVersion: () => {},
    },
  };
  return globalThis.__workspaceTest;
}
function checkpoint(extra = {}) {
  const plan = {
    projectId: 'p',
    chapterId: 'c',
    sourceFingerprint: core.makeSourceFingerprint('source'),
    scenes: [scene],
    updatedAt: 1,
  };
  return {
    runId: 'r1',
    revision: 0,
    sourceFingerprint: plan.sourceFingerprint,
    plan,
    completedScenes: [],
    status: 'RUNNING',
    error: null,
    mode: 'SCENES',
    requestCount: 0,
    reviewFindings: [],
    reviewCompleted: false,
    updatedAt: 1,
    chapterTask: '找线索',
    language: 'zh',
    baselineText: '',
    ...extra,
  };
}

test('checkpoint CAS publishes a matching plan, is durable, and rejects stale writers', async () => {
  const x = setup(),
    store = runtime.createWorkspacePersistence(),
    first = checkpoint();
  assert.equal(await store.compareAndSet(null, first), true);
  assert.equal(x.flushes, 1);
  core.validateWritingArchive(x.state.sceneWritingByProject.p, 'p');
  assert.equal(await store.compareAndSet(null, first), false);
  assert.equal(
    await store.compareAndSet(first, {
      ...first,
      revision: 1,
      status: 'INTERRUPTED',
      updatedAt: 2,
    }),
    true
  );
  const interrupted = x.state.sceneWritingByProject.p.checkpoints[0];
  assert.equal(
    await store.compareAndSet(interrupted, {
      ...interrupted,
      runId: 'r2',
      revision: 2,
      status: 'RUNNING',
      updatedAt: 3,
    }),
    true
  );
  assert.equal(x.state.sceneWritingByProject.p.checkpoints.length, 1);
  assert.equal(x.state.backupExtensions.pcWritingDraftHistoryByProject.p[0].runId, 'r1');
  core.validateWritingArchive(x.state.sceneWritingByProject.p, 'p');
});
test('savePlan rejects orphan RUNNING checkpoints, archives interrupted draft and preserves Android graph', async () => {
  const x = setup(),
    store = runtime.createWorkspacePersistence(),
    first = checkpoint();
  await store.compareAndSet(null, first);
  assert.equal(await store.savePlan({ ...first.plan, updatedAt: 2 }), false);
  await store.compareAndSet(first, { ...first, status: 'INTERRUPTED', revision: 1, updatedAt: 2 });
  assert.equal(await store.savePlan({ ...first.plan, updatedAt: 3 }), true);
  assert.equal(x.state.sceneWritingByProject.p.checkpoints.length, 0);
  assert.equal(x.state.backupExtensions.pcWritingDraftHistoryByProject.p.length, 1);
  core.validateWritingArchive(x.state.sceneWritingByProject.p, 'p');
});
test('generation publishes a pending candidate, never writes prose, and adoption is native CAS/idempotent', async () => {
  const x = setup();
  const candidate = await runtime.generateWorkspaceChapter('p', 'c', { sessionId: 's' });
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.sessionId, 's');
  assert.equal(x.chapters[0].draft_text, '原稿');
  assert.equal(x.adoptions.length, 0);
  assert.equal(runtime.hasActiveWorkspaceTasks(), false);
  core.validateWritingArchive(x.state.sceneWritingByProject.p, 'p');
  assert.equal(x.requests[0].responseFormat, 'text');
  assert.equal(
    (await runtime.reviewWorkspaceCandidate('p', candidate.id, 'accept')).accepted,
    true
  );
  await runtime.reviewWorkspaceCandidate('p', candidate.id, 'accept');
  assert.equal(x.adoptions.length, 1);
  assert.equal(x.chapters[0].final_text, candidate.body);
});
test('changed sources and imported candidates cannot overwrite current prose', async () => {
  const x = setup(),
    candidate = await runtime.generateWorkspaceChapter('p', 'c');
  x.chapters[0].draft_text = '用户的新正文';
  await assert.rejects(runtime.reviewWorkspaceCandidate('p', candidate.id, 'accept'), /变化/);
  assert.equal(x.adoptions.length, 0);
  x.state.backupExtensions.pcWritingCandidatesByProject.p[0].importedReadOnly = true;
  await assert.rejects(runtime.reviewWorkspaceCandidate('p', candidate.id, 'accept'), /只读/);
});
test('source-linked notes bind to current prose only after explicit verification', async () => {
  const x = setup(),
    workspace = {
      ...core.defaultWritingWorkspace(),
      notes: [
        {
          id: 'n',
          kind: 'fact',
          subject: '钥匙',
          text: '甲取得钥匙',
          sourceChapterId: 'c',
          sourceBodyHash: null,
          knownByCharacterIds: [],
          payoffChapterId: null,
          resolved: false,
          importance: 1,
        },
      ],
    };
  await runtime.saveWorkspace('p', workspace);
  assert.equal(x.state.writingWorkspaceByProject.p.notes[0].sourceBodyHash, core.hashText('原稿'));
  x.chapters[0].draft_text = '改变后的正文';
  await runtime.saveWorkspace('p', x.state.writingWorkspaceByProject.p);
  assert.equal(x.state.writingWorkspaceByProject.p.notes[0].sourceBodyHash, core.hashText('原稿'));
});
test('durability failure blocks the pipeline before another paid request', async () => {
  const x = setup();
  x.failFlush = true;
  await assert.rejects(runtime.generateWorkspaceChapter('p', 'c'), /disk unavailable/);
  assert.equal(x.requests.length, 0);
  assert.equal(runtime.hasActiveWorkspaceTasks(), false);
});
test('exact missing resume is an error, not a silent fresh generation', async () => {
  const x = setup();
  await assert.rejects(
    runtime.generateWorkspaceChapter('p', 'c', { resumeRunId: 'missing' }),
    /确切任务/
  );
  assert.equal(x.requests.length, 0);
});
test('standalone planning forwards strict JSON format and really saves a plan', async () => {
  const x = setup();
  x.respond = async () => ({ text: JSON.stringify({ scenes: [scene] }), finishReason: 'stop' });
  await runtime.generateWorkspaceScenePlan('p', 'c');
  assert.equal(x.requests[0].responseFormat, 'json');
  assert.equal(x.state.sceneWritingByProject.p.plans.length, 1);
  assert.ok(x.flushes > 0);
  assert.equal(runtime.hasActiveWorkspaceTasks(), false);
});

test('editing the scene plan invalidates old adoption and revision before any paid call', async () => {
  const x = setup(),
    candidate = await runtime.generateWorkspaceChapter('p', 'c');
  const current = x.state.sceneWritingByProject.p.plans[0];
  await runtime
    .createWorkspacePersistence()
    .savePlan({
      ...current,
      updatedAt: current.updatedAt + 1,
      scenes: [{ ...current.scenes[0], goal: '另一个目标' }],
    });
  await assert.rejects(runtime.reviewWorkspaceCandidate('p', candidate.id, 'accept'), /场景计划/);
  await assert.rejects(runtime.reviseWorkspaceCandidate('p', candidate.id, '重写结尾'), /场景计划/);
  assert.equal(x.adoptions.length, 0);
  assert.equal(x.requests.length, 1);
});

test('adoption and revision cannot race the same candidate', async () => {
  const x = setup(),
    candidate = await runtime.generateWorkspaceChapter('p', 'c'),
    originalProject = x.project;
  let release;
  x.project = new Promise(resolve => {
    release = resolve;
  });
  const adopting = runtime.reviewWorkspaceCandidate('p', candidate.id, 'accept');
  await assert.rejects(
    runtime.reviseWorkspaceCandidate('p', candidate.id, '改写'),
    /正在审核或修订/
  );
  release(originalProject);
  await adopting;
  assert.equal(x.adoptions.length, 1);
  assert.equal(x.requests.length, 1);
});

test('pause aborts only its scoped run and persists an interrupted checkpoint', async () => {
  const x = setup();
  x.respond = request =>
    new Promise((_resolve, reject) =>
      request.signal.addEventListener(
        'abort',
        () => reject(new DOMException('paused', 'AbortError')),
        { once: true }
      )
    );
  const running = runtime.generateWorkspaceChapter('p', 'c');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.hasActiveWorkspaceTasks(), true);
  await runtime.pauseWorkspaceTask('p', 'c');
  await assert.rejects(running, /paused/);
  assert.equal(runtime.hasActiveWorkspaceTasks(), false);
  assert.equal(x.state.sceneWritingByProject.p.checkpoints[0].status, 'INTERRUPTED');
  core.validateWritingArchive(x.state.sceneWritingByProject.p, 'p');
});
