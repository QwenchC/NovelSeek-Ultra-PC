import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/backup/archive.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const codec = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const fixture = JSON.parse(await readFile('tests/fixtures/backup-cross-platform.json', 'utf8'));
const bridgeCompiled = await build({ entryPoints: ['src/backup/bridge.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const bridge = await import(`data:text/javascript;base64,${Buffer.from(bridgeCompiled.outputFiles[0].text).toString('base64')}`);
function assertDomainBridge(bundle) {
  const prepared = bridge.prepareBackupImport(bundle, { projects: [], charactersByProject: {}, writingWorkspaceByProject: {}, writingUsageByProject: {}, sceneWritingByProject: {}, generationRunsByProject: {}, agentSessions: {}, agentSessionMetrics: {}, backupExtensions: {} });
  const project = prepared.content.projects[0], chapter = prepared.content.chapters[0];
  assert.equal(project.id, 'interop-project'); assert.equal(project.title, '两端互通测试'); assert.equal(project.target_word_count, 30000);
  assert.equal(chapter.project_id, project.id); assert.equal(chapter.order_index, 3); assert.equal(chapter.outline_goal, '寻找线索');
  assert.equal(chapter.conflict, '不能暴露秘密'); assert.equal(chapter.twist, '残页指向故人'); assert.equal(chapter.cliffhanger, '守卫突然回头');
  assert.equal(chapter.word_count, 12); assert.equal(chapter.arc_id, 'interop-arc'); assert.equal(chapter.created_at, '2026-10-07T10:00:00Z');
  assert.equal(chapter.draft_text, '雪夜😀\n\n他找到了线索。'); assert.equal(chapter.final_text, '');
  assert.equal(JSON.parse(chapter.illustrations)[0].imageBase64, 'data:image/png;base64,QUJD');
}
test('shared fixture PC ZIP roundtrip and real artifact for Android', async () => {
  const blob = await codec.writeBackupZip(fixture);
  assert.deepEqual(await codec.readBackup(blob), fixture);
  assertDomainBridge(await codec.readBackup(blob));
  await mkdir('.cache/interoperability', { recursive: true });
  await writeFile('.cache/interoperability/pc-backup.zip', new Uint8Array(await blob.arrayBuffer()));
});
test('actual Android Java DEFLATED ZIP has the identical shared data', { skip: !process.env.NOVELSEEK_ANDROID_BACKUP_FIXTURE }, async () => {
  const bytes = await readFile(process.env.NOVELSEEK_ANDROID_BACKUP_FIXTURE);
  const decoded = await codec.readBackup(new Uint8Array(bytes));
  assert.deepEqual(decoded, fixture);
  assertDomainBridge(decoded);
});
