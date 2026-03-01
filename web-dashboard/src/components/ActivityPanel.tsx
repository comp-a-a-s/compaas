import { useState, useEffect, useRef, useMemo } from 'react';
import type { ActivityEvent } from '../types';
import FloatingSelect from './ui/FloatingSelect';

interface ActivityPanelProps {
  events: ActivityEvent[];
}

// ---- Helpers ----
function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = (action || '').toUpperCase();
  if (a.includes('DELEGATED') || a.includes('DELEGATE')) return { bg: '#1c2233', text: 'var(--tf-accent)' };
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (a.includes('COMPLETED') || a.includes('DONE') || a.includes('FINISH')) return { bg: '#1a2e25', text: 'var(--tf-success)' };
  if (a.includes('BLOCKED') || a.includes('ERROR') || a.includes('FAIL')) return { bg: '#2d1519', text: 'var(--tf-error)' };
  if (a.includes('WARNING') || a.includes('WARN')) return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (a.includes('ASSIGNED') || a.includes('ASSIGN')) return { bg: '#1c2233', text: 'var(--tf-accent)' };
  if (a.includes('UPDATED') || a.includes('UPDATE')) return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (a.includes('CREATED') || a.includes('CREATE')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (a.includes('MESSAGE')) return { bg: '#1f2f3f', text: 'var(--tf-accent)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)' };
}

const ACTION_TYPES = ['ALL', 'DELEGATED', 'STARTED', 'COMPLETED', 'BLOCKED', 'ASSIGNED', 'UPDATED', 'CREATED', 'MESSAGE', 'WARNING', 'ERROR'];
const PAGE_SIZE_OPTIONS = [
  { value: '50', label: '50 / page', description: 'Show 50 events per page.' },
  { value: '100', label: '100 / page', description: 'Show 100 events per page.' },
  { value: '200', label: '200 / page', description: 'Show 200 events per page.' },
];

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

function eventDetailText(event: ActivityEvent): string {
  const base = (event.detail || '').trim();
  const metadata = event.metadata || {};
  const command = typeof metadata.command === 'string' ? metadata.command : '';
  const filePath = typeof metadata.file_path === 'string' ? metadata.file_path : '';
  const workspacePath = typeof metadata.workspace_path === 'string' ? metadata.workspace_path : '';
  const extras = [command, filePath, workspacePath].filter(Boolean).join(' | ');
  if (base && extras) return `${base} (${extras})`;
  if (base) return base;
  if (extras) return extras;
  return '(no detail)';
}

function taskLabel(event: ActivityEvent): string {
  const metadata = event.metadata || {};
  const explicit = typeof metadata.task === 'string' ? metadata.task.trim() : '';
  if (explicit) return explicit;
  const detail = (event.detail || '').trim();
  const commandMatch = detail.match(/running:\s*(.+)$/i);
  if (commandMatch?.[1]) return commandMatch[1].trim().slice(0, 140);
  const delegationMatch = detail.match(/delegating to\s+([a-z0-9\- ]+):?\s*(.*)$/i);
  if (delegationMatch) {
    const delegatedTask = delegationMatch[2]?.trim();
    if (delegatedTask) return delegatedTask.slice(0, 140);
  }
  return detail.slice(0, 140);
}

