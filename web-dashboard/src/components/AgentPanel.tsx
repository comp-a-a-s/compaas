import { useState, useEffect, useMemo } from 'react';
import { fetchAgentDetail } from '../api/client';
import type { Agent, ActivityEvent, TaskWithProject, WorkforceLiveSnapshot, WorkforceState, WorkforceWorker } from '../types';

interface AgentPanelProps {
  agents: Agent[];
  loading: boolean;
  microProjectMode?: boolean;
  workforceLive?: WorkforceLiveSnapshot;
}

// ---- Helpers ----
function effectiveModel(agent: Agent): string {
  return (agent.runtime_model || agent.model || '').trim() || 'unknown';
}

function effectiveRuntimeLabel(agent: Agent): string {
  return (agent.runtime_label || effectiveModel(agent)).trim();
}

function modelBadge(model: string): { bg: string; text: string; label: string } {
  const m = model.toLowerCase();
  if (m.includes('codex')) return { bg: '#1a2e25', text: 'var(--tf-success)', label: 'Codex' };
  if (m.includes('opus')) return { bg: '#1c2233', text: 'var(--tf-accent)', label: 'Opus' };
  if (m.includes('sonnet')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)', label: 'Sonnet' };
  if (m.includes('haiku')) return { bg: '#1a2e25', text: 'var(--tf-success)', label: 'Haiku' };
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)', label: model };
  if (m.includes('llama') || m.includes('qwen') || m.includes('mistral') || m.includes('gemma')) return { bg: '#2d2213', text: 'var(--tf-warning)', label: model };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)', label: model };
}

function avatarColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('codex')) return 'var(--tf-success)';
  if (m.includes('opus')) return 'var(--tf-accent)';
  if (m.includes('sonnet')) return 'var(--tf-accent-blue)';
  if (m.includes('haiku')) return 'var(--tf-success)';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'var(--tf-accent-blue)';
  if (m.includes('llama') || m.includes('qwen') || m.includes('mistral') || m.includes('gemma')) return 'var(--tf-warning)';
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

function liveStateStyle(state?: WorkforceState): { dot: string; label: string; border: string; glow: string; bg: string } {
  switch (state) {
    case 'working':
      return {
        dot: 'var(--tf-success)',
        label: 'Working',
        border: 'var(--tf-success)',
        glow: 'rgba(63,185,80,0.16)',
        bg: 'rgba(63,185,80,0.06)',
      };
    case 'assigned':
      return {
        dot: 'var(--tf-warning)',
        label: 'Assigned',
        border: 'var(--tf-warning)',
        glow: 'rgba(240,170,74,0.18)',
        bg: 'rgba(240,170,74,0.08)',
      };
    case 'reporting':
      return {
        dot: 'var(--tf-accent-blue)',
        label: 'Reporting',
        border: 'var(--tf-accent-blue)',
        glow: 'rgba(59,142,255,0.18)',
        bg: 'rgba(59,142,255,0.08)',
      };
    case 'blocked':
      return {
        dot: 'var(--tf-error)',
        label: 'Blocked',
        border: 'var(--tf-error)',
        glow: 'rgba(234,114,103,0.18)',
        bg: 'rgba(234,114,103,0.08)',
      };
    default:
      return {
        dot: 'var(--tf-text-muted)',
        label: 'Idle',
        border: 'var(--tf-border)',
        glow: 'transparent',
        bg: 'var(--tf-surface)',
      };
  }
}

