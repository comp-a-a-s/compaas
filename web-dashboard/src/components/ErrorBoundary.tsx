import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  fingerprint: string;
  readinessLoading: boolean;
  readinessSummary: string;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

const LOCAL_STORAGE_PREFIXES = ['compaas_', 'tf_'];
const LOCAL_STORAGE_KEYS = [
  'MICRO_PROJECT_MODE',
  'TELEGRAM_MIRROR_ENABLED',
  'SETTINGS_TAB',
  'tf_pinned_msgs',
  'tf_compact_mode',
  'tf_agent_models',
  'tf_agent_personas',
];

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      fingerprint: '',
      readinessLoading: false,
      readinessSummary: '',
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    const fingerprint = `eb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      hasError: true,
      error,
      fingerprint,
      readinessLoading: false,
      readinessSummary: '',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep console trace for local support diagnostics.
    console.error('[COMPaaS] ErrorBoundary captured runtime failure', {
      fingerprint: this.state.fingerprint,
      error,
      componentStack: info.componentStack,
    });
  }

  private resetBoundary = () => {
    this.setState({
      hasError: false,
      error: null,
      fingerprint: '',
      readinessLoading: false,
      readinessSummary: '',
    });
  };

  private reloadApp = () => {
    window.location.reload();
  };

  private resetLocalUiState = () => {
    try {
      const keysToRemove: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) || '';
        if (!key) continue;
        if (LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)) || LOCAL_STORAGE_KEYS.includes(key)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
      this.setState({ readinessSummary: 'Local UI state was reset. Reload to start clean.' });
    } catch {
      this.setState({ readinessSummary: 'Unable to reset local UI state. Check browser storage permissions.' });
    }
  };

  private copyDiagnostics = async () => {
    const errorText = this.state.error?.stack || this.state.error?.message || 'Unknown runtime error';
    const payload = [
      `Fingerprint: ${this.state.fingerprint || 'n/a'}`,
      `User Agent: ${navigator.userAgent}`,
      `URL: ${window.location.href}`,
      '',
      errorText,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      this.setState({ readinessSummary: 'Diagnostics copied to clipboard.' });
    } catch {
      this.setState({ readinessSummary: 'Unable to copy diagnostics. Check clipboard permissions.' });
    }
  };

  private checkReadiness = async () => {
    this.setState({ readinessLoading: true, readinessSummary: '' });
    try {
      const response = await fetch('/api/v1/system/readiness');
      if (!response.ok) {
        this.setState({
          readinessLoading: false,
          readinessSummary: `Readiness check failed (HTTP ${response.status}).`,
        });
        return;
      }
      const payload = await response.json() as {
        status?: string;
        provider?: { name?: string; mode?: string; ready?: boolean; reason?: string };
        workspace?: { exists?: boolean; writable?: boolean };
        latest_incident?: { reason?: string; severity?: string } | null;
      };
      const providerName = String(payload.provider?.name || 'provider');
      const providerMode = String(payload.provider?.mode || 'default');
      const providerReady = payload.provider?.ready !== false;
      const providerReason = String(payload.provider?.reason || '').trim();
      const workspaceReady = Boolean(payload.workspace?.exists) && Boolean(payload.workspace?.writable);
      const incident = payload.latest_incident
        ? `${String(payload.latest_incident.severity || '').toLowerCase() || 'warning'}:${String(payload.latest_incident.reason || '')}`
        : 'none';
      const lines = [
        `Readiness: ${String(payload.status || 'unknown')}`,
        `Provider: ${providerName} (${providerMode}) ${providerReady ? 'ready' : 'not ready'}`,
        providerReason ? `Provider detail: ${providerReason}` : '',
        `Workspace writable: ${workspaceReady ? 'yes' : 'no'}`,
        `Latest incident: ${incident}`,
      ].filter(Boolean);
      this.setState({
        readinessLoading: false,
        readinessSummary: lines.join('\n'),
      });
    } catch {
      this.setState({
        readinessLoading: false,
        readinessSummary: 'Readiness check failed due to network/runtime error.',
      });
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            backgroundColor: 'var(--tf-bg)',
            color: 'var(--tf-text)',
            padding: '20px',
          }}
        >
          <div
            style={{
              width: 'min(760px, 100%)',
              textAlign: 'left',
              border: '1px solid var(--tf-border)',
              borderRadius: '14px',
              backgroundColor: 'var(--tf-surface)',
              padding: '18px',
            }}
          >
            <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--tf-error)' }}>
              Something went wrong
            </p>
            <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--tf-text-secondary)', wordBreak: 'break-word', lineHeight: 1.55 }}>
              {this.state.error?.message || 'An unexpected runtime error occurred.'}
            </p>
            {this.state.fingerprint && (
              <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--tf-text-muted)' }}>
                Error fingerprint: {this.state.fingerprint}
              </p>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' }}>
              <button
                onClick={this.resetBoundary}
                style={{
                  fontSize: '12px',
                  padding: '7px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-surface-raised)',
                  color: 'var(--tf-text)',
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <button
                onClick={this.reloadApp}
                style={{
                  fontSize: '12px',
                  padding: '7px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-surface-raised)',
                  color: 'var(--tf-text)',
                  cursor: 'pointer',
                }}
              >
                Reload app
              </button>
              <button
                onClick={this.resetLocalUiState}
                style={{
                  fontSize: '12px',
                  padding: '7px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-surface-raised)',
                  color: 'var(--tf-text)',
                  cursor: 'pointer',
                }}
              >
                Reset local UI state
              </button>
              <button
                onClick={() => { void this.copyDiagnostics(); }}
                style={{
                  fontSize: '12px',
                  padding: '7px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-surface-raised)',
                  color: 'var(--tf-text)',
                  cursor: 'pointer',
                }}
              >
                Copy diagnostics
              </button>
              <button
                onClick={() => { void this.checkReadiness(); }}
                disabled={this.state.readinessLoading}
                style={{
                  fontSize: '12px',
                  padding: '7px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: this.state.readinessLoading ? 'var(--tf-surface-raised)' : 'var(--tf-accent-dim)',
                  color: this.state.readinessLoading ? 'var(--tf-text-muted)' : 'var(--tf-text)',
                  cursor: this.state.readinessLoading ? 'default' : 'pointer',
                }}
              >
                {this.state.readinessLoading ? 'Checking readiness…' : 'Check readiness'}
              </button>
            </div>

            {this.state.readinessSummary && (
              <pre
                style={{
                  marginTop: '12px',
                  fontSize: '11px',
                  color: 'var(--tf-text-muted)',
                  whiteSpace: 'pre-wrap',
                  backgroundColor: 'var(--tf-bg)',
                  border: '1px solid var(--tf-border)',
                  borderRadius: '8px',
                  padding: '10px',
                }}
              >
                {this.state.readinessSummary}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
