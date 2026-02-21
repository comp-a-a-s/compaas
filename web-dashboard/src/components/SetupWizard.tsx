import React, { useState } from 'react';
import { saveSetupConfig, testLlmConnection } from '../api/client';
import type { AppConfig, LlmConfig } from '../types';
import { useThemeSwitch } from '../hooks/useTheme';
import type { ThemeName } from '../hooks/useTheme';
import CompassRoseLogo from './CompassRoseLogo';

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

const TOTAL_STEPS = 7;
const TELEGRAM_KEYS = {
  token: 'compaas_telegram_token',
  chatId: 'compaas_telegram_chatid',
  configured: 'compaas_telegram_configured',
} as const;

const AGENT_DEFAULTS: AgentDefault[] = [
  { id: 'ceo', role: 'CEO', defaultName: 'Marcus' },
  { id: 'cto', role: 'CTO', defaultName: 'Elena' },
  { id: 'chief-researcher', role: 'Chief Researcher', defaultName: 'Victor' },
  { id: 'ciso', role: 'CISO', defaultName: 'Rachel' },
  { id: 'cfo', role: 'CFO', defaultName: 'Jonathan' },
  { id: 'vp-product', role: 'VP Product', defaultName: 'Sarah' },
  { id: 'vp-engineering', role: 'VP Engineering', defaultName: 'David' },
  { id: 'lead-backend', role: 'Lead Backend', defaultName: 'James' },
  { id: 'lead-frontend', role: 'Lead Frontend', defaultName: 'Priya' },
  { id: 'lead-designer', role: 'Lead Designer', defaultName: 'Lena' },
  { id: 'qa-lead', role: 'QA Lead', defaultName: 'Carlos' },
  { id: 'devops', role: 'DevOps', defaultName: 'Nina' },
  { id: 'security-engineer', role: 'Security Engineer', defaultName: 'Alex' },
  { id: 'data-engineer', role: 'Data Engineer', defaultName: 'Maya' },
  { id: 'tech-writer', role: 'Tech Writer', defaultName: 'Tom' },
];

const POLL_INTERVAL_OPTIONS = [
  { label: '3 seconds', value: 3000 },
  { label: '5 seconds', value: 5000 },
  { label: '10 seconds', value: 10000 },
  { label: '30 seconds', value: 30000 },
];

// Name templates for crew (keyed by agent IDs)
const NAME_TEMPLATES: Record<string, Record<string, string>> = {
  'Classic Tech': {
    ceo: 'Marcus', cto: 'Elena', 'chief-researcher': 'Victor', ciso: 'Rachel',
    cfo: 'Jonathan', 'vp-product': 'Sarah', 'vp-engineering': 'David', 'lead-backend': 'James',
    'lead-frontend': 'Priya', 'lead-designer': 'Lena', 'qa-lead': 'Carlos', devops: 'Nina',
    'security-engineer': 'Alex', 'data-engineer': 'Maya', 'tech-writer': 'Tom',
  },
  'Silicon Valley': {
    ceo: 'Mark', cto: 'Susan', 'chief-researcher': 'Vinod', ciso: 'Emily',
    cfo: 'Peter', 'vp-product': 'Marissa', 'vp-engineering': 'Reid', 'lead-backend': 'Jeff',
    'lead-frontend': 'Sheryl', 'lead-designer': 'Jessica', 'qa-lead': 'Larry', devops: 'Diane',
    'security-engineer': 'Kevin', 'data-engineer': 'Lisa', 'tech-writer': 'Bill',
  },
  'Mythology': {
    ceo: 'Zeus', cto: 'Athena', 'chief-researcher': 'Apollo', ciso: 'Artemis',
    cfo: 'Hermes', 'vp-product': 'Hera', 'vp-engineering': 'Hephaestus', 'lead-backend': 'Ares',
    'lead-frontend': 'Aphrodite', 'lead-designer': 'Persephone', 'qa-lead': 'Dionysus', devops: 'Nike',
    'security-engineer': 'Poseidon', 'data-engineer': 'Demeter', 'tech-writer': 'Prometheus',
  },
  'Avengers': {
    ceo: 'Tony', cto: 'Pepper', 'chief-researcher': 'Bruce', ciso: 'Natasha',
    cfo: 'Nick', 'vp-product': 'Wanda', 'vp-engineering': 'Thor', 'lead-backend': 'Steve',
    'lead-frontend': 'Shuri', 'lead-designer': 'Carol', 'qa-lead': 'Clint', devops: 'Hope',
    'security-engineer': 'Scott', 'data-engineer': 'Maria', 'tech-writer': 'Vision',
  },
};

// Theme options
const THEMES = [
  { id: 'midnight', label: 'Midnight', description: 'High-contrast deep blue', preview: ['#070f19', '#17293d', '#edf5ff'] },
  { id: 'twilight', label: 'Twilight', description: 'Moody indigo dusk', preview: ['#181626', '#312f4a', '#f3f4ff'] },
  { id: 'dawn', label: 'Dawn', description: 'Muted warm daylight', preview: ['#efe9de', '#ece4d6', '#2f3a45'] },
  { id: 'sahara', label: 'Sahara', description: 'Soft desert parchment', preview: ['#f2e7d4', '#efe1cb', '#3f3325'] },
];

// ---- Colours (CSS variables only) ----

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

