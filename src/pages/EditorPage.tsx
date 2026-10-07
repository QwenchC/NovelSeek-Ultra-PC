import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { WorkspaceChapterEntry } from '../writingUi/WorkspaceChapterEntry';
import { useAppStore } from '@store/index';
import { chapterApi, projectApi, knowledgeApi } from '@services/api';
import { Button } from '@components/Button';
import { ArrowLeft, Save, Sparkles, StopCircle, Check, FileText, ChevronRight, RefreshCw, Image, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import type { Chapter } from '@typings/index';
import { confirmDialog } from '@utils/index';
import { tx } from '@utils/i18n';
import { useSmartBack } from '@utils/useSmartBack';

// 单次生成的目标字数（控制在2500字左右避免中断）
const TARGET_WORDS_PER_GENERATION = 2500;

// 推文生成结果类型
interface PromoResult {
  imagePrompt: string;
  summary: string;
  imageBase64: string | null;
}

interface Illustration {
  id: string;
  anchorIndex: number; // 1-based paragraph index
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

// 去除 Markdown 符号
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s*/g, '')        // 移除标题符号
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 移除加粗
    .replace(/\*([^*]+)\*/g, '$1')     // 移除斜体
    .replace(/`([^`]+)`/g, '$1')       // 移除行内代码
    .replace(/^[-*+]\s+/gm, '')        // 移除列表符号
    .replace(/^\d+\.\s+/gm, '')        // 移除有序列表
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 移除链接
    .replace(/>\s*/g, '')              // 移除引用符号
    .trim();
}

export function EditorPage() {
  const { projectId, chapterId } = useParams();
  const navigate = useNavigate();
  const smartBack = useSmartBack(projectId ? `/project/${projectId}` : '/short-novels');
  const [searchParams] = useSearchParams();
  const {
    textModelConfig,
    pollinationsKey,
    imageEngine,
    comfyUIUrl,
    getCharacters,
    getWorldSetting,
    getTimeline,
    getPromo,
    setPromo,
    uiLanguage,
    knowledgeBaseEnabled,
    embeddingConfig,
    summariesEnabled,
    entitiesEnabled,
  } = useAppStore();
  const hasValidTextConfig = useMemo(
    () =>
      textModelConfig.apiKey.trim().length > 0 &&
      textModelConfig.apiUrl.trim().length > 0 &&
      textModelConfig.model.trim().length > 0 &&
      Number.isFinite(textModelConfig.temperature),
    [textModelConfig]
  );
  const hasValidEmbeddingConfig = useMemo(
    () =>
      knowledgeBaseEnabled &&
      embeddingConfig.apiKey.trim().length > 0 &&
      embeddingConfig.apiUrl.trim().length > 0 &&
      embeddingConfig.model.trim().length > 0,
    [knowledgeBaseEnabled, embeddingConfig]
  );
  
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [allChapters, setAllChapters] = useState<Chapter[]>([]);
  const [projectLanguage, setProjectLanguage] = useState<'zh' | 'en'>('zh');
  const [content, setContent] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [revisionSelection, setRevisionSelection] = useState<{
    start: number;
    end: number;
    text: string;
  } | null>(null);
  const [revisionButtonPos, setRevisionButtonPos] = useState<{ x: number; y: number } | null>(null);
  const [isRevising, setIsRevising] = useState(false);
  
  // 推文相关状态
  const [promoResult, setPromoResult] = useState<PromoResult | null>(null);
  const [isPromoExpanded, setIsPromoExpanded] = useState(false);
  const [isGeneratingPromo, setIsGeneratingPromo] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [showPromoStyleConfig, setShowPromoStyleConfig] = useState(false);
  const [promoStyle, setPromoStyle] = useState('cinematic');

  // 插图相关状态
  const [isIllustrationMode, setIsIllustrationMode] = useState(false);
  const [selectedParagraphs, setSelectedParagraphs] = useState<Set<number>>(new Set());
  const [illustrations, setIllustrations] = useState<Illustration[]>([]);
  const [activeIllustrationId, setActiveIllustrationId] = useState<string | null>(null);
  const [illustrationError, setIllustrationError] = useState<string | null>(null);
  const [isGeneratingIllustration, setIsGeneratingIllustration] = useState(false);
  const [anchorEdits, setAnchorEdits] = useState<Record<string, string>>({});
  const [showIllustrationConfig, setShowIllustrationConfig] = useState(false);
  const [showChapterSwitcher, setShowChapterSwitcher] = useState(false);
  const [illustrationConfig, setIllustrationConfig] = useState<IllustrationConfig>({
    model: 'zimage',
    width: 1920,
    height: 1080,
    style: '',
  });
  const [illustrationConfigDraft, setIllustrationConfigDraft] = useState<IllustrationConfig>({
    model: 'zimage',
    width: 1920,
    height: 1080,
    style: '',
  });
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const chapterSwitcherRef = useRef<HTMLDivElement>(null);
  const autoPrologueRef = useRef(false);

  useEffect(() => {
    if (chapterId && projectId) {
      loadChapterData();
    }
  }, [chapterId, projectId]);

  useEffect(() => {
    const shouldAuto = searchParams.get('prologue') === '1';
    if (shouldAuto && chapter && !autoPrologueRef.current && !isGenerating) {
      autoPrologueRef.current = true;
      handleGeneratePrologue();
    }
  }, [searchParams, chapter, isGenerating]);

  // 加载已保存的推文数据
  useEffect(() => {
    if (chapterId) {
      const savedPromo = getPromo(chapterId);
      if (savedPromo) {
        setPromoResult(savedPromo);
      }
    }
  }, [chapterId, getPromo]);

  useEffect(() => {
    // 计算字数（排除空格）
    const count = content.replace(/\s/g, '').length;
    setWordCount(count);
  }, [content]);

  const parseIllustrations = (raw?: string | null): Illustration[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(item => ({
          id: String(item.id || `ill-${Date.now()}`),
          anchorIndex: Number(item.anchorIndex) || 1,
          paragraphIndices: Array.isArray(item.paragraphIndices)
            ? item.paragraphIndices.map((n: number) => Number(n)).filter((n: number) => !Number.isNaN(n))
            : [],
          prompt: String(item.prompt || ''),
          imageBase64: String(item.imageBase64 || ''),
          createdAt: String(item.createdAt || new Date().toISOString()),
        }))
        .filter(item => item.imageBase64);
    } catch {
      return [];
    }
  };

  const paragraphs = useMemo(() => {
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    return normalized
      .split(/\n\s*\n+/)
      .map(p => p.trim())
      .filter(Boolean);
  }, [content]);

  const selectedIndices = useMemo(
    () => Array.from(selectedParagraphs).sort((a, b) => a - b),
    [selectedParagraphs]
  );

  const sortedChapters = useMemo(
    () =>
      [...allChapters].sort((a, b) => {
        if (a.order_index !== b.order_index) {
          return a.order_index - b.order_index;
        }
        return a.created_at.localeCompare(b.created_at);
      }),
    [allChapters]
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

  // 当段落数量变化时，清理超出范围的选择与插图位置
  useEffect(() => {
    if (paragraphs.length === 0) {
      if (selectedParagraphs.size > 0) {
        setSelectedParagraphs(new Set());
      }
      return;
    }

    setSelectedParagraphs(prev => {
      const filtered = new Set([...prev].filter(i => i <= paragraphs.length));
      return filtered;
    });

    setIllustrations(prev => {
      let changed = false;
      const updated = prev.map(item => {
        const clamped = Math.min(Math.max(1, item.anchorIndex), paragraphs.length);
        if (clamped !== item.anchorIndex) {
          changed = true;
          return { ...item, anchorIndex: clamped };
        }
        return item;
      });
      if (changed) {
        setIsSaved(false);
      }
      return changed ? updated : prev;
    });
  }, [paragraphs.length, selectedParagraphs.size]);

  const loadChapterData = async () => {
    try {
      const chapters = await chapterApi.getByProject(projectId!);
      const project = await projectApi.getById(projectId!);
      setProjectLanguage(project?.language === 'en' ? 'en' : 'zh');
      setAllChapters(chapters);
      const found = chapters.find(c => c.id === chapterId);
      if (found) {
        setChapter(found);
        setContent(found.draft_text || found.final_text || '');
        setIllustrations(parseIllustrations(found.illustrations));
        setSelectedParagraphs(new Set());
        setActiveIllustrationId(null);
        setIsSaved(true);
      }
    } catch (error) {
      console.error('Failed to load chapter:', error);
      setError(tx(uiLanguage, '加载章节失败', 'Failed to load chapter'));
    }
  };

  // 获取前一章的内容摘要用于上下文连贯
  const getPreviousChapterSummary = (): string | null => {
    if (!chapter || !allChapters.length) return null;

    // Collect up to 3 written chapters before the current one
    const prevChapters = allChapters
      .filter(c => c.order_index < chapter.order_index && (c.draft_text || c.final_text))
      .sort((a, b) => b.order_index - a.order_index)
      .slice(0, 3)
      .reverse(); // restore chronological order

    if (prevChapters.length === 0) return null;

    const parts: string[] = [];
    // Earlier chapters: last 400 chars each, for broader story awareness
    for (const c of prevChapters.slice(0, -1)) {
      const content = (c.draft_text || c.final_text) ?? '';
      parts.push(`【${c.title || `第${c.order_index}章`}结尾片段】\n${content.slice(-400)}`);
    }
    // Most recent chapter: last 1500 chars for natural continuation
    const lastChap = prevChapters[prevChapters.length - 1];
    const lastContent = (lastChap.draft_text || lastChap.final_text) ?? '';
    parts.push(`【前一章结尾】\n${lastContent.slice(-1500)}`);

    return parts.join('\n\n');
  };

  // 获取当前内容的结尾部分用于续写
  const getCurrentContentTail = (): string => {
    if (!content) return '';
    // 取最后800字作为续写上下文
    return content.slice(-800);
  };

  const handleSave = async () => {
    if (!chapterId || !content) return;

    setIsSaving(true);
    try {
      const illustrationsPayload = JSON.stringify(illustrations);
      await chapterApi.update(chapterId, content, undefined, illustrationsPayload);
      setIsSaved(true);

      // Fire-and-forget: index this chapter into the local knowledge base.
      if (hasValidEmbeddingConfig && projectId && content.trim().length > 200) {
        const pid = projectId;
        const cid = chapterId;
        const ctitle = chapter?.title || '';
        const ctext = content;

        knowledgeApi
          .indexChapter({
            projectId: pid,
            chapterId: cid,
            text: ctext,
            embeddingConfig,
          })
          .then((r) => {
            if (!r.skipped) {
              console.info(`[KB] Indexed ${r.chunksIndexed} chunks for chapter ${cid}`);
            }
          })
          .catch((e) => {
            console.warn('[KB] Index failed:', e);
          });

        if (summariesEnabled && textModelConfig.apiKey.trim()) {
          knowledgeApi
            .generateChapterSummary({
              projectId: pid,
              chapterId: cid,
              chapterTitle: ctitle,
              chapterText: ctext,
              textConfig: textModelConfig,
              embeddingConfig,
            })
            .catch((e) => console.warn('[KB] Chapter summary failed:', e));

          knowledgeApi
            .markRollupsStale(pid)
            .catch((e) => console.warn('[KB] Mark stale failed:', e));
        }

        if (entitiesEnabled && textModelConfig.apiKey.trim()) {
          const knownCharacterNames = getCharacters(pid).map((c) => c.name).filter(Boolean);
          knowledgeApi
            .extractEntities({
              projectId: pid,
              chapterId: cid,
              chapterTitle: ctitle,
              chapterText: ctext,
              knownCharacterNames,
              textConfig: textModelConfig,
              embeddingConfig,
            })
            .catch((e) => console.warn('[KB] Entity extraction failed:', e));
        }
      }
    } catch (error) {
      console.error('Failed to save:', error);
      setError(tx(uiLanguage, '保存失败', 'Save failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setIsSaved(false);
    setRevisionSelection(null);
    setRevisionButtonPos(null);
  };

  const getCaretClientPosition = (textarea: HTMLTextAreaElement, position: number) => {
    const div = document.createElement('div');
    const style = window.getComputedStyle(textarea);
    const properties = [
      'direction',
      'box-sizing',
      'width',
      'height',
      'overflow-x',
      'overflow-y',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'font-style',
      'font-variant',
      'font-weight',
      'font-stretch',
      'font-size',
      'line-height',
      'font-family',
      'text-align',
      'text-transform',
      'text-indent',
      'text-decoration',
      'letter-spacing',
      'word-spacing',
      'tab-size',
      '-moz-tab-size',
    ];

    properties.forEach(prop => {
      const value = style.getPropertyValue(prop);
      if (value) {
        div.style.setProperty(prop, value);
      }
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
    if (start === end) {
      setRevisionSelection(null);
      setRevisionButtonPos(null);
      return;
    }

    const selectedText = textarea.value.slice(start, end);
    if (!selectedText.trim()) {
      setRevisionSelection(null);
      setRevisionButtonPos(null);
      return;
    }

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
      setError(tx(uiLanguage, '请先在设置页面配置 DeepSeek API 密钥', 'Configure text model API key in Settings first'));
      return;
    }
    setIsRevising(true);
    const { start, end, text } = revisionSelection;
    try {
      const revised = await invoke<string>('generate_revision', {
        input: {
          text,
          goals: '润色并保持原意，使表达更自然流畅',
          text_config: textModelConfig,
        },
      });

      setContent(prev => prev.slice(0, start) + revised + prev.slice(end));
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
      const message = typeof err === 'string' ? err : (err as Error)?.message || '润色失败';
      setError(message);
    } finally {
      setIsRevising(false);
    }
  };

  // 生成新内容（从头或续写）
  const handleGenerate = async (mode: 'new' | 'continue' = 'new') => {
    if (!hasValidTextConfig) {
      setError(tx(uiLanguage, '请先在设置页面配置 DeepSeek API 密钥', 'Configure text model API key in Settings first'));
      return;
    }

    if (!chapter) {
      setError(tx(uiLanguage, '章节信息未加载', 'Chapter data is not loaded'));
      return;
    }

    setError(null);
    setIsGenerating(true);
    
    // 续写模式：在现有内容后追加
    if (mode === 'new') {
      setContent('');
    }

    try {
      const unlisten = await listen<string>('chapter-stream', (event) => {
        setContent(prev => prev + event.payload);
      });

      // 获取上下文信息
      const previousSummary = getPreviousChapterSummary();
      const currentTail = mode === 'continue' ? getCurrentContentTail() : null;

      // 获取角色信息，确保AI生成时保持角色一致性
      const characters = projectId ? getCharacters(projectId) : [];
      const charactersInfo = characters.length > 0 
        ? characters.map((c, i) => {
            const isProtag = c.isProtagonist ? '【主角】' : '';
            return `${i + 1}. ${c.name}${isProtag}\n   - 性别：${c.gender || '未设定'}\n   - 身份：${c.role || '未设定'}\n   - 性格：${c.personality || '未设定'}\n   - 背景：${c.background || '未设定'}\n   - 动机：${c.motivation || '未设定'}\n   - 形象：${c.appearance || '未设定'}`;
          }).join('\n')
        : null;

      // 获取世界观设定和时间线，防止章节之间冲突
      const worldSetting = projectId ? getWorldSetting(projectId) : '';
      const timeline = projectId ? getTimeline(projectId) : '';

      // Long-range semantic retrieval (RAG). Falls through silently on failure.
      let longRangeContext = '';
      if (hasValidEmbeddingConfig && projectId) {
        try {
          const queryParts = [
            chapter.title,
            chapter.outline_goal,
            chapter.conflict,
          ].filter((s): s is string => Boolean(s && s.trim()));
          const query = queryParts.join('\n');

          const recentIds = [...allChapters]
            .filter((c) => (c.final_text || c.draft_text || '').trim().length > 0)
            .sort((a, b) => b.order_index - a.order_index)
            .slice(0, 3)
            .map((c) => c.id);

          longRangeContext = await knowledgeApi.retrieveContext({
            projectId,
            query,
            topK: 5,
            excludeChapterIds: recentIds,
            embeddingConfig,
            includeSummaries: summariesEnabled,
            includeForeshadowing: entitiesEnabled,
          });
        } catch (e) {
          console.warn('[KB] Retrieve failed, falling back to legacy context only:', e);
        }
      }

      const enrichedWorldSetting = longRangeContext
        ? `${worldSetting || ''}\n\n【长程相关记忆】\n${longRangeContext}`.trim()
        : (worldSetting || null);

      await invoke<string>('generate_chapter_stream', {
        chapterTitle: chapter.title,
        outlineGoal: chapter.outline_goal || '推进剧情发展',
        conflict: chapter.conflict || '角色面临挑战',
        previousSummary: previousSummary,
        currentContent: currentTail,
        charactersInfo: charactersInfo,
        worldSetting: enrichedWorldSetting,
        timeline: timeline || null,
        targetWords: TARGET_WORDS_PER_GENERATION,
        isContinuation: mode === 'continue',
        outputLanguage: projectLanguage,
        textConfig: textModelConfig,
      });

      unlisten();
      setIsSaved(false);
    } catch (err) {
      const errorMessage = typeof err === 'string' ? err : (err as Error)?.message || '生成失败';
      if (!errorMessage.includes('cancelled') && !errorMessage.includes('中断')) {
        setError(errorMessage);
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStop = async () => {
    try {
      await invoke('cancel_generation');
    } catch (err) {
      console.error('Failed to cancel:', err);
    }
    setIsGenerating(false);
  };

  // 生成章节推文（封面+摘要）
  const handleGeneratePrologue = async () => {
    if (!hasValidTextConfig) {
      setError(tx(uiLanguage, '请先在设置页面配置 DeepSeek API 密钥', 'Configure text model API key in Settings first'));
      return;
    }

    if (!projectId) {
      setError(tx(uiLanguage, '项目信息未加载', 'Project data is not loaded'));
      return;
    }

    setError(null);
    setIsGenerating(true);
    setIsSaved(false);
    setContent('');

    let unlisten: (() => void) | null = null;

    try {
      unlisten = await listen<string>('chapter-stream', (event) => {
        setContent(prev => prev + event.payload);
      });

      const project = await projectApi.getById(projectId);
      if (!project?.description || !project.description.trim()) {
        throw new Error('请先生成小说大纲');
      }

      await invoke<string>('generate_prologue_stream', {
        title: project.title,
        genre: project.genre || '未分类',
        outline: project.description,
        outputLanguage: project.language || 'zh',
        textConfig: textModelConfig,
      });
    } catch (err) {
      const message =
        typeof err === 'string'
          ? err
          : (err as Error)?.message || tx(uiLanguage, '序章生成失败', 'Failed to generate prologue');
      if (!message.includes('cancelled') && !message.includes('中断')) {
        setError(message);
      }
    } finally {
      if (unlisten) {
        unlisten();
      }
      setIsGenerating(false);
    }
  };

  const openPromoStyleConfig = () => {
    if (!content || content.trim().length < 100) {
      setPromoError(
        tx(
          uiLanguage,
          '章节内容太少，请先生成或编写更多内容（至少100字）',
          'Chapter content is too short. Generate or write more content (at least 100 characters).'
        )
      );
      return;
    }

    if (!hasValidTextConfig) {
      setPromoError(tx(uiLanguage, '请先在设置中配置DeepSeek API Key', 'Configure text model API key in Settings first'));
      return;
    }

    setPromoError(null);
    setShowPromoStyleConfig(true);
  };

  const handleGeneratePromo = async (styleInput?: string) => {
    if (!content || content.trim().length < 100) {
      setPromoError(
        tx(
          uiLanguage,
          '章节内容太少，请先生成或编写更多内容（至少100字）',
          'Chapter content is too short. Generate or write more content (at least 100 characters).'
        )
      );
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
      // 第一步：生成摘要和图片提示词
      const promoData = await invoke<{ image_prompt: string; summary: string }>('generate_chapter_promo', {
        chapterTitle: chapter?.title || (projectLanguage === 'en' ? 'Untitled Chapter' : '未命名章节'),
        chapterContent: content,
        style,
        outputLanguage: projectLanguage,
        textConfig: textModelConfig,
      });

      // 第二步：生成图片（3:1比例，1200x400）
      const imageBase64 = await invoke<string>('generate_promo_image', {
        prompt: promoData.image_prompt,
        width: 1200,
        height: 400,
        pollinationsKey: pollinationsKey || null,
        engine: imageEngine,
        comfyuiUrl: comfyUIUrl || null,
      });

      const newPromoResult = {
        imagePrompt: promoData.image_prompt,
        summary: promoData.summary,
        imageBase64: imageBase64,
      };
      
      setPromoResult(newPromoResult);
      setIsPromoExpanded(true); // 生成成功后自动展开
      
      // 保存到store（持久化）
      if (chapterId) {
        setPromo(chapterId, newPromoResult);
      }
    } catch (err) {
      const errorMessage =
        typeof err === 'string'
          ? err
          : (err as Error)?.message || tx(uiLanguage, '推文生成失败', 'Failed to generate promo');
      setPromoError(errorMessage);
    } finally {
      setIsGeneratingPromo(false);
    }
  };

  const confirmPromoGeneration = async () => {
    setShowPromoStyleConfig(false);
    await handleGeneratePromo(promoStyle);
  };

  const toggleParagraphSelection = (index: number) => {
    setSelectedParagraphs(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const clearParagraphSelection = () => {
    setSelectedParagraphs(new Set());
  };

  const toggleIllustrationPreview = (id: string) => {
    setActiveIllustrationId(prev => (prev === id ? null : id));
  };

  const handleAnchorInputChange = (id: string, value: string) => {
    setAnchorEdits(prev => ({ ...prev, [id]: value }));
  };

  const applyAnchorChange = (id: string) => {
    if (paragraphs.length === 0) return;
    const rawValue = anchorEdits[id];
    const parsed = rawValue ? parseInt(rawValue, 10) : NaN;
    if (Number.isNaN(parsed)) return;
    const clamped = Math.min(Math.max(1, parsed), paragraphs.length);
    setIllustrations(prev =>
      prev.map(item => (item.id === id ? { ...item, anchorIndex: clamped } : item))
    );
    setAnchorEdits(prev => ({ ...prev, [id]: String(clamped) }));
    setIsSaved(false);
  };

  const handleDeleteIllustration = async (id: string) => {
    const confirmed = await confirmDialog(
      tx(uiLanguage, '确定删除这张插图吗？', 'Delete this illustration?'),
      tx(uiLanguage, '删除插图', 'Delete Illustration')
    );
    if (!confirmed) return;
    setIllustrations(prev => prev.filter(item => item.id !== id));
    setAnchorEdits(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (activeIllustrationId === id) {
      setActiveIllustrationId(null);
    }
    setIsSaved(false);
  };

  const openIllustrationConfig = () => {
    if (!hasValidTextConfig) {
      setIllustrationError(tx(uiLanguage, '请先在设置页面配置 DeepSeek API 密钥', 'Configure text model API key in Settings first'));
      return;
    }
    if (selectedIndices.length === 0) {
      setIllustrationError(tx(uiLanguage, '请先勾选需要生成插图的段落', 'Select paragraphs before generating illustrations'));
      return;
    }

    setIllustrationError(null);
    setIllustrationConfigDraft({ ...illustrationConfig });
    setShowIllustrationConfig(true);
  };

  const generateIllustrationWithConfig = async (config: IllustrationConfig) => {
    if (!hasValidTextConfig) {
      setIllustrationError(tx(uiLanguage, '请先在设置页面配置 DeepSeek API 密钥', 'Configure text model API key in Settings first'));
      return;
    }
    if (selectedIndices.length === 0) {
      setIllustrationError(tx(uiLanguage, '请先勾选需要生成插图的段落', 'Select paragraphs before generating illustrations'));
      return;
    }

    setIllustrationError(null);
    setIsGeneratingIllustration(true);

    try {
      const selectedText = selectedIndices
        .map(index => paragraphs[index - 1])
        .filter(Boolean)
        .join('\n\n');
      const anchorIndex = selectedIndices[0];

      const prompt = await invoke<string>('generate_illustration_prompt', {
        text: selectedText,
        style: config.style?.trim() || null,
        textConfig: textModelConfig,
      });

      const imageBase64 = await invoke<string>('generate_promo_image', {
        prompt: prompt,
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

      setIllustrations(prev => [...prev, newIllustration]);
      setActiveIllustrationId(newIllustration.id);
      clearParagraphSelection();
      setIsSaved(false);
    } catch (err) {
      const errorMessage =
        typeof err === 'string'
          ? err
          : (err as Error)?.message || tx(uiLanguage, '插图生成失败', 'Failed to generate illustration');
      setIllustrationError(errorMessage);
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

  const getChapterDisplayTitle = (targetChapter: Chapter): string => {
    const targetIsPrologue = targetChapter.title.trim() === '序章' || targetChapter.order_index === 0;
    if (targetIsPrologue) {
      return tx(uiLanguage, '序章', 'Prologue');
    }
    return uiLanguage === 'en'
      ? `Chapter ${targetChapter.order_index} - ${targetChapter.title}`
      : `第${targetChapter.order_index}章 - ${targetChapter.title}`;
  };

  const handleSwitchChapter = async (targetChapter: Chapter) => {
    if (!projectId || !targetChapter.id) return;

    if (targetChapter.id === chapterId) {
      setShowChapterSwitcher(false);
      return;
    }

    if (!isSaved) {
      const confirmed = await confirmDialog(
        tx(
          uiLanguage,
          '当前有未保存内容，切换章节会丢失修改，确定继续吗？',
          'You have unsaved changes. Switching chapters will discard them. Continue?'
        ),
        tx(uiLanguage, '未保存内容', 'Unsaved Changes')
      );
      if (!confirmed) {
        return;
      }
    }

    setShowChapterSwitcher(false);
    navigate(`/editor/${projectId}/${targetChapter.id}`);
  };

  useEffect(() => {
    setShowChapterSwitcher(false);
  }, [chapterId]);

  useEffect(() => {
    if (!showChapterSwitcher) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!chapterSwitcherRef.current) return;
      if (!chapterSwitcherRef.current.contains(event.target as Node)) {
        setShowChapterSwitcher(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowChapterSwitcher(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showChapterSwitcher]);

  // 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [content, chapterId]);

  const isPrologue = chapter?.title.trim() === '序章' || chapter?.order_index === 0;
  const headerTitle = chapter
    ? isPrologue
      ? tx(uiLanguage, '序章', 'Prologue')
      : uiLanguage === 'en'
        ? `Chapter ${chapter.order_index} - ${chapter.title}`
        : `第${chapter.order_index}章 - ${chapter.title}`
    : tx(uiLanguage, '章节编辑器', 'Chapter Editor');

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between mb-4 pb-4 border-b border-gray-200 dark:border-gray-700 flex-wrap gap-2">
        <div className="flex items-center space-x-4 min-w-0 flex-shrink">
          <Button variant="ghost" onClick={smartBack} className="whitespace-nowrap flex-shrink-0">
            <ArrowLeft className="w-4 h-4 mr-2" />
            {tx(uiLanguage, '返回', 'Back')}
          </Button>
          {projectId && <WorkspaceChapterEntry projectId={projectId} chapterId={chapter?.id} canReview={isSaved && !isGenerating && !isSaving} onReviewed={accepted => { if (accepted) void loadChapterData(); }} />}
          <div ref={chapterSwitcherRef} className="min-w-0 relative">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white truncate">
              <button
                type="button"
                onClick={() => setShowChapterSwitcher(prev => !prev)}
                className="inline-flex max-w-full items-center gap-1.5 text-left text-gray-900 dark:text-white hover:text-primary-600 dark:hover:text-primary-300 transition-colors"
                title={tx(uiLanguage, '点击切换章节', 'Click to switch chapter')}
              >
                <span className="truncate">{headerTitle}</span>
                {showChapterSwitcher ? (
                  <ChevronUp className="w-4 h-4 flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 flex-shrink-0" />
                )}
              </button>
            </h2>
            {showChapterSwitcher && sortedChapters.length > 0 && (
              <div className="absolute left-0 top-full z-30 mt-2 w-[min(90vw,30rem)] max-h-80 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg">
                {sortedChapters.map(item => {
                  const itemIsPrologue = item.title.trim() === '序章' || item.order_index === 0;
                  const isCurrent = item.id === chapterId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => void handleSwitchChapter(item)}
                      className={`w-full px-3 py-2 text-left border-b last:border-b-0 border-gray-100 dark:border-gray-700 transition-colors ${
                        isCurrent
                          ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                          : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/40'
                      }`}
                    >
                      <p className="text-sm font-medium truncate">{getChapterDisplayTitle(item)}</p>
                      {!itemIsPrologue && item.outline_goal && (
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 truncate">
                          {stripMarkdown(item.outline_goal).replace(
                            /^(目标|Goal)\s*[：:]\s*/i,
                            projectLanguage === 'en' ? 'Goal: ' : '目标：'
                          )}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {(isPrologue || chapter?.outline_goal) && (
              <p
                className="text-sm text-gray-500 dark:text-gray-400 mt-1 truncate max-w-md"
                title={isPrologue ? (chapter?.final_text || chapter?.draft_text || '') : chapter?.outline_goal}
              >
                {isPrologue
                  ? stripMarkdown(chapter?.final_text || chapter?.draft_text || '') ||
                    tx(uiLanguage, '待生成', 'Pending')
                  : stripMarkdown(chapter?.outline_goal || '').replace(
                      /^(目标|Goal)\s*[：:]\s*/i,
                      projectLanguage === 'en' ? 'Goal: ' : '目标：'
                    )}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center space-x-3 flex-shrink-0">
          {/* 字数统计 */}
          <div className="flex items-center text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
            <FileText className="w-4 h-4 mr-1" />
            <span>
              {wordCount}
              {tx(uiLanguage, '字', ' chars')}
            </span>
          </div>
          
          {/* 保存状态 */}
          {isSaved ? (
            <span className="flex items-center text-green-600 dark:text-green-400 text-sm whitespace-nowrap">
              <Check className="w-4 h-4 mr-1" />
              {tx(uiLanguage, '已保存', 'Saved')}
            </span>
          ) : (
            <span className="text-orange-500 text-sm whitespace-nowrap">
              {tx(uiLanguage, '未保存', 'Unsaved')}
            </span>
          )}
          
          {/* 操作按钮 */}
          <div className="flex space-x-2 flex-shrink-0">
            {isGenerating ? (
                <Button onClick={handleStop} variant="outline" className="bg-red-50 border-red-300 text-red-600 hover:bg-red-100 whitespace-nowrap">
                  <StopCircle className="w-4 h-4 mr-1" />
                  {tx(uiLanguage, '停止', 'Stop')}
                </Button>
              ) : (
              <>
                {/* 如果没有内容，显示"AI生成"；如果有内容，显示"AI续写" */}
                {content ? (
                  <Button variant="outline" onClick={() => handleGenerate('continue')} className="whitespace-nowrap">
                    <ChevronRight className="w-4 h-4 mr-1" />
                    {tx(uiLanguage, '续写', 'Continue')}
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => handleGenerate('new')} className="whitespace-nowrap">
                    <Sparkles className="w-4 h-4 mr-1" />
                    {tx(uiLanguage, '生成', 'Generate')}
                  </Button>
                )}
                {/* 生成推文按钮 */}
                <Button 
                  variant="outline" 
                  onClick={openPromoStyleConfig} 
                  disabled={isGeneratingPromo || !content || content.trim().length < 100}
                  className="whitespace-nowrap"
                  title={
                    !content || content.trim().length < 100
                      ? tx(uiLanguage, '需要至少100字内容', 'At least 100 characters required')
                      : tx(uiLanguage, '生成章节封面和摘要', 'Generate chapter cover and summary')
                  }
                >
                  {isGeneratingPromo ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Image className="w-4 h-4 mr-1" />
                  )}
                  {tx(uiLanguage, '推文', 'Promo')}
                </Button>
                {/* 插图模式按钮 */}
                <Button
                  variant={isIllustrationMode ? 'secondary' : 'outline'}
                  onClick={() => setIsIllustrationMode(prev => !prev)}
                  className="whitespace-nowrap"
                  title={
                    isIllustrationMode
                      ? tx(uiLanguage, '退出插图模式', 'Exit illustration mode')
                      : tx(uiLanguage, '进入插图模式', 'Enter illustration mode')
                  }
                >
                  <Image className="w-4 h-4 mr-1" />
                  {tx(uiLanguage, '插图', 'Illustration')}
                </Button>
              </>
            )}
            <Button onClick={handleSave} loading={isSaving} disabled={isSaved} className="whitespace-nowrap">
              <Save className="w-4 h-4 mr-1" />
              {tx(uiLanguage, '保存', 'Save')}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
        <div className="w-full lg:w-4/5 flex flex-col min-h-0 lg:order-1">
          {/* 推文展示区域（封面+摘要） */}
          {(promoResult || promoError) && (
            <div className="mb-4 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              {/* 折叠/展开标题栏 */}
              <button
                onClick={() => setIsPromoExpanded(!isPromoExpanded)}
                className="w-full flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <Image className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    {tx(uiLanguage, '章节推文', 'Chapter Promo')}
                  </span>
                  {promoResult && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {tx(uiLanguage, '（封面 + 摘要）', '(Cover + Summary)')}
                    </span>
                  )}
                </div>
                {isPromoExpanded ? (
                  <ChevronUp className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                )}
              </button>

              {/* 展开的内容 */}
              {isPromoExpanded && (
                <div className="p-4 bg-white dark:bg-gray-900">
                  {promoError && (
                    <div className="text-red-500 text-sm mb-3">
                      {promoError}
                      <button 
                        onClick={() => setPromoError(null)} 
                        className="ml-2 underline"
                      >
                        {tx(uiLanguage, '关闭', 'Close')}
                      </button>
                    </div>
                  )}
                  
                  {promoResult && (
                    <div className="space-y-4">
                      {/* 封面图片 */}
                      {promoResult.imageBase64 && (
                        <div className="relative">
                          <img 
                            src={promoResult.imageBase64} 
                            alt={tx(uiLanguage, '章节封面', 'Chapter Cover')}
                            className="w-full rounded-lg shadow-md"
                            style={{ aspectRatio: '3/1', objectFit: 'cover' }}
                          />
                        </div>
                      )}
                      
                      {/* 摘要 */}
                      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                        <div className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
                          {tx(uiLanguage, '摘要：', 'Summary:')}
                        </div>
                        <p className="text-gray-800 dark:text-gray-200 leading-relaxed">
                          {promoResult.summary}
                        </p>
                      </div>

                      {/* 重新生成按钮 */}
                      <div className="flex justify-end">
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={openPromoStyleConfig}
                          disabled={isGeneratingPromo}
                        >
                          {isGeneratingPromo ? (
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3 h-3 mr-1" />
                          )}
                          {tx(uiLanguage, '重新生成', 'Regenerate')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-4">
              <p className="text-red-600 dark:text-red-400">{error}</p>
              <button 
                onClick={() => setError(null)} 
                className="text-sm text-red-500 underline mt-1"
              >
                {tx(uiLanguage, '关闭', 'Close')}
              </button>
            </div>
          )}

          {/* 生成状态指示器 */}
          {isGenerating && (
            <div className="flex items-center mb-4 text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20 p-3 rounded-lg">
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              <span>{tx(uiLanguage, 'AI正在生成内容...', 'AI is generating content...')}</span>
            </div>
          )}

          {/* 编辑区域 */}
          <div
            ref={editorContainerRef}
            className="flex-1 min-h-0 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden relative"
          >
            {revisionSelection && revisionButtonPos && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handlePolishSelection}
                disabled={isRevising}
                className="absolute z-10 w-8 h-8 rounded-full bg-primary-600 hover:bg-primary-700 text-white flex items-center justify-center shadow-md"
                style={{ left: revisionButtonPos.x, top: revisionButtonPos.y }}
                title={tx(uiLanguage, '润色选中内容', 'Polish selected text')}
              >
                {isRevising ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              </button>
            )}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={handleContentChange}
              onMouseUp={updateRevisionSelection}
              onKeyUp={updateRevisionSelection}
              onSelect={updateRevisionSelection}
              onScroll={() => {
                if (revisionSelection) {
                  updateRevisionSelection();
                }
              }}
              onBlur={() => {
                setRevisionSelection(null);
                setRevisionButtonPos(null);
              }}
              className="w-full h-full resize-none border-none focus:outline-none dark:bg-gray-800 dark:text-white p-6 font-serif text-lg leading-relaxed"
               placeholder={
                 uiLanguage === 'en'
                   ? `Start writing here...

