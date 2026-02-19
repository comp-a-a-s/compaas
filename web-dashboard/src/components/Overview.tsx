import { useState, useMemo } from 'react';
import type { Agent, Project, Task, ActivityEvent } from '../types';
import Tooltip from './Tooltip';

interface OverviewProps {
  agents: Agent[];
  projects: Project[];
  tasks: Task[];
  events: ActivityEvent[];
  loadingAgents: boolean;
  loadingProjects: boolean;
  loadingTasks: boolean;
}

// ---- Skeleton helper ----
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} style={{ height: '1rem' }} />;
}

// ---- Stat card ----
interface StatCardProps {
  label: string;
  value: string;
  color: string;
  loading: boolean;
}
function StatCard({ label, value, color, loading }: StatCardProps) {
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-1 animate-slide-up"
      style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
    >
      <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
        {label}
      </p>
      {loading ? (
        <Skeleton className="w-12 h-8" />
      ) : (
        <p className="text-3xl font-bold" style={{ color }}>
          {value}
        </p>
      )}
    </div>
  );
}

// ---- Model color helper ----
function modelColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'var(--tf-accent)';
  if (m.includes('sonnet')) return 'var(--tf-accent-blue)';
  if (m.includes('haiku')) return 'var(--tf-success)';
  return 'var(--tf-text-secondary)';
}

// ---- Recent activity helpers ----
function isAgentRecentlyActive(agentId: string, agentName: string, events: ActivityEvent[]): boolean {
  const now = Date.now();
  const WINDOW_MS = 90_000;
  const idLower = agentId.toLowerCase();
  const nameLower = agentName.toLowerCase();
  return events.some((evt) => {
    if (!evt.timestamp) return false;
    const evtTime = new Date(evt.timestamp).getTime();
    if (now - evtTime > WINDOW_MS) return false;
    const evtAgent = (evt.agent ?? '').toLowerCase();
    return evtAgent === idLower || evtAgent === nameLower || evtAgent.includes(nameLower);
  });
}

// ---- Animated connector line ----
// Shows a flowing green signal when the connected child (or its subtree) is active.

interface ConnectorProps {
  vertical?: boolean;
  active?: boolean;
  size: number; // px: height for vertical, width for horizontal
}

function Connector({ vertical = true, active = false, size }: ConnectorProps) {
  const baseColor = active ? 'rgba(63,185,80,0.35)' : 'var(--tf-border)';
  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        ...(vertical
          ? { width: '2px', height: `${size}px` }
          : { height: '2px', width: `${size}px` }),
        backgroundColor: baseColor,
        transition: 'background-color 0.4s',
        borderRadius: '1px',
      }}
    >
      {active && (
        <div
          className={vertical ? 'anim-flow-down' : 'anim-flow-right'}
          style={{
            position: 'absolute',
            ...(vertical
              ? { left: 0, right: 0, height: '50%' }
              : { top: 0, bottom: 0, width: '50%' }),
            background: vertical
              ? 'linear-gradient(to bottom, transparent, var(--tf-success), transparent)'
              : 'linear-gradient(to right, transparent, var(--tf-success), transparent)',
          }}
        />
      )}
    </div>
  );
}

