import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            backgroundColor: 'var(--tf-bg)',
            color: 'var(--tf-text)',
          }}
        >
          <div style={{ textAlign: 'center', padding: '24px', maxWidth: '400px' }}>
            <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--tf-error)', marginBottom: '8px' }}>
              Something went wrong
            </p>
            <p style={{ fontSize: '12px', color: 'var(--tf-text-muted)', marginBottom: '16px', wordBreak: 'break-word' }}>
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                fontSize: '12px',
                padding: '6px 14px',
                borderRadius: '8px',
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-surface-raised)',
                color: 'var(--tf-text)',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
