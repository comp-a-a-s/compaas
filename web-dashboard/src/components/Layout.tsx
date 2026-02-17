import React, { useState } from 'react';

interface LayoutProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: React.ReactNode;
  chatOpen: boolean;
  onChatToggle: () => void;
  chatPanel?: React.ReactNode;
  chatHasUnread?: boolean;
}

const NAV_ITEMS = [
  {
    id: 'overview',
    label: 'Overview',
    iconPath: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  },
  {
    id: 'agents',
    label: 'Agents',
    iconPath: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  },
  {
    id: 'projects',
    label: 'Projects',
    iconPath: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  },
  {
    id: 'activity',
    label: 'Activity',
    iconPath: 'M13 10V3L4 14h7v7l9-11h-7z',
  },
  {
    id: 'metrics',
    label: 'Metrics',
    iconPath: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    id: 'settings',
    label: 'Settings',
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

export default function Layout({ activeTab, onTabChange, children, chatOpen, onChatToggle, chatPanel, chatHasUnread }: LayoutProps) {
  const [chatFullscreen, setChatFullscreen] = useState(false);

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

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: '#0d1117', color: '#e6edf3' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0 w-56"
        style={{ backgroundColor: '#0d1117', borderRight: '1px solid #30363d' }}
      >
        {/* Logo */}
        <div className="px-4 py-5 flex-shrink-0" style={{ borderBottom: '1px solid #21262d' }}>
          <div className="flex items-center gap-3">
            {/* Lightning bolt icon */}
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: '#8b8fc7' }}
            >
              <svg
                className="w-4 h-4"
                stroke="currentColor"
                fill="none"
                strokeWidth={2}
                viewBox="0 0 24 24"
                aria-hidden="true"
                style={{ color: '#0d1117' }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight" style={{ color: '#e6edf3' }}>
                ThunderFlow
              </h1>
              <p className="text-xs leading-tight" style={{ color: '#484f58' }}>
                AI Dashboard
              </p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav
          className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto"
          role="navigation"
          aria-label="Main navigation"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer text-left"
                style={{
                  backgroundColor: isActive ? '#21262d' : 'transparent',
                  color: isActive ? '#8b8fc7' : '#8b949e',
                  borderLeft: isActive ? '2px solid #8b8fc7' : '2px solid transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#0d1117';
                    (e.currentTarget as HTMLButtonElement).style.color = '#e6edf3';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                    (e.currentTarget as HTMLButtonElement).style.color = '#8b949e';
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
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Status footer */}
        <div
          className="px-4 py-4 flex-shrink-0"
          style={{ borderTop: '1px solid #21262d' }}
        >
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot"
              style={{ backgroundColor: '#3fb950' }}
              aria-hidden="true"
            />
            <span className="text-xs" style={{ color: '#484f58' }}>
              Live
            </span>
            <span className="text-xs ml-auto" style={{ color: '#30363d' }}>
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
              border: '1px solid #30363d',
              backgroundColor: 'transparent',
              color: '#8b949e',
              fontSize: '11px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2ca5e0'; e.currentTarget.style.color = '#2ca5e0'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#30363d'; e.currentTarget.style.color = '#8b949e'; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
            </svg>
            Continue on Telegram
          </button>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
        <header
          className="flex items-center justify-between px-6 py-3 flex-shrink-0"
          style={{ backgroundColor: '#161b22', borderBottom: '1px solid #21262d' }}
        >
          <div>
            <h2 className="text-base font-semibold" style={{ color: '#e6edf3' }}>
              {PAGE_LABELS[activeTab] ?? 'Dashboard'}
            </h2>
            <p className="text-xs" style={{ color: '#484f58' }}>
              ThunderFlow — AI Virtual Company
            </p>
          </div>
          <div
            className="text-xs px-3 py-1.5 rounded-full"
            style={{
              color: '#8b949e',
              backgroundColor: '#21262d',
              border: '1px solid #30363d',
            }}
          >
            {today}
          </div>
        </header>

        {/* Page content */}
        <main
          id="main-content"
          className="flex-1 overflow-y-auto p-6"
          style={{ backgroundColor: '#0d1117' }}
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
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '16px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            overflow: 'hidden',
            transition: 'all 0.25s ease',
          }}
        >
          {/* Chat header with fullscreen + close */}
          <div
            className="flex items-center justify-between px-4 py-3 flex-shrink-0"
            style={{ borderBottom: '1px solid #21262d' }}
          >
            <div className="flex items-center gap-2">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                style={{ backgroundColor: '#8b8fc7', color: '#0d1117' }}
              >
                M
              </div>
              <span className="text-sm font-semibold" style={{ color: '#e6edf3' }}>
                CEO Chat
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* Fullscreen toggle button */}
              <button
                onClick={() => setChatFullscreen(f => !f)}
                title={chatFullscreen ? 'Restore' : 'Expand'}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
                style={{ color: '#484f58', backgroundColor: 'transparent' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#21262d';
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
                style={{ color: '#484f58', backgroundColor: 'transparent' }}
                aria-label="Close chat"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#21262d';
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

      {/* Floating chat toggle button */}
      <button
        onClick={handleChatToggle}
        className="fixed z-50 flex items-center justify-center rounded-full shadow-lg transition-all duration-200 cursor-pointer"
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          width: '52px',
          height: '52px',
          backgroundColor: chatOpen ? '#21262d' : '#8b8fc7',
          color: chatOpen ? '#8b949e' : '#0d1117',
          border: `1px solid ${chatOpen ? '#30363d' : '#8b8fc7'}`,
        }}
        aria-label={chatOpen ? 'Close CEO Chat' : 'Open CEO Chat'}
        onMouseEnter={(e) => {
          if (!chatOpen) {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#7b7fbf';
          } else {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#30363d';
          }
        }}
        onMouseLeave={(e) => {
          if (!chatOpen) {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#8b8fc7';
          } else {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#21262d';
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
              backgroundColor: '#f85149',
              border: '2px solid #0d1117',
            }}
            aria-label="Unread messages"
          />
        )}
      </button>
    </div>
  );
}
