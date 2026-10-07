import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';
import type { WritingArchive, WritingWorkspace, WritingUsageEntry } from '../writing/models';
import type { SessionMetrics } from '../agent/agentPolicy';
import type {
  Chapter,
  EmbeddingConfig,
  ImageEngine,
  Project,
  ProjectFolder,
  TextModelConfig,
  TextModelProfile,
  TextModelProvider,
  UiLanguage,
} from '@typings/index';

export type { ProjectFolder };

// ── Persistence storage ────────────────────────────────────────
// localStorage's ~5MB quota can't hold image-heavy state (character portraits, chapter promo
// images) — importing a full Android backup overflows it. Persist to IndexedDB instead (large
// quota), migrating any existing localStorage value on first read.
const IDB_NAME = 'novelseek-store';
const IDB_STORE = 'kv';
let idbPromise: Promise<IDBDatabase> | null = null;

function getIdb(): Promise<IDBDatabase> {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}

function idbGet(key: string): Promise<string | null> {
  return getIdb().then(
    (db) =>
      new Promise<string | null>((resolve, reject) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve((r.result as string | undefined) ?? null);
        r.onerror = () => reject(r.error);
      })
  );
}

function idbSet(key: string, value: string): Promise<void> {
  return getIdb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      })
  );
}

function idbDel(key: string): Promise<void> {
  return getIdb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      })
  );
}

// Debounced, deferred persistence. zustand's persist calls setItem after EVERY `set`, and the default
// JSON storage serializes the WHOLE persisted blob synchronously. Our blob is image-heavy (character
// portraits, chapter promo images, agent steps), so a synchronous JSON.stringify on every state change
// — e.g. the several store writes a page navigation triggers — janks the UI badly.
//
// This storage defers + coalesces the expensive serialize: setItem just records the latest value and
// schedules a single flush (≤600ms later, off the interaction). A pagehide/visibilitychange flush makes
// sure the last write isn't lost when the window closes. getItem stays synchronous-read (idb → legacy
// localStorage) and returns the parsed object.
let pendingPersist: { name: string; value: unknown } | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
// Serialize asynchronous IDB writes: a late old debounce must never overwrite an imported snapshot.
let persistWriteQueue: Promise<void> = Promise.resolve();
function queuedIdbSet(name: string, serialized: string): Promise<void> {
  const write = persistWriteQueue.then(() => idbSet(name, serialized));
  persistWriteQueue = write.catch(() => undefined);
  return write;
}

function flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!pendingPersist) return;
  const { name, value } = pendingPersist;
  pendingPersist = null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (e) {
    console.error('[store] serialize failed:', e);
    return;
  }
  queuedIdbSet(name, serialized)
    .then(() => {
      // Free the old localStorage copy once data lives in IndexedDB.
      try { localStorage.removeItem(name); } catch { /* ignore */ }
    })
    .catch((e) => {
      console.warn('[store] IndexedDB set failed, falling back to localStorage:', e);
      try { localStorage.setItem(name, serialized); } catch (e2) { console.error('[store] persist failed (quota?):', e2); }
    });
}

const debouncedIdbStorage: PersistStorage<unknown> = {
  getItem: async (name) => {
    let str: string | null = null;
    try {
      str = await idbGet(name);
    } catch (e) {
      console.warn('[store] IndexedDB get failed:', e);
    }
    // One-time migration: read the legacy localStorage value if IndexedDB is empty.
    if (str == null) {
      try { str = localStorage.getItem(name); } catch { str = null; }
    }
    if (str == null) return null;
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    // Coalesce: record the latest snapshot; the first write in a burst schedules one flush.
    pendingPersist = { name, value };
    if (!persistTimer) persistTimer = setTimeout(flushPersist, 600);
  },
  removeItem: async (name) => {
    if (pendingPersist && pendingPersist.name === name) pendingPersist = null;
    try { await idbDel(name); } catch { /* ignore */ }
    try { localStorage.removeItem(name); } catch { /* ignore */ }
  },
};

// Never lose the last debounced write when the window closes or is hidden.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });
}

export interface Character {
  id: string;
  name: string;
  gender: string;
  role: string;
  personality: string;
  background: string;
  motivation: string;
  appearance: string;
  portraitBase64?: string;
  portraitPrompt?: string;
  isProtagonist: boolean;
  // Cultivation realm tracking (mirrors Android `Character.currentRealmId/currentSubRealmId`).
  currentRealmId?: string;
  currentSubRealmId?: string;
}

export interface ChapterPromo {
  imagePrompt: string;
  summary: string;
  imageBase64: string | null;
}

// ── Long Novel types ──────────────────────────────────────────
export type NovelType = 'short' | 'long';

export interface PlotArc {
  id: string;
  title: string;
  summary: string;
  order: number;
  status: 'upcoming' | 'active' | 'ending' | 'completed';
  chaptersUntilEnd?: number;
  chapterCount: number;
  miniOutline?: string;
  builtChapterIds?: string[];
  // The 副本 (Volume) this arc belongs to. Null = legacy/un-assigned; migrated into "副本1"
  // by ensureVolumes(). Mirrors Android `PlotArc.volumeId`.
  volumeId?: string;
}

// ── 副本 (Volume) — long-novel container for plot arcs ─────────
// Mirrors Android `Volume` (Domain.kt). Volumes are an ordered grouping of PlotArcs; arcs
// reference their volume via PlotArc.volumeId. Stored in `volumesByProject`.
export interface Volume {
  id: string;
  name: string;
  description: string;
  order: number;
  createdAt: string;
  /** 本副本的修为/境界规划与上限（用户填写）。会作为硬约束注入本副本的章节规划与生成，
   *  防止跨副本越级、重复突破、忽高忽低。例："主角只突破到微尘境·巅峰，在微尘境内逐层稳步推进，不进入下一大境界"。 */
  realmPlan?: string;
}

// ── 成长路线 (Character Growth) ────────────────────────────────
// One entry in a character's growth route — a per-chapter knowledge base of how the character
// develops. The latest entries are injected into new-chapter generation as soft guidance.
// Stored in `characterGrowthByProject[projectId][characterId]`. Mirrors Android `CharacterGrowthEntry`.
export interface CharacterGrowthEntry {
  id: string;
  value: string;
  chapterId?: string;
  chapterOrder?: number;
  chapterTitle?: string;
  createdAt: string;
  manual: boolean;
}

// ── 容器 (Container) — flexible, optionally AI-evolved knowledge store per project ──
// Mirrors Android `Container`/`ContainerEntry`/`ContainerStore` (Container.kt). A container is
// partitioned into BLOCKS by its type:
//   - by_character: one block per character (blockKey = characterId)
//   - by_chapter:   one block per chapter   (blockKey = chapterId)
//   - single:       one block               (blockKey = "main")
// Blocks are derived live from current characters/chapters; each block holds a CHAIN of entries
// (oldest → newest). Stored in `containersByProject[projectId]`.
export type ContainerType = 'by_character' | 'by_chapter' | 'single';
export const CONTAINER_SINGLE_BLOCK_KEY = 'main';

export interface Container {
  id: string;
  name: string;
  type: ContainerType;
  autoUpdatePerChapter: boolean;
  affectsGeneration: boolean;
  affectsVolumeGeneration: boolean;
  affectsArcGeneration: boolean;
  createdAt: string;
}

export interface ContainerEntry {
  id: string;
  value: string;
  sourceChapterId?: string;
  sourceChapterOrder?: number;
  sourceChapterTitle?: string;
  createdAt: string;
  manual: boolean;
}

export interface ContainerStore {
  containers: Container[];
  // containerId -> (blockKey -> chain of entries, oldest first)
  entries: Record<string, Record<string, ContainerEntry[]>>;
}

