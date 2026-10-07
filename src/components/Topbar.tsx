import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '@store/index';
import { tx } from '@utils/i18n';
import { cn } from '@utils/index';
import { Menu, Loader2, BookOpen, ScrollText, X } from 'lucide-react';

/** Extract the project id from any project-scoped route, or null for non-project pages. */
function activeProjectIdFromPath(pathname: string): string | null {
  const m =
    pathname.match(/^\/long-novel\/([^/]+)/) ||
    pathname.match(/^\/project\/([^/]+)/) ||
    pathname.match(/^\/workbench\/([^/]+)/) ||
    pathname.match(/^\/editor\/([^/]+)/);
  return m ? m[1] : null;
}

/** Live generation indicator, isolated so frequent progress updates don't re-render the tab strip. */
function GenerationStatus() {
  const isGenerating = useAppStore((s) => s.isGenerating);
  const generationProgress = useAppStore((s) => s.generationProgress);
  const uiLanguage = useAppStore((s) => s.uiLanguage);
  if (!isGenerating) return null;
  return (
    <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400 flex-shrink-0">
      <Loader2 className="w-4 h-4 animate-spin" />
      <span className="truncate max-w-[160px] md:max-w-[240px]">
        {generationProgress || tx(uiLanguage, '生成中...', 'Generating...')}
      </span>
    </div>
  );
}

export function Topbar() {
  const location = useLocation();
  const navigate = useNavigate();

  // Subscribe per-field (not the whole store) so the Topbar doesn't re-render on unrelated state
  // changes (chapters, streaming text, currentProject, …) — a big part of the page-switch jank.
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setMobileMenuOpen = useAppStore((s) => s.setMobileMenuOpen);
  const uiLanguage = useAppStore((s) => s.uiLanguage);
  const projects = useAppStore((s) => s.projects);
  const novelTypeByProject = useAppStore((s) => s.novelTypeByProject);
  const openProjectTabs = useAppStore((s) => s.openProjectTabs);
  const tabPathByProject = useAppStore((s) => s.tabPathByProject);
  const openProjectTab = useAppStore((s) => s.openProjectTab);
  const setProjectTabPath = useAppStore((s) => s.setProjectTabPath);
  const closeProjectTab = useAppStore((s) => s.closeProjectTab);
  const closeOtherProjectTabs = useAppStore((s) => s.closeOtherProjectTabs);
  const closeAllProjectTabs = useAppStore((s) => s.closeAllProjectTabs);
  const reorderProjectTabs = useAppStore((s) => s.reorderProjectTabs);

  const activeId = activeProjectIdFromPath(location.pathname);

  // Drag-to-reorder + right-click context menu state.
  const [dragId, setDragId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const projectPath = (id: string) => `/workbench/${id}`;
  const homePathFor = (id: string) =>
    (novelTypeByProject[id] || 'short') === 'long' ? '/long-novels' : '/short-novels';
  // Where a tab reopens: its last-visited sub-page (e.g. the chapter editor), else the landing page.
  const tabTarget = (id: string) => tabPathByProject[id] || projectPath(id);

  // Auto-open the tab for the active project AND remember its exact current route, so switching back
  // returns to where you left off (not the project landing page).
  useEffect(() => {
    if (!activeId) return;
    openProjectTab(activeId);
    setProjectTabPath(activeId, location.pathname);
  }, [activeId, location.pathname, openProjectTab, setProjectTabPath]);

  // Close the context menu on Escape.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // Tabs to render: keep order; once projects are loaded, drop tabs whose project no longer exists.
  const tabs = openProjectTabs
    .map((id) => ({ id, project: projects.find((p) => p.id === id) }))
    .filter((t) => t.project || projects.length === 0);

  // Close a tab; if it was the active one, move to a neighbour (else that type's home).
  const closeTab = (id: string) => {
    const idx = openProjectTabs.indexOf(id);
    closeProjectTab(id);
    if (id !== activeId) return;
    const remaining = openProjectTabs.filter((pid) => pid !== id);
    const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[remaining.length - 1];
    navigate(next ? tabTarget(next) : homePathFor(id));
  };

  const closeOthers = (keepId: string) => {
    closeOtherProjectTabs(keepId);
    setMenu(null);
    if (activeId && activeId !== keepId) navigate(tabTarget(keepId));
  };

  const closeAll = () => {
    closeAllProjectTabs();
    setMenu(null);
    if (activeId) navigate(homePathFor(activeId));
  };

  // Move the dragged tab to the dropped-on tab's slot, persisting the new order.
  const handleDrop = (targetId: string) => {
    const from = openProjectTabs.indexOf(dragId ?? '');
    const to = openProjectTabs.indexOf(targetId);
    setDragId(null);
    if (from < 0 || to < 0 || from === to) return;
    const arr = [...openProjectTabs];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    reorderProjectTabs(arr);
  };

  return (
    <header className="h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center gap-2 px-2">
      <div className="flex items-center flex-shrink-0">
        <button
          onClick={() => setMobileMenuOpen(true)}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 md:hidden"
          title={tx(uiLanguage, '打开菜单', 'Open menu')}
        >
          <Menu className="w-5 h-5" />
        </button>

        {!sidebarOpen && (
          <button
            onClick={toggleSidebar}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 hidden md:block"
            title={tx(uiLanguage, '展开侧边栏', 'Expand sidebar')}
          >
            <Menu className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Open-project tabs (browser-like multi-open): click to switch (restores the last sub-page),
          drag to reorder, middle-click to close, right-click for close-others / close-all. */}
      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto h-full">
        {tabs.map(({ id, project }) => {
          const isActive = id === activeId;
          const isLong = (novelTypeByProject[id] || 'short') === 'long';
          const Icon = isLong ? BookOpen : ScrollText;
          const title = project?.title || tx(uiLanguage, '未命名', 'Untitled');
          return (
            <div
              key={id}
              draggable
              onClick={() => navigate(tabTarget(id))}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id }); }}
              onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={(e) => { e.preventDefault(); handleDrop(id); }}
              onDragEnd={() => setDragId(null)}
              title={title}
              className={cn(
                'group flex items-center gap-1.5 h-8 pl-2.5 pr-1 rounded-md border cursor-pointer flex-shrink-0 max-w-[180px] transition-colors',
                dragId === id && 'opacity-40',
                isActive
                  ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800 text-primary-700 dark:text-primary-300'
                  : 'bg-gray-50 dark:bg-gray-700/40 border-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              )}
            >
              <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', isLong && 'text-purple-500')} />
              <span className="text-xs truncate">{title}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); closeTab(id); }}
                className="p-0.5 rounded opacity-50 hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-600 flex-shrink-0"
                title={tx(uiLanguage, '关闭标签', 'Close tab')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      <GenerationStatus />

      {/* Right-click context menu */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div
            className="fixed z-50 min-w-[150px] py-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg text-sm"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              onClick={() => { closeTab(menu.id); setMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {tx(uiLanguage, '关闭', 'Close')}
            </button>
            <button
              type="button"
              disabled={openProjectTabs.length <= 1}
              onClick={() => closeOthers(menu.id)}
              className="w-full text-left px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {tx(uiLanguage, '关闭其它', 'Close others')}
            </button>
            <button
              type="button"
              onClick={closeAll}
              className="w-full text-left px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {tx(uiLanguage, '关闭全部', 'Close all')}
            </button>
          </div>
        </>
      )}
    </header>
  );
}
