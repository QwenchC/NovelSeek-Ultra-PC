import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';
globalThis.crypto ??= webcrypto;
const compiled = await build({ entryPoints: ['src/backup/archive.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { readBackup, writeBackupZip, writeBackupJson } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const base = () => ({ version: 1, exportedAt: '2026-10-07T00:00:00Z', appVersion: '1.6.0', data: {
  projects: [{ id: 'p', title: '中文小说😀' }], chaptersByProject: { p: [{ id: 'c', title: '第一章', order_index: 0 }] },
  chapterBodies: { c: { draft: '草稿😀\n甲乙', final: '完整正文', futureBodyField: '保留' } },
  chapterIllustrations: { c: [{ id: 'i', imageBase64: 'aGVsbG8=', extra: { x: 1 } }] },
  sceneWritingByProject: { p: { version: 1, plans: [{ chapterId: 'c' }], checkpoints: [{ runId: 'r' }] } },
  writingWorkspaceByProject: { p: { version: 1, notes: [{ text: '伏笔' }], style: '古风' } },
  generationRunsByProject: { p: [{ id: 'g', candidates: [{ body: '候选正文' }] }] },
  agentSessions: { s: { id: 's', steps: [{ id: 'a', type: 'action', text: '{}', planId: 'plan-1' }], memory: { summary: '摘要' } } },
  unknownAndroidByProject: { p: { nested: [1, null, '😀'] } },
} });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
/** Independently constructs Java-style DEFLATE ZIPs with signed data descriptors. */
function zip(items, deflated = false) {
  const local = [], central = []; let offset = 0;
  for (const [name, source] of items) {
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source), path = Buffer.from(name);
    const body = deflated ? deflateRawSync(bytes) : bytes, flags = deflated ? 0x808 : 0x800, crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(deflated ? 8 : 0, 8); header.writeUInt16LE(path.length, 26);
    if (!deflated) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(bytes.length, 22); }
    const descriptor = Buffer.alloc(deflated ? 16 : 0);
    if (deflated) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(body.length, 8); descriptor.writeUInt32LE(bytes.length, 12); }
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(deflated ? 8 : 0, 10); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, path, body, descriptor); central.push(entry, path); offset += header.length + path.length + body.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([...local, directory, end]);
}
function archiveItems(bundle = base(), descriptors = []) {
  const bytes = Buffer.from(JSON.stringify(bundle));
  return [['manifest.json', JSON.stringify({ format: 'novelseek-backup', archiveVersion: 1, bundleVersion: 1, entries: [{ path: 'backup.json', bytes: bytes.length, sha256: hash(bytes), jsonPath: null }, ...descriptors] })], ['backup.json', bytes]];
}
test('v1 split ZIP fully round-trips Unicode, scene archives, images and unknown extensions', async () => {
  const bundle = base(), blob = await writeBackupZip(bundle);
  assert.deepEqual(await readBackup(blob), bundle);
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.subarray(30, 43).toString(), 'manifest.json');
  const manifestLength = bytes.readUInt32LE(22), manifest = JSON.parse(bytes.subarray(43, 43 + manifestLength));
  assert.equal(manifest.format, 'novelseek-backup');
  assert.ok(manifest.entries.some(d => d.jsonPath?.join('.') === 'data.sceneWritingByProject.p.checkpoints.0'));
  assert.ok(manifest.entries.some(d => d.jsonPath?.join('.') === 'data.chapterBodies.c'));
});
test('Android/Java DEFLATE ZIP with signed descriptors is supported', async () => {
  assert.deepEqual(await readBackup(zip(archiveItems(), true)), base());
});
test('legacy JSON and UTF8 BOM are supported; invalid version and UTF8 are rejected', async () => {
  assert.deepEqual(await readBackup(writeBackupJson(base())), base());
  assert.deepEqual(await readBackup(new Blob(['\ufeff', JSON.stringify(base())])), base());
  await assert.rejects(readBackup(new Blob([JSON.stringify({ ...base(), version: 2 })])), /版本/);
  await assert.rejects(readBackup(new Uint8Array([0xff, 0xfe, 0xfa])), /UTF-8/);
});
test('changed content with a valid CRC is still rejected by SHA256 before returning', async () => {
  const items = archiveItems(); items[1][1] = Buffer.from(JSON.stringify({ ...base(), exportedAt: 'tampered' }));
  await assert.rejects(readBackup(zip(items)), /大小不一致|SHA-256/);
  const sameLength = archiveItems(); sameLength[1][1] = Buffer.from(sameLength[1][1].toString().replace('完整正文', '恶意内容'));
  await assert.rejects(readBackup(zip(sameLength)), /SHA-256/);
});
test('duplicate, traversal, extra, local-header disagreement and truncated ZIP are rejected', async () => {
  const items = archiveItems();
  await assert.rejects(readBackup(zip([...items, ['backup.json', '{}']])), /重复/);
  await assert.rejects(readBackup(zip([...items, ['../evil.json', '{}']])), /路径/);
  await assert.rejects(readBackup(zip([...items, ['attachments/000001.json', '{}']])), /数量/);
  const valid = Buffer.from(await zip(items).arrayBuffer()), bad = Buffer.from(valid); bad[30] = 'x'.charCodeAt(0);
  await assert.rejects(readBackup(bad), /路径/);
  await assert.rejects(readBackup(valid.subarray(0, valid.length - 5)), /目录/);
});
test('input, entry, total and entry-count limits are enforced on reads and writes', async () => {
  const bundle = base(), blob = await writeBackupZip(bundle);
  await assert.rejects(readBackup(blob, { maxInputBytes: blob.size - 1 }), /输入/);
  await assert.rejects(readBackup(blob, { maxEntryBytes: 5 }), /单项/);
  await assert.rejects(readBackup(blob, { maxTotalBytes: 100, maxEntryBytes: 100 }), /单项|总/);
  await assert.rejects(readBackup(blob, { maxEntries: 2 }), /数量/);
  await assert.rejects(writeBackupZip(bundle, { maxEntries: 2 }), /数量/);
  await assert.rejects(writeBackupZip(bundle, { maxEntryBytes: 10 }), /单项/);
  await assert.rejects(writeBackupZip(bundle, { maxInputBytes: 10 }), /大小/);
  assert.throws(() => writeBackupJson(bundle, { maxInputBytes: 10 }), /大小/);
});
test('manifest versions, missing payloads and malformed digests are rejected', async () => {
  const items = archiveItems(), manifest = JSON.parse(items[0][1]); manifest.archiveVersion = 2; items[0][1] = JSON.stringify(manifest);
  await assert.rejects(readBackup(zip(items)), /版本/);
  const digestItems = archiveItems(), digestManifest = JSON.parse(digestItems[0][1]); digestManifest.entries[0].sha256 = 'wrong'; digestItems[0][1] = JSON.stringify(digestManifest);
  await assert.rejects(readBackup(zip(digestItems)), /清单/);
});
test('attachment pointer collisions and non-null targets are rejected', async () => {
  const bytes = Buffer.from('"body"'), d = { path: 'attachments/000001.json', bytes: bytes.length, sha256: hash(bytes), jsonPath: ['data', 'chapterBodies', 'c'] };
  await assert.rejects(readBackup(zip([...archiveItems(base(), [d]), [d.path, bytes]])), /空占位/);
  const nested = { ...d, path: 'attachments/000002.json', jsonPath: [...d.jsonPath, 'draft'] };
  await assert.rejects(readBackup(zip([...archiveItems(base(), [d, nested]), [d.path, bytes], [nested.path, bytes]])), /覆盖/);
});
test('deflate bombs cannot bypass declared entry size', async () => {
  const items = archiveItems({ ...base(), data: { body: 'a'.repeat(1_000_000) } });
  const manifest = JSON.parse(items[0][1]); manifest.entries[0].bytes = 2; items[0][1] = JSON.stringify(manifest);
  const raw = Buffer.from(await zip(items, true).arrayBuffer());
  // Alter the final entry's central size and matching data-descriptor size, retaining compression.
  const end = raw.length - 22, central = raw.readUInt32LE(end + 16), second = central + 46 + Buffer.byteLength('manifest.json');
  raw.writeUInt32LE(2, second + 24);
  const local = raw.readUInt32LE(second + 42), dataOffset = local + 30 + raw.readUInt16LE(local + 26), compressed = raw.readUInt32LE(second + 20);
  raw.writeUInt32LE(2, dataOffset + compressed + 12);
  await assert.rejects(readBackup(raw), /解压/);
});
