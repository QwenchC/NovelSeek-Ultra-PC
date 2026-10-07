import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle the real runner and policy. Only the native transport, tools and host store are mocked.
// Every test imports a fresh runner module, so leases and singleton cancellation cannot leak.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/agent/agentRunner.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  plugins: [
    {
      name: 'agent-runner-host-mocks',
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^@store\/index$|^@services\/api$|^@services\/writingApi$|^\.\/agentTools$|^\.\.\/writingUi\/workspaceRuntime$/,
          },
          args => ({ path: args.path, namespace: 'mock' })
        );
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => {
          const source =
            args.path === '@store/index'
              ? `
        export const useAppStore = { getState: () => globalThis.__agentRunnerTest.state,
          setState(patch) { const x=globalThis.__agentRunnerTest; x.state={...x.state,...(typeof patch==='function'?patch(x.state):patch)}; } };
      `
              : args.path === '@services/writingApi'
                ? `
        export async function requestWriting(request) {
          const x=globalThis.__agentRunnerTest; x.requests.push(request);
          const action=x.actions.shift(); if(!action)throw new Error('Unexpected model request');
          return {text:JSON.stringify(action),finishReason:'stop',usage:{promptTokens:20,completionTokens:10,cacheHitTokens:5}};
        }
      `
                : args.path === '@services/api'
                  ? `
        export const chapterApi={getByProject:async pid=>{const x=globalThis.__agentRunnerTest;x.chapterReads.push(pid);return x.readChapters?x.readChapters(pid):structuredClone(x.chapters[pid]||[]);}};
      `
                  : args.path === './agentTools'
                    ? `
        export const AGENT_TOOLS=[{name:'generate_chapter',sensitive:false,run:async(args,ctx)=>globalThis.__agentRunnerTest.generate(args,ctx)}];
        export const toolDocs=()=> 'generate_chapter creates a candidate; approval is required';
        export const findTool=name=>AGENT_TOOLS.find(tool=>tool.name===name);
      `
                    : `
        export const getWorkspaceCandidates=pid=>globalThis.__agentRunnerTest.candidates[pid]||[];
      `;
          return { contents: source, loader: 'js' };
        });
      },
    },
  ],
});
let moduleNonce = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await tick();
  }
}
async function fixture(t) {
  const x = {
    requests: [],
    chapterReads: [],
    toolCalls: [],
    candidates: { p: [] },
    chapters: { p: [{ id: 'chapter', final_text: '', draft_text: '' }] },
    actions: [
      { action: 'generate_chapter', args: { chapterId: 'chapter' } },
      { action: 'final', args: { message: '完成' } },
    ],
  };
  x.state = {
    uiLanguage: 'zh',
    backupImportPending: false,
    agentEngine: 'legacy',
    agentReasoningLevel: 'medium',
    agentContextBudget: 200000,
    agentSessionMetrics: {},
    agentMaxSteps: 5,
    agentStatus: 'idle',
    agentRunSessionId: null,
    agentPendingConfirm: null,
    agentCurrentSessionId: 'owner',
    currentProject: { id: 'p' },
    projects: [
      { id: 'p', title: 'Owner book' },
      { id: 'other-project', title: 'Other book' },
    ],
    textModelConfig: {
      provider: 'custom',
      model: 'mock',
      apiUrl: 'local',
      apiKey: '',
      temperature: 0.5,
    },
    embeddingConfig: {},
    backupExtensions: { pcWritingCandidatesByProject: x.candidates },
    agentSessions: {
      owner: {
        id: 'owner',
        title: 'Owner conversation',
        lockedProjectId: 'p',
        autoApprove: true,
        steps: [],
      },
      other: {
        id: 'other',
        title: 'Other conversation',
        lockedProjectId: 'other-project',
        autoApprove: true,
        steps: [],
      },
    },
    getAgentSession: id => x.state.agentSessions[id],
    patchAgentSession: (id, patch) => {
      x.state.agentSessions[id] = { ...x.state.agentSessions[id], ...patch };
    },
    appendAgentStep: (id, step) => {
      x.state.agentSessions[id].steps.push(step);
    },
    setAgentStatus: value => {
      x.state.agentStatus = value;
    },
    setAgentRunSessionId: value => {
      x.state.agentRunSessionId = value;
    },
    setAgentPendingConfirm: value => {
      x.state.agentPendingConfirm = value;
    },
    getVolumes: () => [],
    getPlotArcs: () => [],
    getCharacters: () => [],
  };
  x.generate = async (args, context) => {
    x.toolCalls.push({ args, context });
    const candidate = {
      id: 'current',
      projectId: 'p',
      chapterId: 'chapter',
      runId: 'run-current',
      sessionId: context.sessionId,
      status: 'pending',
      body: '候选正文',
      adoptedText: undefined,
    };
    x.candidates.p.push(candidate);
    return JSON.stringify({
      resultKind: 'pending_review',
      projectId: 'p',
      chapterId: 'chapter',
      runId: candidate.runId,
      candidateId: candidate.id,
    });
  };
  globalThis.__agentRunnerTest = x;
  const bundle = outputFiles[0].text + `\n// isolated-runner-instance-${++moduleNonce}`;
  const { agentRunner } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle).toString('base64')
  );
  x.runner = agentRunner;
  t.after(async () => {
    agentRunner.stop();
    await until(() => !agentRunner.isRunning(), 'runner cleanup');
  });
  x.waitForReview = () =>
    until(
      () =>
        x.state.agentStatus === 'awaiting_confirm' && !!x.state.agentSessions.owner.pendingReview,
      'candidate review lease'
    );
  x.adopt = (id = 'current', body = '用户采用的正文') => {
    const candidate = x.candidates.p.find(c => c.id === id);
    candidate.status = 'accepted';
    candidate.adoptedText = body;
    x.chapters.p[0].final_text = body;
  };
  x.finish = () => until(() => !agentRunner.isRunning(), 'runner completion');
  return x;
}

