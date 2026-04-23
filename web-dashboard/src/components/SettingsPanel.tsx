import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchConfig,
  updateConfig,
  updateConfigResult,
  testLlmConnection,
  fetchLlmModels,
  saveIntegrationsResult,
  pollTelegramMessagesResult,
  githubVerifyIntegration,
  vercelVerifyIntegration,
  netlifyVerifyIntegration,
  gitlabVerifyIntegration,
  stripeVerifyIntegration,
  fetchGithubRepos,
  createGithubRepo,
  githubSecretScan,
  githubSync,
  githubDrift,
  githubRollback,
  fetchPrQualityProfile,
  updatePrQualityProfile,
  vercelLinkProject,
  vercelDeploy,
  vercelAssignDomain,
  vercelSetEnv,
  netlifyDeploy,
  netlifyAssignDomain,
  netlifySetEnv,
  vercelListProjects,
  netlifyListSites,
  slackSendMessageResult,
  linearVerifyIntegration,
  linearCreateIssue,
  notionVerifyIntegration,
  notionUpsertPage,
  jiraVerifyIntegration,
  jiraCreateIssue,
  jiraTransitionIssue,
  gitlabCreateBranch,
  gitlabCreateMergeRequest,
  fetchUpdateStatus,
  checkForUpdates,
  applyManualUpdate,
} from '../api/client';
import type { AppConfig, GuidanceAction, LlmConfig, UpdateStatusResponse } from '../types';
import { useThemeSwitch } from '../hooks/useTheme';
import type { ThemeName } from '../hooks/useTheme';
import FloatingSelect from './ui/FloatingSelect';
import ContextPackPanel from './ContextPackPanel';
import InlineActionCard from './InlineActionCard';

// ---- Types ----

