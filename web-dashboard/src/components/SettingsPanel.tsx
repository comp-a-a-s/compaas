import { useState, useEffect } from 'react';
import { fetchConfig, updateConfig, testLlmConnection } from '../api/client';
import type { AppConfig, LlmConfig } from '../types';
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
  { id: 'sahara', label: 'Sahara', description: 'Warm desert sand', preview: ['#1a1715', '#2d2924', '#d97757'] },
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

  const MAX_AGENT_NAME_LENGTH = 50;

  const handleSave = async () => {
    if (!draft.trim() || draft === currentName) {
      setEditing(false);
      return;
    }
    if (draft.trim().length > MAX_AGENT_NAME_LENGTH) return;
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, MAX_AGENT_NAME_LENGTH))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') { setEditing(false); setDraft(currentName); }
            }}
            autoFocus
            maxLength={MAX_AGENT_NAME_LENGTH}
            style={{ ...inputStyle() }}
            onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
          />
          {draft.length >= MAX_AGENT_NAME_LENGTH - 5 && (
            <span style={{ fontSize: '10px', color: draft.length >= MAX_AGENT_NAME_LENGTH ? C.error : C.textMuted }}>
              {draft.length}/{MAX_AGENT_NAME_LENGTH}
            </span>
          )}
        </div>
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

