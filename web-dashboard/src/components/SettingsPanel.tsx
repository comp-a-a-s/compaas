import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchConfig, updateConfig } from '../api/client';
import type { AppConfig } from '../types';

// ---- Types ----

interface SettingsPanelProps {
  onConfigUpdated?: () => void;
}

// ---- Constants ----

const AGENT_ROSTER = [
  { id: 'marcus', role: 'CEO' },
  { id: 'elena', role: 'CTO' },
  { id: 'victor', role: 'Chief Researcher' },
  { id: 'rachel', role: 'CISO' },
  { id: 'jonathan', role: 'CFO' },
  { id: 'sarah', role: 'VP Product' },
  { id: 'david', role: 'VP Engineering' },
  { id: 'james', role: 'Lead Backend' },
  { id: 'priya', role: 'Lead Frontend' },
  { id: 'lena', role: 'Lead Designer' },
  { id: 'carlos', role: 'QA Lead' },
  { id: 'nina', role: 'DevOps' },
  { id: 'alex', role: 'Security Engineer' },
  { id: 'maya', role: 'Data Engineer' },
  { id: 'tom', role: 'Tech Writer' },
];

const POLL_INTERVAL_OPTIONS = [
  { label: '3 seconds', value: 3000 },
  { label: '5 seconds', value: 5000 },
  { label: '10 seconds', value: 10000 },
  { label: '30 seconds', value: 30000 },
];

// ---- Colours ----

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

