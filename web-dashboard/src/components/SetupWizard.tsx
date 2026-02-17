import { useState } from 'react';
import { saveSetupConfig } from '../api/client';
import type { AppConfig } from '../types';

// ---- Types ----

interface AgentDefault {
  id: string;
  role: string;
  defaultName: string;
}

interface SetupWizardProps {
  onComplete: () => void;
}

// ---- Constants ----

const TOTAL_STEPS = 5;

const AGENT_DEFAULTS: AgentDefault[] = [
  { id: 'marcus', role: 'CEO', defaultName: 'Marcus' },
  { id: 'elena', role: 'CTO', defaultName: 'Elena' },
  { id: 'victor', role: 'Chief Researcher', defaultName: 'Victor' },
  { id: 'rachel', role: 'CISO', defaultName: 'Rachel' },
  { id: 'jonathan', role: 'CFO', defaultName: 'Jonathan' },
  { id: 'sarah', role: 'VP Product', defaultName: 'Sarah' },
  { id: 'david', role: 'VP Engineering', defaultName: 'David' },
  { id: 'james', role: 'Lead Backend', defaultName: 'James' },
  { id: 'priya', role: 'Lead Frontend', defaultName: 'Priya' },
  { id: 'lena', role: 'Lead Designer', defaultName: 'Lena' },
  { id: 'carlos', role: 'QA Lead', defaultName: 'Carlos' },
  { id: 'nina', role: 'DevOps', defaultName: 'Nina' },
  { id: 'alex', role: 'Security Engineer', defaultName: 'Alex' },
  { id: 'maya', role: 'Data Engineer', defaultName: 'Maya' },
  { id: 'tom', role: 'Tech Writer', defaultName: 'Tom' },
];

const POLL_INTERVAL_OPTIONS = [
  { label: '3 seconds', value: 3000 },
  { label: '5 seconds', value: 5000 },
  { label: '10 seconds', value: 10000 },
  { label: '30 seconds', value: 30000 },
];

// ---- Colours (centralised for easy reference) ----

const C = {
  bg: '#0d1117',
  surface: '#161b22',
  surfaceRaised: '#21262d',
  border: '#30363d',
  textPrimary: '#e6edf3',
  textSecondary: '#8b949e',
  textMuted: '#484f58',
  accent: '#58a6ff',
  accentDim: '#1f6feb',
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
} as const;

// ---- Step indicator ----

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div
      className="flex items-center justify-center gap-2"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={`Step ${current} of ${total}`}
    >
      {Array.from({ length: total }, (_, i) => {
        const step = i + 1;
        const isDone = step < current;
        const isActive = step === current;
        return (
          <div key={step} className="flex items-center gap-2">
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: 600,
                border: `1px solid ${isActive ? C.accent : isDone ? C.accentDim : C.border}`,
                backgroundColor: isActive ? C.accentDim : isDone ? 'rgba(31,111,235,0.2)' : C.surfaceRaised,
                color: isActive ? C.textPrimary : isDone ? C.accent : C.textMuted,
                transition: 'all 0.2s',
              }}
              aria-hidden="true"
            >
              {isDone ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2 6l3 3 5-5" stroke={C.accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                step
              )}
            </div>
            {step < total && (
              <div
                style={{
                  width: '24px',
                  height: '1px',
                  backgroundColor: step < current ? C.accentDim : C.border,
                  transition: 'background-color 0.2s',
                }}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Sub-step components ----

function StepWelcome() {
  return (
    <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
      <div
        style={{
          width: '56px',
          height: '56px',
          borderRadius: '12px',
          backgroundColor: C.accentDim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 24px',
          border: `1px solid ${C.accent}`,
        }}
        aria-hidden="true"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style={{ color: C.textPrimary }}>
          <path d="M12 2L2 8.5l10 13.5 10-13.5L12 2z" />
        </svg>
      </div>
      <h2 style={{ fontSize: '22px', fontWeight: 700, color: C.textPrimary, marginBottom: '12px' }}>
        Welcome to CrackPie
      </h2>
      <p style={{ fontSize: '14px', color: C.textSecondary, lineHeight: '1.6', maxWidth: '480px', margin: '0 auto' }}>
        CrackPie is your AI-powered virtual company dashboard. You direct a team of 15 autonomous agents
        across engineering, product, research, and operations. This wizard takes about 2 minutes to configure
        your workspace.
      </p>
    </div>
  );
}

function StepBoardHead({
  userName,
  onUserNameChange,
}: {
  userName: string;
  onUserNameChange: (v: string) => void;
}) {
  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        Your Name
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '24px' }}>
        This is how agents will address you in conversations and reports.
      </p>
      <div>
        <label
          htmlFor="board-head-name"
          style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: C.textSecondary, marginBottom: '6px' }}
        >
          Your name (Board Head)
        </label>
        <input
          id="board-head-name"
          type="text"
          value={userName}
          onChange={(e) => onUserNameChange(e.target.value)}
          placeholder="e.g. Idan"
          autoFocus
          style={{
            width: '100%',
            padding: '9px 12px',
            backgroundColor: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: '6px',
            color: C.textPrimary,
            fontSize: '14px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      </div>
    </div>
  );
}

