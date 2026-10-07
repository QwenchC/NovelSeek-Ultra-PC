import { Inflate } from 'fflate';

/** Android BackupArchiveCodec v1 wire protocol. No files are extracted to disk. */
export interface BackupBundle {
  version: 1;
  exportedAt: string;
  appVersion?: string | null;
  data: Record<string, unknown>;
}
export interface ArchiveLimits {
  maxEntryBytes: number; maxTotalBytes: number; maxInputBytes: number; maxEntries: number;
}
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: MAX_ARCHIVE_BYTES,
  maxInputBytes: MAX_ARCHIVE_BYTES, maxEntries: 50_000,
};
interface Descriptor { path: string; bytes: number; sha256: string; jsonPath: string[] | null }
interface Payload { path: string; value: unknown; jsonPath: string[] | null }
interface ZipEntry { path: string; flags: number; method: number; crc: number; size: number; compressed: number; offset: number; dataOffset?: number }
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const attachments = new Set(['chapterBodies', 'chapterIllustrations', 'novelChats', 'agentSessions',
  'coversByProject', 'coverImagesByProject', 'promoByChapter', 'generationRuns',
  'generationRunsByProject', 'chapterGenerationRunsByProject', 'sceneWritingByProject',
  'sceneWritingPlansByProject', 'writingWorkspaceByProject']);
const nestedMaps = new Set(['generationRuns', 'generationRunsByProject', 'chapterGenerationRunsByProject',
  'sceneWritingByProject', 'sceneWritingPlansByProject', 'writingWorkspaceByProject']);
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(message: string): never { throw new Error(`备份校验失败：${message}`); }
function limitsOf(overrides: Partial<ArchiveLimits>): ArchiveLimits {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) fail('大小或数量上限无效');
  if (limits.maxInputBytes > MAX_ARCHIVE_BYTES || limits.maxTotalBytes > MAX_ARCHIVE_BYTES ||
      limits.maxEntryBytes > limits.maxTotalBytes || limits.maxEntries < 2 || limits.maxEntries > 50_000) fail('大小或数量上限无效');
  return limits;
}
export function validateBundle(value: unknown): BackupBundle {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.data) || typeof value.exportedAt !== 'string' ||
      (value.appVersion != null && typeof value.appVersion !== 'string')) fail('不支持的备份格式或版本');
  return value as unknown as BackupBundle;
}
function validatePath(path: string): void {
  if (path !== 'manifest.json' && path !== 'backup.json' && !/^attachments\/[0-9]{6}\.json$/.test(path)) fail('不安全或不支持的 ZIP 路径');
}
function encoded(value: unknown, maximum: number): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length < 1 || bytes.length > maximum) fail('单项大小超过上限');
  return bytes;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bufferPart(bytes));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function bufferPart(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return new Uint8Array(bytes).buffer;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function split(bundle: BackupBundle, maxEntries: number): Payload[] {
  const parts: Payload[] = [];
  const detach = (value: unknown, jsonPath: string[]) => {
    if (jsonPath.some(segment => segment.length > 1000)) fail('附件 JSON 路径过长');
    if (parts.length + 3 > maxEntries) fail('文件项数量超过上限');
    parts.push({ path: `attachments/${String(parts.length + 1).padStart(6, '0')}.json`, value, jsonPath });
    return null;
  };
  const data: Record<string, unknown> = Object.create(null);
  for (const [field, value] of Object.entries(bundle.data)) {
    if (!attachments.has(field)) { data[field] = value; continue; }
    if (Array.isArray(value)) { data[field] = value.map((item, i) => detach(item, ['data', field, String(i)])); continue; }
    if (!isRecord(value)) { data[field] = value; continue; }
    const map: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      const path = ['data', field, key];
      if (Array.isArray(child)) map[key] = child.map((item, i) => detach(item, [...path, String(i)]));
      else if (isRecord(child) && nestedMaps.has(field)) {
        const nested: Record<string, unknown> = Object.create(null);
        for (const [id, item] of Object.entries(child)) {
          const nestedPath = [...path, id];
          if (field === 'sceneWritingByProject' && Array.isArray(item)) nested[id] = item.map((scene, i) => detach(scene, [...nestedPath, String(i)]));
          else if (field === 'sceneWritingByProject' && isRecord(item)) nested[id] = Object.fromEntries(Object.entries(item).map(([k, checkpoint]) => [k, detach(checkpoint, [...nestedPath, k])]));
          else nested[id] = detach(item, nestedPath);
        }
        map[key] = nested;
      } else map[key] = detach(child, path);
    }
    data[field] = map;
  }
  return [{ path: 'backup.json', value: { ...bundle, data }, jsonPath: null }, ...parts];
}

