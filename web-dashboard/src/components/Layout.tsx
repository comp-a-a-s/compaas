import React, { useState } from 'react';
import Tooltip from './Tooltip';

interface LayoutProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: React.ReactNode;
  chatOpen: boolean;
  onChatToggle: () => void;
  chatPanel?: React.ReactNode;
  chatHasUnread?: boolean;
  ceoName?: string;
}

const NAV_ITEMS = [
  {
    id: 'overview',
    label: 'Overview',
    shortcut: '1',
    iconPath: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  },
  {
    id: 'agents',
    label: 'Agents',
    shortcut: '2',
    iconPath: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  },
  {
    id: 'projects',
    label: 'Projects',
    shortcut: '3',
    iconPath: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  },
  {
    id: 'activity',
    label: 'Activity',
    shortcut: '4',
    iconPath: 'M13 10V3L4 14h7v7l9-11h-7z',
  },
  {
    id: 'metrics',
    label: 'Metrics',
    shortcut: '5',
    iconPath: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    id: 'settings',
    label: 'Settings',
    shortcut: '6',
    iconPath: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  },
];

const PAGE_LABELS: Record<string, string> = {
  overview: 'Overview',
  agents: 'Agents',
  projects: 'Projects',
  activity: 'Activity',
  metrics: 'Metrics',
  settings: 'Settings',
};

export default function Layout({ activeTab, onTabChange, children, chatOpen, onChatToggle, chatPanel, chatHasUnread, ceoName = 'CEO' }: LayoutProps) {
  const [chatFullscreen, setChatFullscreen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('thunderflow_sidebar_collapsed') === 'true';
  });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const handleChatToggle = () => {
    if (chatOpen) {
      setChatFullscreen(false);
    }
    onChatToggle();
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('thunderflow_sidebar_collapsed', String(next));
      return next;
    });
  };

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0 transition-all duration-200"
        style={{
          width: sidebarCollapsed ? '56px' : '224px',
          backgroundColor: 'var(--tf-bg)',
          borderRight: '1px solid var(--tf-border)',
          overflow: 'hidden',
        }}
      >
        {/* Logo */}
        <div
          className="flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--tf-surface-raised)',
            padding: sidebarCollapsed ? '14px 0' : '20px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'space-between',
          }}
        >
          <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
            {/* Lightning bolt icon */}
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: 'var(--tf-accent)' }}
            >
              <svg
                className="w-4 h-4"
                stroke="currentColor"
                fill="none"
                strokeWidth={2}
                viewBox="0 0 24 24"
                aria-hidden="true"
                style={{ color: 'var(--tf-bg)' }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            {!sidebarCollapsed && (
              <div style={{ minWidth: 0 }}>
                <h1 className="text-sm font-bold leading-tight" style={{ color: 'var(--tf-text)' }}>
                  ThunderFlow
                </h1>
                <p className="text-xs leading-tight" style={{ color: 'var(--tf-text-muted)' }}>
                  AI Dashboard
                </p>
              </div>
            )}
          </div>
          {/* Collapse toggle (only visible when expanded) */}
          {!sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              title="Collapse sidebar"
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
          className="flex-1 py-3 overflow-y-auto overflow-x-hidden"
          style={{ padding: sidebarCollapsed ? '12px 0' : '12px 8px' }}
          role="navigation"
          aria-label="Main navigation"
        >
          {/* Expand button when collapsed */}
          {sidebarCollapsed && (
            <Tooltip content="Expand sidebar" position="right">
              <button
                onClick={toggleSidebar}
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
                  onClick={() => onTabChange(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className="w-full flex items-center rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer"
                  style={{
                    gap: sidebarCollapsed ? 0 : '12px',
                    padding: sidebarCollapsed ? '8px 0' : '8px 12px',
                    justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                    backgroundColor: isActive ? 'var(--tf-surface-raised)' : 'transparent',
                    color: isActive ? 'var(--tf-accent)' : 'var(--tf-text-secondary)',
                    borderLeft: isActive && !sidebarCollapsed ? '2px solid var(--tf-accent)' : '2px solid transparent',
                    marginBottom: '2px',
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
                  <svg
                    className="w-4 h-4 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.iconPath} />
                  </svg>
                  {!sidebarCollapsed && item.label}
                </button>
              </Tooltip>
            );
          })}
        </nav>

        {/* Status footer */}
        <div
          className="flex-shrink-0"
          style={{
            borderTop: '1px solid var(--tf-surface-raised)',
            padding: sidebarCollapsed ? '12px 0' : '16px',
          }}
        >
          {sidebarCollapsed ? (
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
                  5s poll
                </span>
              </div>
              {/* Telegram handoff button */}
              <button
                onClick={() => {
                  const configured = localStorage.getItem('thunderflow_telegram_configured') === 'true';
                  if (configured) {
                    alert('Session handoff to Telegram initiated. Continue the conversation in your Telegram bot.');
                  } else {
                    onTabChange('settings');
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
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2ca5e0'; e.currentTarget.style.color = '#2ca5e0'; }}
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
          className="flex items-center justify-between px-6 py-3 flex-shrink-0"
          style={{ backgroundColor: 'var(--tf-surface)', borderBottom: '1px solid var(--tf-surface-raised)' }}
        >
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--tf-text)' }}>
              {PAGE_LABELS[activeTab] ?? 'Dashboard'}
            </h2>
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              ThunderFlow — AI Virtual Company
            </p>
          </div>
          <div
            className="text-xs px-3 py-1.5 rounded-full"
            style={{
              color: 'var(--tf-text-secondary)',
              backgroundColor: 'var(--tf-surface-raised)',
              border: '1px solid var(--tf-border)',
            }}
          >
            {today}
          </div>
        </header>

        {/* Page content */}
        <main
          id="main-content"
          className="flex-1 overflow-y-auto p-6"
          style={{ backgroundColor: 'var(--tf-bg)' }}
        >
          {children}
        </main>
      </div>

      {/* Floating CEO Chat */}
      {chatOpen && (
        <div
          className="fixed z-50 flex flex-col"
          style={{
            bottom: chatFullscreen ? '5vh' : '80px',
            right: chatFullscreen ? '2.5vw' : '24px',
            width: chatFullscreen ? '95vw' : '420px',
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
      )}

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
