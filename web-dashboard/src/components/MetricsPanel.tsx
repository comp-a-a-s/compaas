import { useState, useMemo, useCallback } from 'react';
import type { ActivityEvent } from '../types';
import FloatingSelect from './ui/FloatingSelect';

interface EventLogPanelProps {
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

function formatTimestamp(ts: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return `${date} ${time}`;
  } catch {
    return ts;
  }
}

const ACTION_TYPES = [
  'ALL',
  'DELEGATED',
  'STARTED',
  'COMPLETED',
  'BLOCKED',
  'ASSIGNED',
  'UPDATED',
  'CREATED',
  'MESSAGE',
  'WARNING',
  'ERROR',
];

function escapeCSVField(value: string): string {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function exportToCSV(events: ActivityEvent[]): void {
  const headers = [
    'Timestamp',
    'Agent',
    'Display Agent',
    'Action',
    'Detail',
    'Project',
    'Source Agent',
    'Target Agent',
    'Flow',
    'Event Kind',
    'State',
    'Task',
    'Command',
    'File Path',
  ];

  const rows = events.map((e) => {
    const { displayName } = deriveDisplayAgent(e);
    const meta = e.metadata || {};
    return [
      formatTimestamp(e.timestamp),
      e.agent || '',
      displayName,
      e.action || '',
      e.detail || '',
      e.project_id || '',
      typeof meta.source_agent === 'string' ? meta.source_agent : '',
      typeof meta.target_agent === 'string' ? meta.target_agent : '',
      typeof meta.flow === 'string' ? meta.flow : '',
      typeof meta.event_kind === 'string' ? meta.event_kind : '',
      typeof meta.state === 'string' ? meta.state : '',
      typeof meta.task === 'string' ? meta.task : '',
      typeof meta.command === 'string' ? meta.command : '',
      typeof meta.file_path === 'string' ? meta.file_path : '',
    ].map(escapeCSVField);
  });

  const csvContent = [headers.map(escapeCSVField).join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `event-log-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ---- Column widths ----
const COL_WIDTHS = {
  timestamp: '160px',
  agent: '130px',
  action: '110px',
  detail: 'auto',
  project: '110px',
};

// ---- Table row ----
interface EventRowProps {
  event: ActivityEvent;
  index: number;
}

function EventRow({ event, index }: EventRowProps) {
  const badge = actionBadgeStyle(event.action);
  const { displayName, delegationTag } = deriveDisplayAgent(event);

  return (
    <tr
      style={{
        borderBottom: '1px solid var(--tf-surface-raised)',
        backgroundColor: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
        fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", monospace',
      }}
    >
      {/* Timestamp */}
      <td
        style={{
          padding: '8px 10px',
          fontSize: '11px',
          color: 'var(--tf-text-muted)',
          whiteSpace: 'nowrap',
          verticalAlign: 'middle',
          width: COL_WIDTHS.timestamp,
          minWidth: COL_WIDTHS.timestamp,
        }}
      >
        {formatTimestamp(event.timestamp)}
      </td>

      {/* Agent */}
      <td
        style={{
          padding: '8px 10px',
          fontSize: '11px',
          verticalAlign: 'middle',
          width: COL_WIDTHS.agent,
          minWidth: COL_WIDTHS.agent,
        }}
      >
        <span style={{ color: 'var(--tf-accent)', fontWeight: 600 }}>{displayName}</span>
        {delegationTag && (
          <span
            style={{
              display: 'block',
              fontSize: '10px',
              color: 'var(--tf-success)',
              marginTop: '2px',
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            }}
          >
            {delegationTag}
          </span>
        )}
      </td>

      {/* Action */}
      <td
        style={{
          padding: '8px 10px',
          verticalAlign: 'middle',
          width: COL_WIDTHS.action,
          minWidth: COL_WIDTHS.action,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            fontSize: '10px',
            fontWeight: 700,
            padding: '2px 7px',
            borderRadius: '4px',
            backgroundColor: badge.bg,
            color: badge.text,
            whiteSpace: 'nowrap',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          }}
          role="status"
        >
          {event.action}
        </span>
      </td>

      {/* Detail */}
      <td
        style={{
          padding: '8px 10px',
          fontSize: '11px',
          color: 'var(--tf-text-secondary)',
          verticalAlign: 'middle',
          maxWidth: '0',
          width: COL_WIDTHS.detail,
        }}
      >
        <span
          style={{
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={event.detail || ''}
        >
          {event.detail || <span style={{ color: 'var(--tf-text-muted)', fontStyle: 'italic' }}>(no detail)</span>}
        </span>
      </td>

      {/* Project */}
      <td
        style={{
          padding: '8px 10px',
          verticalAlign: 'middle',
          width: COL_WIDTHS.project,
          minWidth: COL_WIDTHS.project,
        }}
      >
        {event.project_id ? (
          <span
            style={{
              display: 'inline-block',
              fontSize: '10px',
              padding: '2px 7px',
              borderRadius: '4px',
              backgroundColor: 'var(--tf-surface)',
              color: 'var(--tf-accent-blue)',
              border: '1px solid var(--tf-border)',
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '100px',
            }}
            title={event.project_id}
          >
            {event.project_id}
          </span>
        ) : (
          <span style={{ fontSize: '11px', color: 'var(--tf-surface-raised)' }}>—</span>
        )}
      </td>
    </tr>
  );
}

// ---- Empty state ----
function EmptyState() {
  return (
    <tr>
      <td
        colSpan={5}
        style={{ padding: '48px 24px', textAlign: 'center' }}
      >
        <p style={{ fontSize: '13px', color: 'var(--tf-text-muted)', margin: 0 }}>
          No events match the current filters.
        </p>
        <p style={{ fontSize: '11px', color: 'var(--tf-border)', margin: '6px 0 0' }}>
          Try adjusting the search or filter criteria.
        </p>
      </td>
    </tr>
  );
}

// ---- Main EventLogPanel ----
export default function EventLogPanel({ events }: EventLogPanelProps) {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('ALL');

  // Build unique agent list — include delegation metadata agents
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
      { value: '', label: 'All Agents', description: 'Show events from all agents.' },
      ...agentNames.map((name) => ({ value: name, label: name })),
    ],
    [agentNames],
  );

  // Filtered + sorted events (newest first)
  const filteredEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...events]
      .reverse()
      .filter((e) => {
        // Agent filter — match event agent or delegation metadata agents
        if (agentFilter) {
          const meta = e.metadata || {};
          const agentMatch =
            e.agent === agentFilter ||
            meta.source_agent === agentFilter ||
            meta.target_agent === agentFilter;
          if (!agentMatch) return false;
        }

        // Action type filter
        if (actionFilter !== 'ALL') {
          if (!(e.action || '').toUpperCase().includes(actionFilter)) return false;
        }

        // Text search across all visible fields + metadata
        if (q) {
          const haystack = [
            e.timestamp,
            e.agent,
            e.action,
            e.detail,
            e.project_id || '',
            JSON.stringify(e.metadata || {}),
          ]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }

        return true;
      });
  }, [events, search, agentFilter, actionFilter]);

  const handleExport = useCallback(() => {
    exportToCSV(filteredEvents);
  }, [filteredEvents]);

  return (
    <section
      className="animate-fade-in"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
      aria-label="Event log"
    >
      {/* ---- Header bar ---- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '12px',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h2
            style={{
              fontSize: '13px',
              fontWeight: 700,
              color: 'var(--tf-text)',
              margin: 0,
              letterSpacing: '0.02em',
            }}
          >
            Event Log
          </h2>
          <span
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '99px',
              backgroundColor: 'var(--tf-surface-raised)',
              color: 'var(--tf-text-muted)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {filteredEvents.length}
            {filteredEvents.length !== events.length && (
              <> of {events.length}</>
            )}
            {' '}
            {filteredEvents.length === 1 ? 'event' : 'events'}
          </span>
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={filteredEvents.length === 0}
          style={{
            fontSize: '11px',
            padding: '4px 12px',
            borderRadius: '99px',
            border: '1px solid var(--tf-border)',
            backgroundColor: 'var(--tf-surface)',
            color: filteredEvents.length === 0 ? 'var(--tf-text-muted)' : 'var(--tf-text)',
            cursor: filteredEvents.length === 0 ? 'not-allowed' : 'pointer',
            fontWeight: 500,
            transition: 'background-color 150ms, color 150ms',
            opacity: filteredEvents.length === 0 ? 0.5 : 1,
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
          }}
          aria-label={`Export ${filteredEvents.length} filtered events as CSV`}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* ---- Filter bar ---- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '12px',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        {/* Text search */}
        <div
          role="search"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 10px',
            borderRadius: '8px',
            backgroundColor: 'var(--tf-surface)',
            border: '1px solid var(--tf-border)',
            flex: '1 1 200px',
            minWidth: '160px',
            maxWidth: '320px',
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--tf-text-muted)', flexShrink: 0 }}
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <label htmlFor="event-log-search" className="sr-only">
            Search events
          </label>
          <input
            id="event-log-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events..."
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              fontSize: '12px',
              color: 'var(--tf-text)',
            }}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--tf-text-muted)',
                fontSize: '11px',
                padding: '0',
                lineHeight: 1,
              }}
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </div>

        {/* Agent dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label
            htmlFor="agent-filter-trigger"
            style={{ fontSize: '11px', color: 'var(--tf-text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            Agent
          </label>
          <FloatingSelect
            value={agentFilter}
            options={agentOptions}
            onChange={setAgentFilter}
            searchable
            ariaLabel="Filter by agent"
            size="sm"
            variant="input"
            style={{ width: '190px' }}
          />
        </div>

        {/* Action type pills */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}
          role="group"
          aria-label="Filter by action type"
        >
          <span style={{ fontSize: '11px', color: 'var(--tf-text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
            Action
          </span>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {ACTION_TYPES.map((type) => {
              const active = actionFilter === type;
              const badge = type !== 'ALL' ? actionBadgeStyle(type) : null;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setActionFilter(type)}
                  aria-pressed={active}
                  style={{
                    fontSize: '10px',
                    padding: '3px 9px',
                    borderRadius: '99px',
                    border: active
                      ? `1px solid ${badge ? badge.text : 'var(--tf-text)'}`
                      : '1px solid var(--tf-border)',
                    backgroundColor: active
                      ? badge ? badge.bg : 'var(--tf-surface-raised)'
                      : 'var(--tf-bg)',
                    color: active
                      ? badge ? badge.text : 'var(--tf-text)'
                      : 'var(--tf-text-muted)',
                    cursor: 'pointer',
                    fontWeight: active ? 700 : 500,
                    transition: 'background-color 150ms, color 150ms, border-color 150ms',
                    outline: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {type}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ---- Table ---- */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          borderRadius: '12px',
          border: '1px solid var(--tf-border)',
          backgroundColor: 'var(--tf-surface)',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
          }}
          aria-label="Event log table"
        >
          <colgroup>
            <col style={{ width: COL_WIDTHS.timestamp }} />
            <col style={{ width: COL_WIDTHS.agent }} />
            <col style={{ width: COL_WIDTHS.action }} />
            <col />
            <col style={{ width: COL_WIDTHS.project }} />
          </colgroup>

          {/* Sticky header */}
          <thead>
            <tr
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                backgroundColor: 'var(--tf-surface)',
                borderBottom: '1px solid var(--tf-border)',
              }}
            >
              {[
                { key: 'timestamp', label: 'Timestamp', width: COL_WIDTHS.timestamp },
                { key: 'agent', label: 'Agent', width: COL_WIDTHS.agent },
                { key: 'action', label: 'Action', width: COL_WIDTHS.action },
                { key: 'detail', label: 'Detail', width: COL_WIDTHS.detail },
                { key: 'project', label: 'Project', width: COL_WIDTHS.project },
              ].map(({ key, label }) => (
                <th
                  key={key}
                  scope="col"
                  style={{
                    padding: '9px 10px',
                    textAlign: 'left',
                    fontSize: '10px',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--tf-text-muted)',
                    fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", monospace',
                    whiteSpace: 'nowrap',
                    userSelect: 'none',
                  }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {filteredEvents.length === 0 ? (
              <EmptyState />
            ) : (
              filteredEvents.map((event, i) => (
                <EventRow
                  key={`${event.timestamp}-${event.agent}-${i}`}
                  event={event}
                  index={i}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
