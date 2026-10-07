// Agent tool registry — ports the core of Android agent/AgentController.kt onto the PC data layer
// (Tauri SQLite for projects/chapters, zustand for per-project maps). Each tool returns a short
// result string that's fed back to the model on the next ReAct turn.

import { useAppStore } from '@store/index';
import type { Character, CultivationRealm, Volume, ContainerType, PlotArc } from '@store/index';
import { CONTAINER_SINGLE_BLOCK_KEY } from '@store/index';
import { projectApi, chapterApi, aiApi, knowledgeApi, snapshotApi } from '@services/api';
import type { Chapter, TextModelConfig, EmbeddingConfig, CreateProjectInput } from '@typings/index';
import { invoke } from '@tauri-apps/api/tauri';
import { generateVolumes, generateArcsForVolume } from '@utils/volumeAi';
import { buildGenerationGuidance } from '@utils/containerAi';
import { buildSnapshotContent, restoreSnapshot } from '@utils/snapshots';
import { buildRealmSystemContext, buildVolumeRealmConstraint } from '@utils/cultivation';
import { readTextRange, searchText } from '../writing';
import { generateWorkspaceChapter, latestWorkspaceCheckpoint, getWorkspaceCandidates } from '../writingUi/workspaceRuntime';
import { useAgentStream } from './agentStream';
import { proposeAgentBody } from './agentWriting';

type Lang = 'zh' | 'en';
type Args = Record<string, any>;

export interface AgentToolCtx {
  signal?: AbortSignal;
  sessionId?: string;
  getFocusId: () => string | null;
  setFocusId: (id: string | null) => void;
  textConfig: TextModelConfig;
  embeddingConfig: EmbeddingConfig;
  uiLanguage: Lang;
  /** Emit an image bubble into the agent chain (e.g. a generated cover/portrait/illustration). */
  pushImage?: (label: string, dataUrl: string) => void;
}

export interface AgentTool {
  name: string;
  desc: string;
  sensitive?: boolean;
  run: (args: Args, ctx: AgentToolCtx) => Promise<string>;
}

const s = () => useAppStore.getState();
const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function resolvePid(args: Args, ctx: AgentToolCtx): string {
  const pid = (typeof args.projectId === 'string' && args.projectId.trim()) ? args.projectId.trim() : ctx.getFocusId();
  if (!pid) throw new Error('没有聚焦项目，请先 create_project 或 focus_project');
  return pid;
}

async function refreshProjects() {
  const all = await projectApi.getAll();
  useAppStore.getState().setProjects(all);
  // Signal any open chapter-list page (e.g. the editor) to re-fetch chapters this run just changed.
  useAppStore.getState().bumpChaptersVersion();
}

