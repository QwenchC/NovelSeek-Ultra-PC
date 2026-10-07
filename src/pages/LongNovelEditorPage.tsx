import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { WorkspaceChapterEntry } from '../writingUi/WorkspaceChapterEntry';
import { useAppStore } from '@store/index';
import type { PlotArc } from '@store/index';
import { chapterApi, knowledgeApi } from '@services/api';
import { Button } from '@components/Button';
import { CultivationSystemPanel } from '@components/CultivationSystemPanel';
import { MoreMenu, MoreMenuItem } from '@components/MoreMenu';
import { VolumeArcPanel } from '@components/VolumeArcPanel';
import { uiPrompt, uiConfirm } from '@components/uiDialog';
import { CharacterConsistencyPicker, buildCharactersInfo } from '@components/CharacterConsistencyPicker';
import { chapterStructureLabel, stripChapterHeading } from '@utils/index';
import { useSmartBack } from '@utils/useSmartBack';
import { buildRealmSystemContext, buildVolumeRealmConstraint } from '@utils/cultivation';
import { buildGenerationGuidance, runChapterAutoUpdates } from '@utils/containerAi';
import {
  getEditorDraft, setEditorDraftContent, setEditorDraftScroll,
} from '@utils/editorDraftCache';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft, Save, Sparkles, StopCircle, Plus, Layers, Boxes,
  Play, Sunset, Check, ChevronDown, ChevronUp, BookOpen,
  RefreshCw, AlertTriangle, X, Wand2, FileText, Image, Loader2, Edit2,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import type { Chapter } from '@typings/index';
import { tx } from '@utils/i18n';

const TARGET_WORDS = 2500;

function buildArcContext(arcs: PlotArc[], uiLanguage: 'zh' | 'en'): string {
  if (!arcs.length) return '';
  const activeArc = arcs.find((a) => a.status === 'active' || a.status === 'ending');
  const completed = arcs.filter((a) => a.status === 'completed');
  const upcoming = arcs.filter((a) => a.status === 'upcoming');

  if (uiLanguage === 'en') {
    let ctx = '[Story Arc Progress]\n';
    if (completed.length) ctx += `Completed arcs: ${completed.map((a) => a.title).join(' → ')}\n`;
    if (activeArc) {
      ctx += `Current arc: ${activeArc.title}\n`;
      if (activeArc.summary) ctx += `Arc summary: ${activeArc.summary}\n`;
      if (activeArc.status === 'ending') {
        ctx += `⚠ ENDING PHASE: This arc is winding down. Drive the story to a satisfying arc conclusion.\n`;
      } else {
        ctx += `This arc is actively unfolding. Maintain the arc's core conflict and keep plot threads alive.\n`;
      }
    }
    if (upcoming.length) ctx += `Upcoming arcs: ${upcoming.map((a) => a.title).join(', ')}\n`;
    return ctx;
  } else {
    let ctx = '【剧情弧线进度】\n';
    if (completed.length) ctx += `已完成弧线：${completed.map((a) => a.title).join(' → ')}\n`;
    if (activeArc) {
      ctx += `当前弧线：${activeArc.title}\n`;
      if (activeArc.summary) ctx += `弧线概述：${activeArc.summary}\n`;
      if (activeArc.status === 'ending') {
        ctx += `⚠ 结尾阶段：当前弧线进入最后 ${activeArc.chaptersUntilEnd ?? '?'} 章，本章需推动剧情走向本弧线的阶段性收束，但不要仓促。\n`;
      } else {
        ctx += `弧线进行中：维持核心矛盾，推进主线剧情，为后续伏笔做铺垫。\n`;
      }
    }
    if (upcoming.length) ctx += `后续弧线（暂不展开）：${upcoming.map((a) => a.title).join('、')}\n`;
    return ctx;
  }
}

function getPreviousChapterSummary(chapters: Chapter[], currentChapter: Chapter): string {
  const prev = chapters
    .filter((c) => c.order_index < currentChapter.order_index)
    .filter((c) => (c.final_text || c.draft_text || '').trim().length > 0)
    .sort((a, b) => b.order_index - a.order_index)
    .slice(0, 3)
    .reverse();

  if (!prev.length) return '';

  return prev
    .map((c, idx) => {
      const content = (c.final_text || c.draft_text || '').trim();
      const isLast = idx === prev.length - 1;
      const snippet = content.slice(-(isLast ? 1500 : 500));
      const relativeLabel =
        idx === prev.length - 1 ? '紧邻上章' :
        idx === prev.length - 2 ? '两章前' : '更早的章节';
      const goalLine = c.outline_goal ? `（目标：${c.outline_goal}\uff09` : '';
      return `---- ${relativeLabel}「${c.title}」${goalLine} ----\n${snippet}`;
    })
    .join('\n\n');
}

function buildChapterList(chapters: Chapter[], currentChapterId: string): string {
  const sorted = [...chapters].sort((a, b) => a.order_index - b.order_index);
  if (!sorted.length) return '';
  return sorted
    .map((c) => {
      const written = (c.final_text || c.draft_text || '').trim().length > 0;
      const isCurrent = c.id === currentChapterId;
      const flag = isCurrent ? ' ←当前章节' : written ? '' : ' [待写]';
      const words = c.word_count > 0 ? `（${c.word_count}字）` : '';
      const goal = c.outline_goal ? ` — ${c.outline_goal.slice(0, 30)}` : '';
      return `第${c.order_index}章 ${c.title}${words}${goal}${flag}`;
    })
    .join('\n');
}

function parseArcMiniOutline(text: string): { title: string; goal: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(第\d+章|Chapter \d+)/i.test(line))
    .map((line) => {
      const zh = line.match(/^第\d+章[\uff1a:]\s*(.+?)\s*[\u2014\u2013-]+\s*(.+)$/);
      if (zh) return { title: zh[1].trim(), goal: zh[2].trim() };
      const en = line.match(/^Chapter \d+[\uff1a:]\s*(.+?)\s*[\u2014\u2013-]+\s*(.+)$/i);
      if (en) return { title: en[1].trim(), goal: en[2].trim() };
      const simple = line.match(/^(?:第\d+章|Chapter \d+)[\uff1a:]\s*(.+)$/i);
      if (simple) return { title: simple[1].trim(), goal: '' };
      return null;
    })
    .filter(Boolean) as { title: string; goal: string }[];
}

interface PromoResult {
  imagePrompt: string;
  summary: string;
  imageBase64: string | null;
}

interface Illustration {
  id: string;
  anchorIndex: number;
  paragraphIndices: number[];
  prompt: string;
  imageBase64: string;
  createdAt: string;
}

interface IllustrationConfig {
  model: string;
  width: number;
  height: number;
  style: string;
}

