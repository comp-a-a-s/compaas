import { useState, useEffect } from 'react';
import { fetchAgentDetail } from '../api/client';
import type { Agent, ActivityEvent, TaskWithProject } from '../types';

interface AgentPanelProps {
  agents: Agent[];
  loading: boolean;
}

// ---- Helpers ----
function modelBadge(model: string): { bg: string; text: string; label: string } {
  const m = model.toLowerCase();
  if (m.includes('opus')) return { bg: '#1c2233', text: '#8b8fc7', label: 'Opus' };
  if (m.includes('sonnet')) return { bg: '#1c2940', text: '#58a6ff', label: 'Sonnet' };
  if (m.includes('haiku')) return { bg: '#1a2e25', text: '#3fb950', label: 'Haiku' };
  return { bg: '#21262d', text: '#8b949e', label: model };
}

function avatarColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return '#8b8fc7';
  if (m.includes('sonnet')) return '#58a6ff';
  if (m.includes('haiku')) return '#3fb950';
  return '#8b949e';
}

function statusStyle(status: string): { dot: string; label: string } {
  const s = status.toLowerCase();
  if (s === 'permanent' || s === 'active') return { dot: '#3fb950', label: 'Active' };
  if (s === 'available') return { dot: '#d29922', label: 'Available' };
  if (s === 'on_demand') return { dot: '#58a6ff', label: 'On-demand' };
  if (s === 'busy') return { dot: '#d29922', label: 'Busy' };
  return { dot: '#484f58', label: status };
}

function priorityBadge(priority: string): { bg: string; text: string } {
  const p = priority.toUpperCase();
  if (p === 'P0') return { bg: '#2d1519', text: '#f85149' };
  if (p === 'P1') return { bg: '#2d2213', text: '#d29922' };
  if (p === 'P2') return { bg: '#2d2213', text: '#d29922' };
  return { bg: '#21262d', text: '#484f58' };
}

function taskStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return '#3fb950';
  if (s === 'in_progress' || s === 'in progress') return '#58a6ff';
  if (s === 'blocked') return '#f85149';
  if (s === 'review') return '#8b8fc7';
  return '#8b949e';
}