Tips:
- Press Ctrl+S to save quickly
- Click "Continue" to let AI keep writing
- You can edit AI-generated content anytime`
                   : `在这里开始写作...

提示：
- 使用 Ctrl+S 快速保存
- 点击「AI续写」让AI继续创作
- 可以随时编辑AI生成的内容`
               }
               disabled={isGenerating}
             />
          </div>
        </div>
        <div className="w-full lg:w-1/5 lg:min-w-[260px] flex flex-col min-h-0 lg:order-2">
          {/* 插图模式面板（段落列表） */}
          <div className="mb-4 lg:mb-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden flex flex-col h-full min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-gray-50 dark:bg-gray-800">
              <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <Image className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                <span className="font-medium">{tx(uiLanguage, '插图段落', 'Illustration Paragraphs')}</span>
                <span className="text-xs text-gray-500">
                  ({paragraphs.length}
                  {tx(uiLanguage, ' 段', ' paragraphs')})
                </span>
                {isIllustrationMode && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300">
                    {tx(uiLanguage, '插图模式', 'Illustration Mode')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={openIllustrationConfig}
                  loading={isGeneratingIllustration}
                  disabled={!isIllustrationMode || selectedIndices.length === 0}
                  className="whitespace-nowrap"
                >
                  {tx(uiLanguage, '生成插图', 'Generate Illustration')}
                  {selectedIndices.length > 0
                    ? uiLanguage === 'en'
                      ? ` (${selectedIndices.length})`
                      : `（${selectedIndices.length}段）`
                    : ''}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={clearParagraphSelection}
                  disabled={selectedIndices.length === 0}
                  className="whitespace-nowrap"
                >
                  {tx(uiLanguage, '清空勾选', 'Clear Selection')}
                </Button>
              </div>
            </div>

            {illustrationError && (
              <div className="px-3 pb-2 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 border-t border-red-200 dark:border-red-800">
                {illustrationError}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
              {paragraphs.length === 0 ? (
                <div className="p-4 text-sm text-gray-500 dark:text-gray-400">
                  {tx(uiLanguage, '暂无内容，无法生成插图', 'No content available for illustration')}
                </div>
              ) : (
                paragraphs.map((para, idx) => {
                  const index = idx + 1;
                  const items = illustrationsByAnchor.get(index) || [];
                  const isSelected = selectedParagraphs.has(index);

                  return (
                    <div
                      key={index}
                      className={`flex items-start gap-3 p-3 ${isSelected ? 'bg-primary-50 dark:bg-primary-900/20' : ''}`}
                    >
                      <div className="flex flex-col items-center gap-2 pt-1 w-12">
                        <span className="text-[10px] text-gray-400">#{index}</span>
                        {isIllustrationMode && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleParagraphSelection(index)}
                            className="h-4 w-4 accent-primary-600"
                          />
                        )}
                        <div className="flex flex-col gap-1">
                          {items.map(item => (
                            <button
                              key={item.id}
                              onClick={() => toggleIllustrationPreview(item.id)}
                              className={`p-1 rounded-full border ${
                                activeIllustrationId === item.id
                                  ? 'bg-primary-100 border-primary-400 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                                  : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-100 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-300'
                              }`}
                              title={tx(uiLanguage, '查看插图', 'View illustration')}
                            >
                              <Image className="w-3 h-3" />
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                          {para}
                        </p>

                        {items.map(item => (
                          activeIllustrationId === item.id && (
                            <div
                              key={`${item.id}-preview`}
                              className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3"
                            >
                              <img
                                src={item.imageBase64}
                                alt={tx(uiLanguage, '插图', 'Illustration')}
                                className="w-full rounded-md shadow-sm"
                              />
                              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                                <span className="text-gray-500 dark:text-gray-400">
                                  {tx(uiLanguage, '位置', 'Anchor')}
                                </span>
                                <input
                                  type="number"
                                  min={1}
                                  max={paragraphs.length}
                                  value={anchorEdits[item.id] ?? String(item.anchorIndex)}
                                  onChange={e => handleAnchorInputChange(item.id, e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      applyAnchorChange(item.id);
                                    }
                                  }}
                                  className="w-20 px-2 py-1 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => applyAnchorChange(item.id)}
                                >
                                  {tx(uiLanguage, '移动', 'Move')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleDeleteIllustration(item.id)}
                                  className="text-red-600 hover:text-red-700"
                                >
                                  {tx(uiLanguage, '删除', 'Delete')}
                                </Button>
                              </div>
                            </div>
                          )
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {showPromoStyleConfig && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
              {tx(uiLanguage, '章节封面风格', 'Chapter Cover Style')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '图片风格', 'Image Style')}
                </label>
                <input
                  type="text"
                  list="promo-style-options"
                  value={promoStyle}
                  onChange={e => setPromoStyle(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                  placeholder={tx(
                    uiLanguage,
                    '选择或输入风格（支持中文，会自动转换）',
                    'Select or type a style (non-English is auto-converted)'
                  )}
                />
                <datalist id="promo-style-options">
                  <option value="cinematic" />
                  <option value="watercolor" />
                  <option value="anime" />
                </datalist>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {tx(
                  uiLanguage,
                  '支持自定义输入（含中文），系统会将风格整合为英文提示词用于生图',
                  'Custom input supported. Non-English style words are translated into English prompts.'
                )}
              </p>
            </div>
            <div className="flex space-x-3 pt-6">
              <Button type="button" variant="outline" onClick={() => setShowPromoStyleConfig(false)} className="flex-1">
                {tx(uiLanguage, '取消', 'Cancel')}
              </Button>
              <Button onClick={confirmPromoGeneration} loading={isGeneratingPromo} className="flex-1">
                {tx(uiLanguage, '生成', 'Generate')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showIllustrationConfig && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
              {tx(uiLanguage, '插图生成设置', 'Illustration Settings')}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '模型', 'Model')}
                </label>
                <input
                  type="text"
                  value={illustrationConfigDraft.model}
                  onChange={e => setIllustrationConfigDraft(prev => ({ ...prev, model: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                  placeholder="zimage"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {tx(uiLanguage, '宽度', 'Width')}
                  </label>
                  <input
                    type="number"
                    value={illustrationConfigDraft.width}
                    onChange={e => setIllustrationConfigDraft(prev => ({
                      ...prev,
                      width: parseInt(e.target.value, 10) || prev.width,
                    }))}
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                    min={64}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {tx(uiLanguage, '高度', 'Height')}
                  </label>
                  <input
                    type="number"
                    value={illustrationConfigDraft.height}
                    onChange={e => setIllustrationConfigDraft(prev => ({
                      ...prev,
                      height: parseInt(e.target.value, 10) || prev.height,
                    }))}
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                    min={64}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {tx(uiLanguage, '图片风格', 'Image Style')}
                </label>
                <input
                  type="text"
                  list="illustration-style-options"
                  value={illustrationConfigDraft.style}
                  onChange={e => setIllustrationConfigDraft(prev => ({ ...prev, style: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                  placeholder={tx(
                    uiLanguage,
                    '选择或输入风格（支持中文，会自动翻译）',
                    'Select or type a style (non-English is auto-translated)'
                  )}
                />
                <datalist id="illustration-style-options">
                  <option value="cinematic" />
                  <option value="watercolor" />
                  <option value="anime" />
                </datalist>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400">
                {tx(
                  uiLanguage,
                  '默认模型为 zimage，建议 16:9 或 3:2 比例更适合插图展示',
                  'Default model is zimage. 16:9 or 3:2 works best for illustration layout.'
                )}
              </p>
            </div>

            <div className="flex space-x-3 pt-6">
              <Button type="button" variant="outline" onClick={() => setShowIllustrationConfig(false)} className="flex-1">
                {tx(uiLanguage, '取消', 'Cancel')}
              </Button>
              <Button onClick={confirmIllustrationGeneration} loading={isGeneratingIllustration} className="flex-1">
                {tx(uiLanguage, '生成', 'Generate')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