function formatElapsed(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  if (mins > 0) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  return `${secs}s`;
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
  liveInfo?: WorkforceWorker;
}
function AgentCard({ agent, selected, onSelect, disabled = false, liveInfo }: AgentCardProps) {
  const model = effectiveModel(agent);
  const runtimeLabel = effectiveRuntimeLabel(agent);
  const badge = modelBadge(model);
  const color = avatarColor(model);
  const status = statusStyle(agent.status);
  const initial = agent.name.charAt(0).toUpperCase();
  const liveState = !disabled ? liveInfo?.state : undefined;
  const liveStyle = liveStateStyle(liveState);
  const hasLiveState = Boolean(liveState);
  const isWorking = liveState === 'working';

  return (
    <button
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className="w-full text-left rounded-xl p-4 flex flex-col gap-3 transition-all duration-200 cursor-pointer"
      style={{
        backgroundColor: selected
          ? 'var(--tf-surface-raised)'
          : hasLiveState
          ? liveStyle.bg
          : 'var(--tf-surface)',
        border: `1px solid ${selected ? 'var(--tf-accent)' : hasLiveState ? liveStyle.border : 'var(--tf-border)'}`,
        opacity: disabled ? 0.48 : 1,
        filter: disabled ? 'grayscale(35%)' : 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: 'none',
        boxShadow: hasLiveState && !selected ? `0 0 12px ${liveStyle.glow}` : 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected && !disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#6e7681';
        }
      }}
      onMouseLeave={(e) => {
        if (!selected && !disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = hasLiveState ? liveStyle.border : 'var(--tf-border)';
        }
      }}
    >
      {/* Avatar + status */}
      <div className="flex items-start justify-between">
        <div style={{ position: 'relative' }}>
          {isWorking && (
            <div style={{
              position: 'absolute',
              inset: '-4px',
              borderRadius: '50%',
              border: '2px solid var(--tf-success)',
              opacity: 0.6,
              animation: 'pulse-ring 1.8s ease-out infinite',
            }} />
          )}
          {hasLiveState && !isWorking && (
            <div style={{
              position: 'absolute',
              inset: '-4px',
              borderRadius: '50%',
              border: `2px solid ${liveStyle.border}`,
              opacity: 0.45,
            }} />
          )}
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
            style={{ backgroundColor: color, color: 'var(--tf-bg)', position: 'relative' }}
          >
            {initial}
          </div>
          {hasLiveState && (
            <div style={{
              position: 'absolute',
              bottom: -1,
              right: -1,
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              backgroundColor: liveStyle.dot,
              border: '2px solid var(--tf-surface)',
            }} />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {hasLiveState ? (
            <>
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: liveStyle.dot, animation: isWorking ? 'pulse-dot 1.4s ease-in-out infinite' : undefined }}
                aria-hidden="true"
              />
              <span className="text-xs font-medium" style={{ color: liveStyle.dot }}>
                {liveStyle.label}
              </span>
            </>
          ) : (
            <>
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: status.dot }}
                aria-hidden="true"
              />
              <span className="text-xs" style={{ color: status.dot }}>
                {status.label}
              </span>
            </>
          )}
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

      {/* Live task label */}
      {hasLiveState && liveInfo?.task && (
        <p
          className={`text-xs leading-tight${isWorking ? ' animate-pulse-dot' : ''}`}
          style={{
            color: liveStyle.dot,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={liveInfo.task}
        >
          {liveInfo.task}
        </p>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5">
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ backgroundColor: badge.bg, color: badge.text }}
          title={runtimeLabel}
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
  liveInfo?: WorkforceWorker;
}
function DetailPanel({ agent, onClose, liveInfo }: DetailPanelProps) {
  const model = effectiveModel(agent);
  const runtimeLabel = effectiveRuntimeLabel(agent);
  const badge = modelBadge(model);
  const color = avatarColor(model);
  const status = statusStyle(agent.status);
  const liveStyle = liveStateStyle(liveInfo?.state);
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
                title={runtimeLabel}
              >
                {badge.label}
              </span>
              {liveInfo ? (
                <span className="flex items-center gap-1 text-xs" style={{ color: liveStyle.dot }}>
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      backgroundColor: liveStyle.dot,
                      animation: liveInfo.state === 'working' ? 'pulse-dot 1.4s ease-in-out infinite' : undefined,
                    }}
                  />
                  Live State: {liveStyle.label}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs" style={{ color: status.dot }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: status.dot }} />
                  {status.label}
                </span>
              )}
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
        {/* Live task banner */}
        {liveInfo && (
          <section
            className="rounded-lg px-4 py-3"
            style={{
              backgroundColor: liveStyle.bg,
              border: `1px solid ${liveStyle.border}`,
            }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: liveStyle.dot,
                  animation: liveInfo.state === 'working' ? 'pulse-dot 1.4s ease-in-out infinite' : undefined,
                }}
              />
              <h4 className="text-xs font-semibold uppercase tracking-widest" style={{ color: liveStyle.dot }}>
                Live State: {liveStyle.label}
              </h4>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text)' }}>
              {liveInfo.task || 'No active task detail provided.'}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
              Since {new Date(liveInfo.started_at || liveInfo.updated_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              {' '}&middot;{' '}Elapsed {formatElapsed(liveInfo.elapsed_seconds)}
            </p>
          </section>
        )}

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
            {runtimeLabel}
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
export default function AgentPanel({ agents, loading, microProjectMode = false, workforceLive }: AgentPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailedAgent, setDetailedAgent] = useState<Agent | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const effectiveSelectedId = microProjectMode && selectedId && selectedId !== 'ceo' ? null : selectedId;

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Fetch full detail when an agent is selected
  useEffect(() => {
    if (!effectiveSelectedId) return;
    let cancelled = false;
    fetchAgentDetail(effectiveSelectedId).then((data) => {
      if (!cancelled && data) setDetailedAgent(data);
    });
    return () => { cancelled = true; };
  }, [effectiveSelectedId]);

  // Keep selection source-of-truth on selectedId so closing always hides the panel.
  const selectedAgent = effectiveSelectedId
    ? (
        detailedAgent && detailedAgent.id === effectiveSelectedId
          ? detailedAgent
          : agents.find((a) => a.id === effectiveSelectedId) ?? null
      )
    : null;

  const liveByAgent = useMemo(() => {
    const byAgent = new Map<string, WorkforceWorker>();
    const workers = workforceLive?.workers || [];
    const stateRank: Record<WorkforceState, number> = {
      working: 4,
      blocked: 3,
      reporting: 2,
      assigned: 1,
    };
    for (const worker of workers) {
      const agentId = String(worker.agent_id || '').trim().toLowerCase().replace(/\\s+/g, '-');
      if (!agentId) continue;
      const existing = byAgent.get(agentId);
      if (!existing) {
        byAgent.set(agentId, worker);
        continue;
      }
      const workerRank = stateRank[worker.state] || 0;
      const existingRank = stateRank[existing.state] || 0;
      if (workerRank > existingRank) {
        byAgent.set(agentId, worker);
        continue;
      }
      if (workerRank === existingRank && String(worker.updated_at || '') > String(existing.updated_at || '')) {
        byAgent.set(agentId, worker);
      }
    }
    return byAgent;
  }, [workforceLive?.workers]);

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
                    selected={effectiveSelectedId === agent.id}
                    disabled={disabled}
                    onSelect={() => handleSelect(agent.id)}
                    liveInfo={liveByAgent.get(agent.id)}
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
              liveInfo={liveByAgent.get(selectedAgent.id)}
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
