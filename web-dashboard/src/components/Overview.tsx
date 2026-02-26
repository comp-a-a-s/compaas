import { useState, useMemo, useRef, useEffect } from 'react';
import type { Agent, Project, Task, ActivityEvent } from '../types';
import type { ActiveAgentInfo } from './TeamPulse';
import Tooltip from './Tooltip';

interface OverviewProps {
  agents: Agent[];
  projects: Project[];
  tasks: Task[];
  events: ActivityEvent[];
  activeProjectId?: string;
  microProjectMode?: boolean;
  loadingAgents: boolean;
  loadingProjects: boolean;
  loadingTasks: boolean;
  liveAgents?: Map<string, ActiveAgentInfo>;
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
function effectiveModel(agent: Agent): string {
  return (agent.runtime_model || agent.model || '').trim() || 'unknown';
}

function runtimeLabel(agent: Agent): string {
  return (agent.runtime_label || effectiveModel(agent)).trim();
}

function modelColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('codex')) return 'var(--tf-success)';
  if (m.includes('opus')) return 'var(--tf-accent)';
  if (m.includes('sonnet')) return 'var(--tf-accent-blue)';
  if (m.includes('haiku')) return 'var(--tf-success)';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'var(--tf-accent-blue)';
  if (m.includes('llama') || m.includes('qwen') || m.includes('mistral') || m.includes('gemma')) return 'var(--tf-warning)';
  return 'var(--tf-text-secondary)';
}

// ---- Recent activity helpers ----
function isAgentRecentlyActive(agentId: string, agentName: string, events: ActivityEvent[]): boolean {
  const now = Date.now();
  const WINDOW_MS = 90_000;
  const idLower = agentId.toLowerCase();
  const nameLower = agentName.toLowerCase();
  // normalizeAgent() converts slugs like "lead-backend" to display names "Lead Backend",
  // so we also need to match the space-separated form of the slug.
  const idSpaced = idLower.replace(/-/g, ' ');
  return events.some((evt) => {
    if (!evt.timestamp) return false;
    const evtTime = new Date(evt.timestamp).getTime();
    if (now - evtTime > WINDOW_MS) return false;
    const evtAgent = (evt.agent ?? '').toLowerCase();
    // Check direct agent match (slug, space-separated slug, or personal name)
    if (evtAgent === idLower || evtAgent === idSpaced || evtAgent === nameLower || evtAgent.includes(nameLower)) return true;
    // Also check delegation metadata — agents appear as target/source in delegation events
    const meta = evt.metadata || {};
    const target = String(meta.target_agent ?? '').toLowerCase();
    const source = String(meta.source_agent ?? '').toLowerCase();
    if (target === idLower || target === nameLower) return true;
    if (source === idLower || source === nameLower) return true;
    return false;
  });
}

// ---- Animated connector line ----
// Shows a flowing green signal when the connected child (or its subtree) is active.

interface ConnectorProps {
  vertical?: boolean;
  active?: boolean;
  flowDirection?: 'down' | 'up' | null;
  size: number; // px: height for vertical, width for horizontal
}

