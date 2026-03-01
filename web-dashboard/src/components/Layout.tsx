import React, { useState, useEffect, useMemo, useRef } from 'react';
import Tooltip from './Tooltip';
import CompassRoseLogo from './CompassRoseLogo';
import FloatingSelect from './ui/FloatingSelect';
import TeamPulse from './TeamPulse';
import type { Agent, Project, WorkforceLiveSnapshot } from '../types';

interface LayoutProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: React.ReactNode;
  chatOpen: boolean;
  onChatToggle: () => void;
  chatPanel?: React.ReactNode;
  chatHasUnread?: boolean;
  ceoName?: string;
  pollIntervalMs?: number;
  microProjectMode?: boolean;
  globalSearchQuery?: string;
  onGlobalSearchQueryChange?: (value: string) => void;
  projects?: Project[];
  activeProjectId?: string;
  onActiveProjectChange?: (projectId: string) => void;
  onCreateProjectRequest?: () => void;
  telegramMirrorEnabled?: boolean;
  telegramConfigured?: boolean;
  onToggleTelegramMirror?: () => void;
  onRequestMicroToggle?: () => void;
  agents?: Agent[];
  workforceLive?: WorkforceLiveSnapshot;
}

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', shortcut: '1', iconPath: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { id: 'agents', label: 'Agents', shortcut: '2', iconPath: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
  { id: 'projects', label: 'Projects', shortcut: '3', iconPath: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
  { id: 'activity', label: 'Activity', shortcut: '4', iconPath: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'events', label: 'Event Log', shortcut: '5', iconPath: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
  { id: 'settings', label: 'Settings', shortcut: '6', iconPath: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
] as const;

const SIDEBAR_COLLAPSED_KEY = 'compaas_sidebar_collapsed';
const CHAT_SPLIT_WIDTH_KEY = 'compaas_chat_split_width';
const CHAT_MAXIMIZED_KEY = 'compaas_chat_maximized';
const PROJECT_CREATE_SENTINEL = '__create_new_project__';

const PAGE_LABELS: Record<string, string> = {
  overview: 'Overview',
  agents: 'Agents',
  projects: 'Projects',
  activity: 'Activity',
  events: 'Event Log',
  settings: 'Settings',
};

function getStoredBoolean(primaryKey: string, fallback = false): boolean {
  const primary = localStorage.getItem(primaryKey);
  if (primary !== null) return primary === 'true';
  return fallback;
}

function formatPollInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms poll`;
  if (ms % 1000 === 0) return `${ms / 1000}s poll`;
  return `${(ms / 1000).toFixed(1)}s poll`;
}

function CeoBadge({ ceoName }: { ceoName: string }) {
  return (
    <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
        style={{
          background: 'linear-gradient(135deg, var(--tf-accent), var(--tf-accent-blue))',
          color: 'var(--tf-bg)',
          boxShadow: '0 0 0 1px color-mix(in srgb, var(--tf-accent-blue) 38%, transparent)',
        }}
      >
        {ceoName.charAt(0).toUpperCase()}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>
          CEO Chat
        </div>
        <div className="text-[10px]" style={{ color: 'var(--tf-text-muted)' }}>{ceoName}</div>
      </div>
    </div>
  );
}

// ---- Header Controls (Search, Project Selector, CEO Chat) ----
const HEADER_H = '34px';

function HeaderControls({
  searchExpanded, setSearchExpanded, globalSearchQuery, onGlobalSearchQueryChange,
  activeProjectId, projectSelectOptions, handleProjectSelection, projects,
  chatOpen, chatHasUnread, onChatToggle, microProjectMode, isMobileViewport,
}: {
  searchExpanded: boolean;
  setSearchExpanded: (v: boolean) => void;
  globalSearchQuery: string;
  onGlobalSearchQueryChange?: (v: string) => void;
  activeProjectId: string;
  projectSelectOptions: { value: string; label: string; description?: string; keywords?: string[] }[];
  handleProjectSelection: (id: string) => void;
  projects: Project[];
  chatOpen: boolean;
  chatHasUnread: boolean;
  onChatToggle: () => void;
  microProjectMode: boolean;
  isMobileViewport: boolean;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const pillBase: React.CSSProperties = {
    height: HEADER_H,
    display: 'flex',
    alignItems: 'center',
    borderRadius: '999px',
    border: '1px solid var(--tf-border)',
    backgroundColor: 'var(--tf-surface)',
    transition: 'all 0.2s',
  };

  // Determine active project's delivery mode for the icon
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const isGithub = activeProject?.delivery_mode === 'github' || (activeProject?.github_repo && activeProject.github_repo.length > 0);

  return (
    <div className="header-controls flex items-center gap-2">
      {/* 1. Search — collapsed icon, expands on click */}
      <div
        style={{
          ...pillBase,
          width: searchExpanded ? (isMobileViewport ? '180px' : '220px') : HEADER_H,
          padding: searchExpanded ? '0 10px' : '0',
          justifyContent: searchExpanded ? 'flex-start' : 'center',
          gap: '6px',
          cursor: searchExpanded ? 'text' : 'pointer',
          overflow: 'hidden',
        }}
        onClick={() => {
          if (!searchExpanded) {
            setSearchExpanded(true);
            setTimeout(() => searchRef.current?.focus(), 60);
          }
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--tf-text-muted)', flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        {searchExpanded && (
          <input
            ref={searchRef}
            value={globalSearchQuery}
            onChange={(e) => onGlobalSearchQueryChange?.(e.target.value)}
            onBlur={() => { if (!globalSearchQuery) setSearchExpanded(false); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { onGlobalSearchQueryChange?.(''); setSearchExpanded(false); } }}
            placeholder="Search..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--tf-text)',
              fontSize: '12px',
              minWidth: 0,
            }}
            aria-label="Global search"
          />
        )}
      </div>

      {/* 2. Project selector — pill with location icon */}
      <div
        className="header-project-context"
        style={{
          ...pillBase,
          gap: '6px',
          padding: '0 10px',
          minWidth: isMobileViewport ? '140px' : '200px',
          maxWidth: isMobileViewport ? 'min(48vw, 240px)' : '300px',
        }}
      >
        {/* Location icon: folder for local, GitHub mark for github */}
        {isGithub ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--tf-text-muted)', flexShrink: 0 }}>
            <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--tf-text-muted)', flexShrink: 0 }}>
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        )}
        <FloatingSelect
          value={activeProjectId || ''}
          options={projectSelectOptions}
          onChange={handleProjectSelection}
          searchable
          size="sm"
          variant="pill"
          style={{ width: '100%', minWidth: 0 }}
          ariaLabel="Global project selector"
          placeholder={projects.length > 0 ? 'Select project...' : 'No projects yet'}
        />
      </div>

      {/* 3. CEO Chat — rightmost, pill button */}
      <Tooltip content={chatOpen ? 'Close CEO chat (C)' : 'Open CEO chat (C)'} position="bottom">
        <button
          onClick={onChatToggle}
          className="relative cursor-pointer transition-all duration-200"
          style={{
            ...pillBase,
            gap: '7px',
            padding: isMobileViewport ? '0 10px' : '0 14px',
            backgroundColor: chatOpen ? 'var(--tf-accent)' : 'var(--tf-surface)',
            color: chatOpen ? 'var(--tf-bg)' : 'var(--tf-text)',
            borderColor: chatOpen ? 'var(--tf-accent)' : 'var(--tf-border)',
            boxShadow: chatOpen
              ? '0 0 12px rgba(168,131,255,0.25)'
              : chatHasUnread
                ? '0 0 10px rgba(234,114,103,0.3)'
                : 'none',
          }}
          aria-label={chatOpen ? 'Close CEO chat' : 'Open CEO chat'}
          onMouseEnter={(e) => {
            if (!chatOpen) {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-accent)';
            }
          }}
          onMouseLeave={(e) => {
            if (!chatOpen) {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-border)';
            }
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={chatOpen ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={chatOpen ? 0 : 1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.4-4 8-9 8a9.9 9.9 0 01-4.3-.9L3 20l1.4-3.7C3.5 15 3 13.6 3 12c0-4.4 4-8 9-8s9 3.6 9 8z" />
          </svg>
          {!isMobileViewport && (
            <span style={{ fontSize: '12px', fontWeight: 600 }}>
              {chatOpen ? 'Close' : 'CEO Chat'}
            </span>
          )}
          {microProjectMode && !isMobileViewport && (
            <span
              style={{
                fontSize: '9px',
                fontWeight: 700,
                color: chatOpen ? 'var(--tf-bg)' : 'var(--tf-warning)',
                border: chatOpen ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(240,170,74,0.45)',
                backgroundColor: chatOpen ? 'rgba(255,255,255,0.15)' : 'rgba(240,170,74,0.1)',
                borderRadius: '999px',
                padding: '1px 5px',
                lineHeight: 1.2,
              }}
            >
              MICRO
            </span>
          )}
          {chatHasUnread && !chatOpen && (
            <span
              className="animate-pulse-dot"
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '9px',
                height: '9px',
                borderRadius: '50%',
                backgroundColor: 'var(--tf-error)',
                border: '1.5px solid var(--tf-bg)',
              }}
              aria-label="Unread messages"
            />
          )}
        </button>
      </Tooltip>
    </div>
  );
}

export default function Layout({
  activeTab,
  onTabChange,
  children,
  chatOpen,
  onChatToggle,
  chatPanel,
  chatHasUnread,
  ceoName = 'CEO',
  pollIntervalMs = 5000,
  microProjectMode = false,
  globalSearchQuery = '',
  onGlobalSearchQueryChange,
  projects = [],
  activeProjectId = '',
  onActiveProjectChange,
  onCreateProjectRequest,
  telegramMirrorEnabled = false,
  telegramConfigured = false,
  onToggleTelegramMirror,
  onRequestMicroToggle,
  agents = [],
  workforceLive,
}: LayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => getStoredBoolean(SIDEBAR_COLLAPSED_KEY));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [chatSplitWidth, setChatSplitWidth] = useState(() => {
    const raw = localStorage.getItem(CHAT_SPLIT_WIDTH_KEY);
    const parsed = Number(raw || 420);
    return Number.isFinite(parsed) ? Math.max(300, Math.min(760, parsed)) : 420;
  });
  const [chatMaximized, setChatMaximized] = useState(() => getStoredBoolean(CHAT_MAXIMIZED_KEY));
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);

  useEffect(() => {
    const onResize = () => {
      const width = window.innerWidth;
      setViewportWidth(width);
      if (width > 900) {
        setMobileSidebarOpen(false);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isMobileViewport = viewportWidth <= 900;
  const sidebarIsCollapsed = isMobileViewport ? false : sidebarCollapsed;
  const maxChatWidth = Math.min(760, Math.round(viewportWidth * 0.58));
  const defaultChatWidth = Math.max(300, Math.min(maxChatWidth, chatSplitWidth));
  const effectiveChatWidth = !isMobileViewport && chatMaximized ? maxChatWidth : defaultChatWidth;

  useEffect(() => {
    localStorage.setItem(CHAT_MAXIMIZED_KEY, String(chatMaximized));
  }, [chatMaximized]);

  useEffect(() => {
    if (!isMobileViewport) {
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = mobileSidebarOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileViewport, mobileSidebarOpen]);

  useEffect(() => {
    if (isMobileViewport || !draggingSplit) return;
    const onMove = (evt: MouseEvent) => {
      const next = Math.max(300, Math.min(maxChatWidth, window.innerWidth - evt.clientX));
      setChatSplitWidth(next);
    };
    const onUp = () => {
      setDraggingSplit(false);
      localStorage.setItem(CHAT_SPLIT_WIDTH_KEY, String(chatSplitWidth));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingSplit, isMobileViewport, maxChatWidth, chatSplitWidth]);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  const handleProjectSelection = (projectId: string) => {
    if (projectId === PROJECT_CREATE_SENTINEL) {
      onCreateProjectRequest?.();
      return;
    }
    onActiveProjectChange?.(projectId);
  };

  const projectSelectOptions = useMemo(() => {
    const base = [
      {
        value: PROJECT_CREATE_SENTINEL,
        label: '+ Create New Project...',
        description: 'Start a new project workspace',
      },
      ...projects.map((project) => ({
        value: project.id,
        label: project.name,
        description: project.status ? `Status: ${project.status}` : undefined,
        keywords: [project.id, project.name, project.status || ''],
      })),
    ];
    return base;
  }, [projects]);

  const splitHeaderButtonBase: React.CSSProperties = {
    padding: '4px 8px',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: 600,
    border: '1px solid var(--tf-border)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  return (
    <div
      className="compaas-shell flex h-screen overflow-hidden"
      style={{ backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)' }}
    >
      <aside
        className="flex flex-col flex-shrink-0 transition-all duration-200"
        style={{
          backgroundColor: 'var(--tf-bg)',
          borderRight: '1px solid var(--tf-border)',
          overflow: 'hidden',
          ...(isMobileViewport
            ? {
                width: '262px',
                position: 'fixed',
                top: 0,
                left: 0,
                bottom: 0,
                zIndex: 60,
                transform: mobileSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
                pointerEvents: mobileSidebarOpen ? 'auto' : 'none',
                visibility: mobileSidebarOpen ? 'visible' : 'hidden',
              }
            : {
                width: sidebarIsCollapsed ? '56px' : '208px',
                position: 'relative',
                transform: 'none',
                boxShadow: 'none',
              }),
        }}
      >
        <div
          className="flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--tf-surface-raised)',
            padding: sidebarIsCollapsed ? '14px 0' : '16px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarIsCollapsed ? 'center' : 'space-between',
          }}
        >
          <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
            <CompassRoseLogo size={30} />
            {!sidebarIsCollapsed && (
              <div style={{ minWidth: 0 }}>
                <h1 className="text-sm font-bold leading-tight tracking-tight" style={{ color: 'var(--tf-text)' }}>
                  COMPaaS
                </h1>
                <p className="text-xs leading-tight" style={{ color: 'var(--tf-text-muted)' }}>
                  Company as a Service
                </p>
              </div>
            )}
          </div>
          {isMobileViewport && (
            <button
              onClick={() => setMobileSidebarOpen(false)}
              aria-label="Close navigation menu"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--tf-text-muted)',
                cursor: 'pointer',
                padding: '2px',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)'; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {!sidebarIsCollapsed && !isMobileViewport && (
            <button
              onClick={toggleSidebar}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--tf-text-muted)',
                cursor: 'pointer',
                padding: '2px',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)'; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
              </svg>
            </button>
          )}
        </div>

        <nav
          className="flex-1 flex flex-col overflow-y-auto overflow-x-hidden"
          style={{ padding: sidebarIsCollapsed ? '10px 0' : '10px 8px' }}
          role="navigation"
          aria-label="Main navigation"
        >
          {sidebarIsCollapsed && (
            <Tooltip content="Expand sidebar" position="right">
              <button
                onClick={toggleSidebar}
                aria-label="Expand sidebar"
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '8px 0',
                  background: 'none',
                  border: 'none',
                  color: 'var(--tf-text-muted)',
                  cursor: 'pointer',
                  marginBottom: '4px',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)'; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M6 5l7 7-7 7" />
                </svg>
              </button>
            </Tooltip>
          )}

          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <Tooltip key={item.id} content={`${item.label} (${item.shortcut})`} position="right">
                <button
                  onClick={() => {
                    onTabChange(item.id);
                    if (isMobileViewport) setMobileSidebarOpen(false);
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  className="w-full flex items-center rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer"
                  style={{
                    gap: sidebarIsCollapsed ? 0 : '10px',
                    padding: sidebarIsCollapsed ? '8px 0' : '8px 10px',
                    justifyContent: sidebarIsCollapsed ? 'center' : 'flex-start',
                    marginBottom: '2px',
                    backgroundColor: isActive ? 'var(--tf-surface-raised)' : 'transparent',
                    color: isActive ? 'var(--tf-accent)' : 'var(--tf-text-secondary)',
                    borderLeft: isActive && !sidebarIsCollapsed ? '2px solid var(--tf-accent)' : '2px solid transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-bg)';
                      (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                      (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-secondary)';
                    }
                  }}
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.iconPath} />
                  </svg>
                  {!sidebarIsCollapsed && item.label}
                </button>
              </Tooltip>
            );
          })}
        </nav>

        <div
          className="flex-shrink-0"
          style={{
            borderTop: '1px solid var(--tf-surface-raised)',
            padding: sidebarIsCollapsed ? '12px 0' : '14px 12px',
          }}
        >
          {sidebarIsCollapsed ? (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <span
                className="w-2 h-2 rounded-full animate-pulse-dot"
                style={{ backgroundColor: 'var(--tf-success)' }}
                aria-hidden="true"
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot"
                  style={{ backgroundColor: 'var(--tf-success)' }}
                  aria-hidden="true"
                />
                <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                  Live
                </span>
                <span className="text-xs ml-auto" style={{ color: 'var(--tf-border)' }}>
                  {formatPollInterval(pollIntervalMs)}
                </span>
              </div>
            </>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header
          className="flex items-center justify-between px-4 md:px-6 py-3 flex-shrink-0"
          style={{ backgroundColor: 'var(--tf-surface)', borderBottom: '1px solid var(--tf-surface-raised)' }}
        >
          <div className="flex items-center gap-2">
            {isMobileViewport && (
              <button
                onClick={() => setMobileSidebarOpen(true)}
                aria-label="Open navigation menu"
                className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer"
                style={{
                  backgroundColor: 'transparent',
                  color: 'var(--tf-text-secondary)',
                  border: '1px solid var(--tf-border)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--tf-text)' }}>
                {PAGE_LABELS[activeTab] ?? 'Dashboard'}
              </h2>
              <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                COMPaaS — Company as a Service
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <TeamPulse agents={agents} workforceLive={workforceLive} isMobile={isMobileViewport} />
            <HeaderControls
            searchExpanded={searchExpanded}
            setSearchExpanded={setSearchExpanded}
            globalSearchQuery={globalSearchQuery ?? ''}
            onGlobalSearchQueryChange={onGlobalSearchQueryChange}
            activeProjectId={activeProjectId ?? ''}
            projectSelectOptions={projectSelectOptions}
            handleProjectSelection={handleProjectSelection}
            projects={projects}
            chatOpen={chatOpen}
            chatHasUnread={chatHasUnread ?? false}
            onChatToggle={onChatToggle}
            microProjectMode={microProjectMode ?? false}
            isMobileViewport={isMobileViewport}
          />
          </div>
        </header>

        {isMobileViewport ? (
          chatOpen ? (
            <div
              className="flex-1 flex flex-col overflow-hidden split-chat-panel split-chat-panel-open"
              style={{ backgroundColor: 'var(--tf-surface)' }}
            >
              <div
                className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
              >
                <CeoBadge ceoName={ceoName} />
                <div className="flex items-center gap-2">
                  <button
                    onClick={onRequestMicroToggle}
                    title="Micro Project mode: CEO-only fast path for very small tasks"
                    style={{
                      ...splitHeaderButtonBase,
                      borderColor: microProjectMode ? 'var(--tf-warning)' : 'var(--tf-border)',
                      backgroundColor: microProjectMode ? 'rgba(240,170,74,0.14)' : 'transparent',
                      color: microProjectMode ? 'var(--tf-warning)' : 'var(--tf-text-muted)',
                    }}
                  >
                    Micro {microProjectMode ? 'On' : 'Off'}
                  </button>
                  <button
                    onClick={onToggleTelegramMirror}
                    title={telegramConfigured ? 'Mirror this chat to Telegram messages' : 'Configure Telegram in Settings first'}
                    style={{
                      ...splitHeaderButtonBase,
                      borderColor: telegramMirrorEnabled ? 'var(--tf-accent-blue)' : 'var(--tf-border)',
                      backgroundColor: telegramMirrorEnabled ? 'color-mix(in srgb, var(--tf-accent-blue) 16%, transparent)' : 'transparent',
                      color: telegramMirrorEnabled ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)',
                      opacity: telegramConfigured ? 1 : 0.7,
                    }}
                  >
                    Telegram {telegramMirrorEnabled ? 'On' : 'Off'}
                  </button>
                  <button
                    onClick={onChatToggle}
                    className="w-6 h-6 rounded flex items-center justify-center cursor-pointer"
                    style={{ color: 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                    aria-label="Close CEO chat"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-hidden">{chatPanel}</div>
            </div>
          ) : (
            <main
              id="main-content"
              className="flex-1 overflow-y-auto p-4 md:p-6"
              style={{ backgroundColor: 'var(--tf-bg)' }}
            >
              {children}
            </main>
          )
        ) : (
          <div
            className="flex-1 overflow-hidden"
            style={{
              display: 'grid',
              gridTemplateColumns: chatOpen ? `minmax(0, 1fr) 6px ${effectiveChatWidth}px` : 'minmax(0, 1fr) 0px 0px',
              transition: 'grid-template-columns 280ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <main
              id="main-content"
              className="overflow-y-auto p-4 md:p-6"
              style={{ backgroundColor: 'var(--tf-bg)', minWidth: 0 }}
            >
              {children}
            </main>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize CEO chat panel"
              onMouseDown={() => chatOpen && !chatMaximized && setDraggingSplit(true)}
              style={{
                cursor: chatOpen && !chatMaximized ? 'col-resize' : 'default',
                backgroundColor: draggingSplit ? 'var(--tf-accent-blue)' : 'var(--tf-border)',
                opacity: chatOpen && !chatMaximized ? 0.45 : 0,
                transition: 'opacity 160ms ease, background-color 160ms ease',
                pointerEvents: chatOpen && !chatMaximized ? 'auto' : 'none',
              }}
            />

            <aside
              className={`split-chat-panel ${chatOpen ? 'split-chat-panel-open' : ''}`}
              style={{
                borderLeft: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-surface)',
                overflow: 'hidden',
                pointerEvents: chatOpen ? 'auto' : 'none',
              }}
            >
              <div
                className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
              >
                <CeoBadge ceoName={ceoName} />
                <div className="flex items-center gap-2">
                  <button
                    onClick={onRequestMicroToggle}
                    title="Micro Project mode: CEO-only fast path for very small tasks"
                    style={{
                      ...splitHeaderButtonBase,
                      borderColor: microProjectMode ? 'var(--tf-warning)' : 'var(--tf-border)',
                      backgroundColor: microProjectMode ? 'rgba(240,170,74,0.14)' : 'transparent',
                      color: microProjectMode ? 'var(--tf-warning)' : 'var(--tf-text-muted)',
                    }}
                  >
                    Micro {microProjectMode ? 'On' : 'Off'}
                  </button>
                  <button
                    onClick={onToggleTelegramMirror}
                    title={telegramConfigured ? 'Mirror this chat to Telegram messages' : 'Configure Telegram in Settings first'}
                    style={{
                      ...splitHeaderButtonBase,
                      borderColor: telegramMirrorEnabled ? 'var(--tf-accent-blue)' : 'var(--tf-border)',
                      backgroundColor: telegramMirrorEnabled ? 'color-mix(in srgb, var(--tf-accent-blue) 16%, transparent)' : 'transparent',
                      color: telegramMirrorEnabled ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)',
                      opacity: telegramConfigured ? 1 : 0.7,
                    }}
                  >
                    Telegram {telegramMirrorEnabled ? 'On' : 'Off'}
                  </button>
                  <button
                    onClick={() => setChatMaximized((prev) => !prev)}
                    title={chatMaximized ? 'Restore previous chat width' : 'Maximize chat panel width'}
                    style={{
                      ...splitHeaderButtonBase,
                      borderColor: chatMaximized ? 'var(--tf-accent-blue)' : 'var(--tf-border)',
                      backgroundColor: chatMaximized ? 'color-mix(in srgb, var(--tf-accent-blue) 16%, transparent)' : 'transparent',
                      color: chatMaximized ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)',
                    }}
                  >
                    {chatMaximized ? 'Restore' : 'Maximize'}
                  </button>
                  <button
                    onClick={onChatToggle}
                    className="w-6 h-6 rounded flex items-center justify-center cursor-pointer"
                    style={{ color: 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                    aria-label="Close CEO chat"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-hidden">{chatPanel}</div>
            </aside>
          </div>
        )}
      </div>

      {isMobileViewport && mobileSidebarOpen && (
        <button
          onClick={() => setMobileSidebarOpen(false)}
          aria-label="Close navigation overlay"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            backgroundColor: 'rgba(2, 8, 14, 0.5)',
            border: 'none',
            cursor: 'pointer',
          }}
        />
      )}
    </div>
  );
}
