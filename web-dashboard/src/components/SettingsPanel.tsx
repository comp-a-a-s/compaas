import { useState, useEffect } from 'react';
import {
  fetchConfig,
  updateConfig,
  testLlmConnection,
  saveIntegrations,
  fetchGithubRepos,
  createGithubRepo,
  githubSecretScan,
  githubSync,
  githubDrift,
  githubRollback,
  vercelLinkProject,
  vercelDeploy,
  vercelAssignDomain,
  vercelSetEnv,
} from '../api/client';
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
  { id: 'midnight', label: 'Midnight', description: 'High-contrast deep blue', preview: ['#070f19', '#17293d', '#edf5ff'] },
  { id: 'twilight', label: 'Twilight', description: 'Moody indigo dusk', preview: ['#181626', '#312f4a', '#f3f4ff'] },
  { id: 'dawn', label: 'Dawn', description: 'Soft daylight with strong readability', preview: ['#f6f3ea', '#efe8d8', '#273242'] },
  { id: 'sahara', label: 'Sahara', description: 'Warm sand, softer contrast', preview: ['#f7efe3', '#f2e6d2', '#3f3428'] },
];

type SettingsTab = 'general' | 'ai' | 'agents' | 'integrations' | 'appearance';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: 'general', label: 'General', description: 'Core dashboard and identity settings.' },
  { id: 'ai', label: 'AI', description: 'Model provider and runtime selection.' },
  { id: 'agents', label: 'Agents', description: 'Names, model overrides, and agent personas.' },
  { id: 'integrations', label: 'Integrations', description: 'Workspace mode, GitHub, Vercel, Telegram, Slack, and webhooks.' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and density preferences.' },
];

interface IntegrationSettings {
  workspace_mode: 'local' | 'github';
  github_token: string;
  github_repo: string;
  github_default_branch: string;
  github_auto_push: boolean;
  github_auto_pr: boolean;
  vercel_token: string;
  vercel_team_id: string;
  vercel_project_name: string;
  slack_token: string;
  webhook_url: string;
}

const REDACTED_SECRET = '__COMPAAS_REDACTED__';

