import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const mockPlugin = { name: 'backup-runtime-mocks', setup(builder) {
  builder.onResolve({ filter: /^(\.\.\/store|\.\.\/services\/api|\.\.\/writingUi\/workspaceRuntime|@tauri-apps\/api\/tauri)$/ }, args => ({ path: args.path, namespace: 'backup-mock' }));
  builder.onLoad({ filter: /.*/, namespace: 'backup-mock' }, args => ({ contents: args.path.includes('workspaceRuntime')
    ? 'export function hasActiveWorkspaceTasks(){return globalThis.backupMock.workspaceActive;}'
    : args.path.includes('/api') && !args.path.includes('tauri')
    ? 'export const projectApi={getAll:async()=>globalThis.backupMock.projects};'
    : args.path.includes('tauri')
    ? 'export function invoke(name,args){return globalThis.backupMock.invoke(name,args);}'
    : `export const useAppStore={getState:()=>globalThis.backupMock.state,setState:p=>Object.assign(globalThis.backupMock.state,p),persist:{hasHydrated:()=>true,onFinishHydration:()=>()=>{}}};
       export function persistImportedBackupMetadata(p){return globalThis.backupMock.persist(p);}`,
    loader: 'js' }));
} };
const compiled = await build({ entryPoints: ['src/backup/service.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [mockPlugin] });
const { importBackupAtomically, recoverPendingBackupMetadata } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const bundle = () => ({ version: 1, exportedAt: '', appVersion: '1.6.0', data: {
  projects: [{ id: 'p', title: '导入小说' }], chaptersByProject: { p: [{ id: 'c', title: '章节', order_index: 0 }] },
  chapterBodies: { c: { draft: '完整草稿', final: '完整正文' } }, worldSettingByProject: { p: '备份世界观' },
} });
function reset(options = {}) {
  const mock = { options, trace: [], workspaceActive: false, pending: null, projects: [],
    state: { projects: [], agentStatus: 'idle', isGenerating: false, backupImportPending: false, chaptersVersion: 0, worldSettingByProject: { local: '本机设置' }, backupExtensions: {} },
    async invoke(name, args) {
      this.trace.push(name);
      if (name === 'get_pending_backup_metadata') return this.pending;
      if (name === 'import_backup_atomic') {
        if (this.options.atomicFailure) throw new Error('SQLITE_TRANSACTION_FAILED');
        if (this.pending) throw new Error('PENDING_IMPORT');
        this.projects = args.request.projects;
        this.pending = { revision: 'revision-1', metadataJson: args.request.metadataJson };
        return { revision: 'revision-1', importedProjects: this.projects.length, importedChapters: args.request.chapters.length };
      }
      if (name === 'ack_backup_metadata') {
        if (this.options.ackFailure) throw new Error('ACK_FAILED');
        assert.equal(args.revision, this.pending.revision); this.pending = null; return;
      }
      throw new Error(`Unexpected invoke ${name}`);
    },
    async persist(patch) {
      this.trace.push('persist-idb');
      assert.ok(this.pending, 'metadata can publish only after native transaction and journal');
      if (this.options.metadataFailure) throw new Error('IDB_QUOTA');
      Object.assign(this.state, patch);
    },
  };
  globalThis.backupMock = mock; return mock;
}
test('content transaction precedes durable metadata, which precedes journal acknowledgement', async () => {
  const mock = reset(), result = await importBackupAtomically(bundle());
  assert.deepEqual(mock.trace, ['import_backup_atomic', 'persist-idb', 'ack_backup_metadata']);
  assert.equal(result.importedChapters, 1); assert.equal(mock.pending, null);
  assert.equal(mock.state.backupImportPending, false); assert.equal(mock.state.worldSettingByProject.p, '备份世界观');
  assert.equal(mock.state.worldSettingByProject.local, '本机设置');
});
test('failed SQLite transaction leaves both metadata and active-import guard unchanged', async () => {
  const mock = reset({ atomicFailure: true });
  await assert.rejects(importBackupAtomically(bundle()), /SQLITE/);
  assert.deepEqual(mock.trace, ['import_backup_atomic']); assert.equal(mock.pending, null);
  assert.deepEqual(mock.state.worldSettingByProject, { local: '本机设置' }); assert.equal(mock.state.backupImportPending, false);
});
test('IDB failure retains native recovery journal, blocks repeated import and recovers idempotently', async () => {
  const mock = reset({ metadataFailure: true });
  await assert.rejects(importBackupAtomically(bundle()), /待恢复/);
  assert.ok(mock.pending); assert.equal(mock.state.backupImportPending, true);
  assert.equal(mock.state.worldSettingByProject.p, undefined);
  await assert.rejects(importBackupAtomically(bundle()), /尚未恢复/);
  mock.options.metadataFailure = false;
  assert.equal(await recoverPendingBackupMetadata(), true);
  assert.equal(mock.pending, null); assert.equal(mock.state.backupImportPending, false); assert.equal(mock.state.worldSettingByProject.p, '备份世界观');
  assert.equal(await recoverPendingBackupMetadata(), false);
});
test('acknowledgement failure retains the journal even after metadata publication', async () => {
  const mock = reset({ ackFailure: true });
  await assert.rejects(importBackupAtomically(bundle()), /待恢复/);
  assert.ok(mock.pending); assert.equal(mock.state.worldSettingByProject.p, '备份世界观');
  mock.options.ackFailure = false;
  await recoverPendingBackupMetadata(); assert.equal(mock.pending, null); assert.equal(mock.state.backupImportPending, false);
});
test('running, waiting-for-user and workbench tasks block import before native mutation', async () => {
  for (const status of ['running', 'awaiting_user', 'awaiting_confirm']) {
    const mock = reset(); mock.state.agentStatus = status;
    await assert.rejects(importBackupAtomically(bundle()), /结束/); assert.deepEqual(mock.trace, []);
  }
  const mock = reset(); mock.workspaceActive = true;
  await assert.rejects(importBackupAtomically(bundle()), /工作台/); assert.deepEqual(mock.trace, []);
});
test('corrupted/prototype-changing recovery metadata is rejected and not acknowledged', async () => {
  const mock = reset(); mock.pending = { revision: 'r', metadataJson: '{"format":"novelseek-desktop-metadata","version":1,"patch":{"__proto__":{"polluted":true}}}' };
  await assert.rejects(recoverPendingBackupMetadata(), /不允许/);
  assert.ok(mock.pending); assert.equal({}.polluted, undefined); assert.deepEqual(mock.trace, ['get_pending_backup_metadata']);
});