// ── 问小说 (Novel Chat) ────────────────────────────────────────
// One turn in the per-project "ask the novel" Q&A agent. Mirrors Android `NovelChatMessage`.
// Stored in `novelChatsByProject[projectId]`; exported/imported under the backup key `novelChats`.
export interface NovelChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface CharacterRelationship {
  id: string;
  fromCharId: string;
  toCharId: string;
  type: string;
  description: string;
}

export interface CharacterEvent {
  id: string;
  characterId: string;
  arcId: string;
  chapterIndex: number;
  chapterTitle: string;
  title: string;
  description: string;
}

// ── Cultivation realm system (xuanhuan / xianxia) ──────────────

/** 小境界（sub-realm）—— 隶属于某个大境界内部的细分等级。 */
export interface CultivationSubRealm {
  id: string;
  order: number;          // 0-indexed within the parent major realm
  name: string;
  description?: string;
}

/** 大境界（major realm）—— 顶层修炼阶段，可包含若干小境界。 */
export interface CultivationRealm {
  id: string;
  order: number;          // 0-indexed top-level order; lower = weaker
  name: string;           // e.g. "炼气期", "筑基期"
  description?: string;   // optional flavor / required conditions
  subRealms?: CultivationSubRealm[];
}

export interface CharacterRealmEvent {
  id: string;
  characterId: string;
  realmId: string;
  chapterId: string;          // FK-style ref into the chapters table
  chapterOrderIndex: number;  // cached for sort & display so we don't need a join
  note?: string;
}

function normalizeCharacterRecord(character: Partial<Character>, index = 0): Character {
  return {
    id: character.id || `char-${Date.now()}-${index}`,
    name: character.name || `角色${index + 1}`,
    gender: character.gender || '',
    role: character.role || '',
    personality: character.personality || '',
    background: character.background || '',
    motivation: character.motivation || '',
    appearance: character.appearance || '',
    portraitBase64: character.portraitBase64 || undefined,
    portraitPrompt: character.portraitPrompt || undefined,
    isProtagonist: Boolean(character.isProtagonist),
    currentRealmId: character.currentRealmId || undefined,
    currentSubRealmId: character.currentSubRealmId || undefined,
  };
}

function normalizeCharacterList(characters: unknown): Character[] {
  if (!Array.isArray(characters)) return [];
  return characters.map((character, index) =>
    normalizeCharacterRecord((character as Partial<Character>) || {}, index)
  );
}

const TEXT_MODEL_PROVIDERS: TextModelProvider[] = [
  'deepseek',
  'openai',
  'openrouter',
  'gemini',
  'custom',
];

const DEFAULT_ACTIVE_PROFILE_ID = 'deepseek';

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  apiKey: '',
  apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'text-embedding-v3',
  dimensions: 1024,
};

const BUILTIN_TEXT_MODEL_PROFILES: TextModelProfile[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'deepseek',
    apiKey: '',
    apiUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 0.7,
    builtIn: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    apiKey: '',
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    builtIn: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    provider: 'openrouter',
    apiKey: '',
    apiUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    temperature: 0.7,
    builtIn: true,
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'gemini',
    name: 'Gemini(OpenAI兼容)',
    provider: 'gemini',
    apiKey: '',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    temperature: 0.7,
    builtIn: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
];

function getInitialTheme(): 'light' | 'dark' {
  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

function getInitialUiLanguage(): UiLanguage {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  return 'zh';
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(2, Math.max(0, value));
}

function normalizeProvider(value: unknown): TextModelProvider {
  if (typeof value === 'string' && TEXT_MODEL_PROVIDERS.includes(value as TextModelProvider)) {
    return value as TextModelProvider;
  }
  return 'custom';
}

function toTextModelConfig(profile: TextModelProfile): TextModelConfig {
  return {
    provider: profile.provider,
    apiKey: profile.apiKey,
    apiUrl: profile.apiUrl,
    model: profile.model,
    temperature: clampTemperature(profile.temperature),
  };
}

function cloneBuiltinProfiles(): TextModelProfile[] {
  return BUILTIN_TEXT_MODEL_PROFILES.map((profile) => ({ ...profile }));
}

function normalizeProfile(input: Partial<TextModelProfile> & { id: string }): TextModelProfile {
  const provider = normalizeProvider(input.provider);
  return {
    id: input.id,
    name: (input.name || input.id).trim() || input.id,
    provider,
    apiKey: (input.apiKey || '').trim(),
    apiUrl: (input.apiUrl || '').trim(),
    model: (input.model || '').trim(),
    temperature: clampTemperature(
      typeof input.temperature === 'number' ? input.temperature : 0.7
    ),
    builtIn: Boolean(input.builtIn),
    keyUrl: typeof input.keyUrl === 'string' ? input.keyUrl : undefined,
  };
}

function mergeProfilesWithBuiltins(rawProfiles: unknown[]): TextModelProfile[] {
  const merged = cloneBuiltinProfiles();

  if (!Array.isArray(rawProfiles)) {
    return merged;
  }

  for (const item of rawProfiles) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<TextModelProfile>;
    if (!raw.id || typeof raw.id !== 'string') continue;

    const normalized = normalizeProfile({
      ...raw,
      id: raw.id,
    });

    const existingIndex = merged.findIndex((profile) => profile.id === normalized.id);
    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      merged[existingIndex] = {
        ...existing,
        ...normalized,
        builtIn: existing.builtIn,
        keyUrl: existing.keyUrl || normalized.keyUrl,
      };
    } else {
      merged.push({
        ...normalized,
        builtIn: false,
      });
    }
  }

  return merged;
}

function generateCustomProfileId(profiles: TextModelProfile[]): string {
  let seed = profiles.length + 1;
  let candidate = `custom-${seed}`;
  while (profiles.some((profile) => profile.id === candidate)) {
    seed += 1;
    candidate = `custom-${seed}`;
  }
  return candidate;
}

function pickActiveProfile(
  profiles: TextModelProfile[],
  activeProfileId?: string,
  preferredProvider?: TextModelProvider
): TextModelProfile {
  const byId = activeProfileId
    ? profiles.find((profile) => profile.id === activeProfileId)
    : undefined;
  if (byId) return byId;

  const byProvider = preferredProvider
    ? profiles.find((profile) => profile.provider === preferredProvider)
    : undefined;
  if (byProvider) return byProvider;

  return (
    profiles.find((profile) => profile.id === DEFAULT_ACTIVE_PROFILE_ID) ||
    profiles[0] ||
    cloneBuiltinProfiles()[0]
  );
}

// ── Agent 多会话 (ported from Android agent/data/model/Agent.kt) ──────────────
// One step in the agent's top-to-bottom execution chain; persisted so a session survives restarts.
export type AgentStepRole = 'user' | 'thought' | 'tool' | 'result' | 'final' | 'error' | 'ask' | 'image';
export interface AgentStep {
  id: string;
  role: AgentStepRole;
  content: string;
  tool?: string;
  image?: string; // base64 data URL for role === 'image'
}
/** One agent conversation. `lockedProjectId` is the focused project; `autoApprove` pre-authorizes
 *  sensitive steps for this session. */
export interface AgentSession {
  id: string;
  title: string;
  createdAt: string;
  steps: AgentStep[];
  lockedProjectId: string | null;
  autoApprove: boolean;
}
export interface AgentSessionMeta { id: string; title: string; createdAt: string }

interface AppState {
  // Android-compatible, additive archives. Unknown Android fields live in backupExtensions.
  writingWorkspaceByProject: Record<string, WritingWorkspace>;
  writingUsageByProject: Record<string, WritingUsageEntry[]>;
  sceneWritingByProject: Record<string, WritingArchive>;
  generationRunsByProject: Record<string, unknown[]>;
  backupExtensions: Record<string, unknown>;
  agentEngine: 'legacy' | 'structured';
  agentReasoningLevel: 'low' | 'medium' | 'high';
  agentContextBudget: number;
  agentSessionMetrics: Record<string, SessionMetrics>;
  agentSessionContextSummaries: Record<string, string>;
  /** Import/recovery guard; deliberately not persisted. */
  backupImportPending: boolean;
  projects: Project[];
  currentProject: Project | null;
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (project: Project | null) => void;

