import { useState, useMemo, useRef, useEffect } from 'react';
import type {
  Agent,
  Project,
  Task,
  ActivityEvent,
  OverviewVisualizationMode,
  WorkforceLiveSnapshot,
  WorkforceState,
  WorkforceWorker,
  OrgActivationEntry,
  OrgActivationPhase,
  OrgConnectorActivityMode,
  OrgMotionMode,
  OrgNodeDecor,
  OrgNodeState,
  OrgVisualTier,
  RealWorldAgentPose,
  RealWorldBubbleState,
  RealWorldFrameState,
  RealWorldMovementStage,
  RealWorldSpriteManifest,
  RealWorldZone,
} from '../types';
import Tooltip from './Tooltip';

interface OverviewProps {
  agents: Agent[];
  projects: Project[];
  tasks: Task[];
  events: ActivityEvent[];
  liveEventCount?: number;
  streamSource?: 'SSE' | 'Poll';
  activeProjectId?: string;
  microProjectMode?: boolean;
  loadingAgents: boolean;
  loadingProjects: boolean;
  loadingTasks: boolean;
  workforceLive?: WorkforceLiveSnapshot;
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

function liveStateVisual(state?: WorkforceState): { color: string; bg: string; pulse: boolean } {
  switch (state) {
    case 'working':
      return { color: 'var(--tf-success)', bg: 'rgba(63,185,80,0.14)', pulse: true };
    case 'assigned':
      return { color: 'var(--tf-warning)', bg: 'rgba(240,170,74,0.12)', pulse: false };
    case 'reporting':
      return { color: 'var(--tf-accent-blue)', bg: 'rgba(59,142,255,0.12)', pulse: false };
    case 'blocked':
      return { color: 'var(--tf-error)', bg: 'rgba(234,114,103,0.12)', pulse: false };
    default:
      return { color: 'var(--tf-border)', bg: 'var(--tf-surface-raised)', pulse: false };
  }
}

// Normalize agent identifier to canonical slug format (spaces → dashes, lowercase)
function toAgentSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

function formatElapsedSeconds(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${secs.toString().padStart(2, '0')}s`;
  return `${secs}s`;
}

function formatClock(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatFreshness(iso?: string): string {
  if (!iso) return 'not synced yet';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return 'not synced yet';
  const deltaMs = Math.max(0, Date.now() - ts);
  if (deltaMs < 1000) return 'just now';
  if (deltaMs < 60_000) return `${Math.floor(deltaMs / 1000)}s ago`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  return `${Math.floor(deltaMs / 3_600_000)}h ago`;
}

function liveStateLabel(state: WorkforceState): string {
  if (state === 'working') return 'Working';
  if (state === 'assigned') return 'Assigned';
  if (state === 'reporting') return 'Reporting';
  return 'Blocked';
}

function liveWhyTitle(row: WorkforceWorker): string {
  const bits = [
    `State: ${liveStateLabel(row.state)}`,
    row.task ? `Task: ${row.task}` : '',
    row.run_id ? `Run: ${row.run_id}` : '',
    row.source ? `Source: ${row.source}` : '',
    row.project_id ? `Project: ${row.project_id}` : '',
    row.started_at ? `Started: ${formatClock(row.started_at)}` : '',
    `Elapsed: ${formatElapsedSeconds(row.elapsed_seconds)}`,
  ].filter(Boolean);
  return bits.join('\n');
}

const ORG_EXECUTIVE_IDS = new Set(['ceo']);
const ORG_LEAD_IDS = new Set([
  'cto',
  'cfo',
  'ciso',
  'vp-product',
  'vp-engineering',
  'chief-researcher',
  'lead-backend',
  'lead-frontend',
  'qa-lead',
  'devops',
  'lead-designer',
]);

function toVisualTier(agent: Agent): OrgVisualTier {
  const id = agent.id.toLowerCase();
  if (ORG_EXECUTIVE_IDS.has(id)) return 'executive';
  if (ORG_LEAD_IDS.has(id)) return 'lead';
  const role = String(agent.role || '');
  if (/\bchief\b|\bvp\b|\blead\b/i.test(role)) return 'lead';
  return 'specialist';
}

function toWorkloadScore(count: number, maxCount: number): number {
  if (maxCount <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, count / maxCount));
  return Math.round(ratio * 100);
}

function toStalenessScore(updatedAt?: string): number {
  if (!updatedAt) return 0;
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  const ageMs = Math.max(0, Date.now() - ts);
  const ratio = Math.max(0, Math.min(1, ageMs / (3 * 60_000)));
  return Math.round(ratio * 100);
}

function toMotionMode(
  activeCount: number,
  workingCount: number,
  blockedCount: number,
  stale: boolean,
): OrgMotionMode {
  if (activeCount === 0 && workingCount === 0) return 'quiet';
  if (stale) return 'quiet';
  if (workingCount >= 3 || blockedCount > 0) return 'intense';
  return 'active';
}

const ORG_PHASE_BASE_DELAY_MS: Record<OrgActivationPhase, number> = {
  executive: 0,
  lead: 260,
  specialist: 560,
};
const ORG_PHASE_STEP_MS: Record<OrgActivationPhase, number> = {
  executive: 110,
  lead: 90,
  specialist: 72,
};

function toActivationPhase(tier: OrgVisualTier): OrgActivationPhase {
  if (tier === 'executive') return 'executive';
  if (tier === 'lead') return 'lead';
  return 'specialist';
}

function toConnectorModeForState(state?: WorkforceState): OrgConnectorActivityMode {
  if (state === 'assigned') return 'assigned';
  if (state === 'working') return 'working';
  if (state === 'reporting') return 'reporting';
  if (state === 'blocked') return 'blocked';
  return 'idle';
}

function toIsoMillis(value?: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : Number.POSITIVE_INFINITY;
}

function stableRunScopedHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function stateOrderForActivation(state?: WorkforceState): number {
  if (state === 'working') return 0;
  if (state === 'reporting') return 1;
  if (state === 'assigned') return 2;
  if (state === 'blocked') return 3;
  return 4;
}

function teamZoneForAgent(agentId: string): RealWorldZone {
  if (agentId === 'ceo' || agentId === 'cto' || agentId === 'cfo' || agentId === 'ciso') return 'executive_row';
  if (agentId === 'vp-product' || agentId === 'lead-designer' || agentId === 'tech-writer') return 'product_pod';
  if (agentId === 'vp-engineering' || agentId === 'lead-backend' || agentId === 'lead-frontend' || agentId === 'devops' || agentId === 'data-engineer') {
    return 'engineering_pod';
  }
  if (agentId === 'qa-lead' || agentId === 'security-engineer') return 'qa_bench';
  if (agentId === 'chief-researcher') return 'research_corner';
  return 'briefing_area';
}

type FlowDirection = 'down' | 'up' | null;

// ---- Animated connector line ----
// Shows directional flow + blocked signal for active branches.
interface OrgConnectorProps {
  vertical?: boolean;
  active?: boolean;
  blocked?: boolean;
  flowDirection?: 'down' | 'up' | null;
  size: number | string; // height for vertical, width for horizontal
  motionMode?: OrgMotionMode;
  activationDelayMs?: number;
}

function OrgConnector({
  vertical = true,
  active = false,
  blocked = false,
  flowDirection = 'down',
  size,
  motionMode = 'quiet',
  activationDelayMs = 0,
}: OrgConnectorProps) {
  const baseColor = blocked
    ? 'rgba(240,170,74,0.62)'
    : active
      ? flowDirection === 'up'
        ? 'rgba(59,142,255,0.78)'
        : 'rgba(63,185,80,0.76)'
      : 'rgba(76,109,146,0.72)';
  const length = typeof size === 'number' ? `${size}px` : size;
  const activeGlow = blocked
    ? '0 0 10px rgba(240,170,74,0.25)'
    : active
      ? flowDirection === 'up'
        ? '0 0 10px rgba(59,142,255,0.24)'
        : '0 0 10px rgba(63,185,80,0.22)'
      : 'none';
  return (
    <div
      className={`org-connector ${active ? 'org-connector--active' : ''} ${blocked ? 'org-connector--blocked' : ''}`}
      style={{
        position: 'relative',
        overflow: 'hidden',
        ...(vertical
          ? { width: '3px', height: length }
          : { height: '3px', width: length }),
        backgroundColor: baseColor,
        transition: 'background-color 0.24s ease, box-shadow 0.24s ease, opacity 0.24s ease',
        transitionDelay: active ? `${activationDelayMs}ms` : '0ms',
        borderRadius: '999px',
        boxShadow: activeGlow,
        opacity: motionMode === 'quiet' && !active ? 0.8 : 1,
      }}
    >
      {blocked && <span className="org-connector-blocked-dot" style={{ animationDelay: `${activationDelayMs}ms` }} />}
    </div>
  );
}

function connectorRailColor(active: boolean, blocked: boolean, flowDirection: FlowDirection): string {
  if (blocked) return 'rgba(240,170,74,0.62)';
  if (active) {
    if (flowDirection === 'up') return 'rgba(59,142,255,0.78)';
    return 'rgba(63,185,80,0.76)';
  }
  return 'rgba(76,109,146,0.72)';
}

// ---- Org hierarchy node ----
interface OrgNodeCardProps {
  agent: Agent;
  decor: OrgNodeDecor;
  motionMode: OrgMotionMode;
  activationDelayMs?: number;
  activationReason?: string;
  displayRole?: string;
  onAgentClick?: (agent: Agent) => void;
  muted?: boolean;
  blocked?: boolean;
  showHeatOverlay?: boolean;
  liveState?: WorkforceState;
  liveWorker?: WorkforceWorker;
}
function OrgNodeCard({
  agent,
  decor,
  motionMode,
  activationDelayMs = 0,
  activationReason,
  displayRole,
  onAgentClick,
  muted = false,
  blocked = false,
  showHeatOverlay = false,
  liveState,
  liveWorker,
}: OrgNodeCardProps) {
  const color = modelColor(effectiveModel(agent));
  const initial = agent.name.charAt(0).toUpperCase();
  const effectiveState: WorkforceState | null = !muted
    ? (liveState || (blocked ? 'blocked' : null))
    : null;
  const visual = liveStateVisual(effectiveState || undefined);
  const isActive = decor.state !== 'idle' && !muted;
  const activityLabel = liveWorker?.task && !muted
    ? liveWorker.task
    : !muted && isActive
      ? liveStateLabel(effectiveState || 'working')
      : null;
  const liveMetaLabel = liveWorker
    ? `${liveWorker.run_id ? `${liveWorker.run_id.slice(0, 10)} ` : ''}${liveWorker.source || 'real'} · ${formatElapsedSeconds(liveWorker.elapsed_seconds)}`
    : '';
  const staleVisible = !muted && liveWorker && decor.stalenessScore >= 62;
  const roleLabel = displayRole ?? agent.role;
  const stateLabel = decor.state === 'idle' ? 'Idle' : liveStateLabel(decor.state as WorkforceState);
  const tooltipBits = [
    roleLabel,
    runtimeLabel(agent),
    `State ${stateLabel}`,
    liveWorker?.task ? `Task ${liveWorker.task}` : '',
    liveWorker?.run_id ? `Run ${liveWorker.run_id}` : '',
    liveWorker?.source ? `Source ${liveWorker.source}` : '',
    liveWorker?.updated_at ? `Updated ${formatFreshness(liveWorker.updated_at)}` : '',
    liveWorker ? `Elapsed ${formatElapsedSeconds(liveWorker.elapsed_seconds)}` : '',
    activationReason ? `Activation ${activationReason}` : '',
  ].filter(Boolean);
  const heatIntensity = showHeatOverlay && !muted
    ? Math.max(0.08, Math.min(0.44, decor.workloadScore / 170))
    : 0;
  const activeDelayMs = activationDelayMs;

  return (
    <div
      data-org-node-id={agent.id}
      data-org-tier={decor.tier}
      data-org-state={decor.state}
      data-org-delay={String(activeDelayMs)}
      className={`org-node-card org-node--${decor.tier} org-node-state--${decor.state}${isActive ? ' org-node-active' : ''}${muted ? ' org-node-muted' : ''}${motionMode === 'quiet' ? ' org-node-quiet' : ''}`}
      style={{
        ['--org-active-delay' as any]: `${activeDelayMs}ms`,
        backgroundColor: muted
          ? 'color-mix(in srgb, var(--tf-surface-raised) 84%, var(--tf-bg))'
          : isActive
            ? `color-mix(in srgb, ${visual.bg} 88%, var(--tf-surface-raised))`
            : 'var(--tf-surface-raised)',
        border: `1.5px solid ${isActive ? visual.color : 'var(--tf-border)'}`,
        cursor: onAgentClick ? 'pointer' : 'default',
        transition: 'border-color 0.26s, background-color 0.26s, box-shadow 0.26s, transform 0.22s',
        transitionDelay: isActive ? `${Math.round(activeDelayMs * 0.55)}ms` : '0ms',
        boxShadow: isActive
          ? `0 0 16px color-mix(in srgb, ${visual.color} 34%, transparent), 0 0 4px color-mix(in srgb, ${visual.color} 22%, transparent), inset 0 1px 0 rgba(255,255,255,0.08)`
          : 'inset 0 1px 0 rgba(255,255,255,0.04)',
        opacity: muted ? 0.46 : 1,
        filter: muted ? 'grayscale(38%)' : 'none',
        backgroundImage: heatIntensity > 0
          ? `radial-gradient(circle at 12% 14%, color-mix(in srgb, ${visual.color} ${Math.round(heatIntensity * 100)}%, transparent), transparent 62%)`
          : undefined,
      }}
      onClick={() => onAgentClick?.(agent)}
      role={onAgentClick ? 'button' : undefined}
      tabIndex={onAgentClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onAgentClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onAgentClick(agent);
        }
      }}
    >
      <div className={`org-node-state-chip org-node-state-chip--${decor.state}`}>
        {stateLabel}
      </div>

      {/* Avatar with pulse ring when active */}
      <div style={{ position: 'relative', marginTop: '2px' }}>
        {isActive && visual.pulse && (
          <div style={{
            position: 'absolute',
            inset: '-5px',
            borderRadius: '50%',
            border: `2px solid ${visual.color}`,
            opacity: 0.8,
            animation: 'pulse-ring 1.8s ease-out infinite',
            animationDelay: `${activeDelayMs}ms`,
          }} />
        )}
        {isActive && !visual.pulse && (
          <div style={{
            position: 'absolute',
            inset: '-5px',
            borderRadius: '50%',
            border: `2px solid ${visual.color}`,
            opacity: 0.5,
          }} />
        )}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{
            backgroundColor: color,
            color: 'var(--tf-bg)',
            position: 'relative',
            ...(isActive ? { boxShadow: `0 0 8px color-mix(in srgb, ${visual.color} 48%, transparent)` } : {}),
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
            backgroundColor: visual.color,
            border: '2px solid var(--tf-surface-raised)',
            boxShadow: `0 0 4px color-mix(in srgb, ${visual.color} 52%, transparent)`,
          }} />
        )}
      </div>
      <p className="org-node-name" style={{ color: isActive ? visual.color : 'var(--tf-text)' }}>
        {agent.name}
      </p>
      <p className="org-node-role" style={{ color: 'var(--tf-text-muted)' }}>
        {roleLabel}
      </p>
      {decor.tier === 'lead' && (
        <p className="org-node-team-badge">
          {agent.team || 'Team lead'}
        </p>
      )}

      {/* Show live activity label when working */}
      {activityLabel && !muted ? (
        <p
          className={`org-node-task${visual.pulse ? ' animate-pulse-dot' : ''}`}
          style={{
            color: isActive ? visual.color : blocked ? 'var(--tf-error)' : 'var(--tf-success)',
          }}
          title={activityLabel}
        >
          {activityLabel}
        </p>
      ) : null}
      {liveWorker && !muted && (
        <p
          className="org-node-meta"
          style={{
            color: 'var(--tf-text-muted)',
          }}
          title={tooltipBits.join(' • ')}
        >
          {liveMetaLabel}
        </p>
      )}
      {staleVisible && (
        <p className="org-node-stale" title={tooltipBits.join(' • ')}>
          Last update {formatFreshness(liveWorker?.updated_at)}
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
          Activity Timeline
        </p>
        {recentActivity.length === 0 ? (
          <p style={{ fontSize: '12px', color: 'var(--tf-text-muted)' }}>No recent activity</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0', maxHeight: '240px', overflowY: 'auto' }}>
            {recentActivity.slice(0, 8).map((evt, i) => {
              const ts = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              const isLast = i === Math.min(recentActivity.length, 8) - 1;
              return (
                <div key={i} style={{ display: 'flex', gap: '10px', minHeight: '36px' }}>
                  {/* Timeline spine */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '12px', flexShrink: 0 }}>
                    <div style={{
                      width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                      backgroundColor: i === 0 ? 'var(--tf-success)' : 'var(--tf-border)',
                      border: i === 0 ? '2px solid rgba(63,185,80,0.3)' : 'none',
                    }} />
                    {!isLast && (
                      <div style={{ width: '2px', flex: 1, backgroundColor: 'var(--tf-border)', minHeight: '16px' }} />
                    )}
                  </div>
                  {/* Content */}
                  <div style={{ flex: 1, paddingBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--tf-accent-blue)', fontWeight: 600 }}>{evt.action}</span>
                      {ts && <span style={{ fontSize: '10px', color: 'var(--tf-text-muted)' }}>{ts}</span>}
                    </div>
                    {evt.detail && (
                      <p style={{ fontSize: '11px', color: 'var(--tf-text-secondary)', marginTop: '2px', lineHeight: 1.4 }}>
                        {evt.detail}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
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
      displayRole: 'Chief Product Officer',
      children: [
        { id: 'lead-designer' },
        { id: 'tech-writer' },
      ],
    },
    { id: 'chief-researcher' },
  ],
};

interface OrgTreeMeta {
  depth: number;
  parentId?: string;
  tier: OrgVisualTier;
  phase: OrgActivationPhase;
  displayRole?: string;
  zone: RealWorldZone;
}

interface RealWorldAgentState {
  agentId: string;
  zone: RealWorldZone;
  pose: RealWorldAgentPose;
  state: OrgNodeState;
  movementStage: RealWorldMovementStage;
  frameState: RealWorldFrameState;
  bubbleState: RealWorldBubbleState;
  spriteVariant: 'executive' | 'lead' | 'specialist';
  delayMs: number;
  reason: string;
  movementRoute?: {
    fromZone: RealWorldZone;
    toZone: RealWorldZone;
    progress: number;
  };
  detail?: string;
  task?: string;
}

function buildOrgMetaTree(node: OrgTreeNode, depth = 0, parentId?: string, meta = new Map<string, OrgTreeMeta>()) {
  const syntheticAgent: Agent = {
    id: node.id,
    name: node.id,
    role: node.displayRole || node.id,
    model: '',
    status: 'active',
  };
  const tier = toVisualTier(syntheticAgent);
  meta.set(node.id, {
    depth,
    parentId,
    tier,
    phase: toActivationPhase(tier),
    displayRole: node.displayRole,
    zone: teamZoneForAgent(node.id),
  });
  for (const child of node.children ?? []) {
    buildOrgMetaTree(child, depth + 1, node.id, meta);
  }
  return meta;
}

const ORG_META = buildOrgMetaTree(ORG_TREE);

// Check if a subtree contains any active agent
function subtreeHasActive(node: OrgTreeNode, activeIds: Set<string>): boolean {
  if (activeIds.has(node.id)) return true;
  return (node.children ?? []).some((c) => subtreeHasActive(c, activeIds));
}

function subtreeHasBlocked(node: OrgTreeNode, blockedIds: Set<string>): boolean {
  if (blockedIds.has(node.id)) return true;
  return (node.children ?? []).some((c) => subtreeHasBlocked(c, blockedIds));
}

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

function compareActivationWorkers(
  a: WorkforceWorker,
  b: WorkforceWorker,
  activeRunId: string,
  phase: OrgActivationPhase,
): number {
  const aRun = String(a.run_id || '');
  const bRun = String(b.run_id || '');
  const aRelevant = aRun === activeRunId ? 0 : 1;
  const bRelevant = bRun === activeRunId ? 0 : 1;
  if (aRelevant !== bRelevant) return aRelevant - bRelevant;

  const aStart = toIsoMillis(a.started_at);
  const bStart = toIsoMillis(b.started_at);
  if (aStart !== bStart) return aStart - bStart;

  const aState = stateOrderForActivation(a.state);
  const bState = stateOrderForActivation(b.state);
  if (aState !== bState) return aState - bState;

  const runScope = activeRunId || 'steady';
  const aHash = stableRunScopedHash(`${runScope}:${phase}:${a.agent_id}`);
  const bHash = stableRunScopedHash(`${runScope}:${phase}:${b.agent_id}`);
  return aHash - bHash;
}

function deriveActiveRunId(workforceRows: WorkforceWorker[]): string {
  const counts = new Map<string, number>();
  for (const row of workforceRows) {
    const runId = String(row.run_id || '').trim();
    if (!runId) continue;
    counts.set(runId, (counts.get(runId) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function buildActivationEntries(
  workforceByAgent: Map<string, WorkforceWorker>,
  activeProjectId: string,
): Map<string, OrgActivationEntry> {
  const workforceRows = Array.from(workforceByAgent.values());
  const activeRunId = deriveActiveRunId(workforceRows);
  const candidateIds = new Set<string>();

  if (workforceRows.length === 0) return new Map();

  candidateIds.add('ceo');
  for (const row of workforceRows) {
    const path = findPathToNode(ORG_TREE, row.agent_id);
    if (!path) continue;
    for (const id of path) candidateIds.add(id);
  }

  const candidates = Array.from(candidateIds)
    .map((agentId) => {
      const meta = ORG_META.get(agentId);
      if (!meta) return null;
      const supportingWorkers = workforceRows
        .filter((row) => {
          const path = findPathToNode(ORG_TREE, row.agent_id);
          return Boolean(path?.includes(agentId));
        })
        .sort((a, b) => compareActivationWorkers(a, b, activeRunId, meta.phase));
      const bestWorker = workforceByAgent.get(agentId) || supportingWorkers[0];
      const reason = bestWorker
        ? bestWorker.agent_id === agentId
          ? `${liveStateLabel(bestWorker.state)} on ${bestWorker.task || 'current work'}`
          : `${bestWorker.agent_name || bestWorker.agent_id} pulled this branch live`
        : 'Awaiting delegation';
      return {
        agentId,
        meta,
        worker: bestWorker,
        earliestMs: bestWorker ? Math.min(toIsoMillis(bestWorker.started_at), toIsoMillis(bestWorker.updated_at)) : Number.POSITIVE_INFINITY,
        statePriority: stateOrderForActivation(bestWorker?.state),
        tieBreaker: stableRunScopedHash(`${activeRunId || activeProjectId || 'steady'}:${meta.phase}:${agentId}`),
        reason,
      };
    })
    .filter(Boolean) as Array<{
      agentId: string;
      meta: OrgTreeMeta;
      worker?: WorkforceWorker;
      earliestMs: number;
      statePriority: number;
      tieBreaker: number;
      reason: string;
    }>;

  candidates.sort((a, b) => {
    const phaseGap = ORG_PHASE_BASE_DELAY_MS[a.meta.phase] - ORG_PHASE_BASE_DELAY_MS[b.meta.phase];
    if (phaseGap !== 0) return phaseGap;
    if (a.earliestMs !== b.earliestMs) return a.earliestMs - b.earliestMs;
    if (a.statePriority !== b.statePriority) return a.statePriority - b.statePriority;
    return a.tieBreaker - b.tieBreaker;
  });

  const orderByPhase = new Map<OrgActivationPhase, number>([
    ['executive', 0],
    ['lead', 0],
    ['specialist', 0],
  ]);
  const activationMap = new Map<string, OrgActivationEntry>();
  for (const candidate of candidates) {
    const stepIndex = orderByPhase.get(candidate.meta.phase) || 0;
    orderByPhase.set(candidate.meta.phase, stepIndex + 1);
    const homeZone = candidate.meta.zone;
    const stage: RealWorldMovementStage = candidate.worker?.state === 'reporting'
      ? 'reporting'
      : candidate.worker
        ? 'executing'
        : 'dispatch';
    const fromZone: RealWorldZone = stage === 'reporting'
      ? homeZone
      : candidate.meta.phase === 'executive'
        ? 'executive_row'
        : 'briefing_area';
    const toZone: RealWorldZone = stage === 'reporting'
      ? 'briefing_area'
      : candidate.meta.phase === 'executive'
        ? 'briefing_area'
        : homeZone;
    activationMap.set(candidate.agentId, {
      agent_id: candidate.agentId,
      phase: candidate.meta.phase,
      activation_delay_ms: ORG_PHASE_BASE_DELAY_MS[candidate.meta.phase] + stepIndex * ORG_PHASE_STEP_MS[candidate.meta.phase],
      activation_reason: candidate.reason,
      connector_mode: toConnectorModeForState(candidate.worker?.state),
      movement_route: {
        from_zone: fromZone,
        to_zone: toZone,
        stage,
        progress: candidate.worker ? Math.min(1, Math.max(0.15, candidate.worker.elapsed_seconds / 90)) : 0.15,
      },
    });
  }
  return activationMap;
}

function buildRealWorldStates(
  agents: Agent[],
  workforceByAgent: Map<string, WorkforceWorker>,
  activationMap: Map<string, OrgActivationEntry>,
  isProjectRunning: boolean,
): Map<string, RealWorldAgentState> {
  const states = new Map<string, RealWorldAgentState>();
  for (const agent of agents) {
    const worker = workforceByAgent.get(agent.id);
    const activation = activationMap.get(agent.id);
    const zone = ORG_META.get(agent.id)?.zone || teamZoneForAgent(agent.id);
    const tier = ORG_META.get(agent.id)?.tier || toVisualTier(agent);
    const liveState: OrgNodeState = worker?.state || 'idle';
    let pose: RealWorldAgentPose = 'idle';
    let movementStage: RealWorldMovementStage = 'idle';
    let frameState: RealWorldFrameState = 'loop';
    let bubbleState: RealWorldBubbleState = 'none';
    if (isProjectRunning) {
      if (agent.id === 'ceo' || activation?.phase === 'executive') {
        pose = worker?.state === 'reporting' ? 'presenting' : 'huddle';
        movementStage = worker?.state === 'reporting' ? 'reporting' : 'dispatch';
        bubbleState = worker?.state === 'reporting' ? 'reporting' : 'briefing';
      } else if (worker?.state === 'working') {
        pose = 'walking';
        movementStage = 'executing';
        bubbleState = 'focus';
      } else if (worker?.state === 'assigned') {
        pose = 'huddle';
        movementStage = 'dispatch';
        bubbleState = 'briefing';
      } else if (worker?.state === 'reporting') {
        pose = 'presenting';
        movementStage = 'reporting';
        bubbleState = 'reporting';
      } else if (worker?.state === 'blocked') {
        pose = 'huddle';
        movementStage = 'dispatch';
        bubbleState = 'blocked';
      } else {
        pose = activation ? 'seated' : 'idle';
        movementStage = activation ? 'executing' : 'idle';
      }
    } else {
      pose = 'idle';
      movementStage = 'idle';
    }
    if (liveState === 'blocked') bubbleState = 'blocked';
    if (activation && activation.activation_delay_ms > 0 && pose !== 'idle') frameState = 'transition';
    const route = activation?.movement_route;
    states.set(agent.id, {
      agentId: agent.id,
      zone: pose === 'presenting' || pose === 'huddle'
        ? (activation?.phase === 'executive' || movementStage === 'reporting' ? 'briefing_area' : zone)
        : zone,
      pose,
      state: liveState,
      movementStage,
      frameState,
      bubbleState,
      spriteVariant: tier,
      delayMs: activation?.activation_delay_ms || 0,
      reason: activation?.activation_reason || 'Calm office state',
      movementRoute: route
        ? {
          fromZone: route.from_zone,
          toZone: route.to_zone,
          progress: route.progress,
        }
        : undefined,
      detail: worker?.run_id ? `Run ${worker.run_id}` : undefined,
      task: worker?.task,
    });
  }
  return states;
}

interface TreeNodeProps {
  node: OrgTreeNode;
  depth: number;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
  activeIds: Set<string>;
  focusedAgentIds: Set<string>;
  focusActiveChain: boolean;
  mutedAgentIds: Set<string>;
  flowEdgeDirections: Map<string, FlowDirection>;
  blockedAgentIds: Set<string>;
  liveStateByAgent: Map<string, WorkforceState>;
  liveWorkerByAgent: Map<string, WorkforceWorker>;
  workloadScoreByAgent: Map<string, number>;
  stalenessScoreByAgent: Map<string, number>;
  activationByAgent: Map<string, OrgActivationEntry>;
  showHeatOverlay: boolean;
  motionMode: OrgMotionMode;
}

function TreeNode({
  node,
  depth,
  agentMap,
  onAgentClick,
  activeIds,
  focusedAgentIds,
  focusActiveChain,
  mutedAgentIds,
  flowEdgeDirections,
  blockedAgentIds,
  liveStateByAgent,
  liveWorkerByAgent,
  workloadScoreByAgent,
  stalenessScoreByAgent,
  activationByAgent,
  showHeatOverlay,
  motionMode,
}: TreeNodeProps) {
  const agent = agentMap.get(node.id);
  const children = node.children ?? [];

  if (!agent) return null;

  const hasChildren = children.length > 0;
  const focusMuted = focusActiveChain && focusedAgentIds.size > 0 && !focusedAgentIds.has(node.id);
  const liveState = liveStateByAgent.get(node.id);
  const muted = mutedAgentIds.has(node.id) || (focusMuted && !liveState);
  const liveWorker = liveWorkerByAgent.get(node.id);
  const blocked = blockedAgentIds.has(node.id) || liveState === 'blocked';
  const decorState: OrgNodeState = muted ? 'idle' : (liveState || (blocked ? 'blocked' : 'idle'));
  const activation = activationByAgent.get(node.id);
  const decor: OrgNodeDecor = {
    tier: toVisualTier(agent),
    state: decorState,
    workloadScore: workloadScoreByAgent.get(node.id) || 0,
    stalenessScore: stalenessScoreByAgent.get(node.id) || 0,
  };
  const childSubtreeActive = children.some((c) => subtreeHasActive(c, activeIds))
    || children.some((c) => flowEdgeDirections.has(orgEdgeKey(node.id, c.id)));
  const childBlocked = children.some((c) => subtreeHasBlocked(c, blockedAgentIds));
  const firstFlowEdge = children.find((c) => flowEdgeDirections.has(orgEdgeKey(node.id, c.id)));
  const stemDirection: FlowDirection = firstFlowEdge
    ? (flowEdgeDirections.get(orgEdgeKey(node.id, firstFlowEdge.id)) || 'down')
    : 'down';
  const stemDelayMs = activation?.activation_delay_ms || 0;
  const tooltipContent = liveWorker
    ? `${node.displayRole ?? agent.role} · ${runtimeLabel(agent)} · ${liveWhyTitle(liveWorker).replace(/\n/g, ' • ')}${activation?.activation_reason ? ` • ${activation.activation_reason}` : ''}`
    : `${node.displayRole ?? agent.role} · ${runtimeLabel(agent)}${activation?.activation_reason ? ` · ${activation.activation_reason}` : ''}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Tooltip content={tooltipContent} position="top">
        <OrgNodeCard
          agent={agent}
          decor={decor}
          motionMode={motionMode}
          activationDelayMs={activation?.activation_delay_ms || 0}
          activationReason={activation?.activation_reason}
          displayRole={node.displayRole}
          onAgentClick={onAgentClick}
          muted={muted}
          blocked={blocked}
          showHeatOverlay={showHeatOverlay}
          liveState={liveState}
          liveWorker={liveWorker}
        />
      </Tooltip>

      {hasChildren && (
        <>
          {/* Vertical stem: animated if any child's subtree is active */}
          <OrgConnector
            vertical
            size={24}
            active={childSubtreeActive}
            blocked={childBlocked}
            flowDirection={stemDirection}
            motionMode={motionMode}
            activationDelayMs={stemDelayMs}
          />
          <ChildrenGroup
            node={node}
            depth={depth}
            agentMap={agentMap}
            onAgentClick={onAgentClick}
            activeIds={activeIds}
            focusedAgentIds={focusedAgentIds}
            focusActiveChain={focusActiveChain}
            mutedAgentIds={mutedAgentIds}
            flowEdgeDirections={flowEdgeDirections}
            blockedAgentIds={blockedAgentIds}
            liveStateByAgent={liveStateByAgent}
            liveWorkerByAgent={liveWorkerByAgent}
            workloadScoreByAgent={workloadScoreByAgent}
            stalenessScoreByAgent={stalenessScoreByAgent}
            activationByAgent={activationByAgent}
            showHeatOverlay={showHeatOverlay}
            motionMode={motionMode}
          />
        </>
      )}
    </div>
  );
}

