import { useState, useEffect } from 'react';
import { fetchConfig, updateConfig } from '../api/client';
import type { AppConfig } from '../types';
import { useThemeSwitch } from '../hooks/useTheme';
import type { ThemeName } from '../hooks/useTheme';

// ---- Types ----

interface SettingsPanelProps {
  onConfigUpdated?: () => void;
}

// ---- CSS variable colour references (no hard-coded hex) ----

const C = {
  bg: 'var(--tf-bg)',
  surface: 'var(--tf-surface)',
  surfaceRaised: 'var(--tf-surface-raised)',
  border: 'var(--tf-border)',
  textPrimary: 'var(--tf-text)',
  textSecondary: 'var(--tf-text-secondary)',
  textMuted: 'var(--tf-text-muted)',
  accent: 'var(--tf-accent-blue)',
  accentDim: 'var(--tf-accent-dim)',
  success: 'var(--tf-success)',
  warning: 'var(--tf-warning)',
  error: 'var(--tf-error)',
} as const;

// ---- Agent roster with correct IDs ----

const AGENT_ROSTER = [
  { id: 'ceo', role: 'CEO' },
  { id: 'cto', role: 'CTO' },
  { id: 'chief-researcher', role: 'Chief Researcher' },
  { id: 'ciso', role: 'CISO' },
  { id: 'cfo', role: 'CFO' },
  { id: 'vp-product', role: 'VP Product' },
  { id: 'vp-engineering', role: 'VP Engineering' },
  { id: 'lead-backend', role: 'Lead Backend' },
  { id: 'lead-frontend', role: 'Lead Frontend' },
  { id: 'lead-designer', role: 'Lead Designer' },
  { id: 'qa-lead', role: 'QA Lead' },
  { id: 'devops', role: 'DevOps' },
  { id: 'security-engineer', role: 'Security Engineer' },
  { id: 'data-engineer', role: 'Data Engineer' },
  { id: 'tech-writer', role: 'Tech Writer' },
];

const POLL_INTERVAL_OPTIONS = [
  { label: '3 seconds', value: 3000 },
  { label: '5 seconds', value: 5000 },
  { label: '10 seconds', value: 10000 },
  { label: '30 seconds', value: 30000 },
];

const THEMES = [
  { id: 'midnight', label: 'Midnight', description: 'Deep dark', preview: ['#0d1117', '#161b22', '#e6edf3'] },
  { id: 'twilight', label: 'Twilight', description: 'Soft blue dark', preview: ['#0f1923', '#1a2332', '#d0d8e4'] },
  { id: 'dawn', label: 'Dawn', description: 'Light mode', preview: ['#ffffff', '#f6f8fa', '#24292f'] },
];

// ---- Shared input style helper ----

function inputStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: '100%',
    padding: '8px 12px',
    backgroundColor: C.surfaceRaised,
    border: `1px solid ${C.border}`,
    borderRadius: '6px',
    color: C.textPrimary,
    fontSize: '13px',
    outline: 'none',
    boxSizing: 'border-box',
    ...extra,
  };
}

// ---- Section card ----

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        backgroundColor: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: '12px',
        overflow: 'hidden',
        marginBottom: '16px',
      }}
    >
      <div
        style={{
          padding: '14px 20px',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>
          {title}
        </h3>
      </div>
      <div style={{ padding: '20px' }}>
        {children}
      </div>
    </div>
  );
}

// ---- Toggle switch ----

function Toggle({
  value,
  onChange,
  label,
  description,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
      <div>
        <div style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary, marginBottom: description ? '2px' : 0 }}>
          {label}
        </div>
        {description && (
          <div style={{ fontSize: '11px', color: C.textSecondary }}>{description}</div>
        )}
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        style={{
          position: 'relative',
          width: '44px',
          height: '24px',
          borderRadius: '12px',
          border: `1px solid ${value ? C.accent : C.border}`,
          cursor: 'pointer',
          backgroundColor: value ? C.accentDim : C.surfaceRaised,
          outline: 'none',
          transition: 'background-color 0.2s',
          flexShrink: 0,
          padding: 0,
        }}
        aria-label={label}
        onFocus={(e) => { e.currentTarget.style.boxShadow = `0 0 0 2px ${C.accentDim}`; }}
        onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
      >
        <span
          style={{
            position: 'absolute',
            top: '3px',
            left: value ? '22px' : '3px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: value ? C.accent : C.textMuted,
            transition: 'left 0.2s, background-color 0.2s',
          }}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

// ---- Theme selector (uses useThemeSwitch hook) ----