  chapters: Chapter[];
  currentChapter: Chapter | null;
  setChapters: (chapters: Chapter[]) => void;
  setCurrentChapter: (chapter: Chapter | null) => void;

  charactersByProject: Record<string, Character[]>;
  setCharacters: (projectId: string, characters: Character[]) => void;
  getCharacters: (projectId: string) => Character[];

  promoByChapter: Record<string, ChapterPromo>;
  setPromo: (chapterId: string, promo: ChapterPromo) => void;
  getPromo: (chapterId: string) => ChapterPromo | null;

  worldSettingByProject: Record<string, string>;
  setWorldSetting: (projectId: string, worldSetting: string) => void;
  getWorldSetting: (projectId: string) => string;

  timelineByProject: Record<string, string>;
  setTimeline: (projectId: string, timeline: string) => void;
  getTimeline: (projectId: string) => string;

  textModelConfig: TextModelConfig;
  textModelProfiles: TextModelProfile[];
  activeTextModelProfileId: string;
  pollinationsKey: string;
  imageEngine: ImageEngine;
  comfyUIUrl: string;
  setTextModelConfig: (config: TextModelConfig) => void;
  updateTextModelConfig: (patch: Partial<TextModelConfig>) => void;
  setTextModelProfiles: (profiles: TextModelProfile[]) => void;
  setActiveTextModelProfileId: (profileId: string) => void;
  addTextModelProfile: (profile: Omit<TextModelProfile, 'id'> & { id?: string }) => string;
  updateTextModelProfile: (profileId: string, patch: Partial<TextModelProfile>) => void;
  removeTextModelProfile: (profileId: string) => void;
  setPollinationsKey: (key: string) => void;
  setImageEngine: (engine: ImageEngine) => void;
  setComfyUIUrl: (url: string) => void;

  sidebarOpen: boolean;
  mobileMenuOpen: boolean;
  toggleSidebar: () => void;
  setMobileMenuOpen: (open: boolean) => void;
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
  toggleTheme: () => void;
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  toggleUiLanguage: () => void;

  isGenerating: boolean;
  generationProgress: string;
  setIsGenerating: (isGenerating: boolean) => void;
  setGenerationProgress: (progress: string) => void;

  folders: ProjectFolder[];
  addFolder: (name: string, emoji: string) => string;
  updateFolder: (folderId: string, name: string, emoji: string) => void;
  deleteFolder: (folderId: string) => void;
  moveProjectToFolder: (projectId: string, folderId: string | null) => void;

  // Open project tabs (browser-like multi-open) shown in the Topbar. Ordered list of project IDs.
  openProjectTabs: string[];
  // Per-tab last-visited full route (so a tab reopens on the exact sub-page — e.g. the chapter editor —
  // not just the project landing page). projectId → pathname.
  tabPathByProject: Record<string, string>;
  openProjectTab: (projectId: string) => void;   // add to the end if not already open (no-op otherwise)
  setProjectTabPath: (projectId: string, path: string) => void; // remember the tab's current route
  closeProjectTab: (projectId: string) => void;   // remove from the tab strip
  closeOtherProjectTabs: (keepId: string) => void; // keep only keepId
  closeAllProjectTabs: () => void;                 // clear the strip
  reorderProjectTabs: (orderedIds: string[]) => void;

  // Long novel state
  novelTypeByProject: Record<string, NovelType>;
  setNovelType: (projectId: string, type: NovelType) => void;
  getNovelType: (projectId: string) => NovelType;

  plotArcsByProject: Record<string, PlotArc[]>;
  setPlotArcs: (projectId: string, arcs: PlotArc[]) => void;
  getPlotArcs: (projectId: string) => PlotArc[];
  addPlotArc: (projectId: string, arc: Omit<PlotArc, 'id'>) => string;
  updatePlotArc: (projectId: string, arcId: string, patch: Partial<PlotArc>) => void;
  deletePlotArc: (projectId: string, arcId: string) => void;

  longNovelOutlineByProject: Record<string, string>;
  setLongNovelOutline: (projectId: string, outline: string) => void;
  getLongNovelOutline: (projectId: string) => string;

  characterRelationshipsByProject: Record<string, CharacterRelationship[]>;
  setCharacterRelationships: (projectId: string, rels: CharacterRelationship[]) => void;
  getCharacterRelationships: (projectId: string) => CharacterRelationship[];

  characterEventsByProject: Record<string, CharacterEvent[]>;
  setCharacterEvents: (projectId: string, events: CharacterEvent[]) => void;
  getCharacterEvents: (projectId: string) => CharacterEvent[];
  addCharacterEvent: (projectId: string, event: Omit<CharacterEvent, 'id'>) => void;
  deleteCharacterEvent: (projectId: string, eventId: string) => void;

  // Cultivation realm system
  cultivationRealmsByProject: Record<string, CultivationRealm[]>;
  setCultivationRealms: (projectId: string, realms: CultivationRealm[]) => void;
  getCultivationRealms: (projectId: string) => CultivationRealm[];

  characterRealmEventsByProject: Record<string, CharacterRealmEvent[]>;
  setCharacterRealmEvents: (projectId: string, events: CharacterRealmEvent[]) => void;
  getCharacterRealmEvents: (projectId: string) => CharacterRealmEvent[];
  addCharacterRealmEvent: (projectId: string, event: Omit<CharacterRealmEvent, 'id'>) => void;
  deleteCharacterRealmEvent: (projectId: string, eventId: string) => void;
  /** Remove all realm events tied to a deleted chapter. Idempotent. */
  cleanupRealmEventsForChapter: (projectId: string, chapterId: string) => void;

  // ── 副本 (Volumes) ────────────────────────────────────────────
  volumesByProject: Record<string, Volume[]>;
  setVolumes: (projectId: string, volumes: Volume[]) => void;
  getVolumes: (projectId: string) => Volume[];
  /** Wrap orphan/legacy arcs into a single "副本1". Idempotent — safe on every project open. */
  ensureVolumes: (projectId: string) => void;

  // ── 容器 (Containers) ─────────────────────────────────────────
  containersByProject: Record<string, ContainerStore>;
  getContainerStore: (projectId: string) => ContainerStore;
  getContainers: (projectId: string) => Container[];
  createContainer: (projectId: string, container: Container) => void;
  updateContainerMeta: (
    projectId: string,
    containerId: string,
    patch: Pick<
      Container,
      'name' | 'autoUpdatePerChapter' | 'affectsGeneration' | 'affectsVolumeGeneration' | 'affectsArcGeneration'
    >
  ) => void;
  deleteContainer: (projectId: string, containerId: string) => void;
  getContainerEntries: (projectId: string, containerId: string, blockKey: string) => ContainerEntry[];
  appendContainerEntry: (
    projectId: string,
    containerId: string,
    blockKey: string,
    entry: ContainerEntry
  ) => void;
  /** Overwrite the value of the newest entry in a block (user manually editing the latest value). */
  replaceLatestContainerEntry: (
    projectId: string,
    containerId: string,
    blockKey: string,
    value: string
  ) => void;

  // ── 成长路线 (Character Growth) ───────────────────────────────
  characterGrowthByProject: Record<string, Record<string, CharacterGrowthEntry[]>>;
  getCharacterGrowth: (projectId: string, characterId: string) => CharacterGrowthEntry[];
  setCharacterGrowth: (projectId: string, characterId: string, entries: CharacterGrowthEntry[]) => void;
  appendCharacterGrowth: (projectId: string, characterId: string, entry: CharacterGrowthEntry) => void;