interface ChildrenGroupProps {
  node: OrgTreeNode;
  depth: number;
  agentMap: Map<string, Agent>;
  onAgentClick: (agent: Agent) => void;
  activeIds: Set<string>;
  focusedAgentIds: Set<string>;
  focusActiveChain: boolean;
  mutedAgentIds: Set<string>;
  flowEdgeDirections: Map<string, FlowDirection>;
  blockedAgentIds: Set<string>;
  liveStateByAgent: Map<string, WorkforceState>;
  liveWorkerByAgent: Map<string, WorkforceWorker>;
  workloadScoreByAgent: Map<string, number>;
  stalenessScoreByAgent: Map<string, number>;
  activationByAgent: Map<string, OrgActivationEntry>;
  showHeatOverlay: boolean;
  motionMode: OrgMotionMode;
}

function ChildrenGroup({
  node,
  depth,
  agentMap,
  onAgentClick,
  activeIds,
  focusedAgentIds,
  focusActiveChain,
  mutedAgentIds,
  flowEdgeDirections,
  blockedAgentIds,
  liveStateByAgent,
  liveWorkerByAgent,
  workloadScoreByAgent,
  stalenessScoreByAgent,
  activationByAgent,
  showHeatOverlay,
  motionMode,
}: ChildrenGroupProps) {
  const children = node.children ?? [];
  const visibleChildren = children.filter((c) => agentMap.has(c.id));

  if (visibleChildren.length === 0) return null;

  if (visibleChildren.length === 1) {
    const edgeKey = orgEdgeKey(node.id, visibleChildren[0].id);
    const edgeInFlow = flowEdgeDirections.has(edgeKey);
    const childActive = edgeInFlow || subtreeHasActive(visibleChildren[0], activeIds);
    const childBlocked = subtreeHasBlocked(visibleChildren[0], blockedAgentIds);
    const edgeDirection = flowEdgeDirections.get(edgeKey) || 'down';
    const childDelayMs = activationByAgent.get(visibleChildren[0].id)?.activation_delay_ms || 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <OrgConnector
          vertical
          size={20}
          active={childActive}
          blocked={childBlocked}
          flowDirection={edgeDirection}
          motionMode={motionMode}
          activationDelayMs={childDelayMs}
        />
        <TreeNode
          node={visibleChildren[0]}
          depth={depth + 1}
          agentMap={agentMap}
          onAgentClick={onAgentClick}
          activeIds={activeIds}
          focusedAgentIds={focusedAgentIds}
          focusActiveChain={focusActiveChain}
          mutedAgentIds={mutedAgentIds}
          flowEdgeDirections={flowEdgeDirections}
          blockedAgentIds={blockedAgentIds}
          liveStateByAgent={liveStateByAgent}
          liveWorkerByAgent={liveWorkerByAgent}
          workloadScoreByAgent={workloadScoreByAgent}
          stalenessScoreByAgent={stalenessScoreByAgent}
          activationByAgent={activationByAgent}
          showHeatOverlay={showHeatOverlay}
          motionMode={motionMode}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
      }}
    >
      {visibleChildren.map((child, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === visibleChildren.length - 1;
        const edgeKey = orgEdgeKey(node.id, child.id);
        const edgeInFlow = flowEdgeDirections.has(edgeKey);
        const childActive = edgeInFlow || subtreeHasActive(child, activeIds);
        const childBlocked = subtreeHasBlocked(child, blockedAgentIds);
        const edgeDirection: FlowDirection = flowEdgeDirections.get(edgeKey) || 'down';
        const railColor = connectorRailColor(childActive, childBlocked, edgeDirection);
        const railGlow = childBlocked
          ? '0 0 9px rgba(240,170,74,0.22)'
          : childActive
            ? edgeDirection === 'up'
              ? '0 0 9px rgba(59,142,255,0.18)'
              : '0 0 9px rgba(63,185,80,0.16)'
            : 'none';
        const childDelayMs = (activationByAgent.get(child.id)?.activation_delay_ms || 0) + idx * 18;

        return (
          <div
            key={child.id}
            style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 10px' }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: isFirst ? '50%' : 0,
                right: isLast ? '50%' : 0,
                height: '3px',
                borderRadius: '999px',
                backgroundColor: railColor,
                boxShadow: railGlow,
                transition: 'background-color 0.24s ease, box-shadow 0.24s ease',
                transitionDelay: childActive ? `${childDelayMs}ms` : '0ms',
              }}
            />
            {/* Vertical stub to child */}
            <OrgConnector
              vertical
              size={20}
              active={childActive}
              blocked={childBlocked}
              flowDirection={edgeDirection}
              motionMode={motionMode}
              activationDelayMs={childDelayMs}
            />
            <TreeNode
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              onAgentClick={onAgentClick}
              activeIds={activeIds}
              focusedAgentIds={focusedAgentIds}
              focusActiveChain={focusActiveChain}
              mutedAgentIds={mutedAgentIds}
              flowEdgeDirections={flowEdgeDirections}
              blockedAgentIds={blockedAgentIds}
              liveStateByAgent={liveStateByAgent}
              liveWorkerByAgent={liveWorkerByAgent}
              workloadScoreByAgent={workloadScoreByAgent}
              stalenessScoreByAgent={stalenessScoreByAgent}
              activationByAgent={activationByAgent}
              showHeatOverlay={showHeatOverlay}
              motionMode={motionMode}
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
  workforceLive?: WorkforceLiveSnapshot;
}

interface OrgLegendProps {
  motionMode: OrgMotionMode;
  focusActiveChain: boolean;
  showHeatOverlay: boolean;
}

function OrgLegend({ motionMode, focusActiveChain, showHeatOverlay }: OrgLegendProps) {
  return (
    <div className="org-legend">
      <span className="org-legend-item"><span className="org-legend-dot org-legend-dot--working" /> Working</span>
      <span className="org-legend-item"><span className="org-legend-dot org-legend-dot--reporting" /> Reporting</span>
      <span className="org-legend-item"><span className="org-legend-dot org-legend-dot--blocked" /> Blocked</span>
      <span className="org-legend-item">Motion: {motionMode}</span>
      <span className="org-legend-item">{focusActiveChain ? 'Focus chain on' : 'Focus chain off'}</span>
      <span className="org-legend-item">{showHeatOverlay ? 'Heat overlay on' : 'Heat overlay off'}</span>
    </div>
  );
}

interface RealWorldSceneProps {
  agents: Agent[];
  realWorldStates: Map<string, RealWorldAgentState>;
  activationByAgent: Map<string, OrgActivationEntry>;
  motionMode: OrgMotionMode;
  isProjectRunning: boolean;
  syncFreshness: string;
  onAgentClick: (agent: Agent) => void;
}

interface RealWorldZoneLayout {
  id: RealWorldZone;
  label: string;
  description: string;
  left: number;
  top: number;
  width: number;
  height: number;
  seats: number;
}

interface RealWorldProp {
  id: string;
  kind: 'desk' | 'table' | 'monitor' | 'plant';
  left: number;
  top: number;
  zone?: RealWorldZone;
}

interface PositionedRealWorldAgent {
  agent: Agent;
  scene: RealWorldAgentState;
  left: number;
  top: number;
  zIndex: number;
}

const REAL_WORLD_ZONE_LAYOUTS: RealWorldZoneLayout[] = [
  {
    id: 'executive_row',
    label: 'Executive Row',
    description: 'Where strategic direction and decisions start.',
    left: 5,
    top: 8,
    width: 30,
    height: 18,
    seats: 4,
  },
  {
    id: 'briefing_area',
    label: 'Briefing Area',
    description: 'The handoff zone when the CEO mobilizes the team.',
    left: 38,
    top: 10,
    width: 24,
    height: 20,
    seats: 4,
  },
  {
    id: 'product_pod',
    label: 'Product + Design',
    description: 'Planning, UX shaping, and product flow work.',
    left: 65,
    top: 10,
    width: 30,
    height: 22,
    seats: 4,
  },
  {
    id: 'engineering_pod',
    label: 'Engineering Pod',
    description: 'Implementation and architecture execution.',
    left: 7,
    top: 34,
    width: 45,
    height: 30,
    seats: 7,
  },
  {
    id: 'qa_bench',
    label: 'QA Bench',
    description: 'Validation checks and release confidence.',
    left: 54,
    top: 42,
    width: 20,
    height: 24,
    seats: 3,
  },
  {
    id: 'research_corner',
    label: 'Research Corner',
    description: 'Discovery, scope framing, and synthesis.',
    left: 76,
    top: 39,
    width: 18,
    height: 26,
    seats: 2,
  },
];

const REAL_WORLD_PROPS: RealWorldProp[] = [
  { id: 'exec-desk-1', kind: 'desk', left: 13, top: 17, zone: 'executive_row' },
  { id: 'exec-desk-2', kind: 'desk', left: 24, top: 17, zone: 'executive_row' },
  { id: 'brief-table', kind: 'table', left: 50, top: 20, zone: 'briefing_area' },
  { id: 'prod-desk-1', kind: 'desk', left: 74, top: 18, zone: 'product_pod' },
  { id: 'prod-desk-2', kind: 'desk', left: 87, top: 20, zone: 'product_pod' },
  { id: 'eng-desk-1', kind: 'desk', left: 18, top: 46, zone: 'engineering_pod' },
  { id: 'eng-desk-2', kind: 'desk', left: 30, top: 52, zone: 'engineering_pod' },
  { id: 'eng-desk-3', kind: 'desk', left: 42, top: 47, zone: 'engineering_pod' },
  { id: 'qa-desk', kind: 'desk', left: 61, top: 53, zone: 'qa_bench' },
  { id: 'research-desk', kind: 'desk', left: 84, top: 52, zone: 'research_corner' },
  { id: 'plant-1', kind: 'plant', left: 6, top: 28 },
  { id: 'plant-2', kind: 'plant', left: 94, top: 28 },
  { id: 'monitor-1', kind: 'monitor', left: 51, top: 22 },
  { id: 'monitor-2', kind: 'monitor', left: 62, top: 56 },
];

const DEFAULT_REAL_WORLD_MANIFEST: RealWorldSpriteManifest = {
  atlas_path: '/real-world/sprites/agent/default',
  role_variants: {
    executive: 'default',
    lead: 'default',
    specialist: 'default',
  },
  frame_map: {
    idle: { id: 'idle', src: '/real-world/sprites/agent/default/idle.svg', width: 96, height: 128 },
    seated: { id: 'seated', src: '/real-world/sprites/agent/default/seated.svg', width: 96, height: 128 },
    walking: { id: 'walking', src: '/real-world/sprites/agent/default/walking.svg', width: 96, height: 128 },
    huddle: { id: 'huddle', src: '/real-world/sprites/agent/default/huddle.svg', width: 96, height: 128 },
    presenting: { id: 'presenting', src: '/real-world/sprites/agent/default/presenting.svg', width: 96, height: 128 },
    blocked: { id: 'blocked', src: '/real-world/sprites/agent/default/blocked.svg', width: 96, height: 128 },
  },
  fallback_frame: 'idle',
  props: {
    desk: '/real-world/props/desk.svg',
    table: '/real-world/props/table.svg',
    monitor: '/real-world/props/monitor.svg',
    plant: '/real-world/props/plant.svg',
  },
};

function toPoseFrameKey(scene: RealWorldAgentState): string {
  if (scene.state === 'blocked') return 'blocked';
  return scene.pose;
}

function bubbleLabel(state: RealWorldBubbleState): string {
  if (state === 'briefing') return 'Briefing';
  if (state === 'reporting') return 'Reporting';
  if (state === 'blocked') return 'Blocked';
  if (state === 'focus') return 'In focus';
  return '';
}

function seatPosition(layout: RealWorldZoneLayout, index: number): { left: number; top: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(layout.seats)));
  const col = index % columns;
  const row = Math.floor(index / columns);
  const xGap = columns <= 1 ? 0 : (layout.width - 14) / (columns - 1);
  const yGap = 7.5;
  return {
    left: layout.left + 7 + col * xGap,
    top: layout.top + 10 + row * yGap + (col % 2 === 0 ? 0.5 : 0),
  };
}

