import React, { useState, useMemo, useEffect } from 'react';
import Tooltip from './Tooltip';
import CompassRoseLogo from './CompassRoseLogo';

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
  /** If true, embed chat panel inline in a split-view layout */
  splitView?: boolean;
}

const DEFAULT_NAV_ITEMS = [
  { id: 'overview',  label: 'Overview',  shortcut: '1', iconPath: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { id: 'agents',    label: 'Agents',    shortcut: '2', iconPath: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
  { id: 'projects',  label: 'Projects',  shortcut: '3', iconPath: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
  { id: 'activity',  label: 'Activity',  shortcut: '4', iconPath: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'metrics',   label: 'Metrics',   shortcut: '5', iconPath: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { id: 'settings',  label: 'Settings',  shortcut: '6', iconPath: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

const NAV_ORDER_KEY = 'compaas_sidebar_order';
const LEGACY_NAV_ORDER_KEY = 'tf_sidebar_order';
const SIDEBAR_COLLAPSED_KEY = 'compaas_sidebar_collapsed';
const TELEGRAM_CONFIGURED_KEY = 'compaas_telegram_configured';

function getStoredBoolean(primaryKey: string, fallback = false): boolean {
  const primary = localStorage.getItem(primaryKey);
  if (primary !== null) return primary === 'true';
  return fallback;
}

function loadNavOrder(): string[] {
  try {
    const s = localStorage.getItem(NAV_ORDER_KEY) ?? localStorage.getItem(LEGACY_NAV_ORDER_KEY);
    if (s) {
      const order: string[] = JSON.parse(s);
      // Ensure all default items are present
      const defaultIds = DEFAULT_NAV_ITEMS.map((i) => i.id);
      const validOrder = order.filter((id) => defaultIds.includes(id));
      // Append any new items not in stored order
      for (const id of defaultIds) {
        if (!validOrder.includes(id)) validOrder.push(id);
      }
      localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(validOrder));
      return validOrder;
    }
  } catch { /* ignore */ }
  return DEFAULT_NAV_ITEMS.map((i) => i.id);
}

const PAGE_LABELS: Record<string, string> = {
  overview: 'Overview',
  agents: 'Agents',
  projects: 'Projects',
  activity: 'Activity',
  metrics: 'Metrics',
  settings: 'Settings',
};

function formatPollInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms poll`;
  if (ms % 1000 === 0) return `${ms / 1000}s poll`;
  return `${(ms / 1000).toFixed(1)}s poll`;
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
  splitView: splitViewProp = false,
}: LayoutProps) {
  const [chatFullscreen, setChatFullscreen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    getStoredBoolean(SIDEBAR_COLLAPSED_KEY)
  );
  const [navOrder, setNavOrder] = useState<string[]>(loadNavOrder);
  const [editingSidebar, setEditingSidebar] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [splitView, setSplitView] = useState(splitViewProp);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  // Sync if parent changes the prop
  useEffect(() => { setSplitView(splitViewProp); }, [splitViewProp]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isMobileViewport = viewportWidth <= 900;

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileSidebarOpen(false);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    if (isMobileViewport) {
      setMobileSidebarOpen(false);
    }
  }, [activeTab, isMobileViewport]);

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

  const NAV_ITEMS = useMemo(() => {
    return navOrder
      .map((id) => DEFAULT_NAV_ITEMS.find((item) => item.id === id))
      .filter(Boolean) as typeof DEFAULT_NAV_ITEMS;
  }, [navOrder]);

  const moveNav = (id: string, dir: -1 | 1) => {
    setNavOrder((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next));
      return next;
    });
  };

  const today = useMemo(() => new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }), []);

  const handleChatToggle = () => {
    if (chatOpen) {
      setChatFullscreen(false);
    }
    onChatToggle();
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  const isNarrowViewport = viewportWidth <= 1024;
  const sidebarIsCollapsed = isMobileViewport ? false : sidebarCollapsed;
  const compactChatLeftPx = isMobileViewport ? 12 : (sidebarIsCollapsed ? 64 : 232);

  return (
    <div className="compaas-shell flex h-screen overflow-hidden" style={{ backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0 transition-all duration-200"
        style={{
          backgroundColor: 'var(--tf-bg)',
          borderRight: '1px solid var(--tf-border)',
          overflow: 'hidden',
          ...(isMobileViewport
            ? {
                width: '260px',
                position: 'fixed',
                top: 0,
                left: 0,
                bottom: 0,
                zIndex: 60,
                transform: mobileSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
              }
            : {
                width: sidebarIsCollapsed ? '56px' : '224px',
                position: 'relative',
                transform: 'none',
                boxShadow: 'none',
              }),
        }}
      >
        {/* Logo */}
        <div
          className="flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--tf-surface-raised)',
            padding: sidebarIsCollapsed ? '14px 0' : '20px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarIsCollapsed ? 'center' : 'space-between',
          }}
        >
          <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
            <CompassRoseLogo size={32} />
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
          {/* Collapse toggle (only visible when expanded) */}
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

        {/* Navigation */}
        <nav
          className="flex-1 flex flex-col overflow-y-auto overflow-x-hidden"
          style={{ padding: sidebarIsCollapsed ? '12px 0' : '12px 8px' }}
          role="navigation"
          aria-label="Main navigation"
        >
          {/* Expand button when collapsed */}
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

          {NAV_ITEMS.map((item, idx) => {
            const isActive = activeTab === item.id;
            return (
              <div key={item.id} className="flex items-center" style={{ marginBottom: '2px' }}>
                <Tooltip content={`${item.label} (${item.shortcut})`} position="right">
                  <button
                    onClick={() => {
                      if (!editingSidebar) {
                        onTabChange(item.id);
                        if (isMobileViewport) setMobileSidebarOpen(false);
                      }
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className="flex-1 flex items-center rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer"
                    style={{
                      gap: sidebarIsCollapsed ? 0 : '12px',
                      padding: sidebarIsCollapsed ? '8px 0' : '8px 12px',
                      justifyContent: sidebarIsCollapsed ? 'center' : 'flex-start',
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
                {/* Reorder controls — shown only when editing sidebar and not collapsed */}
                {editingSidebar && !sidebarIsCollapsed && (
                  <div className="flex flex-col" style={{ marginLeft: '2px' }}>
                    <button
                      onClick={() => moveNav(item.id, -1)}
                      disabled={idx === 0}
                      style={{ background: 'none', border: 'none', color: idx === 0 ? 'var(--tf-border)' : 'var(--tf-text-muted)', cursor: idx === 0 ? 'default' : 'pointer', padding: '1px', lineHeight: 1, fontSize: '10px' }}
                    >▲</button>
                    <button
                      onClick={() => moveNav(item.id, 1)}
                      disabled={idx === NAV_ITEMS.length - 1}
                      style={{ background: 'none', border: 'none', color: idx === NAV_ITEMS.length - 1 ? 'var(--tf-border)' : 'var(--tf-text-muted)', cursor: idx === NAV_ITEMS.length - 1 ? 'default' : 'pointer', padding: '1px', lineHeight: 1, fontSize: '10px' }}
                    >▼</button>
                  </div>
                )}
              </div>
            );
          })}
          {/* Edit sidebar toggle */}
          {!sidebarIsCollapsed && (
            <button
              onClick={() => setEditingSidebar((v) => !v)}
              className="w-full text-left text-xs mt-2 px-3 py-1 rounded-lg cursor-pointer transition-all"
              style={{ color: editingSidebar ? 'var(--tf-accent)' : 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = editingSidebar ? 'var(--tf-accent)' : 'var(--tf-text-muted)'; }}
            >
              {editingSidebar ? '✓ Done Reordering' : '⋮ Reorder'}
            </button>
          )}
        </nav>

        {/* Status footer */}
        <div
          className="flex-shrink-0"
          style={{
            borderTop: '1px solid var(--tf-surface-raised)',
            padding: sidebarIsCollapsed ? '12px 0' : '16px',
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
              {/* Telegram handoff button */}
              <button
                onClick={() => {
                  const configured = getStoredBoolean(TELEGRAM_CONFIGURED_KEY);
                  if (configured) {
                    alert('Session handoff to Telegram initiated. Continue the conversation in your Telegram bot.');
                  } else {
                    onTabChange('settings');
                    if (isMobileViewport) setMobileSidebarOpen(false);
                  }
                }}
                title="Continue on Telegram"
                style={{
                  marginTop: '8px',
                  width: '100%',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'transparent',
                  color: 'var(--tf-text-secondary)',
                  fontSize: '11px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--tf-accent-blue)'; e.currentTarget.style.color = 'var(--tf-accent-blue)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--tf-border)'; e.currentTarget.style.color = 'var(--tf-text-secondary)'; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
                </svg>
                Continue on Telegram
              </button>
            </>
          )}
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
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
          <div className="flex items-center gap-2">
            {/* Split view toggle */}
            {!isMobileViewport && (
              <Tooltip content={splitView ? 'Disable split view' : 'Enable split view (chat alongside content)'} position="bottom">
              <button
                onClick={() => setSplitView((v) => !v)}
                aria-label={splitView ? 'Disable split view' : 'Enable split view'}
                className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all"
                style={{
                  backgroundColor: splitView ? 'var(--tf-accent-blue)' : 'transparent',
                  color: splitView ? 'var(--tf-bg)' : 'var(--tf-text-muted)',
                  border: `1px solid ${splitView ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
                }}
                onMouseEnter={(e) => { if (!splitView) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)'; }}
                onMouseLeave={(e) => { if (!splitView) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h4M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M9 3v18M15 3v18" />
                </svg>
              </button>
            </Tooltip>
            )}
            <div
              className="text-xs px-2.5 py-1.5 rounded-full"
              style={{ color: 'var(--tf-text-secondary)', backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}
            >
              {today}
            </div>
          </div>
        </header>

        {/* Page content (normal or split-view) */}
        {splitView && !isMobileViewport ? (
          <div className="flex-1 flex overflow-hidden">
            <main
              id="main-content"
              className="flex-1 overflow-y-auto p-4 md:p-6"
              style={{ backgroundColor: 'var(--tf-bg)' }}
            >
              {children}
            </main>
            {/* Inline chat panel */}
            <div
              className="flex-shrink-0 flex flex-col overflow-hidden"
              style={{
                width: '380px',
                borderLeft: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-surface)',
              }}
            >
              <div
                className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
              >
                <span className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>
                  {ceoName} — CEO
                </span>
                <button
                  onClick={() => setSplitView(false)}
                  className="w-6 h-6 rounded flex items-center justify-center cursor-pointer"
                  style={{ color: 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                  aria-label="Close split view"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                {chatPanel}
              </div>
            </div>
          </div>
        ) : (
          <main
            id="main-content"
            className="flex-1 overflow-y-auto p-4 md:p-6"
            style={{ backgroundColor: 'var(--tf-bg)' }}
          >
            {children}
          </main>
        )}
      </div>

      {/* Mobile sidebar backdrop */}
      {isMobileViewport && mobileSidebarOpen && (
        <button
          onClick={() => setMobileSidebarOpen(false)}
          aria-label="Close navigation menu"
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

      {/* Floating CEO Chat — always mounted to preserve in-flight state; toggled via display */}
      <div
        className="fixed z-50 flex flex-col"
        style={{
          display: chatOpen ? 'flex' : 'none',
          bottom: chatFullscreen ? '5vh' : '80px',
          left: !chatFullscreen && isNarrowViewport ? `${compactChatLeftPx}px` : 'auto',
          right: !chatFullscreen && isNarrowViewport ? '12px' : (chatFullscreen ? '2.5vw' : '24px'),
          width: chatFullscreen ? '95vw' : (isNarrowViewport ? 'auto' : '420px'),
          height: chatFullscreen ? '90vh' : '560px',
          backgroundColor: 'var(--tf-surface)',
          border: '1px solid var(--tf-border)',
          borderRadius: '16px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          transition: 'all 0.25s ease',
        }}
      >
          {/* Chat header with fullscreen + close */}
          <div
            className="flex items-center justify-between px-4 py-3 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
          >
            <div className="flex items-center gap-2">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }}
              >
                {ceoName.charAt(0).toUpperCase()}
              </div>
              <span className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>
                {ceoName} — CEO
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* Fullscreen toggle button */}
              <button
                onClick={() => setChatFullscreen(f => !f)}
                title={chatFullscreen ? 'Restore' : 'Expand'}
                aria-label={chatFullscreen ? 'Restore chat size' : 'Expand chat'}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
                style={{ color: 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                }}
              >
                {chatFullscreen ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9L4 4m0 0h5m-5 0v5M15 9l5-5m0 0h-5m5 0v5M9 15l-5 5m0 0h5m-5 0v-5M15 15l5 5m0 0h-5m5 0v-5" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5h-4m4 0v-4m0 4l-5-5" />
                  </svg>
                )}
              </button>
              {/* Close button */}
              <button
                onClick={handleChatToggle}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
                style={{ color: 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
                aria-label="Close chat"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          {/* Chat content */}
          <div className="flex-1 overflow-hidden">
            {chatPanel}
          </div>
        </div>

      {/* Floating chat toggle button — hidden when chat is fullscreen */}
      {!(chatOpen && chatFullscreen) && (
        <button
          onClick={handleChatToggle}
          className="fixed z-50 flex items-center justify-center rounded-full shadow-lg transition-all duration-200 cursor-pointer"
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            width: '52px',
            height: '52px',
            backgroundColor: chatOpen ? 'var(--tf-surface-raised)' : 'var(--tf-accent)',
            color: chatOpen ? 'var(--tf-text-secondary)' : 'var(--tf-bg)',
            border: `1px solid ${chatOpen ? 'var(--tf-border)' : 'var(--tf-accent)'}`,
          }}
          aria-label={chatOpen ? 'Close CEO Chat' : 'Open CEO Chat'}
          onMouseEnter={(e) => {
            if (!chatOpen) {
              (e.currentTarget as HTMLButtonElement).style.opacity = '0.85';
            } else {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-border)';
            }
          }}
          onMouseLeave={(e) => {
            if (!chatOpen) {
              (e.currentTarget as HTMLButtonElement).style.opacity = '1';
            } else {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)';
            }
          }}
        >
          {chatOpen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          )}
          {/* Unread badge */}
          {chatHasUnread && !chatOpen && (
            <span
              style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: 'var(--tf-error)',
                border: '2px solid var(--tf-bg)',
              }}
              aria-label="Unread messages"
            />
          )}
        </button>
      )}
    </div>
  );
}