test('reviewing an old candidate cannot release the current exact candidate lease', async t => {
  const x = await fixture(t);
  x.candidates.p.push({
    id: 'old',
    projectId: 'p',
    chapterId: 'chapter',
    runId: 'run-old',
    sessionId: 'owner',
    status: 'accepted',
    adoptedText: '旧正文',
  });
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  await x.runner.reviewCompleted('owner', true, 'old');
  await tick();
  assert.equal(x.state.agentStatus, 'awaiting_confirm');
  assert.equal(x.requests.length, 1);
  assert.equal(x.chapterReads.length, 0);
  assert.equal(x.state.agentSessions.owner.pendingReview.candidateId, 'current');
  x.adopt();
  await x.runner.reviewCompleted('owner', true, 'current');
  await x.finish();
  assert.equal(x.requests.length, 2);
  assert.ok(x.state.agentSessions.owner.steps.some(s => s.role === 'final'));
});

test('cross-page review confirms the owning conversation, not the currently selected page/session', async t => {
  const x = await fixture(t);
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  x.state.agentCurrentSessionId = 'other';
  x.state.currentProject = { id: 'other-project' };
  x.adopt();
  await x.runner.reviewCompleted('other', true, 'current');
  await tick();
  assert.equal(x.requests.length, 1);
  assert.equal(x.state.agentStatus, 'awaiting_confirm');
  await x.runner.reviewCompleted('owner', true, 'current');
  await x.finish();
  assert.deepEqual(x.chapterReads, ['p']);
  assert.equal(x.state.agentSessions.other.steps.length, 0);
  assert.ok(x.state.agentSessions.owner.steps.some(s => s.role === 'final'));
});

test('rejection confirms the exact owner without claiming a prose commit', async t => {
  const x = await fixture(t);
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  x.candidates.p[0].status = 'rejected';
  await x.runner.reviewCompleted('owner', false, 'current');
  await x.finish();
  assert.equal(x.chapterReads.length, 0);
  assert.equal(x.chapters.p[0].final_text, '');
  assert.ok(x.state.agentSessions.owner.steps.some(s => s.content.includes('用户未采用候选正文')));
  assert.equal(x.state.agentSessions.owner.pcPlanEvidence, undefined);
});

