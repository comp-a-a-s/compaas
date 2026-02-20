import { useState, useEffect } from 'react';
import { fetchAgentDetail } from '../api/client';
import type { Agent, ActivityEvent, TaskWithProject } from '../types';

interface AgentPanelProps {
  agents: Agent[];
  loading: boolean;
  microProjectMode?: boolean;
}

// ---- Helpers ----
function modelBadge(model: string): { bg: string; text: string; label: string } {
  const m = model.toLowerCase();
  if (m.includes('opus')) return { bg: '#1c2233', text: 'var(--tf-accent)', label: 'Opus' };
  if (m.includes('sonnet')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)', label: 'Sonnet' };
  if (m.includes('haiku')) return { bg: '#1a2e25', text: 'var(--tf-success)', label: 'Haiku' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)', label: model };
}

function avatarColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'var(--tf-accent)';
  if (m.includes('sonnet')) return 'var(--tf-accent-blue)';
  if (m.includes('haiku')) return 'var(--tf-success)';
  return 'var(--tf-text-secondary)';
}

function statusStyle(status: string): { dot: string; label: string } {
  const s = status.toLowerCase();
  if (s === 'permanent' || s === 'active') return { dot: 'var(--tf-success)', label: 'Active' };
  if (s === 'available') return { dot: 'var(--tf-warning)', label: 'Available' };
  if (s === 'on_demand') return { dot: 'var(--tf-accent-blue)', label: 'On-demand' };
  if (s === 'busy') return { dot: 'var(--tf-warning)', label: 'Busy' };
  return { dot: 'var(--tf-text-muted)', label: status };
}

function priorityBadge(priority: string): { bg: string; text: string } {
  const p = priority.toUpperCase();
  if (p === 'P0') return { bg: '#2d1519', text: 'var(--tf-error)' };
  if (p === 'P1') return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (p === 'P2') return { bg: '#2d2213', text: 'var(--tf-warning)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-muted)' };
}

function taskStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return 'var(--tf-success)';
  if (s === 'in_progress' || s === 'in progress') return 'var(--tf-accent-blue)';
  if (s === 'blocked') return 'var(--tf-error)';
  if (s === 'review') return 'var(--tf-accent)';
  return 'var(--tf-text-secondary)';
}

function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = action.toUpperCase();
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (a.includes('COMPLETED') || a.includes('DONE')) return { bg: '#1a2e25', text: 'var(--tf-success)' };
  if (a.includes('BLOCKED') || a.includes('ERROR')) return { bg: '#2d1519', text: 'var(--tf-error)' };
  if (a.includes('ASSIGNED')) return { bg: '#1c2233', text: 'var(--tf-accent)' };
  if (a.includes('UPDATED')) return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (a.includes('CREATED')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)' };
}

// ---- Skeleton ----
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} />;
}

// ---- Agent card ----
interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}
function AgentCard({ agent, selected, onSelect, disabled = false }: AgentCardProps) {
  const badge = modelBadge(agent.model);
  const color = avatarColor(agent.model);
  const status = statusStyle(agent.status);
  const initial = agent.name.charAt(0).toUpperCase();

  return (
    <button
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className="w-full text-left rounded-xl p-4 flex flex-col gap-3 transition-all duration-200 cursor-pointer"
      style={{
        backgroundColor: selected ? 'var(--tf-surface-raised)' : 'var(--tf-surface)',
        border: `1px solid ${selected ? 'var(--tf-accent)' : 'var(--tf-border)'}`,
        opacity: disabled ? 0.48 : 1,
        filter: disabled ? 'grayscale(35%)' : 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected && !disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#6e7681';
        }
      }}
      onMouseLeave={(e) => {
        if (!selected && !disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-border)';
        }
      }}
    >
      {/* Avatar + status */}
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ backgroundColor: color, color: 'var(--tf-bg)' }}
        >
          {initial}
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: status.dot }}
            aria-hidden="true"
          />
          <span className="text-xs" style={{ color: status.dot }}>
            {status.label}
          </span>
        </div>
      </div>

      {/* Name + role */}
      <div>
        <p className="text-sm font-semibold leading-tight" style={{ color: 'var(--tf-text)' }}>
          {agent.name}
        </p>
        <p className="text-xs mt-0.5 leading-tight" style={{ color: 'var(--tf-text-secondary)' }}>
          {agent.role}
        </p>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5">
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ backgroundColor: badge.bg, color: badge.text }}
        >
          {badge.label}
        </span>
        {agent.team && (
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)' }}
          >
            {agent.team}
          </span>
        )}
        {disabled && (
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ backgroundColor: 'rgba(240,170,74,0.15)', color: 'var(--tf-warning)', border: '1px solid rgba(240,170,74,0.45)' }}
          >
            Paused in Micro mode
          </span>
        )}
      </div>
    </button>
  );
}