function integrationsFromConfig(config: AppConfig | null): IntegrationSettings {
  return {
    workspace_mode: config?.integrations?.workspace_mode === 'github' ? 'github' : 'local',
    github_token: config?.integrations?.github_token ?? '',
    github_repo: config?.integrations?.github_repo ?? '',
    github_default_branch: config?.integrations?.github_default_branch ?? 'master',
    github_auto_push: Boolean(config?.integrations?.github_auto_push),
    github_auto_pr: Boolean(config?.integrations?.github_auto_pr),
    vercel_token: config?.integrations?.vercel_token ?? '',
    vercel_team_id: config?.integrations?.vercel_team_id ?? '',
    vercel_project_name: config?.integrations?.vercel_project_name ?? '',
    slack_token: config?.integrations?.slack_token ?? '',
    webhook_url: config?.integrations?.webhook_url ?? '',
  };
}

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
  const [error, setError] = useState<string | null>(null);

  const MAX_AGENT_NAME_LENGTH = 50;

  const handleSave = async () => {
    if (!draft.trim() || draft === currentName) {
      setEditing(false);
      return;
    }
    if (draft.trim().length > MAX_AGENT_NAME_LENGTH) return;
    setSaving(true);
    setError(null);
    try {
      const config = await fetchConfig();
      const updatedAgents = { ...(config?.agents ?? {}), [agentId]: draft.trim() };
      const ok = await updateConfig({ agents: updatedAgents });
      if (!ok) {
        setError('Failed to save');
        return;
      }
      setSaved(true);
      onSaved?.(agentId, draft.trim());
      setTimeout(() => setSaved(false), 2000);
      setEditing(false);
    } catch {
      setError('Failed to save');
    } finally {
      setSaving(false);
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
      {error && (
        <span style={{ fontSize: '11px', color: C.error, flexShrink: 0 }}>{error}</span>
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

const TELEGRAM_KEYS = {
  token: 'compaas_telegram_token',
  chatId: 'compaas_telegram_chatid',
  configured: 'compaas_telegram_configured',
} as const;

function readTelegramValue(key: string): string {
  return localStorage.getItem(key) ?? '';
}

function readTelegramConfigured(): boolean {
  return localStorage.getItem(TELEGRAM_KEYS.configured) === 'true';
}

function TelegramSection() {
  const [botToken, setBotToken] = useState(() => readTelegramValue(TELEGRAM_KEYS.token));
  const [chatId, setChatId] = useState(() => readTelegramValue(TELEGRAM_KEYS.chatId));
  const [configured, setConfigured] = useState(() => readTelegramConfigured());
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    if (botToken && chatId) {
      localStorage.setItem(TELEGRAM_KEYS.token, botToken);
      localStorage.setItem(TELEGRAM_KEYS.chatId, chatId);
      localStorage.setItem(TELEGRAM_KEYS.configured, 'true');
      setConfigured(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const handleClear = () => {
    localStorage.removeItem(TELEGRAM_KEYS.token);
    localStorage.removeItem(TELEGRAM_KEYS.chatId);
    localStorage.removeItem(TELEGRAM_KEYS.configured);
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
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
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
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
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
            border: `1px solid ${!botToken || !chatId ? C.border : C.accent}`,
            backgroundColor: !botToken || !chatId ? 'transparent' : C.accentDim,
            color: !botToken || !chatId ? C.textMuted : C.accent,
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

function detectLocalPreset(baseUrl: string): (typeof LOCAL_PRESETS_SETTINGS)[number]['id'] {
  const match = LOCAL_PRESETS_SETTINGS.find((preset) => preset.baseUrl === baseUrl);
  return match ? match.id : 'custom';
}

function AiProviderSection({
  llm,
  onSaved,
}: {
  llm: LlmConfig | undefined;
  onSaved: () => void;
}) {
  const [provider, setProvider]         = useState<LlmConfig['provider']>(llm?.provider ?? 'anthropic');
  const [anthropicMode, setAnthropicMode] = useState<'cli' | 'apikey'>(llm?.anthropic_mode ?? 'cli');
  const [openaiMode, setOpenaiMode]     = useState<'apikey' | 'codex'>(llm?.openai_mode ?? 'apikey');
  const [baseUrl, setBaseUrl]           = useState(llm?.base_url ?? 'http://localhost:11434/v1');
  const [model, setModel]               = useState(llm?.model ?? 'llama3.2');
  const [apiKey, setApiKey]             = useState(llm?.api_key ?? '');
  const [localPreset, setLocalPreset]   = useState<(typeof LOCAL_PRESETS_SETTINGS)[number]['id']>(() => detectLocalPreset(llm?.base_url ?? 'http://localhost:11434/v1'));
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
  const [saveError, setSaveError]     = useState<string | null>(null);

  const showApiProbe =
    provider === 'openai_compat' || (provider === 'openai' && openaiMode === 'apikey');

  const handlePreset = (presetId: string) => {
    const p = LOCAL_PRESETS_SETTINGS.find((x) => x.id === presetId);
    if (p) {
      setLocalPreset(p.id);
      setBaseUrl(p.baseUrl);
      setApiKey(p.apiKey);
    }
  };

  const handleOpenaiPreset = (m: string) => {
    setOpenaiPreset(m);
    if (m !== 'custom') setModel(m);
  };

  const handleTest = async () => {
    if (!showApiProbe) {
      setTestStatus('error');
      setTestMessage('Connection probe is only available for API-backed modes.');
      return;
    }
    setTestStatus('testing');
    setTestMessage('');
    const result = await testLlmConnection({ base_url: baseUrl, model, api_key: apiKey });
    setTestStatus(result.status);
    setTestMessage(result.message);
  };

  const clearTestStatus = () => {
    setTestStatus('idle');
    setTestMessage('');
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    const resolvedModel = provider === 'openai'
      ? (openaiMode === 'codex' ? 'codex' : (openaiPreset !== 'custom' ? openaiPreset : model))
      : model;
    const resolvedApiKey = provider === 'openai' && openaiMode === 'codex' ? '' : apiKey;
    const patch: Partial<AppConfig> = {
      llm: {
        provider,
        anthropic_mode: anthropicMode,
        openai_mode: openaiMode,
        base_url: provider === 'openai' ? 'https://api.openai.com/v1' : baseUrl,
        model: resolvedModel,
        api_key: resolvedApiKey,
        system_prompt: systemPrompt,
        proxy_enabled: provider !== 'anthropic' && proxyEnabled,
        proxy_url: proxyUrl,
      },
    };
    const ok = await updateConfig(patch as Record<string, unknown>);
    setSaving(false);
    if (!ok) {
      setSaveError('Failed to save provider settings.');
      return;
    }
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
          anthropic:    { icon: 'AN', title: 'Anthropic Cloud', desc: 'Claude via Claude Code CLI. Requires ANTHROPIC_API_KEY.' },
          openai:       { icon: 'OA', title: 'OpenAI',          desc: 'Use API key mode or local Codex CLI mode.' },
          openai_compat:{ icon: 'LM', title: 'Local Model',     desc: 'Ollama, LM Studio, llama.cpp, or any OpenAI-compatible server.' },
        };
        const m = meta[p];
        const selected = provider === p;
        return (
          <button
            key={p}
            role="radio"
            aria-checked={selected}
            onClick={() => {
              setProvider(p);
              if (p === 'openai') {
                setApiKey('');
              }
              clearTestStatus();
            }}
            style={{
              width: '100%', textAlign: 'left', padding: '12px 14px',
              borderRadius: '8px', cursor: 'pointer',
              border: `2px solid ${selected ? C.accent : C.border}`,
              backgroundColor: selected ? C.accentDim : C.surfaceRaised,
              marginBottom: '8px', outline: 'none', transition: 'all 0.15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.06em',
                color: selected ? C.accent : C.textSecondary,
                border: `1px solid ${selected ? C.accent : C.border}`,
                borderRadius: '999px',
                padding: '3px 6px',
                backgroundColor: selected ? 'rgba(88,166,255,0.1)' : C.surface,
              }}>{m.icon}</span>
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

      {/* Anthropic fields */}
      {provider === 'anthropic' && (
        <div style={{ ...rowStyle, marginTop: '4px' }}>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Runtime</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                onClick={() => setAnthropicMode('cli')}
                style={{
                  padding: '4px 10px',
                  borderRadius: '5px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  border: `1px solid ${anthropicMode === 'cli' ? C.accent : C.border}`,
                  backgroundColor: anthropicMode === 'cli' ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: anthropicMode === 'cli' ? C.accent : C.textSecondary,
                }}
              >
                Claude CLI
              </button>
              <button
                onClick={() => setAnthropicMode('apikey')}
                style={{
                  padding: '4px 10px',
                  borderRadius: '5px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  border: `1px solid ${anthropicMode === 'apikey' ? C.accent : C.border}`,
                  backgroundColor: anthropicMode === 'apikey' ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: anthropicMode === 'apikey' ? C.accent : C.textSecondary,
                }}
              >
                API Key
              </button>
            </div>
          </div>

          {anthropicMode === 'apikey' && (
            <div>
              <label style={labelStyle}>Anthropic API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                style={inputStyle({ maxWidth: '420px' })}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
              <p style={{ marginTop: '6px', fontSize: '11px', color: C.textMuted }}>
                Key is injected to Claude CLI for this runtime and stored in config.
              </p>
            </div>
          )}
        </div>
      )}

      {/* OpenAI fields */}
      {provider === 'openai' && (
        <div style={{ ...rowStyle, marginTop: '4px' }}>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Runtime</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                onClick={() => {
                  setOpenaiMode('apikey');
                  const localPlaceholders = new Set(['ollama', 'lm-studio', 'none', 'jan', 'vllm']);
                  if (localPlaceholders.has(apiKey.trim().toLowerCase())) {
                    setApiKey('');
                  }
                  clearTestStatus();
                }}
                style={{
                  padding: '4px 10px',
                  borderRadius: '5px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  border: `1px solid ${openaiMode === 'apikey' ? C.accent : C.border}`,
                  backgroundColor: openaiMode === 'apikey' ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: openaiMode === 'apikey' ? C.accent : C.textSecondary,
                }}
              >
                API
              </button>
              <button
                onClick={() => {
                  setOpenaiMode('codex');
                  setApiKey('');
                  clearTestStatus();
                }}
                style={{
                  padding: '4px 10px',
                  borderRadius: '5px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  border: `1px solid ${openaiMode === 'codex' ? C.accent : C.border}`,
                  backgroundColor: openaiMode === 'codex' ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: openaiMode === 'codex' ? C.accent : C.textSecondary,
                }}
              >
                Codex CLI
              </button>
            </div>
          </div>
          {openaiMode === 'apikey' ? (
            <>
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
                <label style={labelStyle}>OpenAI API Key</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  name="openai-api-key-settings"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  style={inputStyle({ maxWidth: '420px' })}
                  onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                />
              </div>
            </>
          ) : (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: '8px', backgroundColor: C.surface, padding: '10px 12px' }}>
              <p style={{ margin: 0, fontSize: '12px', color: C.textSecondary, lineHeight: 1.6 }}>
                Codex CLI mode uses your local Codex authentication. COMPaaS does not require an API key or model selection in this mode.
              </p>
            </div>
          )}
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
                  border: `1px solid ${localPreset === p.id ? C.accent : C.border}`,
                  backgroundColor: localPreset === p.id ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: localPreset === p.id ? C.accent : C.textSecondary, outline: 'none',
                }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => {
                const next = e.target.value;
                setBaseUrl(next);
                setLocalPreset(detectLocalPreset(next));
              }}
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

      {/* CEO system prompt (non-Anthropic providers) */}
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
      {showApiProbe && (
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
          {(testStatus === 'ok' || testStatus === 'error') && (
            <button
              onClick={clearTestStatus}
              style={{
                border: `1px solid ${C.border}`,
                backgroundColor: 'transparent',
                color: C.textMuted,
                borderRadius: '6px',
                fontSize: '11px',
                lineHeight: 1,
                padding: '4px 7px',
                cursor: 'pointer',
              }}
              aria-label="Dismiss test status"
              title="Dismiss status"
            >
              ×
            </button>
          )}
        </div>
      )}
      {provider === 'openai' && openaiMode === 'codex' && (
        <div style={{ marginBottom: '12px', fontSize: '11px', color: C.textMuted }}>
          Codex CLI mode does not use the API probe button. Validate by sending a CEO chat message.
        </div>
      )}

      {/* Phase 2 — proxy toggle */}
      {provider !== 'anthropic' && (
        <div style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: proxyEnabled ? '10px' : 0 }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary, marginBottom: '2px' }}>Route ALL agents through proxy</div>
              <div style={{ fontSize: '11px', color: C.textSecondary }}>
                Uses a LiteLLM proxy to translate all agent subprocess calls. Requires <code style={{ fontSize: '10px' }}>pip install compaas[proxy]</code>.
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
      {saveError && (
        <div role="alert" style={{ marginTop: '8px', fontSize: '12px', color: C.error }}>
          {saveError}
        </div>
      )}
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

  // Display / integrations
  const [compactMode, setCompactMode] = useState(() => localStorage.getItem('tf_compact_mode') === '1');
  const [agentModels, setAgentModels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('tf_agent_models') ?? '{}'); } catch { return {}; }
  });
  const [agentPersonas, setAgentPersonas] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('tf_agent_personas') ?? '{}'); } catch { return {}; }
  });
  const [workspaceMode, setWorkspaceMode] = useState<'local' | 'github'>('local');
  const [githubToken, setGithubToken] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubDefaultBranch, setGithubDefaultBranch] = useState('master');
  const [githubAutoPush, setGithubAutoPush] = useState(false);
  const [githubAutoPr, setGithubAutoPr] = useState(false);
  const [vercelToken, setVercelToken] = useState('');
  const [vercelTeamId, setVercelTeamId] = useState('');
  const [vercelProjectName, setVercelProjectName] = useState('');
  const [slackToken, setSlackToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [githubTokenMasked, setGithubTokenMasked] = useState(false);
  const [vercelTokenMasked, setVercelTokenMasked] = useState(false);
  const [slackTokenMasked, setSlackTokenMasked] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [githubRepoOptions, setGithubRepoOptions] = useState<Array<{ full_name: string; default_branch: string }>>([]);
  const [integrationOpsStatus, setIntegrationOpsStatus] = useState('');
  const [integrationOpsBusy, setIntegrationOpsBusy] = useState(false);
  const [repoPathForOps, setRepoPathForOps] = useState('');
  const [rollbackCommit, setRollbackCommit] = useState('');
  const [vercelDomain, setVercelDomain] = useState('');
  const [vercelEnvKey, setVercelEnvKey] = useState('');
  const [vercelEnvValue, setVercelEnvValue] = useState('');

  const runIntegrationOp = async (label: string, fn: () => Promise<unknown>) => {
    setIntegrationOpsBusy(true);
    setIntegrationOpsStatus(`${label}...`);
    try {
      const result = await fn();
      setIntegrationOpsStatus(`${label}: ${JSON.stringify(result).slice(0, 320)}`);
    } catch (err) {
      setIntegrationOpsStatus(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIntegrationOpsBusy(false);
    }
  };

  const handleLoadGithubRepos = async () => {
    const token = githubTokenMasked ? '' : githubToken.trim();
    if (!token) {
      setIntegrationOpsStatus('GitHub token is required for repo listing.');
      return;
    }
    await runIntegrationOp('GitHub repo listing', async () => {
      const repos = await fetchGithubRepos(token);
      setGithubRepoOptions(repos);
      return { repos: repos.length };
    });
  };

  const handleCreateGithubRepo = async () => {
    const token = githubTokenMasked ? '' : githubToken.trim();
    if (!token || !githubRepo.trim()) {
      setIntegrationOpsStatus('Set both GitHub token and owner/repo before creating repo.');
      return;
    }
    const repoName = githubRepo.includes('/') ? githubRepo.split('/').pop() || githubRepo : githubRepo;
    await runIntegrationOp('GitHub repo creation', async () =>
      createGithubRepo({
        token,
        name: repoName,
        private: false,
        description: 'Created via COMPaaS',
      }),
    );
  };

  const handleGithubOps = async (mode: 'scan' | 'sync' | 'drift' | 'rollback') => {
    if (!repoPathForOps.trim()) {
      setIntegrationOpsStatus('Set a local repo path for GitHub ops.');
      return;
    }
    if (mode === 'scan') {
      await runIntegrationOp('Secret scan', async () => githubSecretScan(repoPathForOps.trim()));
      return;
    }
    if (mode === 'sync') {
      await runIntegrationOp('Remote sync', async () => githubSync(repoPathForOps.trim(), githubDefaultBranch || 'master'));
      return;
    }
    if (mode === 'drift') {
      await runIntegrationOp('Drift check', async () => githubDrift(repoPathForOps.trim(), githubDefaultBranch || 'master'));
      return;
    }
    if (!rollbackCommit.trim()) {
      setIntegrationOpsStatus('Set commit SHA before rollback.');
      return;
    }
    await runIntegrationOp('Rollback', async () => githubRollback(repoPathForOps.trim(), rollbackCommit.trim()));
  };

  const handleVercelOp = async (mode: 'link' | 'preview' | 'production' | 'domain' | 'env') => {
    const token = vercelTokenMasked ? '' : vercelToken.trim();
    if (!token || !vercelProjectName.trim()) {
      setIntegrationOpsStatus('Set Vercel token and project name first.');
      return;
    }
    if (mode === 'link') {
      await runIntegrationOp('Vercel project link', async () =>
        vercelLinkProject({
          token,
          project_name: vercelProjectName.trim(),
          team_id: vercelTeamId.trim(),
        }),
      );
      return;
    }
    if (mode === 'preview' || mode === 'production') {
      await runIntegrationOp(`Vercel ${mode} deploy`, async () =>
        vercelDeploy({
          token,
          project_name: vercelProjectName.trim(),
          team_id: vercelTeamId.trim(),
          target: mode,
        }),
      );
      return;
    }
    if (mode === 'domain') {
      if (!vercelDomain.trim()) {
        setIntegrationOpsStatus('Set domain before assigning.');
        return;
      }
      await runIntegrationOp('Vercel domain assignment', async () =>
        vercelAssignDomain({
          token,
          project_name: vercelProjectName.trim(),
          domain: vercelDomain.trim(),
          team_id: vercelTeamId.trim(),
        }),
      );
      return;
    }
    if (!vercelEnvKey.trim() || !vercelEnvValue.trim()) {
      setIntegrationOpsStatus('Set env key and value before sync.');
      return;
    }
    await runIntegrationOp('Vercel env sync', async () =>
      vercelSetEnv({
        token,
        project_name: vercelProjectName.trim(),
        key: vercelEnvKey.trim(),
        value: vercelEnvValue,
        team_id: vercelTeamId.trim(),
        target: ['preview', 'production'],
      }),
    );
  };

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
        const integrationCfg = integrationsFromConfig(cfg);
        setWorkspaceMode(integrationCfg.workspace_mode);
        if (integrationCfg.github_token === REDACTED_SECRET) {
          setGithubToken('');
          setGithubTokenMasked(true);
        } else {
          setGithubToken(integrationCfg.github_token);
          setGithubTokenMasked(false);
        }
        setGithubRepo(integrationCfg.github_repo);
        setGithubDefaultBranch(integrationCfg.github_default_branch || 'master');
        setGithubAutoPush(Boolean(integrationCfg.github_auto_push));
        setGithubAutoPr(Boolean(integrationCfg.github_auto_pr));
        if (integrationCfg.vercel_token === REDACTED_SECRET) {
          setVercelToken('');
          setVercelTokenMasked(true);
        } else {
          setVercelToken(integrationCfg.vercel_token);
          setVercelTokenMasked(false);
        }
        setVercelTeamId(integrationCfg.vercel_team_id);
        setVercelProjectName(integrationCfg.vercel_project_name);
        if (integrationCfg.slack_token === REDACTED_SECRET) {
          setSlackToken('');
          setSlackTokenMasked(true);
        } else {
          setSlackToken(integrationCfg.slack_token);
          setSlackTokenMasked(false);
        }
        setWebhookUrl(integrationCfg.webhook_url);
      }
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const patch: Partial<AppConfig> = {
      user: { name: userName.trim() },
      ui: { theme: 'midnight', ...(config?.ui ?? {}), poll_interval_ms: pollInterval },
      server: { host: config?.server?.host ?? '', port: config?.server?.port ?? 3000, ...(config?.server ?? {}), auto_open_browser: autoOpen },
    };

    try {
      const configOk = await updateConfig(patch);
      if (!configOk) {
        setSaveError('Failed to save settings');
        return;
      }

      const nextIntegrations: IntegrationSettings = {
        workspace_mode: workspaceMode,
        github_token: githubTokenMasked ? REDACTED_SECRET : githubToken.trim(),
        github_repo: githubRepo.trim(),
        github_default_branch: githubDefaultBranch.trim() || 'master',
        github_auto_push: githubAutoPush,
        github_auto_pr: githubAutoPr,
        vercel_token: vercelTokenMasked ? REDACTED_SECRET : vercelToken.trim(),
        vercel_team_id: vercelTeamId.trim(),
        vercel_project_name: vercelProjectName.trim(),
        slack_token: slackTokenMasked ? REDACTED_SECRET : slackToken.trim(),
        webhook_url: webhookUrl.trim(),
      };
      const currentIntegrations = integrationsFromConfig(config);
      const integrationsChanged = JSON.stringify(nextIntegrations) !== JSON.stringify(currentIntegrations);

      if (integrationsChanged) {
        const integrationsOk = await saveIntegrations(nextIntegrations);
        if (!integrationsOk) {
          setSaveError('Saved core settings, but failed to save integrations');
          return;
        }
      }

      setConfig((prev) => prev ? ({
        ...prev,
        ...patch,
        integrations: nextIntegrations,
      }) : prev);
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

  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];
  const showGlobalSave = activeTab === 'general' || activeTab === 'integrations';

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }} className="animate-fade-in">
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: C.textPrimary, marginBottom: '4px' }}>
          Settings
        </h2>
        <p style={{ fontSize: '13px', color: C.textSecondary }}>
          Manage your COMPaaS dashboard configuration.
        </p>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px' }}>
          {SETTINGS_TABS.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '7px 12px',
                  borderRadius: '999px',
                  border: `1px solid ${selected ? C.accent : C.border}`,
                  backgroundColor: selected ? C.accentDim : C.surface,
                  color: selected ? C.accent : C.textSecondary,
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: selected ? 600 : 500,
                  whiteSpace: 'nowrap',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <p style={{ marginTop: '8px', fontSize: '12px', color: C.textMuted }}>
          {activeTabMeta.description}
        </p>
      </div>

      {activeTab === 'general' && (
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
              description="Automatically open the dashboard when compaas-web starts"
            />
          </div>
        </Section>
      )}

      {activeTab === 'ai' && (
        <Section title="AI Model Provider">
          <AiProviderSection
            key={`${config?.llm?.provider ?? 'none'}|${config?.llm?.base_url ?? 'none'}|${config?.llm?.model ?? 'none'}`}
            llm={config?.llm}
            onSaved={() => { fetchConfig().then((c) => { if (c) setConfig(c); }); onConfigUpdated?.(); }}
          />
        </Section>
      )}

      {activeTab === 'agents' && (
        <>
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

          <Section title="Agent Models">
            <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '16px' }}>
              Override the model used for individual agents. Leave blank to use the global provider setting.
            </p>
            <p style={{ fontSize: '11px', color: C.warning, marginBottom: '10px' }}>
              Stored locally in this browser only. Runtime overrides are not yet wired on the backend.
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

          <Section title="Agent Personas">
            <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '16px' }}>
              Set a custom system prompt for each agent to shape their personality and focus.
            </p>
            <p style={{ fontSize: '11px', color: C.warning, marginBottom: '10px' }}>
              Stored locally in this browser only. Agent persona injection is not yet wired on the backend.
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
        </>
      )}

      {activeTab === 'integrations' && (
        <>
          <Section title="Telegram Integration">
            <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '16px' }}>
              Configure Telegram to continue CEO conversations from your phone.
              Create a bot via @BotFather, then paste the credentials below.
            </p>
            <TelegramSection />
          </Section>

          <Section title="Integrations">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Workspace Mode</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Choose where generated work is written and versioned</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: workspaceMode === 'github' ? 'rgba(59,142,255,0.14)' : 'rgba(63,185,80,0.12)', color: workspaceMode === 'github' ? C.accent : C.success, border: `1px solid ${workspaceMode === 'github' ? 'rgba(59,142,255,0.35)' : 'rgba(63,185,80,0.3)'}` }}>
                    {workspaceMode === 'github' ? 'GitHub mode' : 'Local mode'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setWorkspaceMode('local')}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '7px',
                      border: `1px solid ${workspaceMode === 'local' ? C.accent : C.border}`,
                      backgroundColor: workspaceMode === 'local' ? C.accentDim : C.surface,
                      color: workspaceMode === 'local' ? C.accent : C.textSecondary,
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    Local files
                  </button>
                  <button
                    onClick={() => setWorkspaceMode('github')}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '7px',
                      border: `1px solid ${workspaceMode === 'github' ? C.accent : C.border}`,
                      backgroundColor: workspaceMode === 'github' ? C.accentDim : C.surface,
                      color: workspaceMode === 'github' ? C.accent : C.textSecondary,
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    GitHub repo
                  </button>
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>GitHub Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Repo sync, branch pushes, PR creation, and webhook intake</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(63,185,80,0.12)', color: C.success, border: `1px solid rgba(63,185,80,0.3)` }}>Inbound webhook ready</span>
                </div>

                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr', marginBottom: '10px' }}>
                  <input
                    type="text"
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                    placeholder="owner/repo (example: comp-a-a-s/compaas)"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <input
                    type="text"
                    value={githubDefaultBranch}
                    onChange={(e) => setGithubDefaultBranch(e.target.value)}
                    placeholder="Default branch (example: master)"
                    style={{ ...inputStyle({ maxWidth: '260px', fontSize: '12px' }) }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <input
                    type="password"
                    value={githubToken}
                    onChange={(e) => { setGithubToken(e.target.value); }}
                    placeholder={githubTokenMasked ? 'Saved (hidden). Type to replace.' : 'ghp_xxxx (Personal access token)'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onInput={() => { setGithubTokenMasked(false); }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: C.textSecondary }}>
                    <input type="checkbox" checked={githubAutoPush} onChange={(e) => setGithubAutoPush(e.target.checked)} />
                    Auto-push commits
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: C.textSecondary }}>
                    <input type="checkbox" checked={githubAutoPr} onChange={(e) => setGithubAutoPr(e.target.checked)} />
                    Auto-open PRs
                  </label>
                </div>

                <p style={{ fontSize: '11px', color: C.textMuted, marginTop: '4px' }}>
                  Webhook URL: <code style={{ color: C.accent }}>/api/integrations/github/webhook</code>
                </p>
                <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={handleLoadGithubRepos}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Load repos
                    </button>
                    <button
                      onClick={handleCreateGithubRepo}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Create repo
                    </button>
                    <button
                      onClick={() => handleGithubOps('scan')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Secret scan
                    </button>
                    <button
                      onClick={() => handleGithubOps('sync')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Sync remote
                    </button>
                    <button
                      onClick={() => handleGithubOps('drift')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Drift check
                    </button>
                  </div>
                  {githubRepoOptions.length > 0 && (
                    <select
                      value={githubRepo}
                      onChange={(e) => setGithubRepo(e.target.value)}
                      style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    >
                      {githubRepoOptions.map((repo) => (
                        <option key={repo.full_name} value={repo.full_name}>
                          {repo.full_name} ({repo.default_branch})
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="text"
                    value={repoPathForOps}
                    onChange={(e) => setRepoPathForOps(e.target.value)}
                    placeholder="/absolute/path/to/local/repo (for sync, drift, scan, rollback)"
                    style={{ ...inputStyle({ maxWidth: '520px', fontSize: '12px' }) }}
                  />
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={rollbackCommit}
                      onChange={(e) => setRollbackCommit(e.target.value)}
                      placeholder="Commit SHA for rollback"
                      style={{ ...inputStyle({ maxWidth: '260px', fontSize: '12px' }) }}
                    />
                    <button
                      onClick={() => handleGithubOps('rollback')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.error}`, backgroundColor: 'transparent', color: C.error, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Rollback commit
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Vercel Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Deploy generated apps directly to Vercel from the same workflow</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(59,142,255,0.14)', color: C.accent, border: `1px solid rgba(59,142,255,0.32)` }}>Deployment ready</span>
                </div>

                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                  <input
                    type="password"
                    value={vercelToken}
                    onChange={(e) => { setVercelToken(e.target.value); }}
                    placeholder={vercelTokenMasked ? 'Saved (hidden). Type to replace.' : 'Vercel token (vercel_...)'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onInput={() => { setVercelTokenMasked(false); }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <input
                    type="text"
                    value={vercelTeamId}
                    onChange={(e) => setVercelTeamId(e.target.value)}
                    placeholder="Team ID (optional)"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <input
                    type="text"
                    value={vercelProjectName}
                    onChange={(e) => setVercelProjectName(e.target.value)}
                    placeholder="Project name"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                </div>
                <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => handleVercelOp('link')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Link project
                    </button>
                    <button
                      onClick={() => handleVercelOp('preview')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Preview deploy
                    </button>
                    <button
                      onClick={() => handleVercelOp('production')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.warning}`, backgroundColor: 'transparent', color: C.warning, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Production deploy
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={vercelDomain}
                      onChange={(e) => setVercelDomain(e.target.value)}
                      placeholder="example.com"
                      style={{ ...inputStyle({ maxWidth: '220px', fontSize: '12px' }) }}
                    />
                    <button
                      onClick={() => handleVercelOp('domain')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Assign domain
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={vercelEnvKey}
                      onChange={(e) => setVercelEnvKey(e.target.value)}
                      placeholder="ENV_KEY"
                      style={{ ...inputStyle({ maxWidth: '160px', fontSize: '12px' }) }}
                    />
                    <input
                      type="text"
                      value={vercelEnvValue}
                      onChange={(e) => setVercelEnvValue(e.target.value)}
                      placeholder="ENV_VALUE"
                      style={{ ...inputStyle({ maxWidth: '220px', fontSize: '12px' }) }}
                    />
                    <button
                      onClick={() => handleVercelOp('env')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Sync env
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Slack Bot</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Two-way Slack integration for CEO conversations</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(63,185,80,0.12)', color: C.success, border: `1px solid rgba(63,185,80,0.3)` }}>Events API ready</span>
                </div>
                <input type="password" value={slackToken} onChange={(e) => { setSlackToken(e.target.value); }}
                  placeholder={slackTokenMasked ? 'Saved (hidden). Type to replace.' : 'xoxb-xxxx (Bot token)'}
                  style={{ ...inputStyle({ maxWidth: '380px', fontSize: '12px' }) }}
                  onInput={() => { setSlackTokenMasked(false); }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                />
                <p style={{ fontSize: '11px', color: C.textMuted, marginTop: '4px' }}>Events URL: <code style={{ color: C.accent }}>/api/integrations/slack/events</code></p>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Outbound Webhooks</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>POST to a URL on every activity event</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(63,185,80,0.12)', color: C.success, border: `1px solid rgba(63,185,80,0.3)` }}>Active</span>
                </div>
                <input type="url" value={webhookUrl} onChange={(e) => { setWebhookUrl(e.target.value); }}
                  placeholder="https://your-server.com/webhook"
                  style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                />
              </div>
            </div>
            {integrationOpsStatus && (
              <div style={{ marginTop: '12px', padding: '10px', borderRadius: '8px', border: `1px solid ${C.border}`, backgroundColor: C.surface }}>
                <p style={{ margin: 0, fontSize: '11px', color: C.textSecondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {integrationOpsStatus}
                </p>
              </div>
            )}
          </Section>
        </>
      )}

      {activeTab === 'appearance' && (
        <>
          <Section title="Appearance">
            <ThemeSelector />
          </Section>

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
        </>
      )}

      {showGlobalSave && (
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
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
