import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@store/index';
import { aiApi, chapterApi, knowledgeApi, projectApi } from '@services/api';
import { readBackup, writeBackupJson, writeBackupZip, type BackupBundle } from '../backup/archive';
import { buildBackupBundle, prepareBackupImport, summarizeBackup, type BackupSummary } from '../backup/bridge';
import { importBackupAtomically, recoverPendingBackupMetadata } from '../backup/service';
import { Button } from '@components/Button';
import { uiConfirm, uiAlert } from '@components/uiDialog';
import type {
  EmbeddingConfig,
  ImageEngine,
  KbStats,
  TextModelConfig,
  TextModelProfile,
  TextModelProvider,
} from '@typings/index';
import {
  CheckCircle,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDriveDownload,
  Image,
  Key,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { tx } from '@utils/i18n';

type Status = 'idle' | 'testing' | 'success' | 'error';

const CUSTOM_MODEL_DEFAULT: Pick<TextModelProfile, 'provider' | 'apiUrl' | 'model' | 'temperature'> = {
  provider: 'custom',
  apiUrl: 'https://your-api.example.com/v1',
  model: 'your-model-name',
  temperature: 0.7,
};

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(2, Math.max(0, value));
}

function isProfileConfigValid(profile: TextModelProfile): boolean {
  return (
    profile.apiKey.trim().length > 0 &&
    profile.apiUrl.trim().length > 0 &&
    profile.model.trim().length > 0 &&
    Number.isFinite(profile.temperature)
  );
}

function toTextConfig(profile: TextModelProfile): TextModelConfig {
  return {
    provider: profile.provider,
    apiKey: profile.apiKey.trim(),
    apiUrl: profile.apiUrl.trim(),
    model: profile.model.trim(),
    temperature: clampTemperature(profile.temperature),
  };
}

function createCustomProfile(
  profiles: TextModelProfile[],
  inputName: string,
  defaultNamePrefix: string
): TextModelProfile {
  let idx = profiles.length + 1;
  let id = `custom-${idx}`;
  while (profiles.some((profile) => profile.id === id)) {
    idx += 1;
    id = `custom-${idx}`;
  }

  const customCount = profiles.filter((profile) => !profile.builtIn).length + 1;
  const name = inputName.trim() || `${defaultNamePrefix} ${customCount}`;

  return {
    id,
    name,
    apiKey: '',
    builtIn: false,
    ...CUSTOM_MODEL_DEFAULT,
  };
}

function normalizeProfile(profile: TextModelProfile): TextModelProfile {
  return {
    ...profile,
    provider: (profile.provider || 'custom') as TextModelProvider,
    name: profile.name.trim() || profile.id,
    apiKey: profile.apiKey.trim(),
    apiUrl: profile.apiUrl.trim(),
    model: profile.model.trim(),
    temperature: clampTemperature(profile.temperature),
  };
}