function ThemeSelector() {
  const { setTheme, currentTheme } = useThemeSwitch();

  return (
    <div>
      <p style={{ fontSize: '12px', fontWeight: 600, color: C.textSecondary, marginBottom: '10px' }}>
        Theme
      </p>
      <div style={{ display: 'flex', gap: '10px' }}>
        {THEMES.map((t) => {
          const selected = currentTheme === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id as ThemeName)}
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: '8px',
                border: `2px solid ${selected ? C.accent : C.border}`,
                backgroundColor: C.surfaceRaised,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 0.2s',
                outline: 'none',
              }}
            >
              <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                {t.preview.map((color, i) => (
                  <div
                    key={i}
                    style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '3px',
                      backgroundColor: color,
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  />
                ))}
              </div>
              <div style={{ fontSize: '11px', fontWeight: 600, color: selected ? C.accent : C.textPrimary }}>
                {t.label}
              </div>
              <div style={{ fontSize: '10px', color: C.textMuted }}>
                {t.description}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Agent name editor row ----

function AgentNameRow({
  agentId,
  role,
  currentName,
  onSaved,
}: {
  agentId: string;
  role: string;
  currentName: string;
  onSaved?: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (!draft.trim() || draft === currentName) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const config = await fetchConfig();
      const updatedAgents = { ...(config?.agents ?? {}), [agentId]: draft.trim() };
      await updateConfig({ agents: updatedAgents });
      setSaved(true);
      onSaved?.(agentId, draft.trim());
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silently fail
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        borderRadius: '8px',
        backgroundColor: C.surfaceRaised,
        border: `1px solid ${C.border}`,
      }}
    >
      {/* Avatar */}
      <div
        style={{
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          backgroundColor: C.accentDim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          fontWeight: 600,
          color: C.textPrimary,
          flexShrink: 0,
        }}
      >
        {currentName.charAt(0).toUpperCase()}
      </div>

      {/* Role label */}
      <div style={{ flex: '0 0 160px' }}>
        <div style={{ fontSize: '12px', fontWeight: 500, color: C.textSecondary }}>{role}</div>
        <div style={{ fontSize: '10px', color: C.textMuted }}>id: {agentId}</div>
      </div>

      {/* Name field */}
      {editing ? (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') { setEditing(false); setDraft(currentName); }
          }}
          autoFocus
          style={{ ...inputStyle(), flex: 1 }}
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      ) : (
        <div style={{ flex: 1, fontSize: '13px', fontWeight: 500, color: C.textPrimary }}>
          {currentName}
        </div>
      )}

      {/* Saved indicator */}
      {saved && (
        <span style={{ fontSize: '11px', color: C.success, flexShrink: 0 }}>Saved!</span>
      )}

      {/* Edit / Save / Cancel buttons */}
      {editing ? (
        <>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '5px 12px',
              borderRadius: '6px',
              border: `1px solid ${C.accent}`,
              backgroundColor: C.accentDim,
              color: C.textPrimary,
              fontSize: '12px',
              cursor: saving ? 'default' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={() => { setEditing(false); setDraft(currentName); }}
            style={{
              padding: '5px 10px',
              borderRadius: '6px',
              border: `1px solid ${C.border}`,
              backgroundColor: 'transparent',
              color: C.textSecondary,
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          onClick={() => { setEditing(true); setDraft(currentName); }}
          style={{
            padding: '5px 10px',
            borderRadius: '6px',
            border: `1px solid ${C.border}`,
            backgroundColor: 'transparent',
            color: C.textSecondary,
            fontSize: '12px',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textSecondary; }}
        >
          Rename
        </button>
      )}
    </div>
  );
}

// ---- Telegram section ----

function TelegramSection() {
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBotToken(localStorage.getItem('thunderflow_telegram_token') ?? '');
    setChatId(localStorage.getItem('thunderflow_telegram_chatid') ?? '');
    setConfigured(localStorage.getItem('thunderflow_telegram_configured') === 'true');
  }, []);

  const handleSave = () => {
    if (botToken && chatId) {
      localStorage.setItem('thunderflow_telegram_token', botToken);
      localStorage.setItem('thunderflow_telegram_chatid', chatId);
      localStorage.setItem('thunderflow_telegram_configured', 'true');
      setConfigured(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const handleClear = () => {
    localStorage.removeItem('thunderflow_telegram_token');
    localStorage.removeItem('thunderflow_telegram_chatid');
    localStorage.removeItem('thunderflow_telegram_configured');
    setBotToken('');
    setChatId('');
    setConfigured(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {configured && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            backgroundColor: 'rgba(63,185,80,0.08)',
            border: '1px solid rgba(63,185,80,0.25)',
            borderRadius: '6px',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 8l4 4 8-8" stroke={C.success} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ fontSize: '12px', color: C.success }}>Telegram is configured</span>
        </div>
      )}

      <div>
        <label
          htmlFor="telegram-token"
          style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: C.textSecondary, marginBottom: '6px' }}
        >
          Bot Token
        </label>
        <input
          id="telegram-token"
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="1234567890:ABCdef..."
          style={inputStyle()}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#2ca5e0'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      </div>

      <div>
        <label
          htmlFor="telegram-chatid"
          style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: C.textSecondary, marginBottom: '6px' }}
        >
          Chat ID
        </label>
        <input
          id="telegram-chatid"
          type="text"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="-1001234567890"
          style={inputStyle()}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#2ca5e0'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={handleSave}
          disabled={!botToken || !chatId}
          style={{
            padding: '7px 16px',
            borderRadius: '6px',
            border: `1px solid ${!botToken || !chatId ? C.border : '#2ca5e0'}`,
            backgroundColor: !botToken || !chatId ? 'transparent' : 'rgba(44,165,224,0.12)',
            color: !botToken || !chatId ? C.textMuted : '#2ca5e0',
            fontSize: '13px',
            cursor: !botToken || !chatId ? 'default' : 'pointer',
            opacity: !botToken || !chatId ? 0.5 : 1,
          }}
        >
          Save Credentials
        </button>
        {configured && (
          <button
            onClick={handleClear}
            style={{
              padding: '7px 14px',
              borderRadius: '6px',
              border: `1px solid ${C.border}`,
              backgroundColor: 'transparent',
              color: C.textSecondary,
              fontSize: '13px',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.error; e.currentTarget.style.borderColor = C.error; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.textSecondary; e.currentTarget.style.borderColor = C.border; }}
          >
            Clear
          </button>
        )}
        {saved && <span style={{ fontSize: '12px', color: C.success }}>Saved!</span>}
      </div>
    </div>
  );
}