  // ── 问小说 (Novel Chat) ───────────────────────────────────────
  novelChatsByProject: Record<string, NovelChatMessage[]>;
  getNovelChat: (projectId: string) => NovelChatMessage[];
  setNovelChat: (projectId: string, messages: NovelChatMessage[]) => void;
  appendNovelChat: (projectId: string, message: NovelChatMessage) => void;
  clearNovelChat: (projectId: string) => void;

  // Local knowledge base (RAG)
  knowledgeBaseEnabled: boolean;
  embeddingConfig: EmbeddingConfig;
  setKnowledgeBaseEnabled: (enabled: boolean) => void;
  setEmbeddingConfig: (config: EmbeddingConfig) => void;
  updateEmbeddingConfig: (patch: Partial<EmbeddingConfig>) => void;

  // KB v2 toggles
  summariesEnabled: boolean;
  entitiesEnabled: boolean;
  setSummariesEnabled: (enabled: boolean) => void;
  setEntitiesEnabled: (enabled: boolean) => void;

  // ── Agent 多会话 (multi-session) ──────────────────────────────
  agentSessions: Record<string, AgentSession>;
  agentSessionOrder: string[];        // session ids, newest-first
  agentCurrentSessionId: string | null;
  getAgentSessionMetas: () => AgentSessionMeta[];
  getAgentSession: (id: string) => AgentSession | undefined;
  /** Ensure at least one session exists and return the current id (creating one if needed). */
  ensureAgentSession: () => string;
  newAgentSession: () => string;      // create + make current, returns new id
  switchAgentSession: (id: string) => void;
  deleteAgentSession: (id: string) => void;
  renameAgentSession: (id: string, title: string) => void;
  /** Upsert a session's full content (steps/focus/autoApprove/title) and mark it current. */
  saveAgentSession: (session: AgentSession) => void;
  /** Append one step to a session's chain (used by the background runner). */
  appendAgentStep: (sessionId: string, step: AgentStep) => void;
  /** Patch a session's fields (focus / autoApprove / steps). */
  patchAgentSession: (sessionId: string, patch: Partial<AgentSession>) => void;
  /** Max autonomous steps per agent run before it pauses (user-adjustable). Persisted. */
  agentMaxSteps: number;
  setAgentMaxSteps: (n: number) => void;

  // ── Agent run-time (NOT persisted — resets to idle on reload) ──
  agentStatus: 'idle' | 'running' | 'awaiting_user' | 'awaiting_confirm';
  agentRunSessionId: string | null;     // which session the background run belongs to
  agentPendingConfirm: { tool: string; args: Record<string, any> } | null;
  setAgentStatus: (status: 'idle' | 'running' | 'awaiting_user' | 'awaiting_confirm') => void;
  setAgentRunSessionId: (id: string | null) => void;
  setAgentPendingConfirm: (p: { tool: string; args: Record<string, any> } | null) => void;
  /** Bumped whenever chapters are mutated outside an open page (e.g. the background agent), so pages
   *  showing a chapter list can re-fetch live. Not persisted. */
  chaptersVersion: number;
  bumpChaptersVersion: () => void;
}