function MaterialIcon({ path, size = 20 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={path} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICON_PATHS = {
  agents: 'M16 11a4 4 0 1 0-8 0m11 8v-1a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v1M8 7a2 2 0 1 0-4 0m20 0a2 2 0 1 1-4 0',
  chat: 'M8 10h8M8 14h5M4 20l3-3h11a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12z',
  projects: 'M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  monitor: 'M4 18h16M7 14l3-4 3 2 4-6',
  anthropic: 'M12 3l7 4v10l-7 4-7-4V7l7-4z',
  openai: 'M12 4l3 2 3 0 2 3-1 3 1 3-2 3-3 0-3 2-3-2-3 0-2-3 1-3-1-3 2-3 3 0 3-2z',
  local: 'M5 18h14M6 6h12l2 8H4l2-8z',
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
  const features = [
    { icon: <MaterialIcon path={ICON_PATHS.agents} />, label: 'Team of 15 AI agents', desc: 'Engineering, Product, Research & Ops' },
    { icon: <MaterialIcon path={ICON_PATHS.chat} />, label: 'Chat with CEO', desc: 'Direct access to your AI CEO' },
    { icon: <MaterialIcon path={ICON_PATHS.projects} />, label: 'Track projects & tasks', desc: 'Kanban boards and task management' },
    { icon: <MaterialIcon path={ICON_PATHS.monitor} />, label: 'Real-time monitoring', desc: 'Live activity feed and metrics' },
  ];

  return (
    <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
      <div style={{ margin: '0 auto 24px', width: '56px' }}>
        <CompassRoseLogo size={56} />
      </div>
      <h2 style={{ fontSize: '22px', fontWeight: 700, color: C.textPrimary, marginBottom: '12px' }}>
        Welcome to COMPaaS
      </h2>
      <p style={{ fontSize: '14px', color: C.textSecondary, lineHeight: '1.6', maxWidth: '480px', margin: '0 auto 24px' }}>
        COMPaaS is your AI-powered virtual company dashboard. You direct a team of 15 autonomous agents
        across engineering, product, research, and operations. This wizard takes about 2 minutes to configure
        your workspace.
      </p>

      {/* Features grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', maxWidth: '480px', margin: '0 auto', textAlign: 'left' }}>
        {features.map((f) => (
          <div
            key={f.label}
            style={{
              backgroundColor: C.surfaceRaised,
              border: `1px solid ${C.border}`,
              borderRadius: '8px',
              padding: '12px',
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-start',
            }}
          >
            <span style={{ fontSize: '18px', flexShrink: 0, marginTop: '1px', color: C.accent }}>{f.icon}</span>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: C.textPrimary, marginBottom: '2px' }}>{f.label}</div>
              <div style={{ fontSize: '11px', color: C.textSecondary }}>{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- AI Provider presets ----

type LlmProvider = 'anthropic' | 'openai' | 'openai_compat';
type AnthropicMode = 'cli' | 'apikey';
type OpenaiMode    = 'apikey' | 'codex';
type LocalPreset   = 'ollama' | 'lmstudio' | 'llamacpp' | 'jan' | 'vllm' | 'custom';

const LOCAL_PRESETS: { id: LocalPreset; label: string; baseUrl: string; apiKey: string; placeholder: string }[] = [
  { id: 'ollama',    label: 'Ollama',    baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama',    placeholder: 'llama3.3' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1',  apiKey: 'lm-studio', placeholder: 'llama-3.3-70b-instruct' },
  { id: 'llamacpp',  label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1',  apiKey: 'none',      placeholder: 'default' },
  { id: 'jan',       label: 'Jan',       baseUrl: 'http://localhost:1337/v1',  apiKey: 'jan',       placeholder: 'llama3.3-70b-instruct' },
  { id: 'vllm',      label: 'vLLM',      baseUrl: 'http://localhost:8000/v1',  apiKey: 'vllm',      placeholder: 'meta-llama/Llama-3.3-70B-Instruct' },
  { id: 'custom',   label: 'Custom',    baseUrl: '',                          apiKey: '',          placeholder: 'my-model' },
];

// Current recommended models as of 2025
const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-6',          label: 'Opus 4.6 ★',     note: 'Most capable — complex tasks' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5',  note: 'Balanced speed & quality' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5',   note: 'Fastest & lowest cost' },
  { id: 'custom',                    label: 'Custom',        note: '' },
];

const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1', 'o1-mini', 'custom'];

const LOCAL_MODEL_SUGGESTIONS: Record<LocalPreset, string[]> = {
  ollama:    ['llama3.3', 'llama3.2', 'deepseek-r1', 'qwen2.5-coder', 'mistral', 'gemma3', 'phi4'],
  lmstudio:  ['llama-3.3-70b-instruct', 'deepseek-r1-distill-llama-70b', 'qwen2.5-coder-32b', 'gemma-3-27b-it'],
  llamacpp:  ['llama-3.3-70b', 'mistral-7b', 'deepseek-coder', 'qwen2.5-7b'],
  jan:       ['llama3.3-70b-instruct', 'mistral-7b-instruct', 'qwen2.5-coder-7b'],
  vllm:      ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-Coder-32B-Instruct', 'mistralai/Mistral-7B-Instruct-v0.3'],
  custom:    [],
};

// Guide box shown inside provider cards
function GuideBox({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, marginTop: '10px', paddingTop: '10px' }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: '11px', fontWeight: 600, color: C.accent,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}
      >
        <span style={{ fontSize: '10px', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'none', display: 'inline-block' }}>▶</span>
        {open ? 'Hide setup guide' : 'How to set up →'}
      </button>
      {open && (
        <div
          style={{
            marginTop: '10px', padding: '12px',
            backgroundColor: C.surface, borderRadius: '8px',
            border: `1px solid ${C.border}`,
            fontSize: '12px', color: C.textSecondary, lineHeight: '1.6',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Inline link style used in guides
const guideLink: React.CSSProperties = {
  color: C.accent, textDecoration: 'underline', cursor: 'pointer',
};

// Code snippet style
function Code({ children }: { children: string }) {
  return (
    <code style={{
      backgroundColor: 'rgba(0,0,0,0.2)', padding: '1px 5px', borderRadius: '4px',
      fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: C.textPrimary,
    }}>
      {children}
    </code>
  );
}

// Sub-tab selector used inside provider cards
function SubTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        padding: '4px 12px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer',
        border: `1px solid ${active ? C.accent : C.border}`,
        backgroundColor: active ? 'rgba(88,166,255,0.15)' : C.surface,
        color: active ? C.accent : C.textSecondary,
        transition: 'all 0.15s',
        fontWeight: active ? 600 : 400,
      }}
    >{label}</button>
  );
}

interface ProviderCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}

function ProviderCard({ icon, title, description, selected, onClick, children }: ProviderCardProps) {
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', padding: '14px 16px',
        borderRadius: '10px', cursor: 'pointer',
        border: `2px solid ${selected ? C.accent : C.border}`,
        backgroundColor: selected ? C.accentDim : C.surfaceRaised,
        transition: 'all 0.15s', marginBottom: '10px', outline: 'none',
      }}
      onFocus={(e) => { e.currentTarget.style.boxShadow = `0 0 0 2px ${C.accentDim}`; }}
      onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: selected && children ? '14px' : 0 }}>
        <span style={{ fontSize: '22px', flexShrink: 0, color: selected ? C.accent : C.textSecondary }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: C.textPrimary, marginBottom: '2px' }}>{title}</div>
          <div style={{ fontSize: '12px', color: C.textSecondary }}>{description}</div>
        </div>
        <div style={{
          width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
          border: `2px solid ${selected ? C.accent : C.border}`,
          backgroundColor: selected ? C.accent : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {selected && <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: C.bg }} />}
        </div>
      </div>
      {selected && children && (
        <div onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </button>
  );
}

function StepAiProvider({
  llmProvider, setLlmProvider,
  anthropicMode, setAnthropicMode,
  anthropicApiKey, setAnthropicApiKey,
  anthropicModelPreset, setAnthropicModelPreset,
  openaiMode, setOpenaiMode,
  localPreset, setLocalPreset,
  llmBaseUrl, setLlmBaseUrl,
  llmModel, setLlmModel,
  llmApiKey, setLlmApiKey,
  openaiModelPreset, setOpenaiModelPreset,
  proxyEnabled, setProxyEnabled,
  proxyUrl, setProxyUrl,
}: {
  llmProvider: LlmProvider;              setLlmProvider: (v: LlmProvider) => void;
  anthropicMode: AnthropicMode;          setAnthropicMode: (v: AnthropicMode) => void;
  anthropicApiKey: string;               setAnthropicApiKey: (v: string) => void;
  anthropicModelPreset: string;          setAnthropicModelPreset: (v: string) => void;
  openaiMode: OpenaiMode;                setOpenaiMode: (v: OpenaiMode) => void;
  localPreset: LocalPreset;              setLocalPreset: (v: LocalPreset) => void;
  llmBaseUrl: string;                    setLlmBaseUrl: (v: string) => void;
  llmModel: string;                      setLlmModel: (v: string) => void;
  llmApiKey: string;                     setLlmApiKey: (v: string) => void;
  openaiModelPreset: string;             setOpenaiModelPreset: (v: string) => void;
  proxyEnabled: boolean;                 setProxyEnabled: (v: boolean) => void;
  proxyUrl: string;                      setProxyUrl: (v: string) => void;
}) {
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const handleLocalPreset = (preset: LocalPreset) => {
    setLocalPreset(preset);
    const p = LOCAL_PRESETS.find((x) => x.id === preset)!;
    setLlmBaseUrl(p.baseUrl);
    setLlmApiKey(p.apiKey);
    if (!llmModel || llmModel === LOCAL_PRESETS.find((x) => x.id !== preset)?.placeholder) {
      setLlmModel(p.placeholder);
    }
  };

  const handleOpenaiModel = (m: string) => {
    setOpenaiModelPreset(m);
    if (m !== 'custom') setLlmModel(m);
  };

  // Resolve test connection params based on current selection
  const getTestParams = () => {
    if (llmProvider === 'anthropic' && anthropicMode === 'apikey') {
      return { base_url: 'https://api.anthropic.com/v1', model: anthropicModelPreset === 'custom' ? llmModel : anthropicModelPreset, api_key: anthropicApiKey };
    }
    if (llmProvider === 'openai') {
      return { base_url: 'https://api.openai.com/v1', model: openaiModelPreset !== 'custom' ? openaiModelPreset : llmModel, api_key: llmApiKey };
    }
    return { base_url: llmBaseUrl, model: llmModel, api_key: llmApiKey };
  };

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    const params = getTestParams();
    const result = await testLlmConnection(params);
    setTestStatus(result.status);
    setTestMessage(result.message);
  };

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        AI Provider
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '20px' }}>
        Choose how your AI agents communicate. You can change this later in Settings.
      </p>

      {/* ── Anthropic ── */}
      <ProviderCard
        icon={<MaterialIcon path={ICON_PATHS.anthropic} />} selected={llmProvider === 'anthropic'}
        title="Anthropic (Recommended)"
        description="Claude Opus 4 / Sonnet 4 / Haiku 4.5 — world's best reasoning and tool-use. Via CLI or direct API key."
        onClick={() => setLlmProvider('anthropic')}
      >
        {/* Sub-mode tabs */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
          <SubTab label="Claude Code CLI" active={anthropicMode === 'cli'} onClick={() => setAnthropicMode('cli')} />
          <SubTab label="API Key (direct)" active={anthropicMode === 'apikey'} onClick={() => setAnthropicMode('apikey')} />
        </div>

        {/* Model picker — shared across both modes */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Model
          </label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '4px' }}>
            {ANTHROPIC_MODELS.map((m) => (
              <button key={m.id} onClick={() => setAnthropicModelPreset(m.id)} style={{
                padding: '4px 10px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer',
                border: `1px solid ${anthropicModelPreset === m.id ? C.accent : C.border}`,
                backgroundColor: anthropicModelPreset === m.id ? 'rgba(88,166,255,0.15)' : C.surface,
                color: anthropicModelPreset === m.id ? C.accent : C.textSecondary,
              }}>{m.label}</button>
            ))}
          </div>
          {anthropicModelPreset === 'custom' && (
            <input
              type="text" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}
              placeholder="e.g. claude-opus-4-6"
              style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          )}
          <p style={{ fontSize: '10px', color: C.textMuted, margin: '4px 0 0' }}>
            ★ Opus 4.6 — most capable. Sonnet 4.5 — balanced. Haiku 4.5 — fastest &amp; cheapest.
          </p>
        </div>

        {/* CLI mode */}
        {anthropicMode === 'cli' && (
          <GuideBox>
            <strong style={{ color: C.textPrimary }}>Setting up Claude Code CLI</strong>
            <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
              <li style={{ marginBottom: '6px' }}>
                <strong>Install Node.js 18+</strong> if not already installed:<br />
                <a href="https://nodejs.org" target="_blank" rel="noreferrer" style={guideLink}>nodejs.org</a>
                {' '}— download the LTS installer for your OS
              </li>
              <li style={{ marginBottom: '6px' }}>
                <strong>Install Claude Code globally:</strong><br />
                <Code>npm install -g @anthropic-ai/claude-code</Code>
              </li>
              <li style={{ marginBottom: '6px' }}>
                <strong>Get your Anthropic API key</strong> at{' '}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={guideLink}>
                  console.anthropic.com/settings/keys
                </a>
                {' '}→ sign up → <em>Create Key</em>
              </li>
              <li style={{ marginBottom: '6px' }}>
                <strong>Set the key in your shell:</strong><br />
                <Code>export ANTHROPIC_API_KEY=sk-ant-api03-...</Code><br />
                <span style={{ fontSize: '11px', color: C.textMuted }}>Add to ~/.bashrc or ~/.zshrc so it persists across terminals.</span>
              </li>
              <li>
                <strong>Verify the install:</strong><br />
                <Code>claude --version</Code><br />
                <span style={{ fontSize: '11px', color: C.textMuted }}>Should print a version like "1.x.x"</span>
              </li>
            </ol>
            <div style={{ marginTop: '10px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
              <strong style={{ color: C.accent, fontSize: '11px' }}>Why CLI?</strong>{' '}
              <span style={{ fontSize: '11px' }}>The CLI handles auth, tool use, and streaming with built-in retries. No API key management needed in COMPaaS — the CLI handles it.</span>
            </div>
          </GuideBox>
        )}

        {/* API key mode */}
        {anthropicMode === 'apikey' && (
          <>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Anthropic API Key
              </label>
              <input
                type="password" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)}
                placeholder="sk-ant-api03-..."
                style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
              <p style={{ fontSize: '10px', color: C.textMuted, margin: '4px 0 0' }}>
                Your key is stored locally and sent only to Anthropic's API.
              </p>
            </div>
            <TestConnectionButton status={testStatus} message={testMessage} onTest={handleTest} />
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>How to get your Anthropic API key</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  Go to{' '}
                  <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={guideLink}>console.anthropic.com</a>
                  {' '}and create a free account (credit card required for paid tier)
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Navigate to <strong>Settings → API Keys</strong> → click <strong>Create Key</strong>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Copy the key — it starts with <Code>sk-ant-api03-</Code>
                </li>
                <li>Paste it above. COMPaaS sends it directly to <Code>api.anthropic.com</Code></li>
              </ol>
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
                <strong style={{ color: C.accent, fontSize: '11px' }}>Pricing:</strong>{' '}
                <span style={{ fontSize: '11px' }}>Opus 4.6 ~$15/M input tokens. Sonnet 4.5 ~$3/M. Haiku 4.5 ~$0.80/M.{' '}
                  Set limits at{' '}
                  <a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer" style={guideLink}>console.anthropic.com/settings/limits</a>
                </span>
              </div>
            </GuideBox>
          </>
        )}
      </ProviderCard>

      {/* ── OpenAI ── */}
      <ProviderCard
        icon={<MaterialIcon path={ICON_PATHS.openai} />} selected={llmProvider === 'openai'}
        title="OpenAI"
        description="GPT-4o, o3-mini, o1 — cloud models. Works via API key or the Codex CLI."
        onClick={() => setLlmProvider('openai')}
      >
        {/* Sub-mode tabs */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
          <SubTab label="API Key" active={openaiMode === 'apikey'} onClick={() => setOpenaiMode('apikey')} />
          <SubTab label="Codex CLI" active={openaiMode === 'codex'} onClick={() => setOpenaiMode('codex')} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Model picker — shown for both modes */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Model
            </label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
              {OPENAI_MODELS.map((m) => (
                <button key={m} onClick={() => handleOpenaiModel(m)} style={{
                  padding: '4px 10px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer',
                  border: `1px solid ${openaiModelPreset === m ? C.accent : C.border}`,
                  backgroundColor: openaiModelPreset === m ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: openaiModelPreset === m ? C.accent : C.textSecondary,
                }}>
                  {m === 'gpt-4o' ? 'gpt-4o ★' : m}
                </button>
              ))}
            </div>
            {openaiModelPreset === 'custom' && (
              <input
                type="text" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}
                placeholder="e.g. gpt-4o-2024-11-20"
                style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            )}
            <p style={{ fontSize: '10px', color: C.textMuted, margin: '4px 0 0' }}>
              ★ gpt-4o — best balance of speed &amp; cost. o3-mini / o1 — stronger reasoning.
            </p>
          </div>

          {/* API key — shown for both modes (Codex CLI also needs OPENAI_API_KEY) */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              OpenAI API Key
            </label>
            <input
              type="password" value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder="sk-..."
              style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>

          <TestConnectionButton status={testStatus} message={testMessage} onTest={handleTest} />

          {/* API Key guide */}
          {openaiMode === 'apikey' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Getting your OpenAI API key</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  Create an account at{' '}
                  <a href="https://platform.openai.com" target="_blank" rel="noreferrer" style={guideLink}>platform.openai.com</a>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Go to <strong>Dashboard → API Keys</strong> → <strong>Create new secret key</strong>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Copy the key (starts with <Code>sk-</Code>) and paste it above
                </li>
                <li>
                  Optional — add a spending limit at{' '}
                  <a href="https://platform.openai.com/settings/organization/limits" target="_blank" rel="noreferrer" style={guideLink}>
                    platform.openai.com/settings/organization/limits
                  </a>
                </li>
              </ol>
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
                <strong style={{ color: C.accent, fontSize: '11px' }}>Pricing:</strong>{' '}
                <span style={{ fontSize: '11px' }}>gpt-4o ~$2.50/M input. o3-mini ~$1.10/M. o1 ~$15/M.</span>
              </div>
            </GuideBox>
          )}

          {/* Codex CLI guide */}
          {openaiMode === 'codex' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Setting up OpenAI Codex CLI</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Install Node.js 18+</strong> from{' '}
                  <a href="https://nodejs.org" target="_blank" rel="noreferrer" style={guideLink}>nodejs.org</a>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Install the Codex CLI:</strong><br />
                  <Code>npm install -g @openai/codex</Code>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Set your OpenAI API key in your shell</strong> (Codex CLI reads it automatically):<br />
                  <Code>export OPENAI_API_KEY=sk-...</Code><br />
                  <span style={{ fontSize: '11px', color: C.textMuted }}>Add to ~/.bashrc or ~/.zshrc to persist.</span>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Verify install:</strong><br />
                  <Code>codex --version</Code>
                </li>
                <li>
                  <strong>Also paste the same key above</strong> — COMPaaS uses it for direct API calls in addition to the CLI.
                </li>
              </ol>
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
                <strong style={{ color: C.accent, fontSize: '11px' }}>About Codex CLI:</strong>{' '}
                <span style={{ fontSize: '11px' }}>OpenAI's terminal coding agent. Same API key as above — the CLI handles tool execution locally while COMPaaS coordinates the agents via API.</span>
              </div>
            </GuideBox>
          )}
        </div>
      </ProviderCard>

      {/* ── Local Model ── */}
      <ProviderCard
        icon={<MaterialIcon path={ICON_PATHS.local} />} selected={llmProvider === 'openai_compat'}
        title="Local / Self-Hosted"
        description="Ollama, LM Studio, llama.cpp, Jan, vLLM — run models on your own machine. Free, private, no cloud."
        onClick={() => setLlmProvider('openai_compat')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Preset tabs */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Server
            </label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {LOCAL_PRESETS.map((p) => (
                <button key={p.id} onClick={() => handleLocalPreset(p.id)} style={{
                  padding: '4px 10px', borderRadius: '5px', fontSize: '12px', cursor: 'pointer',
                  border: `1px solid ${localPreset === p.id ? C.accent : C.border}`,
                  backgroundColor: localPreset === p.id ? 'rgba(88,166,255,0.15)' : C.surface,
                  color: localPreset === p.id ? C.accent : C.textSecondary,
                }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {/* Base URL */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Base URL
            </label>
            <input
              type="text" value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
          {/* Model name + quick-pick */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Model Name
            </label>
            <input
              type="text" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}
              placeholder={LOCAL_PRESETS.find((p) => p.id === localPreset)?.placeholder ?? 'llama3.3'}
              style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
            {/* Quick picks */}
            {LOCAL_MODEL_SUGGESTIONS[localPreset]?.length > 0 && (
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                {LOCAL_MODEL_SUGGESTIONS[localPreset].map((m) => (
                  <button key={m} onClick={() => setLlmModel(m)} style={{
                    padding: '2px 7px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
                    border: `1px solid ${llmModel === m ? C.accent : C.border}`,
                    backgroundColor: llmModel === m ? 'rgba(88,166,255,0.15)' : 'transparent',
                    color: llmModel === m ? C.accent : C.textMuted,
                  }}>{m}</button>
                ))}
              </div>
            )}
          </div>
          {/* Test button */}
          <TestConnectionButton status={testStatus} message={testMessage} onTest={handleTest} />
          {/* Per-preset guide */}
          {localPreset === 'ollama' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Setting up Ollama</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  Download Ollama from{' '}
                  <a href="https://ollama.com/download" target="_blank" rel="noreferrer" style={guideLink}>ollama.com/download</a>
                  {' '}(macOS, Linux, Windows)
                </li>
                <li style={{ marginBottom: '6px' }}>Pull a model:<br /><Code>ollama pull llama3.3</Code></li>
                <li style={{ marginBottom: '6px' }}>Start the server (runs automatically after install):<br /><Code>ollama serve</Code></li>
                <li>COMPaaS connects to <Code>http://localhost:11434/v1</Code> — no API key needed</li>
              </ol>
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
                <strong style={{ color: C.accent, fontSize: '11px' }}>Recommended models:</strong>{' '}
                <span style={{ fontSize: '11px' }}>llama3.3 (best), deepseek-r1 (reasoning), qwen2.5-coder (coding)</span><br />
                <span style={{ fontSize: '11px', color: C.textMuted }}>Browse all models: <a href="https://ollama.com/library" target="_blank" rel="noreferrer" style={guideLink}>ollama.com/library</a></span>
              </div>
            </GuideBox>
          )}
          {localPreset === 'lmstudio' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Setting up LM Studio</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  Download from{' '}
                  <a href="https://lmstudio.ai" target="_blank" rel="noreferrer" style={guideLink}>lmstudio.ai</a>
                </li>
                <li style={{ marginBottom: '6px' }}>In LM Studio, go to the <strong>Discover</strong> tab and download a model</li>
                <li style={{ marginBottom: '6px' }}>Go to <strong>Local Server</strong> tab → Start Server</li>
                <li>COMPaaS connects to <Code>http://localhost:1234/v1</Code></li>
              </ol>
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
                <strong style={{ color: C.accent, fontSize: '11px' }}>Recommended models:</strong>{' '}
                <span style={{ fontSize: '11px' }}>llama-3.3-70b-instruct, deepseek-r1-distill-llama-70b, qwen2.5-coder-32b</span>
              </div>
            </GuideBox>
          )}
          {localPreset === 'llamacpp' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Setting up llama.cpp server</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  Get llama.cpp from{' '}
                  <a href="https://github.com/ggerganov/llama.cpp" target="_blank" rel="noreferrer" style={guideLink}>github.com/ggerganov/llama.cpp</a>
                </li>
                <li style={{ marginBottom: '6px' }}>Build it: <Code>make</Code></li>
                <li style={{ marginBottom: '6px' }}>Download a GGUF model from{' '}
                  <a href="https://huggingface.co/models?library=gguf" target="_blank" rel="noreferrer" style={guideLink}>HuggingFace</a>
                </li>
                <li>Start the server:<br /><Code>./llama-server -m model.gguf --port 8080</Code></li>
              </ol>
            </GuideBox>
          )}
          {localPreset === 'jan' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Setting up Jan</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  Download Jan from{' '}
                  <a href="https://jan.ai" target="_blank" rel="noreferrer" style={guideLink}>jan.ai</a>
                  {' '}(macOS, Linux, Windows)
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Open Jan → go to the <strong>Hub</strong> tab → download a model
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Go to <strong>Settings → Advanced</strong> → enable <strong>API Server</strong>
                </li>
                <li>COMPaaS connects to <Code>http://localhost:1337/v1</Code></li>
              </ol>
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
                <strong style={{ color: C.accent, fontSize: '11px' }}>Note:</strong>{' '}
                <span style={{ fontSize: '11px' }}>Jan is a great desktop-first alternative to LM Studio with a clean UI and one-click model downloads.</span>
              </div>
            </GuideBox>
          )}
          {localPreset === 'vllm' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Setting up vLLM (GPU server)</strong>
              <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Requires Python 3.9+ and CUDA GPU (NVIDIA)</strong>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Install vLLM:<br />
                  <Code>pip install vllm</Code>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  (Optional) Set HuggingFace token for gated models:<br />
                  <Code>export HF_TOKEN=hf_...</Code>
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Start the server with your chosen model:<br />
                  <Code>vllm serve meta-llama/Llama-3.3-70B-Instruct --port 8000</Code>
                </li>
                <li>
                  COMPaaS connects to <Code>http://localhost:8000/v1</Code>
                </li>
              </ol>
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'rgba(88,166,255,0.08)', borderRadius: '6px', border: `1px solid ${C.border}` }}>
                <strong style={{ color: C.accent, fontSize: '11px' }}>Best for:</strong>{' '}
                <span style={{ fontSize: '11px' }}>High-throughput production deployments with NVIDIA GPU. Supports continuous batching and 70B+ models with multi-GPU. Browse models at{' '}
                  <a href="https://huggingface.co/models" target="_blank" rel="noreferrer" style={guideLink}>huggingface.co/models</a>
                </span>
              </div>
            </GuideBox>
          )}
          {localPreset === 'custom' && (
            <GuideBox>
              <strong style={{ color: C.textPrimary }}>Custom OpenAI-compatible server</strong>
              <p style={{ margin: '6px 0 0' }}>
                Any server that implements the OpenAI chat completions API (<Code>/v1/chat/completions</Code>) will work.
              </p>
              <p style={{ margin: '6px 0 0' }}>
                <strong style={{ color: C.textPrimary }}>Compatible servers:</strong>
              </p>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                <li style={{ marginBottom: '3px' }}><strong>text-generation-webui</strong> — run with <Code>--api</Code> flag</li>
                <li style={{ marginBottom: '3px' }}><strong>LocalAI</strong> — drop-in local API server, no GPU required</li>
                <li style={{ marginBottom: '3px' }}><strong>Kobold.cpp</strong> — with OpenAI extension enabled</li>
                <li style={{ marginBottom: '3px' }}><strong>Nitro</strong> — compact inference server by Jan team</li>
                <li><strong>TabbyAPI</strong> — ExLlamaV2-based server for quantized models</li>
              </ul>
              <p style={{ margin: '8px 0 0', fontSize: '11px', color: C.textMuted }}>
                Set Base URL to your server's endpoint and Model Name to the identifier the server expects.
              </p>
            </GuideBox>
          )}
        </div>
      </ProviderCard>

      {/* Phase 2 — proxy toggle (shown for all non-Anthropic providers) */}
      {llmProvider !== 'anthropic' && (
        <div style={{
          marginTop: '4px', padding: '12px 14px',
          backgroundColor: C.surfaceRaised, border: `1px solid ${C.border}`,
          borderRadius: '8px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: proxyEnabled ? '10px' : 0 }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary, marginBottom: '2px' }}>
                Route ALL agents through proxy
              </div>
              <div style={{ fontSize: '11px', color: C.textSecondary }}>
                Uses a LiteLLM proxy to translate agent calls. Requires <code style={{ fontSize: '10px' }}>pip install compaas[proxy]</code>.
              </div>
            </div>
            <button
              role="switch" aria-checked={proxyEnabled}
              onClick={() => setProxyEnabled(!proxyEnabled)}
              style={{
                position: 'relative', width: '44px', height: '24px', borderRadius: '12px', flexShrink: 0,
                border: `1px solid ${proxyEnabled ? C.accent : C.border}`, cursor: 'pointer',
                backgroundColor: proxyEnabled ? C.accentDim : C.surface, outline: 'none', padding: 0,
              }}
              aria-label="Enable proxy mode"
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
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Proxy URL
              </label>
              <input
                type="text" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://localhost:4000"
                style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TestConnectionButton({
  status, message, onTest,
}: {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message: string;
  onTest: () => void;
}) {
  const colors: Record<string, string> = { ok: C.success, error: C.error, testing: C.textMuted, idle: C.accent };
  const labels: Record<string, string> = { ok: 'Connected', error: 'Failed', testing: 'Testing…', idle: 'Test Connection' };
  return (
    <div>
      <button
        onClick={onTest}
        disabled={status === 'testing'}
        style={{
          padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
          border: `1px solid ${colors[status]}`,
          backgroundColor: status === 'ok' ? 'rgba(63,185,80,0.1)' : status === 'error' ? 'rgba(248,81,73,0.1)' : C.surface,
          color: colors[status], outline: 'none',
        }}
      >
        {labels[status]}
      </button>
      {message && status === 'error' && (
        <div style={{ marginTop: '6px', fontSize: '11px', color: C.error, wordBreak: 'break-all' }}>{message}</div>
      )}
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
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '6px' }}>
        This is how agents will address you in conversations and reports.
      </p>
      <p style={{ fontSize: '12px', color: C.textMuted, marginBottom: '24px', fontStyle: 'italic' }}>
        This appears in CEO conversations, reports, and the sidebar
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
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  const applyTemplate = (templateName: string) => {
    setSelectedTemplate(templateName);
    const template = NAME_TEMPLATES[templateName];
    if (template) {
      Object.entries(template).forEach(([id, name]) => {
        onAgentNameChange(id, name);
      });
    }
  };

  const namedCount = Object.values(agentNames).filter((n) => n.trim().length > 0).length;

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        Team Names
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '12px' }}>
        Customise the display name for each agent. Pre-filled with defaults.
      </p>

      {/* Counter */}
      <div style={{ marginBottom: '12px' }}>
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: namedCount === 15 ? C.success : C.textMuted,
            backgroundColor: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: '20px',
            padding: '3px 10px',
          }}
        >
          {namedCount} of 15 agents named
        </span>
      </div>

      {/* Template buttons */}
      <div style={{ marginBottom: '16px' }}>
        <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, marginBottom: '8px' }}>
          Quick Templates
        </p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {Object.keys(NAME_TEMPLATES).map((name) => (
            <button
              key={name}
              onClick={() => applyTemplate(name)}
              style={{
                padding: '5px 12px',
                borderRadius: '6px',
                border: `1px solid ${selectedTemplate === name ? C.accent : C.border}`,
                backgroundColor: selectedTemplate === name ? 'rgba(88,166,255,0.1)' : 'transparent',
                color: selectedTemplate === name ? C.accent : C.textSecondary,
                fontSize: '12px',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {name}
            </button>
          ))}
          <button
            onClick={() => setSelectedTemplate(null)}
            style={{
              padding: '5px 12px',
              borderRadius: '6px',
              border: `1px solid ${selectedTemplate === null ? C.accent : C.border}`,
              backgroundColor: selectedTemplate === null ? 'rgba(88,166,255,0.1)' : 'transparent',
              color: selectedTemplate === null ? C.accent : C.textSecondary,
              fontSize: '12px',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            Custom
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '12px',
          maxHeight: '300px',
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
              onChange={(e) => { setSelectedTemplate(null); onAgentNameChange(agent.id, e.target.value); }}
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
  theme: string;
  onAutoOpenChange: (v: boolean) => void;
  onPollIntervalChange: (v: number) => void;
  onThemeChange: (v: string) => void;
}) {
  const { setTheme, currentTheme } = useThemeSwitch();

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        Preferences
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '20px' }}>
        Configure runtime behaviour and appearance. These can be changed later in Settings.
      </p>

      {/* Theme selector */}
      <div style={{ marginBottom: '16px' }}>
        <p style={{ fontSize: '12px', fontWeight: 600, color: C.textSecondary, marginBottom: '10px' }}>Theme</p>
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
                }}
              >
                <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                  {t.preview.map((color, i) => (
                    <div key={i} style={{ width: '16px', height: '16px', borderRadius: '3px', backgroundColor: color, border: '1px solid rgba(255,255,255,0.1)' }} />
                  ))}
                </div>
                <div style={{ fontSize: '11px', fontWeight: 600, color: selected ? C.accent : C.textPrimary }}>{t.label}</div>
                <div style={{ fontSize: '10px', color: C.textMuted }}>{t.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Auto-open browser toggle */}
      <div
        style={{
          backgroundColor: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          borderRadius: '8px',
          padding: '14px',
          marginBottom: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ fontSize: '13px', fontWeight: 500, color: C.textPrimary, marginBottom: '2px' }}>
            Auto-open browser
          </div>
          <div style={{ fontSize: '11px', color: C.textSecondary }}>
            Automatically open the dashboard when compaas-web starts.
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
          padding: '14px',
        }}
      >
        <label
          htmlFor="poll-interval"
          style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: C.textPrimary, marginBottom: '2px' }}
        >
          Poll interval
        </label>
        <p style={{ fontSize: '11px', color: C.textSecondary, marginBottom: '10px' }}>
          How often the dashboard fetches updated data from the backend.
        </p>
        <select
          id="poll-interval"
          value={pollInterval}
          onChange={(e) => onPollIntervalChange(Number(e.target.value))}
          style={{
            padding: '7px 12px',
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

function StepTelegram({
  telegramBotToken,
  telegramChatId,
  onTokenChange,
  onChatIdChange,
}: {
  telegramBotToken: string;
  telegramChatId: string;
  onTokenChange: (v: string) => void;
  onChatIdChange: (v: string) => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        {/* Telegram icon */}
        <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: '#2ca5e0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
            <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
          </svg>
        </div>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            Telegram Integration
            <span
              style={{
                fontSize: '11px',
                color: C.textMuted,
                fontWeight: 400,
                backgroundColor: C.surfaceRaised,
                border: `1px solid ${C.border}`,
                borderRadius: '4px',
                padding: '1px 7px',
              }}
            >
              Optional
            </span>
          </h2>
          <p style={{ fontSize: '12px', color: C.textSecondary }}>
            Continue conversations from your phone while away.
          </p>
        </div>
      </div>

      <div style={{ padding: '14px', backgroundColor: 'rgba(44,165,224,0.08)', border: '1px solid rgba(44,165,224,0.25)', borderRadius: '8px', marginBottom: '20px' }}>
        <p style={{ fontSize: '12px', color: '#2ca5e0' }}>
          <strong>How it works:</strong> Create a Telegram bot via @BotFather, add it to a chat, then paste the credentials here.
          You can then hand off sessions to Telegram with one click from the sidebar.
        </p>
      </div>

      {/* Bot token input */}
      <div style={{ marginBottom: '14px' }}>
        <label htmlFor="wizard-telegram-token" style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: C.textSecondary, marginBottom: '6px' }}>
          Bot Token
        </label>
        <input
          id="wizard-telegram-token"
          type="password"
          value={telegramBotToken}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="1234567890:ABCdef..."
          style={{ width: '100%', padding: '9px 12px', backgroundColor: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#2ca5e0'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      </div>

      {/* Chat ID input */}
      <div>
        <label htmlFor="wizard-telegram-chatid" style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: C.textSecondary, marginBottom: '6px' }}>
          Chat ID
        </label>
        <input
          id="wizard-telegram-chatid"
          type="text"
          value={telegramChatId}
          onChange={(e) => onChatIdChange(e.target.value)}
          placeholder="-1001234567890"
          style={{ width: '100%', padding: '9px 12px', backgroundColor: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#2ca5e0'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      </div>

      <p style={{ fontSize: '11px', color: C.textMuted, marginTop: '12px' }}>
        You can skip this step and configure Telegram later in Settings.
      </p>
    </div>
  );
}

function StepComplete({
  userName,
  agentNames,
  autoOpenBrowser,
  pollInterval,
  telegramBotToken,
  telegramChatId,
  llmProvider,
  llmModel,
  anthropicMode,
  anthropicModelPreset,
  openaiMode,
  openaiModelPreset,
}: {
  userName: string;
  agentNames: Record<string, string>;
  autoOpenBrowser: boolean;
  pollInterval: number;
  theme: string;
  telegramBotToken: string;
  telegramChatId: string;
  llmProvider: LlmProvider;
  llmModel: string;
  anthropicMode: AnthropicMode;
  anthropicModelPreset: string;
  openaiMode: OpenaiMode;
  openaiModelPreset: string;
}) {
  const { currentTheme } = useThemeSwitch();
  const pollLabel = POLL_INTERVAL_OPTIONS.find((o) => o.value === pollInterval)?.label ?? `${pollInterval}ms`;
  const nameCount = Object.keys(agentNames).length;
  const telegramConfigured = telegramBotToken && telegramChatId;

  const providerLabel =
    llmProvider === 'anthropic' && anthropicMode === 'cli'    ? `Anthropic — Claude CLI (${anthropicModelPreset})` :
    llmProvider === 'anthropic' && anthropicMode === 'apikey' ? `Anthropic — API Key (${anthropicModelPreset})` :
    llmProvider === 'openai'    && openaiMode === 'codex'     ? `OpenAI — Codex CLI (${openaiModelPreset !== 'custom' ? openaiModelPreset : llmModel})` :
    llmProvider === 'openai'                                  ? `OpenAI — API Key (${openaiModelPreset !== 'custom' ? openaiModelPreset : llmModel})` :
                                                                `Local Model (${llmModel})`;

  const rows = [
    { label: 'AI Provider', value: providerLabel },
    { label: 'Board Head', value: userName || '(not set)' },
    { label: 'Team size', value: `${nameCount} agents configured` },
    { label: 'Theme', value: currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1) },
    { label: 'Auto-open browser', value: autoOpenBrowser ? 'Enabled' : 'Disabled' },
    { label: 'Poll interval', value: pollLabel },
    { label: 'Telegram', value: telegramConfigured ? 'Configured' : 'Not configured' },
  ];

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
        {rows.map((row, idx, arr) => (
          <div
            key={row.label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: idx < arr.length - 1 ? `1px solid ${C.border}` : 'none',
              backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
            }}
          >
            <span style={{ fontSize: '13px', color: C.textSecondary }}>{row.label}</span>
            <span style={{
              fontSize: '13px',
              fontWeight: 500,
              color: row.label === 'Telegram' && !telegramConfigured ? C.textMuted : C.textPrimary,
            }}>
              {row.value}
            </span>
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
          border: '1px solid rgba(63,185,80,0.25)',
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

function WizardBackdrop() {
  const particles = [
    { left: '8%', top: '14%', delay: '0s' },
    { left: '19%', top: '28%', delay: '0.8s' },
    { left: '30%', top: '20%', delay: '1.4s' },
    { left: '62%', top: '18%', delay: '0.6s' },
    { left: '74%', top: '30%', delay: '1.1s' },
    { left: '84%', top: '22%', delay: '1.8s' },
    { left: '18%', top: '70%', delay: '1.2s' },
    { left: '48%', top: '78%', delay: '0.5s' },
    { left: '70%', top: '74%', delay: '1.6s' },
    { left: '90%', top: '66%', delay: '0.9s' },
  ];
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <div
        className="wizard-orb wizard-orb-a"
        style={{
          position: 'absolute',
          width: '48vw',
          height: '48vw',
          minWidth: '360px',
          minHeight: '360px',
          borderRadius: '50%',
          background: 'radial-gradient(circle at 30% 30%, color-mix(in srgb, var(--tf-accent-blue) 32%, transparent) 0%, transparent 72%)',
          top: '-22%',
          left: '-12%',
          filter: 'blur(8px)',
        }}
      />
      <div
        className="wizard-orb wizard-orb-b"
        style={{
          position: 'absolute',
          width: '42vw',
          height: '42vw',
          minWidth: '320px',
          minHeight: '320px',
          borderRadius: '50%',
          background: 'radial-gradient(circle at 68% 38%, color-mix(in srgb, var(--tf-accent) 30%, transparent) 0%, transparent 74%)',
          bottom: '-18%',
          right: '-10%',
          filter: 'blur(10px)',
        }}
      />
      <div
        className="wizard-halo-ring"
        style={{
          position: 'absolute',
          width: '72vw',
          height: '72vw',
          minWidth: '560px',
          minHeight: '560px',
          left: '50%',
          top: '52%',
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          background:
            'conic-gradient(from 120deg, ' +
            'color-mix(in srgb, var(--tf-accent-blue) 35%, transparent), ' +
            'transparent 30%, ' +
            'color-mix(in srgb, var(--tf-accent) 30%, transparent) 64%, ' +
            'transparent 88%)',
          maskImage: 'radial-gradient(circle, transparent 44%, black 46%, black 52%, transparent 57%)',
          opacity: 0.4,
          filter: 'blur(2px)',
        }}
      />
      <div
        className="wizard-grid-glow"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.2,
          backgroundImage:
            'linear-gradient(to right, color-mix(in srgb, var(--tf-border) 60%, transparent) 1px, transparent 1px), ' +
            'linear-gradient(to bottom, color-mix(in srgb, var(--tf-border) 60%, transparent) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(circle at 50% 20%, black, transparent 72%)',
        }}
      />
      {particles.map((p, idx) => (
        <div
          key={`${p.left}-${p.top}`}
          className="wizard-particle"
          style={{
            position: 'absolute',
            left: p.left,
            top: p.top,
            width: idx % 3 === 0 ? '5px' : '3px',
            height: idx % 3 === 0 ? '5px' : '3px',
            borderRadius: '999px',
            background: 'color-mix(in srgb, var(--tf-accent-blue) 75%, white)',
            boxShadow: '0 0 16px color-mix(in srgb, var(--tf-accent-blue) 45%, transparent)',
            opacity: 0.75,
            animationDelay: p.delay,
          }}
        />
      ))}
      <div
        className="wizard-wave"
        style={{
          position: 'absolute',
          left: '-10%',
          right: '-10%',
          bottom: '-8%',
          height: '46%',
          background:
            'radial-gradient(70% 110% at 50% 100%, color-mix(in srgb, var(--tf-accent) 22%, transparent), transparent 72%)',
          filter: 'blur(6px)',
          opacity: 0.65,
        }}
      />
      <div
        className="wizard-scanline"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          height: '140px',
          background: 'linear-gradient(180deg, transparent, color-mix(in srgb, var(--tf-accent-blue) 20%, transparent), transparent)',
          filter: 'blur(16px)',
          opacity: 0.45,
        }}
      />
    </div>
  );
}