function parseJsonObject(raw: string): Record<string, any> {
  let value: unknown;
  try { value = JSON.parse(raw.trim()); } catch { throw new Error('模型输出不是完整纯JSON对象，请缩小单次任务或重试；未导入部分内容'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型应输出JSON对象');
  return value as Record<string, any>;
}
function parseJsonArray(raw: string): any[] {
  let value: unknown;
  try { value = JSON.parse(raw.trim()); } catch { throw new Error('模型JSON数组被截断或带有说明；未采用不完整结果，请分批执行'); }
  if (!Array.isArray(value) || !value.length) throw new Error('模型未返回非空JSON数组');
  return value;
}

function findChar(pid: string, ident: string): Character | undefined {
  const chars = s().getCharacters(pid);
  return chars.find((c) => c.id === ident) || chars.find((c) => c.name === ident);
}

function chapterContext(pid: string, ctx: AgentToolCtx, chapters: Chapter[]): { world: string; charInfo: string } {
  const chars = s().getCharacters(pid);
  const charInfo = chars.map((c) => {
    const parts = [`【${c.name}】`, c.role && `身份：${c.role}`, c.personality && `性格：${c.personality}`, c.motivation && `动机：${c.motivation}`].filter(Boolean);
    return parts.join('\n');
  }).join('\n\n');
  const realm = buildRealmSystemContext(s().getCultivationRealms(pid), chars, s().getCharacterRealmEvents(pid), chapters, { uiLanguage: ctx.uiLanguage });
  const guidance = buildGenerationGuidance(pid, 'chapter', ctx.uiLanguage);
  const world = [s().getWorldSetting(pid), realm, guidance].filter((x) => x && x.trim()).join('\n\n');
  return { world, charInfo };
}

const ARC_STATUS_ZH: Record<PlotArc['status'], string> = {
  upcoming: '未开始', active: '进行中', ending: '结尾阶段', completed: '已完成',
};

/** Resolve a chapter's owning arc by explicit arc_id, falling back to any arc's builtChapterIds. */
function arcOfChapter(arcs: PlotArc[], chapter: Chapter): PlotArc | undefined {
  return (chapter.arc_id ? arcs.find((a) => a.id === chapter.arc_id) : undefined)
    || arcs.find((a) => (a.builtChapterIds || []).includes(chapter.id));
}

/**
 * Build the 副本 / 弧线 ownership context for a SPECIFIC chapter so generation respects the
 * project → 副本 → 弧线 → 章节 structure (this chapter's own arc), plus a short arc-sequence
 * overview (completed → current → upcoming) for continuity.
 */
function buildChapterArcContext(pid: string, chapter: Chapter): string {
  const arcs = [...s().getPlotArcs(pid)].sort((a, b) => a.order - b.order);
  if (!arcs.length) return '';
  const vols = s().getVolumes(pid);
  const arc = arcOfChapter(arcs, chapter);
  const out: string[] = [];
  let volConstraint = '';
  if (arc) {
    const vol = arc.volumeId ? vols.find((v) => v.id === arc.volumeId) : undefined;
    out.push('【本章所属（副本/弧线）】');
    if (vol) out.push(`副本：${vol.name}${vol.description ? `——${vol.description}` : ''}`);
    out.push(`弧线：${arc.title}（${ARC_STATUS_ZH[arc.status]}）`);
    if (arc.summary) out.push(`弧线概述：${arc.summary}`);
    if (arc.miniOutline) out.push(`弧线细纲：\n${arc.miniOutline.slice(0, 800)}`);
    const idx = arcs.indexOf(arc);
    const done = arcs.filter((a, i) => i < idx && a.status === 'completed');
    const upcoming = arcs.filter((_, i) => i > idx);
    if (done.length) out.push(`已完成弧线：${done.map((a) => a.title).join(' → ')}`);
    if (upcoming.length) out.push(`后续弧线（暂不展开）：${upcoming.map((a) => a.title).join('、')}`);
    if (arc.status === 'ending') out.push('提示：本弧线进入结尾阶段，应推动剧情走向阶段性收束。');
    if (vol) volConstraint = buildVolumeRealmConstraint(vol.realmPlan, vol.name, 'zh', 'generate');
  }
  // The per-volume realm ceiling goes LAST so it reads as the final, overriding instruction.
  return [out.join('\n'), volConstraint].filter((x) => x && x.trim()).join('\n\n');
}

/**
 * Auto-mark arc statuses from chapter content — the "未开始 / 进行中 / 已完成" the user manages by
 * hand, but driven automatically as the agent plans & writes. An arc with chapters is:
 *   - 已完成 when every one of its chapters has text,
 *   - 进行中 when some (but not all) do,
 *   - otherwise left 未开始 (or whatever it currently is if active/ending).
 */
function recomputeArcStatuses(pid: string, chapters: Chapter[]) {
  const arcs = s().getPlotArcs(pid);
  for (const arc of arcs) {
    const built = new Set(arc.builtChapterIds || []);
    const arcChapters = chapters.filter((c) => c.arc_id === arc.id || built.has(c.id));
    if (arcChapters.length === 0) continue;
    const written = arcChapters.filter((c) => (c.final_text || c.draft_text || '').trim().length > 0).length;
    let next: PlotArc['status'];
    if (written === arcChapters.length) next = 'completed';
    else if (written > 0) next = arc.status === 'ending' ? 'ending' : 'active';
    else next = arc.status === 'active' || arc.status === 'ending' ? arc.status : 'upcoming';
    if (next !== arc.status) s().updatePlotArc(pid, arc.id, { status: next });
  }
}

/** Refetch chapters and re-derive every arc's 未开始/进行中/已完成 status. */
async function syncArcStatuses(pid: string) {
  recomputeArcStatuses(pid, await chapterApi.getByProject(pid));
}

/** Reassign the existing order_index value-set to a new chapter id order (preserves 0-based/gaps). */
async function applyChapterOrder(orderedIds: string[], current: Chapter[]) {
  const slots = current.map((c) => c.order_index).sort((a, b) => a - b);
  for (let i = 0; i < orderedIds.length; i++) {
    const ch = current.find((c) => c.id === orderedIds[i]);
    if (ch && ch.order_index !== slots[i]) await chapterApi.updateMeta(ch.id, { order_index: slots[i] });
  }
}

/** Move an arc to position `pos` (1-based) within its own volume (mirrors VolumeArcPanel). */
function moveArcToPosition(pid: string, arcId: string, pos: number) {
  const arcs = s().getPlotArcs(pid);
  const arc = arcs.find((a) => a.id === arcId);
  if (!arc) return;
  const volArcs = arcs.filter((a) => a.volumeId === arc.volumeId).sort((a, b) => a.order - b.order);
  const slots = volArcs.map((a) => a.order);
  const without = volArcs.filter((a) => a.id !== arcId);
  const clamped = Math.max(1, Math.min(volArcs.length, Math.floor(pos)));
  without.splice(clamped - 1, 0, arc);
  without.forEach((a, i) => { if (a.order !== slots[i]) s().updatePlotArc(pid, a.id, { order: slots[i] }); });
}

/** Parse the project's cover_images JSON into a normalized array. */
function parseCovers(raw: string | null | undefined): { id: string; name: string; imageBase64: string; prompt?: string; createdAt?: string }[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((it: any, i: number) => {
      if (typeof it === 'string') return { id: `idx-${i}`, name: `封面 ${i + 1}`, imageBase64: it };
      const b = it?.imageBase64 || it?.image_base64 || it?.image || it?.base64;
      if (!b) return null;
      return { id: it.id || `idx-${i}`, name: it.name || `封面 ${i + 1}`, imageBase64: b, prompt: it.prompt, createdAt: it.createdAt };
    }).filter(Boolean) as any[];
  } catch { return []; }
}

/** Generate one image via the same Tauri command the UI uses. NOTE: the command already returns a
 *  full `data:image/...;base64,...` URL — use it as-is (do NOT re-prefix, or the <img> breaks). */
async function genImageDataUrl(prompt: string, width: number, height: number): Promise<string> {
  const st = s();
  return invoke<string>('generate_promo_image', {
    prompt, width, height, model: 'zimage',
    pollinationsKey: st.pollinationsKey || null,
    engine: st.imageEngine,
    comfyuiUrl: st.comfyUIUrl || null,
  });
}

export const AGENT_TOOLS: AgentTool[] = [
  // ── Projects ──
  { name: 'list_projects', desc: '列出所有小说项目（id/标题/类型）', run: async () => {
    const ps = s().projects;
    if (ps.length === 0) return '（暂无项目）';
    return ps.map((p) => `- ${p.id} | ${p.title} | ${s().getNovelType(p.id)}`).join('\n');
  }},
  { name: 'create_project', desc: '新建项目。args: title, genre?, description?, novelType(long|short)。会自动聚焦', run: async (a, ctx) => {
    if (!a.title) throw new Error('缺少 title');
    const p = await projectApi.create({ title: a.title, genre: a.genre, description: a.description });
    s().setNovelType(p.id, a.novelType === 'short' ? 'short' : 'long');
    ctx.setFocusId(p.id);
    await refreshProjects();
    return `已创建并聚焦项目：${p.id} 《${p.title}》`;
  }},
  { name: 'focus_project', desc: '聚焦到某个已存在项目。args: projectId', run: async (a, ctx) => {
    const p = await projectApi.getById(a.projectId);
    if (!p) throw new Error('项目不存在');
    ctx.setFocusId(p.id);
    return `已聚焦：${p.id} 《${p.title}》`;
  }},
  { name: 'get_overview', desc: '查看项目概览（大纲节选/副本/弧线/角色/章节数）。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const p = await projectApi.getById(pid);
    const chs = await chapterApi.getByProject(pid);
    const arcs = s().getPlotArcs(pid);
    const vols = s().getVolumes(pid);
    const chars = s().getCharacters(pid);
    const outline = s().getLongNovelOutline(pid);
    return [
      `项目：《${p?.title}》（${p?.genre || '未分类'}），共 ${chs.length} 章，${p?.current_word_count ?? 0} 字`,
      `副本 ${vols.length} 个，弧线 ${arcs.length} 条，角色 ${chars.length} 个`,
      outline ? `大纲节选：${outline.slice(0, 300)}…` : '（暂无大纲）',
    ].join('\n');
  }},
  { name: 'get_structure', desc: '查看项目结构树：副本 → 弧线 → 章节。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const vols = s().getVolumes(pid);
    const arcs = s().getPlotArcs(pid);
    const chs = await chapterApi.getByProject(pid);
    const lines: string[] = [];
    const renderArc = (arcId: string) => {
      const arc = arcs.find((x) => x.id === arcId);
      if (!arc) return;
      lines.push(`  ├ 弧线[${arc.id}] ${arc.title}（${arc.status}）`);
      chs.filter((c) => c.arc_id === arc.id).forEach((c) => lines.push(`  │   - 第${c.order_index}章 [${c.id}] ${c.title}`));
    };
    vols.forEach((v) => {
      lines.push(`副本[${v.id}] ${v.name}`);
      arcs.filter((ar) => ar.volumeId === v.id).forEach((ar) => renderArc(ar.id));
    });
    const orphanArcs = arcs.filter((ar) => !ar.volumeId || !vols.some((v) => v.id === ar.volumeId));
    if (orphanArcs.length) { lines.push('未分配副本：'); orphanArcs.forEach((ar) => renderArc(ar.id)); }
    const orphanChs = chs.filter((c) => !c.arc_id);
    if (orphanChs.length) lines.push(`未归属弧线的章节：${orphanChs.map((c) => `第${c.order_index}章`).join('、')}`);
    return lines.join('\n') || '（结构为空）';
  }},

  // ── World / outline ──
  { name: 'set_world_setting', desc: '覆盖世界观。args: projectId?, text', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx); s().setWorldSetting(pid, String(a.text ?? '')); return '世界观已更新';
  }},
  { name: 'set_timeline', desc: '覆盖时间线。args: projectId?, text', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx); s().setTimeline(pid, String(a.text ?? '')); return '时间线已更新';
  }},
  { name: 'generate_outline', desc: '用 AI 生成长篇大纲并保存（含世界观/角色/副本规划/弧线）。args: projectId?, requirements?', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const p = await projectApi.getById(pid);
    const realm = buildRealmSystemContext(s().getCultivationRealms(pid), s().getCharacters(pid), s().getCharacterRealmEvents(pid), [], { uiLanguage: ctx.uiLanguage, ladderOnly: true });
    const sys = '你是资深网文主编，擅长规划长篇连载小说大纲。';
    const user = [
      `为《${p?.title}》（题材：${p?.genre || '未定'}）生成一份长篇大纲。`,
      p?.description ? `简介：${p.description}` : '',
      a.requirements ? `额外要求：${a.requirements}` : '',
      realm || '',
      '请包含：世界观概述、核心人物设定、时间线、副本规划（3-6个）、剧情弧线。用 Markdown 标题分节。',
    ].filter(Boolean).join('\n');
    const out = await aiApi.chat(user, ctx.textConfig, sys);
    s().setLongNovelOutline(pid, out);
    return `大纲已生成并保存（${out.length} 字）。节选：${out.slice(0, 200)}…`;
  }},
  { name: 'import_characters_from_outline', desc: '从大纲识别并导入角色。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const outline = s().getLongNovelOutline(pid);
    if (!outline.trim()) throw new Error('该项目还没有大纲');
    const sys = '你是专业的小说角色分析师。从大纲中提取所有主要角色与重要配角，为每个角色创建详尽完整的档案——不要简略概括。只输出合法 JSON 数组，无其它文字：[{"name":"角色全名","gender":"男/女/未知","isProtagonist":true 或 false,"role":"身份定位（主角/反派/导师/对手…）","personality":"详细性格、行为倾向、优缺点","motivation":"核心欲望、目标、驱动力与恐惧","background":"详细背景故事：出身/家庭/塑造其性格的过去","appearance":"外貌：体型/五官/着装风格/显著标志"}]。每个字段都要详尽，不能只写短语；只提取真实命名角色，不要地点/弧线/主题概念。';
    const arr = parseJsonArray(await aiApi.chat(`小说大纲：\n${outline.slice(0, 6000)}\n\n请输出完整的 JSON 角色数组，每个字段都要详尽。`, ctx.textConfig, sys));
    const existing = s().getCharacters(pid);
    const names = new Set(existing.map((c) => c.name));
    const added: Character[] = arr
      .filter((o) => o && typeof o.name === 'string' && o.name.trim() && !names.has(o.name))
      .map((o, i) => ({ id: uid(`char${i}`), name: o.name, gender: o.gender || '', role: o.role || '', personality: o.personality || '', background: o.background || '', motivation: o.motivation || '', appearance: o.appearance || '', isProtagonist: o.isProtagonist === true || String(o.isProtagonist).toLowerCase() === 'true' }));
    if (added.length) s().setCharacters(pid, [...existing, ...added]);
    return `导入了 ${added.length} 个新角色：${added.map((c) => c.name).join('、') || '（无）'}`;
  }},

  // ── Realms ──
  { name: 'list_realms', desc: '查看修炼境界体系。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const rs = s().getCultivationRealms(pid);
    if (!rs.length) return '（暂无境界体系）';
    return rs.map((r) => `${r.order + 1}. ${r.name}${r.subRealms?.length ? `（${r.subRealms.map((x) => x.name).join('/')}）` : ''}`).join('\n');
  }},
  { name: 'set_realms', desc: '设置/重建整套境界体系（覆盖）。args: projectId?, realms=JSON数组 [{"name":..,"description":..,"subRealms":[{"name":..,"description":..}]}]', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const arr = Array.isArray(a.realms) ? a.realms : parseJsonArray(typeof a.realms === 'string' ? a.realms : JSON.stringify(a.realms ?? []));
    const realms: CultivationRealm[] = arr.map((r: any, i: number) => ({
      id: uid(`realm${i}`), order: i, name: String(r.name || `境界${i + 1}`), description: r.description || undefined,
      subRealms: Array.isArray(r.subRealms) ? r.subRealms.map((sub: any, j: number) => ({ id: uid(`sub${i}-${j}`), order: j, name: String(sub.name || `层${j + 1}`), description: sub.description || undefined })) : undefined,
    }));
    s().setCultivationRealms(pid, realms);
    return `已设置 ${realms.length} 个境界`;
  }},

  // ── Volumes ──
  { name: 'create_volume', desc: '新建副本。args: projectId?, name, description?, realmPlan?(本副本修为/境界上限的硬约束，如"主角只突破到第一大境界巅峰，逐层稳步突破")', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const vols = s().getVolumes(pid);
    const v: Volume = { id: uid('vol'), name: String(a.name || `副本${vols.length + 1}`), description: a.description || '', order: vols.length, createdAt: new Date().toISOString(), realmPlan: a.realmPlan || '' };
    s().setVolumes(pid, [...vols, v]);
    return `已创建副本：${v.id} ${v.name}${v.realmPlan ? `（已设修为上限）` : ''}`;
  }},
  { name: 'generate_volumes', desc: 'AI 生成若干副本（不生成弧线）。args: projectId?, count, requirements?', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const count = Math.max(1, Math.min(12, Number(a.count) || 3));
    const existing = s().getVolumes(pid);
    const gen = await generateVolumes({ count, context: s().getLongNovelOutline(pid).slice(0, 3000), existingVolumes: existing.map((v) => `- ${v.name}：${v.description}`).join('\n'), requirements: a.requirements || '', textConfig: ctx.textConfig, uiLanguage: ctx.uiLanguage });
    const created: Volume[] = gen.map((g, i) => ({ id: uid(`vol${i}`), name: g.name, description: g.description, order: existing.length + i, createdAt: new Date().toISOString() }));
    s().setVolumes(pid, [...existing, ...created]);
    return `已生成 ${created.length} 个副本：${created.map((v) => `${v.id}:${v.name}`).join('、')}`;
  }},
  { name: 'list_volumes', desc: '列出副本及其弧线数。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const vols = s().getVolumes(pid); const arcs = s().getPlotArcs(pid);
    if (!vols.length) return '（暂无副本）';
    return vols.map((v) => `- ${v.id} | ${v.name} | ${arcs.filter((ar) => ar.volumeId === v.id).length} 条弧线`).join('\n');
  }},
  { name: 'update_volume', desc: '修改副本信息。args: projectId?, volumeId, name?, description?, realmPlan?(本副本修为/境界上限的硬约束；设定后规划与生成都会严格遵守)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const vols = s().getVolumes(pid);
    if (!vols.some((v) => v.id === a.volumeId)) throw new Error('副本不存在');
    s().setVolumes(pid, vols.map((v) => v.id === a.volumeId ? { ...v, name: a.name ?? v.name, description: a.description ?? v.description, realmPlan: a.realmPlan ?? v.realmPlan } : v));
    return `副本已更新${a.realmPlan != null ? '（已更新修为上限）' : ''}`;
  }},
  { name: 'generate_arcs_for_volume', desc: '在某副本内 AI 生成若干弧线。args: projectId?, volumeId, count, requirements?', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const vol = s().getVolumes(pid).find((v) => v.id === a.volumeId);
    if (!vol) throw new Error('副本不存在');
    const count = Math.max(1, Math.min(12, Number(a.count) || 3));
    const arcs = s().getPlotArcs(pid);
    const inVol = arcs.filter((ar) => ar.volumeId === vol.id);
    const volConstraint = buildVolumeRealmConstraint(vol.realmPlan, vol.name, ctx.uiLanguage, 'plan');
    const requirements = [a.requirements || '', volConstraint].filter((x) => x && x.trim()).join('\n\n');
    const gen = await generateArcsForVolume({ count, volumeName: vol.name, volumeDescription: vol.description, context: s().getLongNovelOutline(pid).slice(0, 3000), existingArcs: inVol.map((ar) => `- ${ar.title}`).join('\n'), requirements, textConfig: ctx.textConfig, uiLanguage: ctx.uiLanguage });
    let order = arcs.length;
    const names: string[] = [];
    for (const g of gen) { s().addPlotArc(pid, { title: g.title, summary: g.summary, order: order++, status: 'upcoming', chapterCount: g.chapter_count, volumeId: vol.id }); names.push(g.title); }
    return `已在《${vol.name}》生成 ${names.length} 条弧线：${names.join('、')}`;
  }},
  { name: 'update_arc', desc: '修改弧线信息。args: projectId?, arcId, title?, summary?, chapterCount?, status?(upcoming|active|ending|completed)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const arc = s().getPlotArcs(pid).find((x) => x.id === a.arcId);
    if (!arc) throw new Error('弧线不存在');
    s().updatePlotArc(pid, a.arcId, { title: a.title ?? arc.title, summary: a.summary ?? arc.summary, chapterCount: a.chapterCount != null ? Number(a.chapterCount) : arc.chapterCount, status: a.status ?? arc.status });
    return '弧线已更新';
  }},
  { name: 'plan_arc_chapters', desc: '为某弧线用 AI 规划若干章节（每章给出真实「章节标题」+「本章目标」），并创建为待写章节。args: projectId?, arcId, count', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const arc = s().getPlotArcs(pid).find((x) => x.id === a.arcId);
    if (!arc) throw new Error('弧线不存在');
    const count = Math.max(1, Math.min(30, Number(a.count) || 5));

    // AI-plan real chapter titles + goals (grounded in outline / arc / realms). Never bare "第N章".
    const outline = s().getLongNovelOutline(pid).slice(0, 2500);
    const realm = buildRealmSystemContext(s().getCultivationRealms(pid), s().getCharacters(pid), s().getCharacterRealmEvents(pid), [], { uiLanguage: ctx.uiLanguage, ladderOnly: true });
    const planVol = arc.volumeId ? s().getVolumes(pid).find((v) => v.id === arc.volumeId) : undefined;
    const realmConstraint = planVol ? buildVolumeRealmConstraint(planVol.realmPlan, planVol.name, ctx.uiLanguage, 'plan') : '';
    const sys = '你为长篇小说的某条剧情弧线规划具体章节。每章给出一个简洁有吸引力的"章节标题"（4-14字，体现本章看点，**不要带"第N章"前缀或序号**）与"本章目标"（1-2句，具体可执行）。规划修为/突破节奏时必须严格遵守下方"修为/境界硬约束"，不得安排越级、跳级、跌落或超过本副本上限的境界变化。只输出 JSON 数组、无其它文字：[{"title":"章节标题","goal":"本章目标"}]';
    const user = [
      `弧线：${arc.title}`,
      arc.summary ? `弧线概述：${arc.summary}` : '',
      arc.miniOutline ? `弧线细纲：\n${arc.miniOutline.slice(0, 800)}` : '',
      outline ? `【大纲】\n${outline}` : '',
      realm || '',
      realmConstraint || '',
      `请规划 ${count} 个章节。`,
    ].filter(Boolean).join('\n\n');
    const items = parseJsonArray(await aiApi.chat(user, ctx.textConfig, sys));

    // Strip any stray chapter-number prefix the model may still prepend.
    const stripNum = (t: string) => t.trim()
      .replace(/^第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章节回][\s:：、.\-—　]*/u, '')
      .replace(/^chapter\s+\d+[\s:：.\-—]*/i, '').trim();

    const chs = await chapterApi.getByProject(pid);
    let order = chs.length;
    const created: string[] = [];
    const names: string[] = [];
    const n = items.length > 0 ? Math.min(items.length, count) : count;
    for (let i = 0; i < n; i++) {
      const it = items[i] || {};
      const title = (typeof it.title === 'string' ? stripNum(it.title) : '') || `第${order + 1}章`;
      const goal = (typeof it.goal === 'string' && it.goal.trim()) ? it.goal.trim()
        : (typeof it.summary === 'string' && it.summary.trim()) ? it.summary.trim()
        : `${arc.title} - 第${i + 1}节`;
      const c = await chapterApi.create({ project_id: pid, title, order_index: order + 1, outline_goal: goal, conflict: '' });
      await chapterApi.updateMeta(c.id, { arc_id: arc.id });
      created.push(c.id); names.push(title); order++;
    }
    s().updatePlotArc(pid, arc.id, { builtChapterIds: [...(arc.builtChapterIds || []), ...created], chapterCount: (arc.chapterCount || 0) + created.length, status: arc.status === 'upcoming' ? 'active' : arc.status });
    await refreshProjects();
    await syncArcStatuses(pid);
    return `已为《${arc.title}》规划并创建 ${created.length} 章：${names.join('、')}`;
  }},

  // ── Chapters ──
  { name: 'list_chapters', desc: '列出章节（序号/id/标题/字数）。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const chs = await chapterApi.getByProject(pid);
    if (!chs.length) return '（暂无章节）';
    return chs.map((c) => `- 第${c.order_index}章 [${c.id}] ${c.title} (${c.word_count}字, ${c.status})`).join('\n');
  }},
  { name: 'get_chapter', desc: '查看某章正文节选。args: projectId?, chapterId', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const text = ch.final_text || ch.draft_text || '';
    return `第${ch.order_index}章《${ch.title}》目标：${ch.outline_goal || '无'}\n正文节选：${text.slice(0, 500) || '（空）'}`;
  }},
  { name: 'read_chapter', desc: '分页读取正文，nextOffset继续读；可按字面query搜索。args: projectId?, chapterId, offset?(UTF16位置), limit?(<=12000), query?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const text = ch.final_text || ch.draft_text || '';
    return JSON.stringify(a.query ? searchText([{ id: ch.id, title: ch.title, kind: 'chapter', text }], String(a.query), { offset: Number(a.offset ?? 0), limit: Number(a.limit ?? 10) })
      : { chapterId: ch.id, ...readTextRange(text, Number(a.offset ?? 0), Number(a.limit ?? 8000)) });
  }},
  { name: 'list_paragraphs', desc: '列出某章各段落（带序号，便于定位）。args: projectId?, chapterId', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const paras = (ch.final_text || ch.draft_text || '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    return paras.map((p, i) => `[${i + 1}] ${p.slice(0, 80)}`).join('\n') || '（空）';
  }},
  { name: 'generate_chapter', desc: '按本书工作台模式生成候选正文（快速/场景/精修），待用户在会话内审核采用后才写入正文。args: projectId?, chapterId, resume?(仅本会话同一任务中断时true)', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const checkpoint = a.resume === true ? latestWorkspaceCheckpoint(pid, String(a.chapterId)) : null;
    if (a.resume === true && (!checkpoint || !ctx.sessionId || !getWorkspaceCandidates(pid).some(candidate => candidate.runId === checkpoint.runId && candidate.sessionId === ctx.sessionId))) {
      throw new Error('没有本会话对应的中断任务；外来或其他会话草稿不能自动续写');
    }
    const stream = useAgentStream.getState();
    let accumulated = ''; let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      stream.set('');
      const record = await generateWorkspaceChapter(pid, String(a.chapterId), {
        signal: ctx.signal, initiator: 'agent', sessionId: ctx.sessionId,
        resumeRunId: checkpoint?.runId,
        onDelta: delta => { accumulated += delta; if (!timer) timer = setTimeout(() => { timer = null; stream.set(accumulated); }, 60); },
      });
      return JSON.stringify({ resultKind: 'pending_review', projectId: pid, chapterId: record.chapterId,
        runId: record.runId, candidateId: record.candidateId, message: '候选正文已完成，等待用户审核；尚未提交正文。' });
    } finally { if (timer) clearTimeout(timer); stream.set(''); }
  }},
  { name: 'revise_chapter', desc: '按要求润色/修改某章正文（整章重写）。args: projectId?, chapterId, instruction', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const cur = ch.final_text || ch.draft_text || '';
    if (!cur.trim()) throw new Error('该章暂无正文');
    return proposeAgentBody(pid, ch, ctx, String(a.instruction || '润色并保持原意'), true);
  }},
  { name: 'replace_in_chapter', desc: '局部修改：把某章正文中的一段原文精确替换为新文本。args: projectId?, chapterId, find, replace(留空=删除)', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const cur = ch.final_text || ch.draft_text || '';
    if (!a.find || !cur.includes(a.find)) throw new Error('未在正文中找到要替换的片段（需逐字一致）');
    const next = cur.replace(a.find, a.replace ?? '');
    return proposeAgentBody(pid, ch, ctx, next);
  }},
  { name: 'edit_paragraph', desc: '局部修改：用新文本替换某章第 N 段（按非空行计数）。args: projectId?, chapterId, paragraphIndex(从1), newText', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const cur = ch.final_text || ch.draft_text || '';
    const paras = cur.split(/\n\s*\n+/);
    const idx = Number(a.paragraphIndex) - 1;
    if (idx < 0 || idx >= paras.length) throw new Error('段落序号超出范围');
    paras[idx] = String(a.newText ?? '');
    const next = paras.join('\n\n');
    return proposeAgentBody(pid, ch, ctx, next);
  }},
  { name: 'update_chapter', desc: '修改章节标题/目标/冲突。args: projectId?, chapterId, title?, goal?, conflict?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    await chapterApi.updateMeta(ch.id, { title: a.title, outline_goal: a.goal, conflict: a.conflict });
    s().bumpChaptersVersion();
    return '章节信息已更新';
  }},
  { name: 'assign_chapter_to_arc', desc: '把章节归属到某弧线。args: projectId?, chapterId, arcId', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const arc = s().getPlotArcs(pid).find((x) => x.id === a.arcId);
    if (!arc) throw new Error('弧线不存在');
    await chapterApi.updateMeta(a.chapterId, { arc_id: a.arcId });
    if (!(arc.builtChapterIds || []).includes(a.chapterId)) s().updatePlotArc(pid, arc.id, { builtChapterIds: [...(arc.builtChapterIds || []), a.chapterId] });
    s().bumpChaptersVersion();
    return '已归属章节到弧线';
  }},
  { name: 'insert_chapter', desc: '在某章前/后插入新空白章。args: projectId?, referenceChapterId, before(true=前/false=后)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const chs = [...(await chapterApi.getByProject(pid))].sort((x, y) => x.order_index - y.order_index);
    const refIdx = chs.findIndex((c) => c.id === a.referenceChapterId);
    if (refIdx < 0) throw new Error('参考章节不存在');
    const insertAt = a.before ? refIdx : refIdx + 1;
    const created = await chapterApi.create({ project_id: pid, title: '新章节', order_index: insertAt + 1, outline_goal: '', conflict: '' });
    const ordered = [...chs]; ordered.splice(insertAt, 0, created);
    for (let i = 0; i < ordered.length; i++) await chapterApi.updateMeta(ordered[i].id, { order_index: i + 1 });
    await refreshProjects();
    return `已插入新章节 [${created.id}]`;
  }},
  { name: 'delete_chapter', desc: '删除某章节。args: projectId?, chapterId', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    await chapterApi.delete(a.chapterId);
    s().cleanupRealmEventsForChapter(pid, a.chapterId);
    // Drop the id from any arc's builtChapterIds so arc membership stays accurate.
    s().getPlotArcs(pid).forEach((arc) => {
      if ((arc.builtChapterIds || []).includes(a.chapterId)) {
        s().updatePlotArc(pid, arc.id, { builtChapterIds: (arc.builtChapterIds || []).filter((x) => x !== a.chapterId) });
      }
    });
    await refreshProjects();
    await syncArcStatuses(pid);
    return '章节已删除';
  }},
  { name: 'move_chapter', desc: '调整章节顺序，移动到第几位。args: projectId?, chapterId, position(从1开始)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const pos = Math.max(1, Math.floor(Number(a.position) || 0));
    if (pos < 1) throw new Error('position 需≥1');
    const chs = [...(await chapterApi.getByProject(pid))].sort((x, y) => x.order_index - y.order_index);
    const from = chs.findIndex((c) => c.id === a.chapterId);
    if (from < 0) throw new Error('章节不存在');
    const target = Math.min(pos, chs.length) - 1;
    const ids = chs.map((c) => c.id);
    ids.splice(from, 1);
    ids.splice(target, 0, a.chapterId);
    await applyChapterOrder(ids, chs);
    await refreshProjects();
    return `已把章节移到第 ${target + 1} 位`;
  }},
  { name: 'renumber_chapters', desc: '把章节序号重排为连续的 1..N（修复删除后留下的跳号，不影响归属索引）。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const chs = [...(await chapterApi.getByProject(pid))].sort((x, y) => x.order_index - y.order_index);
    let changed = 0;
    for (let i = 0; i < chs.length; i++) {
      if (chs[i].order_index !== i + 1) { await chapterApi.updateMeta(chs[i].id, { order_index: i + 1 }); changed++; }
    }
    await refreshProjects();
    return changed ? `已将 ${chs.length} 章重排为连续编号` : '章节序号本已连续，无需重排';
  }},

  // ── Characters ──
  { name: 'list_characters', desc: '列出角色（id/姓名/身份/主角）。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const cs = s().getCharacters(pid);
    if (!cs.length) return '（暂无角色）';
    return cs.map((c) => `- ${c.id} | ${c.name}${c.role ? ` | ${c.role}` : ''}${c.isProtagonist ? ' | 主角' : ''}`).join('\n');
  }},
  { name: 'get_character', desc: '查看角色详情。args: projectId?, character(姓名或id)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const c = findChar(pid, a.character);
    if (!c) throw new Error('角色不存在');
    return `【${c.name}】身份：${c.role || '-'}｜性别：${c.gender || '-'}｜性格：${c.personality || '-'}｜动机：${c.motivation || '-'}｜背景：${c.background || '-'}`;
  }},
  { name: 'generate_character', desc: '用一句话描述生成一个契合设定的角色。args: projectId?, brief', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const sys = '根据简述为小说生成一个角色，只输出 JSON：{"name":"","gender":"","role":"","personality":"","motivation":"","background":"","appearance":""}';
    const o = parseJsonObject(await aiApi.chat(`简述：${a.brief}`, ctx.textConfig, sys));
    if (!o.name) throw new Error('生成失败');
    const c: Character = { id: uid('char'), name: o.name, gender: o.gender || '', role: o.role || '', personality: o.personality || '', background: o.background || '', motivation: o.motivation || '', appearance: o.appearance || '', isProtagonist: false };
    s().setCharacters(pid, [...s().getCharacters(pid), c]);
    return `已创建角色：${c.name}`;
  }},
  { name: 'update_character', desc: '修改角色信息。args: projectId?, characterId, name?, gender?, role?, personality?, background?, motivation?, appearance?, isProtagonist?, realm?(境界名), subRealm?(子境界名)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const cs = s().getCharacters(pid);
    const c = cs.find((x) => x.id === a.characterId) || findChar(pid, a.characterId);
    if (!c) throw new Error('角色不存在');
    let currentRealmId = c.currentRealmId, currentSubRealmId = c.currentSubRealmId;
    if (a.realm) {
      const realm = s().getCultivationRealms(pid).find((r) => r.name === a.realm);
      if (realm) { currentRealmId = realm.id; currentSubRealmId = a.subRealm ? realm.subRealms?.find((sr) => sr.name === a.subRealm)?.id : undefined; }
    }
    s().setCharacters(pid, cs.map((x) => x.id === c.id ? { ...x,
      name: a.name ?? x.name, gender: a.gender ?? x.gender, role: a.role ?? x.role,
      personality: a.personality ?? x.personality, background: a.background ?? x.background,
      motivation: a.motivation ?? x.motivation, appearance: a.appearance ?? x.appearance,
      isProtagonist: typeof a.isProtagonist === 'boolean' ? a.isProtagonist : x.isProtagonist,
      currentRealmId, currentSubRealmId } : x));
    return '角色已更新';
  }},
  { name: 'extract_characters_from_chapter', desc: '从某章正文识别并同步新出场角色。args: projectId?, chapterId', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const text = ch.final_text || ch.draft_text || '';
    if (!text.trim()) throw new Error('该章暂无正文');
    const existing = s().getCharacters(pid);
    const known = existing.map((c) => c.name).join('、');
    const sys = '从章节正文中找出"新出场且有名有戏份"的角色（排除已知角色），只输出 JSON 数组：[{"name":"","role":"","personality":"","motivation":""}]，没有就输出 []';
    const arr = parseJsonArray(await aiApi.chat(`已知角色：${known}\n\n正文：\n${text.slice(0, 4000)}`, ctx.textConfig, sys));
    const names = new Set(existing.map((c) => c.name));
    const added: Character[] = arr.filter((o) => o?.name && !names.has(o.name)).map((o, i) => ({ id: uid(`char${i}`), name: o.name, gender: '', role: o.role || '', personality: o.personality || '', background: '', motivation: o.motivation || '', appearance: '', isProtagonist: false }));
    if (added.length) s().setCharacters(pid, [...existing, ...added]);
    return `同步了 ${added.length} 个新角色：${added.map((c) => c.name).join('、') || '（无）'}`;
  }},
  { name: 'add_character_growth', desc: '为某角色追加一条成长记录（绑定章节，软引导后续生成）。args: projectId?, character(姓名或id), value, chapterId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const c = findChar(pid, a.character);
    if (!c) throw new Error('角色不存在');
    let order: number | undefined, title: string | undefined;
    if (a.chapterId) { const ch = (await chapterApi.getByProject(pid)).find((x) => x.id === a.chapterId); order = ch?.order_index; title = ch?.title; }
    s().appendCharacterGrowth(pid, c.id, { id: uid('growth'), value: String(a.value || ''), chapterId: a.chapterId, chapterOrder: order, chapterTitle: title, createdAt: new Date().toISOString(), manual: false });
    return `已记录 ${c.name} 的成长`;
  }},
  { name: 'get_character_growth', desc: '查看某角色的成长路线。args: projectId?, character(姓名或id)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const c = findChar(pid, a.character);
    if (!c) throw new Error('角色不存在');
    const es = s().getCharacterGrowth(pid, c.id);
    if (!es.length) return '（暂无成长记录）';
    return es.map((e, i) => `${i + 1}. ${e.chapterOrder ? `第${e.chapterOrder}章 ` : ''}${e.value}`).join('\n');
  }},

  // ── Containers ──
  { name: 'create_container', desc: '新建资料容器。args: projectId?, name, type(必填，按用户要求选：by_character 依角色分块 / by_chapter 依章节分块 / single 不分块；省略则默认 single), autoUpdate?, affectsGeneration?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const type = (['by_character', 'by_chapter', 'single'].includes(a.type) ? a.type : 'single') as ContainerType;
    const id = uid('cont');
    s().createContainer(pid, { id, name: String(a.name || '容器'), type, autoUpdatePerChapter: !!a.autoUpdate, affectsGeneration: !!a.affectsGeneration, affectsVolumeGeneration: false, affectsArcGeneration: false, createdAt: new Date().toISOString() });
    return `已创建容器：${id} ${a.name}（${type}）`;
  }},
  { name: 'append_container_entry', desc: '向容器某分块写入一条值。args: projectId?, containerId, blockKey(角色id/章节id/main), value', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const blockKey = a.blockKey || CONTAINER_SINGLE_BLOCK_KEY;
    s().appendContainerEntry(pid, a.containerId, blockKey, { id: uid('entry'), value: String(a.value || ''), createdAt: new Date().toISOString(), manual: true });
    return '已写入容器条目';
  }},

  // ── Retrieval ──
  { name: 'retrieve', desc: '就当前项目内容提问/检索。args: projectId?, question', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const cfg = ctx.embeddingConfig;
    if (!s().knowledgeBaseEnabled || !cfg.apiKey.trim() || !cfg.apiUrl.trim() || !cfg.model.trim()) return '本地知识库未配置（请在设置中开启并配置 Embedding）。';
    const ctxText = await knowledgeApi.retrieveContext({ projectId: pid, query: String(a.question || ''), topK: 6, excludeChapterIds: [], embeddingConfig: cfg, includeSummaries: true, includeForeshadowing: true });
    return ctxText || '（未检索到相关内容）';
  }},

  // ── Snapshots ──
  { name: 'create_snapshot', desc: '保存当前项目为版本快照。args: projectId?, label?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const content = await buildSnapshotContent(pid);
    await snapshotApi.create(pid, a.label || null, content);
    return '已保存版本快照';
  }},
  { name: 'list_snapshots', desc: '列出项目的版本快照。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const list = await snapshotApi.list(pid);
    if (!list.length) return '（暂无快照）';
    return list.map((m) => `- ${m.id} | ${m.note || '未命名'} | ${m.created_at}`).join('\n');
  }},
  { name: 'restore_snapshot', desc: '回退到某版本快照（覆盖当前内容；回退前建议先 create_snapshot 备份）。args: projectId?, snapshotId', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    if (!a.snapshotId) throw new Error('缺少 snapshotId');
    const content = await snapshotApi.get(a.snapshotId);
    await restoreSnapshot(pid, content);
    await refreshProjects();
    await syncArcStatuses(pid);
    return '已回退到该版本快照';
  }},
  { name: 'rename_snapshot', desc: '重命名版本快照。args: projectId?, snapshotId, label', run: async (a) => {
    if (!a.snapshotId) throw new Error('缺少 snapshotId');
    await snapshotApi.rename(a.snapshotId, String(a.label || ''));
    return '已重命名快照';
  }},
  { name: 'delete_snapshot', desc: '删除版本快照。args: projectId?, snapshotId', sensitive: true, run: async (a) => {
    if (!a.snapshotId) throw new Error('缺少 snapshotId');
    await snapshotApi.delete(a.snapshotId);
    return '已删除快照';
  }},

  // ── Structure reorder / refine / delete ──
  { name: 'reorder_volume', desc: '调整副本顺序，移动到第几位。args: projectId?, volumeId, position(从1开始)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const pos = Math.max(1, Math.floor(Number(a.position) || 0));
    const vols = [...s().getVolumes(pid)].sort((x, y) => x.order - y.order);
    const from = vols.findIndex((v) => v.id === a.volumeId);
    if (from < 0) throw new Error('副本不存在');
    const target = Math.min(pos, vols.length) - 1;
    const [moved] = vols.splice(from, 1);
    vols.splice(target, 0, moved);
    s().setVolumes(pid, vols.map((v, i) => ({ ...v, order: i })));
    return `已把副本移到第 ${target + 1} 位`;
  }},
  { name: 'reorder_arc', desc: '调整某弧线在其所属副本内的顺序，移动到第几位。args: projectId?, arcId, position(从1开始)', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const pos = Math.max(1, Math.floor(Number(a.position) || 0));
    if (!s().getPlotArcs(pid).some((x) => x.id === a.arcId)) throw new Error('弧线不存在');
    moveArcToPosition(pid, a.arcId, pos);
    return `已把弧线移到（所属副本内）第 ${pos} 位`;
  }},
  { name: 'refine_chapter_plan', desc: '生成正文前先用 AI 细化本章规划（本章目标 / 核心冲突）——批量建的空白章规划较粗糙，写前先细化。args: projectId?, chapterId', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const chs = await chapterApi.getByProject(pid);
    const ch = chs.find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const arcCtx = buildChapterArcContext(pid, ch);
    const prev = chs.filter((c) => c.order_index < ch.order_index && (c.final_text || c.draft_text)).sort((x, y) => y.order_index - x.order_index)[0];
    // Ground the plan in the full project context (or it misleads chapter generation):
    // 大纲 + 副本/弧线 + 世界观/境界/容器手动知识库 + 角色 + 本地知识库索引检索 + 上一章结尾。
    const { world, charInfo } = chapterContext(pid, ctx, chs); // world = 世界观 + 境界 + 容器 affectsGeneration 指引
    const outline = s().getLongNovelOutline(pid).slice(0, 1800);
    let kb = '';
    const cfg = ctx.embeddingConfig;
    if (s().knowledgeBaseEnabled && cfg.apiKey.trim() && cfg.apiUrl.trim() && cfg.model.trim()) {
      try {
        kb = await knowledgeApi.retrieveContext({
          projectId: pid,
          query: `${ch.title} ${ch.outline_goal || ''}`.trim() || `第${ch.order_index}章 剧情规划`,
          topK: 6, excludeChapterIds: [ch.id], embeddingConfig: cfg, includeSummaries: true, includeForeshadowing: true,
        });
      } catch { /* KB optional */ }
    }
    // If the title is still a placeholder number (e.g. "第N章"), ask for a real title too.
    const titleIsPlaceholder = /^第\s*[0-9〇零一二三四五六七八九十百千两]+\s*章\s*$/u.test((ch.title || '').trim()) || !(ch.title || '').trim();
    const sys = `你为长篇小说的某一章细化写作规划。务必结合给定的大纲、副本/弧线、世界观/境界/容器知识库、相关记忆检索与上一章结尾，使本章规划与全书设定一致、不偏离走向。只输出 JSON：{${titleIsPlaceholder ? '"title":"简洁有吸引力的章节标题(4-14字，不带\\"第N章\\"前缀),"' : ''}"goal":"本章目标(1-2句，具体可执行)","conflict":"核心冲突(1句)"}，不要其它文字。`;
    const user = [
      `第${ch.order_index}章${titleIsPlaceholder ? '（暂无标题，请起一个）' : `《${ch.title}》`}`,
      ch.outline_goal ? `现有目标：${ch.outline_goal}` : '',
      outline ? `【大纲】\n${outline}` : '',
      arcCtx,
      world ? `【世界观/设定/境界/容器知识库】\n${world}` : '',
      charInfo ? `【主要角色】\n${charInfo}` : '',
      kb ? `【相关记忆 / 知识库检索】\n${kb}` : '',
      prev ? `上一章结尾：${(prev.final_text || prev.draft_text || '').slice(-400)}` : '',
    ].filter(Boolean).join('\n\n');
    const o = parseJsonObject(await aiApi.chat(user, ctx.textConfig, sys));
    const patch: Record<string, any> = { outline_goal: o.goal ?? ch.outline_goal, conflict: o.conflict ?? ch.conflict };
    let newTitle = ch.title;
    if (titleIsPlaceholder && typeof o.title === 'string') {
      const t = o.title.trim()
        .replace(/^第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章节回][\s:：、.\-—　]*/u, '')
        .replace(/^chapter\s+\d+[\s:：.\-—]*/i, '').trim();
      if (t) { patch.title = t; newTitle = t; }
    }
    await chapterApi.updateMeta(ch.id, patch);
    s().bumpChaptersVersion();
    return `已细化规划——标题：${newTitle || '(未变)'}｜目标：${o.goal || ch.outline_goal || '(未变)'}｜冲突：${o.conflict || ch.conflict || '(未变)'}`;
  }},
  { name: 'delete_arc', desc: '删除某剧情弧线（不删章节）。args: projectId?, arcId', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    if (!s().getPlotArcs(pid).some((x) => x.id === a.arcId)) throw new Error('弧线不存在');
    s().deletePlotArc(pid, a.arcId);
    return '已删除弧线';
  }},
  { name: 'delete_volume', desc: '删除某副本及其下所有弧线（不删章节）。args: projectId?, volumeId', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const vols = s().getVolumes(pid);
    if (!vols.some((v) => v.id === a.volumeId)) throw new Error('副本不存在');
    s().getPlotArcs(pid).filter((arc) => arc.volumeId === a.volumeId).forEach((arc) => s().deletePlotArc(pid, arc.id));
    s().setVolumes(pid, vols.filter((v) => v.id !== a.volumeId).map((v, i) => ({ ...v, order: i })));
    return '已删除副本及其弧线';
  }},
  { name: 'delete_character', desc: '删除角色。args: projectId?, character(姓名或id)', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const c = findChar(pid, a.character);
    if (!c) throw new Error('角色不存在');
    s().setCharacters(pid, s().getCharacters(pid).filter((x) => x.id !== c.id));
    return `已删除角色 ${c.name}`;
  }},

  // ── Project / outline / body direct read-write ──
  { name: 'update_project', desc: '修改项目信息。args: projectId?, title?, genre?, description?, targetWordCount?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const p = await projectApi.getById(pid);
    if (!p) throw new Error('项目不存在');
    const input: CreateProjectInput = {
      title: a.title ?? p.title, author: p.author, genre: a.genre ?? p.genre,
      description: a.description ?? p.description, language: p.language,
      target_word_count: a.targetWordCount != null ? Number(a.targetWordCount) : p.target_word_count,
      cover_images: p.cover_images, default_cover_id: p.default_cover_id,
    };
    await projectApi.update(pid, input);
    await refreshProjects();
    return '已更新项目信息';
  }},
  { name: 'delete_project', desc: '删除整个项目（不可恢复）。args: projectId', sensitive: true, run: async (a, ctx) => {
    const pid = (typeof a.projectId === 'string' && a.projectId.trim()) ? a.projectId.trim() : ctx.getFocusId();
    if (!pid) throw new Error('缺少 projectId');
    const p = await projectApi.getById(pid);
    if (!p) throw new Error('项目不存在');
    await projectApi.delete(pid);
    if (ctx.getFocusId() === pid) ctx.setFocusId(null);
    await refreshProjects();
    return `已删除项目《${p.title}》`;
  }},
  { name: 'get_outline', desc: '分页读取大纲，nextOffset继续读。args: projectId?, offset?, limit?(<=12000), query?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const o = s().getLongNovelOutline(pid);
    return JSON.stringify(a.query ? searchText([{ id: pid, title: '大纲', kind: 'outline', text: o }], String(a.query), { offset: Number(a.offset ?? 0), limit: Number(a.limit ?? 10) })
      : { projectId: pid, ...readTextRange(o, Number(a.offset ?? 0), Number(a.limit ?? 8000)) });
  }},
  { name: 'set_outline', desc: '直接写入/覆盖大纲文本。args: projectId?, text', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    s().setLongNovelOutline(pid, String(a.text ?? ''));
    return '已更新大纲';
  }},
  { name: 'set_chapter_body', desc: '直接写入/覆盖某章正文（精确设定或清理脏数据，不走 AI）。args: projectId?, chapterId, text', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const text = String(a.text ?? '');
    return proposeAgentBody(pid, ch, ctx, text);
  }},

  // ── Realms (append / delete) ──
  { name: 'add_realm', desc: '追加一个境界到体系末尾。args: projectId?, name, description?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    if (!a.name) throw new Error('缺少 name');
    const existing = s().getCultivationRealms(pid);
    const order = (existing.reduce((m, r) => Math.max(m, r.order), -1)) + 1;
    s().setCultivationRealms(pid, [...existing, { id: uid('realm'), order, name: String(a.name), description: a.description || undefined }]);
    return `已追加境界《${a.name}》`;
  }},
  { name: 'delete_realm', desc: '删除某境界。args: projectId?, realm(境界名或id)', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const key = a.realm ?? a.realmId ?? a.name;
    const before = s().getCultivationRealms(pid);
    const after = before.filter((r) => r.id !== key && r.name !== key);
    if (after.length === before.length) throw new Error('未找到境界');
    s().setCultivationRealms(pid, after.map((r, i) => ({ ...r, order: i })));
    return '已删除境界';
  }},

  // ── Containers (list / update / delete) ──
  { name: 'list_containers', desc: '列出资料容器（id/名称/类型/开关）。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const cs = s().getContainers(pid);
    if (!cs.length) return '（暂无容器）';
    return cs.map((c) => `- ${c.id} | ${c.name} | ${c.type}` +
      (c.autoUpdatePerChapter ? ' 按章更新' : '') + (c.affectsGeneration ? ' 影响章节' : '') +
      (c.affectsVolumeGeneration ? ' 影响副本' : '') + (c.affectsArcGeneration ? ' 影响弧线' : '')).join('\n');
  }},
  { name: 'update_container', desc: '修改容器名称/开关（类型不可改）。args: projectId?, containerId, name?, autoUpdate?, affectsGeneration?, affectsVolumeGeneration?, affectsArcGeneration?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const c = s().getContainers(pid).find((x) => x.id === a.containerId);
    if (!c) throw new Error('容器不存在');
    s().updateContainerMeta(pid, c.id, {
      name: a.name ?? c.name,
      autoUpdatePerChapter: typeof a.autoUpdate === 'boolean' ? a.autoUpdate : c.autoUpdatePerChapter,
      affectsGeneration: typeof a.affectsGeneration === 'boolean' ? a.affectsGeneration : c.affectsGeneration,
      affectsVolumeGeneration: typeof a.affectsVolumeGeneration === 'boolean' ? a.affectsVolumeGeneration : c.affectsVolumeGeneration,
      affectsArcGeneration: typeof a.affectsArcGeneration === 'boolean' ? a.affectsArcGeneration : c.affectsArcGeneration,
    });
    return `已更新容器 ${c.name}`;
  }},
  { name: 'delete_container', desc: '删除容器及其全部值。args: projectId?, containerId', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    if (!s().getContainers(pid).some((x) => x.id === a.containerId)) throw new Error('容器不存在');
    s().deleteContainer(pid, a.containerId);
    return '已删除容器';
  }},

  // ── Review / settings ──
  { name: 'review_consistency', desc: '审阅章节之间的前后矛盾 / 逻辑谬误 / 设定不一致。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const chs = [...(await chapterApi.getByProject(pid))].sort((x, y) => x.order_index - y.order_index);
    if (!chs.length) return '（暂无章节，无法审阅）';
    const { world, charInfo } = chapterContext(pid, ctx, chs);
    const lines = chs.map((c) => `第${c.order_index}章《${c.title}》：${((c.final_text || c.draft_text || '').slice(0, 180)) || '(空)'}`).join('\n');
    const sys = '你是严谨的小说审校。找出章节之间的前后矛盾、逻辑谬误、人物/设定/境界不一致之处，逐条列出并注明涉及章节与具体问题，按严重程度排序；若无明显问题也请说明。';
    const user = [charInfo && `【角色】\n${charInfo}`, world && `【设定】\n${world.slice(0, 1500)}`, `【各章节选】\n${lines}`].filter(Boolean).join('\n\n');
    return (await aiApi.chat(user, ctx.textConfig, sys)) || '（审阅失败）';
  }},
  { name: 'get_settings', desc: '查看当前生成设置（文本模型/图片引擎/知识库开关，不含任何密钥）。args: 无', run: async () => {
    const st = s();
    return `文本模型：${st.textModelConfig.model || '(未设)'}；图片引擎：${st.imageEngine}；知识库=${st.knowledgeBaseEnabled} 摘要=${st.summariesEnabled} 实体=${st.entitiesEnabled}`;
  }},
  { name: 'list_text_models', desc: '列出可选文本模型 profile（id/名称/provider/模型，不含密钥）。args: 无', run: async () => {
    const st = s();
    if (!st.textModelProfiles.length) return '（无 profile）';
    return st.textModelProfiles.map((p) => `- ${p.id} | ${p.name} | ${p.provider}/${p.model}${p.id === st.activeTextModelProfileId ? ' (当前)' : ''}`).join('\n');
  }},
  { name: 'set_text_model', desc: '切换当前文本模型 profile。args: profileId', run: async (a) => {
    if (!s().textModelProfiles.some((p) => p.id === a.profileId)) throw new Error('未找到该 profile');
    s().setActiveTextModelProfileId(a.profileId);
    return '已切换文本模型 profile';
  }},
  { name: 'set_image_engine', desc: '切换图片生成引擎。args: engine(pollinations|comfyui)', run: async (a) => {
    if (a.engine !== 'pollinations' && a.engine !== 'comfyui') throw new Error('engine 仅支持 pollinations / comfyui');
    s().setImageEngine(a.engine);
    return `已切换图片引擎为 ${a.engine}`;
  }},
  { name: 'set_kb_features', desc: '开关本地知识库 / 摘要 / 实体功能。args: knowledgeBase?, summaries?, entities?', run: async (a) => {
    if (typeof a.knowledgeBase === 'boolean') s().setKnowledgeBaseEnabled(a.knowledgeBase);
    if (typeof a.summaries === 'boolean') s().setSummariesEnabled(a.summaries);
    if (typeof a.entities === 'boolean') s().setEntitiesEnabled(a.entities);
    const st = s();
    return `已更新：知识库=${st.knowledgeBaseEnabled} 摘要=${st.summariesEnabled} 实体=${st.entitiesEnabled}`;
  }},

  // ── Covers / images ──
  { name: 'list_covers', desc: '列出项目封面（id/名称/是否默认）。args: projectId?', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const p = await projectApi.getById(pid);
    const covers = parseCovers(p?.cover_images);
    if (!covers.length) return '（暂无封面）';
    return covers.map((c) => `- ${c.id} | ${c.name}${c.id === p?.default_cover_id ? ' (默认)' : ''}`).join('\n');
  }},
  { name: 'set_default_cover', desc: '设为默认封面。args: projectId?, coverId', run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const p = await projectApi.getById(pid);
    if (!p) throw new Error('项目不存在');
    if (!parseCovers(p.cover_images).some((c) => c.id === a.coverId)) throw new Error('未找到封面');
    await projectApi.update(pid, {
      title: p.title, author: p.author, genre: p.genre, description: p.description, language: p.language,
      target_word_count: p.target_word_count, cover_images: p.cover_images, default_cover_id: a.coverId,
    });
    await refreshProjects();
    return '已设为默认封面';
  }},
  { name: 'delete_cover', desc: '删除某封面。args: projectId?, coverId', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const p = await projectApi.getById(pid);
    if (!p) throw new Error('项目不存在');
    const covers = parseCovers(p.cover_images);
    if (!covers.some((c) => c.id === a.coverId)) throw new Error('未找到封面');
    const next = covers.filter((c) => c.id !== a.coverId);
    const nextDefault = p.default_cover_id === a.coverId ? (next[0]?.id ?? null) : p.default_cover_id;
    await projectApi.update(pid, {
      title: p.title, author: p.author, genre: p.genre, description: p.description, language: p.language,
      target_word_count: p.target_word_count, cover_images: JSON.stringify(next), default_cover_id: nextDefault,
    });
    await refreshProjects();
    return '已删除封面';
  }},
  { name: 'generate_image', desc: '直接生成一张图片用于测试/预览图片引擎——无需项目、不保存到任何项目，只在会话里展示。args: prompt, width?, height?', sensitive: true, run: async (a, ctx) => {
    const prompt = String(a.prompt || '').trim();
    if (!prompt) throw new Error('缺少 prompt');
    const w = Math.max(64, Math.min(2048, Math.floor(Number(a.width) || 1024)));
    const h = Math.max(64, Math.min(2048, Math.floor(Number(a.height) || 1024)));
    const dataUrl = await genImageDataUrl(prompt, w, h);
    ctx.pushImage?.(ctx.uiLanguage === 'en' ? 'Generated image (preview)' : '生成的图片（预览）', dataUrl);
    return '已生成图片（仅预览，未保存到任何项目）';
  }},
  { name: 'generate_cover', desc: '为项目生成封面（可传 prompt 自定义画面，否则按项目信息）。args: projectId?, prompt?', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const p = await projectApi.getById(pid);
    if (!p) throw new Error('项目不存在');
    const prompt = a.prompt || `${p.genre || ''} ${p.title} book cover art, ${p.description || ''}`.trim();
    const dataUrl = await genImageDataUrl(prompt, 1080, 1920);
    const item = { id: uid('cover'), name: 'AI 封面', imageBase64: dataUrl, prompt, createdAt: new Date().toISOString() };
    const covers = parseCovers(p.cover_images).map((c) => ({ id: c.id, name: c.name, imageBase64: c.imageBase64, prompt: c.prompt, createdAt: c.createdAt }));
    await projectApi.update(pid, {
      title: p.title, author: p.author, genre: p.genre, description: p.description, language: p.language,
      target_word_count: p.target_word_count, cover_images: JSON.stringify([...covers, item]), default_cover_id: item.id,
    });
    await refreshProjects();
    ctx.pushImage?.(ctx.uiLanguage === 'en' ? 'Project cover' : '项目封面', dataUrl);
    return '已生成封面并设为默认';
  }},
  { name: 'generate_portrait', desc: '为角色生成立绘（可传 prompt，否则用角色形象/已存提示词）。args: projectId?, character(姓名或id), prompt?', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const c = findChar(pid, a.character);
    if (!c) throw new Error('角色不存在');
    const prompt = a.prompt || c.portraitPrompt || c.appearance;
    if (!prompt) throw new Error('该角色暂无外貌描述，请提供 prompt 或先补充形象');
    const dataUrl = await genImageDataUrl(prompt, 768, 1024);
    s().setCharacters(pid, s().getCharacters(pid).map((x) => x.id === c.id ? { ...x, portraitBase64: dataUrl, portraitPrompt: prompt } : x));
    ctx.pushImage?.((ctx.uiLanguage === 'en' ? `${c.name} portrait` : `${c.name} 立绘`), dataUrl);
    return `已为 ${c.name} 生成立绘`;
  }},
  { name: 'generate_promo', desc: '为某章生成「章节推文」：章首宽幅头图（推文配图）+ 一段摘要文字，保存到该章的推文中，会显示在章节生成页并随 PDF 导出（标题下方）。⚠ 这不是段落插图——段落插图请用 generate_illustration。args: projectId?, chapterId, style?(画风，可选，如 水墨/赛博朋克)', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const content = ch.final_text || ch.draft_text || '';
    if (content.replace(/\s/g, '').length < 100) throw new Error('章节正文太少（约需 ≥100 字）才能生成推文');
    const promoData = await invoke<{ image_prompt: string; summary: string }>('generate_chapter_promo', {
      chapterTitle: ch.title || (ctx.uiLanguage === 'en' ? 'Untitled' : '未命名章节'),
      chapterContent: content,
      style: typeof a.style === 'string' && a.style.trim() ? a.style.trim() : null,
      outputLanguage: ctx.uiLanguage === 'en' ? 'en' : 'zh',
      textConfig: ctx.textConfig,
    });
    const dataUrl = await genImageDataUrl(promoData.image_prompt, 1200, 400);
    s().setPromo(ch.id, { imagePrompt: promoData.image_prompt, summary: promoData.summary, imageBase64: dataUrl });
    ctx.pushImage?.((ctx.uiLanguage === 'en' ? `Promo · ${ch.title}` : `推文配图 · 第${ch.order_index}章`), dataUrl);
    return `已为第${ch.order_index}章《${ch.title}》生成章节推文（头图 + 摘要）。摘要：${(promoData.summary || '').slice(0, 80)}…`;
  }},
  { name: 'generate_illustration', desc: '为某章生成「段落插图」：嵌入正文中间、锚定某一段的竖图。⚠ 这不是章节推文头图（推文请用 generate_promo）。args: projectId?, chapterId, prompt?(画面，留空则按正文节选), paragraphIndex?(锚定第几段,默认1)', sensitive: true, run: async (a, ctx) => {
    const pid = resolvePid(a, ctx);
    const ch = (await chapterApi.getByProject(pid)).find((c) => c.id === a.chapterId);
    if (!ch) throw new Error('章节不存在');
    const body = ch.final_text || ch.draft_text || '';
    const prompt = a.prompt || body.slice(0, 220);
    if (!prompt.trim()) throw new Error('无 prompt 且本章无正文，无法生成插图');
    const anchor = Math.max(1, Math.floor(Number(a.paragraphIndex) || 1));
    const dataUrl = await genImageDataUrl(prompt, 768, 1024);
    let arr: any[] = [];
    try { arr = ch.illustrations ? JSON.parse(ch.illustrations) : []; if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
    arr.push({ id: uid('ill'), anchorIndex: anchor, paragraphIndices: [anchor], prompt, imageBase64: dataUrl, createdAt: new Date().toISOString() });
    if (ctx.signal?.aborted) throw new DOMException('任务已停止，未写入插图', 'AbortError');
    await invoke('update_chapter_illustrations', { input: {
      projectId: pid, chapterId: ch.id, expectedDraft: ch.draft_text || '',
      expectedFinal: ch.final_text || '', expectedIllustrations: ch.illustrations || '',
      illustrations: JSON.stringify(arr),
    } });
    await refreshProjects();
    ctx.pushImage?.((ctx.uiLanguage === 'en' ? `Illustration · ¶${anchor}` : `第${anchor}段插图`), dataUrl);
    return `已生成并插入段落插图（锚定第 ${anchor} 段）`;
  }},
];

export function toolDocs(): string {
  return AGENT_TOOLS.map((t) => `- ${t.name}${t.sensitive ? ' (需确认)' : ''}: ${t.desc}`).join('\n');
}

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}