// ---- Main Settings Panel ----

export default function SettingsPanel({ onConfigUpdated }: SettingsPanelProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Local form state (mirrors config)
  const [userName, setUserName] = useState('');
  const [pollInterval, setPollInterval] = useState(5000);
  const [autoOpen, setAutoOpen] = useState(true);

  useEffect(() => {
    fetchConfig().then((cfg) => {
      if (cfg) {
        setConfig(cfg);
        setUserName(cfg.user?.name ?? '');
        setPollInterval(cfg.ui?.poll_interval_ms ?? 5000);
        setAutoOpen(cfg.server?.auto_open_browser ?? true);
      }
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const patch: Partial<AppConfig> = {
      user: { name: userName.trim() },
      ui: { theme: config?.ui?.theme ?? 'midnight', ...(config?.ui ?? {}), poll_interval_ms: pollInterval },
      server: { host: config?.server?.host ?? '', port: config?.server?.port ?? 3000, ...(config?.server ?? {}), auto_open_browser: autoOpen },
    };

    try {
      await updateConfig(patch);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      onConfigUpdated?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const agentNameMap: Record<string, string> = config?.agents ?? {};

  const handleAgentSaved = (id: string, name: string) => {
    setConfig((prev) => prev ? {
      ...prev,
      agents: { ...(prev.agents ?? {}), [id]: name },
    } : prev);
    onConfigUpdated?.();
  };

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }} className="animate-fade-in">
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: C.textPrimary, marginBottom: '4px' }}>
          Settings
        </h2>
        <p style={{ fontSize: '13px', color: C.textSecondary }}>
          Manage your ThunderFlow dashboard configuration.
        </p>
      </div>

      {/* General settings */}
      <Section title="General">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label
              htmlFor="settings-username"
              style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: C.textSecondary, marginBottom: '6px' }}
            >
              Your Name (Board Head)
            </label>
            <input
              id="settings-username"
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="e.g. Idan"
              style={inputStyle({ maxWidth: '320px' })}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>

          <div>
            <label
              htmlFor="settings-poll"
              style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: C.textSecondary, marginBottom: '6px' }}
            >
              Poll Interval
            </label>
            <select
              id="settings-poll"
              value={pollInterval}
              onChange={(e) => setPollInterval(Number(e.target.value))}
              style={{ ...inputStyle(), maxWidth: '200px', cursor: 'pointer' }}
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

          <Toggle
            value={autoOpen}
            onChange={setAutoOpen}
            label="Auto-open browser"
            description="Automatically open the dashboard when thunderflow-web starts"
          />
        </div>
      </Section>

      {/* Appearance */}
      <Section title="Appearance">
        <ThemeSelector />
      </Section>

      {/* Agent names */}
      <Section title="Agent Names">
        <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '16px' }}>
          Customise the display name for each AI agent. Click "Rename" to edit.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {AGENT_ROSTER.map((agent) => (
            <AgentNameRow
              key={agent.id}
              agentId={agent.id}
              role={agent.role}
              currentName={agentNameMap[agent.id] ?? agent.role}
              onSaved={handleAgentSaved}
            />
          ))}
        </div>
      </Section>

      {/* Telegram */}
      <Section title="Telegram Integration">
        <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '16px' }}>
          Configure Telegram to continue CEO conversations from your phone.
          Create a bot via @BotFather, then paste the credentials below.
        </p>
        <TelegramSection />
      </Section>

      {/* Save button */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '20px 0',
        }}
      >
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '9px 24px',
            borderRadius: '8px',
            border: `1px solid ${C.accent}`,
            backgroundColor: C.accentDim,
            color: C.textPrimary,
            fontSize: '14px',
            fontWeight: 500,
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          {saving && (
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
          {saving ? 'Saving...' : 'Save Settings'}
        </button>

        {saveSuccess && (
          <span style={{ fontSize: '13px', color: C.success }}>
            Settings saved successfully!
          </span>
        )}

        {saveError && (
          <span role="alert" style={{ fontSize: '13px', color: C.error }}>
            {saveError}
          </span>
        )}
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