const LOCAL_PRESETS_SETTINGS = [
  { id: 'ollama',    label: 'Ollama',    baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1',  apiKey: 'lm-studio' },
  { id: 'llamacpp',  label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1',  apiKey: 'none' },
  { id: 'custom',   label: 'Custom',    baseUrl: '',                          apiKey: '' },
] as const;

const OPENAI_MODEL_PRESETS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'custom'];

function AiProviderSection({
  llm,
  onSaved,
}: {
  llm: LlmConfig | undefined;
  onSaved: () => void;
}) {
  const [provider, setProvider]         = useState<LlmConfig['provider']>(llm?.provider ?? 'anthropic');
  const [baseUrl, setBaseUrl]           = useState(llm?.base_url ?? 'http://localhost:11434/v1');
  const [model, setModel]               = useState(llm?.model ?? 'llama3.2');
  const [apiKey, setApiKey]             = useState(llm?.api_key ?? '');
  const [systemPrompt, setSystemPrompt] = useState(llm?.system_prompt ?? '');
  const [proxyEnabled, setProxyEnabled] = useState(llm?.proxy_enabled ?? false);
  const [proxyUrl, setProxyUrl]         = useState(llm?.proxy_url ?? 'http://localhost:4000');
  const [openaiPreset, setOpenaiPreset] = useState(() => {
    if (!llm || llm.provider !== 'openai') return 'gpt-4o';
    return OPENAI_MODEL_PRESETS.includes(llm.model) ? llm.model : 'custom';
  });

  const [testStatus, setTestStatus]   = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);

  const handlePreset = (presetId: string) => {
    const p = LOCAL_PRESETS_SETTINGS.find((x) => x.id === presetId);
    if (p) { setBaseUrl(p.baseUrl); setApiKey(p.apiKey); }
  };

  const handleOpenaiPreset = (m: string) => {
    setOpenaiPreset(m);
    if (m !== 'custom') setModel(m);
  };

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    const result = await testLlmConnection({ base_url: baseUrl, model, api_key: apiKey });
    setTestStatus(result.status);
    setTestMessage(result.message);
  };

  const handleSave = async () => {
    setSaving(true);
    const resolvedModel = provider === 'openai' && openaiPreset !== 'custom' ? openaiPreset : model;
    const patch: Partial<AppConfig> = {
      llm: {
        provider,
        base_url: provider === 'openai' ? 'https://api.openai.com/v1' : baseUrl,
        model: resolvedModel,
        api_key: apiKey,
        system_prompt: systemPrompt,
        proxy_enabled: provider !== 'anthropic' && proxyEnabled,
        proxy_url: proxyUrl,
      },
    };
    await updateConfig(patch as Record<string, unknown>);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onSaved();
  };

  const rowStyle: React.CSSProperties = {
    padding: '12px 14px',
    backgroundColor: C.surfaceRaised,
    border: `1px solid ${C.border}`,
    borderRadius: '8px',
    marginBottom: '8px',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '11px', fontWeight: 600,
    color: C.textSecondary, marginBottom: '5px',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  return (
    <div>
      {/* Provider radio cards */}
      {(['anthropic', 'openai', 'openai_compat'] as LlmConfig['provider'][]).map((p) => {
        const meta: Record<string, { icon: string; title: string; desc: string }> = {
          anthropic:    { icon: '⚡', title: 'Anthropic Cloud', desc: 'Claude via Claude Code CLI. Requires ANTHROPIC_API_KEY.' },
          openai:       { icon: '🤖', title: 'OpenAI',          desc: 'GPT-4o, GPT-4-turbo, etc. Requires an OpenAI API key.' },
          openai_compat:{ icon: '🖥️', title: 'Local Model',     desc: 'Ollama, LM Studio, llama.cpp, or any OpenAI-compatible server.' },
        };
        const m = meta[p];
        const selected = provider === p;
        return (
          <button
            key={p}
            role="radio"
            aria-checked={selected}
            onClick={() => setProvider(p)}
            style={{
              width: '100%', textAlign: 'left', padding: '12px 14px',
              borderRadius: '8px', cursor: 'pointer',
              border: `2px solid ${selected ? C.accent : C.border}`,
              backgroundColor: selected ? C.accentDim : C.surfaceRaised,
              marginBottom: '8px', outline: 'none', transition: 'all 0.15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>{m.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>{m.title}</div>
                <div style={{ fontSize: '11px', color: C.textSecondary }}>{m.desc}</div>
              </div>
              <div style={{
                width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0,
                border: `2px solid ${selected ? C.accent : C.border}`,
                backgroundColor: selected ? C.accent : 'transparent',
              }} />
            </div>
          </button>
        );
      })}

      {/* OpenAI fields */}
      {provider === 'openai' && (
        <div style={{ ...rowStyle, marginTop: '4px' }}>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Model</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: openaiPreset === 'custom' ? '6px' : 0 }}>
              {OPENAI_MODEL_PRESETS.map((m) => (
                <button key={m} onClick={() => handleOpenaiPreset(m)} style={{
                  padding: '4px 10px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer',
                  border: `1px solid ${openaiPreset === m ? C.accent : C.border}`,
                  backgroundColor: openaiPreset === m ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: openaiPreset === m ? C.accent : C.textSecondary, outline: 'none',
                }}>
                  {m}
                </button>
              ))}
            </div>
            {openaiPreset === 'custom' && (
              <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-2024-08-06" style={inputStyle({ maxWidth: '320px' })}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            )}
          </div>
          <div>
            <label style={labelStyle}>API Key</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..." style={inputStyle({ maxWidth: '420px' })}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
        </div>
      )}

      {/* Local model fields */}
      {provider === 'openai_compat' && (
        <div style={{ ...rowStyle, marginTop: '4px' }}>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Server Preset</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {LOCAL_PRESETS_SETTINGS.map((p) => (
                <button key={p.id} onClick={() => handlePreset(p.id)} style={{
                  padding: '4px 10px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer',
                  border: `1px solid ${baseUrl === p.baseUrl ? C.accent : C.border}`,
                  backgroundColor: baseUrl === p.baseUrl ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: baseUrl === p.baseUrl ? C.accent : C.textSecondary, outline: 'none',
                }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Base URL</label>
            <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1" style={inputStyle({ maxWidth: '420px' })}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Model Name</label>
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
              placeholder="llama3.2" style={inputStyle({ maxWidth: '320px' })}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
        </div>
      )}

      {/* CEO system prompt (all non-Anthropic providers) */}
      {provider !== 'anthropic' && (
        <div style={{ marginBottom: '8px' }}>
          <label style={labelStyle}>CEO System Prompt (optional)</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a seasoned CEO…"
            rows={3}
            style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5' }}
            onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
          />
        </div>
      )}

      {/* Test connection */}
      {provider !== 'anthropic' && (
        <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={handleTest}
            disabled={testStatus === 'testing'}
            style={{
              padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 500,
              cursor: testStatus === 'testing' ? 'default' : 'pointer', outline: 'none',
              border: `1px solid ${testStatus === 'ok' ? C.success : testStatus === 'error' ? C.error : C.accent}`,
              backgroundColor: testStatus === 'ok' ? 'rgba(63,185,80,0.1)' : testStatus === 'error' ? 'rgba(248,81,73,0.1)' : 'transparent',
              color: testStatus === 'ok' ? C.success : testStatus === 'error' ? C.error : C.accent,
            }}
          >
            {testStatus === 'testing' ? 'Testing…' : testStatus === 'ok' ? '✓ Connected' : testStatus === 'error' ? '✗ Failed' : 'Test Connection'}
          </button>
          {testStatus === 'error' && testMessage && (
            <span style={{ fontSize: '11px', color: C.error }}>{testMessage.slice(0, 120)}</span>
          )}
        </div>
      )}

      {/* Phase 2 — proxy toggle */}
      {provider !== 'anthropic' && (
        <div style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: proxyEnabled ? '10px' : 0 }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary, marginBottom: '2px' }}>Route ALL agents through proxy</div>
              <div style={{ fontSize: '11px', color: C.textSecondary }}>
                Uses a LiteLLM proxy to translate all agent subprocess calls. Requires <code style={{ fontSize: '10px' }}>pip install thunderflow[proxy]</code>.
              </div>
            </div>
            <button
              role="switch" aria-checked={proxyEnabled}
              onClick={() => setProxyEnabled(!proxyEnabled)}
              style={{
                position: 'relative', width: '44px', height: '24px', borderRadius: '12px', flexShrink: 0,
                border: `1px solid ${proxyEnabled ? C.accent : C.border}`,
                backgroundColor: proxyEnabled ? C.accentDim : C.surface, cursor: 'pointer', outline: 'none', padding: 0,
              }}
            >
              <span style={{
                position: 'absolute', top: '3px', left: proxyEnabled ? '22px' : '3px',
                width: '16px', height: '16px', borderRadius: '50%',
                backgroundColor: proxyEnabled ? C.accent : C.textMuted,
                transition: 'left 0.2s, background-color 0.2s',
              }} />
            </button>
          </div>
          {proxyEnabled && (
            <div>
              <label style={labelStyle}>Proxy URL</label>
              <input type="text" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://localhost:4000" style={inputStyle({ maxWidth: '320px' })}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            </div>
          )}
        </div>
      )}

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: '8px 18px', borderRadius: '6px', fontSize: '13px', fontWeight: 500,
          border: `1px solid ${saved ? C.success : C.accent}`,
          backgroundColor: saved ? 'rgba(63,185,80,0.1)' : C.accentDim,
          color: saved ? C.success : C.textPrimary,
          cursor: saving ? 'default' : 'pointer', outline: 'none',
        }}
      >
        {saving ? 'Saving…' : saved ? 'Saved' : 'Save Provider Settings'}
      </button>
    </div>
  );
}

export default function SettingsPanel({ onConfigUpdated }: SettingsPanelProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Local form state (mirrors config)
  const [userName, setUserName] = useState('');
  const [pollInterval, setPollInterval] = useState(5000);
  const [autoOpen, setAutoOpen] = useState(true);

  // Display / integrations (localStorage-based)
  const [compactMode, setCompactMode] = useState(() => localStorage.getItem('tf_compact_mode') === '1');
  const [agentModels, setAgentModels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('tf_agent_models') ?? '{}'); } catch { return {}; }
  });
  const [agentPersonas, setAgentPersonas] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('tf_agent_personas') ?? '{}'); } catch { return {}; }
  });
  const [githubToken, setGithubToken] = useState(() => localStorage.getItem('tf_github_token') ?? '');
  const [slackToken, setSlackToken] = useState(() => localStorage.getItem('tf_slack_token') ?? '');
  const [webhookUrl, setWebhookUrl] = useState(() => localStorage.getItem('tf_webhook_url') ?? '');

  useEffect(() => {
    // Apply compact mode on mount
    document.body.classList.toggle('compact-mode', compactMode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* AI Provider */}
      <Section title="AI Model Provider">
        <AiProviderSection llm={config?.llm} onSaved={() => { fetchConfig().then((c) => { if (c) setConfig(c); }); onConfigUpdated?.(); }} />
      </Section>

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

      {/* Display */}
      <Section title="Display">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Toggle
            value={compactMode}
            onChange={(v) => {
              setCompactMode(v);
              localStorage.setItem('tf_compact_mode', v ? '1' : '0');
              document.body.classList.toggle('compact-mode', v);
            }}
            label="Compact mode"
            description="Reduce spacing for a denser, information-rich layout"
          />
        </div>
      </Section>

      {/* Per-agent models */}
      <Section title="Agent Models">
        <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '16px' }}>
          Override the model used for individual agents. Leave blank to use the global provider setting.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {AGENT_ROSTER.slice(0, 6).map((agent) => (
            <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
              <div style={{ flex: '0 0 130px', fontSize: '12px', fontWeight: 500, color: C.textSecondary }}>{agent.role}</div>
              <input
                type="text"
                value={agentModels[agent.id] ?? ''}
                onChange={(e) => {
                  const next = { ...agentModels, [agent.id]: e.target.value };
                  setAgentModels(next);
                  localStorage.setItem('tf_agent_models', JSON.stringify(next));
                }}
                placeholder="(global default)"
                style={{ ...inputStyle(), flex: 1, fontSize: '12px', padding: '5px 10px' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            </div>
          ))}
          <p style={{ fontSize: '11px', color: C.textMuted }}>
            Examples: <code style={{ fontSize: '10px' }}>claude-opus-4-6</code>, <code style={{ fontSize: '10px' }}>gpt-4o</code>, <code style={{ fontSize: '10px' }}>llama3.2</code>
          </p>
        </div>
      </Section>

      {/* Agent personas */}
      <Section title="Agent Personas">
        <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '16px' }}>
          Set a custom system prompt for each agent to shape their personality and focus.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {AGENT_ROSTER.slice(0, 4).map((agent) => (
            <div key={agent.id}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{agent.role}</label>
              <textarea
                value={agentPersonas[agent.id] ?? ''}
                onChange={(e) => {
                  const next = { ...agentPersonas, [agent.id]: e.target.value };
                  setAgentPersonas(next);
                  localStorage.setItem('tf_agent_personas', JSON.stringify(next));
                }}
                placeholder={`Custom system prompt for ${agent.role}…`}
                rows={2}
                style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit', fontSize: '12px', lineHeight: '1.5' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            </div>
          ))}
        </div>
      </Section>

      {/* Integrations */}
      <Section title="Integrations">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* GitHub */}
          <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>GitHub</div>
                <div style={{ fontSize: '11px', color: C.textSecondary }}>CEO creates PRs, issues, and reviews diffs</div>
              </div>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(255,180,0,0.12)', color: C.warning, border: `1px solid rgba(255,180,0,0.3)` }}>Coming soon</span>
            </div>
            <input type="password" value={githubToken} onChange={(e) => { setGithubToken(e.target.value); localStorage.setItem('tf_github_token', e.target.value); }}
              placeholder="ghp_xxxx (Personal access token)"
              style={{ ...inputStyle({ maxWidth: '380px', fontSize: '12px' }) }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>

          {/* Slack */}
          <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Slack Bot</div>
                <div style={{ fontSize: '11px', color: C.textSecondary }}>Two-way Slack integration for CEO conversations</div>
              </div>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(255,180,0,0.12)', color: C.warning, border: `1px solid rgba(255,180,0,0.3)` }}>Coming soon</span>
            </div>
            <input type="password" value={slackToken} onChange={(e) => { setSlackToken(e.target.value); localStorage.setItem('tf_slack_token', e.target.value); }}
              placeholder="xoxb-xxxx (Bot token)"
              style={{ ...inputStyle({ maxWidth: '380px', fontSize: '12px' }) }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>

          {/* Webhooks */}
          <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Outbound Webhooks</div>
                <div style={{ fontSize: '11px', color: C.textSecondary }}>POST to a URL on project/task events</div>
              </div>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(255,180,0,0.12)', color: C.warning, border: `1px solid rgba(255,180,0,0.3)` }}>Coming soon</span>
            </div>
            <input type="url" value={webhookUrl} onChange={(e) => { setWebhookUrl(e.target.value); localStorage.setItem('tf_webhook_url', e.target.value); }}
              placeholder="https://your-server.com/webhook"
              style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
        </div>
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