function StepTeamNames({
  agentNames,
  onAgentNameChange,
}: {
  agentNames: Record<string, string>;
  onAgentNameChange: (id: string, v: string) => void;
}) {
  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        Team Names
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '20px' }}>
        Customise the display name for each agent. Pre-filled with defaults.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '12px',
          maxHeight: '360px',
          overflowY: 'auto',
          paddingRight: '4px',
        }}
      >
        {AGENT_DEFAULTS.map((agent) => (
          <div
            key={agent.id}
            style={{
              backgroundColor: C.surfaceRaised,
              border: `1px solid ${C.border}`,
              borderRadius: '8px',
              padding: '12px',
            }}
          >
            <div style={{ marginBottom: '8px' }}>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: C.textMuted,
                }}
              >
                {agent.id}
              </span>
              <div style={{ fontSize: '11px', color: C.accent, marginTop: '2px' }}>
                {agent.role}
              </div>
            </div>
            <label
              htmlFor={`agent-name-${agent.id}`}
              style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
            >
              Name for {agent.role}
            </label>
            <input
              id={`agent-name-${agent.id}`}
              type="text"
              value={agentNames[agent.id] ?? agent.defaultName}
              onChange={(e) => onAgentNameChange(agent.id, e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                backgroundColor: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: '4px',
                color: C.textPrimary,
                fontSize: '13px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepPreferences({
  autoOpenBrowser,
  pollInterval,
  onAutoOpenChange,
  onPollIntervalChange,
}: {
  autoOpenBrowser: boolean;
  pollInterval: number;
  onAutoOpenChange: (v: boolean) => void;
  onPollIntervalChange: (v: number) => void;
}) {
  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        Preferences
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '24px' }}>
        Configure runtime behaviour. These can be changed later in Settings.
      </p>

      {/* Auto-open browser toggle */}
      <div
        style={{
          backgroundColor: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ fontSize: '14px', fontWeight: 500, color: C.textPrimary, marginBottom: '2px' }}>
            Auto-open browser
          </div>
          <div style={{ fontSize: '12px', color: C.textSecondary }}>
            Automatically open the dashboard when crackpie-web starts.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={autoOpenBrowser}
          onClick={() => onAutoOpenChange(!autoOpenBrowser)}
          style={{
            position: 'relative',
            width: '44px',
            height: '24px',
            borderRadius: '12px',
            border: 'none',
            cursor: 'pointer',
            backgroundColor: autoOpenBrowser ? C.accentDim : C.surfaceRaised,
            outline: 'none',
            transition: 'background-color 0.2s',
            flexShrink: 0,
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: autoOpenBrowser ? C.accent : C.border,
            padding: 0,
          }}
          onFocus={(e) => { e.currentTarget.style.boxShadow = `0 0 0 2px ${C.accentDim}`; }}
          onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
          aria-label="Auto-open browser"
        >
          <span
            style={{
              position: 'absolute',
              top: '3px',
              left: autoOpenBrowser ? '22px' : '3px',
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              backgroundColor: autoOpenBrowser ? C.accent : C.textMuted,
              transition: 'left 0.2s, background-color 0.2s',
            }}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Poll interval dropdown */}
      <div
        style={{
          backgroundColor: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          borderRadius: '8px',
          padding: '16px',
        }}
      >
        <label
          htmlFor="poll-interval"
          style={{ display: 'block', fontSize: '14px', fontWeight: 500, color: C.textPrimary, marginBottom: '2px' }}
        >
          Poll interval
        </label>
        <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '10px' }}>
          How often the dashboard fetches updated data from the backend.
        </p>
        <select
          id="poll-interval"
          value={pollInterval}
          onChange={(e) => onPollIntervalChange(Number(e.target.value))}
          style={{
            padding: '8px 12px',
            backgroundColor: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: '6px',
            color: C.textPrimary,
            fontSize: '13px',
            outline: 'none',
            cursor: 'pointer',
            minWidth: '160px',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        >
          {POLL_INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function StepComplete({
  userName,
  agentNames,
  autoOpenBrowser,
  pollInterval,
}: {
  userName: string;
  agentNames: Record<string, string>;
  autoOpenBrowser: boolean;
  pollInterval: number;
}) {
  const pollLabel = POLL_INTERVAL_OPTIONS.find((o) => o.value === pollInterval)?.label ?? `${pollInterval}ms`;
  const nameCount = Object.keys(agentNames).length;

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        Ready to launch
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '20px' }}>
        Review your configuration before starting the dashboard.
      </p>

      <div
        style={{
          backgroundColor: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          borderRadius: '8px',
          overflow: 'hidden',
          marginBottom: '16px',
        }}
      >
        {[
          { label: 'Board Head', value: userName || '(not set)' },
          { label: 'Team size', value: `${nameCount} agents configured` },
          { label: 'Auto-open browser', value: autoOpenBrowser ? 'Enabled' : 'Disabled' },
          { label: 'Poll interval', value: pollLabel },
        ].map((row, idx, arr) => (
          <div
            key={row.label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: idx < arr.length - 1 ? `1px solid ${C.border}` : 'none',
            }}
          >
            <span style={{ fontSize: '13px', color: C.textSecondary }}>{row.label}</span>
            <span style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary }}>{row.value}</span>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 14px',
          backgroundColor: 'rgba(63,185,80,0.08)',
          border: `1px solid rgba(63,185,80,0.25)`,
          borderRadius: '6px',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 8l4 4 8-8" stroke={C.success} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: '13px', color: C.success }}>
          Configuration will be saved and the dashboard will load.
        </span>
      </div>
    </div>
  );
}