function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = action.toUpperCase();
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1c2940', text: '#58a6ff' };
  if (a.includes('COMPLETED') || a.includes('DONE')) return { bg: '#1a2e25', text: '#3fb950' };
  if (a.includes('BLOCKED') || a.includes('ERROR')) return { bg: '#2d1519', text: '#f85149' };
  if (a.includes('ASSIGNED')) return { bg: '#1c2233', text: '#8b8fc7' };
  if (a.includes('UPDATED')) return { bg: '#2d2213', text: '#d29922' };
  if (a.includes('CREATED')) return { bg: '#1c2940', text: '#58a6ff' };
  return { bg: '#21262d', text: '#8b949e' };
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
}
function AgentCard({ agent, selected, onSelect }: AgentCardProps) {
  const badge = modelBadge(agent.model);
  const color = avatarColor(agent.model);
  const status = statusStyle(agent.status);
  const initial = agent.name.charAt(0).toUpperCase();

  return (
    <button
      onClick={onSelect}
      className="w-full text-left rounded-xl p-4 flex flex-col gap-3 transition-all duration-200 cursor-pointer"
      style={{
        backgroundColor: selected ? '#21262d' : '#161b22',
        border: `1px solid ${selected ? '#8b8fc7' : '#30363d'}`,
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#6e7681';
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#30363d';
        }
      }}
    >
      {/* Avatar + status */}
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ backgroundColor: color, color: '#0d1117' }}
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
        <p className="text-sm font-semibold leading-tight" style={{ color: '#e6edf3' }}>
          {agent.name}
        </p>
        <p className="text-xs mt-0.5 leading-tight" style={{ color: '#8b949e' }}>
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
            style={{ backgroundColor: '#0d1117', color: '#484f58', border: '1px solid #30363d' }}
          >
            {agent.team}
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
      style={{ backgroundColor: '#161b22', border: '1px solid #30363d' }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 flex items-start justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid #21262d' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-base font-bold flex-shrink-0"
            style={{ backgroundColor: color, color: '#0d1117' }}
          >
            {initial}
          </div>
          <div>
            <h3 className="text-sm font-bold" style={{ color: '#e6edf3' }}>
              {agent.name}
            </h3>
            <p className="text-xs" style={{ color: '#8b949e' }}>
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
          style={{ color: '#484f58', backgroundColor: 'transparent' }}
          aria-label="Close detail panel"
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

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Description */}
        {agent.description && (
          <section aria-label="Agent description">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
              Description
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: '#8b949e' }}>
              {agent.description}
            </p>
          </section>
        )}

        {/* Model info */}
        <section aria-label="Model info">
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
            Model
          </h4>
          <p className="text-xs" style={{ color: '#e6edf3' }}>
            {agent.model}
          </p>
        </section>

        {/* Expertise */}
        {agent.expertise && (
          <section aria-label="Agent expertise">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
              Expertise
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: '#8b949e' }}>
              {agent.expertise}
            </p>
          </section>
        )}

        {/* Tools */}
        {tools.length > 0 && (
          <section aria-label="Agent tools">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
              Tools
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((tool) => (
                <span
                  key={tool}
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: '#21262d', color: '#58a6ff', border: '1px solid #30363d' }}
                >
                  {tool}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Assigned Tasks */}
        <section aria-label="Assigned tasks">
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
            Assigned Tasks ({assignedTasks.length})
          </h4>
          {assignedTasks.length === 0 ? (
            <p className="text-xs" style={{ color: '#484f58' }}>
              No tasks assigned
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ borderBottom: '1px solid #21262d' }}>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: '#484f58' }}>
                      Task
                    </th>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: '#484f58' }}>
                      Project
                    </th>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: '#484f58' }}>
                      Priority
                    </th>
                    <th className="text-left py-1.5 font-medium" style={{ color: '#484f58' }}>
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {assignedTasks.map((task) => {
                    const pri = priorityBadge(task.priority);
                    const statusColor = taskStatusColor(task.status);
                    return (
                      <tr key={task.id} style={{ borderBottom: '1px solid #0d1117' }}>
                        <td className="py-1.5 pr-3" style={{ color: '#e6edf3', maxWidth: '140px' }}>
                          <span className="truncate block">{task.title}</span>
                        </td>
                        <td className="py-1.5 pr-3" style={{ color: '#8b949e' }}>
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
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#484f58' }}>
            Recent Activity ({recentActivity.length})
          </h4>
          {recentActivity.length === 0 ? (
            <p className="text-xs" style={{ color: '#484f58' }}>
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
                    style={{ backgroundColor: '#21262d' }}
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
                      <p className="text-xs leading-relaxed" style={{ color: '#8b949e' }}>
                        {evt.detail}
                      </p>
                      {evt.timestamp && (
                        <p className="text-xs mt-0.5" style={{ color: '#484f58' }}>
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
export default function AgentPanel({ agents, loading }: AgentPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailedAgent, setDetailedAgent] = useState<Agent | null>(null);

  // Fetch full detail when an agent is selected
  useEffect(() => {
    if (!selectedId) {
      setDetailedAgent(null);
      return;
    }
    let cancelled = false;
    fetchAgentDetail(selectedId).then((data) => {
      if (!cancelled && data) setDetailedAgent(data);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Use the detailed version if available, otherwise fall back to list version
  const selectedAgent = detailedAgent ?? agents.find((a) => a.id === selectedId) ?? null;

  const handleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="rounded-xl p-4 space-y-3"
            style={{ backgroundColor: '#161b22', border: '1px solid #30363d' }}
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
        <p className="text-sm" style={{ color: '#484f58' }}>
          No agents found. Make sure the backend is running.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-5 h-full animate-fade-in" style={{ minHeight: '600px' }}>
      {/* Agent grid */}
      <div
        className="overflow-y-auto"
        style={{ flex: selectedAgent ? '0 0 auto' : '1', width: selectedAgent ? '420px' : '100%' }}
      >
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: selectedAgent
              ? 'repeat(2, 1fr)'
              : 'repeat(3, 1fr)',
          }}
        >
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              selected={selectedId === agent.id}
              onSelect={() => handleSelect(agent.id)}
            />
          ))}
        </div>
      </div>

      {/* Detail panel */}
      {selectedAgent && (
        <div className="flex-1 overflow-hidden" style={{ minWidth: 0 }}>
          <DetailPanel agent={selectedAgent} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}
