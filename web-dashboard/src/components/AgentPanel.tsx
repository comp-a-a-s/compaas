import { useState, useEffect, useRef } from 'react';
import { fetchAgentDetail, updateAgent } from '../api/client';
import type { Agent, ActivityEvent, TaskWithProject } from '../types';

const AGENT_STATUSES = ['permanent', 'active', 'available', 'busy', 'inactive', 'on_demand'] as const;

interface AgentPanelProps {
  agents: Agent[];
  loading: boolean;
  onAgentUpdated?: () => void;
}

// ---- Helpers ----
function modelBadge(model: string): { bg: string; text: string; label: string } {
  const m = model.toLowerCase();
  if (m.includes('opus')) return { bg: '#2a1e3a', text: '#cba6f7', label: 'Opus' };
  if (m.includes('sonnet')) return { bg: '#1e3050', text: '#89b4fa', label: 'Sonnet' };
  if (m.includes('haiku')) return { bg: '#1a3020', text: '#a6e3a1', label: 'Haiku' };
  return { bg: '#313244', text: '#a6adc8', label: model };
}

function avatarColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return '#cba6f7';
  if (m.includes('sonnet')) return '#89b4fa';
  if (m.includes('haiku')) return '#a6e3a1';
  return '#a6adc8';
}

function statusStyle(status: string): { dot: string; label: string } {
  const s = status.toLowerCase();
  if (s === 'permanent' || s === 'active') return { dot: '#a6e3a1', label: 'Active' };
  if (s === 'available') return { dot: '#f9e2af', label: 'Available' };
  if (s === 'on_demand') return { dot: '#89b4fa', label: 'On-demand' };
  if (s === 'busy') return { dot: '#fab387', label: 'Busy' };
  return { dot: '#6c7086', label: status };
}

function priorityBadge(priority: string): { bg: string; text: string } {
  const p = priority.toUpperCase();
  if (p === 'P0') return { bg: '#3a1a1e', text: '#f38ba8' };
  if (p === 'P1') return { bg: '#3a2510', text: '#fab387' };
  if (p === 'P2') return { bg: '#3a3010', text: '#f9e2af' };
  return { bg: '#313244', text: '#6c7086' };
}

function taskStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return '#a6e3a1';
  if (s === 'in_progress' || s === 'in progress') return '#89b4fa';
  if (s === 'blocked') return '#f38ba8';
  if (s === 'review') return '#cba6f7';
  return '#a6adc8';
}

