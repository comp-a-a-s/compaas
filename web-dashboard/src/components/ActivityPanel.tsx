import { useState, useEffect, useRef, useMemo } from 'react';
import type { ActivityEvent } from '../types';

interface ActivityPanelProps {
  events: ActivityEvent[];
}

// ---- Helpers ----
function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = (action || '').toUpperCase();
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1e3a5f', text: '#89b4fa' };
  if (a.includes('COMPLETED') || a.includes('DONE') || a.includes('FINISH')) return { bg: '#1a3a2a', text: '#a6e3a1' };
  if (a.includes('BLOCKED') || a.includes('ERROR') || a.includes('FAIL')) return { bg: '#3a1a1e', text: '#f38ba8' };
  if (a.includes('ASSIGNED') || a.includes('ASSIGN')) return { bg: '#2a1e3a', text: '#cba6f7' };
  if (a.includes('UPDATED') || a.includes('UPDATE')) return { bg: '#3a3010', text: '#f9e2af' };
  if (a.includes('CREATED') || a.includes('CREATE')) return { bg: '#103a35', text: '#94e2d5' };
  return { bg: '#313244', text: '#a6adc8' };
}

const ACTION_TYPES = ['ALL', 'STARTED', 'COMPLETED', 'BLOCKED', 'ASSIGNED', 'UPDATED', 'CREATED'];

function agentAvatarColor(name: string): string {
  const colors = [
    '#cba6f7', '#89b4fa', '#a6e3a1', '#94e2d5',
    '#fab387', '#f9e2af', '#74c7ec', '#b4befe',
    '#f38ba8', '#f5c2e7',
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
              backgroundColor: '#45475a',
              animationDelay: `${i * 0.25}s`,
            }}
          />
        ))}
      </div>
      <p className="text-sm" style={{ color: '#6c7086' }}>
        Waiting for events...
      </p>
      <p className="text-xs" style={{ color: '#45475a' }}>
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
        borderBottom: '1px solid #313244',
        animationDelay: `${Math.min(index * 0.02, 0.3)}s`,
      }}
    >
      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
        style={{ backgroundColor: color, color: '#11111b' }}
        aria-hidden="true"
      >
        {initial}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-xs font-semibold" style={{ color: '#cdd6f4' }}>
            {agentName}
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
            style={{ backgroundColor: badge.bg, color: badge.text }}
            role="status"
          >
            {event.action}
          </span>
          <span className="text-xs ml-auto flex-shrink-0" style={{ color: '#45475a' }}>
            {formatDate(event.timestamp)} {formatTime(event.timestamp)}
          </span>
        </div>

        <div
          className="rounded-lg px-3 py-2.5"
          style={{ backgroundColor: '#313244' }}
        >
          <p className="text-xs leading-relaxed" style={{ color: '#a6adc8' }}>
            {event.detail || '(no detail)'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---- Main ActivityPanel ----
export default function ActivityPanel({ events }: ActivityPanelProps) {
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('ALL');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  return (
    <div className="flex flex-col animate-fade-in" style={{ height: '100%', minHeight: '600px' }}>
      {/* Filter bar */}
      <div
        className="flex items-center gap-3 px-0 pb-4 flex-shrink-0 flex-wrap"
      >
        <div className="flex items-center gap-2">
          <label
            htmlFor="agent-filter"
            className="text-xs font-medium"
            style={{ color: '#6c7086' }}
          >
            Agent
          </label>
          <select
            id="agent-filter"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="text-xs rounded-lg px-2 py-1.5 transition-colors duration-200 cursor-pointer"
            style={{
              backgroundColor: '#181825',
              border: '1px solid #45475a',
              color: '#cdd6f4',
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
          <span className="text-xs font-medium" style={{ color: '#6c7086' }}>
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
                      ? badge ? badge.bg : '#313244'
                      : '#1e1e2e',
                    color: active
                      ? badge ? badge.text : '#cdd6f4'
                      : '#6c7086',
                    border: active
                      ? `1px solid ${badge ? badge.text : '#cdd6f4'}`
                      : '1px solid #45475a',
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
            style={{ backgroundColor: '#a6e3a1' }}
            aria-hidden="true"
          />
          <span className="text-xs" style={{ color: '#6c7086' }}>
            {filteredEvents.length} events
            {(agentFilter || actionFilter !== 'ALL') ? ` (filtered from ${events.length})` : ''}
          </span>
        </div>
      </div>

      {/* Events feed */}
      <div
        className="flex-1 overflow-y-auto rounded-xl"
        style={{
          backgroundColor: '#181825',
          border: '1px solid #45475a',
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
    </div>
  );
}