test('a persisted review lease restores its original project even after focus/project selection changes', async t => {
  const x = await fixture(t);
  x.candidates.p.push({
    id: 'persisted',
    projectId: 'p',
    chapterId: 'chapter',
    runId: 'saved-run',
    sessionId: 'owner',
    status: 'pending',
  });
  x.state.agentSessions.owner.lockedProjectId = 'other-project';
  x.state.agentSessions.owner.pendingReview = {
    projectId: 'p',
    chapterId: 'chapter',
    runId: 'saved-run',
    candidateId: 'persisted',
    tool: 'generate_chapter',
  };
  x.state.currentProject = { id: 'other-project' };
  x.state.projects = [{ id: 'other-project', title: 'Selected' }];
  x.actions = [{ action: 'final', args: { message: '恢复审核完成' } }];
  x.runner.continue('owner');
  await x.waitForReview();
  assert.equal(x.requests.length, 0);
  assert.equal(x.toolCalls.length, 0);
  assert.equal(x.state.agentSessions.owner.pendingReview.projectId, 'p');
  x.adopt('persisted');
  await x.runner.reviewCompleted('owner', true, 'persisted');
  await x.finish();
  assert.deepEqual(x.chapterReads, ['p']);
  assert.equal(x.requests.length, 1);
});

test('persisted candidates are found from their archive even without a saved review marker or visible project', async t => {
  const x = await fixture(t);
  x.candidates.p.push({
    id: 'persisted',
    projectId: 'p',
    chapterId: 'chapter',
    runId: 'saved-run',
    sessionId: 'owner',
    status: 'pending',
  });
  x.state.agentSessions.owner.lockedProjectId = null;
  x.state.projects = [];
  x.actions = [{ action: 'final', args: { message: '恢复审核完成' } }];
  x.runner.continue('owner');
  await x.waitForReview();
  assert.equal(x.requests.length, 0);
  assert.equal(x.state.agentSessions.owner.pendingReview.candidateId, 'persisted');
  x.adopt('persisted');
  await x.runner.reviewCompleted('owner', true, 'persisted');
  await x.finish();
});

test('a candidate flag alone is not proof: mismatched native prose holds the gate until confirmation succeeds', async t => {
  const x = await fixture(t);
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  x.candidates.p[0].status = 'accepted';
  x.candidates.p[0].adoptedText = '采用正文';
  x.chapters.p[0].final_text = '别的正文';
  await assert.rejects(
    x.runner.reviewCompleted('owner', true, 'current'),
    /章节正文与采用结果不同/
  );
  assert.equal(x.state.agentStatus, 'awaiting_confirm');
  assert.equal(x.requests.length, 1);
  x.chapters.p[0].final_text = '采用正文';
  await x.runner.reviewCompleted('owner', true, 'current');
  await x.finish();
  assert.equal(x.requests.length, 2);
});

test('native proof read failure leaves the exact gate retryable without re-running generation', async t => {
  const x = await fixture(t);
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  x.adopt();
  x.readChapters = async () => {
    throw new Error('native read unavailable');
  };
  await assert.rejects(
    x.runner.reviewCompleted('owner', true, 'current'),
    /native read unavailable/
  );
  assert.equal(x.state.agentStatus, 'awaiting_confirm');
  assert.equal(x.toolCalls.length, 1);
  x.readChapters = undefined;
  await x.runner.reviewCompleted('owner', true, 'current');
  await x.finish();
  assert.equal(x.toolCalls.length, 1);
});

test('stop closes the pending review lease; a late adoption event cannot continue the cancelled run', async t => {
  const x = await fixture(t);
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  x.runner.stop();
  await x.finish();
  x.adopt();
  await x.runner.reviewCompleted('owner', true, 'current');
  await tick();
  assert.equal(x.requests.length, 1);
  assert.equal(x.state.agentRunSessionId, null);
  assert.equal(x.state.agentStatus, 'idle');
  assert.equal(x.state.agentSessions.owner.pendingReview, undefined);
  assert.ok(!x.state.agentSessions.owner.steps.some(s => s.role === 'final'));
});

test('stop during asynchronous native proof cannot release a stale gate after its read finishes', async t => {
  const x = await fixture(t);
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  x.adopt();
  let release;
  x.readChapters = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const confirming = x.runner.reviewCompleted('owner', true, 'current');
  await until(() => !!release, 'pending native proof read');
  x.runner.stop();
  await x.finish();
  release(structuredClone(x.chapters.p));
  await assert.rejects(confirming, /审核等待已变化/);
  assert.equal(x.requests.length, 1);
  assert.ok(!x.state.agentSessions.owner.steps.some(s => s.role === 'final'));
});