/** STORED ZIP is accepted by Android; per-item serialization avoids a second all-book JSON string. */
export async function writeBackupZip(bundle: BackupBundle, overrides: Partial<ArchiveLimits> = {}): Promise<Blob> {
  validateBundle(bundle);
  const limits = limitsOf(overrides);
  const payloads = split(bundle, limits.maxEntries);
  const bodies: Uint8Array[] = [];
  const descriptors: Descriptor[] = [];
  let total = 0;
  for (const payload of payloads) {
    const bytes = encoded(payload.value, limits.maxEntryBytes);
    total += bytes.length; if (total > limits.maxTotalBytes) fail('总解压大小超过上限');
    bodies.push(bytes); descriptors.push({ path: payload.path, bytes: bytes.length, sha256: await sha256(bytes), jsonPath: payload.jsonPath });
  }
  const manifest = encoded({ format: 'novelseek-backup', archiveVersion: 1, bundleVersion: 1, entries: descriptors }, limits.maxEntryBytes);
  if (total + manifest.length > limits.maxTotalBytes) fail('总解压大小超过上限');
  return storedZip(['manifest.json', ...payloads.map(p => p.path)], [manifest, ...bodies], limits.maxInputBytes);
}
function storedZip(names: string[], bodies: Uint8Array[], maximum: number): Blob {
  const local: BlobPart[] = []; const central: Uint8Array[] = []; let offset = 0;
  names.forEach((name, i) => {
    const path = encoder.encode(name), body = bodies[i], crc = crc32(body);
    const header = new Uint8Array(30 + path.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, body.length, true);
    h.setUint16(26, path.length, true); header.set(path, 30);
    const directory = new Uint8Array(46 + path.length), d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true);
    d.setUint32(16, crc, true); d.setUint32(20, body.length, true); d.setUint32(24, body.length, true);
    d.setUint16(28, path.length, true); d.setUint32(42, offset, true); directory.set(path, 46);
    local.push(header, bufferPart(body)); central.push(directory); offset += header.length + body.length;
  });
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, names.length, true); e.setUint16(10, names.length, true);
  e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  if (offset + centralSize + end.length > maximum) fail('ZIP 文件大小超过上限');
  return new Blob([...local, ...central.map(bufferPart), end], { type: 'application/zip' });
}
export function writeBackupJson(bundle: BackupBundle, overrides: Partial<ArchiveLimits> = {}): Blob {
  validateBundle(bundle); const limits = limitsOf(overrides);
  return new Blob([bufferPart(encoded(bundle, Math.min(limits.maxInputBytes, limits.maxTotalBytes)))], { type: 'application/json' });
}
async function bytesAt(blob: Blob, start: number, size: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > blob.size) fail('ZIP 文件被截断');
  return new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
}
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, '')); }
  catch { return fail('JSON 或 UTF-8 内容无效'); }
}
/** Uses the central directory (Android writes data descriptors), then checks every local header. */
async function zipEntries(blob: Blob, limits: ArchiveLimits): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, blob.size - 65_557), tail = await bytesAt(blob, tailStart, blob.size - tailStart);
  const t = new DataView(tail.buffer); let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (t.getUint32(i, true) === 0x06054b50 && i + 22 + t.getUint16(i + 20, true) === tail.length) { end = i; break; }
  if (end < 0) fail('缺少 ZIP 中央目录');
  const count = t.getUint16(end + 10, true), size = t.getUint32(end + 12, true), offset = t.getUint32(end + 16, true);
  if (t.getUint16(end + 4, true) || t.getUint16(end + 6, true) || t.getUint16(end + 8, true) !== count ||
      count < 2 || count > limits.maxEntries || offset + size !== tailStart + end) fail('ZIP 数量、目录或分卷格式无效');
  const entries: ZipEntry[] = [], paths = new Set<string>(); let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > size) fail('ZIP 中央目录无效');
    // Read only one header/name at a time: malicious huge directory extras never get buffered.
    const header = await bytesAt(blob, offset + cursor, 46), c = new DataView(header.buffer);
    if (c.getUint32(0, true) !== 0x02014b50) fail('ZIP 中央目录无效');
    const nameLength = c.getUint16(28, true), extraLength = c.getUint16(30, true), commentLength = c.getUint16(32, true);
    if (cursor + 46 + nameLength + extraLength + commentLength > size) fail('ZIP 目录被截断');
    if (nameLength > 24) fail('ZIP 路径过长');
    const path = decoder.decode(await bytesAt(blob, offset + cursor + 46, nameLength)); validatePath(path);
    if (paths.has(path)) fail('ZIP 含重复路径'); paths.add(path);
    const flags = c.getUint16(8, true), method = c.getUint16(10, true);
    if (flags & ~0x080e || (method !== 0 && method !== 8) || c.getUint16(34, true) !== 0) fail('不支持加密、分卷或 ZIP 压缩算法');
    const entry: ZipEntry = { path, flags, method, crc: c.getUint32(16, true), compressed: c.getUint32(20, true), size: c.getUint32(24, true), offset: c.getUint32(42, true) };
    if (entry.size < 1 || entry.size > limits.maxEntryBytes || entry.compressed > limits.maxInputBytes) fail('单项声明大小超过上限');
    entries.push(entry); cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== size) fail('ZIP 中央目录含额外数据');
  entries.sort((a, b) => a.offset - b.offset);
  if (entries[0].path !== 'manifest.json' || entries[0].offset !== 0) fail('ZIP 首项必须是 manifest.json');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], local = await bytesAt(blob, entry.offset, 30), l = new DataView(local.buffer);
    if (l.getUint32(0, true) !== 0x04034b50 || l.getUint16(6, true) !== entry.flags || l.getUint16(8, true) !== entry.method) fail('ZIP 本地文件头不一致');
    const nameLength = l.getUint16(26, true), extraLength = l.getUint16(28, true);
    if (decoder.decode(await bytesAt(blob, entry.offset + 30, nameLength)) !== entry.path) fail('ZIP 本地路径不一致');
    entry.dataOffset = entry.offset + 30 + nameLength + extraLength;
    const bodyEnd = entry.dataOffset + entry.compressed, nextOffset = entries[i + 1]?.offset ?? offset;
    if (bodyEnd > nextOffset) fail('ZIP 项重叠');
    if (entry.flags & 8) {
      const descriptorSize = nextOffset - bodyEnd;
      if (descriptorSize !== 12 && descriptorSize !== 16) fail('ZIP 数据描述符大小无效');
      const descriptor = await bytesAt(blob, bodyEnd, descriptorSize), d = new DataView(descriptor.buffer), begin = descriptorSize === 16 ? 4 : 0;
      if ((begin && d.getUint32(0, true) !== 0x08074b50) || d.getUint32(begin, true) !== entry.crc || d.getUint32(begin + 4, true) !== entry.compressed || d.getUint32(begin + 8, true) !== entry.size) fail('ZIP 数据描述符不一致');
    } else if (bodyEnd !== nextOffset || l.getUint32(14, true) !== entry.crc || l.getUint32(18, true) !== entry.compressed || l.getUint32(22, true) !== entry.size) fail('ZIP 文件头大小不一致');
  }
  return entries;
}
async function readEntry(blob: Blob, entry: ZipEntry, maximum: number): Promise<Uint8Array> {
  const expected = Math.min(maximum, entry.size); let used = 0;
  const chunks: Uint8Array[] = [];
  const accept = (chunk: Uint8Array) => {
    if (chunk.length > expected - used) fail('单项解压大小超过声明或上限');
    used += chunk.length; if (chunk.length) chunks.push(chunk);
  };
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) fail('STORED 项大小无效');
    accept(await bytesAt(blob, entry.dataOffset!, entry.compressed));
  } else {
    // Small input chunks bound temporary inflater allocations even for highly compressed bombs.
    const inflate = new Inflate(accept);
    for (let cursor = 0; cursor < entry.compressed; cursor += 1024) {
      const count = Math.min(1024, entry.compressed - cursor);
      inflate.push(await bytesAt(blob, entry.dataOffset! + cursor, count), cursor + count === entry.compressed);
    }
    if (!entry.compressed) fail('空的 DEFLATE 数据');
  }
  if (used !== entry.size) fail('解压大小与声明不一致');
  const bytes = new Uint8Array(used); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (crc32(bytes) !== entry.crc) fail('ZIP CRC 校验失败');
  return bytes;
}
interface PatchNode { children: Map<string, PatchNode>; hasValue: boolean; value?: unknown }
function addPointer(root: PatchNode, pointer: string[]): PatchNode {
  let node = root;
  for (const key of pointer) {
    if (node.hasValue) fail('附件 JSON 路径相互覆盖');
    let child = node.children.get(key);
    if (!child) { child = { children: new Map(), hasValue: false }; node.children.set(key, child); }
    node = child;
  }
  if (node.hasValue || node.children.size) fail('附件 JSON 路径重复或相互覆盖');
  node.hasValue = true; return node;
}
function restore(value: unknown, node: PatchNode): unknown {
  if (node.hasValue) { if (value !== null) fail('附件目标不是空占位'); return node.value; }
  for (const [key, child] of node.children) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= value.length) fail('附件数组索引无效');
      value[Number(key)] = restore(value[Number(key)], child);
    } else if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)) {
      Object.defineProperty(value, key, { value: restore(value[key], child), enumerable: true, configurable: true, writable: true });
    } else fail('附件 JSON 路径不存在');
  }
  return value;
}
/** Reads ZIP and old UTF-8 JSON, including BOM. Nothing is returned until all hashes pass. */
export async function readBackup(input: Blob | Uint8Array, overrides: Partial<ArchiveLimits> = {}): Promise<BackupBundle> {
  const limits = limitsOf(overrides), blob = input instanceof Blob ? input : new Blob([bufferPart(input)]);
  if (!blob.size || blob.size > limits.maxInputBytes) fail('输入文件为空或超过上限');
  const signature = await bytesAt(blob, 0, Math.min(4, blob.size));
  if (signature[0] !== 80 || signature[1] !== 75) {
    if (blob.size > limits.maxTotalBytes) fail('JSON 大小超过上限');
    return validateBundle(parseJson(await bytesAt(blob, 0, blob.size)));
  }
  const entries = await zipEntries(blob, limits);
  const manifestBytes = await readEntry(blob, entries[0], limits.maxEntryBytes), manifest = parseJson(manifestBytes);
  if (!isRecord(manifest) || manifest.format !== 'novelseek-backup' || manifest.archiveVersion !== 1 || manifest.bundleVersion !== 1 || !Array.isArray(manifest.entries)) fail('不支持的 ZIP 格式或版本');
  if (manifest.entries.length + 1 !== entries.length) fail('清单和文件项数量不一致');
  const expected = new Map<string, Descriptor>(), pointers = new Map<string, PatchNode>();
  const root: PatchNode = { children: new Map(), hasValue: false }; let total = manifestBytes.length;
  for (const raw of manifest.entries) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || !Number.isSafeInteger(raw.bytes) || typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) fail('清单描述无效');
    validatePath(raw.path);
    if (raw.path === 'manifest.json' || expected.has(raw.path)) fail('清单含重复路径');
    if ((raw.bytes as number) < 1 || (raw.bytes as number) > limits.maxEntryBytes) fail('单项声明大小超过上限');
    total += raw.bytes as number; if (total > limits.maxTotalBytes) fail('总解压大小超过上限');
    if (raw.path === 'backup.json') { if (raw.jsonPath != null) fail('backup.json 不能作为附件'); }
    else {
      if (!Array.isArray(raw.jsonPath) || raw.jsonPath.length < 3 || raw.jsonPath.length > 8 || raw.jsonPath[0] !== 'data' || raw.jsonPath.some(k => typeof k !== 'string' || k.length > 1000)) fail('附件 JSON 路径无效');
      pointers.set(raw.path, addPointer(root, raw.jsonPath));
    }
    expected.set(raw.path, raw as unknown as Descriptor);
  }
  if (!expected.has('backup.json')) fail('缺少 backup.json');
  let base: unknown;
  for (const entry of entries.slice(1)) {
    const descriptor = expected.get(entry.path);
    if (!descriptor || entry.size !== descriptor.bytes) fail('清单外文件项或大小不一致');
    const bytes = await readEntry(blob, entry, descriptor.bytes);
    if (await sha256(bytes) !== descriptor.sha256) fail(`SHA-256 不一致：${entry.path}`);
    const value = parseJson(bytes);
    if (entry.path === 'backup.json') base = value;
    else pointers.get(entry.path)!.value = value;
  }
  return validateBundle(restore(base, root));
}