// ---- Org hierarchy node ----
interface OrgNodeProps {
  agent: Agent;
  displayRole?: string;
  onAgentClick?: (agent: Agent) => void;
  recentlyActive?: boolean;
}
function OrgNode({ agent, displayRole, onAgentClick, recentlyActive = false }: OrgNodeProps) {
  const color = modelColor(agent.model);
  const initial = agent.name.charAt(0).toUpperCase();
  const isActive = recentlyActive || agent.status === 'active' ||
    (agent.recent_activity && agent.recent_activity.length > 0);

  // Latest activity detail for tooltip
  const latestActivity = agent.recent_activity?.[0];

  return (
    <div
      className="flex flex-col items-center gap-1 px-3 py-2 rounded-xl"
      style={{
        backgroundColor: isActive ? 'rgba(63,185,80,0.06)' : 'var(--tf-surface-raised)',
        border: `1px solid ${isActive ? 'var(--tf-success)' : 'var(--tf-border)'}`,
        minWidth: '96px',
        cursor: onAgentClick ? 'pointer' : 'default',
        transition: 'border-color 0.3s, background-color 0.3s, box-shadow 0.3s',
        boxShadow: isActive ? '0 0 10px rgba(63,185,80,0.2)' : 'none',
      }}
      onClick={() => onAgentClick?.(agent)}
      onMouseEnter={(e) => {
        if (onAgentClick) {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--tf-accent)';
        }
      }}
      onMouseLeave={(e) => {
        if (onAgentClick) {
          (e.currentTarget as HTMLDivElement).style.borderColor = isActive ? 'var(--tf-success)' : 'var(--tf-border)';
        }
      }}
      role={onAgentClick ? 'button' : undefined}
      tabIndex={onAgentClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onAgentClick && (e.key === 'Enter' || e.key === ' ')) {
          onAgentClick(agent);
        }
      }}
    >
      {/* Avatar with pulse ring when active */}
      <div style={{ position: 'relative' }}>
        {isActive && (
          <div style={{
            position: 'absolute',
            inset: '-4px',
            borderRadius: '50%',
            border: '2px solid var(--tf-success)',
            opacity: 0.6,
            animation: 'pulse-ring 1.8s ease-out infinite',
          }} />
        )}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ backgroundColor: color, color: 'var(--tf-bg)', position: 'relative' }}
        >
          {initial}
        </div>
        {/* Small green dot indicator */}
        {isActive && (
          <div style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'var(--tf-success)',
            border: '1.5px solid var(--tf-surface-raised)',
          }} />
        )}
      </div>
      <p className="text-xs font-medium text-center leading-tight" style={{ color: 'var(--tf-text)' }}>
        {agent.name}
      </p>
      <p className="text-xs text-center leading-tight" style={{ color: 'var(--tf-text-muted)' }}>
        {displayRole ?? agent.role}
      </p>
      {/* Show live activity label when working */}
      {isActive && latestActivity && (
        <p
          className="text-xs text-center leading-tight animate-pulse-dot"
          style={{ color: 'var(--tf-success)', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={latestActivity.detail || latestActivity.action}
        >
          {latestActivity.action}
        </p>
      )}
    </div>
  );
}

