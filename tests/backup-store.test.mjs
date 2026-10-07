import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const disk = new Map(), writes = [];
let failWrites = false, blockedValue = null, unblock = null;
const database = {
  createObjectStore() {},
  transaction(_store, mode) {
    const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
    tx.objectStore = () => ({
      get(key) { const request = { result: disk.get(key), onsuccess: null, onerror: null }; queueMicrotask(() => request.onsuccess?.()); return request; },
      put(value, key) {
        assert.equal(mode, 'readwrite'); writes.push(JSON.parse(value));
        const finish = () => queueMicrotask(() => {
          if (failWrites) { tx.error = new Error('IDB_QUOTA'); tx.onabort?.(); }
          else { disk.set(key, value); tx.oncomplete?.(); }
        });
        if (blockedValue && JSON.parse(value).state.worldSettingByProject?.p === blockedValue) unblock = finish;
        else finish();
      },
      delete(key) { disk.delete(key); queueMicrotask(() => tx.oncomplete?.()); },
    });
    return tx;
  },
};
globalThis.indexedDB = { open() {
  const request = { result: database, onupgradeneeded: null, onsuccess: null, onerror: null };
  queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); }); return request;
} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// Existing v13 settings and user data must survive the additive migration.
disk.set('novelseek-storage', JSON.stringify({ version: 13, state: { theme: 'dark',
  worldSettingByProject: { old: '历史世界观' }, agentMaxSteps: 77,
  textModelConfig: { provider: 'custom', apiKey: 'existing-private-key', apiUrl: 'https://example.test/v1', model: 'local-model', temperature: 0.4 } } }));
const compiled = await build({ entryPoints: ['src/store/index.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const runtime = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), runtime, runtime.exports);
const { useAppStore, flushWritingPersistence, persistImportedBackupMetadata } = runtime.exports;
if (!useAppStore.persist.hasHydrated()) await new Promise(resolve => { const stop = useAppStore.persist.onFinishHydration(() => { stop(); resolve(); }); });
const stored = () => JSON.parse(disk.get('novelseek-storage')).state;
test('additive v14 migration preserves v13 user settings and initializes interoperable archives', () => {
  const state = useAppStore.getState(); assert.equal(state.theme, 'dark'); assert.equal(state.agentMaxSteps, 77);
  assert.equal(state.textModelConfig.apiKey, 'existing-private-key'); assert.equal(state.worldSettingByProject.old, '历史世界观');
  assert.deepEqual(state.writingWorkspaceByProject, {}); assert.deepEqual(state.sceneWritingByProject, {});
  assert.equal(state.agentEngine, 'legacy'); assert.equal(state.agentContextBudget, 32000);
});
test('strict writing flush persists current checkpoint immediately rather than waiting for debounce', async () => {
  useAppStore.setState({ sceneWritingByProject: { p: { version: 1, plans: [], checkpoints: [] } } });
  await flushWritingPersistence(); assert.equal(stored().sceneWritingByProject.p.version, 1);
  assert.ok(writes.length); assert.equal(JSON.parse(disk.get('novelseek-storage')).version, 14);
});
test('strict writing flush surfaces abort/quota failures instead of reporting a durable checkpoint', async () => {
  const previous = disk.get('novelseek-storage'); failWrites = true;
  useAppStore.setState({ worldSettingByProject: { p: 'unsaved' } });
  await assert.rejects(flushWritingPersistence(), /IDB_QUOTA/); assert.equal(disk.get('novelseek-storage'), previous);
  failWrites = false;
});
test('import publishes metadata only after durable IDB write and cannot be overwritten by an older queued snapshot', async () => {
  useAppStore.setState({ worldSettingByProject: { p: 'before-import' } });
  const prior = flushWritingPersistence();
  blockedValue = 'after-import';
  const importing = persistImportedBackupMetadata({ worldSettingByProject: { p: 'after-import' }, backupExtensions: { unknownAndroidByProject: { p: { future: true } } } });
  await prior;
  for (let i = 0; i < 20 && !unblock; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(unblock); assert.equal(useAppStore.getState().worldSettingByProject.p, 'before-import');
  blockedValue = null; unblock(); unblock = null; await importing;
  assert.equal(useAppStore.getState().worldSettingByProject.p, 'after-import');
  assert.equal(stored().worldSettingByProject.p, 'after-import'); assert.equal(stored().backupExtensions.unknownAndroidByProject.p.future, true);
  await flushWritingPersistence(); assert.equal(stored().worldSettingByProject.p, 'after-import');
});
test('import metadata failure leaves live state intact for native-journal retry', async () => {
  await flushWritingPersistence(); const before = useAppStore.getState().worldSettingByProject;
  failWrites = true;
  await assert.rejects(persistImportedBackupMetadata({ worldSettingByProject: { p: 'must-not-publish' } }), /IDB_QUOTA/);
  assert.equal(useAppStore.getState().worldSettingByProject, before); failWrites = false;
  await persistImportedBackupMetadata({ worldSettingByProject: { p: 'recovered' } });
  assert.equal(stored().worldSettingByProject.p, 'recovered');
  await flushWritingPersistence();
});
