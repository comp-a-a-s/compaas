import { useMemo } from 'react';
import type { RunIncidentEvent, RunLiveSnapshot } from '../types';

type RunControlAction = 'status' | 'retry_step' | 'cancel' | 'continue';

interface RunDrawerProps {
  open: boolean;
  snapshot: RunLiveSnapshot | null;
  incident: RunIncidentEvent | null;
  controlBusyAction: RunControlAction | '';
  controlMessage: string;
  onClose: () => void;
  onControl: (action: RunControlAction) => void;
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rem = safe % 60;
  if (minutes <= 0) return `${rem}s`;
  return `${minutes}m ${String(rem).padStart(2, '0')}s`;
}

function formatRelativeTime(timestamp: string): string {
  const dt = new Date(timestamp);
  if (Number.isNaN(dt.getTime())) return 'unknown';
  const delta = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  const minutes = Math.floor(delta / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function statusTone(state: string): string {
  if (state === 'done') return 'var(--tf-success)';
  if (state === 'failed' || state === 'cancelled') return 'var(--tf-error)';
  if (state === 'verifying') return 'var(--tf-accent-blue)';
  return 'var(--tf-accent)';
}

export default function RunDrawer({
  open,
  snapshot,
  incident,
  controlBusyAction,
  controlMessage,
  onClose,
  onControl,
}: RunDrawerProps) {
  const runStatus = snapshot?.run_status;
  const timeline = useMemo(() => {
    const rows = snapshot?.run?.timeline;
    if (!Array.isArray(rows)) return [];
    return rows.slice(-8).reverse();
  }, [snapshot?.run?.timeline]);

  if (!open) return null;

  return (
    <aside className="run-drawer" aria-label="Run progress drawer">
      <div className="run-drawer-header">
        <div className="run-drawer-title-wrap">
          <h3 className="run-drawer-title">Run Progress</h3>
          {runStatus && (
            <span className="run-drawer-state" style={{ color: statusTone(String(runStatus.state || '').toLowerCase()) }}>
              {String(runStatus.state || 'running').toUpperCase()}
            </span>
          )}
        </div>
        <button type="button" className="run-drawer-close" onClick={onClose} aria-label="Close run drawer">
          ✕
        </button>
      </div>

      {!snapshot || !runStatus ? (
        <div className="run-drawer-empty">No active run.</div>
      ) : (
        <div className="run-drawer-body">
          <section className="run-drawer-card">
            <div className="run-drawer-grid">
              <div>
                <div className="run-drawer-k">Phase</div>
                <div className="run-drawer-v">{runStatus.phase_label || 'Running'}</div>
              </div>
              <div>
                <div className="run-drawer-k">Elapsed</div>
                <div className="run-drawer-v">{formatElapsed(runStatus.elapsed_seconds || 0)}</div>
              </div>
              <div>
                <div className="run-drawer-k">Last update</div>
                <div className="run-drawer-v">{formatRelativeTime(runStatus.last_activity_at)}</div>
              </div>
              <div>
                <div className="run-drawer-k">Heartbeat</div>
                <div className="run-drawer-v">#{runStatus.heartbeat_seq || 0}</div>
              </div>
            </div>
          </section>

          {incident && (
            <section className={`run-drawer-card run-incident run-incident-${incident.severity}`}>
              <div className="run-incident-title">
                {incident.severity === 'critical' ? 'Critical incident' : 'Watchdog warning'}
              </div>
              <div className="run-incident-body">
                {incident.reason.replace(/_/g, ' ')} • inactive {Math.max(0, Math.floor(incident.inactive_seconds || 0))}s
              </div>
              <div className="run-incident-actions">
                {(['status', 'retry_step', 'cancel', 'continue'] as const).map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={`run-incident-btn ${action === 'status' ? 'run-incident-btn-default' : ''}`}
                    onClick={() => onControl(action)}
                    disabled={Boolean(controlBusyAction)}
                  >
                    {controlBusyAction === action ? '...' : action === 'retry_step' ? 'Retry Step' : action === 'continue' ? 'Continue' : action === 'status' ? 'Get Status' : 'Cancel Run'}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="run-drawer-card">
            <div className="run-drawer-section-title">Guardrails</div>
            <div className="run-drawer-grid">
              <div>
                <div className="run-drawer-k">Commands left</div>
                <div className="run-drawer-v">{runStatus.guardrails.command_budget_remaining}</div>
              </div>
              <div>
                <div className="run-drawer-k">Files left</div>
                <div className="run-drawer-v">{runStatus.guardrails.file_budget_remaining}</div>
              </div>
              <div>
                <div className="run-drawer-k">Runtime left</div>
                <div className="run-drawer-v">{formatElapsed(runStatus.guardrails.runtime_budget_remaining)}</div>
              </div>
              <div>
                <div className="run-drawer-k">Over budget</div>
                <div className="run-drawer-v">{runStatus.guardrails.over_budget ? 'Yes' : 'No'}</div>
              </div>
            </div>
          </section>

          <section className="run-drawer-card">
            <div className="run-drawer-section-title">Active Agents</div>
            {runStatus.active_agents.length === 0 ? (
              <div className="run-drawer-empty-small">No active agents reported yet.</div>
            ) : (
              <div className="run-agents-list">
                {runStatus.active_agents.map((agent) => (
                  <div key={`${agent.agent_id}-${agent.state}`} className="run-agent-row">
                    <div className="run-agent-name">{agent.agent_name}</div>
                    <div className="run-agent-state">{agent.state}</div>
                    {agent.task && <div className="run-agent-task">{agent.task}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="run-drawer-card">
            <div className="run-drawer-section-title">Latest Timeline</div>
            {timeline.length === 0 ? (
              <div className="run-drawer-empty-small">No timeline entries yet.</div>
            ) : (
              <div className="run-timeline-list">
                {timeline.map((entry, idx) => (
                  <div key={`${String(entry.timestamp || idx)}-${idx}`} className="run-timeline-row">
                    <div className="run-timeline-time">{formatRelativeTime(String(entry.timestamp || ''))}</div>
                    <div className="run-timeline-label">{String(entry.label || entry.state || 'Update')}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {controlMessage && (
            <section className="run-drawer-card">
              <div className="run-control-message">{controlMessage}</div>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

