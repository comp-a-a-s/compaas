import { useState, useEffect, useMemo } from 'react';
import type { Agent, WorkforceLiveSnapshot, WorkforceWorker } from '../types';
import Tooltip from './Tooltip';

interface TeamPulseProps {
  agents: Agent[];
  workforceLive?: WorkforceLiveSnapshot;
  isMobile?: boolean;
}

function modelColor(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('codex')) return 'var(--tf-success)';
  if (m.includes('opus')) return 'var(--tf-accent)';
  if (m.includes('sonnet')) return 'var(--tf-accent-blue)';
  if (m.includes('haiku')) return 'var(--tf-success)';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'var(--tf-accent-blue)';
  if (m.includes('llama') || m.includes('qwen') || m.includes('mistral') || m.includes('gemma')) return 'var(--tf-warning)';
  return 'var(--tf-text-secondary)';
}

function formatElapsed(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
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

const MAX_VISIBLE = 6;

interface WorkingItem {
  agent: Agent | null;
  worker: WorkforceWorker;
}

export default function TeamPulse({ agents, workforceLive, isMobile = false }: TeamPulseProps) {
  const [expanded, setExpanded] = useState(false);

  const workingList = useMemo<WorkingItem[]>(() => {
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    const workers = (workforceLive?.workers || [])
      .filter((worker) => worker.state === 'working')
      .slice()
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

    return workers.map((worker) => {
      const canonicalId = String(worker.agent_id || '').trim().toLowerCase().replace(/\s+/g, '-');
      return {
        agent: agentMap.get(canonicalId) || null,
        worker,
      };
    });
  }, [agents, workforceLive?.workers]);

  useEffect(() => {
    if (workingList.length !== 0 || !expanded) return;
    const timer = window.setTimeout(() => setExpanded(false), 0);
    return () => window.clearTimeout(timer);
  }, [workingList.length, expanded]);

  if (workingList.length === 0) return null;

  const freshness = formatFreshness(workforceLive?.client_meta?.last_success_at);
  const stale = Boolean(workforceLive?.client_meta?.stale);
  const visible = workingList.slice(0, MAX_VISIBLE);
  const overflow = workingList.length - MAX_VISIBLE;

  const truthPanel = (
    <div
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: '6px',
        minWidth: isMobile ? '220px' : '260px',
        maxWidth: '340px',
        borderRadius: '10px',
        border: '1px solid var(--tf-border)',
        backgroundColor: 'var(--tf-surface)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        padding: '8px',
        zIndex: 60,
        animation: 'slide-up 0.15s ease-out both',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '4px 6px', marginBottom: '4px' }}>
        <p
          style={{
            fontSize: '10px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--tf-text-muted)',
            margin: 0,
          }}
        >
          Live Workforce Truth
        </p>
        <span style={{ fontSize: '10px', color: stale ? 'var(--tf-error)' : 'var(--tf-accent-blue)' }}>
          {stale ? `stale (${freshness})` : `synced ${freshness}`}
        </span>
      </div>

      {workingList.map(({ agent, worker }) => {
        const color = modelColor(agent?.runtime_model || agent?.model || '');
        const displayName = agent?.name || worker.agent_name || worker.agent_id;
        return (
          <div
            key={worker.work_item_id || `${worker.agent_id}-${worker.updated_at}`}
            style={{
              display: 'flex',
              gap: '8px',
              padding: '6px',
              borderRadius: '6px',
              border: '1px solid var(--tf-border)',
              marginBottom: '6px',
              backgroundColor: 'var(--tf-surface-raised)',
            }}
          >
            <div
              style={{
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                backgroundColor: color,
                color: 'var(--tf-bg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '10px',
                fontWeight: 700,
                flexShrink: 0,
                boxShadow: '0 0 0 2px var(--tf-success)',
              }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--tf-text)', margin: 0 }}>
                {displayName}
              </p>
              <p
                style={{
                  fontSize: '10px',
                  color: 'var(--tf-text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  margin: '1px 0 0',
                }}
                title={worker.task || 'Working'}
              >
                {worker.task || 'Working'}
              </p>
              <p style={{ fontSize: '10px', color: 'var(--tf-text-muted)', margin: '2px 0 0' }}>
                run {worker.run_id || '(none)'} · source {worker.source || 'real'} · started {formatClock(worker.started_at)} · elapsed {formatElapsed(worker.elapsed_seconds)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (isMobile) {
    return (
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 cursor-pointer"
          style={{
            height: '28px',
            padding: '0 8px',
            borderRadius: '999px',
            border: '1px solid rgba(63,185,80,0.3)',
            backgroundColor: 'rgba(63,185,80,0.08)',
            color: 'var(--tf-success)',
            fontSize: '11px',
            fontWeight: 600,
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: 'var(--tf-success)',
              animation: 'pulse-ring 1.8s ease-out infinite',
            }}
          />
          {workingList.length} working
        </button>
        {expanded && truthPanel}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1" style={{ height: '34px', position: 'relative' }}>
      {visible.map(({ agent, worker }) => {
        const color = modelColor(agent?.runtime_model || agent?.model || '');
        const displayName = agent?.name || worker.agent_name || worker.agent_id;
        const tooltipText = `${displayName} — ${worker.task || 'Working'}\nrun ${worker.run_id || '(none)'} · source ${worker.source || 'real'} · started ${formatClock(worker.started_at)} · elapsed ${formatElapsed(worker.elapsed_seconds)}`;
        return (
          <Tooltip key={worker.work_item_id || `${worker.agent_id}-${worker.updated_at}`} content={tooltipText} position="bottom">
            <div
              className="team-pulse-avatar"
              style={{
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                backgroundColor: color,
                color: 'var(--tf-bg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '10px',
                fontWeight: 700,
                position: 'relative',
                cursor: 'default',
                animation: 'team-pulse-in 0.25s ease-out both',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: '-3px',
                  borderRadius: '50%',
                  border: '1.5px solid var(--tf-success)',
                  opacity: 0.7,
                  animation: 'pulse-ring 2s ease-out infinite',
                }}
              />
              {displayName.charAt(0).toUpperCase()}
            </div>
          </Tooltip>
        );
      })}

      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          height: '22px',
          padding: '0 8px',
          borderRadius: '999px',
          backgroundColor: expanded ? 'rgba(63,185,80,0.18)' : 'rgba(63,185,80,0.1)',
          color: 'var(--tf-success)',
          fontSize: '10px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          border: '1px solid rgba(63,185,80,0.25)',
          cursor: 'pointer',
        }}
        title={stale ? `Workforce stale (${freshness})` : `Workforce synced ${freshness}`}
      >
        {workingList.length} working
      </button>

      {overflow > 0 && (
        <Tooltip
          content={workingList.slice(MAX_VISIBLE).map(({ agent, worker }) => agent?.name || worker.agent_name || worker.agent_id).join(', ')}
          position="bottom"
        >
          <div
            style={{
              height: '22px',
              padding: '0 6px',
              borderRadius: '999px',
              backgroundColor: 'rgba(63,185,80,0.12)',
              color: 'var(--tf-success)',
              fontSize: '10px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              border: '1px solid rgba(63,185,80,0.25)',
            }}
          >
            +{overflow}
          </div>
        </Tooltip>
      )}

      {expanded && truthPanel}
    </div>
  );
}