// ---- Main component ----

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(1);
  const [userName, setUserName] = useState('');
  const [agentNames, setAgentNames] = useState<Record<string, string>>(
    Object.fromEntries(AGENT_DEFAULTS.map((a) => [a.id, a.defaultName]))
  );
  const [autoOpenBrowser, setAutoOpenBrowser] = useState(true);
  const [pollInterval, setPollInterval] = useState(5000);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleAgentNameChange = (id: string, value: string) => {
    setAgentNames((prev) => ({ ...prev, [id]: value }));
  };

  const canProceed = () => {
    if (step === 2 && !userName.trim()) return false;
    return true;
  };

  const handleNext = () => {
    if (step < TOTAL_STEPS) setStep((s) => s + 1);
  };

  const handleBack = () => {
    if (step > 1) setStep((s) => s - 1);
  };

  const handleLaunch = async () => {
    setSubmitting(true);
    setSubmitError(null);

    const config: Partial<AppConfig> = {
      setup_complete: true,
      user: { name: userName.trim() },
      agents: agentNames,
      ui: {
        theme: 'dark',
        poll_interval_ms: pollInterval,
      },
      // host and port are set server-side; we only send the user-configurable flag
      server: {
        host: '',
        port: 0,
        auto_open_browser: autoOpenBrowser,
      },
    };

    const ok = await saveSetupConfig(config);

    if (ok) {
      onComplete();
    } else {
      setSubmitError('Failed to save configuration. Please check that the crackpie-web server is running and try again.');
      setSubmitting(false);
    }
  };

  const stepLabels = ['Welcome', 'Your Name', 'Team Names', 'Preferences', 'Complete'];

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: C.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
      }}
      role="main"
    >
      <div
        style={{
          width: '100%',
          maxWidth: '640px',
        }}
      >
        {/* Card */}
        <div
          style={{
            backgroundColor: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: '12px',
            overflow: 'hidden',
          }}
          aria-label="Setup wizard"
        >
          {/* Card header */}
          <div
            style={{
              padding: '20px 24px 16px',
              borderBottom: `1px solid ${C.border}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '6px',
                  backgroundColor: C.accentDim,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
                aria-hidden="true"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: C.textPrimary }}>
                  <path d="M12 2L2 8.5l10 13.5 10-13.5L12 2z" />
                </svg>
              </div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>CrackPie Setup</span>
              <span
                style={{
                  fontSize: '11px',
                  color: C.textSecondary,
                  backgroundColor: C.surfaceRaised,
                  border: `1px solid ${C.border}`,
                  borderRadius: '4px',
                  padding: '1px 7px',
                  marginLeft: '4px',
                }}
              >
                {stepLabels[step - 1]}
              </span>
            </div>
            <StepIndicator current={step} total={TOTAL_STEPS} />
          </div>

          {/* Card body */}
          <div style={{ padding: '28px 24px 20px' }}>
            {step === 1 && <StepWelcome />}
            {step === 2 && (
              <StepBoardHead
                userName={userName}
                onUserNameChange={setUserName}
              />
            )}
            {step === 3 && (
              <StepTeamNames
                agentNames={agentNames}
                onAgentNameChange={handleAgentNameChange}
              />
            )}
            {step === 4 && (
              <StepPreferences
                autoOpenBrowser={autoOpenBrowser}
                pollInterval={pollInterval}
                onAutoOpenChange={setAutoOpenBrowser}
                onPollIntervalChange={setPollInterval}
              />
            )}
            {step === 5 && (
              <StepComplete
                userName={userName}
                agentNames={agentNames}
                autoOpenBrowser={autoOpenBrowser}
                pollInterval={pollInterval}
              />
            )}

            {submitError && (
              <div
                role="alert"
                aria-live="polite"
                style={{
                  marginTop: '16px',
                  padding: '10px 14px',
                  backgroundColor: 'rgba(248,81,73,0.1)',
                  border: `1px solid rgba(248,81,73,0.3)`,
                  borderRadius: '6px',
                  fontSize: '13px',
                  color: C.error,
                }}
              >
                {submitError}
              </div>
            )}
          </div>

          {/* Card footer: navigation */}
          <div
            style={{
              padding: '16px 24px',
              borderTop: `1px solid ${C.border}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            {/* Back button */}
            <button
              onClick={handleBack}
              disabled={step === 1}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: `1px solid ${step === 1 ? C.textMuted : C.border}`,
                backgroundColor: 'transparent',
                color: step === 1 ? C.textMuted : C.textSecondary,
                fontSize: '13px',
                fontWeight: 500,
                cursor: step === 1 ? 'default' : 'pointer',
                transition: 'all 0.15s',
                opacity: step === 1 ? 0.4 : 1,
              }}
              onMouseEnter={(e) => {
                if (step !== 1) {
                  e.currentTarget.style.backgroundColor = C.surfaceRaised;
                  e.currentTarget.style.color = C.textPrimary;
                }
              }}
              onMouseLeave={(e) => {
                if (step !== 1) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = C.textSecondary;
                }
              }}
              aria-label="Go to previous step"
            >
              Back
            </button>

            {/* Step counter */}
            <span style={{ fontSize: '12px', color: C.textMuted }}>
              {step} / {TOTAL_STEPS}
            </span>

            {/* Next / Launch button */}
            {step < TOTAL_STEPS ? (
              <button
                onClick={handleNext}
                disabled={!canProceed()}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: `1px solid ${canProceed() ? C.accent : C.textMuted}`,
                  backgroundColor: canProceed() ? C.accentDim : C.surfaceRaised,
                  color: canProceed() ? C.textPrimary : C.textMuted,
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: canProceed() ? 'pointer' : 'default',
                  transition: 'all 0.15s',
                  opacity: canProceed() ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  if (canProceed()) e.currentTarget.style.backgroundColor = '#388bfd22';
                }}
                onMouseLeave={(e) => {
                  if (canProceed()) e.currentTarget.style.backgroundColor = C.accentDim;
                }}
                aria-label={step === 1 ? 'Get Started' : 'Go to next step'}
              >
                {step === 1 ? 'Get Started' : 'Next'}
              </button>
            ) : (
              <button
                onClick={handleLaunch}
                disabled={submitting}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: `1px solid ${C.success}`,
                  backgroundColor: 'rgba(63,185,80,0.15)',
                  color: C.success,
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: submitting ? 'default' : 'pointer',
                  transition: 'all 0.15s',
                  opacity: submitting ? 0.6 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
                onMouseEnter={(e) => {
                  if (!submitting) e.currentTarget.style.backgroundColor = 'rgba(63,185,80,0.25)';
                }}
                onMouseLeave={(e) => {
                  if (!submitting) e.currentTarget.style.backgroundColor = 'rgba(63,185,80,0.15)';
                }}
                aria-label="Launch Dashboard"
                aria-busy={submitting}
              >
                {submitting && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    style={{ animation: 'spin 1s linear infinite' }}
                  >
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                )}
                {submitting ? 'Saving...' : 'Launch Dashboard'}
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