interface SettingsPanelProps {
  onConfigUpdated?: () => void;
  initialTab?: SettingsTab;
  focusConnector?: 'github' | 'gitlab' | 'vercel' | 'netlify' | 'stripe' | 'linear' | 'notion' | 'jira' | null;
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
  { id: 'vp-product', role: 'Chief Product Officer' },
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
  { id: 'integrations', label: 'Integrations', description: 'Workspace mode, GitHub, GitLab, Vercel, Netlify, Telegram, Slack, and webhooks.' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and density preferences.' },
];

interface IntegrationSettings {
  workspace_mode: 'local' | 'github' | 'gitlab';
  github_token: string;
  github_repo: string;
  github_default_branch: string;
  github_auto_push: boolean;
  github_auto_pr: boolean;
  github_verified: boolean;
  github_verified_at: string;
  github_last_error: string;
  gitlab_base_url: string;
  gitlab_token: string;
  gitlab_project_id: string;
  gitlab_default_branch: string;
  gitlab_verified: boolean;
  gitlab_verified_at: string;
  gitlab_last_error: string;
  vercel_token: string;
  vercel_team_id: string;
  vercel_project_name: string;
  vercel_default_target: 'preview' | 'production';
  vercel_verified: boolean;
  vercel_verified_at: string;
  vercel_last_error: string;
  netlify_token: string;
  netlify_site_id: string;
  netlify_team_id: string;
  netlify_default_target: 'preview' | 'production';
  netlify_verified: boolean;
  netlify_verified_at: string;
  netlify_last_error: string;
  deploy_provider_preference: 'vercel' | 'netlify';
  stripe_secret_key: string;
  stripe_publishable_key: string;
  stripe_webhook_secret: string;
  stripe_price_basic: string;
  stripe_price_pro: string;
  stripe_verified: boolean;
  stripe_verified_at: string;
  stripe_last_error: string;
  slack_token: string;
  slack_default_channel: string;
  slack_status: 'disconnected' | 'configured' | 'verified' | 'degraded' | string;
  slack_verified_at: string;
  slack_last_success_at: string;
  slack_last_error: string;
  slack_consecutive_failures: number;
  linear_api_key: string;
  linear_team_id: string;
  linear_verified: boolean;
  linear_verified_at: string;
  linear_last_error: string;
  linear_status: 'disconnected' | 'configured' | 'verified' | 'degraded' | string;
  linear_last_success_at: string;
  linear_consecutive_failures: number;
  notion_token: string;
  notion_parent_page_id: string;
  notion_verified: boolean;
  notion_verified_at: string;
  notion_last_error: string;
  notion_status: 'disconnected' | 'configured' | 'verified' | 'degraded' | string;
  notion_last_success_at: string;
  notion_consecutive_failures: number;
  jira_base_url: string;
  jira_email: string;
  jira_api_token: string;
  jira_project_key: string;
  jira_verified: boolean;
  jira_verified_at: string;
  jira_last_error: string;
  jira_status: 'disconnected' | 'configured' | 'verified' | 'degraded' | string;
  jira_last_success_at: string;
  jira_consecutive_failures: number;
  webhook_url: string;
}

type QuickConnector = 'github' | 'gitlab' | 'vercel' | 'netlify' | 'stripe' | 'linear' | 'notion' | 'jira';
type ConnectorReadinessGroup = 'Deployment connectors' | 'Work management connectors' | 'Messaging connectors';

interface ConnectorReadinessEntry {
  id: string;
  group: ConnectorReadinessGroup;
  name: string;
  configured: boolean;
  verified: boolean;
  status: ConnectorLifecycleState;
  lastSuccessAt: string;
  lastError: string;
  disabledReason: string;
  retry: () => Promise<unknown>;
}

interface DiscoveryOption {
  value: string;
  label: string;
}

interface VerifyOutcome {
  ok: boolean;
  message: string;
}

const REDACTED_SECRET = '__COMPAAS_REDACTED__';

type ConnectorLifecycleState = 'disconnected' | 'configured' | 'verified' | 'degraded';

function normalizeConnectorStatus(rawStatus: unknown, configured: boolean): ConnectorLifecycleState {
  const normalized = String(rawStatus || '').trim().toLowerCase();
  if (normalized === 'configured' || normalized === 'verified' || normalized === 'degraded' || normalized === 'disconnected') {
    return normalized;
  }
  return configured ? 'configured' : 'disconnected';
}

function connectorStatusColor(status: ConnectorLifecycleState): string {
  if (status === 'verified') return C.success;
  if (status === 'degraded') return C.warning;
  if (status === 'configured') return C.accent;
  return C.textMuted;
}

function connectorStatusLabel(status: ConnectorLifecycleState): string {
  if (status === 'verified') return 'Verified';
  if (status === 'degraded') return 'Degraded';
  if (status === 'configured') return 'Configured';
  return 'Disconnected';
}

function connectorReadinessHint(status: ConnectorLifecycleState, configured: boolean): string {
  if (!configured || status === 'disconnected') {
    return 'Configuration is incomplete. Add credentials or IDs, then retry verification.';
  }
  if (status === 'verified') {
    return 'Ready. Connector is configured and verified.';
  }
  if (status === 'degraded') {
    return 'Connector is configured but currently failing. Retry after checking permissions/network.';
  }
  return 'Configured but not yet verified. Run retry to complete setup.';
}

function integrationsFromConfig(config: AppConfig | null): IntegrationSettings {
  return {
    workspace_mode: config?.integrations?.workspace_mode === 'github'
      ? 'github'
      : (config?.integrations?.workspace_mode === 'gitlab' ? 'gitlab' : 'local'),
    github_token: config?.integrations?.github_token ?? '',
    github_repo: config?.integrations?.github_repo ?? '',
    github_default_branch: config?.integrations?.github_default_branch ?? 'main',
    github_auto_push: Boolean(config?.integrations?.github_auto_push),
    github_auto_pr: Boolean(config?.integrations?.github_auto_pr),
    github_verified: Boolean(config?.integrations?.github_verified),
    github_verified_at: config?.integrations?.github_verified_at ?? '',
    github_last_error: config?.integrations?.github_last_error ?? '',
    gitlab_base_url: config?.integrations?.gitlab_base_url ?? 'https://gitlab.com',
    gitlab_token: config?.integrations?.gitlab_token ?? '',
    gitlab_project_id: config?.integrations?.gitlab_project_id ?? '',
    gitlab_default_branch: config?.integrations?.gitlab_default_branch ?? 'main',
    gitlab_verified: Boolean(config?.integrations?.gitlab_verified),
    gitlab_verified_at: config?.integrations?.gitlab_verified_at ?? '',
    gitlab_last_error: config?.integrations?.gitlab_last_error ?? '',
    vercel_token: config?.integrations?.vercel_token ?? '',
    vercel_team_id: config?.integrations?.vercel_team_id ?? '',
    vercel_project_name: config?.integrations?.vercel_project_name ?? '',
    vercel_default_target: config?.integrations?.vercel_default_target === 'production' ? 'production' : 'preview',
    vercel_verified: Boolean(config?.integrations?.vercel_verified),
    vercel_verified_at: config?.integrations?.vercel_verified_at ?? '',
    vercel_last_error: config?.integrations?.vercel_last_error ?? '',
    netlify_token: config?.integrations?.netlify_token ?? '',
    netlify_site_id: config?.integrations?.netlify_site_id ?? '',
    netlify_team_id: config?.integrations?.netlify_team_id ?? '',
    netlify_default_target: config?.integrations?.netlify_default_target === 'production' ? 'production' : 'preview',
    netlify_verified: Boolean(config?.integrations?.netlify_verified),
    netlify_verified_at: config?.integrations?.netlify_verified_at ?? '',
    netlify_last_error: config?.integrations?.netlify_last_error ?? '',
    deploy_provider_preference: config?.integrations?.deploy_provider_preference === 'netlify' ? 'netlify' : 'vercel',
    stripe_secret_key: config?.integrations?.stripe_secret_key ?? '',
    stripe_publishable_key: config?.integrations?.stripe_publishable_key ?? '',
    stripe_webhook_secret: config?.integrations?.stripe_webhook_secret ?? '',
    stripe_price_basic: config?.integrations?.stripe_price_basic ?? '',
    stripe_price_pro: config?.integrations?.stripe_price_pro ?? '',
    stripe_verified: Boolean(config?.integrations?.stripe_verified),
    stripe_verified_at: config?.integrations?.stripe_verified_at ?? '',
    stripe_last_error: config?.integrations?.stripe_last_error ?? '',
    slack_token: config?.integrations?.slack_token ?? '',
    slack_default_channel: config?.integrations?.slack_default_channel ?? '',
    slack_status: config?.integrations?.slack_status ?? 'disconnected',
    slack_verified_at: config?.integrations?.slack_verified_at ?? '',
    slack_last_success_at: config?.integrations?.slack_last_success_at ?? '',
    slack_last_error: config?.integrations?.slack_last_error ?? '',
    slack_consecutive_failures: Number(config?.integrations?.slack_consecutive_failures ?? 0) || 0,
    linear_api_key: config?.integrations?.linear_api_key ?? '',
    linear_team_id: config?.integrations?.linear_team_id ?? '',
    linear_verified: Boolean(config?.integrations?.linear_verified),
    linear_verified_at: config?.integrations?.linear_verified_at ?? '',
    linear_last_error: config?.integrations?.linear_last_error ?? '',
    linear_status: config?.integrations?.linear_status ?? 'disconnected',
    linear_last_success_at: config?.integrations?.linear_last_success_at ?? '',
    linear_consecutive_failures: Number(config?.integrations?.linear_consecutive_failures ?? 0) || 0,
    notion_token: config?.integrations?.notion_token ?? '',
    notion_parent_page_id: config?.integrations?.notion_parent_page_id ?? '',
    notion_verified: Boolean(config?.integrations?.notion_verified),
    notion_verified_at: config?.integrations?.notion_verified_at ?? '',
    notion_last_error: config?.integrations?.notion_last_error ?? '',
    notion_status: config?.integrations?.notion_status ?? 'disconnected',
    notion_last_success_at: config?.integrations?.notion_last_success_at ?? '',
    notion_consecutive_failures: Number(config?.integrations?.notion_consecutive_failures ?? 0) || 0,
    jira_base_url: config?.integrations?.jira_base_url ?? '',
    jira_email: config?.integrations?.jira_email ?? '',
    jira_api_token: config?.integrations?.jira_api_token ?? '',
    jira_project_key: config?.integrations?.jira_project_key ?? '',
    jira_verified: Boolean(config?.integrations?.jira_verified),
    jira_verified_at: config?.integrations?.jira_verified_at ?? '',
    jira_last_error: config?.integrations?.jira_last_error ?? '',
    jira_status: config?.integrations?.jira_status ?? 'disconnected',
    jira_last_success_at: config?.integrations?.jira_last_success_at ?? '',
    jira_consecutive_failures: Number(config?.integrations?.jira_consecutive_failures ?? 0) || 0,
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

function IntegrationGuide({
  title,
  steps,
  note,
}: {
  title: string;
  steps: React.ReactNode[];
  note?: React.ReactNode;
}) {
  return (
    <details
      style={{
        marginTop: '10px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${C.border}`,
        backgroundColor: C.surface,
      }}
    >
      <summary style={{ cursor: 'pointer', fontSize: '11px', fontWeight: 600, color: C.accent }}>
        {title}
      </summary>
      <ol style={{ margin: '8px 0 0 16px', padding: 0, color: C.textSecondary, fontSize: '11px', lineHeight: 1.55 }}>
        {steps.map((step, idx) => (
          <li key={`guide-step-${idx}`} style={{ marginBottom: idx < steps.length - 1 ? '5px' : 0 }}>
            {step}
          </li>
        ))}
      </ol>
      {note && (
        <p style={{ marginTop: '8px', marginBottom: 0, fontSize: '11px', color: C.textMuted, lineHeight: 1.5 }}>
          {note}
        </p>
      )}
    </details>
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
} as const;

function readTelegramValue(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function TelegramSection() {
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<ConnectorLifecycleState>('disconnected');
  const [lastSuccessAt, setLastSuccessAt] = useState('');
  const [lastError, setLastError] = useState('');
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [busy, setBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryStatus, setRetryStatus] = useState('');
  const [saved, setSaved] = useState(false);

  const applyTelegramConfig = useCallback((cfg: AppConfig | null) => {
    const rawToken = String(cfg?.integrations?.telegram_bot_token || '').trim();
    const rawChat = String(cfg?.integrations?.telegram_chat_id || '').trim();
    const token = (rawToken && rawToken !== REDACTED_SECRET) ? rawToken : readTelegramValue(TELEGRAM_KEYS.token).trim();
    const chat = (rawChat && rawChat !== REDACTED_SECRET) ? rawChat : readTelegramValue(TELEGRAM_KEYS.chatId).trim();
    const isConfigured = Boolean(token && chat) || Boolean(cfg?.integrations?.telegram_configured);
    setBotToken(token);
    setChatId(chat);
    setConfigured(isConfigured);
    setStatus(normalizeConnectorStatus(cfg?.integrations?.telegram_status, isConfigured));
    setLastSuccessAt(String(cfg?.integrations?.telegram_last_success_at || '').trim());
    setLastError(String(cfg?.integrations?.telegram_last_error || '').trim());
    setConsecutiveFailures(Math.max(0, Number(cfg?.integrations?.telegram_consecutive_failures || 0) || 0));
  }, []);

  useEffect(() => {
    fetchConfig().then((cfg) => {
      applyTelegramConfig(cfg);
    }).catch(() => {
      applyTelegramConfig(null);
    });
  }, [applyTelegramConfig]);

  const handleSave = async () => {
    const token = botToken.trim();
    const chat = chatId.trim();
    if (!token || !chat) return;
    setBusy(true);
    setError('');
    const result = await saveIntegrationsResult({
      telegram_bot_token: token,
      telegram_chat_id: chat,
      telegram_configured: true,
    });
    if (!result.ok) {
      setBusy(false);
      setConfigured(false);
      setError(result.detail || 'Failed to save Telegram settings.');
      return;
    }
    try {
      localStorage.setItem(TELEGRAM_KEYS.token, token);
      localStorage.setItem(TELEGRAM_KEYS.chatId, chat);
    } catch {
      // no-op
    }
    setConfigured(true);
    setStatus('configured');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    const refreshed = await fetchConfig().catch(() => null);
    applyTelegramConfig(refreshed);
    setBusy(false);
  };

  const handleClear = async () => {
    setBusy(true);
    setError('');
    const result = await saveIntegrationsResult({
      telegram_bot_token: '',
      telegram_chat_id: '',
      telegram_configured: false,
      telegram_cursor_map: {},
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.detail || 'Failed to clear Telegram settings.');
      return;
    }
    try {
      localStorage.removeItem(TELEGRAM_KEYS.token);
      localStorage.removeItem(TELEGRAM_KEYS.chatId);
    } catch {
      // no-op
    }
    setBotToken('');
    setChatId('');
    setConfigured(false);
    setStatus('disconnected');
    setLastSuccessAt('');
    setLastError('');
    setConsecutiveFailures(0);
    setRetryStatus('');
    setBusy(false);
  };

  const handleRetryPoll = async () => {
    if (!configured || busy || retryBusy) {
      return;
    }
    setRetryBusy(true);
    setRetryStatus('');
    const result = await pollTelegramMessagesResult({ timeout_seconds: 1 });
    if (!result.ok) {
      setRetryStatus(result.detail || 'Retry poll failed.');
    } else {
      const messageCount = Array.isArray(result.data?.messages) ? result.data.messages.length : 0;
      setRetryStatus(messageCount > 0
        ? `Retry successful. Pulled ${messageCount} new message${messageCount === 1 ? '' : 's'}.`
        : 'Retry successful. No new messages.');
    }
    const refreshed = await fetchConfig().catch(() => null);
    applyTelegramConfig(refreshed);
    setRetryBusy(false);
  };

  const canSave = Boolean(botToken.trim() && chatId.trim()) && !busy && !retryBusy;

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
      <div
        style={{
          display: 'grid',
          gap: '6px',
          padding: '10px 12px',
          borderRadius: '8px',
          border: `1px solid ${C.border}`,
          backgroundColor: C.surfaceRaised,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: C.textSecondary }}>Connector health:</span>
          <span style={{ fontSize: '12px', fontWeight: 600, color: connectorStatusColor(status) }}>
            {connectorStatusLabel(status)}
          </span>
          {lastSuccessAt && (
            <span style={{ fontSize: '11px', color: C.textMuted }}>
              Last success {new Date(lastSuccessAt).toLocaleString()}
            </span>
          )}
          {consecutiveFailures > 0 && (
            <span style={{ fontSize: '11px', color: C.warning }}>
              {consecutiveFailures} failure{consecutiveFailures === 1 ? '' : 's'} in a row
            </span>
          )}
        </div>
        {lastError && (
          <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>
            {lastError}
          </p>
        )}
      </div>

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
          onClick={() => { void handleSave(); }}
          disabled={!canSave}
          style={{
            padding: '7px 16px',
            borderRadius: '6px',
            border: `1px solid ${canSave ? C.accent : C.border}`,
            backgroundColor: canSave ? C.accentDim : 'transparent',
            color: canSave ? C.accent : C.textMuted,
            fontSize: '13px',
            cursor: canSave ? 'pointer' : 'default',
            opacity: canSave ? 1 : 0.5,
          }}
        >
          {busy ? 'Saving…' : 'Save Credentials'}
        </button>
        <button
          onClick={() => { void handleRetryPoll(); }}
          disabled={!configured || busy || retryBusy}
          style={{
            padding: '7px 14px',
            borderRadius: '6px',
            border: `1px solid ${C.border}`,
            backgroundColor: C.surface,
            color: C.textSecondary,
            fontSize: '13px',
            cursor: (!configured || busy || retryBusy) ? 'default' : 'pointer',
            opacity: (!configured || busy || retryBusy) ? 0.6 : 1,
          }}
        >
          {retryBusy ? 'Retrying…' : 'Retry Poll'}
        </button>
        {configured && (
          <button
            onClick={() => { void handleClear(); }}
            disabled={busy}
            style={{
              padding: '7px 14px',
              borderRadius: '6px',
              border: `1px solid ${C.border}`,
              backgroundColor: 'transparent',
              color: C.textSecondary,
              fontSize: '13px',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.error; e.currentTarget.style.borderColor = C.error; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.textSecondary; e.currentTarget.style.borderColor = C.border; }}
          >
            Clear
          </button>
        )}
        {saved && <span style={{ fontSize: '12px', color: C.success }}>Saved!</span>}
        {error && <span style={{ fontSize: '12px', color: C.warning }}>{error}</span>}
        {retryStatus && <span style={{ fontSize: '12px', color: retryStatus.toLowerCase().includes('failed') ? C.warning : C.textSecondary }}>{retryStatus}</span>}
      </div>

      <div style={{ padding: '10px 12px', borderRadius: '8px', border: `1px solid ${C.border}`, backgroundColor: C.surfaceRaised }}>
        <p style={{ fontSize: '12px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>Full setup guide</p>
        <ol style={{ margin: '0 0 0 18px', padding: 0, color: C.textSecondary, fontSize: '11px', lineHeight: 1.55 }}>
          <li style={{ marginBottom: '5px' }}>Open Telegram and message <strong>@BotFather</strong>.</li>
          <li style={{ marginBottom: '5px' }}>Run <code>/newbot</code>, choose a bot name and username, then copy the Bot Token.</li>
          <li style={{ marginBottom: '5px' }}>To get your Chat ID, message <strong>@userinfobot</strong> in Telegram — it will reply with your ID.</li>
          <li style={{ marginBottom: '5px' }}>Paste both the Bot Token and Chat ID above.</li>
          <li>Enable the <strong>Telegram On</strong> toggle inside CEO Chat to mirror that project conversation.</li>
        </ol>
        <p style={{ marginTop: '8px', fontSize: '11px', color: C.textMuted, lineHeight: 1.5 }}>
          For group chats: add the bot to the group, then use <code>@userinfobot</code> in the group to get its ID (starts with <code>-100</code>).
        </p>
      </div>
    </div>
  );
}

function ConnectorReadinessCenter({
  rows,
  integrationOpsBusy,
  slackRetryBusy,
  quickVerifyBusy,
}: {
  rows: ConnectorReadinessEntry[];
  integrationOpsBusy: boolean;
  slackRetryBusy: boolean;
  quickVerifyBusy: string;
}) {
  return (
    <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}`, display: 'grid', gap: '10px' }}>
      <div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Connector Readiness Center</div>
        <div style={{ fontSize: '11px', color: C.textSecondary }}>
          Clear status per connector with remediation guidance and one-click retry.
        </div>
      </div>
      {(['Deployment connectors', 'Work management connectors', 'Messaging connectors'] as const).map((group) => (
        <div key={group} style={{ border: `1px solid ${C.border}`, borderRadius: '8px', backgroundColor: C.surface, padding: '10px', display: 'grid', gap: '8px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: C.textPrimary }}>{group}</div>
          {rows.filter((row) => row.group === group).map((row) => (
            <div key={`readiness-${row.id}`} style={{ border: `1px solid ${C.border}`, borderRadius: '8px', padding: '8px', backgroundColor: C.surfaceRaised, display: 'grid', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: C.textPrimary }}>{row.name}</div>
                <span style={{ fontSize: '11px', color: connectorStatusColor(row.status) }}>
                  {connectorStatusLabel(row.status)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px', color: C.textSecondary }}>
                <span>Configured: {row.configured ? 'Yes' : 'No'}</span>
                <span>Verified: {row.verified ? 'Yes' : 'No'}</span>
                <span>Last success: {row.lastSuccessAt ? new Date(row.lastSuccessAt).toLocaleString() : '—'}</span>
                <span>Last error: {row.lastError || '—'}</span>
                <button
                  type="button"
                  onClick={() => { void row.retry(); }}
                  disabled={integrationOpsBusy || slackRetryBusy || quickVerifyBusy.length > 0 || Boolean(row.disabledReason)}
                  style={{
                    padding: '4px 9px',
                    borderRadius: '6px',
                    border: `1px solid ${C.border}`,
                    backgroundColor: C.surface,
                    color: C.textSecondary,
                    fontSize: '11px',
                    cursor: (integrationOpsBusy || slackRetryBusy || quickVerifyBusy.length > 0 || Boolean(row.disabledReason)) ? 'not-allowed' : 'pointer',
                    opacity: (integrationOpsBusy || slackRetryBusy || quickVerifyBusy.length > 0 || Boolean(row.disabledReason)) ? 0.7 : 1,
                  }}
                >
                  Retry
                </button>
              </div>
              <p style={{ margin: 0, fontSize: '11px', color: C.textMuted }}>
                Why not ready: {row.disabledReason || connectorReadinessHint(row.status, row.configured)}
              </p>
            </div>
          ))}
        </div>
      ))}
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

const ANTHROPIC_MODEL_PRESETS = [
  'claude-sonnet-4-0',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-3-7-sonnet-latest',
  'claude-3-5-haiku-latest',
  'custom',
];
const OPENAI_MODEL_PRESETS = [
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.2-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1',
  'custom',
];
const GEMINI_MODEL_PRESETS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'custom',
];
const MODEL_CATALOG_CACHE_KEY_PREFIX = 'compaas_model_catalog_cache_v1';

type ModelCatalogSource = 'preset' | 'live' | 'fallback' | 'runtime-fixed';

interface ModelCatalogCacheEntry {
  source: 'live';
  models: string[];
  fetched_at: string;
}

function modelCatalogCacheKey(
  provider: LlmConfig['provider'],
  openaiMode: 'apikey' | 'codex',
  anthropicMode: 'cli' | 'apikey',
  baseUrl: string,
): string {
  const normalizedBase = String(baseUrl || '').trim().toLowerCase();
  const mode = provider === 'openai'
    ? openaiMode
    : provider === 'anthropic'
      ? anthropicMode
      : 'default';
  return `${MODEL_CATALOG_CACHE_KEY_PREFIX}:${provider}:${mode}:${normalizedBase}`;
}

function readCachedModelCatalog(cacheKey: string): ModelCatalogCacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelCatalogCacheEntry>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.source !== 'live') return null;
    const models = Array.isArray(parsed.models)
      ? parsed.models.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    const fetchedAt = String(parsed.fetched_at || '').trim();
    if (!fetchedAt || models.length === 0) return null;
    return { source: 'live', fetched_at: fetchedAt, models };
  } catch {
    return null;
  }
}

function writeCachedModelCatalog(cacheKey: string, entry: ModelCatalogCacheEntry): void {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(entry));
  } catch {
    // Ignore storage failures.
  }
}

function dedupeModelNames(models: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of models) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

function withCustomModelOption(models: string[]): string[] {
  const unique = dedupeModelNames(models.filter((m) => String(m || '').trim().toLowerCase() !== 'custom'));
  return [...unique, 'custom'];
}

function fallbackModelsForProvider(
  provider: LlmConfig['provider'],
  openaiMode: 'apikey' | 'codex',
): string[] {
  if (provider === 'anthropic') return withCustomModelOption(ANTHROPIC_MODEL_PRESETS);
  if (provider === 'openai') {
    if (openaiMode === 'codex') return ['codex', 'custom'];
    return withCustomModelOption(OPENAI_MODEL_PRESETS);
  }
  if (provider === 'gemini') return withCustomModelOption(GEMINI_MODEL_PRESETS);
  return withCustomModelOption(['gpt-oss-120b', 'gpt-oss-20b', 'llama3.2', 'qwen3-coder', 'mistral-small3.1']);
}

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
  const [provider, setProvider]         = useState<LlmConfig['provider']>(llm?.provider ?? 'openai');
  const [anthropicMode, setAnthropicMode] = useState<'cli' | 'apikey'>(llm?.anthropic_mode ?? 'cli');
  const [openaiMode, setOpenaiMode]     = useState<'apikey' | 'codex'>(llm?.openai_mode ?? 'codex');
  const [baseUrl, setBaseUrl]           = useState(llm?.base_url ?? 'http://localhost:11434/v1');
  const [model, setModel]               = useState(() => {
    if (llm?.model) return llm.model;
    if (llm?.provider === 'anthropic') return 'claude-sonnet-4-0';
    if (llm?.provider === 'gemini') return 'gemini-2.5-pro';
    if (llm?.provider === 'openai') return 'gpt-5.2';
    return 'gpt-oss-20b';
  });
  const [apiKey, setApiKey]             = useState(llm?.api_key ?? '');
  const [localPreset, setLocalPreset]   = useState<(typeof LOCAL_PRESETS_SETTINGS)[number]['id']>(() => detectLocalPreset(llm?.base_url ?? 'http://localhost:11434/v1'));
  const [systemPrompt, setSystemPrompt] = useState(llm?.system_prompt ?? '');
  const [proxyEnabled, setProxyEnabled] = useState(llm?.proxy_enabled ?? false);
  const [proxyUrl, setProxyUrl]         = useState(llm?.proxy_url ?? 'http://localhost:4000');
  const [anthropicPreset, setAnthropicPreset] = useState(() => {
    if (!llm || llm.provider !== 'anthropic') return 'claude-sonnet-4-0';
    return ANTHROPIC_MODEL_PRESETS.includes(llm.model) ? llm.model : 'custom';
  });
  const [openaiPreset, setOpenaiPreset] = useState(() => {
    if (!llm || llm.provider !== 'openai') return 'gpt-5.2';
    return OPENAI_MODEL_PRESETS.includes(llm.model) ? llm.model : 'custom';
  });
  const [geminiPreset, setGeminiPreset] = useState(() => {
    if (!llm || llm.provider !== 'gemini') return 'gemini-2.5-pro';
    return GEMINI_MODEL_PRESETS.includes(llm.model) ? llm.model : 'custom';
  });
  const [anthropicModelOptions, setAnthropicModelOptions] = useState<string[]>(() =>
    fallbackModelsForProvider('anthropic', 'apikey'),
  );
  const [openaiModelOptions, setOpenaiModelOptions] = useState<string[]>(() =>
    fallbackModelsForProvider('openai', llm?.openai_mode === 'codex' ? 'codex' : 'apikey'),
  );
  const [geminiModelOptions, setGeminiModelOptions] = useState<string[]>(() =>
    fallbackModelsForProvider('gemini', 'apikey'),
  );
  const [openCompatModelOptions, setOpenCompatModelOptions] = useState<string[]>(() =>
    fallbackModelsForProvider('openai_compat', 'apikey'),
  );
  const [modelCatalogBusy, setModelCatalogBusy] = useState(false);
  const [modelCatalogMessage, setModelCatalogMessage] = useState('');
  const [modelCatalogSource, setModelCatalogSource] = useState<ModelCatalogSource>('preset');
  const [modelCatalogFetchedAt, setModelCatalogFetchedAt] = useState('');
  const modelCatalogRequestRef = useRef(0);

  const [testStatus, setTestStatus]   = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);

  const showApiProbe =
    provider === 'openai_compat' || provider === 'gemini' || (provider === 'openai' && openaiMode === 'apikey');

  const handlePreset = (presetId: string) => {
    const p = LOCAL_PRESETS_SETTINGS.find((x) => x.id === presetId);
    if (p) {
      setLocalPreset(p.id);
      setBaseUrl(p.baseUrl);
      setApiKey(p.apiKey);
    }
  };

  const handleAnthropicPreset = (m: string) => {
    setAnthropicPreset(m);
    if (m !== 'custom') setModel(m);
  };
  const handleOpenaiPreset = (m: string) => {
    setOpenaiPreset(m);
    if (m !== 'custom') setModel(m);
  };
  const handleGeminiPreset = (m: string) => {
    setGeminiPreset(m);
    if (m !== 'custom') setModel(m);
  };

  const applyFetchedCatalog = useCallback((models: string[]) => {
    const normalized = withCustomModelOption(models);
    if (provider === 'anthropic') {
      setAnthropicModelOptions(normalized);
      const currentModel = model.trim();
      if (anthropicPreset === 'custom' && currentModel && normalized.includes(currentModel)) {
        setAnthropicPreset(currentModel);
        return;
      }
      if (anthropicPreset !== 'custom' && !normalized.includes(anthropicPreset)) {
        setAnthropicPreset('custom');
      }
      return;
    }
    if (provider === 'openai') {
      setOpenaiModelOptions(normalized);
      const currentModel = model.trim();
      if (openaiPreset === 'custom' && currentModel && normalized.includes(currentModel)) {
        setOpenaiPreset(currentModel);
        return;
      }
      if (openaiPreset !== 'custom' && !normalized.includes(openaiPreset)) {
        setOpenaiPreset('custom');
      }
      return;
    }
    if (provider === 'gemini') {
      setGeminiModelOptions(normalized);
      const currentModel = model.trim();
      if (geminiPreset === 'custom' && currentModel && normalized.includes(currentModel)) {
        setGeminiPreset(currentModel);
        return;
      }
      if (geminiPreset !== 'custom' && !normalized.includes(geminiPreset)) {
        setGeminiPreset('custom');
      }
      return;
    }
    setOpenCompatModelOptions(normalized);
  }, [anthropicPreset, geminiPreset, model, openaiPreset, provider]);

  const refreshModelCatalog = useCallback(async (manual = false) => {
    if (provider === 'openai' && openaiMode === 'codex') {
      setOpenaiModelOptions(['codex', 'custom']);
      setOpenaiPreset('codex');
      setModel('codex');
      setModelCatalogSource('runtime-fixed');
      setModelCatalogFetchedAt('');
      setModelCatalogMessage("Codex CLI mode uses a fixed model id ('codex').");
      setModelCatalogBusy(false);
      return;
    }

    const cacheKey = modelCatalogCacheKey(provider, openaiMode, anthropicMode, baseUrl);
    const requestId = modelCatalogRequestRef.current + 1;
    modelCatalogRequestRef.current = requestId;
    setModelCatalogBusy(true);
    if (manual) setModelCatalogMessage('Refreshing model catalog...');

    const response = await fetchLlmModels({
      provider,
      anthropic_mode: anthropicMode,
      openai_mode: openaiMode,
      base_url: baseUrl,
      api_key: apiKey,
    });

    if (modelCatalogRequestRef.current !== requestId) return;

    const fallback = fallbackModelsForProvider(provider, openaiMode);
    const fetched = Array.isArray(response.models) ? response.models : [];
    const liveResponse = response.status === 'ok'
      && ((response.catalog_source || response.source) === 'live')
      && fetched.length > 0;
    const source = response.status === 'ok'
      ? ((response.catalog_source || response.source) === 'runtime-fixed'
        ? 'runtime-fixed'
        : (liveResponse ? 'live' : 'fallback'))
      : 'fallback';

    if (liveResponse) {
      applyFetchedCatalog(fetched);
      const fetchedAt = String(response.fetched_at || '').trim();
      setModelCatalogSource('live');
      setModelCatalogFetchedAt(fetchedAt);
      setModelCatalogMessage(
        String(response.message || 'Using live model catalog from provider.'),
      );
      writeCachedModelCatalog(cacheKey, {
        source: 'live',
        models: fetched,
        fetched_at: fetchedAt || new Date().toISOString(),
      });
      setModelCatalogBusy(false);
      return;
    }

    if (source === 'runtime-fixed') {
      applyFetchedCatalog(fetched.length > 0 ? fetched : ['codex', 'custom']);
      setModelCatalogSource('runtime-fixed');
      setModelCatalogFetchedAt(String(response.fetched_at || '').trim());
      setModelCatalogMessage(
        String(response.message || "Codex CLI mode uses a fixed model id ('codex')."),
      );
      setModelCatalogBusy(false);
      return;
    }

    const cachedLive = readCachedModelCatalog(cacheKey);
    if (cachedLive && (response.status !== 'ok' || fetched.length === 0)) {
      applyFetchedCatalog(cachedLive.models);
      setModelCatalogSource('live');
      setModelCatalogFetchedAt(cachedLive.fetched_at);
      setModelCatalogMessage(
        `Live catalog refresh failed. Using cached live model list from ${new Date(cachedLive.fetched_at).toLocaleString()}.`,
      );
      setModelCatalogBusy(false);
      return;
    }

    const nextCatalog = fetched.length > 0 ? fetched : fallback;
    applyFetchedCatalog(nextCatalog);
    setModelCatalogSource(source);
    setModelCatalogFetchedAt(String(response.fetched_at || '').trim());
    setModelCatalogMessage(
      String(response.message || 'Using fallback model catalog.'),
    );
    setModelCatalogBusy(false);
  }, [apiKey, anthropicMode, applyFetchedCatalog, baseUrl, openaiMode, provider]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshModelCatalog(false);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [provider, openaiMode, anthropicMode, baseUrl, refreshModelCatalog]);

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
      : provider === 'anthropic'
        ? (anthropicPreset !== 'custom' ? anthropicPreset : model)
      : provider === 'gemini'
        ? (geminiPreset !== 'custom' ? geminiPreset : model)
      : model;
    const resolvedApiKey = provider === 'openai' && openaiMode === 'codex' ? '' : apiKey;
    const resolvedBaseUrl = provider === 'openai'
      ? 'https://api.openai.com/v1'
      : provider === 'gemini'
        ? 'https://generativelanguage.googleapis.com/v1beta/openai'
        : baseUrl;
    const patch: Partial<AppConfig> = {
      llm: {
        provider,
        anthropic_mode: anthropicMode,
        openai_mode: openaiMode,
        base_url: resolvedBaseUrl,
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

  const localModelPreset = openCompatModelOptions.includes(model.trim()) ? model.trim() : 'custom';

  return (
    <div>
      {/* Provider radio cards */}
      {(['openai', 'anthropic', 'gemini', 'openai_compat'] as LlmConfig['provider'][]).map((p) => {
        const meta: Record<string, { icon: string; title: string; desc: string }> = {
          anthropic:    { icon: 'AN', title: 'Anthropic Cloud', desc: 'Claude Code CLI (recommended) or API key mode.' },
          openai:       { icon: 'OA', title: 'OpenAI',          desc: 'Codex CLI (recommended) or API key mode.' },
          gemini:       { icon: 'GM', title: 'Google Gemini',   desc: 'Gemini API (AI Studio key via OpenAI-compatible endpoint).' },
          openai_compat:{ icon: 'LM', title: 'Local Model',     desc: 'OpenAI-compatible local server (less recommended for orchestration reliability).' },
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
              if (p === 'openai' || p === 'gemini') {
                setApiKey('');
              }
              if (p === 'anthropic') {
                setAnthropicPreset('claude-sonnet-4-0');
                setModel('claude-sonnet-4-0');
              }
              if (p === 'openai') {
                setOpenaiPreset('gpt-5.2');
                setModel('gpt-5.2');
              }
              if (p === 'gemini') {
                setGeminiPreset('gemini-2.5-pro');
                setModel('gemini-2.5-pro');
              }
              if (p === 'openai_compat' && !model.trim()) {
                setModel('gpt-oss-20b');
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
                backgroundColor: selected ? 'color-mix(in srgb, var(--tf-accent-blue) 14%, transparent)' : C.surface,
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

      <div style={{ ...rowStyle, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
        <button
          type="button"
          onClick={() => { void refreshModelCatalog(true); }}
          disabled={modelCatalogBusy}
          style={{
            padding: '6px 10px',
            borderRadius: '7px',
            border: `1px solid ${C.border}`,
            backgroundColor: C.surface,
            color: C.textPrimary,
            fontSize: '12px',
            cursor: modelCatalogBusy ? 'default' : 'pointer',
            opacity: modelCatalogBusy ? 0.7 : 1,
          }}
        >
          {modelCatalogBusy ? 'Refreshing…' : 'Refresh model list'}
        </button>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '3px 8px',
            borderRadius: '999px',
            border: `1px solid ${C.border}`,
            backgroundColor: C.surface,
            color: modelCatalogSource === 'live'
              ? C.success
              : modelCatalogSource === 'runtime-fixed'
                ? C.textSecondary
                : C.warning,
          }}
        >
          {modelCatalogSource}
        </span>
        <span style={{ fontSize: '11px', color: C.textSecondary }}>
          {modelCatalogMessage || 'Model list updates automatically when provider/runtime changes.'}
          {modelCatalogFetchedAt ? ` Last refresh: ${new Date(modelCatalogFetchedAt).toLocaleString()}.` : ''}
        </span>
      </div>

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
                  backgroundColor: anthropicMode === 'cli' ? 'color-mix(in srgb, var(--tf-accent-blue) 20%, transparent)' : C.surface,
                  color: anthropicMode === 'cli' ? C.accent : C.textSecondary,
                }}
              >
                Claude CLI (Recommended)
              </button>
              <button
                onClick={() => setAnthropicMode('apikey')}
                style={{
                  padding: '4px 10px',
                  borderRadius: '5px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  border: `1px solid ${anthropicMode === 'apikey' ? C.accent : C.border}`,
                  backgroundColor: anthropicMode === 'apikey' ? 'color-mix(in srgb, var(--tf-accent-blue) 20%, transparent)' : C.surface,
                  color: anthropicMode === 'apikey' ? C.accent : C.textSecondary,
                }}
              >
                API Key
              </button>
            </div>
          </div>

          <div style={{ marginBottom: anthropicPreset === 'custom' ? '10px' : '6px' }}>
            <label style={labelStyle}>Model</label>
            <div style={{ maxWidth: '360px', marginBottom: anthropicPreset === 'custom' ? '6px' : 0 }}>
              <FloatingSelect
                value={anthropicPreset}
                options={anthropicModelOptions.map((m) => ({ value: m, label: m === 'custom' ? 'Custom model' : m }))}
                onChange={(nextValue) => handleAnthropicPreset(nextValue)}
                ariaLabel="Anthropic model list"
                variant="input"
                size="sm"
              />
            </div>
            {anthropicPreset === 'custom' && (
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-sonnet-4-0"
                style={inputStyle({ maxWidth: '320px' })}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            )}
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
                  backgroundColor: openaiMode === 'codex' ? 'color-mix(in srgb, var(--tf-accent-blue) 20%, transparent)' : C.surface,
                  color: openaiMode === 'codex' ? C.accent : C.textSecondary,
                }}
              >
                Codex CLI (Recommended)
              </button>
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
                  backgroundColor: openaiMode === 'apikey' ? 'color-mix(in srgb, var(--tf-accent-blue) 20%, transparent)' : C.surface,
                  color: openaiMode === 'apikey' ? C.accent : C.textSecondary,
                }}
              >
                API
              </button>
            </div>
          </div>
          {openaiMode === 'apikey' ? (
            <>
              <div style={{ marginBottom: '10px' }}>
                <label style={labelStyle}>Model</label>
                <div style={{ maxWidth: '360px', marginBottom: openaiPreset === 'custom' ? '6px' : 0 }}>
                  <FloatingSelect
                    value={openaiPreset}
                    options={openaiModelOptions.map((m) => ({ value: m, label: m === 'custom' ? 'Custom model' : m }))}
                    onChange={(nextValue) => handleOpenaiPreset(nextValue)}
                    ariaLabel="OpenAI model list"
                    variant="input"
                    size="sm"
                  />
                </div>
                {openaiPreset === 'custom' && (
                  <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
                    placeholder="gpt-5.2" style={inputStyle({ maxWidth: '320px' })}
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

      {/* Gemini fields */}
      {provider === 'gemini' && (
        <div style={{ ...rowStyle, marginTop: '4px' }}>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Model</label>
            <div style={{ maxWidth: '360px', marginBottom: geminiPreset === 'custom' ? '6px' : 0 }}>
              <FloatingSelect
                value={geminiPreset}
                options={geminiModelOptions.map((m) => ({ value: m, label: m === 'custom' ? 'Custom model' : m }))}
                onChange={(nextValue) => handleGeminiPreset(nextValue)}
                ariaLabel="Gemini model list"
                variant="input"
                size="sm"
              />
            </div>
            {geminiPreset === 'custom' && (
              <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
                placeholder="gemini-2.5-pro" style={inputStyle({ maxWidth: '320px' })}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            )}
          </div>
          <div>
            <label style={labelStyle}>Gemini API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIza..."
              style={inputStyle({ maxWidth: '420px' })}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
            <p style={{ marginTop: '6px', fontSize: '11px', color: C.textMuted }}>
              AI Studio key is used with Gemini OpenAI-compatible endpoint.
            </p>
          </div>
        </div>
      )}

      {/* Local model fields */}
      {provider === 'openai_compat' && (
        <div style={{ ...rowStyle, marginTop: '4px' }}>
          <p style={{ margin: '0 0 10px', fontSize: '11px', color: C.textMuted, lineHeight: 1.5 }}>
            Local runtimes are supported, but CLI-backed cloud runtimes are generally more reliable for multi-agent delegation and tool use.
          </p>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Server Preset</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {LOCAL_PRESETS_SETTINGS.map((p) => (
                <button key={p.id} onClick={() => handlePreset(p.id)} style={{
                  padding: '4px 10px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer',
                  border: `1px solid ${localPreset === p.id ? C.accent : C.border}`,
                  backgroundColor: localPreset === p.id ? 'color-mix(in srgb, var(--tf-accent-blue) 20%, transparent)' : C.surface,
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
            <label style={labelStyle}>Model</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '360px' }}>
              <FloatingSelect
                value={localModelPreset}
                options={openCompatModelOptions.map((m) => ({ value: m, label: m === 'custom' ? 'Custom model' : m }))}
                onChange={(nextValue) => {
                  if (nextValue !== 'custom') setModel(nextValue);
                }}
                ariaLabel="Local model list"
                variant="input"
                size="sm"
              />
              {localModelPreset === 'custom' && (
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-oss-20b"
                  style={inputStyle({ maxWidth: '320px' })}
                  onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                />
              )}
            </div>
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
        <div role="alert" style={{ marginTop: '8px' }}>
          <InlineActionCard
            title="Provider settings failed"
            message={saveError}
            severity="error"
            actions={[{ id: 'retry-provider-save', label: 'Retry save', kind: 'retry' } as GuidanceAction]}
            onAction={(action) => {
              if (action.id === 'retry-provider-save') {
                void handleSave();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function SettingsPanel({ onConfigUpdated, initialTab = 'general', focusConnector = null }: SettingsPanelProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Local form state (mirrors config)
  const [userName, setUserName] = useState('');
  const [autoOpen, setAutoOpen] = useState(true);
  const [alwaysOnMode, setAlwaysOnMode] = useState<'guarded_autopilot' | 'manual'>('guarded_autopilot');
  const [runHeartbeatSeconds, setRunHeartbeatSeconds] = useState(5);
  const [runStallWarningSeconds, setRunStallWarningSeconds] = useState(90);
  const [runStallCriticalSeconds, setRunStallCriticalSeconds] = useState(180);
  const [completionCelebrationEnabled, setCompletionCelebrationEnabled] = useState(true);
  const [activityFallbackEnabled, setActivityFallbackEnabled] = useState(true);
  const [activityFallbackMs, setActivityFallbackMs] = useState(15000);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusResponse | null>(null);
  const [updateStatusBusy, setUpdateStatusBusy] = useState(false);
  const [updateApplyBusy, setUpdateApplyBusy] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState('');

  // Display / integrations
  const [compactMode, setCompactMode] = useState(() => localStorage.getItem('tf_compact_mode') === '1');
  const [agentModels, setAgentModels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('tf_agent_models') ?? '{}'); } catch { return {}; }
  });
  const [agentPersonas, setAgentPersonas] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('tf_agent_personas') ?? '{}'); } catch { return {}; }
  });
  const [workspaceMode, setWorkspaceMode] = useState<'local' | 'github' | 'gitlab'>('local');
  const [githubToken, setGithubToken] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubDefaultBranch, setGithubDefaultBranch] = useState('main');
  const [githubAutoPush, setGithubAutoPush] = useState(false);
  const [githubAutoPr, setGithubAutoPr] = useState(false);
  const [gitlabBaseUrl, setGitlabBaseUrl] = useState('https://gitlab.com');
  const [gitlabToken, setGitlabToken] = useState('');
  const [gitlabProjectId, setGitlabProjectId] = useState('');
  const [gitlabDefaultBranch, setGitlabDefaultBranch] = useState('main');
  const [vercelToken, setVercelToken] = useState('');
  const [vercelTeamId, setVercelTeamId] = useState('');
  const [vercelProjectName, setVercelProjectName] = useState('');
  const [netlifyToken, setNetlifyToken] = useState('');
  const [netlifySiteId, setNetlifySiteId] = useState('');
  const [netlifyTeamId, setNetlifyTeamId] = useState('');
  const [stripeSecretKey, setStripeSecretKey] = useState('');
  const [stripePublishableKey, setStripePublishableKey] = useState('');
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState('');
  const [stripePriceBasic, setStripePriceBasic] = useState('');
  const [stripePricePro, setStripePricePro] = useState('');
  const [linearApiKey, setLinearApiKey] = useState('');
  const [linearTeamId, setLinearTeamId] = useState('');
  const [linearIssueTitle, setLinearIssueTitle] = useState('');
  const [linearIssueDescription, setLinearIssueDescription] = useState('');
  const [notionToken, setNotionToken] = useState('');
  const [notionParentPageId, setNotionParentPageId] = useState('');
  const [notionPageTitle, setNotionPageTitle] = useState('');
  const [notionPageMarkdown, setNotionPageMarkdown] = useState('');
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraApiToken, setJiraApiToken] = useState('');
  const [jiraProjectKey, setJiraProjectKey] = useState('');
  const [jiraIssueSummary, setJiraIssueSummary] = useState('');
  const [jiraIssueDescription, setJiraIssueDescription] = useState('');
  const [jiraIssueKeyForTransition, setJiraIssueKeyForTransition] = useState('');
  const [jiraTransitionId, setJiraTransitionId] = useState('');
  const [gitlabBranchName, setGitlabBranchName] = useState('');
  const [gitlabBranchRef, setGitlabBranchRef] = useState('main');
  const [gitlabMrSourceBranch, setGitlabMrSourceBranch] = useState('');
  const [gitlabMrTargetBranch, setGitlabMrTargetBranch] = useState('main');
  const [gitlabMrTitle, setGitlabMrTitle] = useState('');
  const [gitlabMrDescription, setGitlabMrDescription] = useState('');
  const [slackToken, setSlackToken] = useState('');
  const [slackDefaultChannel, setSlackDefaultChannel] = useState('');
  const [slackStatus, setSlackStatus] = useState<ConnectorLifecycleState>('disconnected');
  const [slackVerifiedAt, setSlackVerifiedAt] = useState('');
  const [slackLastSuccessAt, setSlackLastSuccessAt] = useState('');
  const [slackLastError, setSlackLastError] = useState('');
  const [slackConsecutiveFailures, setSlackConsecutiveFailures] = useState(0);
  const [slackRetryBusy, setSlackRetryBusy] = useState(false);
  const [slackRetryStatus, setSlackRetryStatus] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [githubTokenMasked, setGithubTokenMasked] = useState(false);
  const [vercelTokenMasked, setVercelTokenMasked] = useState(false);
  const [netlifyTokenMasked, setNetlifyTokenMasked] = useState(false);
  const [stripeSecretKeyMasked, setStripeSecretKeyMasked] = useState(false);
  const [stripeWebhookSecretMasked, setStripeWebhookSecretMasked] = useState(false);
  const [slackTokenMasked, setSlackTokenMasked] = useState(false);
  const [linearApiKeyMasked, setLinearApiKeyMasked] = useState(false);
  const [notionTokenMasked, setNotionTokenMasked] = useState(false);
  const [jiraApiTokenMasked, setJiraApiTokenMasked] = useState(false);
  const [githubVerified, setGithubVerified] = useState(false);
  const [githubVerifiedAt, setGithubVerifiedAt] = useState('');
  const [githubLastError, setGithubLastError] = useState('');
  const [gitlabTokenMasked, setGitlabTokenMasked] = useState(false);
  const [gitlabVerified, setGitlabVerified] = useState(false);
  const [gitlabVerifiedAt, setGitlabVerifiedAt] = useState('');
  const [gitlabLastError, setGitlabLastError] = useState('');
  const [vercelVerified, setVercelVerified] = useState(false);
  const [vercelVerifiedAt, setVercelVerifiedAt] = useState('');
  const [vercelLastError, setVercelLastError] = useState('');
  const [netlifyVerified, setNetlifyVerified] = useState(false);
  const [netlifyVerifiedAt, setNetlifyVerifiedAt] = useState('');
  const [netlifyLastError, setNetlifyLastError] = useState('');
  const [stripeVerified, setStripeVerified] = useState(false);
  const [stripeVerifiedAt, setStripeVerifiedAt] = useState('');
  const [stripeLastError, setStripeLastError] = useState('');
  const [linearVerified, setLinearVerified] = useState(false);
  const [linearVerifiedAt, setLinearVerifiedAt] = useState('');
  const [linearLastError, setLinearLastError] = useState('');
  const [linearStatus, setLinearStatus] = useState<ConnectorLifecycleState>('disconnected');
  const [linearLastSuccessAt, setLinearLastSuccessAt] = useState('');
  const [linearConsecutiveFailures, setLinearConsecutiveFailures] = useState(0);
  const [notionVerified, setNotionVerified] = useState(false);
  const [notionVerifiedAt, setNotionVerifiedAt] = useState('');
  const [notionLastError, setNotionLastError] = useState('');
  const [notionStatus, setNotionStatus] = useState<ConnectorLifecycleState>('disconnected');
  const [notionLastSuccessAt, setNotionLastSuccessAt] = useState('');
  const [notionConsecutiveFailures, setNotionConsecutiveFailures] = useState(0);
  const [jiraVerified, setJiraVerified] = useState(false);
  const [jiraVerifiedAt, setJiraVerifiedAt] = useState('');
  const [jiraLastError, setJiraLastError] = useState('');
  const [jiraStatus, setJiraStatus] = useState<ConnectorLifecycleState>('disconnected');
  const [jiraLastSuccessAt, setJiraLastSuccessAt] = useState('');
  const [jiraConsecutiveFailures, setJiraConsecutiveFailures] = useState(0);
  const [vercelDefaultTarget, setVercelDefaultTarget] = useState<'preview' | 'production'>('preview');
  const [netlifyDefaultTarget, setNetlifyDefaultTarget] = useState<'preview' | 'production'>('preview');
  const [deployProviderPreference, setDeployProviderPreference] = useState<'vercel' | 'netlify'>('vercel');
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [githubRepoOptions, setGithubRepoOptions] = useState<Array<{ full_name: string; default_branch: string }>>([]);
  const [integrationOpsStatus, setIntegrationOpsStatus] = useState('');
  const [integrationOpsBusy, setIntegrationOpsBusy] = useState(false);
  const [quickVerifyBusy, setQuickVerifyBusy] = useState<'' | QuickConnector>(''); 
  const [verifyAllBusy, setVerifyAllBusy] = useState(false);
  const [vercelDiscoveryBusy, setVercelDiscoveryBusy] = useState(false);
  const [netlifyDiscoveryBusy, setNetlifyDiscoveryBusy] = useState(false);
  const [vercelDiscoveryOptions, setVercelDiscoveryOptions] = useState<DiscoveryOption[]>([]);
  const [netlifyDiscoveryOptions, setNetlifyDiscoveryOptions] = useState<DiscoveryOption[]>([]);
  const [githubInlineStatus, setGithubInlineStatus] = useState('');
  const [gitlabInlineStatus, setGitlabInlineStatus] = useState('');
  const [vercelInlineStatus, setVercelInlineStatus] = useState('');
  const [netlifyInlineStatus, setNetlifyInlineStatus] = useState('');
  const [stripeInlineStatus, setStripeInlineStatus] = useState('');
  const [linearInlineStatus, setLinearInlineStatus] = useState('');
  const [notionInlineStatus, setNotionInlineStatus] = useState('');
  const [jiraInlineStatus, setJiraInlineStatus] = useState('');
  const [showAdvancedIntegrationControls, setShowAdvancedIntegrationControls] = useState(false);
  const [repoPathForOps, setRepoPathForOps] = useState('');
  const [rollbackCommit, setRollbackCommit] = useState('');
  const [vercelDomain, setVercelDomain] = useState('');
  const [vercelEnvKey, setVercelEnvKey] = useState('');
  const [vercelEnvValue, setVercelEnvValue] = useState('');
  const [netlifyDomain, setNetlifyDomain] = useState('');
  const [netlifyEnvKey, setNetlifyEnvKey] = useState('');
  const [netlifyEnvValue, setNetlifyEnvValue] = useState('');
  const [prQualityProfile, setPrQualityProfile] = useState<'strict' | 'balanced' | 'fast'>('balanced');
  const [prProfileStatus, setPrProfileStatus] = useState('');
  const stripeBillingEnabled = config?.feature_flags?.stripe_billing_pack !== false;
  const slackConfigured = slackTokenMasked || Boolean(slackToken.trim());

  const applySlackIntegrationSettings = useCallback((integrationCfg: IntegrationSettings) => {
    if (integrationCfg.slack_token === REDACTED_SECRET) {
      setSlackToken('');
      setSlackTokenMasked(true);
    } else {
      setSlackToken(integrationCfg.slack_token);
      setSlackTokenMasked(false);
    }
    setSlackDefaultChannel(integrationCfg.slack_default_channel || '');
    const configured = integrationCfg.slack_token === REDACTED_SECRET || Boolean((integrationCfg.slack_token || '').trim());
    setSlackStatus(normalizeConnectorStatus(integrationCfg.slack_status, configured));
    setSlackVerifiedAt(integrationCfg.slack_verified_at || '');
    setSlackLastSuccessAt(integrationCfg.slack_last_success_at || '');
    setSlackLastError(integrationCfg.slack_last_error || '');
    setSlackConsecutiveFailures(Math.max(0, Number(integrationCfg.slack_consecutive_failures || 0) || 0));
  }, []);

  const refreshSlackIntegrationState = useCallback(async () => {
    const cfg = await fetchConfig();
    if (!cfg) return false;
    const integrationCfg = integrationsFromConfig(cfg);
    applySlackIntegrationSettings(integrationCfg);
    setConfig(cfg);
    return true;
  }, [applySlackIntegrationSettings]);

  const refreshUpdateStatus = useCallback(async (forceRefresh = false) => {
    setUpdateStatusBusy(true);
    if (forceRefresh) setUpdateFeedback('Checking for updates...');
    const payload = forceRefresh ? await checkForUpdates() : await fetchUpdateStatus();
    if (!payload) {
      setUpdateFeedback('Unable to fetch update status.');
      setUpdateStatusBusy(false);
      return;
    }
    setUpdateStatus(payload);
    if (payload.status !== 'ok') {
      setUpdateFeedback(payload.block_reason || 'Unable to determine update status.');
    } else if (payload.update_available) {
      setUpdateFeedback(`Update available: ${payload.latest_version}`);
    } else {
      setUpdateFeedback(payload.block_reason || 'You are already on the latest release.');
    }
    setUpdateStatusBusy(false);
  }, []);

  const handleApplyUpdate = useCallback(async () => {
    if (!updateStatus?.latest_version || !updateStatus.can_update || updateApplyBusy) return;
    setUpdateApplyBusy(true);
    setUpdateFeedback(`Applying update ${updateStatus.latest_version}...`);
    const payload = await applyManualUpdate(updateStatus.latest_version);
    if (!payload) {
      setUpdateFeedback('Unable to apply update.');
      setUpdateApplyBusy(false);
      return;
    }
    if (payload.status !== 'ok' || !payload.update_applied) {
      setUpdateFeedback(payload.error || payload.block_reason || 'Update was not applied.');
      setUpdateApplyBusy(false);
      await refreshUpdateStatus(false);
      return;
    }
    setUpdateFeedback(`Updated to ${payload.to_version}. Restart COMPaaS to load the new release.`);
    setUpdateApplyBusy(false);
    await refreshUpdateStatus(false);
  }, [refreshUpdateStatus, updateApplyBusy, updateStatus]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    void refreshUpdateStatus(false);
  }, [refreshUpdateStatus]);

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
      await runIntegrationOp('Remote sync', async () => githubSync(repoPathForOps.trim(), githubDefaultBranch || 'main'));
      return;
    }
    if (mode === 'drift') {
      await runIntegrationOp('Drift check', async () => githubDrift(repoPathForOps.trim(), githubDefaultBranch || 'main'));
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
    if (!token && !vercelTokenMasked) {
      setIntegrationOpsStatus('Set Vercel token first.');
      return;
    }
    if (!vercelProjectName.trim()) {
      setIntegrationOpsStatus('Set Vercel project name first.');
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

  const handleNetlifyOp = async (mode: 'preview' | 'production' | 'domain' | 'env') => {
    const token = netlifyTokenMasked ? '' : netlifyToken.trim();
    if (!token && !netlifyTokenMasked) {
      setIntegrationOpsStatus('Set Netlify token first.');
      return;
    }
    if (!netlifySiteId.trim()) {
      setIntegrationOpsStatus('Set Netlify site ID first.');
      return;
    }
    if (mode === 'preview' || mode === 'production') {
      await runIntegrationOp(`Netlify ${mode} deploy`, async () =>
        netlifyDeploy({
          token,
          site_id: netlifySiteId.trim(),
          team_id: netlifyTeamId.trim(),
          target: mode,
        }),
      );
      return;
    }
    if (mode === 'domain') {
      if (!netlifyDomain.trim()) {
        setIntegrationOpsStatus('Set Netlify domain before assigning.');
        return;
      }
      await runIntegrationOp('Netlify domain assignment', async () =>
        netlifyAssignDomain({
          token,
          site_id: netlifySiteId.trim(),
          team_id: netlifyTeamId.trim(),
          domain: netlifyDomain.trim(),
        }),
      );
      return;
    }
    if (!netlifyEnvKey.trim() || !netlifyEnvValue.trim()) {
      setIntegrationOpsStatus('Set Netlify env key and value before sync.');
      return;
    }
    await runIntegrationOp('Netlify env sync', async () =>
      netlifySetEnv({
        token,
        site_id: netlifySiteId.trim(),
        team_id: netlifyTeamId.trim(),
        key: netlifyEnvKey.trim(),
        value: netlifyEnvValue,
        target: ['preview', 'production'],
      }),
    );
  };

  const remediationHint = (connector: QuickConnector, message: string): string => {
    const normalized = message.toLowerCase();
    if (normalized.includes('token')) {
      return `${connector.toUpperCase()}: refresh the token and confirm it has the required scope.`;
    }
    if (normalized.includes('not authorized') || normalized.includes('unauthorized') || normalized.includes('forbidden')) {
      return `${connector.toUpperCase()}: check org/repo/site access for this token and team scope.`;
    }
    if (normalized.includes('network')) {
      return `${connector.toUpperCase()}: retry after connectivity stabilizes.`;
    }
    return `${connector.toUpperCase()}: review connector fields and retry verification.`;
  };

  const handleDiscoverVercelProjects = async () => {
    if (vercelDiscoveryBusy || quickVerifyBusy.length > 0 || verifyAllBusy) return;
    const tokenForList = vercelTokenMasked ? undefined : vercelToken.trim();
    if (!tokenForList && !vercelTokenMasked) {
      setVercelInlineStatus('Token is required to list projects.');
      setIntegrationOpsStatus('Vercel discovery requires a token.');
      return;
    }
    setVercelDiscoveryBusy(true);
    setVercelInlineStatus('Loading projects...');
    setIntegrationOpsStatus('Loading Vercel projects...');
    const result = await vercelListProjects({
      token: tokenForList,
      team_id: vercelTeamId.trim() || undefined,
    });
    if (!result || result.status !== 'ok') {
      setVercelInlineStatus('Unable to load projects. Check token/team scope and retry.');
      setIntegrationOpsStatus('Vercel project discovery failed.');
      setVercelDiscoveryBusy(false);
      return;
    }
    const options: DiscoveryOption[] = (Array.isArray(result.projects) ? result.projects : [])
      .map((project) => {
        const name = String(project?.name || '').trim();
        if (!name) return null;
        const framework = String(project?.framework || '').trim();
        return {
          value: name,
          label: framework ? `${name} (${framework})` : name,
        };
      })
      .filter((option): option is DiscoveryOption => Boolean(option));
    setVercelDiscoveryOptions(options);
    if (!vercelProjectName.trim() && options.length > 0) {
      setVercelProjectName(options[0].value);
    }
    setVercelInlineStatus(options.length > 0 ? `Loaded ${options.length} project${options.length === 1 ? '' : 's'}.` : 'No projects found for this token/team.');
    setIntegrationOpsStatus(options.length > 0 ? 'Vercel projects loaded. Select one, then verify.' : 'No Vercel projects found for this token/team.');
    setVercelDiscoveryBusy(false);
  };

  const handleDiscoverNetlifySites = async () => {
    if (netlifyDiscoveryBusy || quickVerifyBusy.length > 0 || verifyAllBusy) return;
    const tokenForList = netlifyTokenMasked ? undefined : netlifyToken.trim();
    if (!tokenForList && !netlifyTokenMasked) {
      setNetlifyInlineStatus('Token is required to list sites.');
      setIntegrationOpsStatus('Netlify discovery requires a token.');
      return;
    }
    setNetlifyDiscoveryBusy(true);
    setNetlifyInlineStatus('Loading sites...');
    setIntegrationOpsStatus('Loading Netlify sites...');
    const result = await netlifyListSites({
      token: tokenForList,
      team_id: netlifyTeamId.trim() || undefined,
    });
    if (!result || result.status !== 'ok') {
      setNetlifyInlineStatus('Unable to load sites. Check token/team scope and retry.');
      setIntegrationOpsStatus('Netlify site discovery failed.');
      setNetlifyDiscoveryBusy(false);
      return;
    }
    const options: DiscoveryOption[] = (Array.isArray(result.sites) ? result.sites : [])
      .map((site) => {
        const siteId = String(site?.id || '').trim();
        if (!siteId) return null;
        const name = String(site?.name || '').trim();
        const url = String(site?.url || '').trim();
        const labelPrefix = name || siteId;
        return {
          value: siteId,
          label: url ? `${labelPrefix} (${url})` : labelPrefix,
        };
      })
      .filter((option): option is DiscoveryOption => Boolean(option));
    setNetlifyDiscoveryOptions(options);
    if (!netlifySiteId.trim() && options.length > 0) {
      setNetlifySiteId(options[0].value);
    }
    setNetlifyInlineStatus(options.length > 0 ? `Loaded ${options.length} site${options.length === 1 ? '' : 's'}.` : 'No sites found for this token/team.');
    setIntegrationOpsStatus(options.length > 0 ? 'Netlify sites loaded. Select one, then verify.' : 'No Netlify sites found for this token/team.');
    setNetlifyDiscoveryBusy(false);
  };

  const handleQuickVerifyGithub = async (): Promise<VerifyOutcome> => {
    const repo = githubRepo.trim();
    const tokenForVerify = githubTokenMasked ? undefined : githubToken.trim();
    setGithubInlineStatus('');
    if (!repo) {
      const message = 'Repository is required (owner/repo).';
      setGithubInlineStatus(message);
      setIntegrationOpsStatus('GitHub verification requires a repository in owner/repo format.');
      return { ok: false, message };
    }
    if (!tokenForVerify && !githubTokenMasked) {
      const message = 'Token is required for verification.';
      setGithubInlineStatus(message);
      setIntegrationOpsStatus('GitHub verification requires a token.');
      return { ok: false, message };
    }
    setQuickVerifyBusy('github');
    setGithubInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving GitHub connector settings...');
    const saved = await saveIntegrationsResult({
      workspace_mode: workspaceMode,
      github_token: githubTokenMasked ? REDACTED_SECRET : githubToken.trim(),
      github_repo: repo,
      github_default_branch: githubDefaultBranch.trim() || 'main',
      github_auto_push: githubAutoPush,
      github_auto_pr: githubAutoPr,
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setGithubVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setGithubInlineStatus(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }

    setGithubInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying GitHub connector...');
    const result = await githubVerifyIntegration({ token: tokenForVerify, repo });
    if (!result) {
      setQuickVerifyBusy('');
      setGithubVerified(false);
      setGithubLastError('Network error during GitHub verification.');
      setGithubInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('GitHub verification failed due to a network error.');
      return { ok: false, message: 'Network error during GitHub verification.' };
    }

    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'GitHub connector verified.' : 'GitHub verification failed.');
    setGithubVerified(verified);
    setGithubVerifiedAt(verifiedAt);
    setGithubLastError(verified ? '' : message);
    setGithubInlineStatus(message);
    setIntegrationOpsStatus(message);
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleQuickVerifyGitlab = async (): Promise<VerifyOutcome> => {
    const projectId = gitlabProjectId.trim();
    const tokenForVerify = gitlabTokenMasked ? undefined : gitlabToken.trim();
    const resolvedBaseUrl = gitlabBaseUrl.trim() || 'https://gitlab.com';
    setGitlabInlineStatus('');
    if (!projectId) {
      const message = 'Project ID is required.';
      setGitlabInlineStatus(message);
      setIntegrationOpsStatus('GitLab verification requires a project ID.');
      setGitlabLastError(message);
      return { ok: false, message };
    }
    if (!tokenForVerify && !gitlabTokenMasked) {
      const message = 'Token is required for verification.';
      setGitlabInlineStatus(message);
      setIntegrationOpsStatus('GitLab verification requires a token.');
      setGitlabLastError(message);
      return { ok: false, message };
    }
    setQuickVerifyBusy('gitlab');
    setGitlabInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving GitLab connector settings...');
    const saved = await saveIntegrationsResult({
      workspace_mode: workspaceMode,
      gitlab_base_url: resolvedBaseUrl,
      gitlab_token: gitlabTokenMasked ? REDACTED_SECRET : gitlabToken.trim(),
      gitlab_project_id: projectId,
      gitlab_default_branch: gitlabDefaultBranch.trim() || 'main',
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setGitlabVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setGitlabInlineStatus(detail);
      setGitlabLastError(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }

    setGitlabInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying GitLab connector...');
    const result = await gitlabVerifyIntegration({
      base_url: resolvedBaseUrl,
      token: tokenForVerify,
      project_id: projectId,
    });
    if (!result) {
      setQuickVerifyBusy('');
      setGitlabVerified(false);
      setGitlabLastError('Network error during GitLab verification.');
      setGitlabInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('GitLab verification failed due to a network error.');
      return { ok: false, message: 'Network error during GitLab verification.' };
    }

    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'GitLab connector verified.' : 'GitLab verification failed.');
    setGitlabVerified(verified);
    setGitlabVerifiedAt(verifiedAt);
    setGitlabLastError(verified ? '' : message);
    setGitlabInlineStatus(message);
    setIntegrationOpsStatus(message);
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleQuickVerifyVercel = async (): Promise<VerifyOutcome> => {
    const projectName = vercelProjectName.trim();
    const tokenForVerify = vercelTokenMasked ? undefined : vercelToken.trim();
    setVercelInlineStatus('');
    if (!projectName) {
      const message = 'Project name is required.';
      setVercelInlineStatus(message);
      setIntegrationOpsStatus('Vercel verification requires a project name.');
      return { ok: false, message };
    }
    if (!tokenForVerify && !vercelTokenMasked) {
      const message = 'Token is required for verification.';
      setVercelInlineStatus(message);
      setIntegrationOpsStatus('Vercel verification requires a token.');
      return { ok: false, message };
    }
    setQuickVerifyBusy('vercel');
    setVercelInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving Vercel connector settings...');
    const saved = await saveIntegrationsResult({
      vercel_token: vercelTokenMasked ? REDACTED_SECRET : vercelToken.trim(),
      vercel_team_id: vercelTeamId.trim(),
      vercel_project_name: projectName,
      vercel_default_target: vercelDefaultTarget,
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setVercelVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setVercelInlineStatus(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }

    setVercelInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying Vercel connector...');
    const result = await vercelVerifyIntegration({
      token: tokenForVerify,
      project_name: projectName,
      team_id: vercelTeamId.trim(),
    });
    if (!result) {
      setQuickVerifyBusy('');
      setVercelVerified(false);
      setVercelLastError('Network error during Vercel verification.');
      setVercelInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('Vercel verification failed due to a network error.');
      return { ok: false, message: 'Network error during Vercel verification.' };
    }

    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'Vercel connector verified.' : 'Vercel verification failed.');
    setVercelVerified(verified);
    setVercelVerifiedAt(verifiedAt);
    setVercelLastError(verified ? '' : message);
    setVercelInlineStatus(message);
    setIntegrationOpsStatus(message);
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleQuickVerifyNetlify = async (): Promise<VerifyOutcome> => {
    const siteId = netlifySiteId.trim();
    const tokenForVerify = netlifyTokenMasked ? undefined : netlifyToken.trim();
    setNetlifyInlineStatus('');
    if (!siteId) {
      const message = 'Site ID is required.';
      setNetlifyInlineStatus(message);
      setIntegrationOpsStatus('Netlify verification requires a site ID.');
      return { ok: false, message };
    }
    if (!tokenForVerify && !netlifyTokenMasked) {
      const message = 'Token is required for verification.';
      setNetlifyInlineStatus(message);
      setIntegrationOpsStatus('Netlify verification requires a token.');
      return { ok: false, message };
    }
    setQuickVerifyBusy('netlify');
    setNetlifyInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving Netlify connector settings...');
    const saved = await saveIntegrationsResult({
      netlify_token: netlifyTokenMasked ? REDACTED_SECRET : netlifyToken.trim(),
      netlify_site_id: siteId,
      netlify_team_id: netlifyTeamId.trim(),
      netlify_default_target: netlifyDefaultTarget,
      deploy_provider_preference: deployProviderPreference,
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setNetlifyVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setNetlifyInlineStatus(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }
    setNetlifyInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying Netlify connector...');
    const result = await netlifyVerifyIntegration({
      token: tokenForVerify,
      site_id: siteId,
      team_id: netlifyTeamId.trim(),
    });
    if (!result) {
      setQuickVerifyBusy('');
      setNetlifyVerified(false);
      setNetlifyLastError('Network error during Netlify verification.');
      setNetlifyInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('Netlify verification failed due to a network error.');
      return { ok: false, message: 'Network error during Netlify verification.' };
    }
    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'Netlify connector verified.' : 'Netlify verification failed.');
    setNetlifyVerified(verified);
    setNetlifyVerifiedAt(verifiedAt);
    setNetlifyLastError(verified ? '' : message);
    setNetlifyInlineStatus(message);
    setIntegrationOpsStatus(message);
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleQuickVerifyStripe = async (): Promise<VerifyOutcome> => {
    const secretForVerify = stripeSecretKeyMasked ? undefined : stripeSecretKey.trim();
    setStripeInlineStatus('');
    if (!secretForVerify && !stripeSecretKeyMasked) {
      const message = 'Secret key is required for verification.';
      setStripeInlineStatus(message);
      setIntegrationOpsStatus('Stripe verification requires a secret key.');
      return { ok: false, message };
    }
    setQuickVerifyBusy('stripe');
    setStripeInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving Stripe connector settings...');
    const saved = await saveIntegrationsResult({
      stripe_secret_key: stripeSecretKeyMasked ? REDACTED_SECRET : stripeSecretKey.trim(),
      stripe_publishable_key: stripePublishableKey.trim(),
      stripe_webhook_secret: stripeWebhookSecretMasked ? REDACTED_SECRET : stripeWebhookSecret.trim(),
      stripe_price_basic: stripePriceBasic.trim(),
      stripe_price_pro: stripePricePro.trim(),
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setStripeVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setStripeInlineStatus(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }
    setStripeInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying Stripe connector...');
    const result = await stripeVerifyIntegration({ secret_key: secretForVerify });
    if (!result) {
      setQuickVerifyBusy('');
      setStripeVerified(false);
      setStripeLastError('Network error during Stripe verification.');
      setStripeInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('Stripe verification failed due to a network error.');
      return { ok: false, message: 'Network error during Stripe verification.' };
    }
    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'Stripe connector verified.' : 'Stripe verification failed.');
    setStripeVerified(verified);
    setStripeVerifiedAt(verifiedAt);
    setStripeLastError(verified ? '' : message);
    setStripeInlineStatus(message);
    setIntegrationOpsStatus(message);
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleQuickVerifyLinear = async (): Promise<VerifyOutcome> => {
    const keyForVerify = linearApiKeyMasked ? undefined : linearApiKey.trim();
    const teamId = linearTeamId.trim();
    setLinearInlineStatus('');
    if (!keyForVerify && !linearApiKeyMasked) {
      const message = 'API key is required for verification.';
      setLinearInlineStatus(message);
      setIntegrationOpsStatus('Linear verification requires an API key.');
      return { ok: false, message };
    }
    setQuickVerifyBusy('linear');
    setLinearInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving Linear connector settings...');
    const saved = await saveIntegrationsResult({
      linear_api_key: linearApiKeyMasked ? REDACTED_SECRET : linearApiKey.trim(),
      linear_team_id: teamId,
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setLinearVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setLinearInlineStatus(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }
    setLinearInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying Linear connector...');
    const result = await linearVerifyIntegration({ api_key: keyForVerify });
    if (!result) {
      setQuickVerifyBusy('');
      setLinearVerified(false);
      setLinearLastError('Network error during Linear verification.');
      setLinearInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('Linear verification failed due to a network error.');
      return { ok: false, message: 'Network error during Linear verification.' };
    }
    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'Linear connector verified.' : 'Linear verification failed.');
    setLinearVerified(verified);
    setLinearVerifiedAt(verifiedAt);
    setLinearLastError(verified ? '' : message);
    setLinearStatus(verified ? 'verified' : 'degraded');
    setLinearInlineStatus(message);
    setIntegrationOpsStatus(message);
    const refreshed = await fetchConfig().catch(() => null);
    if (refreshed) {
      const integrationCfg = integrationsFromConfig(refreshed);
      setLinearLastSuccessAt(integrationCfg.linear_last_success_at || '');
      setLinearConsecutiveFailures(Math.max(0, Number(integrationCfg.linear_consecutive_failures || 0) || 0));
      setLinearStatus(normalizeConnectorStatus(
        integrationCfg.linear_status,
        Boolean(integrationCfg.linear_api_key) || integrationCfg.linear_api_key === REDACTED_SECRET,
      ));
    }
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleQuickVerifyNotion = async (): Promise<VerifyOutcome> => {
    const tokenForVerify = notionTokenMasked ? undefined : notionToken.trim();
    setNotionInlineStatus('');
    if (!tokenForVerify && !notionTokenMasked) {
      const message = 'Token is required for verification.';
      setNotionInlineStatus(message);
      setIntegrationOpsStatus('Notion verification requires an integration token.');
      return { ok: false, message };
    }
    setQuickVerifyBusy('notion');
    setNotionInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving Notion connector settings...');
    const saved = await saveIntegrationsResult({
      notion_token: notionTokenMasked ? REDACTED_SECRET : notionToken.trim(),
      notion_parent_page_id: notionParentPageId.trim(),
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setNotionVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setNotionInlineStatus(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }
    setNotionInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying Notion connector...');
    const result = await notionVerifyIntegration({ token: tokenForVerify });
    if (!result) {
      setQuickVerifyBusy('');
      setNotionVerified(false);
      setNotionLastError('Network error during Notion verification.');
      setNotionInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('Notion verification failed due to a network error.');
      return { ok: false, message: 'Network error during Notion verification.' };
    }
    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'Notion connector verified.' : 'Notion verification failed.');
    setNotionVerified(verified);
    setNotionVerifiedAt(verifiedAt);
    setNotionLastError(verified ? '' : message);
    setNotionStatus(verified ? 'verified' : 'degraded');
    setNotionInlineStatus(message);
    setIntegrationOpsStatus(message);
    const refreshed = await fetchConfig().catch(() => null);
    if (refreshed) {
      const integrationCfg = integrationsFromConfig(refreshed);
      setNotionLastSuccessAt(integrationCfg.notion_last_success_at || '');
      setNotionConsecutiveFailures(Math.max(0, Number(integrationCfg.notion_consecutive_failures || 0) || 0));
      setNotionStatus(normalizeConnectorStatus(
        integrationCfg.notion_status,
        Boolean(integrationCfg.notion_token) || integrationCfg.notion_token === REDACTED_SECRET,
      ));
    }
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleQuickVerifyJira = async (): Promise<VerifyOutcome> => {
    const baseUrl = jiraBaseUrl.trim();
    const email = jiraEmail.trim();
    const tokenForVerify = jiraApiTokenMasked ? undefined : jiraApiToken.trim();
    setJiraInlineStatus('');
    if (!baseUrl || !email) {
      const message = 'Base URL and email are required.';
      setJiraInlineStatus(message);
      setIntegrationOpsStatus('Jira verification requires base URL and email.');
      return { ok: false, message };
    }
    if (!tokenForVerify && !jiraApiTokenMasked) {
      const message = 'API token is required for verification.';
      setJiraInlineStatus(message);
      setIntegrationOpsStatus('Jira verification requires an API token.');
      return { ok: false, message };
    }
    setQuickVerifyBusy('jira');
    setJiraInlineStatus('Saving connector settings...');
    setIntegrationOpsStatus('Saving Jira connector settings...');
    const saved = await saveIntegrationsResult({
      jira_base_url: baseUrl,
      jira_email: email,
      jira_api_token: jiraApiTokenMasked ? REDACTED_SECRET : jiraApiToken.trim(),
      jira_project_key: jiraProjectKey.trim(),
    });
    if (!saved.ok) {
      setQuickVerifyBusy('');
      setJiraVerified(false);
      const detail = saved.detail || 'Failed to save settings before verification.';
      setJiraInlineStatus(detail);
      setIntegrationOpsStatus(detail);
      return { ok: false, message: detail };
    }
    setJiraInlineStatus('Verifying connector...');
    setIntegrationOpsStatus('Verifying Jira connector...');
    const result = await jiraVerifyIntegration({
      base_url: baseUrl,
      email,
      api_token: tokenForVerify || '',
    });
    if (!result) {
      setQuickVerifyBusy('');
      setJiraVerified(false);
      setJiraLastError('Network error during Jira verification.');
      setJiraInlineStatus('Verification failed due to a network error.');
      setIntegrationOpsStatus('Jira verification failed due to a network error.');
      return { ok: false, message: 'Network error during Jira verification.' };
    }
    const verified = Boolean(result.ok);
    const verifiedAt = verified ? new Date().toISOString() : '';
    const message = result.message || (verified ? 'Jira connector verified.' : 'Jira verification failed.');
    setJiraVerified(verified);
    setJiraVerifiedAt(verifiedAt);
    setJiraLastError(verified ? '' : message);
    setJiraStatus(verified ? 'verified' : 'degraded');
    setJiraInlineStatus(message);
    setIntegrationOpsStatus(message);
    const refreshed = await fetchConfig().catch(() => null);
    if (refreshed) {
      const integrationCfg = integrationsFromConfig(refreshed);
      setJiraLastSuccessAt(integrationCfg.jira_last_success_at || '');
      setJiraConsecutiveFailures(Math.max(0, Number(integrationCfg.jira_consecutive_failures || 0) || 0));
      setJiraStatus(normalizeConnectorStatus(
        integrationCfg.jira_status,
        Boolean(integrationCfg.jira_base_url && integrationCfg.jira_email && integrationCfg.jira_api_token),
      ));
    }
    setQuickVerifyBusy('');
    return { ok: verified, message };
  };

  const handleLinearIssueCreate = async () => {
    const teamId = linearTeamId.trim();
    const title = linearIssueTitle.trim();
    if (!teamId || !title) {
      setIntegrationOpsStatus('Set Linear team ID and issue title before creating an issue.');
      return;
    }
    const apiKey = linearApiKeyMasked ? undefined : linearApiKey.trim();
    await runIntegrationOp('Linear issue create', async () =>
      linearCreateIssue({
        api_key: apiKey,
        team_id: teamId,
        title,
        description: linearIssueDescription.trim(),
      }),
    );
    if (linearApiKeyMasked || apiKey) {
      const refreshed = await fetchConfig().catch(() => null);
      if (refreshed) {
        const integrationCfg = integrationsFromConfig(refreshed);
        setLinearStatus(normalizeConnectorStatus(integrationCfg.linear_status, Boolean(integrationCfg.linear_api_key) || integrationCfg.linear_api_key === REDACTED_SECRET));
        setLinearLastSuccessAt(integrationCfg.linear_last_success_at || '');
        setLinearConsecutiveFailures(Math.max(0, Number(integrationCfg.linear_consecutive_failures || 0) || 0));
      }
    }
  };

  const handleNotionPageUpsert = async () => {
    const title = notionPageTitle.trim();
    if (!title) {
      setIntegrationOpsStatus('Set a Notion page title before publishing.');
      return;
    }
    const token = notionTokenMasked ? undefined : notionToken.trim();
    await runIntegrationOp('Notion page publish', async () =>
      notionUpsertPage({
        token,
        parent_page_id: notionParentPageId.trim(),
        title,
        markdown: notionPageMarkdown.trim(),
      }),
    );
    if (notionTokenMasked || token) {
      const refreshed = await fetchConfig().catch(() => null);
      if (refreshed) {
        const integrationCfg = integrationsFromConfig(refreshed);
        setNotionStatus(normalizeConnectorStatus(integrationCfg.notion_status, Boolean(integrationCfg.notion_token) || integrationCfg.notion_token === REDACTED_SECRET));
        setNotionLastSuccessAt(integrationCfg.notion_last_success_at || '');
        setNotionConsecutiveFailures(Math.max(0, Number(integrationCfg.notion_consecutive_failures || 0) || 0));
      }
    }
  };

  const handleJiraIssueCreate = async () => {
    const baseUrl = jiraBaseUrl.trim();
    const email = jiraEmail.trim();
    const apiToken = jiraApiTokenMasked ? '' : jiraApiToken.trim();
    const projectKey = jiraProjectKey.trim();
    const summary = jiraIssueSummary.trim();
    if (!baseUrl || !email || (!apiToken && !jiraApiTokenMasked) || !projectKey || !summary) {
      setIntegrationOpsStatus('Set Jira base URL, email, token, project key, and summary before creating an issue.');
      return;
    }
    await runIntegrationOp('Jira issue create', async () =>
      jiraCreateIssue({
        base_url: baseUrl,
        email,
        api_token: apiToken,
        project_key: projectKey,
        summary,
        description: jiraIssueDescription.trim(),
      }),
    );
    const refreshed = await fetchConfig().catch(() => null);
    if (refreshed) {
      const integrationCfg = integrationsFromConfig(refreshed);
      setJiraStatus(normalizeConnectorStatus(integrationCfg.jira_status, Boolean(integrationCfg.jira_base_url && integrationCfg.jira_email && integrationCfg.jira_api_token)));
      setJiraLastSuccessAt(integrationCfg.jira_last_success_at || '');
      setJiraConsecutiveFailures(Math.max(0, Number(integrationCfg.jira_consecutive_failures || 0) || 0));
    }
  };

  const handleJiraTransition = async () => {
    const baseUrl = jiraBaseUrl.trim();
    const email = jiraEmail.trim();
    const apiToken = jiraApiTokenMasked ? '' : jiraApiToken.trim();
    const issueKey = jiraIssueKeyForTransition.trim();
    const transitionId = jiraTransitionId.trim();
    if (!baseUrl || !email || (!apiToken && !jiraApiTokenMasked) || !issueKey || !transitionId) {
      setIntegrationOpsStatus('Set Jira base URL, email, token, issue key, and transition ID before transitioning.');
      return;
    }
    await runIntegrationOp('Jira transition', async () =>
      jiraTransitionIssue({
        base_url: baseUrl,
        email,
        api_token: apiToken,
        issue_key: issueKey,
        transition_id: transitionId,
      }),
    );
  };

  const handleGitlabBranchCreate = async () => {
    const token = gitlabTokenMasked ? '' : gitlabToken.trim();
    const projectId = gitlabProjectId.trim();
    const branch = gitlabBranchName.trim();
    if ((!token && !gitlabTokenMasked) || !projectId || !branch) {
      setIntegrationOpsStatus('Set GitLab token, project ID, and branch name before creating a branch.');
      return;
    }
    await runIntegrationOp('GitLab branch create', async () =>
      gitlabCreateBranch({
        base_url: gitlabBaseUrl.trim() || 'https://gitlab.com',
        token,
        project_id: projectId,
        branch,
        ref: gitlabBranchRef.trim() || gitlabDefaultBranch.trim() || 'main',
      }),
    );
  };

  const handleGitlabMergeRequestCreate = async () => {
    const token = gitlabTokenMasked ? '' : gitlabToken.trim();
    const projectId = gitlabProjectId.trim();
    const sourceBranch = gitlabMrSourceBranch.trim();
    const targetBranch = gitlabMrTargetBranch.trim() || gitlabDefaultBranch.trim() || 'main';
    const title = gitlabMrTitle.trim();
    if ((!token && !gitlabTokenMasked) || !projectId || !sourceBranch || !targetBranch || !title) {
      setIntegrationOpsStatus('Set GitLab token, project ID, source/target branches, and MR title before creating an MR.');
      return;
    }
    await runIntegrationOp('GitLab merge request create', async () =>
      gitlabCreateMergeRequest({
        base_url: gitlabBaseUrl.trim() || 'https://gitlab.com',
        token,
        project_id: projectId,
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description: gitlabMrDescription.trim(),
      }),
    );
  };

  const handleConnectAndVerifyAll = async () => {
    if (verifyAllBusy || quickVerifyBusy.length > 0) return;
    setVerifyAllBusy(true);
    setIntegrationOpsStatus('Running Connect & Verify All...');

    const results: string[] = [];
    const remediations: string[] = [];

    const githubConfigured = Boolean(githubRepo.trim()) && (githubTokenMasked || Boolean(githubToken.trim()));
    if (githubConfigured) {
      const outcome = await handleQuickVerifyGithub();
      results.push(`GitHub ${outcome.ok ? 'verified' : 'failed'}`);
      if (!outcome.ok) remediations.push(remediationHint('github', outcome.message));
    } else {
      remediations.push('GITHUB: add repository and token (or keep saved token) before running verify-all.');
    }

    const gitlabConfigured = Boolean(gitlabProjectId.trim()) && (gitlabTokenMasked || Boolean(gitlabToken.trim()));
    if (gitlabConfigured) {
      const outcome = await handleQuickVerifyGitlab();
      results.push(`GitLab ${outcome.ok ? 'verified' : 'failed'}`);
      if (!outcome.ok) remediations.push(remediationHint('gitlab', outcome.message));
    } else if (workspaceMode === 'gitlab') {
      remediations.push('GITLAB: add base URL, project ID, and token (or keep saved token) before running verify-all.');
    }

    const vercelConfigured = Boolean(vercelProjectName.trim()) && (vercelTokenMasked || Boolean(vercelToken.trim()));
    const netlifyConfigured = Boolean(netlifySiteId.trim()) && (netlifyTokenMasked || Boolean(netlifyToken.trim()));
    const deploymentOrder: QuickConnector[] = deployProviderPreference === 'netlify'
      ? ['netlify', 'vercel']
      : ['vercel', 'netlify'];

    for (const connector of deploymentOrder) {
      if (connector === 'vercel' && vercelConfigured) {
        const outcome = await handleQuickVerifyVercel();
        results.push(`Vercel ${outcome.ok ? 'verified' : 'failed'}`);
        if (!outcome.ok) remediations.push(remediationHint('vercel', outcome.message));
      }
      if (connector === 'netlify' && netlifyConfigured) {
        const outcome = await handleQuickVerifyNetlify();
        results.push(`Netlify ${outcome.ok ? 'verified' : 'failed'}`);
        if (!outcome.ok) remediations.push(remediationHint('netlify', outcome.message));
      }
    }

    if (!vercelConfigured && !netlifyConfigured) {
      remediations.push('DEPLOYMENT: discover/select a Vercel project or Netlify site, then run verify-all again.');
    }

    const stripeConfigured = stripeSecretKeyMasked || Boolean(stripeSecretKey.trim());
    if (stripeBillingEnabled && stripeConfigured) {
      const outcome = await handleQuickVerifyStripe();
      results.push(`Stripe ${outcome.ok ? 'verified' : 'failed'}`);
      if (!outcome.ok) remediations.push(remediationHint('stripe', outcome.message));
    }

    const linearConfigured = linearApiKeyMasked || Boolean(linearApiKey.trim());
    if (linearConfigured) {
      const outcome = await handleQuickVerifyLinear();
      results.push(`Linear ${outcome.ok ? 'verified' : 'failed'}`);
      if (!outcome.ok) remediations.push(remediationHint('linear', outcome.message));
    }

    const notionConfigured = notionTokenMasked || Boolean(notionToken.trim());
    if (notionConfigured) {
      const outcome = await handleQuickVerifyNotion();
      results.push(`Notion ${outcome.ok ? 'verified' : 'failed'}`);
      if (!outcome.ok) remediations.push(remediationHint('notion', outcome.message));
    }

    const jiraConfigured = Boolean(jiraBaseUrl.trim() && jiraEmail.trim()) && (jiraApiTokenMasked || Boolean(jiraApiToken.trim()));
    if (jiraConfigured) {
      const outcome = await handleQuickVerifyJira();
      results.push(`Jira ${outcome.ok ? 'verified' : 'failed'}`);
      if (!outcome.ok) remediations.push(remediationHint('jira', outcome.message));
    }

    const summary = [
      results.length > 0 ? `Verification summary: ${results.join(' | ')}.` : 'No connectors were eligible for verification.',
      remediations.length > 0 ? `Next steps: ${remediations.slice(0, 3).join(' ')}` : 'All eligible connectors verified successfully.',
    ].join(' ');
    setIntegrationOpsStatus(summary.trim());
    setVerifyAllBusy(false);
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
        setAutoOpen(cfg.server?.auto_open_browser ?? true);
        setAlwaysOnMode(cfg.ui?.always_on_mode === 'manual' ? 'manual' : 'guarded_autopilot');
        setRunHeartbeatSeconds(Math.max(1, Number(cfg.ui?.run_heartbeat_seconds ?? 5) || 5));
        setRunStallWarningSeconds(Math.max(30, Number(cfg.ui?.run_stall_warning_seconds ?? 90) || 90));
        setRunStallCriticalSeconds(Math.max(30, Number(cfg.ui?.run_stall_critical_seconds ?? 180) || 180));
        setCompletionCelebrationEnabled(cfg.ui?.completion_celebration_enabled !== false);
        setActivityFallbackEnabled(cfg.ui?.activity_stream_fallback_enabled !== false);
        setActivityFallbackMs(Math.max(5000, Number(cfg.ui?.activity_stream_fallback_ms ?? 15000) || 15000));
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
        setGithubDefaultBranch(integrationCfg.github_default_branch || 'main');
        setGithubAutoPush(Boolean(integrationCfg.github_auto_push));
        setGithubAutoPr(Boolean(integrationCfg.github_auto_pr));
        setGithubVerified(Boolean(integrationCfg.github_verified));
        setGithubVerifiedAt(integrationCfg.github_verified_at || '');
        setGithubLastError(integrationCfg.github_last_error || '');
        setGitlabBaseUrl(integrationCfg.gitlab_base_url || 'https://gitlab.com');
        if (integrationCfg.gitlab_token === REDACTED_SECRET) {
          setGitlabToken('');
          setGitlabTokenMasked(true);
        } else {
          setGitlabToken(integrationCfg.gitlab_token);
          setGitlabTokenMasked(false);
        }
        setGitlabProjectId(integrationCfg.gitlab_project_id);
        setGitlabDefaultBranch(integrationCfg.gitlab_default_branch || 'main');
        setGitlabVerified(Boolean(integrationCfg.gitlab_verified));
        setGitlabVerifiedAt(integrationCfg.gitlab_verified_at || '');
        setGitlabLastError(integrationCfg.gitlab_last_error || '');
        if (integrationCfg.vercel_token === REDACTED_SECRET) {
          setVercelToken('');
          setVercelTokenMasked(true);
        } else {
          setVercelToken(integrationCfg.vercel_token);
          setVercelTokenMasked(false);
        }
        setVercelTeamId(integrationCfg.vercel_team_id);
        setVercelProjectName(integrationCfg.vercel_project_name);
        setVercelDefaultTarget(integrationCfg.vercel_default_target === 'production' ? 'production' : 'preview');
        setVercelVerified(Boolean(integrationCfg.vercel_verified));
        setVercelVerifiedAt(integrationCfg.vercel_verified_at || '');
        setVercelLastError(integrationCfg.vercel_last_error || '');
        if (integrationCfg.netlify_token === REDACTED_SECRET) {
          setNetlifyToken('');
          setNetlifyTokenMasked(true);
        } else {
          setNetlifyToken(integrationCfg.netlify_token);
          setNetlifyTokenMasked(false);
        }
        setNetlifySiteId(integrationCfg.netlify_site_id);
        setNetlifyTeamId(integrationCfg.netlify_team_id);
        setNetlifyDefaultTarget(integrationCfg.netlify_default_target === 'production' ? 'production' : 'preview');
        setNetlifyVerified(Boolean(integrationCfg.netlify_verified));
        setNetlifyVerifiedAt(integrationCfg.netlify_verified_at || '');
        setNetlifyLastError(integrationCfg.netlify_last_error || '');
        setDeployProviderPreference(integrationCfg.deploy_provider_preference === 'netlify' ? 'netlify' : 'vercel');
        if (integrationCfg.stripe_secret_key === REDACTED_SECRET) {
          setStripeSecretKey('');
          setStripeSecretKeyMasked(true);
        } else {
          setStripeSecretKey(integrationCfg.stripe_secret_key);
          setStripeSecretKeyMasked(false);
        }
        if (integrationCfg.stripe_webhook_secret === REDACTED_SECRET) {
          setStripeWebhookSecret('');
          setStripeWebhookSecretMasked(true);
        } else {
          setStripeWebhookSecret(integrationCfg.stripe_webhook_secret);
          setStripeWebhookSecretMasked(false);
        }
        setStripePublishableKey(integrationCfg.stripe_publishable_key);
        setStripePriceBasic(integrationCfg.stripe_price_basic);
        setStripePricePro(integrationCfg.stripe_price_pro);
        setStripeVerified(Boolean(integrationCfg.stripe_verified));
        setStripeVerifiedAt(integrationCfg.stripe_verified_at || '');
        setStripeLastError(integrationCfg.stripe_last_error || '');
        if (integrationCfg.linear_api_key === REDACTED_SECRET) {
          setLinearApiKey('');
          setLinearApiKeyMasked(true);
        } else {
          setLinearApiKey(integrationCfg.linear_api_key);
          setLinearApiKeyMasked(false);
        }
        setLinearTeamId(integrationCfg.linear_team_id || '');
        setLinearVerified(Boolean(integrationCfg.linear_verified));
        setLinearVerifiedAt(integrationCfg.linear_verified_at || '');
        setLinearLastError(integrationCfg.linear_last_error || '');
        setLinearStatus(normalizeConnectorStatus(integrationCfg.linear_status, Boolean(integrationCfg.linear_api_key) || integrationCfg.linear_api_key === REDACTED_SECRET));
        setLinearLastSuccessAt(integrationCfg.linear_last_success_at || '');
        setLinearConsecutiveFailures(Math.max(0, Number(integrationCfg.linear_consecutive_failures || 0) || 0));
        if (integrationCfg.notion_token === REDACTED_SECRET) {
          setNotionToken('');
          setNotionTokenMasked(true);
        } else {
          setNotionToken(integrationCfg.notion_token);
          setNotionTokenMasked(false);
        }
        setNotionParentPageId(integrationCfg.notion_parent_page_id || '');
        setNotionVerified(Boolean(integrationCfg.notion_verified));
        setNotionVerifiedAt(integrationCfg.notion_verified_at || '');
        setNotionLastError(integrationCfg.notion_last_error || '');
        setNotionStatus(normalizeConnectorStatus(integrationCfg.notion_status, Boolean(integrationCfg.notion_token) || integrationCfg.notion_token === REDACTED_SECRET));
        setNotionLastSuccessAt(integrationCfg.notion_last_success_at || '');
        setNotionConsecutiveFailures(Math.max(0, Number(integrationCfg.notion_consecutive_failures || 0) || 0));
        setJiraBaseUrl(integrationCfg.jira_base_url || '');
        setJiraEmail(integrationCfg.jira_email || '');
        if (integrationCfg.jira_api_token === REDACTED_SECRET) {
          setJiraApiToken('');
          setJiraApiTokenMasked(true);
        } else {
          setJiraApiToken(integrationCfg.jira_api_token || '');
          setJiraApiTokenMasked(false);
        }
        setJiraProjectKey(integrationCfg.jira_project_key || '');
        setJiraVerified(Boolean(integrationCfg.jira_verified));
        setJiraVerifiedAt(integrationCfg.jira_verified_at || '');
        setJiraLastError(integrationCfg.jira_last_error || '');
        setJiraStatus(normalizeConnectorStatus(
          integrationCfg.jira_status,
          Boolean(integrationCfg.jira_base_url && integrationCfg.jira_email && integrationCfg.jira_api_token),
        ));
        setJiraLastSuccessAt(integrationCfg.jira_last_success_at || '');
        setJiraConsecutiveFailures(Math.max(0, Number(integrationCfg.jira_consecutive_failures || 0) || 0));
        setGitlabBranchRef(integrationCfg.gitlab_default_branch || 'main');
        setGitlabMrTargetBranch(integrationCfg.gitlab_default_branch || 'main');
        applySlackIntegrationSettings(integrationCfg);
        setWebhookUrl(integrationCfg.webhook_url);
      }
    });
    fetchPrQualityProfile().then((payload) => {
      if (!payload || payload.status !== 'ok') return;
      setPrQualityProfile(payload.profile === 'strict' || payload.profile === 'fast' ? payload.profile : 'balanced');
    }).catch(() => {
      // no-op: quality profile endpoint can be unavailable on older backends
    });
  }, [applySlackIntegrationSettings]);

  const handleSlackRetry = async () => {
    if (slackRetryBusy || integrationOpsBusy) return;
    const channel = slackDefaultChannel.trim();
    if (!channel) {
      const message = 'Set a default Slack channel (for example #ops-alerts) before retrying.';
      setSlackRetryStatus(message);
      setIntegrationOpsStatus(message);
      return;
    }
    if (!slackConfigured) {
      const message = 'Save or provide a Slack bot token before retrying.';
      setSlackRetryStatus(message);
      setIntegrationOpsStatus(message);
      return;
    }

    setSlackRetryBusy(true);
    setSlackRetryStatus('Sending outbound connectivity check...');
    setIntegrationOpsStatus('Sending Slack outbound connectivity check...');

    const result = await slackSendMessageResult({
      token: slackTokenMasked ? undefined : slackToken.trim(),
      channel,
      text: `COMPaaS connectivity check • ${new Date().toISOString()}`,
    });

    if (!result.ok) {
      const message = result.detail || 'Slack outbound retry failed.';
      setSlackRetryStatus(message);
      setIntegrationOpsStatus(message);
      await refreshSlackIntegrationState();
      setSlackRetryBusy(false);
      return;
    }

    const message = `Slack outbound retry succeeded for ${channel}.`;
    setSlackRetryStatus(message);
    setIntegrationOpsStatus(message);
    await refreshSlackIntegrationState();
    setSlackRetryBusy(false);
  };

  useEffect(() => {
    if (!focusConnector) return;
    if (focusConnector === 'stripe' && !stripeBillingEnabled) return;
    setActiveTab('integrations');
    if (focusConnector === 'github') {
      setIntegrationOpsStatus('GitHub setup is required before creating GitHub projects. Connect and verify below.');
    } else if (focusConnector === 'gitlab') {
      setIntegrationOpsStatus('GitLab setup is required before creating GitLab projects. Connect and verify below.');
    } else if (focusConnector === 'vercel') {
      setIntegrationOpsStatus('Vercel setup is required for deployments. Connect and verify below.');
    } else if (focusConnector === 'netlify') {
      setIntegrationOpsStatus('Netlify setup is required for deployments. Connect and verify below.');
    } else if (focusConnector === 'stripe') {
      setIntegrationOpsStatus('Stripe setup is required for billing scaffolds. Connect and verify below.');
    } else if (focusConnector === 'linear') {
      setIntegrationOpsStatus('Linear setup is required before creating delivery issues. Connect and verify below.');
    } else if (focusConnector === 'notion') {
      setIntegrationOpsStatus('Notion setup is required before publishing project handoff pages. Connect and verify below.');
    } else if (focusConnector === 'jira') {
      setIntegrationOpsStatus('Jira setup is required before creating or transitioning issues. Connect and verify below.');
    }
  }, [focusConnector, stripeBillingEnabled]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const normalizedHeartbeat = Math.max(1, Math.min(60, Math.round(runHeartbeatSeconds || 5)));
    const normalizedWarning = Math.max(30, Math.min(1200, Math.round(runStallWarningSeconds || 90)));
    const normalizedCritical = Math.max(
      normalizedWarning,
      Math.min(1800, Math.round(runStallCriticalSeconds || 180)),
    );
    const normalizedFallbackMs = Math.max(5000, Math.min(120000, Math.round(activityFallbackMs || 15000)));
    setRunHeartbeatSeconds(normalizedHeartbeat);
    setRunStallWarningSeconds(normalizedWarning);
    setRunStallCriticalSeconds(normalizedCritical);
    setActivityFallbackMs(normalizedFallbackMs);

    const patch: Partial<AppConfig> = {
      user: { name: userName.trim() },
      ui: {
        theme: 'midnight',
        ...(config?.ui ?? {}),
        poll_interval_ms: config?.ui?.poll_interval_ms ?? 5000,
        always_on_mode: alwaysOnMode,
        run_heartbeat_seconds: normalizedHeartbeat,
        run_stall_warning_seconds: normalizedWarning,
        run_stall_critical_seconds: normalizedCritical,
        completion_celebration_enabled: completionCelebrationEnabled,
        completion_celebration_mode: 'subtle_burst',
        activity_stream_fallback_enabled: activityFallbackEnabled,
        activity_stream_fallback_ms: normalizedFallbackMs,
      },
      server: { host: config?.server?.host ?? '', port: config?.server?.port ?? 3000, ...(config?.server ?? {}), auto_open_browser: autoOpen },
    };

    try {
      const configResult = await updateConfigResult(patch as Record<string, unknown>);
      if (!configResult.ok) {
        setSaveError(configResult.detail || 'Failed to save settings');
        return;
      }

      const nextIntegrations: IntegrationSettings = {
        workspace_mode: workspaceMode,
        github_token: githubTokenMasked ? REDACTED_SECRET : githubToken.trim(),
        github_repo: githubRepo.trim(),
        github_default_branch: githubDefaultBranch.trim() || 'main',
        github_auto_push: githubAutoPush,
        github_auto_pr: githubAutoPr,
        github_verified: githubVerified,
        github_verified_at: githubVerifiedAt,
        github_last_error: githubLastError,
        gitlab_base_url: gitlabBaseUrl.trim() || 'https://gitlab.com',
        gitlab_token: gitlabTokenMasked ? REDACTED_SECRET : gitlabToken.trim(),
        gitlab_project_id: gitlabProjectId.trim(),
        gitlab_default_branch: gitlabDefaultBranch.trim() || 'main',
        gitlab_verified: gitlabVerified,
        gitlab_verified_at: gitlabVerifiedAt,
        gitlab_last_error: gitlabLastError,
        vercel_token: vercelTokenMasked ? REDACTED_SECRET : vercelToken.trim(),
        vercel_team_id: vercelTeamId.trim(),
        vercel_project_name: vercelProjectName.trim(),
        vercel_default_target: vercelDefaultTarget,
        vercel_verified: vercelVerified,
        vercel_verified_at: vercelVerifiedAt,
        vercel_last_error: vercelLastError,
        netlify_token: netlifyTokenMasked ? REDACTED_SECRET : netlifyToken.trim(),
        netlify_site_id: netlifySiteId.trim(),
        netlify_team_id: netlifyTeamId.trim(),
        netlify_default_target: netlifyDefaultTarget,
        netlify_verified: netlifyVerified,
        netlify_verified_at: netlifyVerifiedAt,
        netlify_last_error: netlifyLastError,
        deploy_provider_preference: deployProviderPreference,
        stripe_secret_key: stripeSecretKeyMasked ? REDACTED_SECRET : stripeSecretKey.trim(),
        stripe_publishable_key: stripePublishableKey.trim(),
        stripe_webhook_secret: stripeWebhookSecretMasked ? REDACTED_SECRET : stripeWebhookSecret.trim(),
        stripe_price_basic: stripePriceBasic.trim(),
        stripe_price_pro: stripePricePro.trim(),
        stripe_verified: stripeVerified,
        stripe_verified_at: stripeVerifiedAt,
        stripe_last_error: stripeLastError,
        slack_token: slackTokenMasked ? REDACTED_SECRET : slackToken.trim(),
        slack_default_channel: slackDefaultChannel.trim(),
        slack_status: slackStatus,
        slack_verified_at: slackVerifiedAt,
        slack_last_success_at: slackLastSuccessAt,
        slack_last_error: slackLastError,
        slack_consecutive_failures: slackConsecutiveFailures,
        linear_api_key: linearApiKeyMasked ? REDACTED_SECRET : linearApiKey.trim(),
        linear_team_id: linearTeamId.trim(),
        linear_verified: linearVerified,
        linear_verified_at: linearVerifiedAt,
        linear_last_error: linearLastError,
        linear_status: linearStatus,
        linear_last_success_at: linearLastSuccessAt,
        linear_consecutive_failures: linearConsecutiveFailures,
        notion_token: notionTokenMasked ? REDACTED_SECRET : notionToken.trim(),
        notion_parent_page_id: notionParentPageId.trim(),
        notion_verified: notionVerified,
        notion_verified_at: notionVerifiedAt,
        notion_last_error: notionLastError,
        notion_status: notionStatus,
        notion_last_success_at: notionLastSuccessAt,
        notion_consecutive_failures: notionConsecutiveFailures,
        jira_base_url: jiraBaseUrl.trim(),
        jira_email: jiraEmail.trim(),
        jira_api_token: jiraApiTokenMasked ? REDACTED_SECRET : jiraApiToken.trim(),
        jira_project_key: jiraProjectKey.trim(),
        jira_verified: jiraVerified,
        jira_verified_at: jiraVerifiedAt,
        jira_last_error: jiraLastError,
        jira_status: jiraStatus,
        jira_last_success_at: jiraLastSuccessAt,
        jira_consecutive_failures: jiraConsecutiveFailures,
        webhook_url: webhookUrl.trim(),
      };
      const currentIntegrations = integrationsFromConfig(config);
      const githubConfigChanged =
        nextIntegrations.github_repo !== currentIntegrations.github_repo
        || nextIntegrations.github_token !== currentIntegrations.github_token;
      const gitlabConfigChanged =
        nextIntegrations.gitlab_base_url !== currentIntegrations.gitlab_base_url
        || nextIntegrations.gitlab_project_id !== currentIntegrations.gitlab_project_id
        || nextIntegrations.gitlab_token !== currentIntegrations.gitlab_token;
      const vercelConfigChanged =
        nextIntegrations.vercel_project_name !== currentIntegrations.vercel_project_name
        || nextIntegrations.vercel_token !== currentIntegrations.vercel_token;
      const netlifyConfigChanged =
        nextIntegrations.netlify_site_id !== currentIntegrations.netlify_site_id
        || nextIntegrations.netlify_token !== currentIntegrations.netlify_token;
      const stripeConfigChanged =
        nextIntegrations.stripe_secret_key !== currentIntegrations.stripe_secret_key;
      const linearConfigChanged =
        nextIntegrations.linear_api_key !== currentIntegrations.linear_api_key
        || nextIntegrations.linear_team_id !== currentIntegrations.linear_team_id;
      const notionConfigChanged =
        nextIntegrations.notion_token !== currentIntegrations.notion_token
        || nextIntegrations.notion_parent_page_id !== currentIntegrations.notion_parent_page_id;
      const jiraConfigChanged =
        nextIntegrations.jira_base_url !== currentIntegrations.jira_base_url
        || nextIntegrations.jira_email !== currentIntegrations.jira_email
        || nextIntegrations.jira_api_token !== currentIntegrations.jira_api_token
        || nextIntegrations.jira_project_key !== currentIntegrations.jira_project_key;
      const slackConfigChanged =
        nextIntegrations.slack_token !== currentIntegrations.slack_token
        || nextIntegrations.slack_default_channel !== currentIntegrations.slack_default_channel;
      if (githubConfigChanged) {
        nextIntegrations.github_verified = false;
        nextIntegrations.github_verified_at = '';
        nextIntegrations.github_last_error = 'GitHub configuration changed. Re-verify connector.';
      }
      if (gitlabConfigChanged) {
        nextIntegrations.gitlab_verified = false;
        nextIntegrations.gitlab_verified_at = '';
        nextIntegrations.gitlab_last_error = 'GitLab configuration changed. Re-verify connector.';
      }
      if (vercelConfigChanged) {
        nextIntegrations.vercel_verified = false;
        nextIntegrations.vercel_verified_at = '';
        nextIntegrations.vercel_last_error = 'Vercel configuration changed. Re-verify connector.';
      }
      if (netlifyConfigChanged) {
        nextIntegrations.netlify_verified = false;
        nextIntegrations.netlify_verified_at = '';
        nextIntegrations.netlify_last_error = 'Netlify configuration changed. Re-verify connector.';
      }
      if (stripeConfigChanged) {
        nextIntegrations.stripe_verified = false;
        nextIntegrations.stripe_verified_at = '';
        nextIntegrations.stripe_last_error = 'Stripe configuration changed. Re-verify connector.';
      }
      if (linearConfigChanged) {
        nextIntegrations.linear_verified = false;
        nextIntegrations.linear_verified_at = '';
        nextIntegrations.linear_last_success_at = '';
        nextIntegrations.linear_consecutive_failures = 0;
        nextIntegrations.linear_last_error = 'Linear configuration changed. Re-verify connector.';
        nextIntegrations.linear_status = (
          (nextIntegrations.linear_api_key && nextIntegrations.linear_api_key !== REDACTED_SECRET)
          || linearApiKeyMasked
        ) ? 'configured' : 'disconnected';
      }
      if (notionConfigChanged) {
        nextIntegrations.notion_verified = false;
        nextIntegrations.notion_verified_at = '';
        nextIntegrations.notion_last_success_at = '';
        nextIntegrations.notion_consecutive_failures = 0;
        nextIntegrations.notion_last_error = 'Notion configuration changed. Re-verify connector.';
        nextIntegrations.notion_status = (
          (nextIntegrations.notion_token && nextIntegrations.notion_token !== REDACTED_SECRET)
          || notionTokenMasked
        ) ? 'configured' : 'disconnected';
      }
      if (jiraConfigChanged) {
        nextIntegrations.jira_verified = false;
        nextIntegrations.jira_verified_at = '';
        nextIntegrations.jira_last_success_at = '';
        nextIntegrations.jira_consecutive_failures = 0;
        nextIntegrations.jira_last_error = 'Jira configuration changed. Re-verify connector.';
        nextIntegrations.jira_status = (
          nextIntegrations.jira_base_url
          && nextIntegrations.jira_email
          && nextIntegrations.jira_api_token
          && (nextIntegrations.jira_api_token !== REDACTED_SECRET || jiraApiTokenMasked)
        ) ? 'configured' : 'disconnected';
      }
      if (slackConfigChanged) {
        const slackConfiguredNext = Boolean(
          (nextIntegrations.slack_token && nextIntegrations.slack_token !== REDACTED_SECRET)
          || slackTokenMasked,
        );
        nextIntegrations.slack_status = slackConfiguredNext ? 'configured' : 'disconnected';
        nextIntegrations.slack_verified_at = '';
        nextIntegrations.slack_last_success_at = '';
        nextIntegrations.slack_last_error = slackConfiguredNext
          ? 'Slack configuration changed. Retry outbound message to verify.'
          : '';
        nextIntegrations.slack_consecutive_failures = 0;
      }
      const integrationsChanged = JSON.stringify(nextIntegrations) !== JSON.stringify(currentIntegrations);

      if (integrationsChanged) {
        const integrationsResult = await saveIntegrationsResult(nextIntegrations);
        if (!integrationsResult.ok) {
          setSaveError(integrationsResult.detail || 'Saved core settings, but failed to save integrations');
          return;
        }
      }

      const prProfileResult = await updatePrQualityProfile(prQualityProfile);
      if (!prProfileResult.ok) {
        setPrProfileStatus(prProfileResult.detail || 'Unable to save PR quality profile.');
      } else {
        setPrProfileStatus(`PR quality profile set to ${prQualityProfile}.`);
      }

      setConfig((prev) => prev ? ({
        ...prev,
        ...patch,
        integrations: nextIntegrations,
      }) : prev);
      setGithubVerified(nextIntegrations.github_verified);
      setGithubVerifiedAt(nextIntegrations.github_verified_at);
      setGithubLastError(nextIntegrations.github_last_error);
      setGitlabVerified(nextIntegrations.gitlab_verified);
      setGitlabVerifiedAt(nextIntegrations.gitlab_verified_at);
      setGitlabLastError(nextIntegrations.gitlab_last_error);
      setVercelVerified(nextIntegrations.vercel_verified);
      setVercelVerifiedAt(nextIntegrations.vercel_verified_at);
      setVercelLastError(nextIntegrations.vercel_last_error);
      setNetlifyVerified(nextIntegrations.netlify_verified);
      setNetlifyVerifiedAt(nextIntegrations.netlify_verified_at);
      setNetlifyLastError(nextIntegrations.netlify_last_error);
      setStripeVerified(nextIntegrations.stripe_verified);
      setStripeVerifiedAt(nextIntegrations.stripe_verified_at);
      setStripeLastError(nextIntegrations.stripe_last_error);
      setSlackDefaultChannel(nextIntegrations.slack_default_channel);
      setSlackStatus(normalizeConnectorStatus(nextIntegrations.slack_status, Boolean(nextIntegrations.slack_token)));
      setSlackVerifiedAt(nextIntegrations.slack_verified_at);
      setSlackLastSuccessAt(nextIntegrations.slack_last_success_at);
      setSlackLastError(nextIntegrations.slack_last_error);
      setSlackConsecutiveFailures(nextIntegrations.slack_consecutive_failures);
      setLinearVerified(nextIntegrations.linear_verified);
      setLinearVerifiedAt(nextIntegrations.linear_verified_at);
      setLinearLastError(nextIntegrations.linear_last_error);
      setLinearStatus(normalizeConnectorStatus(nextIntegrations.linear_status, Boolean(nextIntegrations.linear_api_key)));
      setLinearLastSuccessAt(nextIntegrations.linear_last_success_at);
      setLinearConsecutiveFailures(nextIntegrations.linear_consecutive_failures);
      setNotionVerified(nextIntegrations.notion_verified);
      setNotionVerifiedAt(nextIntegrations.notion_verified_at);
      setNotionLastError(nextIntegrations.notion_last_error);
      setNotionStatus(normalizeConnectorStatus(nextIntegrations.notion_status, Boolean(nextIntegrations.notion_token)));
      setNotionLastSuccessAt(nextIntegrations.notion_last_success_at);
      setNotionConsecutiveFailures(nextIntegrations.notion_consecutive_failures);
      setJiraVerified(nextIntegrations.jira_verified);
      setJiraVerifiedAt(nextIntegrations.jira_verified_at);
      setJiraLastError(nextIntegrations.jira_last_error);
      setJiraStatus(normalizeConnectorStatus(nextIntegrations.jira_status, Boolean(nextIntegrations.jira_base_url && nextIntegrations.jira_email && nextIntegrations.jira_api_token)));
      setJiraLastSuccessAt(nextIntegrations.jira_last_success_at);
      setJiraConsecutiveFailures(nextIntegrations.jira_consecutive_failures);
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
  const githubVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'github')
    ? 'Another connector verification is in progress.'
    : (!githubRepo.trim()
      ? 'Repository is required (owner/repo).'
      : ((!githubTokenMasked && !githubToken.trim()) ? 'Token is required for verification.' : ''));
  const gitlabVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'gitlab')
    ? 'Another connector verification is in progress.'
    : (!gitlabProjectId.trim()
      ? 'Project ID is required.'
      : ((!gitlabTokenMasked && !gitlabToken.trim()) ? 'Token is required for verification.' : ''));
  const vercelVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'vercel')
    ? 'Another connector verification is in progress.'
    : (!vercelProjectName.trim()
      ? 'Project name is required.'
      : ((!vercelTokenMasked && !vercelToken.trim()) ? 'Token is required for verification.' : ''));
  const netlifyVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'netlify')
    ? 'Another connector verification is in progress.'
    : (!netlifySiteId.trim()
      ? 'Site ID is required.'
      : ((!netlifyTokenMasked && !netlifyToken.trim()) ? 'Token is required for verification.' : ''));
  const stripeVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'stripe')
    ? 'Another connector verification is in progress.'
    : ((!stripeSecretKeyMasked && !stripeSecretKey.trim())
      ? 'Secret key is required for verification.'
      : '');
  const linearVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'linear')
    ? 'Another connector verification is in progress.'
    : ((!linearApiKeyMasked && !linearApiKey.trim())
      ? 'Linear API key is required for verification.'
      : '');
  const notionVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'notion')
    ? 'Another connector verification is in progress.'
    : ((!notionTokenMasked && !notionToken.trim())
      ? 'Notion token is required for verification.'
      : '');
  const jiraVerifyDisabledReason = verifyAllBusy
    ? 'Connect & Verify All is currently running.'
    : (quickVerifyBusy.length > 0 && quickVerifyBusy !== 'jira')
    ? 'Another connector verification is in progress.'
    : ((!jiraBaseUrl.trim() || !jiraEmail.trim())
      ? 'Jira base URL and email are required.'
      : ((!jiraApiTokenMasked && !jiraApiToken.trim())
        ? 'Jira API token is required for verification.'
        : ''));
  const handleTelegramReadinessRetry = async () => {
    setIntegrationOpsStatus('Retrying Telegram poll...');
    const result = await pollTelegramMessagesResult();
    if (!result.ok) {
      setIntegrationOpsStatus(result.detail || 'Telegram retry failed.');
    } else {
      const count = Array.isArray(result.data?.messages) ? result.data.messages.length : 0;
      setIntegrationOpsStatus(count > 0
        ? `Telegram retry succeeded. Pulled ${count} new message${count === 1 ? '' : 's'}.`
        : 'Telegram retry succeeded. No new messages.');
    }
    const refreshed = await fetchConfig().catch(() => null);
    if (refreshed) setConfig(refreshed);
  };

  const telegramTokenConfigured = Boolean(String(config?.integrations?.telegram_bot_token || '').trim());
  const telegramChatConfigured = Boolean(String(config?.integrations?.telegram_chat_id || '').trim());
  const telegramConfigured = telegramTokenConfigured && telegramChatConfigured;
  const telegramConnectorStatus = normalizeConnectorStatus(
    config?.integrations?.telegram_status,
    Boolean(config?.integrations?.telegram_configured),
  );
  const connectorCoverageRows: Array<{ name: string; status: ConnectorLifecycleState }> = [
    { name: 'GitHub', status: githubVerified ? 'verified' : (githubRepo.trim() && (githubTokenMasked || githubToken.trim()) ? 'configured' : 'disconnected') },
    { name: 'GitLab', status: normalizeConnectorStatus(gitlabVerified ? 'verified' : '', Boolean(gitlabProjectId.trim() && (gitlabTokenMasked || gitlabToken.trim()))) },
    { name: 'Vercel', status: normalizeConnectorStatus(vercelVerified ? 'verified' : '', Boolean(vercelProjectName.trim() && (vercelTokenMasked || vercelToken.trim()))) },
    { name: 'Netlify', status: normalizeConnectorStatus(netlifyVerified ? 'verified' : '', Boolean(netlifySiteId.trim() && (netlifyTokenMasked || netlifyToken.trim()))) },
    { name: 'Stripe', status: normalizeConnectorStatus(stripeVerified ? 'verified' : '', Boolean(stripeSecretKeyMasked || stripeSecretKey.trim())) },
    { name: 'Telegram', status: telegramConnectorStatus },
    { name: 'Slack', status: slackStatus },
    { name: 'Linear', status: linearStatus },
    { name: 'Notion', status: notionStatus },
    { name: 'Jira', status: jiraStatus },
  ];
  const connectorsVerifiedCount = connectorCoverageRows.filter((row) => row.status === 'verified').length;
  const connectorsConfiguredCount = connectorCoverageRows.filter((row) => row.status !== 'disconnected').length;
  const connectorsDegradedCount = connectorCoverageRows.filter((row) => row.status === 'degraded').length;
  const readinessRows: ConnectorReadinessEntry[] = [
    {
      id: 'github',
      group: 'Deployment connectors',
      name: 'GitHub',
      configured: Boolean(githubRepo.trim() && (githubTokenMasked || githubToken.trim())),
      verified: githubVerified,
      status: connectorCoverageRows[0].status,
      lastSuccessAt: githubVerifiedAt,
      lastError: githubLastError,
      disabledReason: githubVerifyDisabledReason,
      retry: handleQuickVerifyGithub,
    },
    {
      id: 'gitlab',
      group: 'Deployment connectors',
      name: 'GitLab',
      configured: Boolean(gitlabProjectId.trim() && (gitlabTokenMasked || gitlabToken.trim())),
      verified: gitlabVerified,
      status: connectorCoverageRows[1].status,
      lastSuccessAt: gitlabVerifiedAt,
      lastError: gitlabLastError,
      disabledReason: gitlabVerifyDisabledReason,
      retry: handleQuickVerifyGitlab,
    },
    {
      id: 'vercel',
      group: 'Deployment connectors',
      name: 'Vercel',
      configured: Boolean(vercelProjectName.trim() && (vercelTokenMasked || vercelToken.trim())),
      verified: vercelVerified,
      status: connectorCoverageRows[2].status,
      lastSuccessAt: vercelVerifiedAt,
      lastError: vercelLastError,
      disabledReason: vercelVerifyDisabledReason,
      retry: handleQuickVerifyVercel,
    },
    {
      id: 'netlify',
      group: 'Deployment connectors',
      name: 'Netlify',
      configured: Boolean(netlifySiteId.trim() && (netlifyTokenMasked || netlifyToken.trim())),
      verified: netlifyVerified,
      status: connectorCoverageRows[3].status,
      lastSuccessAt: netlifyVerifiedAt,
      lastError: netlifyLastError,
      disabledReason: netlifyVerifyDisabledReason,
      retry: handleQuickVerifyNetlify,
    },
    {
      id: 'stripe',
      group: 'Deployment connectors',
      name: 'Stripe',
      configured: Boolean(stripeSecretKeyMasked || stripeSecretKey.trim()),
      verified: stripeVerified,
      status: connectorCoverageRows[4].status,
      lastSuccessAt: stripeVerifiedAt,
      lastError: stripeLastError,
      disabledReason: stripeVerifyDisabledReason,
      retry: handleQuickVerifyStripe,
    },
    {
      id: 'linear',
      group: 'Work management connectors',
      name: 'Linear',
      configured: Boolean(linearApiKeyMasked || linearApiKey.trim()),
      verified: linearVerified,
      status: normalizeConnectorStatus(linearStatus, Boolean(linearApiKeyMasked || linearApiKey.trim())),
      lastSuccessAt: linearLastSuccessAt || linearVerifiedAt,
      lastError: linearLastError,
      disabledReason: linearVerifyDisabledReason,
      retry: handleQuickVerifyLinear,
    },
    {
      id: 'notion',
      group: 'Work management connectors',
      name: 'Notion',
      configured: Boolean(notionTokenMasked || notionToken.trim()),
      verified: notionVerified,
      status: normalizeConnectorStatus(notionStatus, Boolean(notionTokenMasked || notionToken.trim())),
      lastSuccessAt: notionLastSuccessAt || notionVerifiedAt,
      lastError: notionLastError,
      disabledReason: notionVerifyDisabledReason,
      retry: handleQuickVerifyNotion,
    },
    {
      id: 'jira',
      group: 'Work management connectors',
      name: 'Jira',
      configured: Boolean(jiraBaseUrl.trim() && jiraEmail.trim() && (jiraApiTokenMasked || jiraApiToken.trim())),
      verified: jiraVerified,
      status: normalizeConnectorStatus(jiraStatus, Boolean(jiraBaseUrl.trim() && jiraEmail.trim() && (jiraApiTokenMasked || jiraApiToken.trim()))),
      lastSuccessAt: jiraLastSuccessAt || jiraVerifiedAt,
      lastError: jiraLastError,
      disabledReason: jiraVerifyDisabledReason,
      retry: handleQuickVerifyJira,
    },
    {
      id: 'slack',
      group: 'Messaging connectors',
      name: 'Slack',
      configured: slackConfigured,
      verified: slackStatus === 'verified',
      status: normalizeConnectorStatus(slackStatus, slackConfigured),
      lastSuccessAt: slackLastSuccessAt || slackVerifiedAt,
      lastError: slackLastError,
      disabledReason: slackConfigured ? '' : 'Save a Slack token before retrying.',
      retry: handleSlackRetry,
    },
    {
      id: 'telegram',
      group: 'Messaging connectors',
      name: 'Telegram',
      configured: telegramConfigured,
      verified: telegramConnectorStatus === 'verified',
      status: telegramConnectorStatus,
      lastSuccessAt: String(config?.integrations?.telegram_last_success_at || '').trim(),
      lastError: String(config?.integrations?.telegram_last_error || '').trim(),
      disabledReason: telegramConfigured ? '' : 'Add Telegram bot token + chat ID before retrying.',
      retry: handleTelegramReadinessRetry,
    },
  ];

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
                Your Name (Chairman)
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

            <Toggle
              value={autoOpen}
              onChange={setAutoOpen}
              label="Auto-open browser"
              description="Automatically open the dashboard when compaas-web starts"
            />

            <div style={{ display: 'grid', gap: '10px' }}>
              <label
                htmlFor="settings-always-on-mode"
                style={{ fontSize: '12px', fontWeight: 500, color: C.textSecondary }}
              >
                Always-on mode
              </label>
              <select
                id="settings-always-on-mode"
                value={alwaysOnMode}
                onChange={(e) => setAlwaysOnMode(e.target.value === 'manual' ? 'manual' : 'guarded_autopilot')}
                style={inputStyle({ maxWidth: '280px' })}
              >
                <option value="guarded_autopilot">Guarded Autopilot (Recommended)</option>
                <option value="manual">Manual</option>
              </select>
              <p style={{ margin: 0, fontSize: '11px', color: C.textMuted }}>
                Guarded Autopilot continues safe run transitions automatically and warns before risky actions.
              </p>
            </div>

            <div style={{ display: 'grid', gap: '10px' }}>
              <p style={{ margin: 0, fontSize: '12px', fontWeight: 500, color: C.textSecondary }}>
                Run watchdog timing
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
                <label style={{ display: 'grid', gap: '5px', fontSize: '11px', color: C.textMuted }}>
                  Heartbeat (seconds)
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={runHeartbeatSeconds}
                    onChange={(e) => setRunHeartbeatSeconds(Math.max(1, Number(e.target.value || 5) || 5))}
                    style={inputStyle()}
                  />
                </label>
                <label style={{ display: 'grid', gap: '5px', fontSize: '11px', color: C.textMuted }}>
                  Stall warning (seconds)
                  <input
                    type="number"
                    min={30}
                    max={1200}
                    value={runStallWarningSeconds}
                    onChange={(e) => setRunStallWarningSeconds(Math.max(30, Number(e.target.value || 90) || 90))}
                    style={inputStyle()}
                  />
                </label>
                <label style={{ display: 'grid', gap: '5px', fontSize: '11px', color: C.textMuted }}>
                  Stall critical (seconds)
                  <input
                    type="number"
                    min={30}
                    max={1800}
                    value={runStallCriticalSeconds}
                    onChange={(e) => setRunStallCriticalSeconds(Math.max(30, Number(e.target.value || 180) || 180))}
                    style={inputStyle()}
                  />
                </label>
              </div>
            </div>

            <Toggle
              value={completionCelebrationEnabled}
              onChange={setCompletionCelebrationEnabled}
              label="Completion celebration"
              description="Show a subtle confetti burst when a project is truly delivered."
            />

            <div style={{ display: 'grid', gap: '10px' }}>
              <Toggle
                value={activityFallbackEnabled}
                onChange={setActivityFallbackEnabled}
                label="Activity fallback polling"
                description="If live stream degrades, keep activity and counters updated via polling."
              />
              <label style={{ display: 'grid', gap: '5px', fontSize: '11px', color: C.textMuted, maxWidth: '220px' }}>
                Fallback interval (ms)
                <input
                  type="number"
                  min={5000}
                  max={120000}
                  value={activityFallbackMs}
                  onChange={(e) => setActivityFallbackMs(Math.max(5000, Number(e.target.value || 15000) || 15000))}
                  style={inputStyle()}
                />
              </label>
            </div>
          </div>
        </Section>
      )}

      {activeTab === 'general' && (
        <Section title="Update Center">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div
              style={{
                backgroundColor: C.surfaceRaised,
                border: `1px solid ${C.border}`,
                borderRadius: '8px',
                padding: '12px',
                display: 'grid',
                gap: '6px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12px' }}>
                <span style={{ color: C.textSecondary }}>Channel</span>
                <strong style={{ color: C.textPrimary }}>{updateStatus?.channel ?? 'release_tags'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12px' }}>
                <span style={{ color: C.textSecondary }}>Current version</span>
                <strong style={{ color: C.textPrimary }}>{updateStatus?.current_version || 'unknown'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12px' }}>
                <span style={{ color: C.textSecondary }}>Latest version</span>
                <strong style={{ color: C.textPrimary }}>{updateStatus?.latest_version || updateStatus?.current_version || 'unknown'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12px' }}>
                <span style={{ color: C.textSecondary }}>Repository state</span>
                <strong style={{ color: updateStatus?.dirty_repo ? C.warning : C.success }}>
                  {updateStatus?.dirty_repo ? 'Dirty (blocked)' : 'Clean'}
                </strong>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => { void refreshUpdateStatus(true); }}
                disabled={updateStatusBusy || updateApplyBusy}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: `1px solid ${C.border}`,
                  backgroundColor: C.surfaceRaised,
                  color: C.textPrimary,
                  cursor: (updateStatusBusy || updateApplyBusy) ? 'default' : 'pointer',
                  opacity: (updateStatusBusy || updateApplyBusy) ? 0.7 : 1,
                }}
              >
                {updateStatusBusy ? 'Checking…' : 'Check for updates'}
              </button>
              <button
                type="button"
                onClick={() => { void handleApplyUpdate(); }}
                disabled={updateStatusBusy || updateApplyBusy || !updateStatus?.can_update}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: `1px solid ${updateStatus?.can_update ? C.accent : C.border}`,
                  backgroundColor: updateStatus?.can_update ? C.accentDim : C.surfaceRaised,
                  color: updateStatus?.can_update ? C.accent : C.textMuted,
                  cursor: (updateStatusBusy || updateApplyBusy || !updateStatus?.can_update) ? 'default' : 'pointer',
                  opacity: (updateStatusBusy || updateApplyBusy || !updateStatus?.can_update) ? 0.7 : 1,
                }}
              >
                {updateApplyBusy ? 'Updating…' : `Update to ${updateStatus?.latest_version || 'latest'}`}
              </button>
            </div>

            {updateFeedback && (
              <div style={{ fontSize: '12px', color: C.textSecondary }}>
                {updateFeedback}
              </div>
            )}
          </div>
        </Section>
      )}

      {activeTab === 'ai' && (
        <>
          <Section title="AI Model Provider">
            <AiProviderSection
              key={`${config?.llm?.provider ?? 'none'}|${config?.llm?.base_url ?? 'none'}|${config?.llm?.model ?? 'none'}`}
              llm={config?.llm}
              onSaved={() => { fetchConfig().then((c) => { if (c) setConfig(c); }); onConfigUpdated?.(); }}
            />
          </Section>
          {config?.feature_flags?.context_packs !== false && (
            <Section title="Global Context Packs">
              <p style={{ fontSize: '12px', color: C.textSecondary, marginBottom: '12px' }}>
                Pinned global packs are injected into CEO prompts across all projects.
              </p>
              <ContextPackPanel defaultScope="global" />
            </Section>
          )}
        </>
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
                Examples: <code style={{ fontSize: '10px' }}>claude-sonnet-4-0</code>, <code style={{ fontSize: '10px' }}>gpt-5.2</code>, <code style={{ fontSize: '10px' }}>gemini-2.5-pro</code>
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

          <Section title="Quick Connect (Recommended)">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Workspace Default</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Default location for new projects</div>
                  </div>
                  <span style={{ fontSize: '11px', color: workspaceMode === 'local' ? C.success : C.accent }}>
                    {workspaceMode === 'github' ? 'GitHub' : workspaceMode === 'gitlab' ? 'GitLab' : 'Local'}
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
                    Local
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
                    GitHub
                  </button>
                  <button
                    onClick={() => setWorkspaceMode('gitlab')}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '7px',
                      border: `1px solid ${workspaceMode === 'gitlab' ? C.accent : C.border}`,
                      backgroundColor: workspaceMode === 'gitlab' ? C.accentDim : C.surface,
                      color: workspaceMode === 'gitlab' ? C.accent : C.textSecondary,
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    GitLab
                  </button>
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Connect & Verify All</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>
                      Runs GitHub + deployment connector checks in sequence and returns remediation if anything fails.
                    </div>
                  </div>
                  <button
                    onClick={() => { void handleConnectAndVerifyAll(); }}
                    disabled={verifyAllBusy || quickVerifyBusy.length > 0}
                    style={{
                      padding: '7px 11px',
                      borderRadius: '7px',
                      border: `1px solid ${C.accent}`,
                      backgroundColor: C.accentDim,
                      color: C.accent,
                      fontSize: '12px',
                      cursor: (verifyAllBusy || quickVerifyBusy.length > 0) ? 'not-allowed' : 'pointer',
                      opacity: (verifyAllBusy || quickVerifyBusy.length > 0) ? 0.75 : 1,
                    }}
                  >
                    {verifyAllBusy ? 'Verifying All…' : 'Connect & Verify All'}
                  </button>
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', gap: '10px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Readiness Coverage</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>
                      Verified {connectorsVerifiedCount}/{connectorCoverageRows.length} • Configured {connectorsConfiguredCount}/{connectorCoverageRows.length}
                      {connectorsDegradedCount > 0 ? ` • Degraded ${connectorsDegradedCount}` : ''}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {connectorCoverageRows.map((row) => (
                    <span
                      key={`coverage-${row.name}`}
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        border: `1px solid ${C.border}`,
                        color: connectorStatusColor(row.status),
                        backgroundColor: C.surface,
                      }}
                    >
                      {row.name}: {connectorStatusLabel(row.status)}
                    </span>
                  ))}
                </div>
              </div>

              <ConnectorReadinessCenter
                rows={readinessRows}
                integrationOpsBusy={integrationOpsBusy}
                slackRetryBusy={slackRetryBusy}
                quickVerifyBusy={quickVerifyBusy}
              />

              <div style={{ fontSize: '12px', fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Deployment connectors
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>GitHub Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Token + repo + verify</div>
                  </div>
                  <span style={{ fontSize: '11px', color: githubVerified ? C.success : C.textMuted }}>
                    {githubVerified ? 'Verified' : 'Not verified'}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                  <input
                    type="text"
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                    placeholder="owner/repo"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={githubDefaultBranch}
                    onChange={(e) => setGithubDefaultBranch(e.target.value)}
                    placeholder="default branch (main)"
                    style={{ ...inputStyle({ maxWidth: '240px', fontSize: '12px' }) }}
                  />
                  <input
                    type="password"
                    value={githubToken}
                    onChange={(e) => { setGithubToken(e.target.value); }}
                    placeholder={githubTokenMasked ? 'Saved (hidden). Type to replace.' : 'ghp_xxx'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onInput={() => { setGithubTokenMasked(false); }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleQuickVerifyGithub(); }}
                      disabled={quickVerifyBusy.length > 0 || Boolean(githubVerifyDisabledReason)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${githubVerified ? C.success : C.accent}`,
                        backgroundColor: githubVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                        color: githubVerified ? C.success : C.accent,
                        fontSize: '12px',
                        cursor: (quickVerifyBusy.length > 0 || githubVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                        opacity: (quickVerifyBusy.length > 0 || githubVerifyDisabledReason) ? 0.75 : 1,
                      }}
                    >
                      {quickVerifyBusy === 'github' ? 'Verifying…' : githubVerified ? 'Verified' : 'Connect & Verify'}
                    </button>
                    {githubVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(githubVerifiedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {githubVerifyDisabledReason && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>
                      {githubVerifyDisabledReason}
                    </p>
                  )}
                  {!githubVerifyDisabledReason && githubInlineStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: githubVerified ? C.success : C.textSecondary }}>
                      {githubInlineStatus}
                    </p>
                  )}
                  {!githubVerified && githubLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{githubLastError}</p>
                  )}
                  <IntegrationGuide
                    title="Full GitHub setup guide"
                    steps={[
                      <>
                        Open token settings at
                        {' '}
                        <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" style={{ color: C.accent }}>
                          github.com/settings/tokens
                        </a>
                        {' '}
                        and create a token.
                      </>,
                      <>
                        Use a
                        {' '}
                        <strong>fine-grained token</strong>
                        {' '}
                        with repo access (recommended), or a classic token with
                        {' '}
                        <code>repo</code>
                        {' '}
                        scope.
                      </>,
                      <>
                        Enter repository in
                        {' '}
                        <code>owner/repo</code>
                        {' '}
                        format and set default branch to
                        {' '}
                        <code>main</code>
                        {' '}
                        unless your repo uses a different default.
                      </>,
                      <>
                        Click
                        {' '}
                        <strong>Connect &amp; Verify</strong>
                        {' '}
                        and wait for Verified status.
                      </>,
                      <>
                        Optional: enable auto-push and auto-PR in Advanced Controls after verification.
                      </>,
                    ]}
                    note={
                      <>
                        If verification fails with
                        {' '}
                        <code>Not authorized</code>
                        , regenerate the token and ensure the selected repo is included in token permissions.
                      </>
                    }
                  />
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>GitLab Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Base URL + token + project + verify</div>
                  </div>
                  <span style={{ fontSize: '11px', color: gitlabVerified ? C.success : C.textMuted }}>
                    {gitlabVerified ? 'Verified' : 'Not verified'}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                  <input
                    type="text"
                    value={gitlabBaseUrl}
                    onChange={(e) => setGitlabBaseUrl(e.target.value)}
                    placeholder="https://gitlab.com"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={gitlabProjectId}
                    onChange={(e) => setGitlabProjectId(e.target.value)}
                    placeholder="Project ID (numeric)"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={gitlabDefaultBranch}
                    onChange={(e) => setGitlabDefaultBranch(e.target.value)}
                    placeholder="default branch (main)"
                    style={{ ...inputStyle({ maxWidth: '240px', fontSize: '12px' }) }}
                  />
                  <input
                    type="password"
                    value={gitlabToken}
                    onChange={(e) => { setGitlabToken(e.target.value); }}
                    placeholder={gitlabTokenMasked ? 'Saved (hidden). Type to replace.' : 'glpat-...'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onInput={() => { setGitlabTokenMasked(false); }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleQuickVerifyGitlab(); }}
                      disabled={quickVerifyBusy.length > 0 || Boolean(gitlabVerifyDisabledReason)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${gitlabVerified ? C.success : C.accent}`,
                        backgroundColor: gitlabVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                        color: gitlabVerified ? C.success : C.accent,
                        fontSize: '12px',
                        cursor: (quickVerifyBusy.length > 0 || gitlabVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                        opacity: (quickVerifyBusy.length > 0 || gitlabVerifyDisabledReason) ? 0.75 : 1,
                      }}
                    >
                      {quickVerifyBusy === 'gitlab' ? 'Verifying…' : gitlabVerified ? 'Verified' : 'Connect & Verify'}
                    </button>
                    {gitlabVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(gitlabVerifiedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {gitlabVerifyDisabledReason && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>
                      {gitlabVerifyDisabledReason}
                    </p>
                  )}
                  {!gitlabVerifyDisabledReason && gitlabInlineStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: gitlabVerified ? C.success : C.textSecondary }}>
                      {gitlabInlineStatus}
                    </p>
                  )}
                  {!gitlabVerified && gitlabLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{gitlabLastError}</p>
                  )}
                  <div style={{ marginTop: '4px', padding: '8px', borderRadius: '8px', border: `1px dashed ${C.border}`, backgroundColor: C.surface }}>
                    <p style={{ margin: 0, fontSize: '11px', color: C.textSecondary, marginBottom: '8px' }}>
                      GitLab delivery actions
                    </p>
                    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr', maxWidth: '560px' }}>
                      <input
                        type="text"
                        value={gitlabBranchName}
                        onChange={(e) => setGitlabBranchName(e.target.value)}
                        placeholder="New branch name"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                      <input
                        type="text"
                        value={gitlabBranchRef}
                        onChange={(e) => setGitlabBranchRef(e.target.value)}
                        placeholder="Ref branch (main)"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                    </div>
                    <button
                      onClick={() => { void handleGitlabBranchCreate(); }}
                      disabled={integrationOpsBusy}
                      style={{ marginTop: '8px', padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Create branch
                    </button>
                    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr', maxWidth: '560px', marginTop: '8px' }}>
                      <input
                        type="text"
                        value={gitlabMrSourceBranch}
                        onChange={(e) => setGitlabMrSourceBranch(e.target.value)}
                        placeholder="MR source branch"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                      <input
                        type="text"
                        value={gitlabMrTargetBranch}
                        onChange={(e) => setGitlabMrTargetBranch(e.target.value)}
                        placeholder="MR target branch"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                      <input
                        type="text"
                        value={gitlabMrTitle}
                        onChange={(e) => setGitlabMrTitle(e.target.value)}
                        placeholder="Merge request title"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                      <input
                        type="text"
                        value={gitlabMrDescription}
                        onChange={(e) => setGitlabMrDescription(e.target.value)}
                        placeholder="MR description (optional)"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                    </div>
                    <button
                      onClick={() => { void handleGitlabMergeRequestCreate(); }}
                      disabled={integrationOpsBusy}
                      style={{ marginTop: '8px', padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Create merge request
                    </button>
                  </div>
                  <IntegrationGuide
                    title="Full GitLab setup guide"
                    steps={[
                      <>
                        Create a Personal Access Token in GitLab with
                        {' '}
                        <code>api</code>
                        {' '}
                        scope.
                      </>,
                      <>
                        For self-hosted GitLab, set your instance URL (for example
                        {' '}
                        <code>https://gitlab.company.com</code>
                        ).
                      </>,
                      <>
                        Open your project in GitLab and copy the numeric
                        {' '}
                        <strong>Project ID</strong>
                        {' '}
                        from project settings or the project overview.
                      </>,
                      <>
                        Set the default branch (
                        <code>main</code>
                        {' '}
                        recommended) and click
                        {' '}
                        <strong>Connect &amp; Verify</strong>
                        .
                      </>,
                    ]}
                    note={
                      <>
                        If verification fails with authorization errors, confirm the token belongs to a user that can access this project ID on the selected GitLab instance.
                      </>
                    }
                  />
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Vercel Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Token + project + verify</div>
                  </div>
                  <span style={{ fontSize: '11px', color: vercelVerified ? C.success : C.textMuted }}>
                    {vercelVerified ? 'Verified' : 'Not verified'}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                  <input
                    type="text"
                    value={vercelProjectName}
                    onChange={(e) => setVercelProjectName(e.target.value)}
                    placeholder="Vercel project name"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={vercelTeamId}
                    onChange={(e) => setVercelTeamId(e.target.value)}
                    placeholder="Team ID (optional)"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="password"
                    value={vercelToken}
                    onChange={(e) => { setVercelToken(e.target.value); }}
                    placeholder={vercelTokenMasked ? 'Saved (hidden). Type to replace.' : 'vercel_xxx'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onInput={() => { setVercelTokenMasked(false); }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleDiscoverVercelProjects(); }}
                      disabled={vercelDiscoveryBusy || verifyAllBusy || quickVerifyBusy.length > 0}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${C.border}`,
                        backgroundColor: C.surface,
                        color: C.textPrimary,
                        fontSize: '12px',
                        cursor: (vercelDiscoveryBusy || verifyAllBusy || quickVerifyBusy.length > 0) ? 'not-allowed' : 'pointer',
                        opacity: (vercelDiscoveryBusy || verifyAllBusy || quickVerifyBusy.length > 0) ? 0.75 : 1,
                      }}
                    >
                      {vercelDiscoveryBusy ? 'Loading…' : 'Discover projects'}
                    </button>
                    {vercelDiscoveryOptions.length > 0 && (
                      <FloatingSelect
                        value={vercelProjectName}
                        options={vercelDiscoveryOptions}
                        onChange={(nextValue) => setVercelProjectName(nextValue)}
                        ariaLabel="Vercel project discovery list"
                        variant="input"
                        size="sm"
                        style={{ maxWidth: '340px' }}
                      />
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: '11px', color: C.textSecondary }}>Default deploy target</label>
                    <FloatingSelect
                      value={vercelDefaultTarget}
                      options={[
                        { value: 'preview', label: 'Preview' },
                        { value: 'production', label: 'Production' },
                      ]}
                      onChange={(nextValue) => setVercelDefaultTarget(nextValue === 'production' ? 'production' : 'preview')}
                      ariaLabel="Default Vercel deploy target"
                      variant="input"
                      size="sm"
                      style={{ maxWidth: '150px' }}
                    />
                    <button
                      onClick={() => { void handleQuickVerifyVercel(); }}
                      disabled={quickVerifyBusy.length > 0 || Boolean(vercelVerifyDisabledReason)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${vercelVerified ? C.success : C.accent}`,
                        backgroundColor: vercelVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                        color: vercelVerified ? C.success : C.accent,
                        fontSize: '12px',
                        cursor: (quickVerifyBusy.length > 0 || vercelVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                        opacity: (quickVerifyBusy.length > 0 || vercelVerifyDisabledReason) ? 0.75 : 1,
                      }}
                    >
                      {quickVerifyBusy === 'vercel' ? 'Verifying…' : vercelVerified ? 'Verified' : 'Connect & Verify'}
                    </button>
                    {vercelVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(vercelVerifiedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {vercelVerifyDisabledReason && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>
                      {vercelVerifyDisabledReason}
                    </p>
                  )}
                  {!vercelVerifyDisabledReason && vercelInlineStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: vercelVerified ? C.success : C.textSecondary }}>
                      {vercelInlineStatus}
                    </p>
                  )}
                  {!vercelVerified && vercelLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{vercelLastError}</p>
                  )}
                  <IntegrationGuide
                    title="Full Vercel setup guide"
                    steps={[
                      <>
                        Open token settings at
                        {' '}
                        <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer" style={{ color: C.accent }}>
                          vercel.com/account/tokens
                        </a>
                        {' '}
                        and create a token.
                      </>,
                      <>
                        Create or import your project in Vercel first, then copy the exact project name.
                      </>,
                      <>
                        Fill Team ID only for organization-owned projects (leave empty for personal scope).
                      </>,
                      <>
                        Set default deploy target to
                        {' '}
                        <strong>Preview</strong>
                        {' '}
                        for safe iteration (recommended).
                      </>,
                      <>
                        Click
                        {' '}
                        <strong>Connect &amp; Verify</strong>
                        {' '}
                        and confirm Verified status before attempting deploy from CEO chat.
                      </>,
                    ]}
                    note={
                      <>
                        If verification returns
                        {' '}
                        <code>Not authorized</code>
                        , the token is invalid or lacks access to that project scope.
                      </>
                    }
                  />
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Netlify Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Token + site + verify</div>
                  </div>
                  <span style={{ fontSize: '11px', color: netlifyVerified ? C.success : C.textMuted }}>
                    {netlifyVerified ? 'Verified' : 'Not verified'}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                  <input
                    type="text"
                    value={netlifySiteId}
                    onChange={(e) => setNetlifySiteId(e.target.value)}
                    placeholder="Netlify site ID"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={netlifyTeamId}
                    onChange={(e) => setNetlifyTeamId(e.target.value)}
                    placeholder="Team ID (optional)"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="password"
                    value={netlifyToken}
                    onChange={(e) => { setNetlifyToken(e.target.value); }}
                    placeholder={netlifyTokenMasked ? 'Saved (hidden). Type to replace.' : 'nfp_...'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onInput={() => { setNetlifyTokenMasked(false); }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleDiscoverNetlifySites(); }}
                      disabled={netlifyDiscoveryBusy || verifyAllBusy || quickVerifyBusy.length > 0}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${C.border}`,
                        backgroundColor: C.surface,
                        color: C.textPrimary,
                        fontSize: '12px',
                        cursor: (netlifyDiscoveryBusy || verifyAllBusy || quickVerifyBusy.length > 0) ? 'not-allowed' : 'pointer',
                        opacity: (netlifyDiscoveryBusy || verifyAllBusy || quickVerifyBusy.length > 0) ? 0.75 : 1,
                      }}
                    >
                      {netlifyDiscoveryBusy ? 'Loading…' : 'Discover sites'}
                    </button>
                    {netlifyDiscoveryOptions.length > 0 && (
                      <FloatingSelect
                        value={netlifySiteId}
                        options={netlifyDiscoveryOptions}
                        onChange={(nextValue) => setNetlifySiteId(nextValue)}
                        ariaLabel="Netlify site discovery list"
                        variant="input"
                        size="sm"
                        style={{ maxWidth: '360px' }}
                      />
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: '11px', color: C.textSecondary }}>Default deploy target</label>
                    <FloatingSelect
                      value={netlifyDefaultTarget}
                      options={[
                        { value: 'preview', label: 'Preview' },
                        { value: 'production', label: 'Production' },
                      ]}
                      onChange={(nextValue) => setNetlifyDefaultTarget(nextValue === 'production' ? 'production' : 'preview')}
                      ariaLabel="Default Netlify deploy target"
                      variant="input"
                      size="sm"
                      style={{ maxWidth: '150px' }}
                    />
                    <button
                      onClick={() => { void handleQuickVerifyNetlify(); }}
                      disabled={quickVerifyBusy.length > 0 || Boolean(netlifyVerifyDisabledReason)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${netlifyVerified ? C.success : C.accent}`,
                        backgroundColor: netlifyVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                        color: netlifyVerified ? C.success : C.accent,
                        fontSize: '12px',
                        cursor: (quickVerifyBusy.length > 0 || netlifyVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                        opacity: (quickVerifyBusy.length > 0 || netlifyVerifyDisabledReason) ? 0.75 : 1,
                      }}
                    >
                      {quickVerifyBusy === 'netlify' ? 'Verifying…' : netlifyVerified ? 'Verified' : 'Connect & Verify'}
                    </button>
                    {netlifyVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(netlifyVerifiedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {netlifyVerifyDisabledReason && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>
                      {netlifyVerifyDisabledReason}
                    </p>
                  )}
                  {!netlifyVerifyDisabledReason && netlifyInlineStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: netlifyVerified ? C.success : C.textSecondary }}>
                      {netlifyInlineStatus}
                    </p>
                  )}
                  {!netlifyVerified && netlifyLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{netlifyLastError}</p>
                  )}
                  <IntegrationGuide
                    title="Full Netlify setup guide"
                    steps={[
                      <>
                        Create an access token at
                        {' '}
                        <a href="https://app.netlify.com/user/applications#personal-access-tokens" target="_blank" rel="noreferrer" style={{ color: C.accent }}>
                          app.netlify.com → User settings → Personal access tokens
                        </a>
                        .
                      </>,
                      <>
                        Click
                        {' '}
                        <strong>Discover sites</strong>
                        {' '}
                        to pull your available sites automatically, then select one from the dropdown.
                      </>,
                      <>
                        Set Team ID only when the site belongs to a team workspace.
                      </>,
                      <>
                        Keep default deploy target on
                        {' '}
                        <strong>Preview</strong>
                        {' '}
                        for safer iteration, then run
                        {' '}
                        <strong>Connect &amp; Verify</strong>
                        .
                      </>,
                    ]}
                    note={
                      <>
                        If verification fails, ensure the token belongs to an account with deploy access to the selected site ID.
                      </>
                    }
                  />
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Default Deployment Provider</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>
                      Used by one-click deploy actions when both connectors are verified.
                    </div>
                  </div>
                  <FloatingSelect
                    value={deployProviderPreference}
                    options={[
                      { value: 'vercel', label: 'Vercel' },
                      { value: 'netlify', label: 'Netlify' },
                    ]}
                    onChange={(nextValue) => setDeployProviderPreference(nextValue === 'netlify' ? 'netlify' : 'vercel')}
                    ariaLabel="Deploy provider preference"
                    variant="input"
                    size="sm"
                    style={{ maxWidth: '170px' }}
                  />
                </div>
              </div>

              {stripeBillingEnabled && (
                <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Stripe Connector</div>
                      <div style={{ fontSize: '11px', color: C.textSecondary }}>Billing keys + verify</div>
                    </div>
                    <span style={{ fontSize: '11px', color: stripeVerified ? C.success : C.textMuted }}>
                      {stripeVerified ? 'Verified' : 'Not verified'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                    <input
                      type="password"
                      value={stripeSecretKey}
                      onChange={(e) => setStripeSecretKey(e.target.value)}
                      onInput={() => setStripeSecretKeyMasked(false)}
                      placeholder={stripeSecretKeyMasked ? 'Saved (hidden). Type to replace.' : 'sk_test_...'}
                      style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    />
                    <input
                      type="text"
                      value={stripePublishableKey}
                      onChange={(e) => setStripePublishableKey(e.target.value)}
                      placeholder="pk_test_... (optional for verify)"
                      style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    />
                    <input
                      type="password"
                      value={stripeWebhookSecret}
                      onChange={(e) => setStripeWebhookSecret(e.target.value)}
                      onInput={() => setStripeWebhookSecretMasked(false)}
                      placeholder={stripeWebhookSecretMasked ? 'Saved (hidden). Type to replace.' : 'whsec_...'}
                      style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    />
                    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr', maxWidth: '420px' }}>
                      <input
                        type="text"
                        value={stripePriceBasic}
                        onChange={(e) => setStripePriceBasic(e.target.value)}
                        placeholder="price_basic (optional)"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                      <input
                        type="text"
                        value={stripePricePro}
                        onChange={(e) => setStripePricePro(e.target.value)}
                        placeholder="price_pro (optional)"
                        style={{ ...inputStyle({ fontSize: '12px' }) }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => { void handleQuickVerifyStripe(); }}
                        disabled={quickVerifyBusy.length > 0 || Boolean(stripeVerifyDisabledReason)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: '7px',
                          border: `1px solid ${stripeVerified ? C.success : C.accent}`,
                          backgroundColor: stripeVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                          color: stripeVerified ? C.success : C.accent,
                          fontSize: '12px',
                          cursor: (quickVerifyBusy.length > 0 || stripeVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                          opacity: (quickVerifyBusy.length > 0 || stripeVerifyDisabledReason) ? 0.75 : 1,
                        }}
                      >
                        {quickVerifyBusy === 'stripe' ? 'Verifying…' : stripeVerified ? 'Verified' : 'Connect & Verify'}
                      </button>
                      {stripeVerifiedAt && (
                        <span style={{ fontSize: '11px', color: C.textMuted }}>
                          Verified {new Date(stripeVerifiedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {stripeVerifyDisabledReason && (
                      <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>
                        {stripeVerifyDisabledReason}
                      </p>
                    )}
                    {!stripeVerifyDisabledReason && stripeInlineStatus && (
                      <p style={{ margin: 0, fontSize: '11px', color: stripeVerified ? C.success : C.textSecondary }}>
                        {stripeInlineStatus}
                      </p>
                    )}
                    {!stripeVerified && stripeLastError && (
                      <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{stripeLastError}</p>
                    )}
                    <IntegrationGuide
                      title="Full Stripe setup guide"
                      steps={[
                        <>
                          Open your Stripe dashboard and copy your
                          {' '}
                          <strong>Secret key</strong>
                          {' '}
                          (test mode first, recommended).
                        </>,
                        <>
                          Optional: add your publishable key and webhook secret now so billing scaffolds can be generated without extra setup.
                        </>,
                        <>
                          Set recurring price IDs (
                          <code>price_basic</code>
                          {' '}
                          /
                          {' '}
                          <code>price_pro</code>
                          ) when you already have products configured.
                        </>,
                        <>
                          Click
                          {' '}
                          <strong>Connect &amp; Verify</strong>
                          {' '}
                          to validate credentials before running billing automation.
                        </>,
                      ]}
                      note={
                        <>
                          If verification fails, double-check that the key type matches your mode (test vs live) and that the account has API access enabled.
                        </>
                      }
                    />
                  </div>
                </div>
              )}

              <div style={{ fontSize: '12px', fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Work management connectors
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Linear Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Verify key, then create delivery issues from the same project flow</div>
                  </div>
                  <span style={{ fontSize: '11px', color: connectorStatusColor(linearStatus) }}>
                    {connectorStatusLabel(linearStatus)}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  <input
                    type="password"
                    value={linearApiKey}
                    onChange={(e) => setLinearApiKey(e.target.value)}
                    onInput={() => setLinearApiKeyMasked(false)}
                    placeholder={linearApiKeyMasked ? 'Saved (hidden). Type to replace.' : 'lin_api_...'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={linearTeamId}
                    onChange={(e) => setLinearTeamId(e.target.value)}
                    placeholder="Team ID (required for issue creation)"
                    style={{ ...inputStyle({ maxWidth: '320px', fontSize: '12px' }) }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleQuickVerifyLinear(); }}
                      disabled={quickVerifyBusy.length > 0 || Boolean(linearVerifyDisabledReason)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${linearVerified ? C.success : C.accent}`,
                        backgroundColor: linearVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                        color: linearVerified ? C.success : C.accent,
                        fontSize: '12px',
                        cursor: (quickVerifyBusy.length > 0 || linearVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                        opacity: (quickVerifyBusy.length > 0 || linearVerifyDisabledReason) ? 0.75 : 1,
                      }}
                    >
                      {quickVerifyBusy === 'linear' ? 'Verifying…' : linearVerified ? 'Verified' : 'Connect & Verify'}
                    </button>
                    {linearVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(linearVerifiedAt).toLocaleString()}
                      </span>
                    )}
                    {linearLastSuccessAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Last success {new Date(linearLastSuccessAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {linearVerifyDisabledReason && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{linearVerifyDisabledReason}</p>
                  )}
                  {!linearVerifyDisabledReason && linearInlineStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: linearVerified ? C.success : C.textSecondary }}>{linearInlineStatus}</p>
                  )}
                  {!linearVerified && linearLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{linearLastError}</p>
                  )}
                  <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr', marginTop: '4px' }}>
                    <input
                      type="text"
                      value={linearIssueTitle}
                      onChange={(e) => setLinearIssueTitle(e.target.value)}
                      placeholder="Issue title for sprint handoff"
                      style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    />
                    <textarea
                      value={linearIssueDescription}
                      onChange={(e) => setLinearIssueDescription(e.target.value)}
                      placeholder="Optional issue description"
                      rows={2}
                      style={{ ...inputStyle({ maxWidth: '520px', fontSize: '12px', resize: 'vertical', fontFamily: 'inherit' }) }}
                    />
                    <button
                      onClick={() => { void handleLinearIssueCreate(); }}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer', maxWidth: '160px' }}
                    >
                      Create Linear issue
                    </button>
                  </div>
                  <IntegrationGuide
                    title="Full Linear setup guide"
                    steps={[
                      <>Create a Linear API key from your workspace settings.</>,
                      <>Paste the key above, add a team ID, and run <strong>Connect &amp; Verify</strong>.</>,
                      <>Use <strong>Create Linear issue</strong> to push a delivery task from COMPaaS.</>,
                    ]}
                  />
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Notion Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Verify token and publish project handoff pages directly from COMPaaS</div>
                  </div>
                  <span style={{ fontSize: '11px', color: connectorStatusColor(notionStatus) }}>
                    {connectorStatusLabel(notionStatus)}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  <input
                    type="password"
                    value={notionToken}
                    onChange={(e) => setNotionToken(e.target.value)}
                    onInput={() => setNotionTokenMasked(false)}
                    placeholder={notionTokenMasked ? 'Saved (hidden). Type to replace.' : 'secret_...'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={notionParentPageId}
                    onChange={(e) => setNotionParentPageId(e.target.value)}
                    placeholder="Parent page ID (required when creating pages)"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleQuickVerifyNotion(); }}
                      disabled={quickVerifyBusy.length > 0 || Boolean(notionVerifyDisabledReason)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${notionVerified ? C.success : C.accent}`,
                        backgroundColor: notionVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                        color: notionVerified ? C.success : C.accent,
                        fontSize: '12px',
                        cursor: (quickVerifyBusy.length > 0 || notionVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                        opacity: (quickVerifyBusy.length > 0 || notionVerifyDisabledReason) ? 0.75 : 1,
                      }}
                    >
                      {quickVerifyBusy === 'notion' ? 'Verifying…' : notionVerified ? 'Verified' : 'Connect & Verify'}
                    </button>
                    {notionVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(notionVerifiedAt).toLocaleString()}
                      </span>
                    )}
                    {notionLastSuccessAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Last success {new Date(notionLastSuccessAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {notionVerifyDisabledReason && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{notionVerifyDisabledReason}</p>
                  )}
                  {!notionVerifyDisabledReason && notionInlineStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: notionVerified ? C.success : C.textSecondary }}>{notionInlineStatus}</p>
                  )}
                  {!notionVerified && notionLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{notionLastError}</p>
                  )}
                  <input
                    type="text"
                    value={notionPageTitle}
                    onChange={(e) => setNotionPageTitle(e.target.value)}
                    placeholder="Page title (for project brief/handoff)"
                    style={{ ...inputStyle({ maxWidth: '460px', fontSize: '12px' }) }}
                  />
                  <textarea
                    value={notionPageMarkdown}
                    onChange={(e) => setNotionPageMarkdown(e.target.value)}
                    placeholder="Markdown content for this Notion page"
                    rows={3}
                    style={{ ...inputStyle({ maxWidth: '560px', fontSize: '12px', resize: 'vertical', fontFamily: 'inherit' }) }}
                  />
                  <button
                    onClick={() => { void handleNotionPageUpsert(); }}
                    disabled={integrationOpsBusy}
                    style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer', maxWidth: '170px' }}
                  >
                    Publish Notion handoff
                  </button>
                  <IntegrationGuide
                    title="Full Notion setup guide"
                    steps={[
                      <>Create an internal integration in Notion and copy its token.</>,
                      <>Share your parent page with that integration and paste the parent page ID above.</>,
                      <>Verify the connector, then publish project briefs/handoffs in one click.</>,
                    ]}
                  />
                </div>
              </div>

              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Jira Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Verify Jira Cloud credentials, create issues, and transition lifecycle states</div>
                  </div>
                  <span style={{ fontSize: '11px', color: connectorStatusColor(jiraStatus) }}>
                    {connectorStatusLabel(jiraStatus)}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  <input
                    type="text"
                    value={jiraBaseUrl}
                    onChange={(e) => setJiraBaseUrl(e.target.value)}
                    placeholder="https://your-org.atlassian.net"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={jiraEmail}
                    onChange={(e) => setJiraEmail(e.target.value)}
                    placeholder="Jira account email"
                    style={{ ...inputStyle({ maxWidth: '320px', fontSize: '12px' }) }}
                  />
                  <input
                    type="password"
                    value={jiraApiToken}
                    onChange={(e) => setJiraApiToken(e.target.value)}
                    onInput={() => setJiraApiTokenMasked(false)}
                    placeholder={jiraApiTokenMasked ? 'Saved (hidden). Type to replace.' : 'Atlassian API token'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                  />
                  <input
                    type="text"
                    value={jiraProjectKey}
                    onChange={(e) => setJiraProjectKey(e.target.value)}
                    placeholder="Project key (e.g. CORE)"
                    style={{ ...inputStyle({ maxWidth: '200px', fontSize: '12px' }) }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleQuickVerifyJira(); }}
                      disabled={quickVerifyBusy.length > 0 || Boolean(jiraVerifyDisabledReason)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${jiraVerified ? C.success : C.accent}`,
                        backgroundColor: jiraVerified ? 'rgba(63,185,80,0.12)' : C.accentDim,
                        color: jiraVerified ? C.success : C.accent,
                        fontSize: '12px',
                        cursor: (quickVerifyBusy.length > 0 || jiraVerifyDisabledReason) ? 'not-allowed' : 'pointer',
                        opacity: (quickVerifyBusy.length > 0 || jiraVerifyDisabledReason) ? 0.75 : 1,
                      }}
                    >
                      {quickVerifyBusy === 'jira' ? 'Verifying…' : jiraVerified ? 'Verified' : 'Connect & Verify'}
                    </button>
                    {jiraVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(jiraVerifiedAt).toLocaleString()}
                      </span>
                    )}
                    {jiraLastSuccessAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Last success {new Date(jiraLastSuccessAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {jiraVerifyDisabledReason && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{jiraVerifyDisabledReason}</p>
                  )}
                  {!jiraVerifyDisabledReason && jiraInlineStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: jiraVerified ? C.success : C.textSecondary }}>{jiraInlineStatus}</p>
                  )}
                  {!jiraVerified && jiraLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{jiraLastError}</p>
                  )}
                  <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr', maxWidth: '560px' }}>
                    <input
                      type="text"
                      value={jiraIssueSummary}
                      onChange={(e) => setJiraIssueSummary(e.target.value)}
                      placeholder="Issue summary"
                      style={{ ...inputStyle({ fontSize: '12px' }) }}
                    />
                    <input
                      type="text"
                      value={jiraIssueDescription}
                      onChange={(e) => setJiraIssueDescription(e.target.value)}
                      placeholder="Issue description (optional)"
                      style={{ ...inputStyle({ fontSize: '12px' }) }}
                    />
                  </div>
                  <button
                    onClick={() => { void handleJiraIssueCreate(); }}
                    disabled={integrationOpsBusy}
                    style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer', maxWidth: '150px' }}
                  >
                    Create Jira issue
                  </button>
                  <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr', maxWidth: '420px' }}>
                    <input
                      type="text"
                      value={jiraIssueKeyForTransition}
                      onChange={(e) => setJiraIssueKeyForTransition(e.target.value)}
                      placeholder="Issue key (e.g. CORE-42)"
                      style={{ ...inputStyle({ fontSize: '12px' }) }}
                    />
                    <input
                      type="text"
                      value={jiraTransitionId}
                      onChange={(e) => setJiraTransitionId(e.target.value)}
                      placeholder="Transition ID"
                      style={{ ...inputStyle({ fontSize: '12px' }) }}
                    />
                  </div>
                  <button
                    onClick={() => { void handleJiraTransition(); }}
                    disabled={integrationOpsBusy}
                    style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer', maxWidth: '185px' }}
                  >
                    Transition Jira issue
                  </button>
                  <IntegrationGuide
                    title="Full Jira setup guide"
                    steps={[
                      <>Create an Atlassian API token and use your Atlassian account email.</>,
                      <>Set Jira base URL and project key, then run <strong>Connect &amp; Verify</strong>.</>,
                      <>Use issue create + transition actions to drive task lifecycle from COMPaaS.</>,
                    ]}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                <p style={{ margin: 0, fontSize: '11px', color: C.textMuted }}>
                  Use advanced controls only for diagnostics, drift checks, and manual deploy operations.
                </p>
                <button
                  onClick={() => setShowAdvancedIntegrationControls((prev) => !prev)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '7px',
                    border: `1px solid ${C.border}`,
                    backgroundColor: C.surface,
                    color: C.textSecondary,
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  {showAdvancedIntegrationControls ? 'Hide Advanced Controls' : 'Show Advanced Controls'}
                </button>
              </div>
            </div>
          </Section>

          <Section title="Ship Loop Controls">
            <div style={{ display: 'grid', gap: '12px' }}>
              <div
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  border: `1px solid ${C.border}`,
                  backgroundColor: C.surfaceRaised,
                  display: 'grid',
                  gap: '8px',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>
                  GitHub PR quality gate profile
                </div>
                <p style={{ margin: 0, fontSize: '11px', color: C.textSecondary }}>
                  Choose the default rigor used for generated PR checklist quality.
                </p>
                <FloatingSelect
                  value={prQualityProfile}
                  options={[
                    { value: 'balanced', label: 'Balanced (Recommended)', description: 'Balanced quality and speed for most teams.' },
                    { value: 'strict', label: 'Strict', description: 'Higher validation depth before PR handoff.' },
                    { value: 'fast', label: 'Fast', description: 'Short checklist for rapid iteration cycles.' },
                  ]}
                  onChange={(value) => setPrQualityProfile(value === 'strict' || value === 'fast' ? value : 'balanced')}
                  ariaLabel="PR quality profile"
                  variant="input"
                  size="sm"
                  style={{ maxWidth: '260px' }}
                />
                {prProfileStatus && (
                  <p style={{ margin: 0, fontSize: '11px', color: C.textMuted }}>
                    {prProfileStatus}
                  </p>
                )}
              </div>
            </div>
          </Section>

          {showAdvancedIntegrationControls && (
          <Section title="Advanced Controls">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ padding: '12px', backgroundColor: C.surfaceRaised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Workspace Mode</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Choose where generated work is written and versioned</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: workspaceMode === 'local' ? 'rgba(63,185,80,0.12)' : 'rgba(59,142,255,0.14)', color: workspaceMode === 'local' ? C.success : C.accent, border: `1px solid ${workspaceMode === 'local' ? 'rgba(63,185,80,0.3)' : 'rgba(59,142,255,0.35)'}` }}>
                    {workspaceMode === 'github' ? 'GitHub mode' : workspaceMode === 'gitlab' ? 'GitLab mode' : 'Local mode'}
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
                  <button
                    onClick={() => setWorkspaceMode('gitlab')}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '7px',
                      border: `1px solid ${workspaceMode === 'gitlab' ? C.accent : C.border}`,
                      backgroundColor: workspaceMode === 'gitlab' ? C.accentDim : C.surface,
                      color: workspaceMode === 'gitlab' ? C.accent : C.textSecondary,
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    GitLab repo
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
                    placeholder="Default branch (example: main)"
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
                    <FloatingSelect
                      value={githubRepo}
                      options={githubRepoOptions.map((repo) => ({
                        value: repo.full_name,
                        label: repo.full_name,
                        description: `default branch: ${repo.default_branch}`,
                        keywords: [repo.full_name, repo.default_branch],
                      }))}
                      onChange={setGithubRepo}
                      searchable
                      ariaLabel="GitHub repository options"
                      variant="input"
                      size="sm"
                      style={{ maxWidth: '420px' }}
                    />
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
                    <div style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>Netlify Connector</div>
                    <div style={{ fontSize: '11px', color: C.textSecondary }}>Deploy generated apps directly to Netlify from the same workflow</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(59,142,255,0.14)', color: C.accent, border: `1px solid rgba(59,142,255,0.32)` }}>Deployment ready</span>
                </div>

                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                  <input
                    type="password"
                    value={netlifyToken}
                    onChange={(e) => { setNetlifyToken(e.target.value); }}
                    placeholder={netlifyTokenMasked ? 'Saved (hidden). Type to replace.' : 'Netlify token (nfp_...)'}
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onInput={() => { setNetlifyTokenMasked(false); }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <input
                    type="text"
                    value={netlifyTeamId}
                    onChange={(e) => setNetlifyTeamId(e.target.value)}
                    placeholder="Team ID (optional)"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <input
                    type="text"
                    value={netlifySiteId}
                    onChange={(e) => setNetlifySiteId(e.target.value)}
                    placeholder="Site ID"
                    style={{ ...inputStyle({ maxWidth: '420px', fontSize: '12px' }) }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                </div>
                <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => handleNetlifyOp('preview')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Preview deploy
                    </button>
                    <button
                      onClick={() => handleNetlifyOp('production')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.warning}`, backgroundColor: 'transparent', color: C.warning, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Production deploy
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={netlifyDomain}
                      onChange={(e) => setNetlifyDomain(e.target.value)}
                      placeholder="example.com"
                      style={{ ...inputStyle({ maxWidth: '220px', fontSize: '12px' }) }}
                    />
                    <button
                      onClick={() => handleNetlifyOp('domain')}
                      disabled={integrationOpsBusy}
                      style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${C.border}`, backgroundColor: C.surface, color: C.textSecondary, fontSize: '12px', cursor: 'pointer' }}
                    >
                      Assign domain
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={netlifyEnvKey}
                      onChange={(e) => setNetlifyEnvKey(e.target.value)}
                      placeholder="ENV_KEY"
                      style={{ ...inputStyle({ maxWidth: '160px', fontSize: '12px' }) }}
                    />
                    <input
                      type="text"
                      value={netlifyEnvValue}
                      onChange={(e) => setNetlifyEnvValue(e.target.value)}
                      placeholder="ENV_VALUE"
                      style={{ ...inputStyle({ maxWidth: '220px', fontSize: '12px' }) }}
                    />
                    <button
                      onClick={() => handleNetlifyOp('env')}
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
                  <span style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    backgroundColor: 'rgba(63,185,80,0.12)',
                    color: connectorStatusColor(slackStatus),
                    border: `1px solid ${C.border}`,
                  }}
                  >
                    {connectorStatusLabel(slackStatus)}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr' }}>
                  <input type="password" value={slackToken} onChange={(e) => { setSlackToken(e.target.value); }}
                    placeholder={slackTokenMasked ? 'Saved (hidden). Type to replace.' : 'xoxb-xxxx (Bot token)'}
                    style={{ ...inputStyle({ maxWidth: '380px', fontSize: '12px' }) }}
                    onInput={() => { setSlackTokenMasked(false); }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <input
                    type="text"
                    value={slackDefaultChannel}
                    onChange={(e) => setSlackDefaultChannel(e.target.value)}
                    placeholder="#channel-or-C12345678"
                    style={{ ...inputStyle({ maxWidth: '320px', fontSize: '12px' }) }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { void handleSlackRetry(); }}
                      disabled={slackRetryBusy || integrationOpsBusy}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: `1px solid ${C.border}`,
                        backgroundColor: C.surface,
                        color: C.textSecondary,
                        fontSize: '12px',
                        cursor: (slackRetryBusy || integrationOpsBusy) ? 'not-allowed' : 'pointer',
                        opacity: (slackRetryBusy || integrationOpsBusy) ? 0.75 : 1,
                      }}
                    >
                      {slackRetryBusy ? 'Retrying…' : 'Retry Outbound'}
                    </button>
                    {slackVerifiedAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Verified {new Date(slackVerifiedAt).toLocaleString()}
                      </span>
                    )}
                    {slackLastSuccessAt && (
                      <span style={{ fontSize: '11px', color: C.textMuted }}>
                        Last success {new Date(slackLastSuccessAt).toLocaleString()}
                      </span>
                    )}
                    {slackConsecutiveFailures > 0 && (
                      <span style={{ fontSize: '11px', color: C.warning }}>
                        {slackConsecutiveFailures} failure{slackConsecutiveFailures === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  {slackLastError && (
                    <p style={{ margin: 0, fontSize: '11px', color: C.warning }}>{slackLastError}</p>
                  )}
                  {slackRetryStatus && (
                    <p style={{ margin: 0, fontSize: '11px', color: slackRetryStatus.toLowerCase().includes('failed') ? C.warning : C.textSecondary }}>
                      {slackRetryStatus}
                    </p>
                  )}
                </div>
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
              <div style={{ marginTop: '12px' }}>
                <InlineActionCard
                  title="Integration operation status"
                  message={integrationOpsStatus}
                  severity={integrationOpsStatus.toLowerCase().includes('failed') || integrationOpsStatus.toLowerCase().includes('required') ? 'warning' : 'info'}
                  actions={[
                    { id: 'copy-integration-status', label: 'Copy diagnostics', kind: 'copy', payload: { text: integrationOpsStatus } },
                  ]}
                  onAction={(action) => {
                    if (action.id === 'copy-integration-status') {
                      const text = String(action.payload?.text || integrationOpsStatus || '').trim();
                      if (text) void navigator.clipboard.writeText(text);
                    }
                  }}
                />
              </div>
            )}
          </Section>
          )}
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
            <div role="alert" style={{ minWidth: '280px', maxWidth: '520px' }}>
              <InlineActionCard
                title="Settings save failed"
                message={saveError}
                severity="error"
                actions={[
                  { id: 'retry-save', label: 'Retry save', kind: 'retry' },
                  { id: 'copy-save-error', label: 'Copy diagnostics', kind: 'copy', payload: { text: saveError } },
                ]}
                onAction={(action) => {
                  if (action.id === 'retry-save') {
                    void handleSave();
                    return;
                  }
                  if (action.id === 'copy-save-error') {
                    const text = String(action.payload?.text || saveError || '').trim();
                    if (text) void navigator.clipboard.writeText(text);
                  }
                }}
              />
            </div>
          )}
        </div>
      )}

      <div
        style={{
          marginTop: '8px',
          paddingTop: '12px',
          borderTop: `1px solid ${C.border}`,
          fontSize: '11px',
          color: C.textMuted,
          textAlign: 'right',
        }}
      >
        Built by Idan H.
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