function Connector({ vertical = true, active = false, flowDirection = 'down', size }: ConnectorProps) {
  const baseColor = active ? 'rgba(63,185,80,0.35)' : 'var(--tf-border)';
  const flowClass = vertical
    ? flowDirection === 'up' ? 'anim-flow-up' : 'anim-flow-down'
    : flowDirection === 'up' ? 'anim-flow-left' : 'anim-flow-right';
  const gradient = vertical
    ? flowDirection === 'up'
      ? 'linear-gradient(to top, transparent, var(--tf-success), transparent)'
      : 'linear-gradient(to bottom, transparent, var(--tf-success), transparent)'
    : flowDirection === 'up'
      ? 'linear-gradient(to left, transparent, var(--tf-success), transparent)'
      : 'linear-gradient(to right, transparent, var(--tf-success), transparent)';
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
          className={flowClass}
          style={{
            position: 'absolute',
            ...(vertical
              ? { left: 0, right: 0, height: '50%' }
              : { top: 0, bottom: 0, width: '50%' }),
            background: gradient,
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
  muted?: boolean;
  activeTaskLabel?: string;
  blocked?: boolean;
}
function OrgNode({
  agent,
  displayRole,
  onAgentClick,
  recentlyActive = false,
  muted = false,
  activeTaskLabel,
  blocked = false,
}: OrgNodeProps) {
  const color = modelColor(effectiveModel(agent));
  const initial = agent.name.charAt(0).toUpperCase();
  const isActive = !muted && (
    recentlyActive
    || agent.status === 'active'
    || (agent.recent_activity && agent.recent_activity.length > 0)
  );

  // Latest activity detail for tooltip
  const latestActivity = agent.recent_activity?.[0];

  // Determine what label to show under the card
  const activityLabel = activeTaskLabel && !muted
    ? activeTaskLabel
    : isActive && latestActivity
      ? (latestActivity.detail || latestActivity.action)
      : isActive
        ? 'Working...'
        : null;

  return (
    <div
      className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl${isActive ? ' org-node-active' : ''}`}
      style={{
        backgroundColor: muted
          ? 'color-mix(in srgb, var(--tf-surface-raised) 84%, var(--tf-bg))'
          : blocked
            ? 'rgba(234,114,103,0.08)'
            : isActive ? 'rgba(63,185,80,0.14)' : 'var(--tf-surface-raised)',
        border: `1.5px solid ${blocked ? 'var(--tf-error)' : isActive ? 'var(--tf-success)' : 'var(--tf-border)'}`,
        minWidth: '88px',
        maxWidth: '128px',
        cursor: onAgentClick ? 'pointer' : 'default',
        transition: 'border-color 0.3s, background-color 0.3s, box-shadow 0.3s',
        boxShadow: isActive
          ? '0 0 12px rgba(63,185,80,0.35), 0 0 4px rgba(63,185,80,0.2)'
          : 'none',
        opacity: muted ? 0.46 : 1,
        filter: muted ? 'grayscale(38%)' : 'none',
      }}
      onClick={() => onAgentClick?.(agent)}
      onMouseEnter={(e) => {
        if (onAgentClick) {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--tf-accent)';
        }
      }}
      onMouseLeave={(e) => {
        if (onAgentClick) {
          (e.currentTarget as HTMLDivElement).style.borderColor = blocked
            ? 'var(--tf-error)'
            : isActive ? 'var(--tf-success)' : 'var(--tf-border)';
        }
      }}
      role={onAgentClick ? 'button' : undefined}
      tabIndex={onAgentClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onAgentClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onAgentClick(agent);
        }
      }}
    >
      {/* Avatar with pulse ring when active */}
      <div style={{ position: 'relative' }}>
        {isActive && (
          <div style={{
            position: 'absolute',
            inset: '-5px',
            borderRadius: '50%',
            border: '2px solid var(--tf-success)',
            opacity: 0.8,
            animation: 'pulse-ring 1.8s ease-out infinite',
          }} />
        )}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{
            backgroundColor: color,
            color: 'var(--tf-bg)',
            position: 'relative',
            ...(isActive ? { boxShadow: `0 0 8px ${color}66` } : {}),
          }}
        >
          {initial}
        </div>
        {/* Small green dot indicator */}
        {isActive && (
          <div style={{
            position: 'absolute',
            bottom: -1,
            right: -1,
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            backgroundColor: 'var(--tf-success)',
            border: '2px solid var(--tf-surface-raised)',
            boxShadow: '0 0 4px rgba(63,185,80,0.5)',
          }} />
        )}
      </div>
      <p className="text-xs font-medium text-center leading-tight" style={{ color: isActive ? 'var(--tf-success)' : 'var(--tf-text)' }}>
        {agent.name}
      </p>
      <p className="text-xs text-center leading-tight" style={{ color: 'var(--tf-text-muted)' }}>
        {displayRole ?? agent.role}
      </p>
      {/* Show live activity label when working */}
      {activityLabel && !muted ? (
        <p
          className="text-xs text-center leading-tight animate-pulse-dot"
          style={{
            color: blocked ? 'var(--tf-error)' : 'var(--tf-success)',
            maxWidth: '96px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 500,
          }}
          title={activityLabel}
        >
          {activityLabel}
        </p>
      ) : null}
    </div>
  );
}

// ---- Agent detail modal ----
interface AgentDetailModalProps {
  agent: Agent;
  onClose: () => void;
}
function AgentDetailModal({ agent, onClose }: AgentDetailModalProps) {
  const color = modelColor(effectiveModel(agent));
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
          Runtime: <span style={{ color: 'var(--tf-text-secondary)' }}>{runtimeLabel(agent)}</span>
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

type FlowDirection = 'down' | 'up' | null;

function orgEdgeKey(parentId: string, childId: string): string {
  return `${parentId}>${childId}`;
}

function findPathToNode(node: OrgTreeNode, targetId: string, path: string[] = []): string[] | null {
  const nextPath = [...path, node.id];
  if (node.id === targetId) return nextPath;
  for (const child of node.children ?? []) {
    const childPath = findPathToNode(child, targetId, nextPath);
    if (childPath) return childPath;
  }
  return null;
}

interface TreeNodeProps {
  node: OrgTreeNode;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
  recentActiveIds: Set<string>;
  activeIds: Set<string>;
  mutedAgentIds: Set<string>;
  flowEdgeDirections: Map<string, FlowDirection>;
  activeTaskByAgent: Map<string, string>;
  blockedAgentIds: Set<string>;
}

function TreeNode({
  node,
  agentMap,
  onAgentClick,
  recentActiveIds,
  activeIds,
  mutedAgentIds,
  flowEdgeDirections,
  activeTaskByAgent,
  blockedAgentIds,
}: TreeNodeProps) {
  const agent = agentMap.get(node.id);
  const children = node.children ?? [];

  if (!agent) return null;

  const hasChildren = children.length > 0;
  const recentlyActive = recentActiveIds.has(node.id);
  const muted = mutedAgentIds.has(node.id);
  const blocked = blockedAgentIds.has(node.id);
  const childSubtreeActive = children.some((c) => subtreeHasActive(c, activeIds))
    || children.some((c) => flowEdgeDirections.has(orgEdgeKey(node.id, c.id)));
  const firstFlowEdge = children.find((c) => flowEdgeDirections.has(orgEdgeKey(node.id, c.id)));
  const stemDirection: FlowDirection = firstFlowEdge
    ? (flowEdgeDirections.get(orgEdgeKey(node.id, firstFlowEdge.id)) || 'down')
    : 'down';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Tooltip content={`${node.displayRole ?? agent.role} · ${runtimeLabel(agent)}`} position="top">
        <OrgNode
          agent={agent}
          displayRole={node.displayRole}
          onAgentClick={onAgentClick}
          recentlyActive={recentlyActive}
          muted={muted}
          blocked={blocked}
          activeTaskLabel={activeTaskByAgent.get(node.id)}
        />
      </Tooltip>

      {hasChildren && (
        <>
          {/* Vertical stem: animated if any child's subtree is active */}
          <Connector vertical size={24} active={childSubtreeActive} flowDirection={stemDirection} />
          <ChildrenGroup
            node={node}
            agentMap={agentMap}
            onAgentClick={onAgentClick}
            recentActiveIds={recentActiveIds}
            activeIds={activeIds}
            mutedAgentIds={mutedAgentIds}
            flowEdgeDirections={flowEdgeDirections}
            activeTaskByAgent={activeTaskByAgent}
            blockedAgentIds={blockedAgentIds}
          />
        </>
      )}
    </div>
  );
}

interface ChildrenGroupProps {
  node: OrgTreeNode;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
  recentActiveIds: Set<string>;
  activeIds: Set<string>;
  mutedAgentIds: Set<string>;
  flowEdgeDirections: Map<string, FlowDirection>;
  activeTaskByAgent: Map<string, string>;
  blockedAgentIds: Set<string>;
}

function ChildrenGroup({
  node,
  agentMap,
  onAgentClick,
  recentActiveIds,
  activeIds,
  mutedAgentIds,
  flowEdgeDirections,
  activeTaskByAgent,
  blockedAgentIds,
}: ChildrenGroupProps) {
  const children = node.children ?? [];
  const visibleChildren = children.filter((c) => agentMap.has(c.id));

  if (visibleChildren.length === 0) return null;

  if (visibleChildren.length === 1) {
    const edgeKey = orgEdgeKey(node.id, visibleChildren[0].id);
    const edgeInFlow = flowEdgeDirections.has(edgeKey);
    const childActive = edgeInFlow || subtreeHasActive(visibleChildren[0], activeIds);
    const edgeDirection = flowEdgeDirections.get(edgeKey) || 'down';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Connector vertical size={20} active={childActive} flowDirection={edgeDirection} />
        <TreeNode
          node={visibleChildren[0]}
          agentMap={agentMap}
          onAgentClick={onAgentClick}
          recentActiveIds={recentActiveIds}
          activeIds={activeIds}
          mutedAgentIds={mutedAgentIds}
          flowEdgeDirections={flowEdgeDirections}
          activeTaskByAgent={activeTaskByAgent}
          blockedAgentIds={blockedAgentIds}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }}>
      {visibleChildren.map((child, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === visibleChildren.length - 1;
        const edgeKey = orgEdgeKey(node.id, child.id);
        const edgeInFlow = flowEdgeDirections.has(edgeKey);
        const childActive = edgeInFlow || subtreeHasActive(child, activeIds);
        const edgeDirection: FlowDirection = flowEdgeDirections.get(edgeKey) || 'down';

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
                  className={edgeDirection === 'up' ? 'anim-flow-left' : 'anim-flow-right'}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    width: '50%',
                    background: edgeDirection === 'up'
                      ? 'linear-gradient(to left, transparent, var(--tf-success), transparent)'
                      : 'linear-gradient(to right, transparent, var(--tf-success), transparent)',
                  }}
                />
              )}
            </div>

            {/* Vertical stub to child */}
            <Connector vertical size={20} active={childActive} flowDirection={edgeDirection} />
            <TreeNode
              node={child}
              agentMap={agentMap}
              onAgentClick={onAgentClick}
              recentActiveIds={recentActiveIds}
              activeIds={activeIds}
              mutedAgentIds={mutedAgentIds}
              flowEdgeDirections={flowEdgeDirections}
              activeTaskByAgent={activeTaskByAgent}
              blockedAgentIds={blockedAgentIds}
            />
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
  activeProjectId?: string;
  microProjectMode?: boolean;
  liveAgents?: Map<string, ActiveAgentInfo>;
}

function OrgChart({ agents, loading, events, activeProjectId = '', microProjectMode = false, liveAgents }: OrgChartProps) {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const hierarchyViewportRef = useRef<HTMLDivElement | null>(null);
  const hierarchyContentRef = useRef<HTMLDivElement | null>(null);
  const [layoutMode, setLayoutMode] = useState<'hierarchy' | 'cluster' | 'timeline'>('hierarchy');
  const [hierarchyScale, setHierarchyScale] = useState(1);
  const [hierarchyHeight, setHierarchyHeight] = useState<number | null>(null);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const scopedEvents = useMemo(() => {
    if (!activeProjectId) return events;
    const byProject = events.filter((evt) => (evt.project_id || '') === activeProjectId);
    return byProject.length > 0 ? byProject : events;
  }, [events, activeProjectId]);

  // Set of recently active IDs inferred from live activity events + liveAgents.
  const recentActiveIds = useMemo(() => {
    const s = new Set<string>();
    for (const agent of agents) {
      if (microProjectMode && agent.id !== 'ceo') continue;
      if (isAgentRecentlyActive(agent.id, agent.name, scopedEvents)) {
        s.add(agent.id);
      }
    }
    // Merge real-time delegation tracking from App.tsx
    if (liveAgents) {
      for (const [id] of liveAgents) {
        if (microProjectMode && id !== 'ceo') continue;
        s.add(id);
      }
    }
    return s;
  }, [agents, scopedEvents, microProjectMode, liveAgents]);

  // Broader active set to drive connector highlights even when events are sparse.
  const activeIds = useMemo(() => {
    const s = new Set(recentActiveIds);
    for (const agent of agents) {
      if (microProjectMode && agent.id !== 'ceo') continue;
      if (agent.status === 'active') s.add(agent.id);
      if ((agent.recent_activity ?? []).length > 0) s.add(agent.id);
    }
    return s;
  }, [agents, recentActiveIds, microProjectMode]);

  const aliasToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      map.set(agent.id.toLowerCase(), agent.id);
      map.set(agent.name.toLowerCase(), agent.id);
      map.set(agent.role.toLowerCase(), agent.id);
    }
    return map;
  }, [agents]);

  const latestFlow = useMemo((): {
    edgeDirections: Map<string, FlowDirection>;
    activeTaskByAgent: Map<string, string>;
    blockedAgentIds: Set<string>;
  } => {
    if (microProjectMode) {
      return {
        edgeDirections: new Map<string, FlowDirection>(),
        activeTaskByAgent: new Map<string, string>(),
        blockedAgentIds: new Set<string>(),
      };
    }
    const FLOW_WINDOW_MS = 12_000;
    const latestEventTimestamp = scopedEvents.length > 0
      ? new Date(scopedEvents[scopedEvents.length - 1].timestamp || '').getTime()
      : 0;
    const edgeDirections = new Map<string, FlowDirection>();
    const activeTaskByAgent = new Map<string, string>();
    const blockedAgentIds = new Set<string>();
    const trackedFlows = new Set<string>();

    const addEdgeDirection = (edgeKey: string, direction: FlowDirection) => {
      if (edgeDirections.has(edgeKey)) {
        edgeDirections.delete(edgeKey);
      }
      edgeDirections.set(edgeKey, direction);
      while (edgeDirections.size > 2) {
        const first = edgeDirections.keys().next().value;
        if (!first) break;
        edgeDirections.delete(first);
      }
    };

    const safeAgentId = (value: unknown): string => {
      const normalized = String(value || '').trim().toLowerCase();
      if (!normalized) return '';
      return aliasToId.get(normalized) || normalized;
    };

    const buildFlowToAgent = (agentId: string, direction: FlowDirection, task: string) => {
      if (!agentId || agentId === 'ceo') return null;
      const targetPath = findPathToNode(ORG_TREE, agentId);
      if (!targetPath || targetPath.length < 2) return null;
      const flowKey = `${agentId}:${direction}`;
      if (trackedFlows.has(flowKey)) return null;
      trackedFlows.add(flowKey);
      for (let i = 0; i < targetPath.length - 1; i += 1) {
        addEdgeDirection(orgEdgeKey(targetPath[i], targetPath[i + 1]), direction);
      }
      if (task) {
        activeTaskByAgent.set(agentId, task.slice(0, 70));
      }
      return true;
    };

    for (let idx = scopedEvents.length - 1; idx >= 0; idx -= 1) {
      const evt = scopedEvents[idx];
      const evtTs = evt.timestamp ? new Date(evt.timestamp).getTime() : 0;
      if (
        latestEventTimestamp
        && Number.isFinite(latestEventTimestamp)
        && evtTs
        && Number.isFinite(evtTs)
        && latestEventTimestamp - evtTs > FLOW_WINDOW_MS
      ) {
        continue;
      }
      const meta = (evt.metadata || {}) as Record<string, unknown>;
      const sourceMeta = safeAgentId(meta.source_agent ?? meta.from_agent);
      const targetMeta = safeAgentId(meta.target_agent ?? meta.to_agent);
      const flowMeta = String(meta.flow || '').toLowerCase();
      const taskText = String(meta.task || evt.detail || evt.action || '').trim();
      if (flowMeta === 'blocked') {
        if (sourceMeta) blockedAgentIds.add(sourceMeta);
        if (targetMeta) blockedAgentIds.add(targetMeta);
      }
      if (sourceMeta && targetMeta && sourceMeta !== targetMeta) {
        if (sourceMeta === 'ceo' && targetMeta !== 'ceo') {
          buildFlowToAgent(targetMeta, 'down', taskText);
          if (edgeDirections.size >= 2) break;
        }
        if (targetMeta === 'ceo' && sourceMeta !== 'ceo') {
          buildFlowToAgent(sourceMeta, 'up', taskText);
          if (edgeDirections.size >= 2) break;
        }
      }

      const detail = (evt.detail || '').toLowerCase();
      const downMatch = detail.match(/delegating to ([a-z0-9\- ]+)/i);
      if (downMatch) {
        buildFlowToAgent(safeAgentId(downMatch[1].trim()), 'down', taskText);
        if (edgeDirections.size >= 2) break;
      }
      const upMatch = detail.match(/(update|result|response) from ([a-z0-9\- ]+)/i);
      if (upMatch) {
        buildFlowToAgent(safeAgentId(upMatch[2].trim()), 'up', taskText);
        if (edgeDirections.size >= 2) break;
      }
    }
    // Merge liveAgents: add flow edges + task labels for actively delegated agents
    if (liveAgents) {
      for (const [agentId, info] of liveAgents) {
        if (agentId === 'ceo' || (microProjectMode && agentId !== 'ceo')) continue;
        const direction: FlowDirection = info.flow === 'up' ? 'up' : 'down';
        buildFlowToAgent(agentId, direction, info.task || '');
        if (info.task && !activeTaskByAgent.has(agentId)) {
          activeTaskByAgent.set(agentId, info.task.slice(0, 70));
        }
      }
    }
    return { edgeDirections, activeTaskByAgent, blockedAgentIds };
  }, [aliasToId, scopedEvents, microProjectMode, liveAgents]);

  const mutedAgentIds = useMemo(() => {
    if (!microProjectMode) return new Set<string>();
    const s = new Set<string>();
    for (const agent of agents) {
      if (agent.id !== 'ceo') s.add(agent.id);
    }
    return s;
  }, [agents, microProjectMode]);

  const handleAgentClick = (agent: Agent) => {
    setSelectedAgent(prev => prev?.id === agent.id ? null : agent);
  };

  const workloadMap = useMemo(() => {
    const out = new Map<string, number>();
    for (const evt of scopedEvents) {
      const key = (evt.agent || '').toLowerCase();
      if (!key) continue;
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  }, [scopedEvents]);

  const handoffPairs = useMemo(() => {
    if (microProjectMode) return [] as Array<[string, number]>;

    const knownAgentIds = new Set(agents.map((agent) => agent.id.toLowerCase()));
    const displayNameById = new Map<string, string>();
    for (const agent of agents) {
      displayNameById.set(agent.id.toLowerCase(), agent.name);
    }
    displayNameById.set('ceo', 'CEO');

    const normalizeAgentId = (value: unknown): string => {
      const normalized = String(value || '').trim().toLowerCase();
      if (!normalized) return '';
      return aliasToId.get(normalized) || normalized;
    };

    const edges = new Map<string, number>();
    for (const evt of scopedEvents) {
      const metadata = (evt.metadata || {}) as Record<string, unknown>;
      let source = normalizeAgentId(metadata.source_agent ?? metadata.from_agent ?? evt.agent);
      let target = normalizeAgentId(metadata.target_agent ?? metadata.to_agent);

      if (!source || !target) {
        const detail = String(evt.detail || '').toLowerCase();
        const downMatch = detail.match(/delegating to ([a-z0-9\- ]+)/i);
        if (downMatch) {
          source = 'ceo';
          target = normalizeAgentId(downMatch[1].trim());
        } else {
          const upMatch = detail.match(/(update|result|response) from ([a-z0-9\- ]+)/i);
          if (upMatch) {
            source = normalizeAgentId(upMatch[2].trim());
            target = 'ceo';
          }
        }
      }

      if (!source || !target || source === target) continue;
      if (!knownAgentIds.has(source) || !knownAgentIds.has(target)) continue;
      if (!(source === 'ceo' || target === 'ceo')) continue;

      const sourceName = displayNameById.get(source) || source;
      const targetName = displayNameById.get(target) || target;
      const key = `${sourceName} -> ${targetName}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }

    return Array.from(edges.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [agents, aliasToId, scopedEvents, microProjectMode]);

  const timelineEvents = useMemo(() => {
    return [...scopedEvents]
      .filter((e) => e.agent || e.detail)
      .slice(-220)
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  }, [scopedEvents]);

  useEffect(() => {
    if (layoutMode !== 'hierarchy') return;
    const viewport = hierarchyViewportRef.current;
    const content = hierarchyContentRef.current;
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const available = Math.max(0, viewport.clientWidth - 6);
      const naturalWidth = content.scrollWidth;
      const naturalHeight = content.scrollHeight;
      if (!available || !naturalWidth || !naturalHeight) return;
      const widthRatio = available / naturalWidth;
      const nextScale = naturalWidth > available
        ? Math.max(0.12, Math.min(1, widthRatio))
        : 1;
      setHierarchyScale(nextScale);
      setHierarchyHeight(Math.ceil(naturalHeight * nextScale));
    };

    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(viewport);
    observer.observe(content);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [layoutMode, agents.length, scopedEvents.length]);

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

  const ceoAgent = agentMap.get('ceo');
  const laneSections = [
    { title: 'Leadership', ids: ['cto', 'cfo', 'ciso', 'vp-product', 'vp-engineering', 'chief-researcher'] },
    { title: 'Product + Design', ids: ['lead-designer', 'tech-writer'] },
    { title: 'Engineering', ids: ['lead-backend', 'lead-frontend', 'qa-lead', 'devops'] },
    { title: 'Specialists', ids: ['security-engineer', 'data-engineer'] },
  ] as const;

  const activeAgentCount = activeIds.size;

  // Build a short list of active agent names for the status badge
  const activeAgentNames = useMemo(() => {
    const names: string[] = [];
    for (const id of activeIds) {
      const a = agentMap.get(id);
      if (a) names.push(a.name);
    }
    return names;
  }, [activeIds, agentMap]);

  return (
    <div ref={chartContainerRef} style={{ maxWidth: '100%', overflow: 'hidden' }}>
      {/* Chart label with active agent count */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '6px',
          marginBottom: '20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <p
            style={{
              fontSize: '10px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: 'var(--tf-text-muted)',
            }}
          >
            Organization Chart
          </p>
          {activeAgentCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '10px',
                fontWeight: 600,
                backgroundColor: activeAgentCount > 1 ? 'rgba(63,185,80,0.12)' : 'rgba(63,185,80,0.08)',
                color: 'var(--tf-success)',
                border: '1px solid rgba(63,185,80,0.25)',
              }}
            >
              <span
                style={{
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--tf-success)',
                  animation: 'pulse-ring 1.8s ease-out infinite',
                }}
              />
              {activeAgentCount} active{activeAgentCount > 1 ? ' — collaborating' : ''}
            </span>
          )}
        </div>
        {activeAgentNames.length > 0 && (
          <p style={{ fontSize: '11px', color: 'var(--tf-success)', fontWeight: 500, textAlign: 'center' }}>
            {activeAgentNames.join(', ')}
          </p>
        )}
      </div>
      {activeProjectId && (
        <p
          style={{
            marginTop: '-12px',
            marginBottom: '10px',
            textAlign: 'center',
            fontSize: '10px',
            color: 'var(--tf-text-muted)',
          }}
        >
          Focused on project: {activeProjectId}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '14px' }}>
        {(['hierarchy', 'cluster', 'timeline'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setLayoutMode(mode)}
            style={{
              borderRadius: '999px',
              border: `1px solid ${layoutMode === mode ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
              backgroundColor: layoutMode === mode ? 'rgba(59,142,255,0.12)' : 'var(--tf-surface)',
              color: layoutMode === mode ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)',
              fontSize: '11px',
              fontWeight: 600,
              padding: '4px 10px',
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {mode}
          </button>
        ))}
      </div>

      {layoutMode === 'timeline' ? (
        <div style={{ border: '1px solid var(--tf-border)', borderRadius: '10px', backgroundColor: 'var(--tf-surface-raised)', maxHeight: '320px', overflowY: 'auto' }}>
          {timelineEvents.length === 0 ? (
            <p className="text-xs py-4 text-center" style={{ color: 'var(--tf-text-muted)' }}>No timeline data yet.</p>
          ) : (
            timelineEvents.map((evt, idx) => (
              <div key={`${evt.timestamp}-${idx}`} style={{ padding: '8px 10px', borderBottom: '1px solid var(--tf-border)' }}>
                <div className="text-xs font-semibold" style={{ color: 'var(--tf-text-secondary)' }}>{evt.agent || 'System'} · {evt.action}</div>
                <div className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>{evt.detail || '(no detail)'}</div>
              </div>
            ))
          )}
        </div>
      ) : (layoutMode === 'cluster') ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {ceoAgent && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                paddingBottom: '8px',
                borderBottom: '1px dashed var(--tf-border)',
              }}
            >
              <Tooltip content={`${ceoAgent.role} · ${runtimeLabel(ceoAgent)}`} position="top">
                <div style={{ transform: 'scale(1.04)', transformOrigin: 'center top' }}>
                  <OrgNode
                    agent={ceoAgent}
                    onAgentClick={handleAgentClick}
                    recentlyActive={activeIds.has(ceoAgent.id)}
                  />
                </div>
              </Tooltip>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '10px',
            }}
          >
            {laneSections.map((section) => {
              const sectionAgents = section.ids
                .map((id) => agentMap.get(id))
                .filter(Boolean) as Agent[];

              if (sectionAgents.length === 0) return null;

              return (
                <div
                  key={section.title}
                  style={{
                    border: '1px solid var(--tf-border)',
                    borderRadius: '10px',
                    backgroundColor: 'var(--tf-surface-raised)',
                    padding: '10px',
                  }}
                >
                  <p
                    style={{
                      fontSize: '10px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: 'var(--tf-text-muted)',
                      marginBottom: '8px',
                    }}
                  >
                    {section.title}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {sectionAgents.map((agent) => {
                      const active = activeIds.has(agent.id);
                      const workload = workloadMap.get(agent.name.toLowerCase()) || workloadMap.get(agent.id.toLowerCase()) || 0;
                      const mutedInMicro = microProjectMode && agent.id !== 'ceo';
                      return (
                        <button
                          key={agent.id}
                          onClick={() => handleAgentClick(agent)}
                          className={active && !mutedInMicro ? 'org-node-active' : ''}
                          style={{
                            border: `1.5px solid ${active && !mutedInMicro ? 'var(--tf-success)' : 'var(--tf-border)'}`,
                            backgroundColor: active && !mutedInMicro ? 'rgba(63,185,80,0.15)' : 'var(--tf-surface)',
                            color: active && !mutedInMicro ? 'var(--tf-success)' : 'var(--tf-text)',
                            borderRadius: '999px',
                            padding: '4px 9px',
                            fontSize: '11px',
                            fontWeight: active && !mutedInMicro ? 600 : 400,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            opacity: mutedInMicro ? 0.42 : 1,
                            filter: mutedInMicro ? 'grayscale(32%)' : 'none',
                          }}
                          title={mutedInMicro ? `${agent.role} · ${runtimeLabel(agent)} · Inactive in Micro mode` : `${agent.role} · ${runtimeLabel(agent)}`}
                        >
                          <span
                            style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              backgroundColor: active && !mutedInMicro ? 'var(--tf-success)' : 'var(--tf-text-muted)',
                              flexShrink: 0,
                            }}
                          />
                          {agent.name}
                          <span style={{ fontSize: '10px', color: 'var(--tf-text-muted)' }}>{workload}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          ref={hierarchyViewportRef}
          style={{
            overflow: 'hidden',
            padding: '8px 8px 16px',
            maxWidth: '100%',
            minHeight: hierarchyHeight ? `${hierarchyHeight}px` : undefined,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              minWidth: '100%',
              margin: '0 auto',
            }}
          >
            <div
              ref={hierarchyContentRef}
              style={{
                width: 'max-content',
                minWidth: 'max-content',
                transform: `scale(${hierarchyScale})`,
                transformOrigin: 'top center',
                transition: 'transform 220ms ease',
              }}
            >
              <TreeNode
                node={ORG_TREE}
                agentMap={agentMap}
                onAgentClick={handleAgentClick}
                recentActiveIds={recentActiveIds}
                activeIds={activeIds}
                mutedAgentIds={mutedAgentIds}
                flowEdgeDirections={latestFlow.edgeDirections}
                activeTaskByAgent={latestFlow.activeTaskByAgent}
                blockedAgentIds={latestFlow.blockedAgentIds}
              />
            </div>
          </div>
        </div>
      )}

      {/* Agent detail panel */}
      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}

      <div style={{ marginTop: '12px', display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div style={{ border: '1px solid var(--tf-border)', borderRadius: '10px', padding: '10px', backgroundColor: 'var(--tf-surface)' }}>
          <p style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tf-text-muted)', marginBottom: '6px' }}>
            Capability Snapshot
          </p>
          {agents.slice(0, 4).map((agent) => {
            const load = workloadMap.get(agent.name.toLowerCase()) || workloadMap.get(agent.id.toLowerCase()) || 0;
            const pct = Math.max(6, Math.min(100, load * 8));
            return (
              <div key={agent.id} style={{ marginBottom: '6px' }}>
                <div style={{ fontSize: '11px', color: 'var(--tf-text-secondary)' }}>{agent.name}</div>
                <div style={{ height: '4px', borderRadius: '999px', backgroundColor: 'var(--tf-surface-raised)' }}>
                  <div style={{ width: `${pct}%`, height: '100%', borderRadius: '999px', backgroundColor: 'var(--tf-accent-blue)' }} />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ border: '1px solid var(--tf-border)', borderRadius: '10px', padding: '10px', backgroundColor: 'var(--tf-surface)' }}>
          <p style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tf-text-muted)', marginBottom: '6px' }}>
            Handoff Map
          </p>
          {handoffPairs.length === 0 ? (
            <p style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>No handoffs detected yet.</p>
          ) : (
            handoffPairs.map(([edge, count]) => (
              <div key={edge} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--tf-text-secondary)', marginBottom: '4px' }}>
                <span>{edge}</span>
                <span style={{ color: 'var(--tf-accent)' }}>{count}</span>
              </div>
            ))
          )}
        </div>
      </div>
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
// ---- Activity heatmap (GitHub-style) ----

function ActivityHeatmap({ events }: { events: ActivityEvent[] }) {
  const WEEKS = 15;
  const DAYS = 7;
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  // Build a map of dateStr → count
  const countByDay = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of events) {
      if (!e.timestamp) continue;
      try {
        const d = new Date(e.timestamp);
        const key = d.toISOString().slice(0, 10);
        map[key] = (map[key] ?? 0) + 1;
      } catch { /* skip */ }
    }
    return map;
  }, [events]);

  // Build grid: WEEKS columns × 7 rows (Mon–Sun)
  const grid: Array<Array<{ dateStr: string; count: number; inFuture: boolean }>> = [];
  for (let w = 0; w < WEEKS; w++) {
    const col: Array<{ dateStr: string; count: number; inFuture: boolean }> = [];
    for (let d = 0; d < DAYS; d++) {
      const offset = (WEEKS - 1 - w) * 7 + (DAYS - 1 - d);
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const dateStr = date.toISOString().slice(0, 10);
      const inFuture = date > today;
      col.push({ dateStr, count: countByDay[dateStr] ?? 0, inFuture });
    }
    grid.push(col);
  }

  const maxCount = Math.max(1, ...Object.values(countByDay));

  function cellColor(count: number, inFuture: boolean): string {
    if (inFuture || count === 0) return 'var(--tf-surface-raised)';
    const intensity = Math.min(count / maxCount, 1);
    if (intensity < 0.25) return 'rgba(63,185,80,0.2)';
    if (intensity < 0.5)  return 'rgba(63,185,80,0.45)';
    if (intensity < 0.75) return 'rgba(63,185,80,0.7)';
    return 'rgba(63,185,80,0.95)';
  }

  const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
          Activity Heatmap
        </h3>
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>{events.length} events · past {WEEKS} weeks</span>
      </div>
      <div style={{ display: 'flex', gap: '3px', alignItems: 'flex-start' }}>
        {/* Day labels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginRight: '4px', paddingTop: '0px' }}>
          {DAY_LABELS.map((l, i) => (
            <div key={i} style={{ width: '12px', height: '12px', fontSize: '9px', color: 'var(--tf-text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{l}</div>
          ))}
        </div>
        {/* Weeks */}
        {grid.map((col, w) => (
          <div key={w} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {col.map((cell, d) => (
              <div
                key={d}
                title={cell.count > 0 ? `${cell.dateStr}: ${cell.count} event${cell.count !== 1 ? 's' : ''}` : cell.dateStr}
                style={{
                  width: '12px', height: '12px', borderRadius: '2px',
                  backgroundColor: cellColor(cell.count, cell.inFuture),
                  cursor: 'default', transition: 'transform 0.1s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.3)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
              />
            ))}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-3">
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>Less</span>
        {['var(--tf-surface-raised)', 'rgba(63,185,80,0.2)', 'rgba(63,185,80,0.45)', 'rgba(63,185,80,0.7)', 'rgba(63,185,80,0.95)'].map((c, i) => (
          <div key={i} style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: c }} />
        ))}
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>More</span>
      </div>
    </div>
  );
}

// ---- Widget configuration ----
const WIDGETS_STORAGE_KEY = 'tf_overview_widgets';
const ALL_WIDGETS = ['stats', 'orgchart', 'tasks', 'projects', 'heatmap'] as const;
type WidgetId = typeof ALL_WIDGETS[number];
const WIDGET_LABELS: Record<WidgetId, string> = {
  stats:    'Stat Cards',
  orgchart: 'Org Chart',
  tasks:    'Task Status',
  projects: 'Project Progress',
  heatmap:  'Activity Heatmap',
};

function loadWidgets(): Record<WidgetId, boolean> {
  try {
    const stored = localStorage.getItem(WIDGETS_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return { stats: true, orgchart: true, tasks: true, projects: true, heatmap: true };
}

export default function Overview({
  agents,
  projects,
  tasks,
  events,
  activeProjectId = '',
  microProjectMode = false,
  loadingAgents,
  loadingProjects,
  loadingTasks,
  liveAgents,
}: OverviewProps) {
  const [widgets, setWidgets] = useState<Record<WidgetId, boolean>>(loadWidgets);
  const [showWidgetMenu, setShowWidgetMenu] = useState(false);

  const toggleWidget = (id: WidgetId) => {
    setWidgets((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem(WIDGETS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Compute task status distribution
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    return counts;
  }, [tasks]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Widget config toolbar */}
      <div className="flex justify-end">
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowWidgetMenu((v) => !v)}
            className="text-xs px-3 py-1.5 rounded-lg cursor-pointer flex items-center gap-1.5 transition-all"
            style={{
              backgroundColor: showWidgetMenu ? 'var(--tf-surface-raised)' : 'var(--tf-surface)',
              color: 'var(--tf-text-secondary)',
              border: '1px solid var(--tf-border)',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            Widgets
          </button>
          {showWidgetMenu && (
            <div
              className="absolute right-0 top-full mt-1 rounded-xl overflow-hidden z-20"
              style={{ minWidth: '180px', backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}
            >
              <p className="px-3 py-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)', borderBottom: '1px solid var(--tf-border)' }}>
                Toggle Widgets
              </p>
              {ALL_WIDGETS.map((id) => (
                <button
                  key={id}
                  onClick={() => toggleWidget(id)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs cursor-pointer transition-all"
                  style={{ color: 'var(--tf-text)', backgroundColor: 'transparent' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                >
                  {WIDGET_LABELS[id]}
                  <span style={{ color: widgets[id] ? 'var(--tf-success)' : 'var(--tf-text-muted)' }}>
                    {widgets[id] ? '✓' : '○'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Stat cards */}
      {widgets.stats && (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Agents"      value={agents.length.toString()}  color="var(--tf-accent)"       loading={loadingAgents} />
          <StatCard label="Projects"    value={projects.length.toString()} color="var(--tf-accent-blue)"  loading={loadingProjects} />
          <StatCard label="Tasks"       value={tasks.length.toString()}    color="var(--tf-success)"      loading={loadingTasks} />
          <StatCard label="Live Events" value={events.length.toString()}   color="var(--tf-warning)"      loading={false} />
        </div>
      )}

      {/* Org chart */}
      {widgets.orgchart && (
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)', overflow: 'hidden' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--tf-text-muted)' }}>
            Organization Hierarchy
          </h3>
          <OrgChart
            agents={agents}
            loading={loadingAgents}
            events={events}
            activeProjectId={activeProjectId}
            microProjectMode={microProjectMode}
            liveAgents={liveAgents}
          />
        </div>
      )}

      {/* Task status + Project progress row */}
      {(widgets.tasks || widgets.projects) && (
        <div className={`grid gap-6 ${widgets.tasks && widgets.projects ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'}`}>
          {widgets.tasks && (
            <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
              <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--tf-text-muted)' }}>
                Task Status Summary
              </h3>
              {loadingTasks ? (
                <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
              ) : Object.keys(statusCounts).length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>No tasks loaded</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).map(([status, count]) => {
                    const pct = tasks.length > 0 ? Math.round((count / tasks.length) * 100) : 0;
                    const color = taskStatusColor(status);
                    return (
                      <div key={status} className="flex flex-col gap-1">
                        <div className="flex justify-between">
                          <span className="text-xs capitalize" style={{ color: 'var(--tf-text)' }}>{status.replace(/_/g, ' ')}</span>
                          <span className="text-xs" style={{ color }}>{count} ({pct}%)</span>
                        </div>
                        <div className="h-1.5 rounded-full" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {widgets.projects && (
            <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
              <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--tf-text-muted)' }}>
                Project Progress
              </h3>
              {loadingProjects ? (
                <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : projects.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>No projects found</p>
              ) : (
                <div className="space-y-4">{projects.map((p) => <ProjectProgress key={p.id} project={p} />)}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Activity heatmap */}
      {widgets.heatmap && <ActivityHeatmap events={events} />}
    </div>
  );
}
