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

// ---- Org hierarchy node ----
interface OrgNodeProps {
  agent: Agent;
  displayRole?: string;
  onAgentClick?: (agent: Agent) => void;
}
function OrgNode({ agent, displayRole, onAgentClick }: OrgNodeProps) {
  const color = modelColor(agent.model);
  const initial = agent.name.charAt(0).toUpperCase();
  const isActive = agent.status === 'active' || agent.status === 'permanent' ||
    (agent.recent_activity && agent.recent_activity.length > 0);

  return (
    <div
      className="flex flex-col items-center gap-1 px-3 py-2 rounded-xl"
      style={{
        backgroundColor: 'var(--tf-surface-raised)',
        border: '1px solid var(--tf-border)',
        minWidth: '96px',
        cursor: onAgentClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
      }}
      onClick={() => onAgentClick?.(agent)}
      onMouseEnter={(e) => {
        if (onAgentClick) {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--tf-accent)';
        }
      }}
      onMouseLeave={(e) => {
        if (onAgentClick) {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--tf-border)';
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
      {/* Avatar with optional pulse ring */}
      <div style={{ position: 'relative' }}>
        {isActive && (
          <div style={{
            position: 'absolute',
            inset: '-3px',
            borderRadius: '50%',
            border: '2px solid var(--tf-success)',
            opacity: 0.6,
            animation: 'pulse-ring 2s ease-out infinite',
          }} />
        )}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ backgroundColor: color, color: 'var(--tf-bg)', position: 'relative' }}
        >
          {initial}
        </div>
      </div>
      <p className="text-xs font-medium text-center leading-tight" style={{ color: 'var(--tf-text)' }}>
        {agent.name}
      </p>
      <p className="text-xs text-center leading-tight" style={{ color: 'var(--tf-text-muted)' }}>
        {displayRole ?? agent.role}
      </p>
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

interface TreeNodeProps {
  node: OrgTreeNode;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
}

function TreeNode({ node, agentMap, onAgentClick }: TreeNodeProps) {
  const agent = agentMap.get(node.id);
  const children = node.children ?? [];

  // If this agent is not in the data, skip rendering
  if (!agent) return null;

  const hasChildren = children.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* The node card wrapped in a Tooltip */}
      <Tooltip content={`${node.displayRole ?? agent.role} · ${agent.model}`} position="top">
        <OrgNode
          agent={agent}
          displayRole={node.displayRole}
          onAgentClick={onAgentClick}
        />
      </Tooltip>

      {hasChildren && (
        <>
          {/* Vertical connector from node down to horizontal bar */}
          <div style={{ width: '2px', height: '24px', backgroundColor: 'var(--tf-border)' }} />

          {/* Row of children with connecting lines */}
          <ChildrenGroup node={node} agentMap={agentMap} onAgentClick={onAgentClick} />
        </>
      )}
    </div>
  );
}

interface ChildrenGroupProps {
  node: OrgTreeNode;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
}

function ChildrenGroup({ node, agentMap, onAgentClick }: ChildrenGroupProps) {
  const children = node.children ?? [];

  // Filter to only children that exist in agentMap
  const visibleChildren = children.filter(c => agentMap.has(c.id));

  if (visibleChildren.length === 0) return null;

  if (visibleChildren.length === 1) {
    // Single child: just a vertical stub + the child node
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: '2px', height: '20px', backgroundColor: 'var(--tf-border)' }} />
        <TreeNode node={visibleChildren[0]} agentMap={agentMap} onAgentClick={onAgentClick} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Horizontal spanning bar — rendered as a relative container */}
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }}>
        {/* The horizontal line is positioned absolutely, spanning between the centers of the first and last child */}
        <HorizontalBar />

        {/* Children row */}
        {visibleChildren.map((child) => (
          <div
            key={child.id}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px' }}
          >
            {/* Vertical stub from horizontal bar down to child card */}
            <div style={{ width: '2px', height: '20px', backgroundColor: 'var(--tf-border)' }} />
            <TreeNode node={child} agentMap={agentMap} onAgentClick={onAgentClick} />
          </div>
        ))}
      </div>
    </div>
  );
}

function HorizontalBar() {
  // Spans from the center of the first child column to the center of the last child column.
  // Each child column has padding: 0 12px around a ~96px min-width card, making each
  // column ~120px wide. The center of the first column from the left edge is 60px.
  // The center of the last column from the right edge is also 60px.
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: '60px',
        right: '60px',
        height: '2px',
        backgroundColor: 'var(--tf-border)',
      }}
    />
  );
}

interface OrgChartProps {
  agents: Agent[];
  loading: boolean;
}

function OrgChart({ agents, loading }: OrgChartProps) {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

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
          <TreeNode node={ORG_TREE} agentMap={agentMap} onAgentClick={handleAgentClick} />
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

// ---- Activity event row ----
interface ActivityRowProps {
  event: ActivityEvent;
}
function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = action.toUpperCase();
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (a.includes('COMPLETED') || a.includes('DONE') || a.includes('FINISH')) return { bg: '#1a2e25', text: 'var(--tf-success)' };
  if (a.includes('BLOCKED') || a.includes('ERROR') || a.includes('FAIL')) return { bg: '#2d1519', text: 'var(--tf-error)' };
  if (a.includes('ASSIGNED') || a.includes('ASSIGN')) return { bg: '#1c2233', text: 'var(--tf-accent)' };
  if (a.includes('UPDATED') || a.includes('UPDATE')) return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (a.includes('CREATED') || a.includes('CREATE')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)' };
}

function ActivityRow({ event }: ActivityRowProps) {
  const badge = actionBadgeStyle(event.action);
  const initial = event.agent ? event.agent.charAt(0).toUpperCase() : '?';
  const agentColor = modelColor('');

  return (
    <div className="flex items-start gap-3 py-2" style={{ borderBottom: '1px solid var(--tf-bg)' }}>
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
        style={{ backgroundColor: agentColor, color: 'var(--tf-bg)' }}
      >
        {initial}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>
            {event.agent || 'System'}
          </span>
          <span
            className="text-xs px-1.5 py-0.5 rounded-full font-medium"
            style={{ backgroundColor: badge.bg, color: badge.text }}
          >
            {event.action}
          </span>
          <span className="text-xs ml-auto flex-shrink-0" style={{ color: 'var(--tf-text-muted)' }}>
            {event.timestamp
              ? new Date(event.timestamp).toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : ''}
          </span>
        </div>
        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--tf-text-secondary)' }}>
          {event.detail}
        </p>
      </div>
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
  // Compute task status distribution
  const statusCounts: Record<string, number> = {};
  for (const t of tasks) {
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
  }

  const recentEvents = events.slice(-20).reverse();

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

      {/* Org chart + Activity row */}
      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Org hierarchy */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--tf-text-muted)' }}>
            Organization Hierarchy
          </h3>
          <OrgChart agents={agents} loading={loadingAgents} />
        </div>

        {/* Recent Activity */}
        <div
          className="rounded-xl p-5 flex flex-col"
          style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-3 flex-shrink-0" style={{ color: 'var(--tf-text-muted)' }}>
            Recent Activity
          </h3>
          <div className="flex-1 overflow-y-auto" style={{ maxHeight: '280px' }}>
            {recentEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <div className="flex gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-2 h-2 rounded-full animate-pulse-dot"
                      style={{ backgroundColor: 'var(--tf-border)', animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
                </div>
                <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                  Waiting for events...
                </p>
              </div>
            ) : (
              recentEvents.map((e, i) => (
                <ActivityRow key={`${e.timestamp}-${i}`} event={e} />
              ))
            )}
          </div>
        </div>
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
