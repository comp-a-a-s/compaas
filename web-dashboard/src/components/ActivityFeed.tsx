import { useEffect, useRef } from 'react';

interface ActivityEvent {
  id: number;
  raw: string;
  timestamp: string;
  agent: string;
  action: string;
  detail: string;
}

interface ActivityFeedProps {
  events: ActivityEvent[];
}

function parseEvent(raw: string, id: number): ActivityEvent {
  // Try to parse structured JSON first
  try {
    const parsed = JSON.parse(raw);
    const agent = parsed.agent ?? parsed.name ?? 'System';
    const action = parsed.action ?? parsed.event ?? parsed.status ?? 'UPDATE';
    const detail = parsed.detail ?? parsed.message ?? parsed.task ?? '';
    const timestamp = parsed.timestamp ?? new Date().toISOString();
    return { id, raw, timestamp, agent, action: action.toUpperCase(), detail };
  } catch {
    // Fall back to plain text parsing
  }

  // Try pattern: "2024-01-01T00:00:00 | AgentName | ACTION | detail"
  const pipePattern = /^(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*(?:\|\s*(.+))?$/;
  const pipeMatch = raw.match(pipePattern);
  if (pipeMatch) {
    return {
      id,
      raw,
      timestamp: pipeMatch[1].trim(),
      agent: pipeMatch[2].trim(),
      action: pipeMatch[3].trim().toUpperCase(),
      detail: pipeMatch[4]?.trim() ?? '',
    };
  }

  // Try "AgentName STARTED/COMPLETED task_name"
  const actionPattern = /^(\S+)\s+(STARTED|COMPLETED|FAILED|BLOCKED|ASSIGNED|UPDATED)\s+(.*)$/i;
  const actionMatch = raw.match(actionPattern);
  if (actionMatch) {
    return {
      id,
      raw,
      timestamp: new Date().toISOString(),
      agent: actionMatch[1],
      action: actionMatch[2].toUpperCase(),
      detail: actionMatch[3],
    };
  }

  // Generic fallback
  return {
    id,
    raw,
    timestamp: new Date().toISOString(),
    agent: 'System',
    action: 'EVENT',
    detail: raw,
  };
}

function actionBadge(action: string): string {
  switch (action) {
    case 'STARTED': return 'bg-blue-900 text-blue-300 border-blue-700';
    case 'COMPLETED': return 'bg-green-900 text-green-300 border-green-700';
    case 'FAILED': return 'bg-red-900 text-red-300 border-red-700';
    case 'BLOCKED': return 'bg-orange-900 text-orange-300 border-orange-700';
    case 'ASSIGNED': return 'bg-violet-900 text-violet-300 border-violet-700';
    case 'UPDATED': return 'bg-yellow-900 text-yellow-300 border-yellow-700';
    default: return 'bg-gray-800 text-gray-300 border-gray-600';
  }
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return timestamp;
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return timestamp;
  }
}

export { parseEvent };
export type { ActivityEvent };

export default function ActivityFeed({ events }: ActivityFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-gray-500 gap-2">
        <div className="flex gap-1.5" aria-hidden="true">
          <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <p className="text-sm">Waiting for activity events...</p>
        <p className="text-xs">Connects to live SSE stream from backend</p>
      </div>
    );
  }

  return (
    <div
      className="h-80 overflow-y-auto space-y-1 pr-1 scroll-smooth"
      role="log"
      aria-live="polite"
      aria-label="Activity feed"
    >
      {events.map((event) => (
        <div
          key={event.id}
          className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-gray-800 transition-colors duration-100"
        >
          {/* Timestamp */}
          <time
            className="text-xs text-gray-500 font-mono flex-shrink-0 mt-0.5 w-20"
            dateTime={event.timestamp}
          >
            {formatTime(event.timestamp)}
          </time>

          {/* Agent avatar */}
          <div
            className="w-5 h-5 rounded-full bg-violet-800 flex items-center justify-center text-violet-200 text-xs flex-shrink-0 mt-0.5"
            aria-hidden="true"
          >
            {event.agent?.charAt(0)?.toUpperCase() ?? '?'}
          </div>

          {/* Agent name */}
          <span className="text-xs font-semibold text-gray-300 flex-shrink-0 mt-0.5 w-28 truncate">
            {event.agent}
          </span>

          {/* Action badge */}
          <span className={`text-xs font-mono border px-1.5 py-0.5 rounded flex-shrink-0 ${actionBadge(event.action)}`}>
            {event.action}
          </span>

          {/* Detail */}
          {event.detail && (
            <span className="text-xs text-gray-400 flex-1 truncate mt-0.5">{event.detail}</span>
          )}
        </div>
      ))}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
