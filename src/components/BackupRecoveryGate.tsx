import { useEffect, useState, type ReactNode } from 'react';
import { recoverPendingBackupMetadata } from '../backup/service';
import { useAppStore } from '../store';
import { projectApi } from '../services/api';

/** A committed native import must be reconciled before any new write can overwrite its metadata. */
export function BackupRecoveryGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    async function recover() {
      if (!('__TAURI_IPC__' in window)) { if (active) setReady(true); return; }
      setError('');
      // State management is installed asynchronously during native startup. A short bounded
      // read-only retry covers that startup window without ever repeating a committed import.
      for (let i = 0; i < 6; i++) {
        try {
          const restored = await recoverPendingBackupMetadata();
          if (restored) {
            useAppStore.getState().setProjects(await projectApi.getAll());
            useAppStore.getState().bumpChaptersVersion();
          }
          if (active) setReady(true);
          return;
        } catch (cause) {
          if (i === 5 || useAppStore.getState().backupImportPending) {
            if (active) setError(String(cause)); return;
          }
          await new Promise(resolve => setTimeout(resolve, 400 * (i + 1)));
        }
      }
    }
    void recover();
    return () => { active = false; };
  }, [attempt]);
  if (!ready) return <main className="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex items-center justify-center p-6">
    <section className="max-w-xl space-y-4"><h1 className="text-xl font-semibold">{error ? '书库恢复未完成' : '正在检查书库恢复状态…'}</h1>
      {error && <><p className="break-words whitespace-pre-wrap">{error}</p><p>原始备份与恢复日志仍保留；完成恢复前不会启动新任务。请勿重复导入。</p>
        <button onClick={() => setAttempt(value => value + 1)} className="px-4 py-2 rounded bg-violet-600 text-white">重试恢复</button></>}
    </section></main>;
  return <>{children}</>;
}