export function LongNovelEditorPage() {
  const { id, chapterId } = useParams<{ id: string; chapterId?: string }>();
  const navigate = useNavigate();
  const smartBack = useSmartBack(id ? `/long-novel/${id}` : '/long-novels');
  const {
    textModelConfig, uiLanguage,
    getCharacters, getWorldSetting, getTimeline,
    getPlotArcs, updatePlotArc, getVolumes,
    getLongNovelOutline, projects,
    pollinationsKey, imageEngine, comfyUIUrl,
    getPromo, setPromo,
    knowledgeBaseEnabled, embeddingConfig,
    summariesEnabled, entitiesEnabled,
    getCultivationRealms, getCharacterRealmEvents,
    chaptersVersion,
  } = useAppStore();

  const hasValidEmbeddingConfig = useMemo(
    () =>
      knowledgeBaseEnabled &&
      embeddingConfig.apiKey.trim().length > 0 &&
      embeddingConfig.apiUrl.trim().length > 0 &&
      embeddingConfig.model.trim().length > 0,
    [knowledgeBaseEnabled, embeddingConfig]
  );

  const hasValidTextConfig = useMemo(
    () =>
      textModelConfig.apiKey.trim().length > 0 &&
      textModelConfig.apiUrl.trim().length > 0 &&
      textModelConfig.model.trim().length > 0,
    [textModelConfig]
  );

  const [allChapters, setAllChapters] = useState<Chapter[]>([]);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [content, setContent] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selection-based polish (mirrors short-novel EditorPage): select text → floating button → AI revises in place.
  const [revisionSelection, setRevisionSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const [revisionButtonPos, setRevisionButtonPos] = useState<{ x: number; y: number } | null>(null);
  const [isRevising, setIsRevising] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  // New chapter form
  const [showNewChapterForm, setShowNewChapterForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [newConflict, setNewConflict] = useState('');
  // Which arc the new chapter belongs to ('' = global end / unassigned). New chapter is inserted
  // right AFTER this arc's current last chapter.
  const [newChapterArcId, setNewChapterArcId] = useState('');

  // Arc panel
  const [arcPanelOpen, setArcPanelOpen] = useState(true);
  // Chapter planning panel (本章目标 / 核心冲突) for the current chapter
  const [showPlanning, setShowPlanning] = useState(false);

  // Arc mini-outline generation
  const [arcMiniOutlineText, setArcMiniOutlineText] = useState('');
  const [isGenMiniOutline, setIsGenMiniOutline] = useState(false);
  const arcMiniOutlineCancelRef = useRef(false);
  const arcMiniOutlineTextRef = useRef('');
  // IDs of chapters created by the most recent handleBuildArcChapters call
  const [arcBuiltChapterIds, setArcBuiltChapterIds] = useState<string[]>([]);
  // Default chapter count for the arc mini-outline build (the activation form was removed).
  const arcChapterCountInput = '8';

  // AI助填
  const [showAiFillDialog, setShowAiFillDialog] = useState(false);
  const [aiFillUserReq, setAiFillUserReq] = useState('');
  const [isAiFilling, setIsAiFilling] = useState(false);
  const [aiFillText, setAiFillText] = useState('');
  const aiFillCancelRef = useRef(false);
  const aiFillTextRef = useRef('');

  // Arc detail
  const [arcDetailOpen, setArcDetailOpen] = useState(false);

  // Promo (chapter cover / 推文)
  const [promoResult, setPromoResult] = useState<PromoResult | null>(null);
  const [isPromoExpanded, setIsPromoExpanded] = useState(false);
  const [isGeneratingPromo, setIsGeneratingPromo] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoStyle, setPromoStyle] = useState('cinematic');
  const [showPromoConfig, setShowPromoConfig] = useState(false);
  const [showCultivationModal, setShowCultivationModal] = useState(false);

  // Illustrations
  const [isIllustrationMode, setIsIllustrationMode] = useState(false);
  const [selectedParagraphs, setSelectedParagraphs] = useState<Set<number>>(new Set());
  const [illustrations, setIllustrations] = useState<Illustration[]>([]);
  const [activeIllustrationId, setActiveIllustrationId] = useState<string | null>(null);
  const [illustrationError, setIllustrationError] = useState<string | null>(null);
  const [isGeneratingIllustration, setIsGeneratingIllustration] = useState(false);
  const [anchorEdits, setAnchorEdits] = useState<Record<string, string>>({});
  const [showIllustrationConfig, setShowIllustrationConfig] = useState(false);
  const [illustrationConfig, setIllustrationConfig] = useState<IllustrationConfig>({
    model: 'zimage', width: 1920, height: 1080, style: '',
  });
  const [illustrationConfigDraft, setIllustrationConfigDraft] = useState<IllustrationConfig>({
    model: 'zimage', width: 1920, height: 1080, style: '',
  });
  // Character-consistency selection for image generation (illustration / promo dialogs).
  const [imageCharIds, setImageCharIds] = useState<Set<string>>(new Set());
  const toggleImageChar = (cid: string) =>
    setImageCharIds((prev) => { const next = new Set(prev); if (next.has(cid)) next.delete(cid); else next.add(cid); return next; });

  const cancelRef = useRef(false);

  // ── Selection-based polish (mirror of short-novel EditorPage) ──
  /** Compute the on-screen pixel position of the caret at `position` inside a textarea (mirror div trick). */
  const getCaretClientPosition = (textarea: HTMLTextAreaElement, position: number) => {
    const div = document.createElement('div');
    const style = window.getComputedStyle(textarea);
    const properties = [
      'direction', 'box-sizing', 'width', 'height', 'overflow-x', 'overflow-y',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size',
      'line-height', 'font-family', 'text-align', 'text-transform', 'text-indent',
      'text-decoration', 'letter-spacing', 'word-spacing', 'tab-size', '-moz-tab-size',
    ];
    properties.forEach((prop) => {
      const value = style.getPropertyValue(prop);
      if (value) div.style.setProperty(prop, value);
    });
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordWrap = 'break-word';
    div.style.top = '0';
    div.style.left = '-9999px';
    div.textContent = textarea.value.substring(0, position);
    const span = document.createElement('span');
    span.textContent = textarea.value.substring(position) || '.';
    div.appendChild(span);
    document.body.appendChild(div);
    const rect = span.getBoundingClientRect();
    const divRect = div.getBoundingClientRect();
    const top = rect.top - divRect.top;
    const left = rect.left - divRect.left;
    document.body.removeChild(div);
    const textareaRect = textarea.getBoundingClientRect();
    return {
      left: textareaRect.left + left - textarea.scrollLeft,
      top: textareaRect.top + top - textarea.scrollTop,
      height: rect.height || parseFloat(style.lineHeight) || 16,
    };
  };

  const updateRevisionSelection = () => {
    const textarea = textareaRef.current;
    const container = editorContainerRef.current;
    if (!textarea || !container) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (start === end) { setRevisionSelection(null); setRevisionButtonPos(null); return; }
    const selectedText = textarea.value.slice(start, end);
    if (!selectedText.trim()) { setRevisionSelection(null); setRevisionButtonPos(null); return; }
    const caret = getCaretClientPosition(textarea, end);
    const containerRect = container.getBoundingClientRect();
    const x = Math.min(Math.max(caret.left - containerRect.left, 8), containerRect.width - 40);
    const y = Math.min(Math.max(caret.top - containerRect.top - 36, 8), containerRect.height - 40);
    setRevisionSelection({ start, end, text: selectedText });
    setRevisionButtonPos({ x, y });
  };

  const handlePolishSelection = async () => {
    if (!revisionSelection) return;
    if (!hasValidTextConfig) {
      setError(tx(uiLanguage, '请先在设置页面配置文本模型 API 密钥', 'Configure text model API key in Settings first'));
      return;
    }
    setIsRevising(true);
    const { start, end, text } = revisionSelection;
    try {
      const revised = await invoke<string>('generate_revision', {
        input: {
          text,
          goals: tx(uiLanguage, '润色并保持原意，使表达更自然流畅', 'Polish while preserving the meaning; make it read more naturally'),
          text_config: textModelConfig,
        },
      });
      setContent((prev) => prev.slice(0, start) + revised + prev.slice(end));
      setIsSaved(false);
      setRevisionSelection(null);
      setRevisionButtonPos(null);
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        const nextPos = start + revised.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextPos, nextPos);
      });
    } catch (err) {
      const message = typeof err === 'string' ? err : (err as Error)?.message || tx(uiLanguage, '润色失败', 'Polish failed');
      setError(message);
    } finally {
      setIsRevising(false);
    }
  };

  const arcs = id ? getPlotArcs(id) : [];
  const volumes = id ? getVolumes(id) : [];
  const activeArc = arcs.find((a) => a.status === 'active' || a.status === 'ending');
  const sortedArcs = [...arcs].sort((a, b) => a.order - b.order);
  const currentProjectMeta = projects.find((p) => p.id === id);
  const projectTitle = currentProjectMeta?.title || '';

  const paragraphs = useMemo(() => {
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    return normalized.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  }, [content]);

  const selectedIndices = useMemo(
    () => Array.from(selectedParagraphs).sort((a, b) => a - b),
    [selectedParagraphs]
  );

  const illustrationsByAnchor = useMemo(() => {
    const map = new Map<number, Illustration[]>();
    for (const item of illustrations) {
      const list = map.get(item.anchorIndex) || [];
      list.push(item);
      map.set(item.anchorIndex, list);
    }
    return map;
  }, [illustrations]);

  const parseIllustrations = (raw?: string | null): Illustration[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => ({
          id: String(item.id || `ill-${Date.now()}`),
          anchorIndex: Number(item.anchorIndex) || 1,
          paragraphIndices: Array.isArray(item.paragraphIndices)
            ? item.paragraphIndices.map((n: number) => Number(n)).filter((n: number) => !Number.isNaN(n))
            : [],
          prompt: String(item.prompt || ''),
          imageBase64: String(item.imageBase64 || ''),
          createdAt: String(item.createdAt || new Date().toISOString()),
        }))
        .filter((item) => item.imageBase64);
    } catch {
      return [];
    }
  };

  // Restore persisted mini-outline state when the active arc changes
  useEffect(() => {
    const saved = activeArc?.miniOutline || '';
    const savedIds = activeArc?.builtChapterIds || [];
    setArcMiniOutlineText(saved);
    arcMiniOutlineTextRef.current = saved;
    setArcBuiltChapterIds(savedIds);
    setIsGenMiniOutline(false);
  }, [activeArc?.id]);

  useEffect(() => {
    if (!id) return;
    chapterApi.getByProject(id).then((data) => {
      const sorted = data.sort((a, b) => a.order_index - b.order_index);
      setAllChapters(sorted);
      if (chapterId) {
        const found = sorted.find((c) => c.id === chapterId);
        if (found) {
          setChapter(found);
          // Restore unsaved in-progress text from a previous tab visit; otherwise load from disk
          // (so a chapter with no local edits still picks up background/agent changes).
          const draft = getEditorDraft(chapterId);
          if (draft?.dirty) {
            setContent(draft.content);
            setIsSaved(false);
          } else {
            setContent(found.final_text || found.draft_text || '');
            setIsSaved(true);
          }
          setIllustrations(parseIllustrations(found.illustrations));
          const savedPromo = getPromo(chapterId);
          setPromoResult(savedPromo || null);
          setIsPromoExpanded(false);
          setSelectedParagraphs(new Set());
          setActiveIllustrationId(null);
          // Restore the editor scroll position once the textarea has rendered the content.
          const top = draft?.scrollTop ?? 0;
          requestAnimationFrame(() => { if (textareaRef.current) textareaRef.current.scrollTop = top; });
        }
      }
    });
  }, [id, chapterId]);

  // Mirror the editor's text + unsaved flag into the per-chapter draft cache, so switching to another
  // tab and back restores exactly what was on screen. Captures every source that sets `content`
  // (typing, AI streaming, polish, generation), since it keys off the `content`/`isSaved` state.
  useEffect(() => {
    const cid = chapter?.id;
    if (!cid) return;
    setEditorDraftContent(cid, content, !isSaved);
  }, [content, isSaved, chapter?.id]);

  // Live-refresh the chapter LIST when chapters change elsewhere (e.g. the background agent creates
  // or generates chapters). Only touches the list — never the open chapter's editing state.
  useEffect(() => {
    if (!id || chaptersVersion === 0) return;
    let cancelled = false;
    chapterApi.getByProject(id).then((data) => {
      if (cancelled) return;
      setAllChapters(data.sort((a, b) => a.order_index - b.order_index));
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaptersVersion]);

  const handleSelectChapter = async (ch: Chapter) => {
    if (!isSaved) {
      const ok = await uiConfirm({
        title: tx(uiLanguage, '切换章节', 'Switch chapter'),
        message: tx(uiLanguage, '有未保存的内容，确定切换章节吗？', 'You have unsaved changes. Switch chapter anyway?'),
      });
      if (!ok) return;
    }
    navigate(`/long-novel/${id}/editor/${ch.id}`, { replace: true });
    setChapter(ch);
    const draft = getEditorDraft(ch.id);
    if (draft?.dirty) {
      setContent(draft.content);
      setIsSaved(false);
    } else {
      setContent(ch.final_text || ch.draft_text || '');
      setIsSaved(true);
    }
    setIllustrations(parseIllustrations(ch.illustrations));
    const savedPromo = getPromo(ch.id);
    setPromoResult(savedPromo || null);
    setIsPromoExpanded(false);
    setSelectedParagraphs(new Set());
    setActiveIllustrationId(null);
    setError(null);
    const top = draft?.scrollTop ?? 0;
    requestAnimationFrame(() => { if (textareaRef.current) textareaRef.current.scrollTop = top; });
  };

  const renameChapterInList = async (ch: Chapter) => {
    const title = await uiPrompt({
      title: tx(uiLanguage, '章节重命名', 'Rename chapter'),
      label: tx(uiLanguage, '章节标题', 'Chapter title'),
      defaultValue: ch.title,
    });
    if (!title?.trim()) return;
    const t = title.trim();
    await chapterApi.updateMeta(ch.id, { title: t });
    setAllChapters((prev) => prev.map((c) => (c.id === ch.id ? { ...c, title: t } : c)));
    setChapter((prev) => (prev && prev.id === ch.id ? { ...prev, title: t } : prev));
  };

  const handleCreateChapter = async () => {
    if (!id || !newTitle.trim()) return;
    const maxOrder = allChapters.length > 0 ? Math.max(...allChapters.map((c) => c.order_index)) : 0;

    // Decide where the new chapter goes. If an arc is selected, insert right AFTER that arc's
    // current last chapter; otherwise append to the global end.
    const targetArc = newChapterArcId ? arcs.find((a) => a.id === newChapterArcId) : undefined;
    let insertAfterOrder = maxOrder;
    if (targetArc) {
      const builtIds = new Set(targetArc.builtChapterIds || []);
      const arcChapters = allChapters.filter((c) => c.arc_id === targetArc.id || builtIds.has(c.id));
      if (arcChapters.length > 0) {
        insertAfterOrder = Math.max(...arcChapters.map((c) => c.order_index));
      } else {
        // Empty arc: place after the last chapter of all arcs ordered before this one.
        const precedingArcIds = new Set(arcs.filter((a) => a.order <= targetArc.order).map((a) => a.id));
        const preceding = allChapters.filter((c) => c.arc_id && precedingArcIds.has(c.arc_id));
        insertAfterOrder = preceding.length > 0 ? Math.max(...preceding.map((c) => c.order_index)) : maxOrder;
      }
    }
    const newOrder = insertAfterOrder + 1;

    // Shift every existing chapter at/after the insertion slot down by one (skip when appending).
    if (newOrder <= maxOrder) {
      const toShift = allChapters
        .filter((c) => c.order_index >= newOrder)
        .sort((a, b) => b.order_index - a.order_index); // high → low to avoid transient collisions
      for (const c of toShift) {
        await chapterApi.updateMeta(c.id, { order_index: c.order_index + 1 });
      }
    }

    const newChapter = await chapterApi.create({
      project_id: id,
      title: newTitle.trim(),
      order_index: newOrder,
      outline_goal: newGoal || undefined,
      conflict: newConflict || undefined,
    });
    // Associate the new chapter with the selected arc (arc_id + arc.builtChapterIds).
    if (targetArc) {
      await chapterApi.updateMeta(newChapter.id, { arc_id: targetArc.id });
      const existingBuilt = targetArc.builtChapterIds || [];
      if (!existingBuilt.includes(newChapter.id)) {
        updatePlotArc(id, targetArc.id, { builtChapterIds: [...existingBuilt, newChapter.id] });
      }
    }

    const updated = await chapterApi.getByProject(id);
    setAllChapters(updated.sort((a, b) => a.order_index - b.order_index));
    setShowNewChapterForm(false);
    setNewTitle('');
    setNewGoal('');
    setNewConflict('');
    setNewChapterArcId('');
    const created = updated.find((c) => c.id === newChapter.id) || newChapter;
    handleSelectChapter(created);
  };

  const openNewChapterForm = () => {
    // Default the arc to the currently active arc (if any) so新章 lands in the arc being written.
    setNewChapterArcId(activeArc?.id || '');
    setShowNewChapterForm(true);
  };

  const handleSave = async () => {
    if (!chapter) return;
    setIsSaving(true);
    try {
      const illustrationsPayload = JSON.stringify(illustrations);
      await chapterApi.update(chapter.id, content, content, illustrationsPayload);
      // Persist the chapter plan (标题 / 本章目标 / 核心冲突) edited in the planning panel.
      await chapterApi.updateMeta(chapter.id, {
        title: chapter.title,
        outline_goal: chapter.outline_goal ?? '',
        conflict: chapter.conflict ?? '',
      });
      setIsSaved(true);
      const wordCount = content.trim() ? content.trim().replace(/\s+/g, '').length : 0;
      const updated: Chapter = { ...chapter, final_text: content, draft_text: content, word_count: wordCount, illustrations: illustrationsPayload };
      setChapter(updated);
      setAllChapters((prev) => prev.map((c) => c.id === chapter.id ? updated : c));

      // Fire-and-forget: index this chapter into the local knowledge base.
      // Idempotent — KnowledgeService skips if content hash unchanged.
      if (hasValidEmbeddingConfig && id && content.trim().length > 200) {
        const projectId = id;
        const chapterId = chapter.id;
        const chapterTitle = chapter.title;
        const chapterText = content;

        knowledgeApi
          .indexChapter({
            projectId,
            chapterId,
            text: chapterText,
            embeddingConfig,
          })
          .then((r) => {
            if (!r.skipped) {
              console.info(`[KB] Indexed ${r.chunksIndexed} chunks for chapter ${chapterId}`);
            }
          })
          .catch((e) => {
            console.warn('[KB] Index failed:', e);
          });

        // v2.0: chapter summary + mark arc/book rollups stale (fire-and-forget).
        // Skipped silently if textConfig is incomplete.
        if (summariesEnabled && textModelConfig.apiKey.trim()) {
          knowledgeApi
            .generateChapterSummary({
              projectId,
              chapterId,
              chapterTitle,
              chapterText,
              textConfig: textModelConfig,
              embeddingConfig,
            })
            .then((s) =>
              console.info(`[KB] Chapter summary updated (${s.wordCount} chars)`)
            )
            .catch((e) => console.warn('[KB] Chapter summary failed:', e));

          knowledgeApi
            .markRollupsStale(projectId)
            .catch((e) => console.warn('[KB] Mark stale failed:', e));
        }

        // v2.1: entity extraction (fire-and-forget).
        if (entitiesEnabled && textModelConfig.apiKey.trim()) {
          const knownCharacterNames = getCharacters(projectId).map((c) => c.name).filter(Boolean);
          knowledgeApi
            .extractEntities({
              projectId,
              chapterId,
              chapterTitle,
              chapterText,
              knownCharacterNames,
              textConfig: textModelConfig,
              embeddingConfig,
            })
            .then((stats) =>
              console.info(
                `[KB] Entities: +${stats.charactersAdded}c +${stats.foreshadowingAdded}f +${stats.locationsAdded}l +${stats.eventsAdded}e +${stats.itemsAdded}i`
              )
            )
            .catch((e) => console.warn('[KB] Entity extraction failed:', e));
        }
      }

      // Container (容器) + character-growth (成长路线) per-chapter AI auto-update.
      // Fire-and-forget: evolves every autoUpdatePerChapter container and any started growth route.
      if (hasValidTextConfig && id && content.trim().length > 200) {
        runChapterAutoUpdates({
          projectId: id,
          chapterId: chapter.id,
          chapterOrder: chapter.order_index,
          chapterTitle: chapter.title,
          chapterText: content,
          textConfig: textModelConfig,
          uiLanguage,
        }).catch((e) => console.warn('[Container/Growth] auto-update failed:', e));
      }
    } catch {
      setError(tx(uiLanguage, '保存失败', 'Save failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleGenerate = async () => {
    if (!chapter || !id || !hasValidTextConfig) return;
    cancelRef.current = false;
    setIsGenerating(true);
    setError(null);

    const characters = getCharacters(id);
    const worldSetting = getWorldSetting(id);
    const timeline = getTimeline(id);
    const arcContext = buildArcContext(sortedArcs, uiLanguage);
    const previousSummary = getPreviousChapterSummary(allChapters, chapter);
    const chapterList = buildChapterList(allChapters, chapter.id);
    const realmContext = buildRealmSystemContext(
      getCultivationRealms(id),
      characters,
      getCharacterRealmEvents(id),
      allChapters,
      { uiLanguage }
    );

    const charactersInfo = characters.length > 0
      ? characters.map((c) => {
          const parts = [
            `【${c.name}】`,
            c.gender ? `- 性别：${c.gender}` : '',
            c.role ? `- 身份：${c.role}` : '',
            c.personality ? `- 性格：${c.personality}` : '',
            c.appearance ? `- 形象：${c.appearance}` : '',
            c.motivation ? `- 动机：${c.motivation}` : '',
          ].filter(Boolean);
          return parts.join('\n');
        }).join('\n\n')
      : undefined;

    // Combine arc context + realm system + world setting.
    // Realm context goes BEFORE worldSetting so the LLM treats it as a foundational
    // power-scaling rule, not a footnote.
    // Soft guidance from containers flagged "affects chapter generation" + latest character growth.
    const containerGuidance = buildGenerationGuidance(id, 'chapter', uiLanguage);

    // Per-volume realm ceiling (hard limit) for THIS chapter's owning volume — prevents over-leveling /
    // skips / drops across the volume. Goes right after the realm ladder so it reads as the binding rule.
    const genArc = chapter.arc_id
      ? sortedArcs.find((a) => a.id === chapter.arc_id)
      : sortedArcs.find((a) => (a.builtChapterIds || []).includes(chapter.id));
    const genVol = genArc?.volumeId ? volumes.find((v) => v.id === genArc.volumeId) : undefined;
    const volRealmConstraint = genVol
      ? buildVolumeRealmConstraint(genVol.realmPlan, genVol.name, uiLanguage, 'generate')
      : '';

    const worldParts: string[] = [];
    if (arcContext) worldParts.push(arcContext);
    if (realmContext) worldParts.push(realmContext);
    if (volRealmConstraint) worldParts.push(volRealmConstraint);
    if (containerGuidance) worldParts.push(containerGuidance);
    if (worldSetting) worldParts.push(worldSetting);
    const combinedWorldSetting = worldParts.length > 0 ? worldParts.join('\n\n') : undefined;

    // Long-range semantic retrieval (RAG). Runs in parallel with stream setup.
    // Falls through silently on error — legacy "last 3 chapters" context still applies.
    let longRangeContext = '';
    if (hasValidEmbeddingConfig && id) {
      try {
        const queryParts = [
          chapter.title,
          chapter.outline_goal,
          chapter.conflict,
          activeArc?.summary,
          activeArc?.title ? `当前弧线：${activeArc.title}` : '',
        ].filter((s): s is string => Boolean(s && s.trim()));
        const query = queryParts.join('\n');

        // Exclude the 3 most recent written chapters — they're already in `previousSummary`.
        const recentIds = [...allChapters]
          .filter((c) => (c.final_text || c.draft_text || '').trim().length > 0)
          .sort((a, b) => b.order_index - a.order_index)
          .slice(0, 3)
          .map((c) => c.id);

        longRangeContext = await knowledgeApi.retrieveContext({
          projectId: id,
          query,
          topK: 5,
          excludeChapterIds: recentIds,
          embeddingConfig,
          includeSummaries: summariesEnabled,
          activeArcId: activeArc?.id,
          includeForeshadowing: entitiesEnabled,
        });
      } catch (e) {
        console.warn('[KB] Retrieve failed, falling back to legacy context only:', e);
      }
    }

    const enrichedWorldSetting = longRangeContext
      ? `${combinedWorldSetting || ''}\n\n【长程相关记忆】\n${longRangeContext}`.trim()
      : combinedWorldSetting;

    const isContinuation = content.trim().length > 0;

    const unlisten = await listen<string>('chapter-stream', (event) => {
      if (cancelRef.current) return;
      if (isContinuation) {
        setContent((prev) => prev + event.payload);
      } else {
        setContent((prev) => prev + event.payload);
      }
    });

    if (!isContinuation) setContent('');

    try {
      await invoke('generate_chapter_stream', {
        chapterTitle: chapter.title,
        outlineGoal: chapter.outline_goal || '',
        conflict: chapter.conflict || '',
        previousSummary: previousSummary || undefined,
        currentContent: isContinuation ? content : undefined,
        chapterList: chapterList || undefined,
        charactersInfo,
        worldSetting: enrichedWorldSetting,
        timeline: timeline || undefined,
        targetWords: TARGET_WORDS,
        isContinuation,
        outputLanguage: uiLanguage,
        textConfig: textModelConfig,
      });

      // Strip a stray leading title/number the model may have prepended (fresh generation only).
      if (!isContinuation && !cancelRef.current) {
        setContent((prev) => stripChapterHeading(prev, chapter.title));
      }

      // Auto-decrement ending countdown if in ending phase
      if (activeArc?.status === 'ending' && id) {
        const remaining = (activeArc.chaptersUntilEnd ?? 1) - 1;
        if (remaining <= 0) {
          updatePlotArc(id, activeArc.id, { chaptersUntilEnd: 0 });
        } else {
          updatePlotArc(id, activeArc.id, { chaptersUntilEnd: remaining });
        }
      }
    } catch (e: unknown) {
      if (!cancelRef.current) {
        setError(typeof e === 'string' ? e : tx(uiLanguage, '生成失败', 'Generation failed'));
      }
    } finally {
      unlisten();
      setIsGenerating(false);
      setIsSaved(false);
    }
  };

  const handleCancel = async () => {
    cancelRef.current = true;
    try { await invoke('cancel_generation'); } catch {}
    setIsGenerating(false);
  };

  const handleOpenAiFill = () => {
    if (activeArc?.status === 'ending') {
      const pre = uiLanguage === 'zh'
        ? `本章需要推进弧线「${activeArc.title}」走向阶段性收束。\n${activeArc.summary ? `弧线概述：${activeArc.summary}` : ''}`.trim()
        : `This chapter should drive arc "${activeArc.title}" toward its conclusion.\n${activeArc.summary ? `Arc summary: ${activeArc.summary}` : ''}`.trim();
      setAiFillUserReq(pre);
    } else {
      setAiFillUserReq('');
    }
    setAiFillText('');
    setIsAiFilling(false);
    setShowAiFillDialog(true);
  };

  const handleAiFill = async () => {
    if (!hasValidTextConfig) return;
    aiFillCancelRef.current = false;
    aiFillTextRef.current = '';
    setAiFillText('');
    setIsAiFilling(true);

    // Build context from last 3 written chapters
    const recentChapters = [...allChapters]
      .sort((a, b) => b.order_index - a.order_index)
      .filter((c) => (c.final_text || c.draft_text || '').trim().length > 0)
      .slice(0, 3)
      .reverse();
    const previousSummary = recentChapters
      .map((c, idx) => {
        const txt = (c.final_text || c.draft_text || '').trim();
        const isLast = idx === recentChapters.length - 1;
        return `【${c.title}${isLast ? '结尾' : '片段'}】\n${txt.slice(-(isLast ? 1500 : 400))}`;
      })
      .join('\n\n');

    const nextIndex = allChapters.length > 0
      ? Math.max(...allChapters.map((c) => c.order_index)) + 1
      : 1;
    const rawArcContext = buildArcContext(sortedArcs, uiLanguage);
    const realmCtxForFill = id
      ? buildRealmSystemContext(
          getCultivationRealms(id),
          getCharacters(id),
          getCharacterRealmEvents(id),
          allChapters,
          { uiLanguage }
        )
      : '';

    // Ground the plan in the full project context, or it will mislead chapter generation:
    // 大纲 + 所属副本/弧线（含细纲）+ 容器手动知识库 + 本地知识库索引检索 + 境界体系。
    const targetArc = (newChapterArcId ? arcs.find((x) => x.id === newChapterArcId) : null) || activeArc || null;
    const outlineText = id ? getLongNovelOutline(id).slice(0, 2000) : '';
    const containerGuidance = id ? buildGenerationGuidance(id, 'chapter', uiLanguage) : '';
    let volArcBlock = '';
    let volRealmConstraint = '';
    if (id && targetArc) {
      const vol = targetArc.volumeId ? getVolumes(id).find((v) => v.id === targetArc.volumeId) : undefined;
      volArcBlock = [
        vol && tx(uiLanguage, `所属副本：${vol.name}${vol.description ? `——${vol.description}` : ''}`, `Volume: ${vol.name}${vol.description ? ` — ${vol.description}` : ''}`),
        tx(uiLanguage, `目标弧线：${targetArc.title}`, `Target arc: ${targetArc.title}`),
        targetArc.summary && tx(uiLanguage, `弧线概述：${targetArc.summary}`, `Arc summary: ${targetArc.summary}`),
        targetArc.miniOutline && tx(uiLanguage, `弧线细纲：\n${targetArc.miniOutline.slice(0, 800)}`, `Arc mini-outline:\n${targetArc.miniOutline.slice(0, 800)}`),
      ].filter(Boolean).join('\n');
      if (vol) volRealmConstraint = buildVolumeRealmConstraint(vol.realmPlan, vol.name, uiLanguage, 'plan');
    }
    // Local knowledge base (embedding index) retrieval when configured.
    let kbContext = '';
    if (id && hasValidEmbeddingConfig) {
      const query = [aiFillUserReq, targetArc?.title, targetArc?.summary].filter(Boolean).join(' ').slice(0, 400)
        || tx(uiLanguage, `第${nextIndex}章 剧情规划`, `chapter ${nextIndex} planning`);
      try {
        kbContext = await knowledgeApi.retrieveContext({
          projectId: id, query, topK: 6, excludeChapterIds: [],
          embeddingConfig, includeSummaries: summariesEnabled, includeForeshadowing: true,
        });
      } catch (err) { console.warn('KB retrieve for plan failed', err); }
    }

    const arcContext = [
      outlineText && tx(uiLanguage, `【大纲】\n${outlineText}`, `[Outline]\n${outlineText}`),
      volArcBlock,
      rawArcContext,
      realmCtxForFill,
      volRealmConstraint,
      containerGuidance,
      kbContext && tx(uiLanguage, `【相关记忆 / 知识库检索】\n${kbContext}`, `[Retrieved memory / knowledge base]\n${kbContext}`),
    ].filter((x) => x && x.trim()).join('\n\n');

    const unlisten = await listen<string>('chapter-outline-stream', (e) => {
      if (aiFillCancelRef.current) return;
      aiFillTextRef.current += e.payload;
      setAiFillText(aiFillTextRef.current);
    });
    try {
      await invoke('generate_chapter_outline_stream', {
        previousSummary,
        userRequirements: aiFillUserReq,
        arcContext,
        chapterIndex: nextIndex,
        outputLanguage: uiLanguage,
        textConfig: textModelConfig,
      });
      // Parse and apply result
      const raw = aiFillTextRef.current;
      const titleMatch = raw.match(/(?:标题|Title)[：:＊*\s]*(.+)/i);
      const goalMatch = raw.match(/(?:目标|Goal)[：:＊*\s]*(.+)/i);
      const conflictMatch = raw.match(/(?:冲突|Conflict)[：:＊*\s]*(.+)/i);
      if (titleMatch?.[1]?.trim()) setNewTitle(titleMatch[1].trim());
      if (goalMatch?.[1]?.trim()) setNewGoal(goalMatch[1].trim());
      if (conflictMatch?.[1]?.trim()) setNewConflict(conflictMatch[1].trim());
      setShowAiFillDialog(false);
    } catch (e) {
      console.error('AI fill failed', e);
    } finally {
      unlisten();
      setIsAiFilling(false);
    }
  };

  const handleCompleteArc = () => {
    if (!id || !activeArc) return;
    updatePlotArc(id, activeArc.id, { status: 'completed', chaptersUntilEnd: undefined });
    // Next arc stays 'upcoming'; user manually enters it from the arc list
  };

  const handleGenerateMiniOutline = async () => {
    if (!id || !activeArc || !hasValidTextConfig) return;
    setIsGenMiniOutline(true);
    setArcMiniOutlineText('');
    arcMiniOutlineCancelRef.current = false;
    arcMiniOutlineTextRef.current = '';
    setArcBuiltChapterIds([]);
    if (id && activeArc) updatePlotArc(id, activeArc.id, { miniOutline: '', builtChapterIds: [] });

    const rawProjectOutline = getLongNovelOutline(id);
    const realmCtxForArcOutline = buildRealmSystemContext(
      getCultivationRealms(id),
      getCharacters(id),
      getCharacterRealmEvents(id),
      allChapters,
      { uiLanguage }
    );
    // This arc's owning volume realm ceiling — the mini-outline sets the breakthrough pacing for the whole
    // arc, so the hard limit must be present here or the per-chapter goals will already drift.
    const arcVol = activeArc.volumeId ? getVolumes(id).find((v) => v.id === activeArc.volumeId) : undefined;
    const arcVolRealmConstraint = arcVol
      ? buildVolumeRealmConstraint(arcVol.realmPlan, arcVol.name, uiLanguage, 'plan')
      : '';
    const projectOutline = [rawProjectOutline, realmCtxForArcOutline, arcVolRealmConstraint]
      .filter((x) => x && x.trim()).join('\n\n');
    const maxExistingOrder = allChapters.length > 0
      ? Math.max(...allChapters.map((c) => c.order_index))
      : 0;
    const startChapterNumber = maxExistingOrder + 1;
    const prevContext = sortedChapters
      .slice(-5)
      .map((c) => `第${c.order_index}章《${c.title}》：${c.outline_goal || '(无目标)'}`)
      .join('\n');

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<string>('arc-mini-outline-stream', (event) => {
        if (arcMiniOutlineCancelRef.current) return;
        arcMiniOutlineTextRef.current += event.payload;
        setArcMiniOutlineText(arcMiniOutlineTextRef.current);
      });
      await invoke('generate_arc_mini_outline_stream', {
        projectTitle,
        projectOutline,
        arcTitle: activeArc.title,
        arcSummary: activeArc.summary || '',
        chapterCount: activeArc.chapterCount || parseInt(arcChapterCountInput, 10) || 8,
        startChapterNumber,
        prevChaptersContext: prevContext,
        outputLanguage: uiLanguage,
        textConfig: textModelConfig,
      });
    } catch (e) {
      if (!arcMiniOutlineCancelRef.current) console.error('Arc mini outline failed', e);
    } finally {
      unlisten?.();
      setIsGenMiniOutline(false);
      // Persist the finished outline (or partial if cancelled)
      if (id && activeArc && arcMiniOutlineTextRef.current) {
        updatePlotArc(id, activeArc.id, { miniOutline: arcMiniOutlineTextRef.current, builtChapterIds: [] });
      }
    }
  };

  const handleBuildArcChapters = async () => {
    if (!id || !arcMiniOutlineText) return;
    const parsed = parseArcMiniOutline(arcMiniOutlineText);
    if (!parsed.length) return;
    const maxOrder = allChapters.length > 0
      ? Math.max(...allChapters.map((c) => c.order_index))
      : 0;
    const newChapters: Chapter[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const ch = await chapterApi.create({
        project_id: id,
        title: parsed[i].title,
        order_index: maxOrder + i + 1,
        outline_goal: parsed[i].goal || undefined,
      });
      newChapters.push(ch);
    }
    setAllChapters((prev) => [...prev, ...newChapters]);
    const builtIds = newChapters.map((c) => c.id);
    setArcBuiltChapterIds(builtIds);
    if (id && activeArc) updatePlotArc(id, activeArc.id, { builtChapterIds: builtIds });
    if (newChapters.length > 0) {
      navigate(`/long-novel/${id}/editor/${newChapters[0].id}`);
    }
  };

  // "完成此弧线" is only allowed once: mini-outline exists, chapters were built,
  // AND at least one of those built chapters already has written content.
  const canCompleteArc = useMemo(() => {
    if (!arcMiniOutlineText) return false;
    if (arcBuiltChapterIds.length === 0) return false;
    return arcBuiltChapterIds.some((chId) => {
      const ch = allChapters.find((c) => c.id === chId);
      return ch && (ch.final_text || ch.draft_text || '').trim().length > 0;
    });
  }, [arcMiniOutlineText, arcBuiltChapterIds, allChapters]);

  const sortedChapters = [...allChapters].sort((a, b) => a.order_index - b.order_index);

  // ── Promo handlers ──────────────────────────────────────────────────────────

  const openPromoStyleConfig = () => {
    if (!content || content.trim().length < 100) {
      setPromoError(tx(uiLanguage, '章节内容太少，请先写更多内容（至少100字）', 'Chapter content too short (at least 100 chars required)'));
      return;
    }
    if (!hasValidTextConfig) {
      setPromoError(tx(uiLanguage, '请先在设置中配置DeepSeek API Key', 'Configure text model API key in Settings first'));
      return;
    }
    setPromoError(null);
    setImageCharIds(new Set());
    setShowPromoConfig(true);
  };

  const handleGeneratePromo = async (styleInput?: string) => {
    if (!content || content.trim().length < 100) {
      setPromoError(tx(uiLanguage, '章节内容太少，请先写更多内容（至少100字）', 'Chapter content too short (at least 100 chars required)'));
      return;
    }
    if (!hasValidTextConfig) {
      setPromoError(tx(uiLanguage, '请先在设置中配置DeepSeek API Key', 'Configure text model API key in Settings first'));
      return;
    }
    const style = styleInput?.trim() || null;
    setIsGeneratingPromo(true);
    setPromoError(null);
    try {
      const promoData = await invoke<{ image_prompt: string; summary: string }>('generate_chapter_promo', {
        chapterTitle: chapter?.title || '未命名章节',
        chapterContent: content,
        style,
        outputLanguage: 'zh',
        textConfig: textModelConfig,
      });
      const charactersInfo = id ? buildCharactersInfo(getCharacters(id), imageCharIds) : null;
      const promoImagePrompt = charactersInfo
        ? `${promoData.image_prompt}\n\n[Characters in frame — keep their look consistent]\n${charactersInfo}`
        : promoData.image_prompt;
      const imageBase64 = await invoke<string>('generate_promo_image', {
        prompt: promoImagePrompt,
        width: 1200,
        height: 400,
        pollinationsKey: pollinationsKey || null,
        engine: imageEngine,
        comfyuiUrl: comfyUIUrl || null,
      });
      const newPromoResult = {
        imagePrompt: promoData.image_prompt,
        summary: promoData.summary,
        imageBase64,
      };
      setPromoResult(newPromoResult);
      setIsPromoExpanded(true);
      if (chapterId) setPromo(chapterId, newPromoResult);
    } catch (err) {
      setPromoError(typeof err === 'string' ? err : (err as Error)?.message || tx(uiLanguage, '推文生成失败', 'Failed to generate promo'));
    } finally {
      setIsGeneratingPromo(false);
    }
  };

  const confirmPromoGeneration = async () => {
    setShowPromoConfig(false);
    await handleGeneratePromo(promoStyle);
  };

  // ── Illustration handlers ───────────────────────────────────────────────────

  const toggleParagraphSelection = (index: number) => {
    setSelectedParagraphs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  const clearParagraphSelection = () => setSelectedParagraphs(new Set());

  const toggleIllustrationPreview = (illId: string) => {
    setActiveIllustrationId((prev) => (prev === illId ? null : illId));
  };

  const handleAnchorInputChange = (illId: string, value: string) => {
    setAnchorEdits((prev) => ({ ...prev, [illId]: value }));
  };

  const applyAnchorChange = (illId: string) => {
    if (paragraphs.length === 0) return;
    const rawValue = anchorEdits[illId];
    const parsed = rawValue ? parseInt(rawValue, 10) : NaN;
    if (Number.isNaN(parsed)) return;
    const clamped = Math.min(Math.max(1, parsed), paragraphs.length);
    setIllustrations((prev) => prev.map((item) => (item.id === illId ? { ...item, anchorIndex: clamped } : item)));
    setAnchorEdits((prev) => ({ ...prev, [illId]: String(clamped) }));
    setIsSaved(false);
  };

  const handleDeleteIllustration = async (illId: string) => {
    const ok = await uiConfirm({ title: tx(uiLanguage, '删除插图', 'Delete illustration'), message: tx(uiLanguage, '确定删除这张插图吗？', 'Delete this illustration?'), danger: true });
    if (!ok) return;
    setIllustrations((prev) => prev.filter((item) => item.id !== illId));
    setAnchorEdits((prev) => { const next = { ...prev }; delete next[illId]; return next; });
    if (activeIllustrationId === illId) setActiveIllustrationId(null);
    setIsSaved(false);
  };

  const openIllustrationConfig = () => {
    if (!hasValidTextConfig) {
      setIllustrationError(tx(uiLanguage, '请先配置 DeepSeek API Key', 'Configure text model API key first'));
      return;
    }
    if (selectedIndices.length === 0) {
      setIllustrationError(tx(uiLanguage, '请先勾选需要生成插图的段落', 'Select paragraphs first'));
      return;
    }
    setIllustrationError(null);
    setIllustrationConfigDraft({ ...illustrationConfig });
    setImageCharIds(new Set());
    setShowIllustrationConfig(true);
  };

  const generateIllustrationWithConfig = async (config: IllustrationConfig) => {
    if (!hasValidTextConfig || selectedIndices.length === 0) return;
    setIllustrationError(null);
    setIsGeneratingIllustration(true);
    try {
      const selectedText = selectedIndices.map((index) => paragraphs[index - 1]).filter(Boolean).join('\n\n');
      const anchorIndex = selectedIndices[0];
      // Character consistency: feed the picked characters' appearance to the prompt builder.
      const charactersInfo = id ? buildCharactersInfo(getCharacters(id), imageCharIds) : null;
      const promptText = charactersInfo
        ? `${selectedText}\n\n【画面中出现的角色，请严格按以下外貌刻画以保持一致】\n${charactersInfo}`
        : selectedText;
      const prompt = await invoke<string>('generate_illustration_prompt', {
        text: promptText,
        style: config.style?.trim() || null,
        textConfig: textModelConfig,
      });
      const imageBase64 = await invoke<string>('generate_promo_image', {
        prompt,
        width: config.width,
        height: config.height,
        model: config.model,
        pollinationsKey: pollinationsKey || null,
        engine: imageEngine,
        comfyuiUrl: comfyUIUrl || null,
      });
      const newIllustration: Illustration = {
        id: `ill-${Date.now()}`,
        anchorIndex,
        paragraphIndices: selectedIndices,
        prompt,
        imageBase64,
        createdAt: new Date().toISOString(),
      };
      setIllustrations((prev) => [...prev, newIllustration]);
      setActiveIllustrationId(newIllustration.id);
      clearParagraphSelection();
      setIsSaved(false);
    } catch (err) {
      setIllustrationError(typeof err === 'string' ? err : (err as Error)?.message || tx(uiLanguage, '插图生成失败', 'Failed to generate illustration'));
    } finally {
      setIsGeneratingIllustration(false);
    }
  };

  const confirmIllustrationGeneration = async () => {
    const width = Math.max(64, Math.floor(Number(illustrationConfigDraft.width) || illustrationConfig.width));
    const height = Math.max(64, Math.floor(Number(illustrationConfigDraft.height) || illustrationConfig.height));
    const model = illustrationConfigDraft.model?.trim() || 'zimage';
    const style = illustrationConfigDraft.style?.trim() || '';
    const config = { model, width, height, style };
    setIllustrationConfig(config);
    setShowIllustrationConfig(false);
    await generateIllustrationWithConfig(config);
  };

  return (
    <>
    <div className="flex h-full min-h-0">
      {/* Left panel: chapter list */}
      <div className="w-60 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-gray-800">
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
          <button
            onClick={smartBack}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate flex-1">
            {tx(uiLanguage, '章节', 'Chapters')}
          </span>
          <button
            onClick={openNewChapterForm}
            className="p-1.5 rounded hover:bg-purple-50 dark:hover:bg-purple-900/20 text-purple-600"
            title={tx(uiLanguage, '新建章节', 'New Chapter')}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sortedChapters.map((ch) => {
            const s = chapterStructureLabel(ch.id, ch.arc_id, arcs, volumes);
            return (
              <div
                key={ch.id}
                onClick={() => handleSelectChapter(ch)}
                className={`group w-full text-left px-3 py-2.5 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer ${
                  chapter?.id === ch.id ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400' : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-4 flex-shrink-0">{ch.order_index}</span>
                  <span className="text-sm truncate flex-1">{ch.title}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); renameChapterInList(ch); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-blue-600 flex-shrink-0 transition-all"
                    title={tx(uiLanguage, '重命名', 'Rename')}
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                </div>
                {(s.volume || s.arc) && (
                  <div className="text-[11px] text-purple-500 dark:text-purple-400 mt-0.5 pl-6 truncate">
                    {[s.volume, s.arc].filter(Boolean).join(' · ')}
                  </div>
                )}
                {ch.word_count > 0 && (
                  <div className="text-xs text-gray-400 mt-0.5 pl-6">{ch.word_count.toLocaleString()}字</div>
                )}
              </div>
            );
          })}
        </div>

        {showNewChapterForm && (
          <div className="p-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={tx(uiLanguage, '章节标题 *', 'Chapter title *')}
              className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
            <div>
              <select
                value={newChapterArcId}
                onChange={(e) => setNewChapterArcId(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
                title={tx(uiLanguage, '归属副本 / 弧线', 'Volume / Arc')}
              >
                <option value="">{tx(uiLanguage, '不归属弧线（排到末尾）', 'No arc (append to end)')}</option>
                {[...volumes].sort((a, b) => a.order - b.order).map((vol) => {
                  const volArcs = sortedArcs.filter((a) => a.volumeId === vol.id);
                  if (volArcs.length === 0) return null;
                  return (
                    <optgroup key={vol.id} label={vol.name}>
                      {volArcs.map((a) => (
                        <option key={a.id} value={a.id}>{a.title}</option>
                      ))}
                    </optgroup>
                  );
                })}
                {(() => {
                  const ids = new Set(volumes.map((v) => v.id));
                  const orphans = sortedArcs.filter((a) => !a.volumeId || !ids.has(a.volumeId));
                  if (orphans.length === 0) return null;
                  return (
                    <optgroup label={tx(uiLanguage, '未分配副本', 'Unassigned')}>
                      {orphans.map((a) => (
                        <option key={a.id} value={a.id}>{a.title}</option>
                      ))}
                    </optgroup>
                  );
                })()}
              </select>
              <p className="text-xs text-gray-400 mt-0.5">
                {tx(uiLanguage, '新章会排在所选弧线最后一章之后', 'New chapter is placed after the arc’s last chapter')}
              </p>
            </div>
            <input
              type="text"
              value={newGoal}
              onChange={(e) => setNewGoal(e.target.value)}
              placeholder={tx(uiLanguage, '本章目标（可选）', 'Chapter goal (optional)')}
              className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
            <input
              type="text"
              value={newConflict}
              onChange={(e) => setNewConflict(e.target.value)}
              placeholder={tx(uiLanguage, '核心冲突（可选）', 'Core conflict (optional)')}
              className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
            <button
              onClick={handleOpenAiFill}
              disabled={!hasValidTextConfig}
              title={!hasValidTextConfig ? tx(uiLanguage, '请先在设置中配置AI模型', 'Configure AI model in Settings first') : undefined}
              className="w-full text-xs py-1.5 rounded border border-dashed border-purple-300 dark:border-purple-700 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 flex items-center justify-center gap-1.5 disabled:opacity-40 transition-colors"
            >
              <Wand2 className="w-3 h-3" />
              {tx(uiLanguage, 'AI 助填', 'AI Fill')}
              {activeArc?.status === 'ending' && (
                <span className="text-orange-500 text-xs">· {tx(uiLanguage, '弧线结尾', 'arc ending')}</span>
              )}
            </button>
            <div className="flex gap-2">
              <button
                onClick={handleCreateChapter}
                disabled={!newTitle.trim()}
                className="flex-1 text-xs py-1.5 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 transition-colors"
              >
                {tx(uiLanguage, '创建', 'Create')}
              </button>
              <button
                onClick={() => { setShowNewChapterForm(false); setNewTitle(''); setNewGoal(''); setNewConflict(''); setNewChapterArcId(''); }}
                className="flex-1 text-xs py-1.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 transition-colors"
              >
                {tx(uiLanguage, '取消', 'Cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main editor area */}
      <div className="flex-1 flex min-w-0">
        <div className="flex-1 flex flex-col min-w-0">
        {chapter ? (
          <>
            {/* Editor toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex-shrink-0">
              {id && <WorkspaceChapterEntry projectId={id} chapterId={chapter.id} canReview={isSaved && !isGenerating && !isSaving} onReviewed={accepted => {
                if (!accepted) return;
                void chapterApi.getByProject(id).then(list => {
                  setAllChapters(list.sort((a, b) => a.order_index - b.order_index));
                  const fresh = list.find(c => c.id === chapter.id); if (!fresh) return;
                  const body = fresh.final_text || fresh.draft_text || '';
                  setEditorDraftContent(fresh.id, body, false); setChapter(fresh); setContent(body); setIsSaved(true);
                }).catch(failure => setError(String(failure)));
              }} />}
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold text-gray-900 dark:text-white truncate">{chapter.title}</h2>
                <button
                  onClick={() => setShowPlanning((v) => !v)}
                  className="text-xs text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 truncate flex items-center gap-1 max-w-full"
                >
                  <FileText className="w-3 h-3 flex-shrink-0" />
                  {chapter.outline_goal
                    ? <span className="truncate">{chapter.outline_goal}</span>
                    : <span>{tx(uiLanguage, '本章规划（目标 / 核心冲突）', 'Chapter plan (goal / conflict)')}</span>}
                </button>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {error && (
                  <span className="text-xs text-red-500 flex items-center gap-1 max-w-[12rem] truncate">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    {error}
                  </span>
                )}
                <Button
                  variant={showPlanning ? 'secondary' : 'outline'}
                  onClick={() => setShowPlanning((v) => !v)}
                  className="text-sm py-1.5"
                  title={tx(uiLanguage, '本章规划：目标 / 核心冲突', 'Chapter plan: goal / conflict')}
                >
                  <FileText className="w-4 h-4 mr-1" />
                  {tx(uiLanguage, '规划', 'Plan')}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleSave}
                  loading={isSaving}
                  disabled={isSaved}
                  className="text-sm py-1.5"
                >
                  <Save className="w-4 h-4 mr-1" />
                  {isSaved ? tx(uiLanguage, '已保存', 'Saved') : tx(uiLanguage, '保存', 'Save')}
                </Button>
                {!isGenerating ? (
                  <Button
                    onClick={handleGenerate}
                    disabled={!hasValidTextConfig}
                    className="text-sm py-1.5 bg-purple-600 hover:bg-purple-700"
                  >
                    <Sparkles className="w-4 h-4 mr-1" />
                    {content.trim() ? tx(uiLanguage, '续写', 'Continue') : tx(uiLanguage, 'AI生成', 'Generate')}
                  </Button>
                ) : (
                  <Button onClick={handleCancel} variant="outline" className="text-sm py-1.5">
                    <StopCircle className="w-4 h-4 mr-1" />
                    {tx(uiLanguage, '停止', 'Stop')}
                  </Button>
                )}
                <MoreMenu label={tx(uiLanguage, '更多', 'More')}>
                  <MoreMenuItem
                    icon={<Boxes className="w-4 h-4 text-purple-500" />}
                    label={tx(uiLanguage, '容器', 'Containers')}
                    disabled={!id}
                    onClick={() => id && navigate(`/long-novel/${id}/containers`)}
                  />
                  <MoreMenuItem
                    icon={<Sparkles className="w-4 h-4 text-amber-500" />}
                    label={tx(uiLanguage, '境界系统', 'Realms')}
                    onClick={() => setShowCultivationModal(true)}
                  />
                  <MoreMenuItem
                    icon={isGeneratingPromo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Image className="w-4 h-4" />}
                    label={tx(uiLanguage, '生成推文', 'Promo')}
                    disabled={isGeneratingPromo || !content || content.trim().length < 100}
                    onClick={openPromoStyleConfig}
                  />
                  <MoreMenuItem
                    icon={<Image className="w-4 h-4" />}
                    label={isIllustrationMode ? tx(uiLanguage, '退出插图模式', 'Exit illustration mode') : tx(uiLanguage, '插图模式', 'Illustration mode')}
                    onClick={() => setIsIllustrationMode((v) => !v)}
                  />
                </MoreMenu>
              </div>
            </div>

            {/* Chapter planning panel — 章节标题 / 本章目标 / 核心冲突 (mirrors Android EditorScreen) */}
            {showPlanning && (
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 flex-shrink-0 space-y-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{tx(uiLanguage, '章节标题', 'Chapter Title')}</label>
                  <input
                    type="text"
                    value={chapter.title}
                    onChange={(e) => { setChapter({ ...chapter, title: e.target.value }); setIsSaved(false); }}
                    className="w-full px-2.5 py-1.5 text-sm border rounded-lg dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    placeholder={tx(uiLanguage, '章节标题', 'Chapter title')}
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{tx(uiLanguage, '本章目标', 'Chapter Goal')}</label>
                    <textarea
                      value={chapter.outline_goal || ''}
                      onChange={(e) => { setChapter({ ...chapter, outline_goal: e.target.value }); setIsSaved(false); }}
                      className="w-full px-2.5 py-1.5 text-sm border rounded-lg dark:bg-gray-700 dark:border-gray-600 h-16 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
                      placeholder={tx(uiLanguage, '本章要推进什么剧情 / 完成什么目标', 'What this chapter should accomplish')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{tx(uiLanguage, '核心冲突', 'Core Conflict')}</label>
                    <textarea
                      value={chapter.conflict || ''}
                      onChange={(e) => { setChapter({ ...chapter, conflict: e.target.value }); setIsSaved(false); }}
                      className="w-full px-2.5 py-1.5 text-sm border rounded-lg dark:bg-gray-700 dark:border-gray-600 h-16 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
                      placeholder={tx(uiLanguage, '本章的核心矛盾 / 张力', "This chapter's central tension")}
                    />
                  </div>
                </div>
                <p className="text-[11px] text-gray-400">
                  {tx(uiLanguage, '保存章节时一并保存；生成正文时作为本章规划注入提示词。', 'Saved with the chapter; injected into the prompt when generating.')}
                </p>
              </div>
            )}

            {/* Promo result banner */}
            {(promoResult || promoError) && (
              <div className="border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                <button
                  onClick={() => setIsPromoExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <Image className="w-4 h-4 text-purple-500" />
                    <span className="font-medium text-gray-700 dark:text-gray-300">{tx(uiLanguage, '章节推文', 'Chapter Promo')}</span>
                  </div>
                  {isPromoExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {isPromoExpanded && (
                  <div className="px-4 py-3 bg-white dark:bg-gray-900 space-y-3">
                    {promoError && (
                      <div className="text-sm text-red-500 flex items-center gap-2">
                        {promoError}
                        <button onClick={() => setPromoError(null)} className="underline text-xs">{tx(uiLanguage, '关闭', 'Close')}</button>
                      </div>
                    )}
                    {promoResult && (
                      <>
                        {promoResult.imageBase64 && (
                          <img src={promoResult.imageBase64} alt="chapter cover" className="w-full rounded-lg shadow" style={{ aspectRatio: '3/1', objectFit: 'cover' }} />
                        )}
                        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                          {promoResult.summary}
                        </div>
                        <div className="flex justify-end">
                          <Button variant="outline" onClick={openPromoStyleConfig} disabled={isGeneratingPromo} className="text-xs py-1">
                            {isGeneratingPromo ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                            {tx(uiLanguage, '重新生成', 'Regenerate')}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Text area */}
            <div ref={editorContainerRef} className="flex-1 relative overflow-hidden">
              {revisionSelection && revisionButtonPos && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handlePolishSelection}
                  disabled={isRevising}
                  className="absolute z-10 w-8 h-8 rounded-full bg-purple-600 hover:bg-purple-700 text-white flex items-center justify-center shadow-md"
                  style={{ left: revisionButtonPos.x, top: revisionButtonPos.y }}
                  title={tx(uiLanguage, '润色选中内容', 'Polish selected text')}
                >
                  {isRevising ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                </button>
              )}
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => { setContent(e.target.value); setIsSaved(false); setRevisionSelection(null); setRevisionButtonPos(null); }}
                onMouseUp={updateRevisionSelection}
                onKeyUp={updateRevisionSelection}
                onSelect={updateRevisionSelection}
                onScroll={(e) => {
                  if (revisionSelection) updateRevisionSelection();
                  if (chapter?.id) setEditorDraftScroll(chapter.id, (e.target as HTMLTextAreaElement).scrollTop);
                }}
                onBlur={() => { setRevisionSelection(null); setRevisionButtonPos(null); }}
                className="w-full h-full px-6 py-5 text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 resize-none focus:outline-none text-base leading-relaxed font-serif"
                placeholder={tx(
                  uiLanguage,
                  '在这里写作，或点击"AI生成"自动生成本章内容...',
                  'Write here or click "Generate" to auto-generate chapter content...'
                )}
              />
            </div>

            {/* Word count footer */}
            <div className="px-4 py-1.5 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-400 flex items-center justify-between flex-shrink-0">
              <span>
                {content.trim() ? content.trim().replace(/\s+/g, '').length : 0} {tx(uiLanguage, '字', 'chars')}
              </span>
              <div className="flex items-center gap-3">
                {isGenerating && (
                  <span className="flex items-center gap-1.5 text-purple-600">
                    <span className="w-1.5 h-3 rounded-sm bg-purple-500 animate-pulse inline-block" />
                    {tx(uiLanguage, 'AI写作中…', 'AI writing…')}
                  </span>
                )}
                {!isSaved && !isGenerating && (
                  <span className="text-yellow-500">{tx(uiLanguage, '未保存', 'Unsaved')}</span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-gray-400">
            <BookOpen className="w-12 h-12 opacity-40" />
            <p>{allChapters.length > 0
              ? tx(uiLanguage, '从左侧选择章节开始写作', 'Select a chapter from the left to start writing')
              : tx(uiLanguage, '还没有章节，创建第一章开始吧', 'No chapters yet — create the first one')
            }</p>
            <Button
              onClick={openNewChapterForm}
              className="bg-purple-600 hover:bg-purple-700"
            >
              <Plus className="w-4 h-4 mr-2" />
              {allChapters.length > 0
                ? tx(uiLanguage, '写新章节', 'New Chapter')
                : tx(uiLanguage, '创建第一章', 'Create First Chapter')
              }
            </Button>
          </div>
        )}
        </div>

        {/* Illustration panel */}
        {isIllustrationMode && chapter && (
          <div className="w-64 flex-shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                <Image className="w-3.5 h-3.5 text-purple-500" />
                {tx(uiLanguage, '插图段落', 'Paragraphs')}
                <span className="text-gray-400">({paragraphs.length})</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={openIllustrationConfig}
                  disabled={isGeneratingIllustration || selectedIndices.length === 0}
                  className="text-xs px-2 py-1 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 transition-colors flex items-center gap-1"
                >
                  {isGeneratingIllustration ? <Loader2 className="w-3 h-3 animate-spin" /> : <Image className="w-3 h-3" />}
                  {tx(uiLanguage, '生成', 'Generate')}{selectedIndices.length > 0 ? `(${selectedIndices.length})` : ''}
                </button>
                <button
                  onClick={clearParagraphSelection}
                  disabled={selectedIndices.length === 0}
                  className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-500 disabled:opacity-40 transition-colors"
                >
                  {tx(uiLanguage, '清空', 'Clear')}
                </button>
              </div>
            </div>
            {illustrationError && (
              <div className="px-3 py-1.5 text-xs text-red-500 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 flex-shrink-0">
                {illustrationError}
                <button onClick={() => setIllustrationError(null)} className="ml-1 underline">{tx(uiLanguage, '关闭', 'Close')}</button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
              {paragraphs.length === 0 ? (
                <p className="p-3 text-xs text-gray-400">{tx(uiLanguage, '暂无内容', 'No content yet')}</p>
              ) : (
                paragraphs.map((para, idx) => {
                  const index = idx + 1;
                  const items = illustrationsByAnchor.get(index) || [];
                  const isSelected = selectedParagraphs.has(index);
                  return (
                    <div key={index} className={`p-2.5 ${isSelected ? 'bg-purple-50 dark:bg-purple-900/20' : ''}`}>
                      <div className="flex items-start gap-2">
                        <div className="flex flex-col items-center gap-1 pt-0.5 flex-shrink-0">
                          <span className="text-[10px] text-gray-400">#{index}</span>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleParagraphSelection(index)}
                            className="h-3.5 w-3.5 accent-purple-600"
                          />
                          {items.map((item) => (
                            <button
                              key={item.id}
                              onClick={() => toggleIllustrationPreview(item.id)}
                              className={`p-0.5 rounded border text-xs ${activeIllustrationId === item.id ? 'bg-purple-100 border-purple-400 text-purple-700 dark:bg-purple-900/30' : 'bg-white border-gray-200 text-gray-400 dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100'}`}
                              title={tx(uiLanguage, '查看插图', 'View illustration')}
                            >
                              <Image className="w-3 h-3" />
                            </button>
                          ))}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap line-clamp-3">{para}</p>
                          {items.map((item) =>
                            activeIllustrationId === item.id ? (
                              <div key={`${item.id}-preview`} className="mt-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-2">
                                <img src={item.imageBase64} alt="illustration" className="w-full rounded shadow-sm" />
                                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                                  <span className="text-gray-500">{tx(uiLanguage, '位置', 'Pos')}</span>
                                  <input
                                    type="number"
                                    min={1}
                                    max={paragraphs.length}
                                    value={anchorEdits[item.id] ?? String(item.anchorIndex)}
                                    onChange={(e) => handleAnchorInputChange(item.id, e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') applyAnchorChange(item.id); }}
                                    className="w-14 px-1.5 py-0.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                                  />
                                  <button onClick={() => applyAnchorChange(item.id)} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 text-gray-600 dark:text-gray-300">
                                    {tx(uiLanguage, '移', 'Move')}
                                  </button>
                                  <button onClick={() => handleDeleteIllustration(item.id)} className="px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-900/20 text-red-600 hover:bg-red-100">
                                    {tx(uiLanguage, '删', 'Del')}
                                  </button>
                                </div>
                              </div>
                            ) : null
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right panel: arc progress */}
      <div className={`flex-shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col transition-all ${arcPanelOpen ? 'w-80' : 'w-10'}`}>
        <button
          onClick={() => setArcPanelOpen((v) => !v)}
          className="p-2 flex items-center justify-center border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full"
          title={arcPanelOpen ? tx(uiLanguage, '折叠', 'Collapse') : tx(uiLanguage, '展开剧情进度', 'Expand arc progress')}
        >
          <Layers className="w-4 h-4 text-purple-600" />
          {arcPanelOpen && (
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300 ml-1.5 flex-1 text-left">
              {tx(uiLanguage, '剧情进度', 'Arc Progress')}
            </span>
          )}
          {arcPanelOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 rotate-90" /> : null}
        </button>

        {arcPanelOpen && (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* 副本 / 弧线 tree — same component as the project page */}
            {id && <VolumeArcPanel projectId={id} uiLanguage={uiLanguage} compact />}

            {/* Arc mini-outline controls — build blank chapters for the active arc */}
            {activeArc && (
              <div className="space-y-2">
                {/* Generate mini-outline */}
                {!arcMiniOutlineText && !isGenMiniOutline && (
                  <button
                    onClick={handleGenerateMiniOutline}
                    disabled={!hasValidTextConfig}
                    className="w-full flex items-center justify-center gap-1.5 text-xs py-2 px-3 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700 text-purple-700 dark:text-purple-400 hover:bg-purple-100 transition-colors disabled:opacity-40"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {tx(uiLanguage, '生成弧线小纲', 'Generate arc outline')}
                  </button>
                )}

                {isGenMiniOutline && (
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700 p-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-purple-600 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse inline-block" />
                        {tx(uiLanguage, 'AI规划中…', 'AI planning…')}
                      </span>
                      <button
                        onClick={() => { arcMiniOutlineCancelRef.current = true; invoke('cancel_generation').catch(() => {}); }}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        {tx(uiLanguage, '停止', 'Stop')}
                      </button>
                    </div>
                    <pre className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">{arcMiniOutlineText}</pre>
                  </div>
                )}

                {arcMiniOutlineText && !isGenMiniOutline && (
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700 p-2 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                        {tx(uiLanguage, '弧线小纲（可直接编辑，输入即保存）', 'Arc outline (edit inline, auto-saved)')}
                      </p>
                      {arcBuiltChapterIds.length > 0 && (
                        <span className="text-[10px] text-emerald-700 dark:text-emerald-400 flex-shrink-0">
                          {tx(uiLanguage,
                            `已构建 ${arcBuiltChapterIds.length} 章`,
                            `${arcBuiltChapterIds.length} chapters built`)}
                        </span>
                      )}
                    </div>
                    <textarea
                      value={arcMiniOutlineText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setArcMiniOutlineText(v);
                        arcMiniOutlineTextRef.current = v;
                        // Auto-persist to zustand. The change survives chapter
                        // builds because mini_outline and builtChapterIds are
                        // independent fields on the arc.
                        if (id && activeArc) {
                          updatePlotArc(id, activeArc.id, { miniOutline: v });
                        }
                      }}
                      spellCheck={false}
                      className="w-full min-h-[140px] max-h-72 text-xs leading-relaxed font-mono text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-y"
                    />
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-snug">
                      {tx(uiLanguage,
                        '格式：第N章：标题 — 目标。每行一章，按此格式"构建空白章节"才能识别。已构建的章节不会受小纲编辑影响——改动只影响下次"构建"。',
                        'Format: "Chapter N: Title — Goal", one per line. Already-built chapters are unaffected by edits — your changes only apply to the next "Build chapters" run.')}
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        onClick={handleBuildArcChapters}
                        className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded bg-purple-600 text-white hover:bg-purple-700 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        {tx(uiLanguage, '构建空白章节', 'Build chapters')}
                      </button>
                      <button
                        onClick={handleGenerateMiniOutline}
                        disabled={!hasValidTextConfig}
                        className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 transition-colors disabled:opacity-40"
                      >
                        <RefreshCw className="w-3 h-3" />
                        {tx(uiLanguage, '重新生成', 'Regenerate')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Complete arc */}
                <button
                  onClick={handleCompleteArc}
                  disabled={!canCompleteArc}
                  title={
                    !arcMiniOutlineText
                      ? tx(uiLanguage, '请先生成弧线小纲', 'Generate the arc mini-outline first')
                      : arcBuiltChapterIds.length === 0
                        ? tx(uiLanguage, '请先构建空白章节', 'Build arc chapters first')
                        : !canCompleteArc
                          ? tx(uiLanguage, '至少写完一章内容后才能完成弧线', 'Write at least one chapter before completing the arc')
                          : ''
                  }
                  className="w-full flex items-center justify-center gap-1.5 text-xs py-2 px-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 text-green-700 dark:text-green-400 hover:bg-green-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-green-50 dark:disabled:hover:bg-green-900/20"
                >
                  <Check className="w-3.5 h-3.5" />
                  {tx(uiLanguage, '完成此弧线', 'Complete this arc')}
                </button>
              </div>
            )}

          </div>
        )}
      </div>
    </div>

    {/* AI 助填 dialog */}
    {showAiFillDialog && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-purple-600" />
              {tx(uiLanguage, 'AI 助填章节信息', 'AI Chapter Planner')}
            </h3>
            <button
              onClick={() => setShowAiFillDialog(false)}
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Arc context hint */}
          {activeArc ? (
            <div className={`text-xs px-3 py-2 rounded-lg flex items-start gap-2 ${
              activeArc.status === 'ending'
                ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-700'
                : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-700'
            }`}>
              {activeArc.status === 'ending' ? <Sunset className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <Play className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
              <span>
                {activeArc.status === 'ending'
                  ? tx(uiLanguage, `弧线「${activeArc.title}」处于结尾阶段，已预填弧线描述`, `Arc "${activeArc.title}" is in ending phase — description pre-filled`)
                  : tx(uiLanguage, `当前弧线：${activeArc.title}（进行中）`, `Active arc: ${activeArc.title}`)}
              </span>
            </div>
          ) : (
            <div className="text-xs px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/50 text-gray-500 border border-gray-200 dark:border-gray-600">
              {tx(uiLanguage, '暂无活跃弧线，将基于前文上下文生成', 'No active arc — will generate based on prior context')}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              {activeArc?.status === 'ending'
                ? tx(uiLanguage, '弧线描述（可编辑，告诉AI这章的收束方向）', 'Arc description — edit to guide the ending')
                : tx(uiLanguage, '本章需求（留空让AI基于剧情自由规划）', 'Chapter requirements — leave blank to let AI plan freely')}
            </label>
            <textarea
              value={aiFillUserReq}
              onChange={(e) => setAiFillUserReq(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              placeholder={tx(
                uiLanguage,
                '例如：安排两位主角在意外中重逢，推进感情线，结尾留下悬念…',
                'e.g. Have the leads meet unexpectedly, advance romance, end with a cliffhanger…'
              )}
            />
          </div>

          {/* Streaming preview */}
          {(isAiFilling || aiFillText) && (
            <div className="bg-gray-50 dark:bg-gray-900/60 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                {isAiFilling
                  ? tx(uiLanguage, 'AI 规划中…', 'AI planning…')
                  : tx(uiLanguage, '生成结果（已自动填入表单）', 'Result — applied to form')}
              </p>
              <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">{aiFillText}</pre>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <button
              onClick={() => setShowAiFillDialog(false)}
              className="text-sm px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              {tx(uiLanguage, '关闭', 'Close')}
            </button>
            {isAiFilling ? (
              <button
                onClick={() => { aiFillCancelRef.current = true; }}
                className="text-sm px-4 py-2 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 transition-colors flex items-center gap-1.5"
              >
                <StopCircle className="w-3.5 h-3.5" />
                {tx(uiLanguage, '停止', 'Stop')}
              </button>
            ) : (
              <button
                onClick={handleAiFill}
                className="text-sm px-4 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700 transition-colors flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {tx(uiLanguage, '生成建议', 'Generate')}
              </button>
            )}
          </div>
        </div>
      </div>
    )}
    {/* Arc detail modal */}
    {arcDetailOpen && activeArc && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[80vh]">
          {/* Header */}
          <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {activeArc.status === 'ending'
                ? <Sunset className="w-4 h-4 text-orange-500 flex-shrink-0" />
                : <Play className="w-4 h-4 text-blue-500 flex-shrink-0" />
              }
              <h3 className="font-semibold text-gray-900 dark:text-white truncate">{activeArc.title}</h3>
              <span className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                activeArc.status === 'ending'
                  ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              }`}>
                {activeArc.status === 'ending'
                  ? tx(uiLanguage, '结尾阶段', 'Ending')
                  : tx(uiLanguage, '进行中', 'Active')}
              </span>
            </div>
            <button
              onClick={() => setArcDetailOpen(false)}
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 flex-shrink-0 ml-2"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {/* Scrollable markdown body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeArc.summary ? (
              <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({children}) => <h1 className="text-base font-bold text-gray-900 dark:text-white mt-4 mb-2 first:mt-0">{children}</h1>,
                    h2: ({children}) => <h2 className="text-sm font-bold text-gray-800 dark:text-gray-200 mt-3 mb-1">{children}</h2>,
                    h3: ({children}) => <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mt-2 mb-1">{children}</h3>,
                    p: ({children}) => <p className="mb-2 leading-relaxed">{children}</p>,
                    ul: ({children}) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
                    ol: ({children}) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
                    li: ({children}) => <li className="leading-relaxed">{children}</li>,
                    strong: ({children}) => <strong className="font-semibold text-gray-900 dark:text-white">{children}</strong>,
                    em: ({children}) => <em className="italic">{children}</em>,
                    blockquote: ({children}) => <blockquote className="border-l-2 border-purple-400 pl-3 italic text-gray-500 dark:text-gray-400 my-2">{children}</blockquote>,
                    hr: () => <hr className="border-gray-200 dark:border-gray-600 my-3" />,
                    code: ({children}) => <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded font-mono">{children}</code>,
                  }}
                >
                  {activeArc.summary}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">{tx(uiLanguage, '暂无弧线描述', 'No arc description')}</p>
            )}
          </div>
          {/* Footer */}
          <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end flex-shrink-0">
            <button
              onClick={() => setArcDetailOpen(false)}
              className="text-sm px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              {tx(uiLanguage, '关闭', 'Close')}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Promo style config modal */}
    {showPromoConfig && (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-2xl">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">{tx(uiLanguage, '章节封面风格', 'Chapter Cover Style')}</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{tx(uiLanguage, '图片风格', 'Image Style')}</label>
              <input
                type="text"
                list="promo-style-opts"
                value={promoStyle}
                onChange={(e) => setPromoStyle(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm"
                placeholder={tx(uiLanguage, '选择或输入风格（支持中文）', 'Select or type a style')}
              />
              <datalist id="promo-style-opts">
                <option value="cinematic" />
                <option value="watercolor" />
                <option value="anime" />
              </datalist>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{tx(uiLanguage, '支持中文输入，系统会将风格整合为英文提示词', 'Non-English style is auto-converted to English prompts')}</p>
            {id && <CharacterConsistencyPicker characters={getCharacters(id)} selectedIds={imageCharIds} onToggle={toggleImageChar} uiLanguage={uiLanguage} />}
          </div>
          <div className="flex gap-3 mt-6">
            <Button variant="outline" onClick={() => setShowPromoConfig(false)} className="flex-1">{tx(uiLanguage, '取消', 'Cancel')}</Button>
            <Button onClick={confirmPromoGeneration} loading={isGeneratingPromo} className="flex-1">{tx(uiLanguage, '生成', 'Generate')}</Button>
          </div>
        </div>
      </div>
    )}

    {/* Illustration config modal */}
    {showIllustrationConfig && (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-2xl">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">{tx(uiLanguage, '插图生成设置', 'Illustration Settings')}</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{tx(uiLanguage, '模型', 'Model')}</label>
              <input type="text" value={illustrationConfigDraft.model} onChange={(e) => setIllustrationConfigDraft((prev) => ({ ...prev, model: e.target.value }))} className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm" placeholder="zimage" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{tx(uiLanguage, '宽度', 'Width')}</label>
                <input type="number" value={illustrationConfigDraft.width} onChange={(e) => setIllustrationConfigDraft((prev) => ({ ...prev, width: parseInt(e.target.value, 10) || prev.width }))} className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm" min={64} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{tx(uiLanguage, '高度', 'Height')}</label>
                <input type="number" value={illustrationConfigDraft.height} onChange={(e) => setIllustrationConfigDraft((prev) => ({ ...prev, height: parseInt(e.target.value, 10) || prev.height }))} className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm" min={64} />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{tx(uiLanguage, '图片风格', 'Image Style')}</label>
              <input type="text" list="ill-style-opts" value={illustrationConfigDraft.style} onChange={(e) => setIllustrationConfigDraft((prev) => ({ ...prev, style: e.target.value }))} className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm" placeholder={tx(uiLanguage, '选择或输入风格（支持中文）', 'Select or type a style')} />
              <datalist id="ill-style-opts">
                <option value="cinematic" />
                <option value="watercolor" />
                <option value="anime" />
              </datalist>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{tx(uiLanguage, '建议 16:9 或 3:2 比例更适合插图展示', '16:9 or 3:2 aspect ratio works best')}</p>
            {id && <CharacterConsistencyPicker characters={getCharacters(id)} selectedIds={imageCharIds} onToggle={toggleImageChar} uiLanguage={uiLanguage} />}
          </div>
          <div className="flex gap-3 mt-6">
            <Button variant="outline" onClick={() => setShowIllustrationConfig(false)} className="flex-1">{tx(uiLanguage, '取消', 'Cancel')}</Button>
            <Button onClick={confirmIllustrationGeneration} loading={isGeneratingIllustration} className="flex-1">{tx(uiLanguage, '生成', 'Generate')}</Button>
          </div>
        </div>
      </div>
    )}

    {showCultivationModal && id && (
      <CultivationSystemPanel
        projectId={id}
        chapters={allChapters}
        onClose={() => setShowCultivationModal(false)}
      />
    )}
    </>
  );
}
