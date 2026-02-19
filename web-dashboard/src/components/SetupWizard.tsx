import { useState } from 'react';
import { saveSetupConfig, testLlmConnection } from '../api/client';
import type { AppConfig, LlmConfig } from '../types';
import { useThemeSwitch } from '../hooks/useTheme';
import type { ThemeName } from '../hooks/useTheme';

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
  { id: 'midnight', label: 'Midnight', description: 'Deep dark — easy on the eyes', preview: ['#0d1117', '#161b22', '#e6edf3'] },
  { id: 'twilight', label: 'Twilight', description: 'Softer dark with blue tones', preview: ['#0f1923', '#1a2332', '#d0d8e4'] },
  { id: 'dawn', label: 'Dawn', description: 'Light mode — clean and bright', preview: ['#ffffff', '#f6f8fa', '#24292f'] },
  { id: 'claude', label: 'Claude', description: 'Warm terracotta — Claude brand colors', preview: ['#1a1715', '#2d2924', '#d97757'] },
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
    { icon: '🤖', label: 'Team of 15 AI agents', desc: 'Engineering, Product, Research & Ops' },
    { icon: '💬', label: 'Chat with CEO', desc: 'Direct access to your AI CEO' },
    { icon: '📋', label: 'Track projects & tasks', desc: 'Kanban boards and task management' },
    { icon: '📊', label: 'Real-time monitoring', desc: 'Live activity feed and metrics' },
  ];

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
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ color: C.textPrimary }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </div>
      <h2 style={{ fontSize: '22px', fontWeight: 700, color: C.textPrimary, marginBottom: '12px' }}>
        Welcome to ThunderFlow
      </h2>
      <p style={{ fontSize: '14px', color: C.textSecondary, lineHeight: '1.6', maxWidth: '480px', margin: '0 auto 24px' }}>
        ThunderFlow is your AI-powered virtual company dashboard. You direct a team of 15 autonomous agents
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
            <span style={{ fontSize: '18px', flexShrink: 0, marginTop: '1px' }}>{f.icon}</span>
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
type LocalPreset  = 'ollama' | 'lmstudio' | 'llamacpp' | 'custom';

const LOCAL_PRESETS: { id: LocalPreset; label: string; baseUrl: string; apiKey: string; placeholder: string }[] = [
  { id: 'ollama',    label: 'Ollama',        baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama',     placeholder: 'llama3.2' },
  { id: 'lmstudio', label: 'LM Studio',      baseUrl: 'http://localhost:1234/v1',  apiKey: 'lm-studio',  placeholder: 'llama-3.2-3b-instruct' },
  { id: 'llamacpp',  label: 'llama.cpp',      baseUrl: 'http://localhost:8080/v1',  apiKey: 'none',       placeholder: 'default' },
  { id: 'custom',   label: 'Custom',         baseUrl: '',                          apiKey: '',           placeholder: 'my-model' },
];

const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'custom'];

