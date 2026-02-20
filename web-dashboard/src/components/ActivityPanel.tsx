import { useState, useEffect, useRef, useMemo } from 'react';
import type { ActivityEvent } from '../types';

interface ActivityPanelProps {
  events: ActivityEvent[];
}

// ---- Helpers ----
function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = (action || '').toUpperCase();
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (a.includes('COMPLETED') || a.includes('DONE') || a.includes('FINISH')) return { bg: '#1a2e25', text: 'var(--tf-success)' };
  if (a.includes('BLOCKED') || a.includes('ERROR') || a.includes('FAIL')) return { bg: '#2d1519', text: 'var(--tf-error)' };
  if (a.includes('ASSIGNED') || a.includes('ASSIGN')) return { bg: '#1c2233', text: 'var(--tf-accent)' };
  if (a.includes('UPDATED') || a.includes('UPDATE')) return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (a.includes('CREATED') || a.includes('CREATE')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)' };
}

const ACTION_TYPES = ['ALL', 'STARTED', 'COMPLETED', 'BLOCKED', 'ASSIGNED', 'UPDATED', 'CREATED'];

function agentAvatarColor(name: string): string {
  const colors = [
    'var(--tf-accent)', 'var(--tf-accent-blue)', 'var(--tf-success)', 'var(--tf-accent-blue)',
    'var(--tf-warning)', 'var(--tf-warning)', 'var(--tf-accent-blue)', 'var(--tf-accent)',
    'var(--tf-error)', 'var(--tf-accent)',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return colors[hash % colors.length];
}

function formatTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts;
  }
}

function formatDate(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

// ---- Empty state ----
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 py-20">
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-3 h-3 rounded-full animate-pulse-dot"
            style={{
              backgroundColor: 'var(--tf-border)',
              animationDelay: `${i * 0.25}s`,
            }}
          />
        ))}
      </div>
      <p className="text-sm" style={{ color: 'var(--tf-text-muted)' }}>
        Waiting for events...
      </p>
      <p className="text-xs" style={{ color: 'var(--tf-border)' }}>
        Events will appear here as they stream in
      </p>
    </div>
  );
}