export function SettingsPage() {
  const {
    uiLanguage,
    textModelProfiles,
    activeTextModelProfileId,
    pollinationsKey,
    imageEngine,
    comfyUIUrl,
    setTextModelProfiles,
    setActiveTextModelProfileId,
    setTextModelConfig,
    setPollinationsKey,
    setImageEngine,
    setComfyUIUrl,
    knowledgeBaseEnabled,
    embeddingConfig,
    setKnowledgeBaseEnabled,
    setEmbeddingConfig,
    projects,
    summariesEnabled,
    entitiesEnabled,
    setSummariesEnabled,
    setEntitiesEnabled,
  } = useAppStore();

  // In-app, centered notice dialog (replaces browser-native alert "localhost:1420 显示" popups).
  const notify = (message: string) => { void uiAlert({ title: tx(uiLanguage, '提示', 'Notice'), message }); };

  const [localProfiles, setLocalProfiles] = useState<TextModelProfile[]>(textModelProfiles);
  const [localActiveProfileId, setLocalActiveProfileId] = useState(activeTextModelProfileId);
  const [newPlatformName, setNewPlatformName] = useState('');
  const [localPollinationsKey, setLocalPollinationsKey] = useState(pollinationsKey);
  const [localImageEngine, setLocalImageEngine] = useState<ImageEngine>(imageEngine);
  const [localComfyUIUrl, setLocalComfyUIUrl] = useState(comfyUIUrl);
  const [showTextKey, setShowTextKey] = useState(false);
  const [showPollinationsKey, setShowPollinationsKey] = useState(false);
  const [textStatus, setTextStatus] = useState<Status>('idle');
  const [pollinationsStatus, setPollinationsStatus] = useState<Status>('idle');
  const [comfyUIStatus, setComfyUIStatus] = useState<Status>('idle');

  // Knowledge base local state
  const [localKnowledgeBaseEnabled, setLocalKnowledgeBaseEnabled] = useState(knowledgeBaseEnabled);
  const [localEmbeddingConfig, setLocalEmbeddingConfig] = useState<EmbeddingConfig>(embeddingConfig);
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<Status>('idle');
  const [rebuildProjectId, setRebuildProjectId] = useState<string>('');
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState('');
  const [kbStats, setKbStats] = useState<KbStats | null>(null);
  const [kbStatsLoading, setKbStatsLoading] = useState(false);

  // KB v2 local state
  const [localSummariesEnabled, setLocalSummariesEnabled] = useState(summariesEnabled);
  const [localEntitiesEnabled, setLocalEntitiesEnabled] = useState(entitiesEnabled);
  const [isBuildingBookSummary, setIsBuildingBookSummary] = useState(false);
  const [bookSummaryStatus, setBookSummaryStatus] = useState('');
  const [isBuildingChapterSummaries, setIsBuildingChapterSummaries] = useState(false);
  const [chapterSummariesProgress, setChapterSummariesProgress] = useState('');

  // Backup / Restore state
  const [backupStatus, setBackupStatus] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isReadingBackup, setIsReadingBackup] = useState(false);
  const [backupFormat, setBackupFormat] = useState<'zip' | 'json'>('zip');
  const [exportIncludeSecrets, setExportIncludeSecrets] = useState(false);
  const backupImportPending = useAppStore(state => state.backupImportPending);
  const [importPreview, setImportPreview] = useState<{
    file: BackupBundle;
    fileName: string;
    summary: BackupSummary;
  } | null>(null);
  const [importIncludeAppSettings, setImportIncludeAppSettings] = useState(false);

  useEffect(() => {
    setLocalProfiles(textModelProfiles);
    setLocalActiveProfileId(activeTextModelProfileId);
  }, [textModelProfiles, activeTextModelProfileId]);

  useEffect(() => {
    setLocalImageEngine(imageEngine);
    setLocalComfyUIUrl(comfyUIUrl);
  }, [imageEngine, comfyUIUrl]);

  useEffect(() => {
    setLocalKnowledgeBaseEnabled(knowledgeBaseEnabled);
    setLocalEmbeddingConfig(embeddingConfig);
  }, [knowledgeBaseEnabled, embeddingConfig]);

  useEffect(() => {
    setLocalSummariesEnabled(summariesEnabled);
    setLocalEntitiesEnabled(entitiesEnabled);
  }, [summariesEnabled, entitiesEnabled]);

  // Default the rebuild project selector to the first project once loaded.
  useEffect(() => {
    if (!rebuildProjectId && projects.length > 0) {
      setRebuildProjectId(projects[0].id);
    }
  }, [projects, rebuildProjectId]);

  // Refresh KB stats whenever the selected project changes.
  useEffect(() => {
    if (!rebuildProjectId) {
      setKbStats(null);
      return;
    }
    let cancelled = false;
    setKbStatsLoading(true);
    knowledgeApi
      .getStats(rebuildProjectId)
      .then((s) => {
        if (!cancelled) setKbStats(s);
      })
      .catch(() => {
        if (!cancelled) setKbStats(null);
      })
      .finally(() => {
        if (!cancelled) setKbStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rebuildProjectId]);

  const activeProfile = useMemo(() => {
    return (
      localProfiles.find((profile) => profile.id === localActiveProfileId) ||
      localProfiles[0] ||
      null
    );
  }, [localProfiles, localActiveProfileId]);

  const updateActiveProfile = (patch: Partial<TextModelProfile>) => {
    if (!activeProfile) return;
    setLocalProfiles((prev) =>
      prev.map((profile) =>
        profile.id === activeProfile.id
          ? {
              ...profile,
              ...patch,
            }
          : profile
      )
    );
    setTextStatus('idle');
  };

  const switchActiveProfile = (profileId: string) => {
    setLocalActiveProfileId(profileId);
    setTextStatus('idle');
  };

  const addCustomPlatform = () => {
    const next = createCustomProfile(localProfiles, newPlatformName, tx(uiLanguage, '自定义平台', 'Custom Platform'));
    setLocalProfiles((prev) => [...prev, next]);
    setLocalActiveProfileId(next.id);
    setNewPlatformName('');
    setTextStatus('idle');
  };

  const deleteActiveCustomPlatform = () => {
    if (!activeProfile || activeProfile.builtIn) return;
    const nextProfiles = localProfiles.filter((profile) => profile.id !== activeProfile.id);
    const fallback = nextProfiles[0];
    setLocalProfiles(nextProfiles);
    if (fallback) {
      setLocalActiveProfileId(fallback.id);
    }
    setTextStatus('idle');
  };

  const testTextModel = async () => {
    if (!activeProfile || !isProfileConfigValid(activeProfile)) {
      notify(
        tx(
          uiLanguage,
          '请完整填写当前平台配置：API Key、API URL、模型、Temperature',
          'Please complete API Key, API URL, model, and temperature for current platform'
        )
      );
      return;
    }

    setTextStatus('testing');
    try {
      const result = await aiApi.testTextConnection(toTextConfig(activeProfile));
      setTextStatus(result ? 'success' : 'error');
    } catch {
      setTextStatus('error');
    }
  };

  const testPollinations = async () => {
    setPollinationsStatus('testing');
    try {
      const result = await aiApi.testPollinations(localPollinationsKey || undefined);
      setPollinationsStatus(result ? 'success' : 'error');
    } catch {
      setPollinationsStatus('error');
    }
  };

  const testComfyUI = async () => {
    setComfyUIStatus('testing');
    try {
      const { invoke } = await import('@tauri-apps/api/tauri');
      const result = await invoke<boolean>('test_comfyui_connection', {
        comfyuiUrl: localComfyUIUrl.trim() || undefined,
      });
      setComfyUIStatus(result ? 'success' : 'error');
    } catch {
      setComfyUIStatus('error');
    }
  };

  const isEmbeddingConfigValid = (cfg: EmbeddingConfig): boolean =>
    cfg.apiKey.trim().length > 0 &&
    cfg.apiUrl.trim().length > 0 &&
    cfg.model.trim().length > 0;

  const updateEmbeddingField = (patch: Partial<EmbeddingConfig>) => {
    setLocalEmbeddingConfig((prev) => ({ ...prev, ...patch }));
    setEmbeddingStatus('idle');
  };

  const testEmbedding = async () => {
    if (!isEmbeddingConfigValid(localEmbeddingConfig)) {
      notify(
        tx(
          uiLanguage,
          '请完整填写 Embedding 配置：API Key、API URL、模型',
          'Please complete Embedding API Key, API URL, and model'
        )
      );
      return;
    }
    setEmbeddingStatus('testing');
    try {
      const ok = await knowledgeApi.testEmbedding(localEmbeddingConfig);
      setEmbeddingStatus(ok ? 'success' : 'error');
    } catch (err) {
      console.warn('[KB] Test embedding failed:', err);
      setEmbeddingStatus('error');
    }
  };

  const rebuildKnowledgeBase = async () => {
    if (!rebuildProjectId) return;
    if (!isEmbeddingConfigValid(localEmbeddingConfig)) {
      notify(
        tx(
          uiLanguage,
          '请先填写并保存 Embedding 配置',
          'Please fill in and save Embedding configuration first'
        )
      );
      return;
    }
    const confirmed = await uiConfirm({
      title: tx(uiLanguage, '重建知识库', 'Rebuild knowledge base'),
      message: tx(
        uiLanguage,
        '将为该项目下所有已写章节重新生成 Embedding，会消耗一定 API 额度。继续？',
        'This will re-embed every written chapter in this project and consume API quota. Continue?'
      ),
    });
    if (!confirmed) return;

    setIsRebuilding(true);
    setRebuildProgress(tx(uiLanguage, '准备中…', 'Preparing…'));
    try {
      const chapters = await chapterApi.getByProject(rebuildProjectId);
      const eligible = chapters.filter(
        (c) => (c.final_text || c.draft_text || '').trim().length > 200
      );
      let done = 0;
      let totalChunks = 0;
      for (const c of eligible) {
        setRebuildProgress(
          tx(uiLanguage, `索引中 ${done + 1} / ${eligible.length}：${c.title}`,
            `Indexing ${done + 1} / ${eligible.length}: ${c.title}`)
        );
        try {
          const r = await knowledgeApi.indexChapter({
            projectId: rebuildProjectId,
            chapterId: c.id,
            text: c.final_text || c.draft_text || '',
            embeddingConfig: localEmbeddingConfig,
          });
          totalChunks += r.chunksIndexed;
        } catch (err) {
          console.warn(`[KB] Index chapter ${c.id} failed:`, err);
        }
        done += 1;
      }
      setRebuildProgress(
        tx(uiLanguage,
          `完成。共索引 ${done} 章，${totalChunks} 个片段。`,
          `Done. Indexed ${done} chapters, ${totalChunks} chunks.`)
      );
      // Refresh stats
      try {
        const s = await knowledgeApi.getStats(rebuildProjectId);
        setKbStats(s);
      } catch {
        /* ignore */
      }
    } catch (err) {
      console.error('[KB] Rebuild failed:', err);
      setRebuildProgress(
        tx(uiLanguage, `失败：${String(err)}`, `Failed: ${String(err)}`)
      );
    } finally {
      setIsRebuilding(false);
    }
  };

  const saveSettings = () => {
    if (!activeProfile || !isProfileConfigValid(activeProfile)) {
      notify(
        tx(
          uiLanguage,
          '请完整填写当前平台配置：API Key、API URL、模型、Temperature',
          'Please complete API Key, API URL, model, and temperature for current platform'
        )
      );
      return;
    }

    const normalizedProfiles = localProfiles.map((profile) => normalizeProfile(profile));
    const normalizedActive =
      normalizedProfiles.find((profile) => profile.id === localActiveProfileId) ||
      normalizedProfiles[0];
    if (!normalizedActive) {
      notify(tx(uiLanguage, '未找到可用平台配置', 'No available platform configuration found'));
      return;
    }

    setTextModelProfiles(normalizedProfiles);
    setActiveTextModelProfileId(normalizedActive.id);
    setTextModelConfig(toTextConfig(normalizedActive));
    setPollinationsKey(localPollinationsKey.trim());
    setImageEngine(localImageEngine);
    setComfyUIUrl(localComfyUIUrl.trim() || 'http://localhost:8188');
    setKnowledgeBaseEnabled(localKnowledgeBaseEnabled);
    setEmbeddingConfig(localEmbeddingConfig);
    setSummariesEnabled(localSummariesEnabled);
    setEntitiesEnabled(localEntitiesEnabled);

    notify(tx(uiLanguage, '设置已保存', 'Settings saved'));
  };

  const buildAllChapterSummaries = async () => {
    if (!rebuildProjectId) return;
    if (!isEmbeddingConfigValid(localEmbeddingConfig)) {
      notify(
        tx(uiLanguage,
          '请先填写并保存 Embedding 配置',
          'Please fill in and save Embedding configuration first')
      );
      return;
    }
    if (!activeProfile || !isProfileConfigValid(activeProfile)) {
      notify(
        tx(uiLanguage,
          '请先完整配置文本模型平台',
          'Please complete a text model platform first')
      );
      return;
    }
    const confirmed = await uiConfirm({
      title: tx(uiLanguage, '生成全部章节摘要', 'Build all chapter summaries'),
      message: tx(uiLanguage,
        '将为该项目下所有正文 >200 字的章节生成 ~150 字摘要，按文本模型平台计费。继续？',
        'This will generate ~150-char summaries for every chapter with >200 chars of content, billed via your text model platform. Continue?'),
    });
    if (!confirmed) return;

    setIsBuildingChapterSummaries(true);
    setChapterSummariesProgress(tx(uiLanguage, '加载章节中…', 'Loading chapters…'));
    try {
      const chapters = await chapterApi.getByProject(rebuildProjectId);
      const eligible = chapters.filter(
        (c) => (c.final_text || c.draft_text || '').trim().length > 200
      );
      let done = 0;
      let failed = 0;
      for (const c of eligible) {
        setChapterSummariesProgress(
          tx(uiLanguage,
            `生成摘要 ${done + 1} / ${eligible.length}：${c.title}`,
            `Summarizing ${done + 1} / ${eligible.length}: ${c.title}`)
        );
        try {
          await knowledgeApi.generateChapterSummary({
            projectId: rebuildProjectId,
            chapterId: c.id,
            chapterTitle: c.title,
            chapterText: c.final_text || c.draft_text || '',
            textConfig: toTextConfig(activeProfile),
            embeddingConfig: localEmbeddingConfig,
          });
        } catch (err) {
          console.warn(`[KB] Chapter summary for ${c.id} failed:`, err);
          failed += 1;
        }
        done += 1;
      }
      setChapterSummariesProgress(
        tx(uiLanguage,
          `完成。成功 ${done - failed} 章，失败 ${failed} 章。现在可以生成本书梗概。`,
          `Done. ${done - failed} succeeded, ${failed} failed. You can now build the book summary.`)
      );
    } catch (err) {
      console.error('[KB] Chapter summaries rebuild failed:', err);
      setChapterSummariesProgress(
        tx(uiLanguage, `失败：${String(err)}`, `Failed: ${String(err)}`)
      );
    } finally {
      setIsBuildingChapterSummaries(false);
    }
  };

  // ── Backup / Restore handlers ───────────────────────────────

  const stateForBackup = () => useAppStore.getState() as unknown as Record<string, unknown>;
  const handleExportBackup = async () => {
    if (isExporting || isImporting || backupImportPending) return;
    if (exportIncludeSecrets && !await uiConfirm({ title: tx(uiLanguage, '导出敏感信息', 'Export sensitive information'), message: tx(uiLanguage,
      '此次备份将包含 API 密钥。请仅保存到可信位置，确认继续？',
      'This backup will contain API keys. Save it only to a trusted location. Continue?') })) return;
    setIsExporting(true);
    setBackupStatus(tx(uiLanguage, '正在读取完整书库并生成备份…', 'Reading the full library and preparing backup…'));
    try {
      // No metadata-only fallback: a failed content read must stop the export visibly.
      const content = await projectApi.exportContent();
      const bundle = buildBackupBundle(stateForBackup(), content, exportIncludeSecrets);
      const blob = backupFormat === 'zip' ? await writeBackupZip(bundle) : writeBackupJson(bundle);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url;
      link.download = `novelseek-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${backupFormat}`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupStatus(tx(uiLanguage, '已导出完整书库（含正文、插图、智能体会话及双端兼容数据）。', 'Full library exported, including text, illustrations, agent sessions and compatible extensions.'));
    } catch (error) {
      setBackupStatus(tx(uiLanguage, `导出失败，未生成不完整备份：${String(error)}`, `Export failed; no incomplete backup was created: ${String(error)}`));
    } finally { setIsExporting(false); }
  };

  const handleImportPickFile = () => {
    if (isReadingBackup || isImporting || isExporting || backupImportPending) return;
    setBackupStatus('');
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.zip,.json,application/zip,application/json';
    input.onchange = async () => {
      const selected = input.files?.[0]; if (!selected) return;
      setIsReadingBackup(true);
      setBackupStatus(tx(uiLanguage, '正在校验备份大小、结构及附件摘要…', 'Validating size, structure and attachment checksums…'));
      try {
        const parsed = await readBackup(selected);
        // Fully validate detached import data before displaying a confirmation or doing any writes.
        prepareBackupImport(parsed, stateForBackup(), false);
        setImportPreview({ file: parsed, fileName: selected.name, summary: summarizeBackup(parsed, stateForBackup()) });
        setImportIncludeAppSettings(false); setBackupStatus('');
      } catch (error) {
        setBackupStatus(tx(uiLanguage, `导入校验失败，书库未改动：${String(error)}`, `Import validation failed; the library is unchanged: ${String(error)}`));
      } finally { setIsReadingBackup(false); }
    };
    input.click();
  };

  const handleConfirmImport = async () => {
    if (!importPreview || isImporting) return;
    setIsImporting(true);
    setBackupStatus(tx(uiLanguage, '正在原子导入书库并保存元数据…', 'Atomically importing the library and saving metadata…'));
    try {
      const receipt = await importBackupAtomically(importPreview.file, importIncludeAppSettings);
      setImportPreview(null);
      setBackupStatus(tx(uiLanguage,
        `导入完成：${receipt.importedProjects} 个项目、${receipt.importedChapters} 个章节。外来任务不会自动续写；本机设置${importIncludeAppSettings ? '已按选择更新' : '保持不变'}。`,
        `Imported ${receipt.importedProjects} projects and ${receipt.importedChapters} chapters. Imported tasks will not resume automatically. Local settings ${importIncludeAppSettings ? 'updated as selected' : 'were retained'}.`));
    } catch (error) {
      setBackupStatus(tx(uiLanguage, `导入失败：${String(error)}`, `Import failed: ${String(error)}`));
    } finally { setIsImporting(false); }
  };

  const handleRecoverBackup = async () => {
    setIsImporting(true);
    try {
      const restored = await recoverPendingBackupMetadata();
      if (restored) {
        useAppStore.getState().setProjects(await projectApi.getAll());
        useAppStore.getState().bumpChaptersVersion();
        setImportPreview(null);
      }
      setBackupStatus(tx(uiLanguage, restored ? '上次导入的元数据已恢复完成。' : '没有待恢复的导入。',
        restored ? 'The previous import metadata has been recovered.' : 'No import recovery is pending.'));
    } catch (error) {
      setBackupStatus(tx(uiLanguage, `恢复失败，恢复日志仍保留：${String(error)}`, `Recovery failed; the recovery journal is retained: ${String(error)}`));
    } finally { setIsImporting(false); }
  };

  const buildBookSummary = async () => {
    if (!rebuildProjectId) return;
    if (!isEmbeddingConfigValid(localEmbeddingConfig)) {
      notify(
        tx(
          uiLanguage,
          '请先填写并保存 Embedding 配置',
          'Please fill in and save Embedding configuration first'
        )
      );
      return;
    }
    if (!activeProfile || !isProfileConfigValid(activeProfile)) {
      notify(
        tx(
          uiLanguage,
          '请先完整配置文本模型平台',
          'Please complete a text model platform first'
        )
      );
      return;
    }
    const proj = projects.find((p) => p.id === rebuildProjectId);
    if (!proj) return;

    setIsBuildingBookSummary(true);
    setBookSummaryStatus(tx(uiLanguage, '生成中…', 'Generating…'));
    try {
      const s = await knowledgeApi.generateBookSummary({
        projectId: rebuildProjectId,
        bookTitle: proj.title,
        bookDescription: proj.description || '',
        textConfig: toTextConfig(activeProfile),
        embeddingConfig: localEmbeddingConfig,
      });
      setBookSummaryStatus(
        tx(uiLanguage,
          `已生成全书梗概，约 ${s.wordCount} 字。`,
          `Book summary generated, ~${s.wordCount} chars.`)
      );
    } catch (err) {
      console.error('[KB] Book summary failed:', err);
      const msg = String(err);
      // Friendlier error when the underlying chapter summaries are missing.
      const hint = msg.includes('No chapter or arc summaries')
        ? tx(uiLanguage,
            '失败：还没有任何章节摘要可供汇总。请先点击上方「重建章节摘要」按钮。',
            'Failed: no chapter summaries to roll up. Click "Rebuild Chapter Summaries" above first.')
        : tx(uiLanguage, `失败：${msg}`, `Failed: ${msg}`);
      setBookSummaryStatus(hint);
    } finally {
      setIsBuildingBookSummary(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">{tx(uiLanguage, '设置', 'Settings')}</h1>

      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center space-x-2 mb-4">
            <Key className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{tx(uiLanguage, '文本模型平台', 'Text Model Platforms')}</h2>
          </div>

          {activeProfile ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {tx(uiLanguage, '平台列表', 'Platform List')}
                  </label>
                  <select
                    value={localActiveProfileId}
                    onChange={(event) => switchActiveProfile(event.target.value)}
                    className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                  >
                    {localProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                        {profile.builtIn ? tx(uiLanguage, '（内置）', ' (Built-in)') : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {tx(uiLanguage, '新增自定义平台', 'Add Custom Platform')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={newPlatformName}
                      onChange={(event) => setNewPlatformName(event.target.value)}
                      placeholder={tx(uiLanguage, '平台名称（可选）', 'Platform Name (Optional)')}
                      className="flex-1 px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                    />
                    <Button onClick={addCustomPlatform} className="px-3 whitespace-nowrap">
                      <Plus className="w-4 h-4 mr-1" />
                      {tx(uiLanguage, '新增', 'Add')}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-medium text-gray-900 dark:text-white">{tx(uiLanguage, '当前平台配置', 'Current Platform Configuration')}</h3>
                {!activeProfile.builtIn && (
                  <button
                    type="button"
                    onClick={deleteActiveCustomPlatform}
                    className="inline-flex items-center px-3 py-1.5 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    {tx(uiLanguage, '删除当前自定义平台', 'Delete Current Custom Platform')}
                  </button>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '平台名称', 'Platform Name')}
                </label>
                <input
                  value={activeProfile.name}
                  onChange={(event) => updateActiveProfile({ name: event.target.value })}
                  placeholder={tx(uiLanguage, '例如：OpenAI生产环境', 'e.g. OpenAI Production')}
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '平台类型', 'Platform Type')}
                </label>
                <select
                  value={activeProfile.provider}
                  onChange={(event) =>
                    updateActiveProfile({ provider: event.target.value as TextModelProvider })
                  }
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                >
                  <option value="deepseek">DeepSeek</option>
                  <option value="openai">OpenAI</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="gemini">{tx(uiLanguage, 'Gemini(OpenAI兼容)', 'Gemini (OpenAI Compatible)')}</option>
                  <option value="custom">{tx(uiLanguage, '自定义(OpenAI兼容)', 'Custom (OpenAI Compatible)')}</option>
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    API Key
                  </label>
                  {activeProfile.keyUrl && (
                    <a
                      href={activeProfile.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                    >
                      {tx(uiLanguage, '获取密钥', 'Get Key')}
                      <ExternalLink className="w-3 h-3 ml-1" />
                    </a>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showTextKey ? 'text' : 'password'}
                    value={activeProfile.apiKey}
                    onChange={(event) => updateActiveProfile({ apiKey: event.target.value })}
                    placeholder={tx(uiLanguage, '请输入 API Key', 'Enter API Key')}
                    className="w-full px-3 py-2 pr-11 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTextKey((prev) => !prev)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    title={showTextKey ? tx(uiLanguage, '隐藏密钥', 'Hide Key') : tx(uiLanguage, '显示密钥', 'Show Key')}
                  >
                    {showTextKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  API URL
                </label>
                <input
                  value={activeProfile.apiUrl}
                  onChange={(event) => updateActiveProfile({ apiUrl: event.target.value })}
                  placeholder={tx(uiLanguage, '例如：https://api.deepseek.com/v1', 'e.g. https://api.deepseek.com/v1')}
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '模型名称', 'Model Name')}
                </label>
                <input
                  value={activeProfile.model}
                  onChange={(event) => updateActiveProfile({ model: event.target.value })}
                  placeholder={tx(uiLanguage, '例如：deepseek-chat / gpt-4o-mini', 'e.g. deepseek-chat / gpt-4o-mini')}
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, 'Temperature（0-2）', 'Temperature (0-2)')}
                </label>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={activeProfile.temperature}
                  onChange={(event) =>
                    updateActiveProfile({ temperature: Number(event.target.value || 0) })
                  }
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400">
                {tx(
                  uiLanguage,
                  '每个平台配置独立保存。切换平台会自动切换对应 API Key、API URL、模型和 Temperature。',
                  'Each platform is saved independently. Switching platform also switches API Key, API URL, model, and temperature.'
                )}
              </p>

              <div className="flex items-center space-x-2">
                <Button onClick={testTextModel} loading={textStatus === 'testing'}>
                  {tx(uiLanguage, '测试当前平台连接', 'Test Current Platform')}
                </Button>
                {textStatus === 'success' && (
                  <div className="flex items-center text-green-600 dark:text-green-400">
                    <CheckCircle className="w-4 h-4 mr-1" />
                    <span className="text-sm">{tx(uiLanguage, '连接成功', 'Connected')}</span>
                  </div>
                )}
                {textStatus === 'error' && (
                  <div className="flex items-center text-red-600 dark:text-red-400">
                    <XCircle className="w-4 h-4 mr-1" />
                    <span className="text-sm">{tx(uiLanguage, '连接失败', 'Connection Failed')}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-500 dark:text-gray-400">{tx(uiLanguage, '暂无可用文本模型平台', 'No available text model platform')}</div>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center space-x-2 mb-4">
            <Image className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {tx(uiLanguage, '图片生成引擎', 'Image Generation Engine')}
            </h2>
          </div>

          {/* Engine selector */}
          <div className="mb-5">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {tx(uiLanguage, '当前引擎', 'Active Engine')}
            </label>
            <div className="flex gap-3">
              {(['pollinations', 'comfyui'] as ImageEngine[]).map((eng) => (
                <label
                  key={eng}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer transition-colors ${
                    localImageEngine === eng
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/30 text-primary-700 dark:text-primary-300'
                      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-primary-400'
                  }`}
                >
                  <input
                    type="radio"
                    name="imageEngine"
                    value={eng}
                    checked={localImageEngine === eng}
                    onChange={() => setLocalImageEngine(eng)}
                    className="accent-primary-500"
                  />
                  {eng === 'pollinations' ? 'Pollinations' : 'ComfyUI'}
                </label>
              ))}
            </div>
          </div>

          {/* Pollinations config */}
          <div
            className={`space-y-4 rounded-lg border p-4 transition-opacity ${
              localImageEngine === 'pollinations'
                ? 'border-primary-300 dark:border-primary-700'
                : 'border-gray-200 dark:border-gray-700 opacity-60'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-800 dark:text-gray-200">Pollinations API</span>
              <a
                href="https://pollinations.ai"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              >
                {tx(uiLanguage, '访问官网', 'Official Site')}
                <ExternalLink className="w-3 h-3 ml-1" />
              </a>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {tx(uiLanguage, 'API Key（可选）', 'API Key (Optional)')}
                </label>
                <a
                  href="https://enter.pollinations.ai/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                >
                  {tx(uiLanguage, '获取密钥', 'Get Key')}
                  <ExternalLink className="w-3 h-3 ml-1" />
                </a>
              </div>
              <div className="relative">
                <input
                  type={showPollinationsKey ? 'text' : 'password'}
                  value={localPollinationsKey}
                  onChange={(event) => setLocalPollinationsKey(event.target.value)}
                  placeholder={tx(uiLanguage, 'pk_... 或 sk_...', 'pk_... or sk_...')}
                  className="w-full px-3 py-2 pr-11 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => setShowPollinationsKey((prev) => !prev)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  title={showPollinationsKey ? tx(uiLanguage, '隐藏密钥', 'Hide Key') : tx(uiLanguage, '显示密钥', 'Show Key')}
                >
                  {showPollinationsKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-400">
              {tx(uiLanguage, '不配置 API Key 也可使用，但可能受到频率限制。', 'Works without API key, but may be rate-limited.')}
            </p>

            <div className="flex items-center space-x-2">
              <Button onClick={testPollinations} loading={pollinationsStatus === 'testing'}>
                {tx(uiLanguage, '测试 Pollinations 连接', 'Test Pollinations')}
              </Button>
              {pollinationsStatus === 'success' && (
                <div className="flex items-center text-green-600 dark:text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  <span className="text-sm">{tx(uiLanguage, '连接成功', 'Connected')}</span>
                </div>
              )}
              {pollinationsStatus === 'error' && (
                <div className="flex items-center text-red-600 dark:text-red-400">
                  <XCircle className="w-4 h-4 mr-1" />
                  <span className="text-sm">{tx(uiLanguage, '连接失败', 'Failed')}</span>
                </div>
              )}
            </div>
          </div>

          {/* ComfyUI config */}
          <div
            className={`mt-4 space-y-4 rounded-lg border p-4 transition-opacity ${
              localImageEngine === 'comfyui'
                ? 'border-primary-300 dark:border-primary-700'
                : 'border-gray-200 dark:border-gray-700 opacity-60'
            }`}
          >
            <span className="font-medium text-gray-800 dark:text-gray-200">ComfyUI</span>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {tx(uiLanguage, '服务地址', 'Server URL')}
              </label>
              <input
                value={localComfyUIUrl}
                onChange={(event) => setLocalComfyUIUrl(event.target.value)}
                placeholder="http://localhost:8188"
                className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
              />
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-400">
              {tx(
                uiLanguage,
                '使用工作流：t2i-lumicreate（z-image-turbo 模型，无 LoRA）。请确保 ComfyUI 正在运行并已加载所需模型。',
                'Uses workflow: t2i-lumicreate (z-image-turbo, no LoRA). Ensure ComfyUI is running with required models loaded.'
              )}
            </p>

            <div className="flex items-center space-x-2">
              <Button onClick={testComfyUI} loading={comfyUIStatus === 'testing'}>
                {tx(uiLanguage, '测试 ComfyUI 连接', 'Test ComfyUI')}
              </Button>
              {comfyUIStatus === 'success' && (
                <div className="flex items-center text-green-600 dark:text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  <span className="text-sm">{tx(uiLanguage, '连接成功', 'Connected')}</span>
                </div>
              )}
              {comfyUIStatus === 'error' && (
                <div className="flex items-center text-red-600 dark:text-red-400">
                  <XCircle className="w-4 h-4 mr-1" />
                  <span className="text-sm">{tx(uiLanguage, '连接失败，请确认 ComfyUI 已启动', 'Connection failed. Ensure ComfyUI is running.')}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Local Knowledge Base (RAG) ─────────────────────────── */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center space-x-2 mb-4">
            <Database className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {tx(uiLanguage, '本地知识库（实验性）', 'Local Knowledge Base (Experimental)')}
            </h2>
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 leading-relaxed">
            {tx(
              uiLanguage,
              '开启后，每次保存章节会将正文切片并通过 Embedding 模型转为向量存入本地数据库；生成新章节时会自动检索历史中最相关的片段，作为「长程相关记忆」拼到提示词末尾。原有的近 3 章上下文逻辑不变，KB 检索仅作增强。',
              'When enabled, saving a chapter chunks its text and embeds it locally; new chapter generation retrieves the most relevant past snippets and appends them as long-range memory. The legacy last-3-chapters context is unchanged — KB only augments it.'
            )}
          </p>

          {/* Enable toggle */}
          <label className="flex items-center gap-3 mb-5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={localKnowledgeBaseEnabled}
              onChange={(e) => setLocalKnowledgeBaseEnabled(e.target.checked)}
              className="w-4 h-4 accent-primary-500"
            />
            <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
              {tx(uiLanguage, '启用本地知识库', 'Enable local knowledge base')}
            </span>
          </label>

          <div
            className={`space-y-4 rounded-lg border p-4 transition-opacity ${
              localKnowledgeBaseEnabled
                ? 'border-primary-300 dark:border-primary-700'
                : 'border-gray-200 dark:border-gray-700 opacity-60'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-800 dark:text-gray-200">
                {tx(uiLanguage, 'Embedding 服务（OpenAI 兼容）', 'Embedding Provider (OpenAI Compatible)')}
              </span>
              <a
                href="https://bailian.console.aliyun.com/?apiKey=1#/api-key"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              >
                {tx(uiLanguage, '获取百炼 API Key', 'Get Bailian API Key')}
                <ExternalLink className="w-3 h-3 ml-1" />
              </a>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                API Key
              </label>
              <div className="relative">
                <input
                  type={showEmbeddingKey ? 'text' : 'password'}
                  value={localEmbeddingConfig.apiKey}
                  onChange={(e) => updateEmbeddingField({ apiKey: e.target.value })}
                  placeholder="sk-..."
                  disabled={!localKnowledgeBaseEnabled}
                  className="w-full px-3 py-2 pr-11 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50 dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => setShowEmbeddingKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  {showEmbeddingKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr] gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  API URL
                </label>
                <input
                  value={localEmbeddingConfig.apiUrl}
                  onChange={(e) => updateEmbeddingField({ apiUrl: e.target.value })}
                  placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                  disabled={!localKnowledgeBaseEnabled}
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50 dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '模型', 'Model')}
                </label>
                <input
                  value={localEmbeddingConfig.model}
                  onChange={(e) => updateEmbeddingField({ model: e.target.value })}
                  placeholder="text-embedding-v3"
                  disabled={!localKnowledgeBaseEnabled}
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50 dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '维度（可选）', 'Dimensions (optional)')}
                </label>
                <input
                  type="number"
                  min={1}
                  value={localEmbeddingConfig.dimensions ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    updateEmbeddingField({
                      dimensions: Number.isFinite(n) && n > 0 ? n : undefined,
                    });
                  }}
                  placeholder="1024"
                  disabled={!localKnowledgeBaseEnabled}
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50 dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                />
              </div>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {tx(
                uiLanguage,
                '默认配置指向阿里云百炼。也支持任意 OpenAI 兼容的 Embedding 端点（硅基流动、智谱 GLM、OpenAI 等）。',
                'Defaults point to Alibaba Cloud Bailian (DashScope). Any OpenAI-compatible embedding endpoint also works (SiliconFlow, Zhipu GLM, OpenAI, etc.).'
              )}
            </p>

            <div className="flex items-center space-x-2">
              <Button
                onClick={testEmbedding}
                loading={embeddingStatus === 'testing'}
                disabled={!localKnowledgeBaseEnabled}
              >
                {tx(uiLanguage, '测试 Embedding 连接', 'Test Embedding')}
              </Button>
              {embeddingStatus === 'success' && (
                <div className="flex items-center text-green-600 dark:text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  <span className="text-sm">{tx(uiLanguage, '连接成功', 'Connected')}</span>
                </div>
              )}
              {embeddingStatus === 'error' && (
                <div className="flex items-center text-red-600 dark:text-red-400">
                  <XCircle className="w-4 h-4 mr-1" />
                  <span className="text-sm">{tx(uiLanguage, '连接失败', 'Connection Failed')}</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Rebuild / Stats panel ─────────────────────────────── */}
          <div className="mt-5 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
            <h3 className="text-base font-medium text-gray-900 dark:text-white">
              {tx(uiLanguage, '项目知识库管理', 'Project Knowledge Base')}
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '选择项目', 'Select Project')}
                </label>
                <select
                  value={rebuildProjectId}
                  onChange={(e) => setRebuildProjectId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                >
                  {projects.length === 0 && (
                    <option value="">{tx(uiLanguage, '（暂无项目）', '(No projects)')}</option>
                  )}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button
                  onClick={rebuildKnowledgeBase}
                  loading={isRebuilding}
                  disabled={!localKnowledgeBaseEnabled || !rebuildProjectId || isRebuilding}
                >
                  <RefreshCw className="w-4 h-4 mr-1" />
                  {tx(uiLanguage, '重建知识库', 'Rebuild')}
                </Button>
              </div>
            </div>

            {rebuildProgress && (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {rebuildProgress}
              </p>
            )}

            <div className="text-xs text-gray-600 dark:text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
              {kbStatsLoading ? (
                <span>{tx(uiLanguage, '加载统计中…', 'Loading stats…')}</span>
              ) : kbStats ? (
                <>
                  <span>
                    {tx(uiLanguage, `已索引片段：${kbStats.totalChunks}`,
                      `Chunks indexed: ${kbStats.totalChunks}`)}
                  </span>
                  <span>
                    {tx(uiLanguage, `已索引来源：${kbStats.totalSources}`,
                      `Sources indexed: ${kbStats.totalSources}`)}
                  </span>
                  {kbStats.embeddingModels.length > 0 && (
                    <span>
                      {tx(uiLanguage, '使用模型：', 'Models: ')}
                      {kbStats.embeddingModels.join(', ')}
                    </span>
                  )}
                </>
              ) : (
                <span>
                  {tx(uiLanguage, '该项目暂无索引数据', 'No KB data for this project yet')}
                </span>
              )}
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              {tx(
                uiLanguage,
                '提示：日常保存章节时会自动入库，只有第一次接入 / 切换 embedding 模型时才需要"重建"。',
                'Tip: regular chapter saves auto-index. Use "Rebuild" only on first setup or after switching embedding models.'
              )}
            </p>
          </div>

          {/* ── v2 augmentation layers ─────────────────────────── */}
          <div className={`mt-5 rounded-lg border p-4 space-y-4 transition-opacity ${
              localKnowledgeBaseEnabled
                ? 'border-amber-300 dark:border-amber-700'
                : 'border-gray-200 dark:border-gray-700 opacity-60'
            }`}>
            <h3 className="text-base font-medium text-gray-900 dark:text-white">
              {tx(uiLanguage, '增强层（v2，可选）', 'Augmentation Layers (v2, optional)')}
            </h3>
            <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
              {tx(uiLanguage,
                '这两层增强会在每次保存章节时额外调用一次 Chat Completion（按文本模型平台计费），并在生成新章节时把"全书梗概 / 当前弧线进度 / 未回收伏笔"塞进提示词。建议长篇（30 章以上）开启。',
                'Each layer triggers one extra Chat Completion per chapter save (billed via your text model platform), and injects book/arc summaries plus open foreshadowing into the prompt. Recommended for long novels (30+ chapters).')}
            </p>

            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={localSummariesEnabled}
                onChange={(e) => setLocalSummariesEnabled(e.target.checked)}
                disabled={!localKnowledgeBaseEnabled}
                className="mt-0.5 w-4 h-4 accent-primary-500"
              />
              <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {tx(uiLanguage, '启用分层摘要（章节 / 弧线 / 全书）', 'Enable hierarchical summaries (chapter / arc / book)')}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {tx(uiLanguage,
                    '保存章节时自动生成 ~150 字章节摘要，提示词里追加「全书梗概」+「当前弧线进度」段。',
                    'Auto-generates ~150-char chapter summaries on save. Prompts gain "book synopsis" and "current arc progress" sections.')}
                </div>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={localEntitiesEnabled}
                onChange={(e) => setLocalEntitiesEnabled(e.target.checked)}
                disabled={!localKnowledgeBaseEnabled}
                className="mt-0.5 w-4 h-4 accent-primary-500"
              />
              <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {tx(uiLanguage, '启用实体抽取（人物登场 / 伏笔 / 地点 / 事件 / 物品）', 'Enable entity extraction (characters / foreshadowing / locations / events / items)')}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {tx(uiLanguage,
                    '保存章节时自动结构化抽取，并在提示词里追加「未回收伏笔」清单，避免长篇写飞。',
                    'Structured extraction on save; "open foreshadowing" list is added to the prompt to keep long arcs coherent.')}
                </div>
              </div>
            </label>

            {/* Manual rebuild buttons */}
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700 space-y-4">
              {/* Step 1: chapter summaries */}
              <div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {tx(uiLanguage, '步骤 1：重建所有章节摘要', 'Step 1: Rebuild all chapter summaries')}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {tx(uiLanguage,
                        '一次性为已有章节生成摘要（首次启用必跑）。开启摘要 toggle 后，日常保存章节会自动维护。',
                        'One-shot pass over existing chapters (required on first enable). After toggle is on, regular chapter saves keep summaries up-to-date.')}
                    </div>
                  </div>
                  <Button
                    onClick={buildAllChapterSummaries}
                    loading={isBuildingChapterSummaries}
                    disabled={!localKnowledgeBaseEnabled || !rebuildProjectId || isBuildingChapterSummaries}
                  >
                    {tx(uiLanguage, '重建章节摘要', 'Rebuild Chapter Summaries')}
                  </Button>
                </div>
                {chapterSummariesProgress && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">{chapterSummariesProgress}</p>
                )}
              </div>

              {/* Step 2: book summary */}
              <div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {tx(uiLanguage, '步骤 2：生成「全书梗概」', 'Step 2: Build book summary')}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {tx(uiLanguage,
                        '基于已有章节 / 弧线摘要汇总。建议每 5-10 章手动刷新一次。',
                        'Rolls up existing chapter / arc summaries. Refresh every 5–10 chapters.')}
                    </div>
                  </div>
                  <Button
                    onClick={buildBookSummary}
                    loading={isBuildingBookSummary}
                    disabled={!localKnowledgeBaseEnabled || !rebuildProjectId || isBuildingBookSummary}
                  >
                    {tx(uiLanguage, '生成本书梗概', 'Build Book Summary')}
                  </Button>
                </div>
                {bookSummaryStatus && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">{bookSummaryStatus}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Backup / Restore ──────────────────────────────────── */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center space-x-2 mb-4">
            <HardDriveDownload className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {tx(uiLanguage, '数据备份 / 恢复', 'Data Backup / Restore')}
            </h2>
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
            {tx(uiLanguage,
              '备份包含完整正文、插图、角色、场景规划、写作档案和智能体会话，可与 Android 1.6.0 交换。推荐使用带附件摘要校验的 ZIP；同时支持旧版 JSON。导入先校验再确认，相同 ID 的项目或章节由备份覆盖，本机模型和 API 设置默认保持不变。',
              'Back up complete text, illustrations, characters, scene plans, writing archives and agent sessions, compatible with Android 1.6.0. Checksummed ZIP is recommended; legacy JSON is also supported. Imports are validated before confirmation. Matching IDs are replaced; local model/API settings are retained by default.')}
          </p>

          <div className="flex flex-wrap items-center gap-4 mb-3 text-sm text-gray-700 dark:text-gray-300">
            <label className="flex items-center gap-2">
              {tx(uiLanguage, '备份格式', 'Format')}
              <select value={backupFormat} onChange={e => setBackupFormat(e.target.value as 'zip' | 'json')} disabled={isExporting}
                className="rounded border bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 px-2 py-1">
                <option value="zip">ZIP {tx(uiLanguage, '（推荐）', '(recommended)')}</option><option value="json">JSON {tx(uiLanguage, '（旧版）', '(legacy)')}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={exportIncludeSecrets} onChange={e => setExportIncludeSecrets(e.target.checked)} disabled={isExporting} />
              {tx(uiLanguage, '包含 API 密钥（敏感）', 'Include API keys (sensitive)')}
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleExportBackup} variant="outline" className="whitespace-nowrap" loading={isExporting} disabled={isImporting || isReadingBackup || backupImportPending}>
              <Download className="w-4 h-4 mr-2" />
              {tx(uiLanguage, '导出全部数据', 'Export Backup')}
            </Button>
            <Button onClick={handleImportPickFile} variant="outline" className="whitespace-nowrap" loading={isReadingBackup} disabled={isImporting || isExporting || backupImportPending}>
              <Upload className="w-4 h-4 mr-2" />
              {tx(uiLanguage, '从备份导入', 'Import Backup')}
            </Button>
            <Button onClick={handleRecoverBackup} variant="outline" disabled={isImporting || isExporting || isReadingBackup}>
              {tx(uiLanguage, '重试恢复', 'Retry recovery')}
            </Button>
          </div>

          {backupStatus && (
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-3 whitespace-pre-line">
              {backupStatus}
            </p>
          )}

          <p className="text-xs text-amber-700 dark:text-amber-400 mt-3 leading-relaxed">
            {tx(uiLanguage,
              '默认移除 API 密钥，但仍包含全部书稿和私人会话，请妥善保管。导入的运行中任务会标记为已中断，不会在本机自动续写。ZIP 校验只能检测损坏，不能证明文件来源可信。',
              'API keys are excluded by default, but private manuscripts and conversations remain. Keep backups secure. Imported running tasks are interrupted, not auto-resumed. ZIP checksums detect corruption; they do not authenticate the sender.')}
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={saveSettings}>{tx(uiLanguage, '保存设置', 'Save Settings')}</Button>
        </div>
      </div>

      {/* Import preview modal */}
      {importPreview && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (!isImporting && e.target === e.currentTarget) setImportPreview(null); }}
        >
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-primary-600" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {tx(uiLanguage, '确认导入', 'Confirm Import')}
              </h3>
            </div>

            <div className="text-xs text-gray-500 dark:text-gray-400 break-all">
              {importPreview.fileName}
              {importPreview.file.exportedAt && (
                <span className="ml-2 text-gray-400">
                  ({new Date(importPreview.file.exportedAt).toLocaleString()})
                </span>
              )}
            </div>
            {!Array.isArray(importPreview.file.data.projects) && importPreview.summary.chaptersInBackup === 0 && (
              <p className="text-sm text-amber-700 dark:text-amber-400">{tx(uiLanguage, '此旧备份只包含元数据，不含正文或完整书库项目；它不能恢复文件中原本不存在的章节。', 'This legacy backup contains metadata only, not manuscript text or complete library projects. Chapters absent from the file cannot be restored.')}</p>
            )}

            <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3 text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">{tx(uiLanguage, '章节 / 智能体会话', 'Chapters / agent sessions')}</span>
                <span className="font-medium text-gray-900 dark:text-white">{importPreview.summary.chaptersInBackup} / {importPreview.summary.sessionsInBackup}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">
                  {tx(uiLanguage, '备份中的项目数', 'Projects in backup')}
                </span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {importPreview.summary.projectIdsInBackup}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">
                  {tx(uiLanguage, '当前已有的项目数', 'Projects currently in app')}
                </span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {importPreview.summary.projectIdsInStore}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">
                  {tx(uiLanguage, '将被覆盖的项目数', 'Projects to be overwritten')}
                </span>
                <span className={`font-medium ${importPreview.summary.projectIdsOverlap > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>
                  {importPreview.summary.projectIdsOverlap}
                </span>
              </div>
              {importPreview.summary.chapterPromosInBackup > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">
                    {tx(uiLanguage, '章节封面/摘要', 'Chapter promos')}
                  </span>
                  <span className="font-medium text-gray-900 dark:text-white">
                    {importPreview.summary.chapterPromosInBackup}
                  </span>
                </div>
              )}
            </div>

            {importPreview.summary.hasAppSettings && (
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={importIncludeAppSettings}
                  onChange={(e) => setImportIncludeAppSettings(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-primary-500"
                />
                <span className="text-sm text-gray-800 dark:text-gray-200">
                  {tx(uiLanguage,
                    '同时导入桌面端设置（模型、API、主题等）；Android 自有设置仍仅保留用于交换，不覆盖本机',
                    'Also import desktop settings (models, API, theme, etc.). Android-only settings remain exchange data and do not overwrite this device.')}
                </span>
              </label>
            )}
            {backupStatus && <p role="status" className="text-sm text-amber-700 dark:text-amber-400 whitespace-pre-line">{backupStatus}</p>}
            {backupImportPending && <Button onClick={handleRecoverBackup} variant="outline" disabled={isImporting}>{tx(uiLanguage, '重试恢复上次导入', 'Recover previous import')}</Button>}

            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onClick={() => setImportPreview(null)} disabled={isImporting}>
                {tx(uiLanguage, '取消', 'Cancel')}
              </Button>
              <Button onClick={handleConfirmImport} loading={isImporting} disabled={isImporting}>
                {tx(uiLanguage, '确认导入', 'Confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