const initialProfiles = cloneBuiltinProfiles();
const initialActiveProfile = pickActiveProfile(initialProfiles, DEFAULT_ACTIVE_PROFILE_ID);

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      writingWorkspaceByProject: {},
      writingUsageByProject: {},
      sceneWritingByProject: {},
      generationRunsByProject: {},
      backupExtensions: {},
      agentEngine: 'legacy',
      agentReasoningLevel: 'medium',
      agentContextBudget: 32_000,
      agentSessionMetrics: {},
      agentSessionContextSummaries: {},
      backupImportPending: false,
      projects: [],
      currentProject: null,
      setProjects: (projects) => set({ projects }),
      setCurrentProject: (currentProject) => set({ currentProject }),

      chapters: [],
      currentChapter: null,
      setChapters: (chapters) => set({ chapters }),
      setCurrentChapter: (currentChapter) => set({ currentChapter }),

      charactersByProject: {},
      setCharacters: (projectId, characters) =>
        set((state) => ({
          charactersByProject: {
            ...state.charactersByProject,
            [projectId]: normalizeCharacterList(characters),
          },
        })),
      getCharacters: (projectId) => normalizeCharacterList(get().charactersByProject[projectId]),

      promoByChapter: {},
      setPromo: (chapterId, promo) =>
        set((state) => ({
          promoByChapter: {
            ...state.promoByChapter,
            [chapterId]: promo,
          },
        })),
      getPromo: (chapterId) => get().promoByChapter[chapterId] || null,

      worldSettingByProject: {},
      setWorldSetting: (projectId, worldSetting) =>
        set((state) => ({
          worldSettingByProject: {
            ...state.worldSettingByProject,
            [projectId]: worldSetting,
          },
        })),
      getWorldSetting: (projectId) => get().worldSettingByProject[projectId] || '',

      timelineByProject: {},
      setTimeline: (projectId, timeline) =>
        set((state) => ({
          timelineByProject: {
            ...state.timelineByProject,
            [projectId]: timeline,
          },
        })),
      getTimeline: (projectId) => get().timelineByProject[projectId] || '',

      textModelProfiles: initialProfiles,
      activeTextModelProfileId: initialActiveProfile.id,
      textModelConfig: toTextModelConfig(initialActiveProfile),
      pollinationsKey: '',

      imageEngine: 'pollinations' as ImageEngine,
      comfyUIUrl: 'http://localhost:8188',

      setTextModelConfig: (textModelConfig) =>
        set((state) => {
          const normalized: TextModelConfig = {
            provider: normalizeProvider(textModelConfig.provider),
            apiKey: (textModelConfig.apiKey || '').trim(),
            apiUrl: (textModelConfig.apiUrl || '').trim(),
            model: (textModelConfig.model || '').trim(),
            temperature: clampTemperature(textModelConfig.temperature),
          };
          const profiles = state.textModelProfiles.map((profile) =>
            profile.id === state.activeTextModelProfileId
              ? normalizeProfile({ ...profile, ...normalized, id: profile.id })
              : profile
          );
          return {
            textModelConfig: normalized,
            textModelProfiles: profiles,
          };
        }),

      updateTextModelConfig: (patch) =>
        set((state) => {
          const nextConfig: TextModelConfig = {
            ...state.textModelConfig,
            ...patch,
            provider: normalizeProvider((patch.provider ?? state.textModelConfig.provider) as TextModelProvider),
            temperature: clampTemperature(
              typeof patch.temperature === 'number'
                ? patch.temperature
                : state.textModelConfig.temperature
            ),
          };

          const profiles = state.textModelProfiles.map((profile) =>
            profile.id === state.activeTextModelProfileId
              ? normalizeProfile({ ...profile, ...nextConfig, id: profile.id })
              : profile
          );

          return {
            textModelConfig: nextConfig,
            textModelProfiles: profiles,
          };
        }),

      setTextModelProfiles: (profiles) =>
        set((state) => {
          const mergedProfiles = mergeProfilesWithBuiltins(profiles);
          const activeProfile = pickActiveProfile(
            mergedProfiles,
            state.activeTextModelProfileId,
            state.textModelConfig.provider
          );
          return {
            textModelProfiles: mergedProfiles,
            activeTextModelProfileId: activeProfile.id,
            textModelConfig: toTextModelConfig(activeProfile),
          };
        }),

      setActiveTextModelProfileId: (profileId) =>
        set((state) => {
          const activeProfile = pickActiveProfile(
            state.textModelProfiles,
            profileId,
            state.textModelConfig.provider
          );
          return {
            activeTextModelProfileId: activeProfile.id,
            textModelConfig: toTextModelConfig(activeProfile),
          };
        }),

      addTextModelProfile: (profile) => {
        const state = get();
        const id =
          typeof profile.id === 'string' && profile.id.trim()
            ? profile.id.trim()
            : generateCustomProfileId(state.textModelProfiles);
        const nextProfile = normalizeProfile({
          ...profile,
          id,
          builtIn: false,
          provider: profile.provider ?? 'custom',
        });

        set((current) => ({
          textModelProfiles: [...current.textModelProfiles, nextProfile],
        }));

        return id;
      },

      updateTextModelProfile: (profileId, patch) =>
        set((state) => {
          const profiles = state.textModelProfiles.map((profile) =>
            profile.id === profileId
              ? normalizeProfile({
                  ...profile,
                  ...patch,
                  id: profile.id,
                  builtIn: profile.builtIn,
                  keyUrl: profile.keyUrl || patch.keyUrl,
                })
              : profile
          );

          const activeProfile = pickActiveProfile(
            profiles,
            state.activeTextModelProfileId,
            state.textModelConfig.provider
          );

          return {
            textModelProfiles: profiles,
            activeTextModelProfileId: activeProfile.id,
            textModelConfig: toTextModelConfig(activeProfile),
          };
        }),

      removeTextModelProfile: (profileId) =>
        set((state) => {
          const target = state.textModelProfiles.find((profile) => profile.id === profileId);
          if (!target || target.builtIn) {
            return {};
          }

          const profiles = state.textModelProfiles.filter((profile) => profile.id !== profileId);
          const activeProfile = pickActiveProfile(
            profiles,
            state.activeTextModelProfileId === profileId
              ? DEFAULT_ACTIVE_PROFILE_ID
              : state.activeTextModelProfileId,
            state.textModelConfig.provider
          );

          return {
            textModelProfiles: profiles,
            activeTextModelProfileId: activeProfile.id,
            textModelConfig: toTextModelConfig(activeProfile),
          };
        }),

      setPollinationsKey: (pollinationsKey) => set({ pollinationsKey }),

      setImageEngine: (imageEngine) => set({ imageEngine }),
      setComfyUIUrl: (comfyUIUrl) => set({ comfyUIUrl }),

      sidebarOpen: true,
      mobileMenuOpen: false,
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setMobileMenuOpen: (open) => set({ mobileMenuOpen: open }),
      theme: getInitialTheme(),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      uiLanguage: getInitialUiLanguage(),
      setUiLanguage: (uiLanguage) => set({ uiLanguage }),
      toggleUiLanguage: () =>
        set((state) => ({
          uiLanguage: state.uiLanguage === 'zh' ? 'en' : 'zh',
        })),

      isGenerating: false,
      generationProgress: '',
      setIsGenerating: (isGenerating) => set({ isGenerating }),
      setGenerationProgress: (generationProgress) => set({ generationProgress }),

      folders: [],
      addFolder: (name, emoji) => {
        const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        set((state) => ({
          folders: [...state.folders, { id, name, emoji, projectIds: [] }],
        }));
        return id;
      },
      updateFolder: (folderId, name, emoji) =>
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId ? { ...f, name, emoji } : f
          ),
        })),
      deleteFolder: (folderId) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== folderId),
        })),
      moveProjectToFolder: (projectId, folderId) =>
        set((state) => ({
          folders: state.folders.map((f) => {
            if (folderId === null || f.id !== folderId) {
              // Remove from this folder
              return { ...f, projectIds: f.projectIds.filter((pid) => pid !== projectId) };
            }
            // Add to this folder (avoid duplicates)
            if (f.projectIds.includes(projectId)) return f;
            return { ...f, projectIds: [...f.projectIds, projectId] };
          }),
        })),

      openProjectTabs: [],
      tabPathByProject: {},
      openProjectTab: (projectId) =>
        set((state) =>
          state.openProjectTabs.includes(projectId)
            ? state
            : { openProjectTabs: [...state.openProjectTabs, projectId] }
        ),
      setProjectTabPath: (projectId, path) =>
        set((state) =>
          state.tabPathByProject[projectId] === path
            ? state
            : { tabPathByProject: { ...state.tabPathByProject, [projectId]: path } }
        ),
      closeProjectTab: (projectId) =>
        set((state) => {
          const rest = { ...state.tabPathByProject };
          delete rest[projectId];
          return {
            openProjectTabs: state.openProjectTabs.filter((pid) => pid !== projectId),
            tabPathByProject: rest,
          };
        }),
      closeOtherProjectTabs: (keepId) =>
        set((state) => ({
          openProjectTabs: state.openProjectTabs.filter((pid) => pid === keepId),
          tabPathByProject: state.tabPathByProject[keepId]
            ? { [keepId]: state.tabPathByProject[keepId] }
            : {},
        })),
      closeAllProjectTabs: () => set({ openProjectTabs: [], tabPathByProject: {} }),
      reorderProjectTabs: (orderedIds) => set({ openProjectTabs: orderedIds }),

      // ── Long novel implementations ──────────────────────────
      novelTypeByProject: {},
      setNovelType: (projectId, type) =>
        set((state) => ({
          novelTypeByProject: { ...state.novelTypeByProject, [projectId]: type },
        })),
      getNovelType: (projectId) => get().novelTypeByProject[projectId] || 'short',

      plotArcsByProject: {},
      setPlotArcs: (projectId, arcs) =>
        set((state) => ({
          plotArcsByProject: { ...state.plotArcsByProject, [projectId]: arcs },
        })),
      getPlotArcs: (projectId) => get().plotArcsByProject[projectId] || [],
      addPlotArc: (projectId, arc) => {
        const id = `arc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        set((state) => ({
          plotArcsByProject: {
            ...state.plotArcsByProject,
            [projectId]: [...(state.plotArcsByProject[projectId] || []), { ...arc, id }],
          },
        }));
        return id;
      },
      updatePlotArc: (projectId, arcId, patch) =>
        set((state) => ({
          plotArcsByProject: {
            ...state.plotArcsByProject,
            [projectId]: (state.plotArcsByProject[projectId] || []).map((a) =>
              a.id === arcId ? { ...a, ...patch } : a
            ),
          },
        })),
      deletePlotArc: (projectId, arcId) =>
        set((state) => ({
          plotArcsByProject: {
            ...state.plotArcsByProject,
            [projectId]: (state.plotArcsByProject[projectId] || []).filter((a) => a.id !== arcId),
          },
        })),

      longNovelOutlineByProject: {},
      setLongNovelOutline: (projectId, outline) =>
        set((state) => ({
          longNovelOutlineByProject: { ...state.longNovelOutlineByProject, [projectId]: outline },
        })),
      getLongNovelOutline: (projectId) => get().longNovelOutlineByProject[projectId] || '',

      characterRelationshipsByProject: {},
      setCharacterRelationships: (projectId, rels) =>
        set((state) => ({
          characterRelationshipsByProject: {
            ...state.characterRelationshipsByProject,
            [projectId]: rels,
          },
        })),
      getCharacterRelationships: (projectId) =>
        get().characterRelationshipsByProject[projectId] || [],

      characterEventsByProject: {},
      setCharacterEvents: (projectId, events) =>
        set((state) => ({
          characterEventsByProject: { ...state.characterEventsByProject, [projectId]: events },
        })),
      getCharacterEvents: (projectId) => get().characterEventsByProject[projectId] || [],
      addCharacterEvent: (projectId, event) =>
        set((state) => ({
          characterEventsByProject: {
            ...state.characterEventsByProject,
            [projectId]: [
              ...(state.characterEventsByProject[projectId] || []),
              { ...event, id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
            ],
          },
        })),
      deleteCharacterEvent: (projectId, eventId) =>
        set((state) => ({
          characterEventsByProject: {
            ...state.characterEventsByProject,
            [projectId]: (state.characterEventsByProject[projectId] || []).filter(
              (e) => e.id !== eventId
            ),
          },
        })),

      // ── Cultivation realm system ──────────────────────────────
      cultivationRealmsByProject: {},
      setCultivationRealms: (projectId, realms) =>
        set((state) => ({
          cultivationRealmsByProject: {
            ...state.cultivationRealmsByProject,
            [projectId]: [...realms].sort((a, b) => a.order - b.order),
          },
        })),
      getCultivationRealms: (projectId) => {
        const list = get().cultivationRealmsByProject[projectId] || [];
        return [...list].sort((a, b) => a.order - b.order);
      },

      characterRealmEventsByProject: {},
      setCharacterRealmEvents: (projectId, events) =>
        set((state) => ({
          characterRealmEventsByProject: {
            ...state.characterRealmEventsByProject,
            [projectId]: events,
          },
        })),
      getCharacterRealmEvents: (projectId) =>
        get().characterRealmEventsByProject[projectId] || [],
      addCharacterRealmEvent: (projectId, event) =>
        set((state) => ({
          characterRealmEventsByProject: {
            ...state.characterRealmEventsByProject,
            [projectId]: [
              ...(state.characterRealmEventsByProject[projectId] || []),
              { ...event, id: `realmevt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
            ],
          },
        })),
      deleteCharacterRealmEvent: (projectId, eventId) =>
        set((state) => ({
          characterRealmEventsByProject: {
            ...state.characterRealmEventsByProject,
            [projectId]: (state.characterRealmEventsByProject[projectId] || []).filter(
              (e) => e.id !== eventId
            ),
          },
        })),
      cleanupRealmEventsForChapter: (projectId, chapterId) =>
        set((state) => {
          const existing = state.characterRealmEventsByProject[projectId];
          if (!existing) return state;
          const filtered = existing.filter((e) => e.chapterId !== chapterId);
          if (filtered.length === existing.length) return state;
          return {
            characterRealmEventsByProject: {
              ...state.characterRealmEventsByProject,
              [projectId]: filtered,
            },
          };
        }),

      // ── 副本 (Volumes) ──────────────────────────────────────────
      volumesByProject: {},
      setVolumes: (projectId, volumes) =>
        set((state) => ({
          volumesByProject: {
            ...state.volumesByProject,
            [projectId]: [...volumes].sort((a, b) => a.order - b.order),
          },
        })),
      getVolumes: (projectId) => {
        const list = get().volumesByProject[projectId] || [];
        return [...list].sort((a, b) => a.order - b.order);
      },
      ensureVolumes: (projectId) => {
        const state = get();
        const arcs = state.plotArcsByProject[projectId] || [];
        const vols = state.getVolumes(projectId);
        if (vols.length > 0) {
          const ids = new Set(vols.map((v) => v.id));
          const firstId = vols[0].id; // already sorted by order
          if (arcs.some((a) => !a.volumeId || !ids.has(a.volumeId))) {
            state.setPlotArcs(
              projectId,
              arcs.map((a) =>
                !a.volumeId || !ids.has(a.volumeId) ? { ...a, volumeId: firstId } : a
              )
            );
          }
          return;
        }
        if (arcs.length === 0) return; // no volumes & no arcs: created on demand
        const name = state.uiLanguage === 'en' ? 'Volume 1' : '副本1';
        const vol: Volume = {
          id: `vol-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          description: '',
          order: 0,
          createdAt: new Date().toISOString(),
        };
        state.setVolumes(projectId, [vol]);
        state.setPlotArcs(
          projectId,
          arcs.map((a) => ({ ...a, volumeId: vol.id }))
        );
      },

      // ── 容器 (Containers) ───────────────────────────────────────
      containersByProject: {},
      getContainerStore: (projectId) =>
        get().containersByProject[projectId] || { containers: [], entries: {} },
      getContainers: (projectId) => get().getContainerStore(projectId).containers,
      createContainer: (projectId, container) =>
        set((state) => {
          const store = state.containersByProject[projectId] || { containers: [], entries: {} };
          return {
            containersByProject: {
              ...state.containersByProject,
              [projectId]: { ...store, containers: [...store.containers, container] },
            },
          };
        }),
      updateContainerMeta: (projectId, containerId, patch) =>
        set((state) => {
          const store = state.containersByProject[projectId];
          if (!store) return state;
          return {
            containersByProject: {
              ...state.containersByProject,
              [projectId]: {
                ...store,
                containers: store.containers.map((c) =>
                  c.id === containerId ? { ...c, ...patch } : c
                ),
              },
            },
          };
        }),
      deleteContainer: (projectId, containerId) =>
        set((state) => {
          const store = state.containersByProject[projectId];
          if (!store) return state;
          const nextEntries = { ...store.entries };
          delete nextEntries[containerId];
          return {
            containersByProject: {
              ...state.containersByProject,
              [projectId]: {
                containers: store.containers.filter((c) => c.id !== containerId),
                entries: nextEntries,
              },
            },
          };
        }),
      getContainerEntries: (projectId, containerId, blockKey) =>
        get().getContainerStore(projectId).entries[containerId]?.[blockKey] || [],
      appendContainerEntry: (projectId, containerId, blockKey, entry) =>
        set((state) => {
          const store = state.containersByProject[projectId] || { containers: [], entries: {} };
          const byContainer = { ...(store.entries[containerId] || {}) };
          byContainer[blockKey] = [...(byContainer[blockKey] || []), entry];
          return {
            containersByProject: {
              ...state.containersByProject,
              [projectId]: {
                ...store,
                entries: { ...store.entries, [containerId]: byContainer },
              },
            },
          };
        }),
      replaceLatestContainerEntry: (projectId, containerId, blockKey, value) =>
        set((state) => {
          const store = state.containersByProject[projectId];
          if (!store) return state;
          const byContainer = store.entries[containerId];
          const chain = byContainer?.[blockKey];
          if (!chain || chain.length === 0) return state;
          const nextChain = [...chain];
          nextChain[nextChain.length - 1] = {
            ...nextChain[nextChain.length - 1],
            value,
            manual: true,
          };
          return {
            containersByProject: {
              ...state.containersByProject,
              [projectId]: {
                ...store,
                entries: {
                  ...store.entries,
                  [containerId]: { ...byContainer, [blockKey]: nextChain },
                },
              },
            },
          };
        }),

      // ── 成长路线 (Character Growth) ─────────────────────────────
      characterGrowthByProject: {},
      getCharacterGrowth: (projectId, characterId) =>
        get().characterGrowthByProject[projectId]?.[characterId] || [],
      setCharacterGrowth: (projectId, characterId, entries) =>
        set((state) => ({
          characterGrowthByProject: {
            ...state.characterGrowthByProject,
            [projectId]: {
              ...(state.characterGrowthByProject[projectId] || {}),
              [characterId]: entries,
            },
          },
        })),
      appendCharacterGrowth: (projectId, characterId, entry) =>
        set((state) => {
          const inner = state.characterGrowthByProject[projectId] || {};
          return {
            characterGrowthByProject: {
              ...state.characterGrowthByProject,
              [projectId]: {
                ...inner,
                [characterId]: [...(inner[characterId] || []), entry],
              },
            },
          };
        }),

      // ── 问小说 (Novel Chat) ─────────────────────────────────────
      novelChatsByProject: {},
      getNovelChat: (projectId) => get().novelChatsByProject[projectId] || [],
      setNovelChat: (projectId, messages) =>
        set((state) => ({
          novelChatsByProject: { ...state.novelChatsByProject, [projectId]: messages },
        })),
      appendNovelChat: (projectId, message) =>
        set((state) => ({
          novelChatsByProject: {
            ...state.novelChatsByProject,
            [projectId]: [...(state.novelChatsByProject[projectId] || []), message],
          },
        })),
      clearNovelChat: (projectId) =>
        set((state) => {
          const next = { ...state.novelChatsByProject };
          delete next[projectId];
          return { novelChatsByProject: next };
        }),

      // ── Knowledge base ────────────────────────────────────────
      knowledgeBaseEnabled: false,
      embeddingConfig: { ...DEFAULT_EMBEDDING_CONFIG },
      setKnowledgeBaseEnabled: (enabled) => set({ knowledgeBaseEnabled: enabled }),
      setEmbeddingConfig: (config) =>
        set({
          embeddingConfig: {
            apiKey: (config.apiKey || '').trim(),
            apiUrl: (config.apiUrl || DEFAULT_EMBEDDING_CONFIG.apiUrl).trim(),
            model: (config.model || DEFAULT_EMBEDDING_CONFIG.model).trim(),
            dimensions:
              typeof config.dimensions === 'number' && config.dimensions > 0
                ? config.dimensions
                : undefined,
          },
        }),
      updateEmbeddingConfig: (patch) =>
        set((state) => ({
          embeddingConfig: {
            ...state.embeddingConfig,
            ...patch,
          },
        })),

      // KB v2 toggles
      summariesEnabled: false,
      entitiesEnabled: false,
      setSummariesEnabled: (enabled) => set({ summariesEnabled: enabled }),
      setEntitiesEnabled: (enabled) => set({ entitiesEnabled: enabled }),

      // ── Agent 多会话 (multi-session) ────────────────────────────
      agentSessions: {},
      agentSessionOrder: [],
      agentCurrentSessionId: null,
      getAgentSessionMetas: () =>
        get().agentSessionOrder
          .map((id) => get().agentSessions[id])
          .filter((s): s is AgentSession => !!s)
          .map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
      getAgentSession: (id) => get().agentSessions[id],
      ensureAgentSession: () => {
        const st = get();
        const cur = st.agentCurrentSessionId;
        if (cur && st.agentSessions[cur]) return cur;
        const firstId = st.agentSessionOrder.find((id) => st.agentSessions[id]);
        if (firstId) { set({ agentCurrentSessionId: firstId }); return firstId; }
        return get().newAgentSession();
      },
      newAgentSession: () => {
        const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        set((state) => {
          const title = `会话 ${state.agentSessionOrder.length + 1}`;
          const session: AgentSession = { id, title, createdAt: new Date().toISOString(), steps: [], lockedProjectId: null, autoApprove: false };
          return {
            agentSessions: { ...state.agentSessions, [id]: session },
            agentSessionOrder: [id, ...state.agentSessionOrder],
            agentCurrentSessionId: id,
          };
        });
        return id;
      },
      switchAgentSession: (id) => {
        if (get().agentSessions[id]) set({ agentCurrentSessionId: id });
      },
      deleteAgentSession: (id) =>
        set((state) => {
          const sessions = { ...state.agentSessions };
          delete sessions[id];
          const order = state.agentSessionOrder.filter((x) => x !== id);
          const current = state.agentCurrentSessionId === id ? (order[0] ?? null) : state.agentCurrentSessionId;
          return { agentSessions: sessions, agentSessionOrder: order, agentCurrentSessionId: current };
        }),
      renameAgentSession: (id, title) =>
        set((state) => {
          const s = state.agentSessions[id];
          if (!s) return {} as Partial<AppState>;
          return { agentSessions: { ...state.agentSessions, [id]: { ...s, title } } };
        }),
      saveAgentSession: (session) =>
        set((state) => {
          const order = state.agentSessionOrder.includes(session.id)
            ? state.agentSessionOrder
            : [session.id, ...state.agentSessionOrder];
          return {
            agentSessions: { ...state.agentSessions, [session.id]: session },
            agentSessionOrder: order,
            agentCurrentSessionId: session.id,
          };
        }),
      appendAgentStep: (sessionId, step) =>
        set((state) => {
          const sess = state.agentSessions[sessionId];
          if (!sess) return {} as Partial<AppState>;
          return { agentSessions: { ...state.agentSessions, [sessionId]: { ...sess, steps: [...sess.steps, step] } } };
        }),
      patchAgentSession: (sessionId, patch) =>
        set((state) => {
          const sess = state.agentSessions[sessionId];
          if (!sess) return {} as Partial<AppState>;
          return { agentSessions: { ...state.agentSessions, [sessionId]: { ...sess, ...patch } } };
        }),

      // ── Agent run-time (not persisted) ──
      agentStatus: 'idle',
      agentRunSessionId: null,
      agentPendingConfirm: null,
      setAgentStatus: (agentStatus) => set({ agentStatus }),
      setAgentRunSessionId: (agentRunSessionId) => set({ agentRunSessionId }),
      setAgentPendingConfirm: (agentPendingConfirm) => set({ agentPendingConfirm }),
      agentMaxSteps: 40,
      setAgentMaxSteps: (n) => set({ agentMaxSteps: Math.max(5, Math.min(200, Math.floor(Number(n)) || 40)) }),
      chaptersVersion: 0,
      bumpChaptersVersion: () => set((state) => ({ chaptersVersion: state.chaptersVersion + 1 })),
    }),
    {
      name: 'novelseek-storage',
      storage: debouncedIdbStorage as PersistStorage<AppState>,
      version: 14,
      partialize: (state) => ({
        writingWorkspaceByProject: state.writingWorkspaceByProject,
        writingUsageByProject: state.writingUsageByProject,
        sceneWritingByProject: state.sceneWritingByProject,
        generationRunsByProject: state.generationRunsByProject,
        backupExtensions: state.backupExtensions,
        agentEngine: state.agentEngine,
        agentReasoningLevel: state.agentReasoningLevel,
        agentContextBudget: state.agentContextBudget,
        agentSessionMetrics: state.agentSessionMetrics,
        agentSessionContextSummaries: state.agentSessionContextSummaries,
        textModelConfig: state.textModelConfig,
        textModelProfiles: state.textModelProfiles,
        activeTextModelProfileId: state.activeTextModelProfileId,
        pollinationsKey: state.pollinationsKey,
        imageEngine: state.imageEngine,
        comfyUIUrl: state.comfyUIUrl,
        charactersByProject: state.charactersByProject,
        worldSettingByProject: state.worldSettingByProject,
        timelineByProject: state.timelineByProject,
        promoByChapter: state.promoByChapter,
        theme: state.theme,
        uiLanguage: state.uiLanguage,
        folders: state.folders,
        // NOTE: openProjectTabs / tabPathByProject are deliberately NOT persisted — tabs reset each
        // launch (per request), and persisting them made every navigation re-serialize the whole
        // image-heavy store blob (a major page-switch jank source).
        novelTypeByProject: state.novelTypeByProject,
        plotArcsByProject: state.plotArcsByProject,
        longNovelOutlineByProject: state.longNovelOutlineByProject,
        characterRelationshipsByProject: state.characterRelationshipsByProject,
        characterEventsByProject: state.characterEventsByProject,
        cultivationRealmsByProject: state.cultivationRealmsByProject,
        characterRealmEventsByProject: state.characterRealmEventsByProject,
        volumesByProject: state.volumesByProject,
        containersByProject: state.containersByProject,
        characterGrowthByProject: state.characterGrowthByProject,
        novelChatsByProject: state.novelChatsByProject,
        knowledgeBaseEnabled: state.knowledgeBaseEnabled,
        embeddingConfig: state.embeddingConfig,
        summariesEnabled: state.summariesEnabled,
        entitiesEnabled: state.entitiesEnabled,
        agentMaxSteps: state.agentMaxSteps,
        agentSessions: state.agentSessions,
        agentSessionOrder: state.agentSessionOrder,
        agentCurrentSessionId: state.agentCurrentSessionId,
      }),
      migrate: (persistedState: any, version) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState;
        }

        if (version < 13) {
          // Tabs are no longer persisted — drop any leftover copy so old blobs don't restore them once.
          delete persistedState.openProjectTabs;
          delete persistedState.tabPathByProject;
        }

        if (version < 14) {
          for (const field of ['writingWorkspaceByProject', 'writingUsageByProject', 'sceneWritingByProject',
            'generationRunsByProject', 'backupExtensions', 'agentSessionMetrics', 'agentSessionContextSummaries']) {
            if (!persistedState[field] || typeof persistedState[field] !== 'object' || Array.isArray(persistedState[field])) persistedState[field] = {};
          }
          if (persistedState.agentEngine !== 'structured') persistedState.agentEngine = 'legacy';
          if (!['low', 'medium', 'high'].includes(persistedState.agentReasoningLevel)) persistedState.agentReasoningLevel = 'medium';
          if (!Number.isFinite(persistedState.agentContextBudget) || persistedState.agentContextBudget < 2000) persistedState.agentContextBudget = 32_000;
        }

        if (version < 2) {
          const legacyKey =
            typeof persistedState.deepseekKey === 'string' ? persistedState.deepseekKey : '';
          const existingConfig =
            persistedState.textModelConfig && typeof persistedState.textModelConfig === 'object'
              ? persistedState.textModelConfig
              : {};

          persistedState.textModelConfig = {
            provider: normalizeProvider(existingConfig.provider),
            apiKey: (existingConfig.apiKey || legacyKey || '').trim(),
            apiUrl: (existingConfig.apiUrl || 'https://api.deepseek.com/v1').trim(),
            model: (existingConfig.model || 'deepseek-chat').trim(),
            temperature: clampTemperature(
              typeof existingConfig.temperature === 'number' ? existingConfig.temperature : 0.7
            ),
          };

          delete persistedState.deepseekKey;
        }

        if (version < 3) {
          const existingConfig =
            persistedState.textModelConfig && typeof persistedState.textModelConfig === 'object'
              ? persistedState.textModelConfig
              : {};
          const mergedProfiles = mergeProfilesWithBuiltins(
            Array.isArray(persistedState.textModelProfiles) ? persistedState.textModelProfiles : []
          );

          const activeProfile = pickActiveProfile(
            mergedProfiles,
            typeof persistedState.activeTextModelProfileId === 'string'
              ? persistedState.activeTextModelProfileId
              : undefined,
            normalizeProvider(existingConfig.provider)
          );

          const configuredActive = normalizeProfile({
            ...activeProfile,
            id: activeProfile.id,
            apiKey:
              typeof existingConfig.apiKey === 'string'
                ? existingConfig.apiKey
                : activeProfile.apiKey,
            apiUrl:
              typeof existingConfig.apiUrl === 'string'
                ? existingConfig.apiUrl
                : activeProfile.apiUrl,
            model:
              typeof existingConfig.model === 'string'
                ? existingConfig.model
                : activeProfile.model,
            temperature:
              typeof existingConfig.temperature === 'number'
                ? existingConfig.temperature
                : activeProfile.temperature,
          });

          persistedState.textModelProfiles = mergedProfiles.map((profile) =>
            profile.id === configuredActive.id ? configuredActive : profile
          );
          persistedState.activeTextModelProfileId = configuredActive.id;
          persistedState.textModelConfig = toTextModelConfig(configuredActive);
        }

        if (version < 4) {
          persistedState.uiLanguage =
            persistedState.uiLanguage === 'en' || persistedState.uiLanguage === 'zh'
              ? persistedState.uiLanguage
              : getInitialUiLanguage();
        }

        if (version < 5) {
          if (!Array.isArray(persistedState.folders)) {
            persistedState.folders = [];
          }
        }

        if (version < 6) {
          if (!persistedState.imageEngine) {
            persistedState.imageEngine = 'pollinations';
          }
          if (!persistedState.comfyUIUrl) {
            persistedState.comfyUIUrl = 'http://localhost:8188';
          }
        }

        if (version < 7) {
          if (!persistedState.novelTypeByProject) persistedState.novelTypeByProject = {};
          if (!persistedState.plotArcsByProject) persistedState.plotArcsByProject = {};
          if (!persistedState.longNovelOutlineByProject) persistedState.longNovelOutlineByProject = {};
          if (!persistedState.characterRelationshipsByProject) persistedState.characterRelationshipsByProject = {};
          if (!persistedState.characterEventsByProject) persistedState.characterEventsByProject = {};
        }

        if (version < 8) {
          if (typeof persistedState.knowledgeBaseEnabled !== 'boolean') {
            persistedState.knowledgeBaseEnabled = false;
          }
          if (!persistedState.embeddingConfig || typeof persistedState.embeddingConfig !== 'object') {
            persistedState.embeddingConfig = { ...DEFAULT_EMBEDDING_CONFIG };
          } else {
            persistedState.embeddingConfig = {
              apiKey: persistedState.embeddingConfig.apiKey || '',
              apiUrl: persistedState.embeddingConfig.apiUrl || DEFAULT_EMBEDDING_CONFIG.apiUrl,
              model: persistedState.embeddingConfig.model || DEFAULT_EMBEDDING_CONFIG.model,
              dimensions:
                typeof persistedState.embeddingConfig.dimensions === 'number'
                  ? persistedState.embeddingConfig.dimensions
                  : DEFAULT_EMBEDDING_CONFIG.dimensions,
            };
          }
        }

        if (version < 9) {
          if (typeof persistedState.summariesEnabled !== 'boolean') {
            persistedState.summariesEnabled = false;
          }
          if (typeof persistedState.entitiesEnabled !== 'boolean') {
            persistedState.entitiesEnabled = false;
          }
        }

        if (version < 10) {
          if (!persistedState.cultivationRealmsByProject) {
            persistedState.cultivationRealmsByProject = {};
          }
          if (!persistedState.characterRealmEventsByProject) {
            persistedState.characterRealmEventsByProject = {};
          }
        }

        if (version < 11) {
          // New mechanisms ported back from the Android app (NovelSeek-Ultra).
          if (!persistedState.volumesByProject) persistedState.volumesByProject = {};
          if (!persistedState.containersByProject) persistedState.containersByProject = {};
          if (!persistedState.characterGrowthByProject) persistedState.characterGrowthByProject = {};
          if (!persistedState.novelChatsByProject) persistedState.novelChatsByProject = {};
        }

        if (version < 12) {
          // Agent multi-session persistence.
          if (!persistedState.agentSessions || typeof persistedState.agentSessions !== 'object') persistedState.agentSessions = {};
          if (!Array.isArray(persistedState.agentSessionOrder)) persistedState.agentSessionOrder = [];
          if (typeof persistedState.agentCurrentSessionId !== 'string') persistedState.agentCurrentSessionId = null;
        }

        return persistedState;
      },
    }
  )
);

let importMetadataQueue: Promise<void> = Promise.resolve();
/** Writing checkpoints must be durable before the next provider request begins. */
export function flushWritingPersistence(): Promise<void> {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  pendingPersist = null;
  const options = useAppStore.persist.getOptions();
  const current = useAppStore.getState();
  const state = options.partialize ? options.partialize(current) : current;
  return queuedIdbSet(options.name || 'novelseek-storage', JSON.stringify({ state, version: options.version ?? 14 }));
}
/** Strict commit used after SQLite's recovery journal has committed. Never falls back silently. */
export function persistImportedBackupMetadata(patch: Record<string, unknown>): Promise<void> {
  const operation = importMetadataQueue.then(async () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    flushPersist();
    await persistWriteQueue;
    const options = useAppStore.persist.getOptions();
    const merged = { ...useAppStore.getState(), ...patch } as AppState;
    const state = options.partialize ? options.partialize(merged) : merged;
    // Validate/serialize before publishing state. The native journal is retained if IDB fails.
    await queuedIdbSet(options.name || 'novelseek-storage', JSON.stringify({ state, version: options.version ?? 14 }));
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    pendingPersist = null;
    useAppStore.setState(patch as Partial<AppState>);
    try { localStorage.removeItem(options.name || 'novelseek-storage'); } catch { /* legacy cleanup only */ }
  });
  importMetadataQueue = operation.catch(() => undefined);
  return operation;
}
