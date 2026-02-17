import React from 'react';

interface LayoutProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: React.ReactNode;
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
    id: 'chat',
    label: 'CEO Chat',
    iconPath: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  },
];

const PAGE_LABELS: Record<string, string> = {
  overview: 'Overview',
  agents: 'Agents',
  projects: 'Projects',
  activity: 'Activity',
  metrics: 'Metrics',
  chat: 'CEO Chat',
};

export default function Layout({ activeTab, onTabChange, children }: LayoutProps) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: '#1e1e2e', color: '#cdd6f4' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0 w-56"
        style={{ backgroundColor: '#11111b', borderRight: '1px solid #45475a' }}
      >
        {/* Logo */}
        <div className="px-4 py-5 flex-shrink-0" style={{ borderBottom: '1px solid #313244' }}>
          <div className="flex items-center gap-3">
            {/* Diamond/Pie icon */}
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: '#cba6f7' }}
            >
              <svg
                className="w-4 h-4"
                style={{ color: '#11111b' }}
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M12 2L2 8.5l10 13.5 10-13.5L12 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight" style={{ color: '#cdd6f4' }}>
                CrackPie
              </h1>
              <p className="text-xs leading-tight" style={{ color: '#6c7086' }}>
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
                  backgroundColor: isActive ? '#313244' : 'transparent',
                  color: isActive ? '#cba6f7' : '#a6adc8',
                  borderLeft: isActive ? '2px solid #cba6f7' : '2px solid transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#1e1e2e';
                    (e.currentTarget as HTMLButtonElement).style.color = '#cdd6f4';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                    (e.currentTarget as HTMLButtonElement).style.color = '#a6adc8';
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
          style={{ borderTop: '1px solid #313244' }}
        >
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot"
              style={{ backgroundColor: '#a6e3a1' }}
              aria-hidden="true"
            />
            <span className="text-xs" style={{ color: '#6c7086' }}>
              Live
            </span>
            <span className="text-xs ml-auto" style={{ color: '#45475a' }}>
              5s poll
            </span>
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
        <header
          className="flex items-center justify-between px-6 py-3 flex-shrink-0"
          style={{ backgroundColor: '#181825', borderBottom: '1px solid #313244' }}
        >
          <div>
            <h2 className="text-base font-semibold" style={{ color: '#cdd6f4' }}>
              {PAGE_LABELS[activeTab] ?? 'Dashboard'}
            </h2>
            <p className="text-xs" style={{ color: '#6c7086' }}>
              CrackPie — AI Virtual Company
            </p>
          </div>
          <div
            className="text-xs px-3 py-1.5 rounded-full"
            style={{
              color: '#a6adc8',
              backgroundColor: '#313244',
              border: '1px solid #45475a',
            }}
          >
            {today}
          </div>
        </header>

        {/* Page content */}
        <main
          id="main-content"
          className="flex-1 overflow-y-auto p-6"
          style={{ backgroundColor: '#1e1e2e' }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