// ---- Detail panel ----
interface DetailPanelProps {
  agent: Agent;
  onClose: () => void;
}
function DetailPanel({ agent, onClose }: DetailPanelProps) {
  const badge = modelBadge(agent.model);
  const color = avatarColor(agent.model);
  const status = statusStyle(agent.status);
  const initial = agent.name.charAt(0).toUpperCase();

  // Parse tools from comma-separated string
  const tools: string[] = agent.tools
    ? agent.tools.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const assignedTasks: TaskWithProject[] = agent.assigned_tasks ?? [];
  const recentActivity: ActivityEvent[] = agent.recent_activity ?? [];

  return (
    <div
      className="rounded-xl flex flex-col h-full animate-slide-in-right overflow-hidden"
      style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 flex items-start justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-base font-bold flex-shrink-0"
            style={{ backgroundColor: color, color: 'var(--tf-bg)' }}
          >
            {initial}
          </div>
          <div>
            <h3 className="text-sm font-bold" style={{ color: 'var(--tf-text)' }}>
              {agent.name}
            </h3>
            <p className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
              {agent.role}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={{ backgroundColor: badge.bg, color: badge.text }}
              >
                {badge.label}
              </span>
              <span className="flex items-center gap-1 text-xs" style={{ color: status.dot }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: status.dot }} />
                {status.label}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
          style={{ color: 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
          aria-label="Close detail panel"
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

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Description */}
        {agent.description && (
          <section aria-label="Agent description">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
              Description
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
              {agent.description}
            </p>
          </section>
        )}

        {/* Model info */}
        <section aria-label="Model info">
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Model
          </h4>
          <p className="text-xs" style={{ color: 'var(--tf-text)' }}>
            {agent.model}
          </p>
        </section>

        {/* Expertise */}
        {agent.expertise && (
          <section aria-label="Agent expertise">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
              Expertise
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
              {agent.expertise}
            </p>
          </section>
        )}

        {/* Tools */}
        {tools.length > 0 && (
          <section aria-label="Agent tools">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
              Tools
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((tool) => (
                <span
                  key={tool}
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-accent-blue)', border: '1px solid var(--tf-border)' }}
                >
                  {tool}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Assigned Tasks */}
        <section aria-label="Assigned tasks">
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Assigned Tasks ({assignedTasks.length})
          </h4>
          {assignedTasks.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              No tasks assigned
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: 'var(--tf-text-muted)' }}>
                      Task
                    </th>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: 'var(--tf-text-muted)' }}>
                      Project
                    </th>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: 'var(--tf-text-muted)' }}>
                      Priority
                    </th>
                    <th className="text-left py-1.5 font-medium" style={{ color: 'var(--tf-text-muted)' }}>
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {assignedTasks.map((task) => {
                    const pri = priorityBadge(task.priority);
                    const statusColor = taskStatusColor(task.status);
                    return (
                      <tr key={task.id} style={{ borderBottom: '1px solid var(--tf-bg)' }}>
                        <td className="py-1.5 pr-3" style={{ color: 'var(--tf-text)', maxWidth: '140px' }}>
                          <span className="truncate block">{task.title}</span>
                        </td>
                        <td className="py-1.5 pr-3" style={{ color: 'var(--tf-text-secondary)' }}>
                          {task.project_name}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span
                            className="px-1.5 py-0.5 rounded-full font-medium"
                            style={{ backgroundColor: pri.bg, color: pri.text }}
                          >
                            {task.priority}
                          </span>
                        </td>
                        <td className="py-1.5">
                          <span style={{ color: statusColor }}>{task.status}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Activity timeline */}
        <section aria-label="Recent activity">
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--tf-text-muted)' }}>
            Recent Activity ({recentActivity.length})
          </h4>
          {recentActivity.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              No recent activity
            </p>
          ) : (
            <div className="space-y-2">
              {recentActivity.map((evt, i) => {
                const badge2 = actionBadgeStyle(evt.action);
                return (
                  <div
                    key={i}
                    className="flex gap-3 rounded-lg px-3 py-2.5"
                    style={{ backgroundColor: 'var(--tf-surface-raised)' }}
                  >
                    <div className="flex flex-col items-center">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap"
                        style={{ backgroundColor: badge2.bg, color: badge2.text }}
                      >
                        {evt.action}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
                        {evt.detail}
                      </p>
                      {evt.timestamp && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--tf-text-muted)' }}>
                          {new Date(evt.timestamp).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ---- Main AgentPanel ----
export default function AgentPanel({ agents, loading, microProjectMode = false }: AgentPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailedAgent, setDetailedAgent] = useState<Agent | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Fetch full detail when an agent is selected
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetchAgentDetail(selectedId).then((data) => {
      if (!cancelled && data) setDetailedAgent(data);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Keep selection source-of-truth on selectedId so closing always hides the panel.
  const selectedAgent = selectedId
    ? (
        detailedAgent && detailedAgent.id === selectedId
          ? detailedAgent
          : agents.find((a) => a.id === selectedId) ?? null
      )
    : null;

  // Filter agents by search query
  const filteredAgents = agents.filter((a) => {
    const q = searchQuery.toLowerCase();
    return a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q) || (a.team || '').toLowerCase().includes(q);
  });

  const isNarrowViewport = viewportWidth <= 1100;
  const isPhoneViewport = viewportWidth <= 760;

  const handleSelect = (id: string) => {
    setSelectedId((prev) => {
      const next = prev === id ? null : id;
      if (next !== prev) {
        setDetailedAgent(null);
      }
      return next;
    });
  };

  useEffect(() => {
    if (microProjectMode && selectedId && selectedId !== 'ceo') {
      setSelectedId(null);
      setDetailedAgent(null);
    }
  }, [microProjectMode, selectedId]);

  if (loading) {
    return (
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="rounded-xl p-4 space-y-3"
            style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
          >
            <Skeleton className="w-10 h-10 rounded-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm" style={{ color: 'var(--tf-text-muted)' }}>
          No agents found. Make sure the backend is running.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 h-full animate-fade-in" style={{ minHeight: 0 }}>
      {/* Search / filter input */}
      <div>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search agents by name, role, or team..."
          aria-label="Search agents"
          style={{
            width: '100%',
            maxWidth: '360px',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid var(--tf-border)',
            backgroundColor: 'var(--tf-surface)',
            color: 'var(--tf-text)',
            fontSize: '13px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--tf-accent)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--tf-border)'; }}
        />
        {microProjectMode && (
          <p className="text-xs mt-2" style={{ color: 'var(--tf-warning)' }}>
            Micro Project mode is active: only the CEO is active for fast solo execution.
          </p>
        )}
      </div>

      <div className="flex gap-5 flex-1" style={{ minHeight: 0, flexDirection: isNarrowViewport ? 'column' : 'row' }}>
        {/* Agent grid */}
        <div
          className="overflow-y-auto"
          style={{
            flex: selectedAgent && !isNarrowViewport ? '0 0 auto' : '1',
            width: selectedAgent && !isNarrowViewport ? '420px' : '100%',
            maxWidth: selectedAgent && !isNarrowViewport ? '420px' : 'none',
          }}
        >
          {filteredAgents.length === 0 && searchQuery ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--tf-text-muted)' }}>
              No agents match "{searchQuery}"
            </p>
          ) : (
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: isPhoneViewport
                  ? 'repeat(1, 1fr)'
                  : isNarrowViewport
                  ? 'repeat(2, 1fr)'
                  : selectedAgent
                  ? 'repeat(2, 1fr)'
                  : 'repeat(3, 1fr)',
              }}
            >
              {filteredAgents.map((agent) => {
                const disabled = microProjectMode && agent.id !== 'ceo';
                return (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    selected={selectedId === agent.id}
                    disabled={disabled}
                    onSelect={() => handleSelect(agent.id)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedAgent && (
          <div className="flex-1 overflow-hidden" style={{ minWidth: 0, minHeight: isNarrowViewport ? '420px' : 0 }}>
            <DetailPanel
              agent={selectedAgent}
              onClose={() => {
                setSelectedId(null);
                setDetailedAgent(null);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