// ---- Event bubble ----
interface EventBubbleProps {
  event: ActivityEvent;
  index: number;
}
function EventBubble({ event, index }: EventBubbleProps) {
  const badge = actionBadgeStyle(event.action);
  const agentName = event.agent || 'System';
  const initial = agentName.charAt(0).toUpperCase();
  const color = agentAvatarColor(agentName);

  return (
    <div
      className="flex items-start gap-3 py-3 animate-slide-up"
      style={{
        borderBottom: '1px solid var(--tf-surface-raised)',
        animationDelay: `${Math.min(index * 0.02, 0.3)}s`,
      }}
    >
      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
        style={{ backgroundColor: color, color: 'var(--tf-bg)' }}
        aria-hidden="true"
      >
        {initial}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>
            {agentName}
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
            style={{ backgroundColor: badge.bg, color: badge.text }}
            role="status"
          >
            {event.action}
          </span>
          <span className="text-xs ml-auto flex-shrink-0" style={{ color: 'var(--tf-border)' }}>
            {formatDate(event.timestamp)} {formatTime(event.timestamp)}
          </span>
        </div>

        <div
          className="rounded-lg px-3 py-2.5"
          style={{ backgroundColor: 'var(--tf-surface-raised)' }}
        >
          <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
            {event.detail || '(no detail)'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---- Audit log entry ----
function AuditEntry({ event, index }: { event: ActivityEvent; index: number }) {
  const badge = actionBadgeStyle(event.action);
  return (
    <div
      className="flex items-center gap-3 py-2 text-xs animate-slide-up"
      style={{ borderBottom: '1px solid var(--tf-surface-raised)', animationDelay: `${Math.min(index * 0.01, 0.2)}s`, fontFamily: 'ui-monospace, monospace' }}
    >
      <span style={{ color: 'var(--tf-text-muted)', flexShrink: 0, width: '130px' }}>
        {formatDate(event.timestamp)} {formatTime(event.timestamp)}
      </span>
      <span
        style={{ flexShrink: 0, width: '90px', padding: '1px 6px', borderRadius: '4px', backgroundColor: badge.bg, color: badge.text, textAlign: 'center', fontSize: '10px', fontWeight: 600 }}
      >
        {event.action}
      </span>
      <span style={{ color: 'var(--tf-accent)', flexShrink: 0, width: '90px' }}>{event.agent}</span>
      <span style={{ color: 'var(--tf-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {event.detail}
      </span>
    </div>
  );
}

// ---- Main ActivityPanel ----
export default function ActivityPanel({ events }: ActivityPanelProps) {
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('ALL');
  const [activeTab, setActiveTab] = useState<'live' | 'audit'>('live');
  const [auditSearch, setAuditSearch] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const distanceToBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    if (distanceToBottom <= 120) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [events.length]);

  // Build unique agent list for filter
  const agentNames = useMemo(() => {
    const names = new Set<string>();
    for (const e of events) {
      if (e.agent) names.add(e.agent);
    }
    return Array.from(names).sort();
  }, [events]);

  // Filter events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const agentMatch = !agentFilter || e.agent === agentFilter;
      const actionMatch =
        actionFilter === 'ALL' ||
        (e.action || '').toUpperCase().includes(actionFilter);
      return agentMatch && actionMatch;
    });
  }, [events, agentFilter, actionFilter]);

  // Audit log derived state
  const auditEvents = useMemo(() => {
    const all = [...events].reverse(); // newest first
    if (!auditSearch.trim()) return all;
    const q = auditSearch.toLowerCase();
    return all.filter((e) =>
      (e.agent || '').toLowerCase().includes(q) ||
      (e.action || '').toLowerCase().includes(q) ||
      (e.detail || '').toLowerCase().includes(q)
    );
  }, [events, auditSearch]);

  return (
    <div className="flex flex-col animate-fade-in" style={{ height: '100%', minHeight: 0 }}>
      {/* Tab bar */}
      <div className="flex items-center gap-1 pb-3 flex-shrink-0">
        {(['live', 'audit'] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className="text-xs px-3 py-1.5 rounded-lg transition-all duration-150 cursor-pointer capitalize font-medium"
            style={{
              backgroundColor: activeTab === tab ? 'var(--tf-surface-raised)' : 'transparent',
              color: activeTab === tab ? 'var(--tf-text)' : 'var(--tf-text-muted)',
              border: activeTab === tab ? '1px solid var(--tf-border)' : '1px solid transparent',
              outline: 'none',
            }}>
            {tab === 'live' ? 'Live Feed' : 'Audit Log'}
          </button>
        ))}
        <span className="ml-auto text-xs" style={{ color: 'var(--tf-text-muted)' }}>{events.length} total events</span>
      </div>

      {/* Audit log view */}
      {activeTab === 'audit' && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 mb-3 flex-shrink-0" style={{ padding: '6px 10px', backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)', borderRadius: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--tf-text-muted)' }}>⌕</span>
            <input type="text" value={auditSearch} onChange={(e) => setAuditSearch(e.target.value)}
              placeholder="Search audit log…"
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: '12px', color: 'var(--tf-text)' }} />
            {auditSearch && <button onClick={() => setAuditSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tf-text-muted)', fontSize: '11px' }}>✕</button>}
            {auditSearch && <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>{auditEvents.length} results</span>}
          </div>
          <div className="flex-1 overflow-y-auto rounded-xl px-3" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
            {/* Header row */}
            <div className="flex items-center gap-3 py-2 text-xs sticky top-0" style={{ borderBottom: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)', fontFamily: 'ui-monospace, monospace', fontWeight: 600, color: 'var(--tf-text-muted)' }}>
              <span style={{ width: '130px', flexShrink: 0 }}>TIMESTAMP</span>
              <span style={{ width: '90px', flexShrink: 0 }}>ACTION</span>
              <span style={{ width: '90px', flexShrink: 0 }}>AGENT</span>
              <span>DETAIL</span>
            </div>
            {auditEvents.length === 0
              ? <p className="text-xs text-center py-8" style={{ color: 'var(--tf-text-muted)' }}>No audit entries yet.</p>
              : auditEvents.map((e, i) => <AuditEntry key={`${e.timestamp}-${i}`} event={e} index={i} />)
            }
          </div>
        </div>
      )}

      {/* Live feed view */}
      {activeTab === 'live' && <>
      {/* Filter bar */}
      <div
        className="flex items-center gap-3 px-0 pb-4 flex-shrink-0 flex-wrap"
      >
        <div className="flex items-center gap-2">
          <label
            htmlFor="agent-filter"
            className="text-xs font-medium"
            style={{ color: 'var(--tf-text-muted)' }}
          >
            Agent
          </label>
          <select
            id="agent-filter"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="text-xs rounded-lg px-2 py-1.5 transition-colors duration-200 cursor-pointer"
            style={{
              backgroundColor: 'var(--tf-surface)',
              border: '1px solid var(--tf-border)',
              color: 'var(--tf-text)',
              outline: 'none',
            }}
          >
            <option value="">All Agents</option>
            {agentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium" style={{ color: 'var(--tf-text-muted)' }}>
            Action
          </span>
          <div className="flex gap-1 flex-wrap">
            {ACTION_TYPES.map((type) => {
              const active = actionFilter === type;
              const badge = type !== 'ALL' ? actionBadgeStyle(type) : null;
              return (
                <button
                  key={type}
                  onClick={() => setActionFilter(type)}
                  className="text-xs px-2 py-1 rounded-full transition-all duration-200 cursor-pointer font-medium"
                  style={{
                    backgroundColor: active
                      ? badge ? badge.bg : 'var(--tf-surface-raised)'
                      : 'var(--tf-bg)',
                    color: active
                      ? badge ? badge.text : 'var(--tf-text)'
                      : 'var(--tf-text-muted)',
                    border: active
                      ? `1px solid ${badge ? badge.text : 'var(--tf-text)'}`
                      : '1px solid var(--tf-border)',
                    outline: 'none',
                  }}
                >
                  {type}
                </button>
              );
            })}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse-dot"
            style={{ backgroundColor: 'var(--tf-success)' }}
            aria-hidden="true"
          />
          <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
            {filteredEvents.length} events
            {(agentFilter || actionFilter !== 'ALL') ? ` (filtered from ${events.length})` : ''}
          </span>
        </div>
      </div>

      {/* Events feed */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto rounded-xl"
        style={{
          backgroundColor: 'var(--tf-surface)',
          border: '1px solid var(--tf-border)',
        }}
        role="feed"
        aria-label="Activity events"
        aria-live="polite"
      >
        {filteredEvents.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="px-4">
            {filteredEvents.map((event, i) => (
              <EventBubble
                key={`${event.timestamp}-${event.agent}-${i}`}
                event={event}
                index={i}
              />
            ))}
            <div ref={bottomRef} className="h-4" />
          </div>
        )}
      </div>
    </>}
    </div>
  );
}