function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = action.toUpperCase();
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1e3a5f', text: '#89b4fa' };
  if (a.includes('COMPLETED') || a.includes('DONE')) return { bg: '#1a3a2a', text: '#a6e3a1' };
  if (a.includes('BLOCKED') || a.includes('ERROR')) return { bg: '#3a1a1e', text: '#f38ba8' };
  if (a.includes('ASSIGNED')) return { bg: '#2a1e3a', text: '#cba6f7' };
  if (a.includes('UPDATED')) return { bg: '#3a3010', text: '#f9e2af' };
  if (a.includes('CREATED')) return { bg: '#103a35', text: '#94e2d5' };
  return { bg: '#313244', text: '#a6adc8' };
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
        backgroundColor: selected ? '#313244' : '#181825',
        border: `1px solid ${selected ? '#cba6f7' : '#45475a'}`,
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#7f849c';
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#45475a';
        }
      }}
    >
      {/* Avatar + status */}
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ backgroundColor: color, color: '#11111b' }}
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
        <p className="text-sm font-semibold leading-tight" style={{ color: '#cdd6f4' }}>
          {agent.name}
        </p>
        <p className="text-xs mt-0.5 leading-tight" style={{ color: '#a6adc8' }}>
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
            style={{ backgroundColor: '#1e1e2e', color: '#6c7086', border: '1px solid #45475a' }}
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
  onAgentUpdated?: () => void;
}
function DetailPanel({ agent, onClose, onAgentUpdated }: DetailPanelProps) {
  const badge = modelBadge(agent.model);
  const color = avatarColor(agent.model);
  const status = statusStyle(agent.status);
  const initial = agent.name.charAt(0).toUpperCase();

  // Inline name editing
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(agent.name);
  const [savingName, setSavingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Status editing
  const [editingStatus, setEditingStatus] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  // Sync nameValue when agent changes
  useEffect(() => {
    setNameValue(agent.name);
    setEditingName(false);
    setEditingStatus(false);
  }, [agent.id, agent.name]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  const handleNameSave = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === agent.name) {
      setEditingName(false);
      setNameValue(agent.name);
      return;
    }
    setSavingName(true);
    const ok = await updateAgent(agent.id, { name: trimmed });
    setSavingName(false);
    if (ok) {
      setEditingName(false);
      onAgentUpdated?.();
    }
  };

  const handleStatusChange = async (newStatus: string) => {
    if (newStatus === agent.status) {
      setEditingStatus(false);
      return;
    }
    setSavingStatus(true);
    const ok = await updateAgent(agent.id, { status: newStatus });
    setSavingStatus(false);
    if (ok) {
      setEditingStatus(false);
      onAgentUpdated?.();
    }
  };

  // Parse tools from comma-separated string
  const tools: string[] = agent.tools
    ? agent.tools.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const assignedTasks: TaskWithProject[] = agent.assigned_tasks ?? [];
  const recentActivity: ActivityEvent[] = agent.recent_activity ?? [];

  return (
    <div
      className="rounded-xl flex flex-col h-full animate-slide-in-right overflow-hidden"
      style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 flex items-start justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid #313244' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-base font-bold flex-shrink-0"
            style={{ backgroundColor: color, color: '#11111b' }}
          >
            {initial}
          </div>
          <div>
            {/* Editable name */}
            {editingName ? (
              <div className="flex items-center gap-1.5">
                <input
                  ref={nameInputRef}
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleNameSave();
                    if (e.key === 'Escape') { setEditingName(false); setNameValue(agent.name); }
                  }}
                  disabled={savingName}
                  maxLength={50}
                  className="text-sm font-bold rounded px-1.5 py-0.5 outline-none"
                  style={{
                    backgroundColor: '#313244',
                    color: '#cdd6f4',
                    border: '1px solid #cba6f7',
                    width: '140px',
                  }}
                />
                <button
                  onClick={handleNameSave}
                  disabled={savingName}
                  className="w-5 h-5 flex items-center justify-center rounded cursor-pointer"
                  style={{ color: '#a6e3a1' }}
                  title="Save"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </button>
                <button
                  onClick={() => { setEditingName(false); setNameValue(agent.name); }}
                  className="w-5 h-5 flex items-center justify-center rounded cursor-pointer"
                  style={{ color: '#f38ba8' }}
                  title="Cancel"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group">
                <h3 className="text-sm font-bold" style={{ color: '#cdd6f4' }}>
                  {agent.name}
                </h3>
                <button
                  onClick={() => setEditingName(true)}
                  className="w-5 h-5 flex items-center justify-center rounded opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
                  style={{ color: '#6c7086' }}
                  title="Edit name"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              </div>
            )}
            <p className="text-xs" style={{ color: '#a6adc8' }}>
              {agent.role}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={{ backgroundColor: badge.bg, color: badge.text }}
              >
                {badge.label}
              </span>

              {/* Editable status */}
              {editingStatus ? (
                <div className="flex items-center gap-1">
                  <select
                    value={agent.status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    disabled={savingStatus}
                    className="text-xs rounded px-1.5 py-0.5 cursor-pointer outline-none"
                    style={{
                      backgroundColor: '#313244',
                      color: '#cdd6f4',
                      border: '1px solid #cba6f7',
                    }}
                  >
                    {AGENT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s === 'on_demand' ? 'On-demand' : s.charAt(0).toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setEditingStatus(false)}
                    className="w-4 h-4 flex items-center justify-center rounded cursor-pointer"
                    style={{ color: '#6c7086' }}
                    title="Cancel"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setEditingStatus(true)}
                  className="flex items-center gap-1 text-xs cursor-pointer transition-opacity hover:opacity-80"
                  style={{ color: status.dot, background: 'none', border: 'none', padding: 0 }}
                  title="Click to change status"
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: status.dot }} />
                  {status.label}
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.5 }}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
          style={{ color: '#6c7086', backgroundColor: 'transparent' }}
          aria-label="Close detail panel"
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#313244';
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
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6c7086' }}>
              Description
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: '#a6adc8' }}>
              {agent.description}
            </p>
          </section>
        )}

        {/* Model info */}
        <section aria-label="Model info">
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6c7086' }}>
            Model
          </h4>
          <p className="text-xs" style={{ color: '#cdd6f4' }}>
            {agent.model}
          </p>
        </section>

        {/* Expertise */}
        {agent.expertise && (
          <section aria-label="Agent expertise">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6c7086' }}>
              Expertise
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: '#a6adc8' }}>
              {agent.expertise}
            </p>
          </section>
        )}

        {/* Tools */}
        {tools.length > 0 && (
          <section aria-label="Agent tools">
            <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6c7086' }}>
              Tools
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((tool) => (
                <span
                  key={tool}
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: '#313244', color: '#94e2d5', border: '1px solid #45475a' }}
                >
                  {tool}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Assigned Tasks */}
        <section aria-label="Assigned tasks">
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6c7086' }}>
            Assigned Tasks ({assignedTasks.length})
          </h4>
          {assignedTasks.length === 0 ? (
            <p className="text-xs" style={{ color: '#6c7086' }}>
              No tasks assigned
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ borderBottom: '1px solid #313244' }}>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: '#6c7086' }}>
                      Task
                    </th>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: '#6c7086' }}>
                      Project
                    </th>
                    <th className="text-left py-1.5 pr-3 font-medium" style={{ color: '#6c7086' }}>
                      Priority
                    </th>
                    <th className="text-left py-1.5 font-medium" style={{ color: '#6c7086' }}>
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {assignedTasks.map((task) => {
                    const pri = priorityBadge(task.priority);
                    const statusColor = taskStatusColor(task.status);
                    return (
                      <tr key={task.id} style={{ borderBottom: '1px solid #1e1e2e' }}>
                        <td className="py-1.5 pr-3" style={{ color: '#cdd6f4', maxWidth: '140px' }}>
                          <span className="truncate block">{task.title}</span>
                        </td>
                        <td className="py-1.5 pr-3" style={{ color: '#a6adc8' }}>
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
          <h4 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#6c7086' }}>
            Recent Activity ({recentActivity.length})
          </h4>
          {recentActivity.length === 0 ? (
            <p className="text-xs" style={{ color: '#6c7086' }}>
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
                    style={{ backgroundColor: '#313244' }}
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
                      <p className="text-xs leading-relaxed" style={{ color: '#a6adc8' }}>
                        {evt.detail}
                      </p>
                      {evt.timestamp && (
                        <p className="text-xs mt-0.5" style={{ color: '#6c7086' }}>
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
export default function AgentPanel({ agents, loading, onAgentUpdated }: AgentPanelProps) {
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
            style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
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
        <p className="text-sm" style={{ color: '#6c7086' }}>
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
          <DetailPanel agent={selectedAgent} onClose={() => setSelectedId(null)} onAgentUpdated={onAgentUpdated} />
        </div>
      )}
    </div>
  );
}