// ---- Main component ----

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(1);

  // Step 2 — AI Provider
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('anthropic');
  // Anthropic sub-options
  const [anthropicMode, setAnthropicMode] = useState<AnthropicMode>('cli');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicModelPreset, setAnthropicModelPreset] = useState('claude-opus-4-6');
  // OpenAI sub-options
  const [openaiMode, setOpenaiMode] = useState<OpenaiMode>('apikey');
  // Local / shared
  const [localPreset, setLocalPreset] = useState<LocalPreset>('ollama');
  const [llmBaseUrl, setLlmBaseUrl] = useState('http://localhost:11434/v1');
  const [llmModel, setLlmModel] = useState('llama3.3');
  const [llmApiKey, setLlmApiKey] = useState('ollama');
  const [openaiModelPreset, setOpenaiModelPreset] = useState('gpt-4o');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('http://localhost:4000');

  // Step 3 — Board Head name
  const [userName, setUserName] = useState('');

  // Step 4 — Team Names
  const [agentNames, setAgentNames] = useState<Record<string, string>>(
    Object.fromEntries(AGENT_DEFAULTS.map((a) => [a.id, a.defaultName]))
  );

  // Step 5 — Preferences
  const [autoOpenBrowser, setAutoOpenBrowser] = useState(true);
  const [pollInterval, setPollInterval] = useState(5000);
  const [theme, setTheme] = useState('midnight');

  // Step 6 — Telegram
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { currentTheme } = useThemeSwitch();

  const handleAgentNameChange = (id: string, value: string) => {
    setAgentNames((prev) => ({ ...prev, [id]: value }));
  };

  const canProceed = () => {
    if (step === 3 && !userName.trim()) return false;
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

    // Save Telegram credentials if provided; clear any stale values if skipped
    if (telegramBotToken && telegramChatId) {
      localStorage.setItem(TELEGRAM_KEYS.token, telegramBotToken);
      localStorage.setItem(TELEGRAM_KEYS.chatId, telegramChatId);
      localStorage.setItem(TELEGRAM_KEYS.configured, 'true');
    } else {
      localStorage.removeItem(TELEGRAM_KEYS.token);
      localStorage.removeItem(TELEGRAM_KEYS.chatId);
      localStorage.removeItem(TELEGRAM_KEYS.configured);
    }

    // Resolve model, base_url, and api_key based on provider + sub-mode
    let resolvedModel = llmModel;
    let resolvedBaseUrl = llmBaseUrl;
    let resolvedApiKey = llmApiKey;

    if (llmProvider === 'anthropic') {
      resolvedModel = anthropicModelPreset === 'custom' ? llmModel : anthropicModelPreset;
      resolvedBaseUrl = 'https://api.anthropic.com/v1';
      resolvedApiKey = anthropicMode === 'apikey' ? anthropicApiKey : '';
    } else if (llmProvider === 'openai') {
      resolvedModel = openaiModelPreset !== 'custom' ? openaiModelPreset : llmModel;
      resolvedBaseUrl = 'https://api.openai.com/v1';
      resolvedApiKey = llmApiKey;
    }

    const llmConfig: LlmConfig = {
      provider: llmProvider,
      anthropic_mode: anthropicMode,
      openai_mode: openaiMode,
      base_url: resolvedBaseUrl,
      model: resolvedModel,
      api_key: resolvedApiKey,
      system_prompt: '',
      proxy_enabled: llmProvider !== 'anthropic' && proxyEnabled,
      proxy_url: proxyUrl,
    };

    const config: Partial<AppConfig> = {
      setup_complete: true,
      user: { name: userName.trim() },
      agents: agentNames,
      ui: {
        theme: currentTheme,
        poll_interval_ms: pollInterval,
      },
      server: {
        host: '',
        port: 0,
        auto_open_browser: autoOpenBrowser,
      },
      llm: llmConfig,
    };

    const ok = await saveSetupConfig(config);

    if (ok) {
      onComplete();
    } else {
      setSubmitError('Failed to save configuration. Please check that compaas-web is running and try again.');
      setSubmitting(false);
    }
  };

  const stepLabels = ['Welcome', 'AI Provider', 'Your Name', 'Team Names', 'Preferences', 'Telegram', 'Complete'];

  return (
    <div
      style={{
        minHeight: '100vh',
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: C.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
      }}
      role="main"
    >
      <WizardBackdrop />
      <div
        style={{
          width: '100%',
          maxWidth: '640px',
          position: 'relative',
          zIndex: 1,
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
              <div style={{ flexShrink: 0 }}>
                <CompassRoseLogo size={28} />
              </div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>COMPaaS Setup</span>
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
              <StepAiProvider
                llmProvider={llmProvider}             setLlmProvider={setLlmProvider}
                anthropicMode={anthropicMode}         setAnthropicMode={setAnthropicMode}
                anthropicApiKey={anthropicApiKey}     setAnthropicApiKey={setAnthropicApiKey}
                anthropicModelPreset={anthropicModelPreset} setAnthropicModelPreset={setAnthropicModelPreset}
                openaiMode={openaiMode}               setOpenaiMode={setOpenaiMode}
                localPreset={localPreset}             setLocalPreset={setLocalPreset}
                llmBaseUrl={llmBaseUrl}               setLlmBaseUrl={setLlmBaseUrl}
                llmModel={llmModel}                   setLlmModel={setLlmModel}
                llmApiKey={llmApiKey}                 setLlmApiKey={setLlmApiKey}
                openaiModelPreset={openaiModelPreset} setOpenaiModelPreset={setOpenaiModelPreset}
                proxyEnabled={proxyEnabled}           setProxyEnabled={setProxyEnabled}
                proxyUrl={proxyUrl}                   setProxyUrl={setProxyUrl}
              />
            )}
            {step === 3 && (
              <StepBoardHead
                userName={userName}
                onUserNameChange={setUserName}
              />
            )}
            {step === 4 && (
              <StepTeamNames
                agentNames={agentNames}
                onAgentNameChange={handleAgentNameChange}
              />
            )}
            {step === 5 && (
              <StepPreferences
                autoOpenBrowser={autoOpenBrowser}
                pollInterval={pollInterval}
                theme={theme}
                onAutoOpenChange={setAutoOpenBrowser}
                onPollIntervalChange={setPollInterval}
                onThemeChange={setTheme}
              />
            )}
            {step === 6 && (
              <StepTelegram
                telegramBotToken={telegramBotToken}
                telegramChatId={telegramChatId}
                onTokenChange={setTelegramBotToken}
                onChatIdChange={setTelegramChatId}
              />
            )}
            {step === 7 && (
              <StepComplete
                userName={userName}
                agentNames={agentNames}
                autoOpenBrowser={autoOpenBrowser}
                pollInterval={pollInterval}
                theme={theme}
                telegramBotToken={telegramBotToken}
                telegramChatId={telegramChatId}
                llmProvider={llmProvider}
                llmModel={llmModel}
                anthropicMode={anthropicMode}
                anthropicModelPreset={anthropicModelPreset}
                openaiMode={openaiMode}
                openaiModelPreset={openaiModelPreset}
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
                  border: '1px solid rgba(248,81,73,0.3)',
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
                  if (canProceed()) e.currentTarget.style.opacity = '0.85';
                }}
                onMouseLeave={(e) => {
                  if (canProceed()) e.currentTarget.style.opacity = '1';
                }}
                aria-label={step === 1 ? 'Get Started' : step === 6 ? 'Skip' : 'Go to next step'}
              >
                {step === 1 ? 'Get Started' : step === 6 ? 'Skip / Next' : 'Next'}
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
        @keyframes wizardFloatA {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(24px, 18px, 0) scale(1.06); }
        }
        @keyframes wizardFloatB {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(-22px, -20px, 0) scale(1.05); }
        }
        @keyframes wizardGridPulse {
          0%, 100% { opacity: 0.16; }
          50% { opacity: 0.28; }
        }
        @keyframes wizardHaloSpin {
          0% { transform: translate(-50%, -50%) rotate(0deg); opacity: 0.22; }
          50% { opacity: 0.46; }
          100% { transform: translate(-50%, -50%) rotate(360deg); opacity: 0.22; }
        }
        @keyframes wizardParticleFloat {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.35; }
          50% { transform: translate3d(0, -10px, 0) scale(1.3); opacity: 0.95; }
        }
        @keyframes wizardWaveShift {
          0%, 100% { transform: translateX(0); opacity: 0.45; }
          50% { transform: translateX(2.5%); opacity: 0.7; }
        }
        @keyframes wizardScan {
          0% { transform: translateY(-30vh); opacity: 0; }
          20% { opacity: 0.42; }
          70% { opacity: 0.38; }
          100% { transform: translateY(130vh); opacity: 0; }
        }
        .wizard-orb-a { animation: wizardFloatA 12s ease-in-out infinite; }
        .wizard-orb-b { animation: wizardFloatB 14s ease-in-out infinite; }
        .wizard-grid-glow { animation: wizardGridPulse 8s ease-in-out infinite; }
        .wizard-halo-ring { animation: wizardHaloSpin 26s linear infinite; }
        .wizard-particle { animation: wizardParticleFloat 4.2s ease-in-out infinite; }
        .wizard-wave { animation: wizardWaveShift 13s ease-in-out infinite; }
        .wizard-scanline { animation: wizardScan 9.5s linear infinite; }
      `}</style>
    </div>
  );
}