test('foreign read-only conversations are not replayed by Continue', async t => {
  const x = await fixture(t);
  x.state.agentSessions.owner.importedReadOnly = true;
  x.runner.continue('owner');
  await tick();
  assert.equal(x.requests.length, 0);
  assert.equal(x.toolCalls.length, 0);
  assert.equal(x.runner.isRunning(), false);
  assert.ok(
    x.state.agentSessions.owner.steps.some(
      s => s.role === 'error' && s.content.includes('跨端导入会话')
    )
  );
});

test('an explicit new task skips foreign read-only candidates instead of becoming stuck on their review', async t => {
  const x = await fixture(t);
  x.candidates.p.push({
    id: 'imported',
    projectId: 'p',
    chapterId: 'chapter',
    runId: 'foreign-run',
    sessionId: 'owner',
    status: 'pending',
    importedReadOnly: true,
  });
  x.state.agentSessions.owner.importedReadOnly = true;
  x.runner.start('owner', '根据当前资料创建新候选');
  await x.waitForReview();
  assert.equal(x.requests.length, 1);
  assert.equal(x.toolCalls.length, 1);
  assert.equal(x.state.agentSessions.owner.pendingReview.candidateId, 'current');
  assert.equal(x.candidates.p[0].status, 'pending');
  assert.equal(x.candidates.p[0].importedReadOnly, true);
  x.adopt();
  await x.runner.reviewCompleted('owner', true, 'current');
  await x.finish();
});

test('a tool cannot route a foreign read-only candidate into an executable review gate', async t => {
  const x = await fixture(t);
  x.generate = async (_args, context) => {
    x.candidates.p.push({
      id: 'foreign',
      projectId: 'p',
      chapterId: 'chapter',
      runId: 'foreign-run',
      sessionId: context.sessionId,
      status: 'pending',
      importedReadOnly: true,
    });
    return JSON.stringify({
      resultKind: 'pending_review',
      projectId: 'p',
      chapterId: 'chapter',
      runId: 'foreign-run',
      candidateId: 'foreign',
    });
  };
  x.runner.start('owner', '创建候选');
  await x.finish();
  assert.equal(x.requests.length, 1);
  assert.equal(x.state.agentSessions.owner.pendingReview, undefined);
  assert.ok(
    x.state.agentSessions.owner.steps.some(
      s => s.role === 'error' && s.content.includes('外来候选仅供只读')
    )
  );
});

test('a late proof from a cancelled run cannot release a new run in the same conversation', async t => {
  const x = await fixture(t);
  x.runner.start('owner', '写第一章');
  await x.waitForReview();
  x.adopt();
  let release;
  x.readChapters = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const oldConfirmation = x.runner.reviewCompleted('owner', true, 'current');
  await until(() => !!release, 'old native proof');
  x.runner.stop();
  await x.finish();
  x.actions = [
    { action: 'generate_chapter', args: {} },
    { action: 'final', args: { message: '新任务完成' } },
  ];
  x.generate = async (_args, context) => {
    const next = {
      id: 'next-candidate',
      projectId: 'p',
      chapterId: 'chapter',
      runId: 'next-run',
      sessionId: context.sessionId,
      status: 'pending',
    };
    x.candidates.p.push(next);
    return JSON.stringify({
      resultKind: 'pending_review',
      projectId: 'p',
      chapterId: 'chapter',
      runId: next.runId,
      candidateId: next.id,
    });
  };
  x.runner.start('owner', '重新生成第二个候选');
  await x.waitForReview();
  assert.equal(x.state.agentSessions.owner.pendingReview.candidateId, 'next-candidate');
  release(structuredClone(x.chapters.p));
  await assert.rejects(oldConfirmation, /审核等待已变化/);
  assert.equal(x.requests.length, 2);
  assert.equal(x.state.agentStatus, 'awaiting_confirm');
  assert.equal(x.state.agentSessions.owner.pendingReview.candidateId, 'next-candidate');
  x.readChapters = undefined;
  x.adopt('next-candidate');
  await x.runner.reviewCompleted('owner', true, 'next-candidate');
  await x.finish();
  assert.equal(x.requests.length, 3);
});