function interpolatePos(from: { left: number; top: number }, to: { left: number; top: number }, progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  return {
    left: from.left + (to.left - from.left) * p,
    top: from.top + (to.top - from.top) * p,
  };
}

function RealWorldScene({
  agents,
  realWorldStates,
  activationByAgent,
  motionMode,
  isProjectRunning,
  syncFreshness,
  onAgentClick,
}: RealWorldSceneProps) {
  const [manifest, setManifest] = useState<RealWorldSpriteManifest>(DEFAULT_REAL_WORLD_MANIFEST);
  const zoneMap = useMemo(() => {
    const map = new Map<RealWorldZone, RealWorldZoneLayout>();
    for (const zone of REAL_WORLD_ZONE_LAYOUTS) map.set(zone.id, zone);
    return map;
  }, []);

  useEffect(() => {
    let isCancelled = false;
    const loadManifest = async () => {
      try {
        const response = await fetch('/real-world/sprite-manifest.json', { cache: 'force-cache' });
        if (!response.ok) return;
        const loaded = (await response.json()) as Partial<RealWorldSpriteManifest>;
        if (isCancelled) return;
        setManifest((prev) => ({
          ...prev,
          ...loaded,
          role_variants: { ...prev.role_variants, ...(loaded.role_variants || {}) },
          frame_map: { ...prev.frame_map, ...(loaded.frame_map || {}) },
          props: { ...prev.props, ...(loaded.props || {}) },
        }));
      } catch {
        // Keep resilient fallback manifest.
      }
    };
    void loadManifest();
    return () => { isCancelled = true; };
  }, []);

  const agentsByZone = useMemo(() => {
    const grouped = new Map<RealWorldZone, Agent[]>();
    for (const zone of REAL_WORLD_ZONE_LAYOUTS) grouped.set(zone.id, []);
    for (const agent of agents) {
      const zone = realWorldStates.get(agent.id)?.zone || teamZoneForAgent(agent.id);
      const list = grouped.get(zone) || [];
      list.push(agent);
      grouped.set(zone, list);
    }
    for (const [zone, list] of grouped.entries()) {
      list.sort((a, b) => {
        const aDelay = activationByAgent.get(a.id)?.activation_delay_ms ?? Number.MAX_SAFE_INTEGER;
        const bDelay = activationByAgent.get(b.id)?.activation_delay_ms ?? Number.MAX_SAFE_INTEGER;
        if (aDelay !== bDelay) return aDelay - bDelay;
        return a.name.localeCompare(b.name);
      });
      grouped.set(zone, list);
    }
    return grouped;
  }, [agents, realWorldStates, activationByAgent]);

  const positionedAgents = useMemo(() => {
    const out: PositionedRealWorldAgent[] = [];
    for (const zone of REAL_WORLD_ZONE_LAYOUTS) {
      const zoneAgents = agentsByZone.get(zone.id) || [];
      zoneAgents.forEach((agent, index) => {
        const scene = realWorldStates.get(agent.id);
        if (!scene) return;
        const baseSeat = seatPosition(zone, index);
        const route = scene.movementRoute;
        let position = baseSeat;
        if (route) {
          const fromZone = zoneMap.get(route.fromZone) || zone;
          const toZone = zoneMap.get(route.toZone) || zone;
          const fromSeat = seatPosition(fromZone, index);
          const toSeat = seatPosition(toZone, index);
          position = interpolatePos(fromSeat, toSeat, route.progress);
        }
        const jitter = (stableRunScopedHash(`${agent.id}:${scene.delayMs}:${scene.pose}`) % 5) - 2;
        const left = position.left + jitter * 0.24;
        const top = position.top + (scene.pose === 'walking' ? -0.7 : 0);
        out.push({ agent, scene, left, top, zIndex: Math.round(top * 10) });
      });
    }
    return out.sort((a, b) => a.zIndex - b.zIndex);
  }, [agentsByZone, realWorldStates, zoneMap]);

  return (
    <div className={`real-world-shell real-world-motion-${motionMode} ${isProjectRunning ? 'real-world-running' : 'real-world-idle'}`}>
      <div className="real-world-office" data-real-world-office>
        <div className="real-world-layer real-world-layer--base">
          <div className="real-world-floor" />
          <div className="real-world-wall real-world-wall--top" />
          <div className="real-world-wall real-world-wall--left" />
          <div className="real-world-wall real-world-wall--right" />
        </div>

        <div className="real-world-layer real-world-layer--zones">
          {REAL_WORLD_ZONE_LAYOUTS.map((zone) => (
            <section
              key={zone.id}
              className={`real-world-zone-iso real-world-zone-iso--${zone.id}`}
              style={{
                left: `${zone.left}%`,
                top: `${zone.top}%`,
                width: `${zone.width}%`,
                height: `${zone.height}%`,
              }}
            >
              <div className="real-world-zone-plate" />
              <div className="real-world-zone-furniture">
                <span />
                <span />
                <span />
              </div>
              <div className="real-world-zone-meta">
                <p className="real-world-zone-label">{zone.label}</p>
                <p className="real-world-zone-description">{zone.description}</p>
              </div>
            </section>
          ))}
        </div>

        <div className="real-world-layer real-world-layer--props" data-real-world-furniture>
          {REAL_WORLD_PROPS.map((prop) => (
            <div
              key={prop.id}
              className={`real-world-prop real-world-prop--${prop.kind}`}
              style={{ left: `${prop.left}%`, top: `${prop.top}%` }}
            >
              <img src={manifest.props[prop.kind] || DEFAULT_REAL_WORLD_MANIFEST.props[prop.kind]} alt={prop.kind} loading="lazy" />
            </div>
          ))}
        </div>

        <div className="real-world-layer real-world-layer--paths">
          <div className="real-world-walk-path real-world-walk-path--north" />
          <div className="real-world-walk-path real-world-walk-path--mid" />
          <div className="real-world-walk-path real-world-walk-path--south" />
        </div>

        <div className="real-world-layer real-world-layer--agents">
          {positionedAgents.map(({ agent, scene, left, top, zIndex }) => {
          const activation = activationByAgent.get(agent.id);
          const isActive = scene.state !== 'idle' || Boolean(activation);
          const frameKey = toPoseFrameKey(scene);
          const sprite = manifest.frame_map[frameKey] || manifest.frame_map[manifest.fallback_frame] || DEFAULT_REAL_WORLD_MANIFEST.frame_map.idle;
          const bubble = bubbleLabel(scene.bubbleState);
          return (
            <button
              key={agent.id}
              type="button"
              data-real-world-agent-id={agent.id}
              data-real-world-pose={scene.pose || 'idle'}
              data-real-world-delay={String(scene.delayMs || 0)}
              className={`real-world-agent real-world-agent--${scene.pose || 'idle'} real-world-agent--${scene.state || 'idle'} real-world-agent--${scene.spriteVariant} ${isActive ? 'real-world-agent--active' : ''}`}
              style={{
                ['--rw-delay' as any]: `${scene.delayMs || 0}ms`,
                left: `${left}%`,
                top: `${top}%`,
                zIndex,
              }}
              onClick={() => onAgentClick(agent)}
              title={`${agent.name} · ${scene.reason || agent.role}${scene.task ? ` · ${scene.task}` : ''}`}
            >
              <span className="real-world-agent-shadow" />
              <span className={`real-world-sprite-wrap real-world-frame-${scene.frameState}`}>
                <img
                  className="real-world-agent-sprite"
                  src={sprite.src}
                  alt={`${agent.name} sprite`}
                  width={sprite.width || 96}
                  height={sprite.height || 128}
                  loading="lazy"
                />
                <span className="real-world-agent-sprite-tint" />
              </span>
              <span className="real-world-agent-card">
                <span className="real-world-agent-name">{agent.name}</span>
                <span className="real-world-agent-role">{ORG_META.get(agent.id)?.displayRole || agent.role}</span>
                {scene.task ? (
                  <span className="real-world-agent-task">{scene.task}</span>
                ) : (
                  <span className="real-world-agent-task">{isProjectRunning ? scene.reason : 'Calm office state'}</span>
                )}
              </span>
              {bubble && <span className={`real-world-speech-bubble real-world-speech-bubble--${scene.bubbleState}`}>{bubble}</span>}
            </button>
          );
          })}
        </div>

        <div className="real-world-layer real-world-layer--chips">
          <span className="real-world-ui-chip">{isProjectRunning ? 'Office live' : 'Office calm'}</span>
          <span className="real-world-ui-chip">Synced {syncFreshness}</span>
          <span className="real-world-ui-chip">Executives brief first</span>
        </div>
      </div>
      <div className="real-world-footer">
        <span className="real-world-footer-chip">{isProjectRunning ? 'Live mission floor' : 'Calm office floor'}</span>
        <span className="real-world-footer-chip">Task-driven movement</span>
        <span className="real-world-footer-chip">Human sprite actors</span>
      </div>
    </div>
  );
}