function extraSummaryRows(event: ActivityEvent): string[] {
  const metadata = event.metadata || {};
  const rows: string[] = [];
  const command = typeof metadata.command === 'string' ? metadata.command.trim() : '';
  const filePath = typeof metadata.file_path === 'string' ? metadata.file_path.trim() : '';
  const workspacePath = typeof metadata.workspace_path === 'string' ? metadata.workspace_path.trim() : '';
  const provider = typeof metadata.provider === 'string' ? metadata.provider.trim() : '';
  const mode = typeof metadata.mode === 'string' ? metadata.mode.trim() : '';
  const model = typeof metadata.model === 'string' ? metadata.model.trim() : '';
  const exitCode = typeof metadata.exit_code === 'number' ? metadata.exit_code : null;
  if (provider || mode || model) {
    const runtimeBits = [provider, mode].filter(Boolean).join('/');
    rows.push(`Runtime: ${runtimeBits || 'unknown'}${model ? ` · ${model}` : ''}`);
  }
  if (command) rows.push(`Command: ${command}`);
  if (filePath) rows.push(`File: ${filePath}`);
  if (workspacePath) rows.push(`Workspace: ${workspacePath}`);
  if (exitCode !== null) rows.push(`Exit: ${exitCode}`);
  return rows.slice(0, 4);
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
/** Derive the primary display agent from delegation metadata.
 *  When the CEO delegates, we want to show the WORKING agent, not just "ceo". */
function deriveDisplayAgent(event: ActivityEvent): {
  displayName: string;
  delegationTag: string;
} {
  const metadata = event.metadata || {};
  const source = typeof metadata.source_agent === 'string' ? metadata.source_agent.trim() : '';
  const target = typeof metadata.target_agent === 'string' ? metadata.target_agent.trim() : '';
  const flow = typeof metadata.flow === 'string' ? metadata.flow.trim().toLowerCase() : '';
  const action = (event.action || '').toUpperCase();

  // Delegation down: CEO -> agent. Show the target agent as primary.
  if (flow === 'down' && target && target !== 'ceo' && (action.includes('DELEGATED') || action.includes('STARTED'))) {
    return { displayName: target, delegationTag: 'delegated by CEO' };
  }
  // Result flowing up: agent -> CEO. Show the source agent as primary.
  if (flow === 'up' && source && source !== 'ceo' && (action.includes('COMPLETED') || action.includes('UPDATED'))) {
    return { displayName: source, delegationTag: 'reported to CEO' };
  }
  // Agent doing their own work
  if (event.agent && event.agent !== 'ceo' && event.agent !== 'system') {
    return { displayName: event.agent, delegationTag: '' };
  }
  return { displayName: event.agent || 'System', delegationTag: '' };
}

function EventBubble({ event, index }: EventBubbleProps) {
  const badge = actionBadgeStyle(event.action);
  const { displayName, delegationTag } = deriveDisplayAgent(event);
  const initial = displayName.charAt(0).toUpperCase();
  const color = agentAvatarColor(displayName);
  const task = taskLabel(event);
  const extraRows = extraSummaryRows(event);

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
            {displayName}
          </span>
          {delegationTag && (
            <span
              className="text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0"
              style={{ backgroundColor: 'rgba(63,185,80,0.1)', color: 'var(--tf-success)', fontSize: '10px' }}
            >
              {delegationTag}
            </span>
          )}
          {event.project_id && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
              style={{ backgroundColor: 'var(--tf-surface)', color: 'var(--tf-accent-blue)', border: '1px solid var(--tf-border)' }}
            >
              {event.project_id}
            </span>
          )}
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
          <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)', marginBottom: '4px' }}>
            {task || '(no detail)'}
          </p>
          <div className="space-y-1">
            {extraRows.map((row) => (
              <p key={row} className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                {row}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Audit log entry ----
function AuditEntry({ event, index }: { event: ActivityEvent; index: number }) {
  const badge = actionBadgeStyle(event.action);
  const { displayName } = deriveDisplayAgent(event);
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
      <span style={{ color: 'var(--tf-accent)', flexShrink: 0, width: '90px' }}>{displayName}</span>
      <span style={{ color: 'var(--tf-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {event.project_id ? `[${event.project_id}] ` : ''}{eventDetailText(event)}
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
  const [livePageSize, setLivePageSize] = useState<number>(50);
  const [auditPageSize, setAuditPageSize] = useState<number>(50);
  const [livePage, setLivePage] = useState<number>(1);
  const [auditPage, setAuditPage] = useState<number>(1);
  const feedRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (livePage !== 1) return;
    const feed = feedRef.current;
    if (!feed) return;
    const distanceToBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    if (distanceToBottom <= 120) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [events.length, livePage]);

  // Build unique agent list for filter — include delegation metadata agents
  const agentNames = useMemo(() => {
    const names = new Set<string>();
    for (const e of events) {
      if (e.agent) names.add(e.agent);
      const meta = e.metadata || {};
      if (typeof meta.source_agent === 'string' && meta.source_agent) names.add(meta.source_agent);
      if (typeof meta.target_agent === 'string' && meta.target_agent) names.add(meta.target_agent);
    }
    return Array.from(names).sort();
  }, [events]);

  const agentOptions = useMemo(
    () => [
      { value: '', label: 'All Agents', description: 'Show events from the entire organization.' },
      ...agentNames.map((name) => ({ value: name, label: name })),
    ],
    [agentNames],
  );

  // Filter events — also match delegation metadata agents
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      let agentMatch = !agentFilter;
      if (agentFilter) {
        const meta = e.metadata || {};
        agentMatch =
          e.agent === agentFilter ||
          meta.source_agent === agentFilter ||
          meta.target_agent === agentFilter;
      }
      const actionMatch =
        actionFilter === 'ALL' ||
        (e.action || '').toUpperCase().includes(actionFilter);
      return agentMatch && actionMatch;
    });
  }, [events, agentFilter, actionFilter]);

  const livePageCount = Math.max(1, Math.ceil(filteredEvents.length / livePageSize));
  const normalizedLivePage = Math.min(livePage, livePageCount);
  const liveSliceEnd = Math.max(0, filteredEvents.length - ((normalizedLivePage - 1) * livePageSize));
  const liveSliceStart = Math.max(0, liveSliceEnd - livePageSize);
  const pagedLiveEvents = filteredEvents.slice(liveSliceStart, liveSliceEnd);

  // Audit log derived state
  const auditEvents = useMemo(() => {
    const all = [...events].reverse(); // newest first
    if (!auditSearch.trim()) return all;
    const q = auditSearch.toLowerCase();
    return all.filter((e) =>
      (e.agent || '').toLowerCase().includes(q) ||
      (e.action || '').toLowerCase().includes(q) ||
      (e.detail || '').toLowerCase().includes(q) ||
      JSON.stringify(e.metadata || {}).toLowerCase().includes(q)
    );
  }, [events, auditSearch]);

  const auditPageCount = Math.max(1, Math.ceil(auditEvents.length / auditPageSize));
  const normalizedAuditPage = Math.min(auditPage, auditPageCount);
  const auditSliceStart = (normalizedAuditPage - 1) * auditPageSize;
  const auditSliceEnd = auditSliceStart + auditPageSize;
  const pagedAuditEvents = auditEvents.slice(auditSliceStart, auditSliceEnd);

  useEffect(() => {
    setLivePage(1);
  }, [agentFilter, actionFilter, livePageSize]);

  useEffect(() => {
    setAuditPage(1);
  }, [auditSearch, auditPageSize]);

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
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <FloatingSelect
              value={String(auditPageSize)}
              options={PAGE_SIZE_OPTIONS}
              onChange={(value) => setAuditPageSize(Number(value))}
              ariaLabel="Audit page size"
              size="sm"
              variant="input"
              style={{ width: '125px' }}
            />
            <span className="text-xs ml-auto" style={{ color: 'var(--tf-text-muted)' }}>
              Page {normalizedAuditPage} / {auditPageCount}
            </span>
            <button
              type="button"
              onClick={() => setAuditPage((prev) => Math.max(1, prev - 1))}
              disabled={normalizedAuditPage <= 1}
              className="text-xs px-2 py-1 rounded-md"
              style={{
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-surface)',
                color: normalizedAuditPage <= 1 ? 'var(--tf-text-muted)' : 'var(--tf-text)',
                opacity: normalizedAuditPage <= 1 ? 0.6 : 1,
                cursor: normalizedAuditPage <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              Newer
            </button>
            <button
              type="button"
              onClick={() => setAuditPage((prev) => Math.min(auditPageCount, prev + 1))}
              disabled={normalizedAuditPage >= auditPageCount}
              className="text-xs px-2 py-1 rounded-md"
              style={{
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-surface)',
                color: normalizedAuditPage >= auditPageCount ? 'var(--tf-text-muted)' : 'var(--tf-text)',
                opacity: normalizedAuditPage >= auditPageCount ? 0.6 : 1,
                cursor: normalizedAuditPage >= auditPageCount ? 'not-allowed' : 'pointer',
              }}
            >
              Older
            </button>
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
              : pagedAuditEvents.map((e, i) => <AuditEntry key={`${e.timestamp}-${i}`} event={e} index={i} />)
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
            className="text-xs font-medium"
            style={{ color: 'var(--tf-text-muted)' }}
          >
            Agent
          </label>
          <FloatingSelect
            value={agentFilter}
            options={agentOptions}
            onChange={setAgentFilter}
            searchable
            ariaLabel="Agent filter"
            size="sm"
            variant="input"
            style={{ width: '210px' }}
          />
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

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <FloatingSelect
          value={String(livePageSize)}
          options={PAGE_SIZE_OPTIONS}
          onChange={(value) => setLivePageSize(Number(value))}
          ariaLabel="Live feed page size"
          size="sm"
          variant="input"
          style={{ width: '125px' }}
        />
        <span className="text-xs ml-auto" style={{ color: 'var(--tf-text-muted)' }}>
          Page {normalizedLivePage} / {livePageCount}
        </span>
        <button
          type="button"
          onClick={() => setLivePage((prev) => Math.max(1, prev - 1))}
          disabled={normalizedLivePage <= 1}
          className="text-xs px-2 py-1 rounded-md"
          style={{
            border: '1px solid var(--tf-border)',
            backgroundColor: 'var(--tf-surface)',
            color: normalizedLivePage <= 1 ? 'var(--tf-text-muted)' : 'var(--tf-text)',
            opacity: normalizedLivePage <= 1 ? 0.6 : 1,
            cursor: normalizedLivePage <= 1 ? 'not-allowed' : 'pointer',
          }}
        >
          Newer
        </button>
        <button
          type="button"
          onClick={() => setLivePage((prev) => Math.min(livePageCount, prev + 1))}
          disabled={normalizedLivePage >= livePageCount}
          className="text-xs px-2 py-1 rounded-md"
          style={{
            border: '1px solid var(--tf-border)',
            backgroundColor: 'var(--tf-surface)',
            color: normalizedLivePage >= livePageCount ? 'var(--tf-text-muted)' : 'var(--tf-text)',
            opacity: normalizedLivePage >= livePageCount ? 0.6 : 1,
            cursor: normalizedLivePage >= livePageCount ? 'not-allowed' : 'pointer',
          }}
        >
          Older
        </button>
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
            {pagedLiveEvents.map((event, i) => (
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
