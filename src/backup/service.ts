import { invoke } from '@tauri-apps/api/tauri';
import { useAppStore, persistImportedBackupMetadata } from '../store';
import { projectApi } from '../services/api';
import { isRecord, type BackupBundle } from './archive';
import { prepareBackupImport } from './bridge';

interface PendingMetadata { revision: string; metadataJson: string }
interface ImportResult { revision: string; importedProjects: number; importedChapters: number }
interface MetadataJournal { format: 'novelseek-desktop-metadata'; version: 1; patch: Record<string, unknown> }
function stateRecord(): Record<string, unknown> { return useAppStore.getState() as unknown as Record<string, unknown>; }
function parseJournal(serialized: string): MetadataJournal {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || value.format !== 'novelseek-desktop-metadata' || value.version !== 1 || !isRecord(value.patch)) throw new Error('导入恢复日志格式无效，请保留原始备份后联系支持');
  // Native journal is local trusted output, but refuse it overriding store methods/runtime status.
  for (const [key, item] of Object.entries(value.patch)) {
    const current = stateRecord()[key];
    if (['__proto__', 'constructor', 'prototype'].includes(key) || typeof current === 'function' || key === 'backupImportPending' || key === 'agentStatus' || key === 'agentRunSessionId' || key === 'agentPendingConfirm' || typeof item === 'function') throw new Error('导入恢复日志包含不允许的字段');
  }
  return value as unknown as MetadataJournal;
}
let recovery: Promise<boolean> | null = null;
export function recoverPendingBackupMetadata(): Promise<boolean> {
  if (recovery) return recovery;
  recovery = (async () => {
    if (!useAppStore.persist.hasHydrated()) await new Promise<void>(resolve => {
      const unsubscribe = useAppStore.persist.onFinishHydration(() => { unsubscribe(); resolve(); });
      if (useAppStore.persist.hasHydrated()) { unsubscribe(); resolve(); }
    });
    const pending = await invoke<PendingMetadata | null>('get_pending_backup_metadata');
    if (!pending) return false;
    useAppStore.setState({ backupImportPending: true });
    const journal = parseJournal(pending.metadataJson);
    await persistImportedBackupMetadata(journal.patch);
    await invoke<void>('ack_backup_metadata', { revision: pending.revision });
    useAppStore.setState({ backupImportPending: false });
    return true;
  })().finally(() => { recovery = null; });
  return recovery;
}
/** Content and metadata journal first commit in ONE SQLite transaction; then durable IDB; then ack. */
export async function importBackupAtomically(bundle: BackupBundle, includePcSettings = false): Promise<ImportResult> {
  const active = useAppStore.getState();
  if (active.backupImportPending) throw new Error('上次导入的元数据尚未恢复，请先重试恢复');
  if (active.agentStatus !== 'idle' || active.isGenerating) throw new Error('请先结束运行中或等待确认的智能体/写作任务，再导入备份');
  const workspaceRuntime = await import('../writingUi/workspaceRuntime');
  if (workspaceRuntime.hasActiveWorkspaceTasks()) throw new Error('请先暂停正在运行的写作工作台任务，再导入备份');
  const current = useAppStore.getState();
  if (current.backupImportPending || current.agentStatus !== 'idle' || current.isGenerating) throw new Error('任务状态已变化，请先结束任务或完成上次导入');
  const prepared = prepareBackupImport(bundle, stateRecord(), includePcSettings);
  const journal: MetadataJournal = { format: 'novelseek-desktop-metadata', version: 1, patch: prepared.metadata };
  useAppStore.setState({ backupImportPending: true });
  let committed = false;
  let finalized = false;
  try {
    const result = await invoke<ImportResult>('import_backup_atomic', { request: { ...prepared.content, metadataJson: JSON.stringify(journal) } });
    committed = true;
    await persistImportedBackupMetadata(prepared.metadata);
    await invoke<void>('ack_backup_metadata', { revision: result.revision });
    useAppStore.setState({ backupImportPending: false });
    finalized = true;
    const projects = await projectApi.getAll();
    useAppStore.setState({ projects, chaptersVersion: useAppStore.getState().chaptersVersion + 1 });
    return result;
  } catch (error) {
    if (!committed) useAppStore.setState({ backupImportPending: false });
    else if (!finalized) throw new Error(`书库已安全提交，但元数据仍待恢复；请点击“重试恢复”或重新启动，不要重复导入。${error instanceof Error ? error.message : String(error)}`);
    else throw new Error(`导入已完成，但书库列表刷新失败。请重新打开应用。${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