function OrgChart({ agents, loading, events, activeProjectId = '', microProjectMode = false, workforceLive }: OrgChartProps) {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showTruthDrawer, setShowTruthDrawer] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const hierarchyViewportRef = useRef<HTMLDivElement | null>(null);
  const hierarchyContentRef = useRef<HTMLDivElement | null>(null);
  const [visualizationMode, setVisualizationMode] = useState<OverviewVisualizationMode>('org_tree');
  const [layoutMode, setLayoutMode] = useState<'hierarchy' | 'cluster' | 'timeline'>('hierarchy');
  const [hierarchyScale, setHierarchyScale] = useState(1);
  const [hierarchyHeight, setHierarchyHeight] = useState<number | null>(null);
  const [focusActiveChain, setFocusActiveChain] = useState(true);
  const [showHeatOverlay, setShowHeatOverlay] = useState(false);
  const [compactViewport, setCompactViewport] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= 900 : false));
  const [documentVisible, setDocumentVisible] = useState(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState !== 'hidden';
  });
  const lastAutoCenteredNodeRef = useRef('');

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const scopedEvents = useMemo(() => {
    if (!activeProjectId) return events;
    // Filter to the active project, but ALWAYS include delegation events
    // (DELEGATED/STARTED/COMPLETED with agent flow metadata) regardless of
    // project_id.  The backend may resolve to a different project than the
    // frontend's activeProjectId, which would silently drop delegation events
    // and prevent agents from lighting up in the org chart.
    const result = events.filter((evt) => {
      if ((evt.project_id || '') === activeProjectId) return true;
      const meta = (evt.metadata || {}) as Record<string, unknown>;
      const flow = String(meta.flow || '').toLowerCase();
      if (flow === 'down' || flow === 'up') return true;
      const action = (evt.action || '').toUpperCase();
      if (action === 'DELEGATED' || action === 'STARTED' || action === 'COMPLETED') {
        const target = String(meta.target_agent || '').toLowerCase();
        const source = String(meta.source_agent || '').toLowerCase();
        if ((target && target !== 'ceo') || (source && source !== 'ceo')) return true;
      }
      return false;
    });
    return result.length > 0 ? result : events;
  }, [events, activeProjectId]);

  // Map of agent aliases (name, role, space-separated slug) → canonical agent ID.
  // Must be declared before recentActiveIds which depends on it.
  const aliasToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      const idLower = agent.id.toLowerCase();
      map.set(idLower, agent.id);
      map.set(agent.name.toLowerCase(), agent.id);
      map.set(agent.role.toLowerCase(), agent.id);
      // Also map space-separated form of slug: "lead backend" → "lead-backend"
      const spaced = idLower.replace(/-/g, ' ');
      if (spaced !== idLower) {
        map.set(spaced, agent.id);
      }
    }
    return map;
  }, [agents]);

  const workforceByAgent = useMemo(() => {
    const rows = workforceLive?.workers || [];
    const byAgent = new Map<string, WorkforceWorker>();
    const stateRank: Record<WorkforceState, number> = {
      working: 4,
      blocked: 3,
      reporting: 2,
      assigned: 1,
    };
    for (const row of rows) {
      if (activeProjectId && String(row.project_id || '') !== activeProjectId) continue;
      const raw = String(row.agent_id || '').trim().toLowerCase();
      const slug = toAgentSlug(raw);
      const canonical = aliasToId.get(raw) || aliasToId.get(slug) || slug;
      if (!canonical || !agentMap.has(canonical)) continue;
      if (microProjectMode && canonical !== 'ceo') continue;
      const existing = byAgent.get(canonical);
      if (!existing) {
        byAgent.set(canonical, row);
        continue;
      }
      const rank = stateRank[row.state] || 0;
      const currentRank = stateRank[existing.state] || 0;
      if (rank > currentRank) {
        byAgent.set(canonical, row);
        continue;
      }
      if (rank === currentRank && String(row.updated_at || '') > String(existing.updated_at || '')) {
        byAgent.set(canonical, row);
      }
    }
    return byAgent;
  }, [workforceLive?.workers, activeProjectId, aliasToId, agentMap, microProjectMode]);

  const workforceStateByAgent = useMemo(() => {
    const map = new Map<string, WorkforceState>();
    for (const [id, row] of workforceByAgent.entries()) {
      map.set(id, row.state);
    }
    return map;
  }, [workforceByAgent]);

  const workforceCounts = useMemo(() => {
    let assigned = 0;
    let working = 0;
    let reporting = 0;
    let blocked = 0;
    for (const row of workforceByAgent.values()) {
      if (row.state === 'assigned') assigned += 1;
      if (row.state === 'working') working += 1;
      if (row.state === 'reporting') reporting += 1;
      if (row.state === 'blocked') blocked += 1;
    }
    return { assigned, working, reporting, blocked };
  }, [workforceByAgent]);
  const truthRows = useMemo(
    () => Array.from(workforceByAgent.values()).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))),
    [workforceByAgent],
  );

  const hasCanonicalPresence = Boolean(
    workforceLive?.client_meta?.last_success_at
    || (workforceLive?.as_of && workforceLive.as_of !== '1970-01-01T00:00:00.000Z'),
  );
  const workforceStale = Boolean(workforceLive?.client_meta?.stale);

  // Set of currently working agent IDs. Canonical source is workforce presence.
  const recentActiveIds = useMemo(() => {
    const s = new Set<string>();
    for (const [agentId, row] of workforceByAgent.entries()) {
      if (row.state === 'working') s.add(agentId);
    }
    return s;
  }, [workforceByAgent]);

  // Broader active set to drive connector highlights.
  const activeIds = useMemo(() => {
    const s = new Set<string>();
    for (const [agentId] of workforceByAgent.entries()) {
      s.add(agentId);
    }
    return s;
  }, [workforceByAgent]);

  const latestFlow = useMemo((): {
    edgeDirections: Map<string, FlowDirection>;
    blockedAgentIds: Set<string>;
  } => {
    const edgeDirections = new Map<string, FlowDirection>();
    const blockedAgentIds = new Set<string>();

    const addFlowToAgent = (agentId: string, direction: FlowDirection) => {
      if (!agentId || agentId === 'ceo') return;
      const path = findPathToNode(ORG_TREE, agentId);
      if (!path || path.length < 2) return;
      for (let i = 0; i < path.length - 1; i += 1) {
        edgeDirections.set(orgEdgeKey(path[i], path[i + 1]), direction);
      }
    };

    for (const [agentId, row] of workforceByAgent.entries()) {
      if (agentId === 'ceo' || (microProjectMode && agentId !== 'ceo')) continue;
      if (row.state === 'blocked') {
        blockedAgentIds.add(agentId);
        continue;
      }
      const direction: FlowDirection = row.state === 'reporting' ? 'up' : 'down';
      addFlowToAgent(agentId, direction);
    }

    return { edgeDirections, blockedAgentIds };
  }, [workforceByAgent, microProjectMode]);

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

  const workloadByAgent = useMemo(() => {
    const out = new Map<string, number>();
    for (const agent of agents) {
      const keyByName = agent.name.toLowerCase();
      const keyById = agent.id.toLowerCase();
      const count = workloadMap.get(keyByName) || workloadMap.get(keyById) || 0;
      out.set(agent.id, count);
    }
    return out;
  }, [agents, workloadMap]);

  const maxWorkload = useMemo(() => {
    let max = 0;
    for (const value of workloadByAgent.values()) {
      if (value > max) max = value;
    }
    return max;
  }, [workloadByAgent]);

  const workloadScoreByAgent = useMemo(() => {
    const out = new Map<string, number>();
    for (const [agentId, count] of workloadByAgent.entries()) {
      out.set(agentId, toWorkloadScore(count, maxWorkload));
    }
    return out;
  }, [maxWorkload, workloadByAgent]);

  const stalenessScoreByAgent = useMemo(() => {
    const out = new Map<string, number>();
    for (const agent of agents) {
      const row = workforceByAgent.get(agent.id);
      out.set(agent.id, toStalenessScore(row?.updated_at));
    }
    return out;
  }, [agents, workforceByAgent]);

  const focusedAgentIds = useMemo(() => {
    const set = new Set<string>();
    if (!focusActiveChain) return set;
    const sources = recentActiveIds.size > 0 ? recentActiveIds : activeIds;
    if (sources.size === 0) return set;
    set.add('ceo');
    for (const id of sources) {
      const path = findPathToNode(ORG_TREE, id);
      if (!path) continue;
      for (const segment of path) set.add(segment);
    }
    return set;
  }, [activeIds, focusActiveChain, recentActiveIds]);

  const mutedAgentIds = useMemo(() => {
    const s = new Set<string>();
    if (microProjectMode) {
      for (const agent of agents) {
        if (agent.id !== 'ceo') s.add(agent.id);
      }
    }
    return s;
  }, [agents, microProjectMode]);

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
    if (typeof document === 'undefined') return undefined;
    const onVisibility = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setCompactViewport(window.innerWidth <= 900);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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

  useEffect(() => {
    if (layoutMode !== 'hierarchy') return;
    if (!focusActiveChain) return;
    const sources = recentActiveIds.size > 0 ? Array.from(recentActiveIds) : Array.from(activeIds);
    if (sources.length === 0) return;
    const targetId = sources[0];
    if (!targetId) return;
    const signature = `${activeProjectId || 'global'}:${targetId}`;
    if (lastAutoCenteredNodeRef.current === signature) return;
    const viewport = hierarchyViewportRef.current;
    if (!viewport) return;
    const node = viewport.querySelector<HTMLElement>(`[data-org-node-id="${targetId}"]`);
    if (!node) return;
    lastAutoCenteredNodeRef.current = signature;
    try {
      node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch {
      // Ignore scroll compatibility differences.
    }
  }, [activeIds, activeProjectId, focusActiveChain, layoutMode, recentActiveIds]);

  // Build a short list of active agent names for the status badge.
  // Use recentActiveIds (not broader activeIds) so the header matches the glowing nodes.
  const activeAgentNames = useMemo(() => {
    const names: string[] = [];
    for (const id of recentActiveIds) {
      const a = agentMap.get(id);
      if (a) names.push(a.name);
    }
    return names;
  }, [recentActiveIds, agentMap]);

  const ceoAgent = agentMap.get('ceo');
  const laneSections = [
    { title: 'Leadership', ids: ['cto', 'cfo', 'ciso', 'vp-product', 'vp-engineering', 'chief-researcher'] },
    { title: 'Product + Design', ids: ['lead-designer', 'tech-writer'] },
    { title: 'Engineering', ids: ['lead-backend', 'lead-frontend', 'qa-lead', 'devops'] },
    { title: 'Specialists', ids: ['security-engineer', 'data-engineer'] },
  ] as const;

  const workingAgentCount = workforceCounts.working;
  const assignedAgentCount = workforceCounts.assigned;
  const reportingAgentCount = workforceCounts.reporting;
  const blockedAgentCount = workforceCounts.blocked;
  const isProjectRunning = activeIds.size > 0 || workingAgentCount > 0 || assignedAgentCount > 0 || reportingAgentCount > 0;
  const syncFreshness = formatFreshness(workforceLive?.client_meta?.last_success_at);
  const baseMotionMode = toMotionMode(activeIds.size, workingAgentCount, blockedAgentCount, workforceStale);
  const motionMode: OrgMotionMode = documentVisible ? baseMotionMode : 'quiet';
  const effectiveVisualizationMode: OverviewVisualizationMode = compactViewport ? 'org_tree' : visualizationMode;
  const activationByAgent = useMemo(
    () => buildActivationEntries(workforceByAgent, activeProjectId),
    [workforceByAgent, activeProjectId],
  );
  const realWorldStates = useMemo(
    () => buildRealWorldStates(agents, workforceByAgent, activationByAgent, isProjectRunning),
    [agents, workforceByAgent, activationByAgent, isProjectRunning],
  );
  const motionVars = {
    ['--org-flow-duration' as any]: motionMode === 'intense' ? '1.05s' : motionMode === 'active' ? '1.45s' : '2.1s',
    ['--org-glow-opacity' as any]: motionMode === 'intense' ? 1 : motionMode === 'active' ? 0.86 : 0.6,
    ['--org-pulse-scale' as any]: motionMode === 'intense' ? 1.12 : motionMode === 'active' ? 1.06 : 1.02,
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
    <div
      ref={chartContainerRef}
      className={`org-chart-shell org-chart-soft-bg ${isProjectRunning ? 'org-chart-running' : ''} org-motion-${motionMode}`}
      style={{ maxWidth: '100%', overflow: 'hidden', ...motionVars }}
    >
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
          {workingAgentCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '10px',
                fontWeight: 600,
                backgroundColor: workingAgentCount > 1 ? 'rgba(63,185,80,0.12)' : 'rgba(63,185,80,0.08)',
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
              {workingAgentCount} working — collaborating
            </span>
          )}
          {hasCanonicalPresence && assignedAgentCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '10px',
                fontWeight: 600,
                backgroundColor: 'rgba(240,170,74,0.12)',
                color: 'var(--tf-warning)',
                border: '1px solid rgba(240,170,74,0.35)',
              }}
            >
              {assignedAgentCount} assigned
            </span>
          )}
          {hasCanonicalPresence && reportingAgentCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '10px',
                fontWeight: 600,
                backgroundColor: 'rgba(59,142,255,0.12)',
                color: 'var(--tf-accent-blue)',
                border: '1px solid rgba(59,142,255,0.35)',
              }}
            >
              {reportingAgentCount} reporting
            </span>
          )}
          {hasCanonicalPresence && blockedAgentCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '10px',
                fontWeight: 600,
                backgroundColor: 'rgba(234,114,103,0.12)',
                color: 'var(--tf-error)',
                border: '1px solid rgba(234,114,103,0.35)',
              }}
            >
              {blockedAgentCount} blocked
            </span>
          )}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '2px 8px',
              borderRadius: '999px',
              fontSize: '10px',
              fontWeight: 600,
              backgroundColor: workforceStale ? 'rgba(234,114,103,0.12)' : 'rgba(59,142,255,0.12)',
              color: workforceStale ? 'var(--tf-error)' : 'var(--tf-accent-blue)',
              border: `1px solid ${workforceStale ? 'rgba(234,114,103,0.35)' : 'rgba(59,142,255,0.35)'}`,
            }}
            title={workforceLive?.client_meta?.last_success_at ? `Last successful sync ${workforceLive.client_meta.last_success_at}` : 'No successful sync yet'}
          >
            {workforceStale ? `stale (${syncFreshness})` : `synced ${syncFreshness}`}
          </span>
          <button
            onClick={() => setShowTruthDrawer((v) => !v)}
            style={{
              borderRadius: '999px',
              border: `1px solid ${showTruthDrawer ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
              backgroundColor: showTruthDrawer ? 'rgba(59,142,255,0.12)' : 'var(--tf-surface)',
              color: showTruthDrawer ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)',
              fontSize: '10px',
              fontWeight: 600,
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            {showTruthDrawer ? 'Hide Live Truth' : 'Live Truth'}
          </button>
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
      {microProjectMode && (
        <p
          style={{
            marginTop: activeProjectId ? '-4px' : '-12px',
            marginBottom: '10px',
            textAlign: 'center',
            fontSize: '10px',
            color: 'var(--tf-warning)',
          }}
        >
          Micro mode active: org chart live state is CEO-only.
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
        {([
          ['org_tree', 'Org Tree'],
          ['real_world', 'Real World'],
        ] as const).map(([mode, label]) => (
          <button
            key={mode}
            onClick={() => setVisualizationMode(mode)}
            disabled={compactViewport && mode === 'real_world'}
            style={{
              borderRadius: '999px',
              border: `1px solid ${effectiveVisualizationMode === mode ? 'var(--tf-success)' : 'var(--tf-border)'}`,
              backgroundColor: effectiveVisualizationMode === mode ? 'rgba(63,185,80,0.12)' : 'var(--tf-surface)',
              color: effectiveVisualizationMode === mode ? 'var(--tf-success)' : 'var(--tf-text-muted)',
              fontSize: '11px',
              fontWeight: 600,
              padding: '4px 12px',
              cursor: compactViewport && mode === 'real_world' ? 'not-allowed' : 'pointer',
              opacity: compactViewport && mode === 'real_world' ? 0.52 : 1,
            }}
            title={compactViewport && mode === 'real_world' ? 'Real World mode is desktop/tablet only.' : undefined}
          >
            {label}
          </button>
        ))}
      </div>
      {compactViewport && (
        <p
          style={{
            textAlign: 'center',
            fontSize: '10px',
            color: 'var(--tf-text-muted)',
            marginTop: '-4px',
            marginBottom: '10px',
          }}
        >
          Real World mode is available on desktop/tablet. Showing Org Tree on mobile.
        </p>
      )}

      {effectiveVisualizationMode === 'org_tree' && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
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
          <button
            onClick={() => setFocusActiveChain((v) => !v)}
            style={{
              borderRadius: '999px',
              border: `1px solid ${focusActiveChain ? 'var(--tf-success)' : 'var(--tf-border)'}`,
              backgroundColor: focusActiveChain ? 'rgba(63,185,80,0.12)' : 'var(--tf-surface)',
              color: focusActiveChain ? 'var(--tf-success)' : 'var(--tf-text-muted)',
              fontSize: '11px',
              fontWeight: 600,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            {focusActiveChain ? 'Focus Chain: On' : 'Focus Chain: Off'}
          </button>
          <button
            onClick={() => setShowHeatOverlay((v) => !v)}
            style={{
              borderRadius: '999px',
              border: `1px solid ${showHeatOverlay ? 'var(--tf-warning)' : 'var(--tf-border)'}`,
              backgroundColor: showHeatOverlay ? 'rgba(240,170,74,0.12)' : 'var(--tf-surface)',
              color: showHeatOverlay ? 'var(--tf-warning)' : 'var(--tf-text-muted)',
              fontSize: '11px',
              fontWeight: 600,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            {showHeatOverlay ? 'Heat Overlay: On' : 'Heat Overlay: Off'}
          </button>
        </div>
      )}

      <OrgLegend motionMode={motionMode} focusActiveChain={focusActiveChain} showHeatOverlay={showHeatOverlay} />

      {showTruthDrawer && (
        <div
          style={{
            marginBottom: '14px',
            border: '1px solid var(--tf-border)',
            borderRadius: '10px',
            backgroundColor: 'var(--tf-surface-raised)',
            padding: '10px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
            <p style={{ fontSize: '11px', fontWeight: 600, color: 'var(--tf-text)', margin: 0 }}>
              Live Workforce Truth
            </p>
            <p style={{ fontSize: '10px', color: 'var(--tf-text-muted)', margin: 0 }}>
              Active means state = <strong>working</strong>. Assigned/reporting/blocked are visible context only.
            </p>
          </div>
          {truthRows.length === 0 ? (
            <p style={{ fontSize: '11px', color: 'var(--tf-text-muted)', margin: 0 }}>
              No live workers in current scope.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '240px', overflowY: 'auto' }}>
              {truthRows.map((row) => {
                const stateVisual = liveStateVisual(row.state);
                const displayAgent = agentMap.get(row.agent_id)?.name || row.agent_name || row.agent_id;
                return (
                  <div
                    key={row.work_item_id || `${row.agent_id}-${row.updated_at}`}
                    style={{
                      border: '1px solid var(--tf-border)',
                      borderRadius: '8px',
                      backgroundColor: 'var(--tf-surface)',
                      padding: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--tf-text)' }}>{displayAgent}</span>
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          color: stateVisual.color,
                          backgroundColor: stateVisual.bg,
                          border: `1px solid ${stateVisual.color}`,
                          borderRadius: '999px',
                          padding: '1px 7px',
                        }}
                      >
                        {liveStateLabel(row.state)}
                      </span>
                      {row.project_id && (
                        <span style={{ fontSize: '10px', color: 'var(--tf-text-muted)' }}>project {row.project_id}</span>
                      )}
                    </div>
                    {row.task && (
                      <p style={{ fontSize: '11px', color: 'var(--tf-text-secondary)', margin: '6px 0 2px' }}>
                        {row.task}
                      </p>
                    )}
                    <p style={{ fontSize: '10px', color: 'var(--tf-text-muted)', margin: 0 }}>
                      run {row.run_id || '(none)'} · source {row.source || 'real'} · started {formatClock(row.started_at)} · elapsed {formatElapsedSeconds(row.elapsed_seconds)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {effectiveVisualizationMode === 'real_world' ? (
        <RealWorldScene
          agents={agents}
          realWorldStates={realWorldStates}
          activationByAgent={activationByAgent}
          motionMode={motionMode}
          isProjectRunning={isProjectRunning}
          syncFreshness={syncFreshness}
          onAgentClick={handleAgentClick}
        />
      ) : layoutMode === 'timeline' ? (
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
                  <OrgNodeCard
                    agent={ceoAgent}
                    decor={{
                      tier: toVisualTier(ceoAgent),
                      state: workforceStateByAgent.get(ceoAgent.id) || 'idle',
                      workloadScore: workloadScoreByAgent.get(ceoAgent.id) || 0,
                      stalenessScore: stalenessScoreByAgent.get(ceoAgent.id) || 0,
                    }}
                    motionMode={motionMode}
                    activationDelayMs={activationByAgent.get(ceoAgent.id)?.activation_delay_ms || 0}
                    activationReason={activationByAgent.get(ceoAgent.id)?.activation_reason}
                    onAgentClick={handleAgentClick}
                    showHeatOverlay={showHeatOverlay}
                    liveState={workforceStateByAgent.get(ceoAgent.id)}
                    liveWorker={workforceByAgent.get(ceoAgent.id)}
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
                      const liveState = workforceStateByAgent.get(agent.id);
                      const nodeVisual = liveStateVisual(liveState);
                      const active = activeIds.has(agent.id);
                      const workload = workloadByAgent.get(agent.id) || 0;
                      const mutedInMicro = (microProjectMode && agent.id !== 'ceo')
                        || (focusActiveChain && focusedAgentIds.size > 0 && !focusedAgentIds.has(agent.id));
                      const showActive = active && !mutedInMicro;
                      const showWorkingPulse = showActive && liveState === 'working';
                      return (
                        <button
                          key={agent.id}
                          onClick={() => handleAgentClick(agent)}
                          className={showWorkingPulse ? 'org-node-active' : ''}
                          style={{
                            border: `1.5px solid ${showActive ? nodeVisual.color : 'var(--tf-border)'}`,
                            backgroundColor: showActive ? nodeVisual.bg : 'var(--tf-surface)',
                            color: showActive ? nodeVisual.color : 'var(--tf-text)',
                            borderRadius: '999px',
                            padding: '4px 9px',
                            fontSize: '11px',
                            fontWeight: showActive ? 600 : 400,
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
                              backgroundColor: showActive ? nodeVisual.color : 'var(--tf-text-muted)',
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
                depth={0}
                agentMap={agentMap}
                onAgentClick={handleAgentClick}
                activeIds={activeIds}
                focusedAgentIds={focusedAgentIds}
                focusActiveChain={focusActiveChain}
                mutedAgentIds={mutedAgentIds}
                flowEdgeDirections={latestFlow.edgeDirections}
                blockedAgentIds={latestFlow.blockedAgentIds}
                liveStateByAgent={workforceStateByAgent}
                liveWorkerByAgent={workforceByAgent}
                workloadScoreByAgent={workloadScoreByAgent}
                stalenessScoreByAgent={stalenessScoreByAgent}
                activationByAgent={activationByAgent}
                showHeatOverlay={showHeatOverlay}
                motionMode={motionMode}
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
  liveEventCount = 0,
  streamSource = 'SSE',
  activeProjectId = '',
  microProjectMode = false,
  loadingAgents,
  loadingProjects,
  loadingTasks,
  workforceLive,
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
          <StatCard
            label={`Live Events ${streamSource === 'Poll' ? '(Poll)' : '(SSE)'}`}
            value={Math.max(events.length, liveEventCount).toString()}
            color="var(--tf-warning)"
            loading={false}
          />
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
            workforceLive={workforceLive}
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