function StepAiProvider({
  llmProvider, setLlmProvider,
  localPreset, setLocalPreset,
  llmBaseUrl, setLlmBaseUrl,
  llmModel, setLlmModel,
  llmApiKey, setLlmApiKey,
  openaiModelPreset, setOpenaiModelPreset,
  proxyEnabled, setProxyEnabled,
  proxyUrl, setProxyUrl,
}: {
  llmProvider: LlmProvider;            setLlmProvider: (v: LlmProvider) => void;
  localPreset: LocalPreset;            setLocalPreset: (v: LocalPreset) => void;
  llmBaseUrl: string;                  setLlmBaseUrl: (v: string) => void;
  llmModel: string;                    setLlmModel: (v: string) => void;
  llmApiKey: string;                   setLlmApiKey: (v: string) => void;
  openaiModelPreset: string;           setOpenaiModelPreset: (v: string) => void;
  proxyEnabled: boolean;               setProxyEnabled: (v: boolean) => void;
  proxyUrl: string;                    setProxyUrl: (v: string) => void;
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

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    const result = await testLlmConnection({ base_url: llmBaseUrl, model: llmModel, api_key: llmApiKey });
    setTestStatus(result.status);
    setTestMessage(result.message);
  };

  const ProviderCard = ({
    icon, title, description, selected, onClick, children,
  }: {
    id?: LlmProvider; icon: string; title: string; description: string;
    selected: boolean; onClick: () => void; children?: React.ReactNode;
  }) => (
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
        <span style={{ fontSize: '22px', flexShrink: 0 }}>{icon}</span>
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

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, color: C.textPrimary, marginBottom: '6px' }}>
        AI Provider
      </h2>
      <p style={{ fontSize: '13px', color: C.textSecondary, marginBottom: '20px' }}>
        Choose how your AI agents communicate. You can change this later in Settings.
      </p>

      {/* Anthropic */}
      <ProviderCard
        id="anthropic" icon="⚡" selected={llmProvider === 'anthropic'}
        title="Anthropic Cloud"
        description="Claude Opus / Sonnet / Haiku via Anthropic API. Requires ANTHROPIC_API_KEY in your environment."
        onClick={() => setLlmProvider('anthropic')}
      />

      {/* OpenAI */}
      <ProviderCard
        id="openai" icon="🤖" selected={llmProvider === 'openai'}
        title="OpenAI"
        description="GPT-4o, GPT-4-turbo, GPT-3.5-turbo, etc. Requires an OpenAI API key."
        onClick={() => setLlmProvider('openai')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Model preset */}
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
                  {m}
                </button>
              ))}
            </div>
            {openaiModelPreset === 'custom' && (
              <input
                type="text" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}
                placeholder="e.g. gpt-4o-2024-08-06"
                style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
              />
            )}
          </div>
          {/* API key */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              API Key
            </label>
            <input
              type="password" value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder="sk-..."
              style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
          {/* Test button */}
          <TestConnectionButton status={testStatus} message={testMessage} onTest={handleTest} />
        </div>
      </ProviderCard>

      {/* Local Model */}
      <ProviderCard
        id="openai_compat" icon="🖥️" selected={llmProvider === 'openai_compat'}
        title="Local Model"
        description="Ollama, LM Studio, llama.cpp, or any OpenAI-compatible server running locally."
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
          {/* Model name */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: C.textSecondary, marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Model Name
            </label>
            <input
              type="text" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}
              placeholder={LOCAL_PRESETS.find((p) => p.id === localPreset)?.placeholder ?? 'llama3.2'}
              style={{ width: '100%', padding: '7px 10px', backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textPrimary, fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
            />
          </div>
          {/* Test button */}
          <TestConnectionButton status={testStatus} message={testMessage} onTest={handleTest} />
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
                Uses a LiteLLM proxy to translate agent calls. Requires <code style={{ fontSize: '10px' }}>pip install thunderflow[proxy]</code>.
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
            Automatically open the dashboard when thunderflow-web starts.
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
}) {
  const { currentTheme } = useThemeSwitch();
  const pollLabel = POLL_INTERVAL_OPTIONS.find((o) => o.value === pollInterval)?.label ?? `${pollInterval}ms`;
  const nameCount = Object.keys(agentNames).length;
  const telegramConfigured = telegramBotToken && telegramChatId;

  const providerLabel =
    llmProvider === 'anthropic'     ? 'Anthropic Cloud (Claude)' :
    llmProvider === 'openai'        ? `OpenAI (${llmModel})` :
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

// ---- Main component ----

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(1);

  // Step 2 — AI Provider
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('anthropic');
  const [localPreset, setLocalPreset] = useState<LocalPreset>('ollama');
  const [llmBaseUrl, setLlmBaseUrl] = useState('http://localhost:11434/v1');
  const [llmModel, setLlmModel] = useState('llama3.2');
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
      localStorage.setItem('thunderflow_telegram_token', telegramBotToken);
      localStorage.setItem('thunderflow_telegram_chatid', telegramChatId);
      localStorage.setItem('thunderflow_telegram_configured', 'true');
    } else {
      localStorage.removeItem('thunderflow_telegram_token');
      localStorage.removeItem('thunderflow_telegram_chatid');
      localStorage.removeItem('thunderflow_telegram_configured');
    }

    // Resolve the effective model for OpenAI (custom vs preset)
    const resolvedModel =
      llmProvider === 'openai' && openaiModelPreset !== 'custom'
        ? openaiModelPreset
        : llmModel;

    const llmConfig: LlmConfig = {
      provider: llmProvider,
      base_url: llmProvider === 'openai' ? 'https://api.openai.com/v1' : llmBaseUrl,
      model: resolvedModel,
      api_key: llmApiKey,
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
      setSubmitError('Failed to save configuration. Please check that the thunderflow-web server is running and try again.');
      setSubmitting(false);
    }
  };

  const stepLabels = ['Welcome', 'AI Provider', 'Your Name', 'Team Names', 'Preferences', 'Telegram', 'Complete'];

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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ color: C.textPrimary }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: C.textPrimary }}>ThunderFlow Setup</span>
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
                llmProvider={llmProvider}           setLlmProvider={setLlmProvider}
                localPreset={localPreset}           setLocalPreset={setLocalPreset}
                llmBaseUrl={llmBaseUrl}             setLlmBaseUrl={setLlmBaseUrl}
                llmModel={llmModel}                 setLlmModel={setLlmModel}
                llmApiKey={llmApiKey}               setLlmApiKey={setLlmApiKey}
                openaiModelPreset={openaiModelPreset} setOpenaiModelPreset={setOpenaiModelPreset}
                proxyEnabled={proxyEnabled}         setProxyEnabled={setProxyEnabled}
                proxyUrl={proxyUrl}                 setProxyUrl={setProxyUrl}
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
      `}</style>
    </div>
  );
}