// ---- Small shared primitives ----

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: '12px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.07em',
        color: C.textMuted,
        marginBottom: '12px',
      }}
    >
      {children}
    </h2>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        backgroundColor: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: '8px',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SavedBadge({ visible }: { visible: boolean }) {
  return (
    <span
      aria-live="polite"
      style={{
        fontSize: '11px',
        color: C.success,
        fontWeight: 500,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.3s',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M1.5 5l2.5 2.5 4.5-4.5" stroke={C.success} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Saved
    </span>
  );
}

// ---- Reusable inline field row ----

interface InlineFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (v: string) => Promise<void>;
  description?: string;
}

function InlineField({ label, value: initialValue, placeholder, onSave, description }: InlineFieldProps) {
  const [value, setValue] = useState(initialValue);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync if parent value changes (config reload)
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  const triggerSave = useCallback(
    (v: string) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(async () => {
        setSaving(true);
        await onSave(v);
        setSaving(false);
        setSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
      }, 600);
    },
    [onSave]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    triggerSave(v);
  };

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const id = `settings-field-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' }}>
        <label
          htmlFor={id}
          style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary }}
        >
          {label}
        </label>
        {saving ? (
          <span style={{ fontSize: '11px', color: C.textMuted }}>Saving...</span>
        ) : (
          <SavedBadge visible={saved} />
        )}
      </div>
      {description && (
        <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '8px' }}>{description}</p>
      )}
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        style={{
          width: '100%',
          maxWidth: '360px',
          padding: '7px 10px',
          backgroundColor: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          borderRadius: '5px',
          color: C.textPrimary,
          fontSize: '13px',
          outline: 'none',
          boxSizing: 'border-box',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
      />
    </div>
  );
}

// ---- Agent name grid ----

interface AgentNameGridProps {
  agentNames: Record<string, string>;
  onSave: (id: string, name: string) => Promise<void>;
}

function AgentNameGrid({ agentNames, onSave }: AgentNameGridProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: '1px',
        backgroundColor: C.border,
      }}
    >
      {AGENT_ROSTER.map((agent) => {
        const currentName = agentNames[agent.id] ?? '';
        return (
          <AgentNameCell
            key={agent.id}
            agentId={agent.id}
            role={agent.role}
            currentName={currentName}
            onSave={(name) => onSave(agent.id, name)}
          />
        );
      })}
    </div>
  );
}

interface AgentNameCellProps {
  agentId: string;
  role: string;
  currentName: string;
  onSave: (name: string) => Promise<void>;
}

function AgentNameCell({ agentId, role, currentName, onSave }: AgentNameCellProps) {
  const [value, setValue] = useState(currentName);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setValue(currentName);
  }, [currentName]);

  const triggerSave = useCallback(
    (v: string) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(async () => {
        setSaving(true);
        await onSave(v);
        setSaving(false);
        setSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
      }, 700);
    },
    [onSave]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    triggerSave(v);
  };

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const inputId = `agent-name-${agentId}`;

  return (
    <div
      style={{
        backgroundColor: C.surface,
        padding: '12px 14px',
      }}
    >
      <div style={{ marginBottom: '7px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <span
            style={{
              fontSize: '10px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: C.textMuted,
              display: 'block',
            }}
          >
            {agentId}
          </span>
          <span style={{ fontSize: '11px', color: C.accent }}>{role}</span>
        </div>
        {saving ? (
          <span style={{ fontSize: '10px', color: C.textMuted }}>...</span>
        ) : (
          <SavedBadge visible={saved} />
        )}
      </div>
      <label htmlFor={inputId} style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        Name for {role}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={handleChange}
        style={{
          width: '100%',
          padding: '5px 8px',
          backgroundColor: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          borderRadius: '4px',
          color: C.textPrimary,
          fontSize: '12px',
          outline: 'none',
          boxSizing: 'border-box',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
      />
    </div>
  );
}

// ---- Poll interval control ----

interface PollIntervalControlProps {
  value: number;
  onSave: (v: number) => Promise<void>;
}

function PollIntervalControl({ value: initialValue, onSave }: PollIntervalControlProps) {
  const [value, setValue] = useState(initialValue);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = Number(e.target.value);
    setValue(v);
    setSaving(true);
    await onSave(v);
    setSaving(false);
    setSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
  };

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' }}>
        <label
          htmlFor="settings-poll-interval"
          style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary }}
        >
          Poll interval
        </label>
        {saving ? (
          <span style={{ fontSize: '11px', color: C.textMuted }}>Saving...</span>
        ) : (
          <SavedBadge visible={saved} />
        )}
      </div>
      <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '8px' }}>
        How often the dashboard fetches updated data from the backend.
      </p>
      <select
        id="settings-poll-interval"
        value={value}
        onChange={handleChange}
        style={{
          padding: '7px 10px',
          backgroundColor: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          borderRadius: '5px',
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
  );
}

// ---- Server settings section ----

interface ServerSettingsProps {
  server: AppConfig['server'] | null;
  configFilePath?: string;
}

function ServerSettings({ server, configFilePath }: ServerSettingsProps) {
  const filePath = configFilePath ?? 'company_data/config.yaml';

  return (
    <div>
      <Card>
        {server ? (
          <div>
            {[
              { label: 'Host', value: server.host },
              { label: 'Port', value: String(server.port) },
              { label: 'Auto-open browser', value: server.auto_open_browser ? 'Enabled' : 'Disabled' },
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
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: C.textPrimary,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  }}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: '16px', fontSize: '13px', color: C.textMuted }}>
            Server information unavailable.
          </div>
        )}
      </Card>

      <div
        style={{
          marginTop: '12px',
          padding: '14px 16px',
          backgroundColor: 'rgba(210,153,34,0.08)',
          border: `1px solid rgba(210,153,34,0.25)`,
          borderRadius: '8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            style={{ flexShrink: 0, marginTop: '1px' }}
          >
            <path
              d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8z"
              fill={C.warning}
              fillOpacity="0.8"
            />
            <path d="M8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zM8 10.5a1 1 0 110 2 1 1 0 010-2z" fill={C.warning} />
          </svg>
          <div>
            <p style={{ fontSize: '13px', fontWeight: 500, color: C.warning, marginBottom: '6px' }}>
              Server settings require a restart
            </p>
            <p style={{ fontSize: '12px', color: C.textSecondary, lineHeight: '1.5', marginBottom: '10px' }}>
              To change host, port, or auto-open browser settings, edit the config file directly then restart
              the server process.
            </p>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', color: C.textMuted, display: 'block', marginBottom: '4px' }}>
                Config file path
              </span>
              <code
                style={{
                  fontSize: '12px',
                  color: C.accent,
                  backgroundColor: C.surfaceRaised,
                  border: `1px solid ${C.border}`,
                  borderRadius: '4px',
                  padding: '3px 8px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  display: 'inline-block',
                }}
              >
                {filePath}
              </code>
            </div>
            <div
              style={{
                backgroundColor: C.surfaceRaised,
                border: `1px solid ${C.border}`,
                borderRadius: '4px',
                padding: '10px 12px',
              }}
            >
              <p style={{ fontSize: '11px', color: C.textMuted, fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                How to apply changes
              </p>
              <ol style={{ paddingLeft: '14px', margin: 0 }}>
                {[
                  `Open ${filePath} in a text editor`,
                  'Edit the desired server settings under the server: key',
                  'Save the file',
                  'Stop crackpie-web (Ctrl+C)',
                  'Run crackpie-web again',
                ].map((step, i) => (
                  <li
                    key={i}
                    style={{
                      fontSize: '12px',
                      color: C.textSecondary,
                      lineHeight: '1.6',
                      paddingLeft: '4px',
                    }}
                  >
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Loading skeleton ----

function SettingsSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      {[1, 2, 3, 4].map((i) => (
        <div key={i}>
          <div
            style={{
              width: '80px',
              height: '10px',
              backgroundColor: C.surfaceRaised,
              borderRadius: '4px',
              marginBottom: '12px',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          />
          <div
            style={{
              height: '60px',
              backgroundColor: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: '8px',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          />
        </div>
      ))}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

// ---- Main component ----

export default function SettingsPanel({ onConfigUpdated }: SettingsPanelProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoadError(false);
    const data = await fetchConfig();
    if (data) {
      setConfig(data);
    } else {
      setLoadError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const patchConfig = useCallback(
    async (updates: Record<string, unknown>): Promise<void> => {
      const ok = await updateConfig(updates);
      if (ok) {
        onConfigUpdated?.();
        // Refresh local config to reflect persisted state
        const fresh = await fetchConfig();
        if (fresh) setConfig(fresh);
      }
    },
    [onConfigUpdated]
  );

  const handleUserNameSave = useCallback(
    async (name: string) => {
      await patchConfig({ user: { name } });
    },
    [patchConfig]
  );

  const handleAgentNameSave = useCallback(
    async (id: string, name: string) => {
      await patchConfig({ agents: { [id]: name } });
    },
    [patchConfig]
  );

  const handlePollIntervalSave = useCallback(
    async (ms: number) => {
      await patchConfig({ ui: { poll_interval_ms: ms } });
    },
    [patchConfig]
  );

  return (
    <div
      style={{
        maxWidth: '860px',
        margin: '0 auto',
        paddingBottom: '48px',
      }}
    >
      {/* Page header */}
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '4px' }}>
          Settings
        </h1>
        <p style={{ fontSize: '13px', color: C.textSecondary }}>
          Manage your profile, team names, and dashboard preferences.
        </p>
      </div>

      {loading && <SettingsSkeleton />}

      {!loading && loadError && (
        <div
          role="alert"
          style={{
            padding: '14px 16px',
            backgroundColor: 'rgba(248,81,73,0.1)',
            border: `1px solid rgba(248,81,73,0.3)`,
            borderRadius: '8px',
            fontSize: '13px',
            color: C.error,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="6" stroke={C.error} strokeWidth="1.5" />
            <path d="M7 4v3m0 2.5v.5" stroke={C.error} strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Failed to load configuration. Check that the crackpie-web server is running.
          <button
            onClick={loadConfig}
            style={{
              marginLeft: 'auto',
              padding: '4px 12px',
              borderRadius: '4px',
              border: `1px solid ${C.error}`,
              backgroundColor: 'transparent',
              color: C.error,
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && config && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

          {/* ---- Profile ---- */}
          <section aria-labelledby="section-profile">
            <SectionTitle>
              <span id="section-profile">Profile</span>
            </SectionTitle>
            <Card>
              <InlineField
                label="Your name (Board Head)"
                value={config.user?.name ?? ''}
                placeholder="e.g. Idan"
                description="This is how agents will address you in conversations and reports."
                onSave={handleUserNameSave}
              />
            </Card>
          </section>

          {/* ---- Team Names ---- */}
          <section aria-labelledby="section-team">
            <SectionTitle>
              <span id="section-team">Team Names</span>
            </SectionTitle>
            <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '10px' }}>
              Each name saves automatically when you stop typing.
            </p>
            <Card>
              <AgentNameGrid
                agentNames={config.agents ?? {}}
                onSave={handleAgentNameSave}
              />
            </Card>
          </section>

          {/* ---- UI Preferences ---- */}
          <section aria-labelledby="section-ui">
            <SectionTitle>
              <span id="section-ui">UI Preferences</span>
            </SectionTitle>
            <Card>
              <PollIntervalControl
                value={config.ui?.poll_interval_ms ?? 5000}
                onSave={handlePollIntervalSave}
              />
            </Card>
          </section>

          {/* ---- Server Settings ---- */}
          <section aria-labelledby="section-server">
            <SectionTitle>
              <span id="section-server">Server Settings</span>
            </SectionTitle>
            <ServerSettings server={config.server ?? null} />
          </section>

        </div>
      )}
    </div>
  );
}
