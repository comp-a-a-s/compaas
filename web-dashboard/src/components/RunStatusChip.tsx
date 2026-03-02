import type { RunIncidentEvent, RunStatusEvent } from '../types';

interface RunStatusChipProps {
  status: RunStatusEvent | null;
  incident: RunIncidentEvent | null;
  open: boolean;
  onToggle: () => void;
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rem = safe % 60;
  if (minutes <= 0) return `${rem}s`;
  return `${minutes}m ${String(rem).padStart(2, '0')}s`;
}

function isTerminal(state: string): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}

export default function RunStatusChip({ status, incident, open, onToggle }: RunStatusChipProps) {
  if (!status) return null;
  const state = String(status.state || '').toLowerCase();
  const tone = incident?.severity === 'critical'
    ? 'var(--tf-error)'
    : incident?.severity === 'warning'
      ? 'var(--tf-warning)'
      : state === 'done'
        ? 'var(--tf-success)'
        : state === 'failed' || state === 'cancelled'
          ? 'var(--tf-error)'
          : 'var(--tf-accent)';
  const label = state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Running';
  const elapsed = formatElapsed(status.elapsed_seconds || 0);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="run-status-chip"
      aria-label={open ? 'Close run drawer' : 'Open run drawer'}
      title={open ? 'Close run drawer' : 'Open run drawer'}
    >
      <span className={`run-status-chip-dot ${!isTerminal(state) ? 'animate-pulse-dot' : ''}`} style={{ backgroundColor: tone }} />
      <span className="run-status-chip-label">{label}</span>
      <span className="run-status-chip-sep">•</span>
      <span className="run-status-chip-elapsed">{elapsed}</span>
    </button>
  );
}