// ---- Agent detail modal ----
interface AgentDetailModalProps {
  agent: Agent;
  onClose: () => void;
}
function AgentDetailModal({ agent, onClose }: AgentDetailModalProps) {
  const color = modelColor(agent.model);
  const initial = agent.name.charAt(0).toUpperCase();
  const recentActivity = agent.recent_activity ?? [];

  return (
    <div
      style={{
        marginTop: '16px',
        backgroundColor: 'var(--tf-surface)',
        border: '1px solid var(--tf-border)',
        borderRadius: '10px',
        padding: '16px',
        animation: 'slide-up 0.2s ease-out both',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '36px', height: '36px', borderRadius: '50%',
              backgroundColor: color, color: 'var(--tf-bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '14px', fontWeight: 700,
            }}
          >
            {initial}
          </div>
          <div>
            <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--tf-text)' }}>{agent.name}</p>
            <p style={{ fontSize: '12px', color: 'var(--tf-text-secondary)' }}>{agent.role}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            width: '28px', height: '28px', borderRadius: '6px',
            border: 'none', backgroundColor: 'transparent', color: 'var(--tf-text-muted)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
          aria-label="Close agent detail"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>
          Model: <span style={{ color: 'var(--tf-text-secondary)' }}>{agent.model}</span>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>
          Status: <span style={{ color: agent.status === 'active' || agent.status === 'permanent' ? 'var(--tf-success)' : 'var(--tf-text-secondary)' }}>{agent.status}</span>
        </div>
        {agent.team && (
          <div style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>
            Team: <span style={{ color: 'var(--tf-text-secondary)' }}>{agent.team}</span>
          </div>
        )}
        {agent.hired_at && (
          <div style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>
            Hired: <span style={{ color: 'var(--tf-text-secondary)' }}>{new Date(agent.hired_at).toLocaleDateString()}</span>
          </div>
        )}
      </div>

      <div>
        <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--tf-text-muted)', marginBottom: '6px' }}>
          Recent Activity
        </p>
        {recentActivity.length === 0 ? (
          <p style={{ fontSize: '12px', color: 'var(--tf-text-muted)' }}>No recent activity</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentActivity.slice(0, 3).map((evt, i) => (
              <div key={i} style={{ fontSize: '12px', color: 'var(--tf-text-secondary)', padding: '4px 8px', backgroundColor: 'var(--tf-surface-raised)', borderRadius: '4px' }}>
                <span style={{ color: 'var(--tf-accent-blue)', marginRight: '6px' }}>{evt.action}</span>
                {evt.detail}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Org chart (tree hierarchy) ----

interface OrgTreeNode {
  id: string;
  displayRole?: string;
  children?: OrgTreeNode[];
}

const ORG_TREE: OrgTreeNode = {
  id: 'ceo',
  children: [
    {
      id: 'cto',
      children: [
        {
          id: 'vp-engineering',
          children: [
            { id: 'lead-backend' },
            { id: 'lead-frontend' },
            { id: 'qa-lead' },
            { id: 'devops' },
            { id: 'data-engineer' },
          ],
        },
      ],
    },
    {
      id: 'ciso',
      children: [
        { id: 'security-engineer' },
      ],
    },
    { id: 'cfo' },
    {
      id: 'vp-product',
      displayRole: 'CPO',
      children: [
        { id: 'lead-designer' },
        { id: 'tech-writer' },
      ],
    },
    { id: 'chief-researcher' },
  ],
};

// Check if a subtree contains any active agent
function subtreeHasActive(node: OrgTreeNode, activeIds: Set<string>): boolean {
  if (activeIds.has(node.id)) return true;
  return (node.children ?? []).some((c) => subtreeHasActive(c, activeIds));
}

interface TreeNodeProps {
  node: OrgTreeNode;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
  events: ActivityEvent[];
  activeIds: Set<string>;
}

function TreeNode({ node, agentMap, onAgentClick, events, activeIds }: TreeNodeProps) {
  const agent = agentMap.get(node.id);
  const children = node.children ?? [];

  if (!agent) return null;

  const hasChildren = children.length > 0;
  const recentlyActive = isAgentRecentlyActive(node.id, agent.name, events);
  // The vertical stem from this node to its children is active if ANY descendant is active
  const childSubtreeActive = children.some((c) => subtreeHasActive(c, activeIds));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Tooltip content={`${node.displayRole ?? agent.role} · ${agent.model}`} position="top">
        <OrgNode
          agent={agent}
          displayRole={node.displayRole}
          onAgentClick={onAgentClick}
          recentlyActive={recentlyActive}
        />
      </Tooltip>

      {hasChildren && (
        <>
          {/* Vertical stem: animated if any child's subtree is active */}
          <Connector vertical size={24} active={childSubtreeActive} />
          <ChildrenGroup node={node} agentMap={agentMap} onAgentClick={onAgentClick} events={events} activeIds={activeIds} />
        </>
      )}
    </div>
  );
}

interface ChildrenGroupProps {
  node: OrgTreeNode;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
  events: ActivityEvent[];
  activeIds: Set<string>;
}

function ChildrenGroup({ node, agentMap, onAgentClick, events, activeIds }: ChildrenGroupProps) {
  const children = node.children ?? [];
  const visibleChildren = children.filter((c) => agentMap.has(c.id));

  if (visibleChildren.length === 0) return null;

  if (visibleChildren.length === 1) {
    const childActive = subtreeHasActive(visibleChildren[0], activeIds);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Connector vertical size={20} active={childActive} />
        <TreeNode node={visibleChildren[0]} agentMap={agentMap} onAgentClick={onAgentClick} events={events} activeIds={activeIds} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }}>
      {visibleChildren.map((child, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === visibleChildren.length - 1;
        const childActive = subtreeHasActive(child, activeIds);

        return (
          <div
            key={child.id}
            style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 10px' }}
          >
            {/* Horizontal connector segment — animated when this branch leads to active agent */}
            <div style={{
              position: 'absolute',
              top: 0,
              left: isFirst ? '50%' : 0,
              right: isLast ? '50%' : 0,
              height: '2px',
              overflow: 'hidden',
              backgroundColor: childActive ? 'rgba(63,185,80,0.35)' : 'var(--tf-border)',
              transition: 'background-color 0.4s',
            }}>
              {childActive && (
                <div
                  className="anim-flow-right"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    width: '50%',
                    background: 'linear-gradient(to right, transparent, var(--tf-success), transparent)',
                  }}
                />
              )}
            </div>

            {/* Vertical stub to child */}
            <Connector vertical size={20} active={childActive} />
            <TreeNode node={child} agentMap={agentMap} onAgentClick={onAgentClick} events={events} activeIds={activeIds} />
          </div>
        );
      })}
    </div>
  );
}

interface OrgChartProps {
  agents: Agent[];
  loading: boolean;
  events: ActivityEvent[];
}

function OrgChart({ agents, loading, events }: OrgChartProps) {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  // Set of currently active agent IDs for connector animations
  const activeIds = useMemo(() => {
    const s = new Set<string>();
    for (const agent of agents) {
      if (isAgentRecentlyActive(agent.id, agent.name, events)) {
        s.add(agent.id);
      }
    }
    return s;
  }, [agents, events]);

  const handleAgentClick = (agent: Agent) => {
    setSelectedAgent(prev => prev?.id === agent.id ? null : agent);
  };

  if (loading) {
    return (
      <div className="space-y-2 py-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm py-4 text-center" style={{ color: 'var(--tf-text-muted)' }}>
        No agents found
      </p>
    );
  }

  return (
    <div>
      {/* Chart label */}
      <p
        style={{
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--tf-text-muted)',
          textAlign: 'center',
          marginBottom: '20px',
        }}
      >
        Organization Chart
      </p>

      {/* Scrollable chart container */}
      <div
        style={{
          overflowX: 'auto',
          overflowY: 'visible',
          padding: '8px 16px 16px',
          minWidth: 'min-content',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <TreeNode node={ORG_TREE} agentMap={agentMap} onAgentClick={handleAgentClick} events={events} activeIds={activeIds} />
        </div>
      </div>

      {/* Agent detail panel */}
      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </div>
  );
}

// ---- Project progress bar ----
interface ProjectProgressProps {
  project: Project;
}
function ProjectProgress({ project }: ProjectProgressProps) {
  const counts = project.task_counts ?? {};
  const done = counts['done'] ?? 0;
  const total = project.total_tasks ?? Object.values(counts).reduce((s, v) => s + v, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const statusColor =
    project.status === 'active'
      ? 'var(--tf-success)'
      : project.status === 'completed'
      ? 'var(--tf-accent-blue)'
      : project.status === 'paused'
      ? 'var(--tf-warning)'
      : 'var(--tf-text-secondary)';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium truncate" style={{ color: 'var(--tf-text)', maxWidth: '160px' }}>
          {project.name}
        </span>
        <span className="text-xs flex-shrink-0 ml-2" style={{ color: statusColor }}>
          {pct}%
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: statusColor }}
        />
      </div>
      <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
        {done}/{total} tasks · {project.status}
      </p>
    </div>
  );
}

// ---- Task status summary ----
function taskStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return 'var(--tf-success)';
  if (s === 'in_progress' || s === 'in progress') return 'var(--tf-accent-blue)';
  if (s === 'blocked') return 'var(--tf-error)';
  if (s === 'review') return 'var(--tf-accent)';
  if (s === 'todo') return 'var(--tf-text-secondary)';
  return 'var(--tf-text-muted)';
}

// ---- Main Overview component ----
export default function Overview({
  agents,
  projects,
  tasks,
  events,
  loadingAgents,
  loadingProjects,
  loadingTasks,
}: OverviewProps) {
  // Compute task status distribution — memoized so it only recomputes when tasks change
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    return counts;
  }, [tasks]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard
          label="Agents"
          value={agents.length.toString()}
          color="var(--tf-accent)"
          loading={loadingAgents}
        />
        <StatCard
          label="Projects"
          value={projects.length.toString()}
          color="var(--tf-accent-blue)"
          loading={loadingProjects}
        />
        <StatCard
          label="Tasks"
          value={tasks.length.toString()}
          color="var(--tf-success)"
          loading={loadingTasks}
        />
        <StatCard
          label="Live Events"
          value={events.length.toString()}
          color="var(--tf-warning)"
          loading={false}
        />
      </div>

      {/* Org chart — full width */}
      <div
        className="rounded-xl p-5"
        style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--tf-text-muted)' }}>
          Organization Hierarchy
        </h3>
        <OrgChart agents={agents} loading={loadingAgents} events={events} />
      </div>

      {/* Task status + Project progress row */}
      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Task status summary */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--tf-text-muted)' }}>
            Task Status Summary
          </h3>
          {loadingTasks ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : Object.keys(statusCounts).length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              No tasks loaded
            </p>
          ) : (
            <div className="space-y-3">
              {Object.entries(statusCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => {
                  const pct = tasks.length > 0 ? Math.round((count / tasks.length) * 100) : 0;
                  const color = taskStatusColor(status);
                  return (
                    <div key={status} className="flex flex-col gap-1">
                      <div className="flex justify-between">
                        <span className="text-xs capitalize" style={{ color: 'var(--tf-text)' }}>
                          {status.replace(/_/g, ' ')}
                        </span>
                        <span className="text-xs" style={{ color }}>
                          {count} ({pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Project progress */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--tf-text-muted)' }}>
            Project Progress
          </h3>
          {loadingProjects ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              No projects found
            </p>
          ) : (
            <div className="space-y-4">
              {projects.map((p) => (
                <ProjectProgress key={p.id} project={p} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
