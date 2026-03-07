import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  AutoLaunchStatus,
  ChatMessage,
  CompletionCelebrationPayload,
  DeliveryGates,
  GuidanceAction,
  GuidancePayload,
  PromptExample,
  Project,
  QualityReport,
  RefinementPayload,
  RunDoneTerminalState,
  RunIncidentEvent,
  RunStatusEvent,
  StructuredChatResponse,
  StructuredDeliverable,
} from '../types';
import {
  fetchChatHistory,
  clearChatHistory,
  createChatWebSocket,
  approveProjectPlan,
  sendTelegramMessage,
  pollTelegramMessages,
  fetchMemory,
  addMemory,
  clearMemory,
  fetchMemoryPolicy,
  updateMemoryPolicy,
  deployProjectToVercel,
  fetchProjectReleaseNotes,
  applyStripeBillingPack,
} from '../api/client';
import FloatingSelect from './ui/FloatingSelect';
import { useToast } from './Toast';
import { PROMPT_EXAMPLES, PROMPT_EXAMPLE_CATEGORIES } from '../constants/promptExamples';
import ContextPackPanel from './ContextPackPanel';
import PreviewReviewPanel from './PreviewReviewPanel';
import InlineActionCard from './InlineActionCard';

// ---- Helpers ----

function formatTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'Invalid time';
  }
}

function formatElapsedCompact(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rem = safe % 60;
  if (minutes <= 0) return `${rem}s`;
  return `${minutes}m ${String(rem).padStart(2, '0')}s`;
}

function terminalStateLabel(state?: RunDoneTerminalState): string {
  if (state === 'failed') return 'Run failed';
  if (state === 'cancelled') return 'Run cancelled';
  return 'Run completed';
}

function msgKey(msg: ChatMessage): string {
  return `${msg.timestamp}|${msg.role}`;
}

// ---- Action text parser ----

interface ActionInfo { label: string; icon: string; color: string; }

function prettyAgentName(raw: string): string {
  // Micro-agents: "micro-backend-db-schema" → "Backend (db schema)"
  const microMatch = raw.match(/^micro-([^-]+)-(.+)$/i);
  if (microMatch) {
    const parent = microMatch[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const spec = microMatch[2].replace(/-/g, ' ');
    return `${parent} (${spec})`;
  }
  const normalized = raw.replace(/^chief-/i, 'chief ').replace(/^vp-/i, 'vp ');
  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function summarizeCommand(command: string): string {
  const cmd = command.toLowerCase();
  if (!cmd) return 'Running implementation step';
  if (/\b(pwd|ls|find|rg --files)\b/.test(cmd)) return 'Reviewing workspace structure';
  if (/\b(cat|sed|head|tail)\b/.test(cmd)) return 'Reading project files';
  if (/\b(apply_patch|cat >|tee |echo .*>|mkdir|touch)\b/.test(cmd)) return 'Writing project files';
  if (/\b(pytest|npm test|pnpm test|vitest|jest)\b/.test(cmd)) return 'Running test checks';
  if (/\b(npm run build|vite build|tsc|npm run lint|eslint)\b/.test(cmd)) return 'Running build and quality checks';
  if (/\b(git )\b/.test(cmd)) return 'Preparing git workspace';
  return 'Running implementation step';
}

function summarizeActionPayload(payload: {
  label?: string;
  command?: string;
  tool?: string;
  actor?: string;
  target?: string;
  source_agent?: string;
  target_agent?: string;
  flow?: string;
  task?: string;
}): string {
  const actorRaw = String(payload.actor || payload.source_agent || 'CEO');
  const targetRaw = String(payload.target || payload.target_agent || '');
  const target = targetRaw ? prettyAgentName(targetRaw) : '';
  const task = String(payload.task || '').trim();
  const flow = String(payload.flow || '').toLowerCase();
  const tool = String(payload.tool || '').toLowerCase();
  const command = String(payload.command || '').trim();

  // Delegation: show the delegated agent prominently
  if (flow === 'down' && target && target.toLowerCase() !== 'ceo') {
    return task ? `${target} is working on: ${task.slice(0, 92)}` : `Delegated to ${target}`;
  }
  // Result: show which agent completed
  if (flow === 'up' && actorRaw) {
    const source = prettyAgentName(actorRaw);
    if (source.toLowerCase() !== 'ceo') {
      return `${source} delivered results`;
    }
  }
  if (flow === 'blocked') {
    const source = prettyAgentName(actorRaw);
    return `${source} hit a blocker and is requesting guidance`;
  }
  // Failed delegation: show which agent failed
  if (flow === 'failed') {
    const failedAgent = prettyAgentName(actorRaw);
    return `${failedAgent} failed — result not received`;
  }
  // Internal CEO work — describe the action without "Ceo is..." prefix
  if (task) return task.slice(0, 100);
  if (command) return summarizeCommand(command);
  if (tool.includes('websearch')) return 'Researching references';
  if (tool.includes('webfetch')) return 'Collecting source content';
  if (tool.includes('grep') || tool.includes('glob') || tool.includes('read')) return 'Inspecting the codebase';
  if (tool.includes('write') || tool.includes('edit') || tool.includes('multiedit')) return 'Updating project files';
  if (tool.includes('bash') || tool.includes('command_execution')) return 'Running implementation steps';
  return payload.label ? String(payload.label) : 'Executing a task';
}

function enrichActionText(
  existing: string,
  detail: { command?: string; filePath?: string; tool?: string },
): string {
  const trimmed = existing.trim();
  const command = (detail.command || '').trim();
  const filePath = (detail.filePath || '').trim();
  const lower = trimmed.toLowerCase();

  if (command && (
    lower === 'running command…'
    || lower.includes('details unavailable')
    || lower.includes('using bash')
    || lower.startsWith('running:')
  )) {
    const clipped = command.length > 180 ? `${command.slice(0, 177)}...` : command;
    return `Running: ${clipped}`;
  }

  if (filePath && (lower.startsWith('write') || lower.startsWith('edit') || lower.startsWith('reading'))) {
    const base = trimmed.split(':')[0] || trimmed;
    return `${base}: ${filePath}`;
  }

  return trimmed;
}

function parseActionText(text: string): ActionInfo {
  const lower = text.toLowerCase();
  const normalized = text.replace(/\s+/g, ' ').trim();
  const runningMatch = normalized.match(/^(running|run|execute|executing)\s*:?\s*(.+)$/i);
  if (runningMatch?.[2]) {
    const cmd = runningMatch[2].trim();
    const clipped = cmd.length > 72 ? `${cmd.slice(0, 69)}…` : cmd;
    return { label: `Running: ${clipped}`, icon: '⚡', color: 'var(--tf-accent)' };
  }
  const usingMatch = normalized.match(/^using\s+(.+)$/i);
  if (usingMatch?.[1]) {
    const tool = usingMatch[1].trim();
    const clipped = tool.length > 72 ? `${tool.slice(0, 69)}…` : tool;
    return {
      label: `Using ${clipped}`,
      icon: tool.toLowerCase().includes('bash') ? '⚡' : '◦',
      color: tool.toLowerCase().includes('bash') ? 'var(--tf-warning)' : 'var(--tf-text-secondary)',
    };
  }
  if (lower.includes('delegat') || lower.includes('spawn') || lower.includes('subagent')) {
    const m = text.match(/\b(ceo|cto|cfo|ciso|backend|frontend|devops|qa|designer|researcher|security|writer)\b/i);
    return { label: `Delegating to ${m ? m[1] : 'team'}…`, icon: '→', color: 'var(--tf-accent)' };
  }
  if (lower.includes('task tool') || lower.includes('launching agent'))
    return { label: 'Launching specialist agent…', icon: '→', color: 'var(--tf-accent)' };
  if (lower.includes('command_execution'))
    return { label: 'Running internal command…', icon: '⚡', color: 'var(--tf-accent)' };
  if (lower.includes('websearch') || lower.includes('web search') || lower.includes('searching web'))
    return { label: 'Searching the web…', icon: '⊕', color: 'var(--tf-accent-blue)' };
  if (lower.includes('webfetch') || lower.includes('fetching') || lower.includes('web fetch'))
    return { label: 'Fetching web page…', icon: '⊕', color: 'var(--tf-accent-blue)' };
  if (lower.includes('grep') || lower.includes('search') || lower.includes('find'))
    return { label: 'Searching codebase…', icon: '◎', color: 'var(--tf-warning)' };
  if (lower.includes('read') || lower.includes('open file') || lower.includes('glob')) {
    const f = text.match(/[A-Za-z0-9_-]+\.[a-z]{2,5}/);
    return { label: f ? `Reading ${f[0]}` : 'Reading file…', icon: '▷', color: 'var(--tf-text-secondary)' };
  }
  if (lower.includes('write') || lower.includes('edit') || lower.includes('creat')) {
    const f = text.match(/[A-Za-z0-9_-]+\.[a-z]{2,5}/);
    return { label: f ? `Writing ${f[0]}` : 'Writing code…', icon: '✎', color: 'var(--tf-success)' };
  }
  if (lower.includes('bash') || lower.includes('run') || lower.includes('execut') || lower.includes('command')) {
    if (lower.includes('command exit=0') || lower.includes('exit=0')) {
      return { label: 'Command completed successfully', icon: '✓', color: 'var(--tf-success)' };
    }
    if (lower.includes('command exit=') || lower.includes('exit=1') || lower.includes('error')) {
      return { label: 'Command completed with issues', icon: '!', color: 'var(--tf-warning)' };
    }
    const commandHint = normalized.match(/`([^`]+)`/)?.[1] ?? '';
    if (commandHint) {
      const clipped = commandHint.length > 72 ? `${commandHint.slice(0, 69)}…` : commandHint;
      return { label: `Running: ${clipped}`, icon: '⚡', color: 'var(--tf-accent)' };
    }
    const normalizedLower = normalized.toLowerCase();
    if (
      normalizedLower.includes('details unavailable')
      || normalizedLower.startsWith('running command')
      || normalizedLower.startsWith('using bash')
    ) {
      const clipped = normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
      return { label: clipped, icon: '⚡', color: 'var(--tf-warning)' };
    }
    return { label: 'Running implementation step', icon: '⚡', color: 'var(--tf-accent)' };
  }
  if (lower.includes('plan') || lower.includes('analyz') || lower.includes('review'))
    return { label: 'Analyzing…', icon: '◈', color: 'var(--tf-warning)' };
  const clean = text.replace(/\/home\/[^\s/]+\/[^\s/]+\//g, '…/').replace(/\s+/g, ' ').trim();
  return { label: clean.length > 72 ? clean.slice(0, 69) + '…' : clean, icon: '◦', color: 'var(--tf-text-muted)' };
}

const MICRO_COMPLEX_HINTS = [
  'architecture',
  'benchmark',
  'ci/cd',
  'compare',
  'deployment',
  'end-to-end',
  'integration',
  'migration',
  'oauth',
  'performance',
  'plan',
  'production',
  'research',
  'roadmap',
  'scale',
  'security',
  'strategy',
  'tradeoff',
];

const EXECUTION_HINTS = ['build', 'create', 'develop', 'implement', 'fix', 'deploy', 'code', 'scaffold', 'ship'];

const TYPEWRITER_MIN_DELAY_MS = 14;
const TYPEWRITER_BASE_DELAY_MS = 34;
const TYPEWRITER_COMMA_DELAY_MS = 26;
const TYPEWRITER_SENTENCE_DELAY_MS = 52;
const PROMPT_CATEGORY_ALL = 'all';
const PROMPT_EXAMPLES_CATEGORY_KEY = 'compaas_prompt_examples_category';
const PROMPT_EXAMPLES_RECENT_KEY = 'compaas_prompt_examples_recent';
const PROMPT_EXAMPLES_SEEN_BY_PROJECT_KEY = 'compaas_prompt_examples_seen_by_project';
const PROMPT_EXAMPLES_RECENT_LIMIT = 5;

function looksExecutionRequest(input: string): boolean {
  const lower = input.trim().toLowerCase();
  if (!lower) return false;
  return EXECUTION_HINTS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower));
}

const TELEGRAM_KEYS = {
  token: 'compaas_telegram_token',
  chatId: 'compaas_telegram_chatid',
  configured: 'compaas_telegram_configured',
  mirror: 'compaas_telegram_mirror_enabled',
} as const;

function readTelegramCredentials(): { token: string; chatId: string; configured: boolean } {
  try {
    const token = localStorage.getItem(TELEGRAM_KEYS.token) ?? '';
    const chatId = localStorage.getItem(TELEGRAM_KEYS.chatId) ?? '';
    const configured = (localStorage.getItem(TELEGRAM_KEYS.configured) === 'true') && Boolean(token && chatId);
    return { token, chatId, configured };
  } catch {
    return { token: '', chatId: '', configured: false };
  }
}

function microComplexityReason(input: string): string | null {
  const text = input.trim();
  const lower = text.toLowerCase();
  const reasons: string[] = [];

  if (text.length > 260) reasons.push('it is long and likely multi-step');
  if (text.split('\n').length > 3 || lower.split(' and ').length > 3) reasons.push('it combines multiple objectives');
  const hits = MICRO_COMPLEX_HINTS.filter((kw) => lower.includes(kw));
  if (hits.length > 0) reasons.push(`it includes advanced scope (${hits.slice(0, 3).join(', ')})`);

  if (reasons.length === 0) return null;
  return `This request looks too large for Micro Project mode because ${reasons.join('; ')}.`;
}

// ---- Markdown renderers ----

function trimLinkTarget(target: string): string {
  return target.trim().replace(/^<|>$/g, '').replace(/[),.;!?]+$/, '');
}

function isHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function isPathLikeTarget(target: string): boolean {
  if (!target) return false;
  if (isHttpUrl(target)) return false;
  if (target.startsWith('#') || target.startsWith('mailto:') || target.startsWith('tel:')) return false;
  if (/\s/.test(target)) return false;
  return target.includes('/');
}

function normalizeStructuredResponse(value: unknown): StructuredChatResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const nextActions = Array.isArray(raw.next_actions) ? raw.next_actions.map((item) => String(item)).filter(Boolean) : [];
  const risks = Array.isArray(raw.risks) ? raw.risks.map((item) => String(item)).filter(Boolean) : [];
  const validation = Array.isArray(raw.validation) ? raw.validation.map((item) => String(item)).filter(Boolean) : [];
  const delegations = Array.isArray(raw.delegations)
    ? raw.delegations
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const payload = item as Record<string, unknown>;
        const agent = String(payload.agent || '').trim();
        const why = String(payload.why || '').trim();
        const action = String(payload.action || '').trim();
        if (!agent && !why && !action) return null;
        return { agent, why, action };
      })
      .filter(Boolean) as Array<{ agent: string; why: string; action: string }>
    : [];
  const deliverables = Array.isArray(raw.deliverables)
    ? raw.deliverables
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const payload = item as Record<string, unknown>;
        const target = trimLinkTarget(String(payload.target || ''));
        if (!target) return null;
        const normalizedKind = String(payload.kind || '').toLowerCase();
        const kind: StructuredDeliverable['kind'] = normalizedKind === 'url' || isHttpUrl(target) ? 'url' : 'path';
        const label = String(payload.label || target).trim() || target;
        return { label, target, kind };
      })
      .filter(Boolean) as StructuredDeliverable[]
    : [];
  const runCommands = Array.isArray(raw.run_commands) ? raw.run_commands.map((item) => String(item)).filter(Boolean) : [];
  const openLinks = Array.isArray(raw.open_links)
    ? raw.open_links
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const payload = item as Record<string, unknown>;
        const target = trimLinkTarget(String(payload.target || ''));
        if (!target) return null;
        const normalizedKind = String(payload.kind || '').toLowerCase();
        const kind: StructuredDeliverable['kind'] = normalizedKind === 'url' || isHttpUrl(target) ? 'url' : 'path';
        const label = String(payload.label || target).trim() || target;
        return { label, target, kind };
      })
      .filter(Boolean) as StructuredDeliverable[]
    : [];
  const completionKind = (raw.completion_kind === 'build_complete' || raw.completion_kind === 'general')
    ? raw.completion_kind
    : undefined;
  if (
    !summary
    && nextActions.length === 0
    && risks.length === 0
    && validation.length === 0
    && deliverables.length === 0
    && openLinks.length === 0
    && runCommands.length === 0
    && delegations.length === 0
  ) {
    return undefined;
  }
  return {
    summary,
    next_actions: nextActions,
    risks,
    validation,
    deliverables,
    run_commands: runCommands,
    open_links: openLinks,
    completion_kind: completionKind,
    delegations,
  };
}

function hasStructuredContent(value?: StructuredChatResponse): boolean {
  if (!value) return false;
  const summary = (value.summary || '').trim();
  return Boolean(
    summary
    || (value.deliverables && value.deliverables.length > 0)
    || (value.open_links && value.open_links.length > 0)
    || (value.run_commands && value.run_commands.length > 0)
    || (value.validation && value.validation.length > 0)
    || (value.next_actions && value.next_actions.length > 0)
  );
}

function normalizeQualityReport(value: unknown): QualityReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const failedRaw = Array.isArray(raw.failed_gates) ? raw.failed_gates : [];
  const failedGates = failedRaw.map((item) => String(item)).filter(Boolean);
  return {
    code_quality: Math.max(0, Math.min(100, Number(raw.code_quality || 0) || 0)),
    ux_quality: Math.max(0, Math.min(100, Number(raw.ux_quality || 0) || 0)),
    visual_distinctiveness: Math.max(0, Math.min(100, Number(raw.visual_distinctiveness || 0) || 0)),
    validation_passed: Boolean(raw.validation_passed),
    failed_gates: failedGates,
  };
}

function normalizeDeliveryGates(value: unknown): DeliveryGates | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const required = Array.isArray(raw.required) ? raw.required.map((item) => String(item)).filter(Boolean) : [];
  const passed = Array.isArray(raw.passed) ? raw.passed.map((item) => String(item)).filter(Boolean) : [];
  const blocked = Array.isArray(raw.blocked) ? raw.blocked.map((item) => String(item)).filter(Boolean) : [];
  if (required.length === 0 && passed.length === 0 && blocked.length === 0) return undefined;
  return { required, passed, blocked };
}

function normalizeRefinementPayload(value: unknown): RefinementPayload | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const attempted = Boolean(raw.attempted);
  const passIndex = Math.max(0, Math.floor(Number(raw.pass_index || 0) || 0));
  const maxPasses = Math.max(passIndex, Math.floor(Number(raw.max_passes || 0) || 0));
  const reason = String(raw.reason || '').trim();
  return {
    attempted,
    pass_index: passIndex,
    max_passes: maxPasses,
    ...(reason ? { reason } : {}),
  };
}

function normalizeRunStatusEvent(value: unknown): RunStatusEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const runId = String(raw.run_id || '').trim();
  const projectId = String(raw.project_id || '').trim();
  const state = String(raw.state || '').trim();
  const phaseLabel = String(raw.phase_label || '').trim();
  const lastActivityAt = String(raw.last_activity_at || '').trim();
  const elapsedSeconds = Number(raw.elapsed_seconds || 0);
  const heartbeatSeq = Number(raw.heartbeat_seq || 0);
  const guardrailsRaw = raw.guardrails && typeof raw.guardrails === 'object'
    ? raw.guardrails as Record<string, unknown>
    : {};
  const activeAgentsRaw = Array.isArray(raw.active_agents) ? raw.active_agents : [];
  const activeAgents = activeAgentsRaw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      const agentId = String(item.agent_id || '').trim();
      const agentName = String(item.agent_name || '').trim();
      if (!agentId || !agentName) return null;
      const payload: RunStatusEvent['active_agents'][number] = {
        agent_id: agentId,
        agent_name: agentName,
        state: String(item.state || 'working').trim(),
      };
      const task = String(item.task || '').trim();
      if (task) payload.task = task;
      return payload;
    })
    .filter((entry): entry is RunStatusEvent['active_agents'][number] => entry !== null);
  if (!runId) return null;
  return {
    run_id: runId,
    project_id: projectId,
    state,
    phase_label: phaseLabel || 'Running',
    elapsed_seconds: Number.isFinite(elapsedSeconds) ? Math.max(0, Math.floor(elapsedSeconds)) : 0,
    last_activity_at: lastActivityAt || new Date().toISOString(),
    active_agents: activeAgents,
    guardrails: {
      command_budget_remaining: Number(guardrailsRaw.command_budget_remaining || 0) || 0,
      file_budget_remaining: Number(guardrailsRaw.file_budget_remaining || 0) || 0,
      runtime_budget_remaining: Number(guardrailsRaw.runtime_budget_remaining || 0) || 0,
      over_budget: Boolean(guardrailsRaw.over_budget),
    },
    heartbeat_seq: Number.isFinite(heartbeatSeq) ? Math.max(0, Math.floor(heartbeatSeq)) : 0,
  };
}

function normalizeRunIncidentEvent(value: unknown): RunIncidentEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const runId = String(raw.run_id || '').trim();
  if (!runId) return null;
  const suggestedRaw = Array.isArray(raw.suggested_actions) ? raw.suggested_actions : [];
  return {
    run_id: runId,
    severity: String(raw.severity || 'warning').trim(),
    reason: String(raw.reason || 'silent_run').trim(),
    inactive_seconds: Math.max(0, Number(raw.inactive_seconds || 0) || 0),
    suggested_actions: suggestedRaw.map((entry) => String(entry || '').trim()).filter(Boolean),
    default_action: String(raw.default_action || 'status').trim(),
  };
}

function MarkdownBody({ content, onCopyPath }: { content: string; onCopyPath: (path: string) => void }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="chat-markdown-p">{children}</p>,
          ul: ({ children }) => <ul className="chat-markdown-ul">{children}</ul>,
          ol: ({ children }) => <ol className="chat-markdown-ol">{children}</ol>,
          li: ({ children }) => <li className="chat-markdown-li">{children}</li>,
          pre: ({ children }) => <pre className="chat-markdown-pre">{children}</pre>,
          code: ({ children, className }) => (
            <code className={className ? `chat-markdown-code ${className}` : 'chat-markdown-inline-code'}>
              {children}
            </code>
          ),
          a: ({ href = '', children }) => {
            const target = trimLinkTarget(String(href));
            if (isPathLikeTarget(target)) {
              return (
                <button
                  type="button"
                  className="chat-path-link"
                  onClick={() => onCopyPath(target)}
                  title={`Copy path: ${target}`}
                >
                  {children}
                </button>
              );
            }
            const safeHref = target || '#';
            return (
              <a href={safeHref} target="_blank" rel="noreferrer" className="chat-http-link" title={safeHref}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface StructuredCompletionCardProps {
  structured: StructuredChatResponse;
  qualityReport?: QualityReport;
  deliveryGates?: DeliveryGates;
  refinement?: RefinementPayload;
  showFullResponse: boolean;
  onToggleFullResponse: () => void;
  onCopyPath: (path: string) => void;
  onCopyCommand: (command: string) => void;
}

function StructuredCompletionCard({
  structured,
  qualityReport,
  deliveryGates,
  refinement,
  showFullResponse,
  onToggleFullResponse,
  onCopyPath,
  onCopyCommand,
}: StructuredCompletionCardProps) {
  const summary = (structured.summary || '').trim();
  const deliverables = structured.deliverables || [];
  const validation = structured.validation || [];
  const nextActions = structured.next_actions || [];
  const runCommands = structured.run_commands || [];
  const openLinks = structured.open_links || [];
  const completionKind = structured.completion_kind || 'general';
  return (
    <div className={`chat-summary-card${completionKind === 'build_complete' ? ' chat-summary-card-glow' : ''}`}>
      <div className="chat-summary-card-header">
        <span className="chat-summary-card-title">
          {completionKind === 'build_complete' ? 'Completion Summary' : 'Response Summary'}
        </span>
        <button type="button" onClick={onToggleFullResponse} className="chat-summary-toggle">
          {showFullResponse ? 'Hide full response' : 'Show full response'}
        </button>
      </div>

      {summary && (
        <div className="chat-summary-block">
          <p className="chat-summary-label">Outcome</p>
          <p className="chat-summary-text">{summary}</p>
        </div>
      )}

      {deliverables.length > 0 && (
        <div className="chat-summary-block">
          <p className="chat-summary-label">Deliverables</p>
          <ul className="chat-summary-list">
            {deliverables.map((item, idx) => (
              <li key={`${item.target}-${idx}`} className="chat-summary-list-item">
                {item.kind === 'url' ? (
                  <a href={item.target} target="_blank" rel="noreferrer" className="chat-http-link">
                    {item.label}
                  </a>
                ) : (
                  <button type="button" className="chat-path-link" onClick={() => onCopyPath(item.target)} title={`Copy path: ${item.target}`}>
                    {item.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {runCommands.length > 0 && (
        <div className="chat-summary-block">
          <p className="chat-summary-label">Run Commands</p>
          <ul className="chat-summary-list">
            {runCommands.map((command, idx) => (
              <li key={`${command}-${idx}`} className="chat-summary-list-item chat-summary-command-row">
                <code className="chat-markdown-inline-code" style={{ flex: 1, minWidth: 0 }}>{command}</code>
                <button
                  type="button"
                  className="chat-summary-copy-btn"
                  onClick={() => onCopyCommand(command)}
                  title={`Copy command: ${command}`}
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {openLinks.length > 0 && (
        <div className="chat-summary-block">
          <p className="chat-summary-label">Open Links</p>
          <ul className="chat-summary-list">
            {openLinks.map((item, idx) => (
              <li key={`${item.target}-${idx}`} className="chat-summary-list-item">
                {item.kind === 'url' ? (
                  <a href={item.target} target="_blank" rel="noreferrer" className="chat-http-link">
                    {item.label}
                  </a>
                ) : (
                  <button type="button" className="chat-path-link" onClick={() => onCopyPath(item.target)} title={`Copy path: ${item.target}`}>
                    {item.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {validation.length > 0 && (
        <div className="chat-summary-block">
          <p className="chat-summary-label">Validation</p>
          <ul className="chat-summary-list">
            {validation.map((item, idx) => <li key={`${item}-${idx}`} className="chat-summary-list-item">{item}</li>)}
          </ul>
        </div>
      )}

      {nextActions.length > 0 && (
        <div className="chat-summary-block">
          <p className="chat-summary-label">Next Actions</p>
          <ol className="chat-summary-list chat-summary-list-numbered">
            {nextActions.map((item, idx) => <li key={`${item}-${idx}`} className="chat-summary-list-item">{item}</li>)}
          </ol>
        </div>
      )}

      {(qualityReport || deliveryGates || refinement?.attempted) && (
        <div className="chat-summary-block">
          <p className="chat-summary-label">Quality Outcome</p>
          {qualityReport && (
            <div className="chat-quality-metrics">
              <span className="chat-quality-chip">Code {qualityReport.code_quality}</span>
              <span className="chat-quality-chip">UX {qualityReport.ux_quality}</span>
              <span className="chat-quality-chip">Visual {qualityReport.visual_distinctiveness}</span>
            </div>
          )}
          {deliveryGates && (
            <div className="chat-quality-gates">
              <p className="chat-summary-text">
                Gates: {deliveryGates.passed.length}/{deliveryGates.required.length} passed
              </p>
              {deliveryGates.blocked.length > 0 && (
                <ul className="chat-summary-list">
                  {deliveryGates.blocked.map((gate) => (
                    <li key={gate} className="chat-summary-list-item">{gate.replace(/_/g, ' ')}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {qualityReport && qualityReport.failed_gates.length > 0 && (
            <ul className="chat-summary-list">
              {qualityReport.failed_gates.map((gate) => (
                <li key={gate} className="chat-summary-list-item">{gate.replace(/_/g, ' ')}</li>
              ))}
            </ul>
          )}
          {refinement?.attempted && (
            <p className="chat-summary-text">
              Refinement pass {refinement.pass_index}/{Math.max(refinement.pass_index, refinement.max_passes)} executed.
              {refinement.reason ? ` ${refinement.reason}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CompletionCelebrationBurst({ burstId }: { burstId: string }) {
  const pieces = useMemo(() => {
    const palette = ['var(--tf-accent)', 'var(--tf-accent-blue)', 'var(--tf-success)', 'var(--tf-warning)'];
    return Array.from({ length: 22 }, (_, idx) => ({
      id: `${burstId}-${idx}`,
      left: `${4 + Math.random() * 92}%`,
      delay: `${Math.random() * 280}ms`,
      duration: `${1200 + Math.random() * 700}ms`,
      color: palette[idx % palette.length],
      rotate: `${Math.round((Math.random() * 2 - 1) * 24)}deg`,
    }));
  }, [burstId]);
  return (
    <div className="chat-celebration-layer" aria-hidden="true">
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className="chat-celebration-piece"
          style={{
            left: piece.left,
            animationDelay: piece.delay,
            animationDuration: piece.duration,
            backgroundColor: piece.color,
            transform: `rotate(${piece.rotate})`,
          }}
        />
      ))}
    </div>
  );
}

// ---- Search highlight helper ----

function highlightSearch(text: string, query?: string): React.ReactNode {
  if (!query || !query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === query.toLowerCase()
          ? <mark key={i} style={{ backgroundColor: 'rgba(255,200,0,0.35)', color: 'inherit', borderRadius: '2px' }}>{p}</mark>
          : p
      )}
    </>
  );
}

// ---- Message bubble ----

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  ceoName?: string;
  userName?: string;
  pinned?: boolean;
  onPin?: () => void;
  searchQuery?: string;
  onCopyPath: (path: string) => void;
  onCopyCommand: (command: string) => void;
  onDeployPreview?: (projectId: string) => void;
  onPromoteProduction?: (projectId: string) => void;
  onGenerateReleaseNotes?: (projectId: string) => void;
  onStartReview?: (projectId: string, deploymentUrl?: string) => void;
  onAddBillingPack?: (projectId: string) => void;
  onGuidanceAction?: (action: GuidanceAction, message: ChatMessage) => void;
  reviewActionsEnabled?: boolean;
  billingActionsEnabled?: boolean;
}

function MessageBubble({
  message,
  isStreaming,
  ceoName = 'CEO',
  userName = 'You',
  pinned,
  onPin,
  searchQuery,
  onCopyPath,
  onCopyCommand,
  onDeployPreview,
  onPromoteProduction,
  onGenerateReleaseNotes,
  onStartReview,
  onAddBillingPack,
  onGuidanceAction,
  reviewActionsEnabled = true,
  billingActionsEnabled = true,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const speakerName = isUser ? userName : (isSystem ? 'System' : ceoName);
  const speakerInitial = isSystem ? '!' : ceoName.charAt(0).toUpperCase();
  const [hovered, setHovered] = useState(false);
  const [showFullResponse, setShowFullResponse] = useState(false);
  const structuredRunCommands = message.structured?.run_commands || [];
  const structuredHasDeliverySignals = structuredRunCommands.length > 0
    && (
      (message.structured?.deliverables?.length || 0) > 0
      || (message.structured?.open_links?.length || 0) > 0
      || (message.structured?.validation?.length || 0) > 0
    );
  const showStructuredCard = !isUser
    && !isSystem
    && !isStreaming
    && !searchQuery
    && message.structured?.completion_kind === 'build_complete'
    && structuredHasDeliverySignals
    && hasStructuredContent(message.structured);
  const autoLaunch = !isUser && !isSystem && !isStreaming ? message.auto_launch : undefined;
  const terminalState = !isUser && !isSystem && !isStreaming ? message.terminal_state : undefined;
  const terminalReason = !isUser && !isSystem && !isStreaming ? String(message.error_reason || '').trim() : '';
  const terminalGuidance = !isUser && !isSystem && !isStreaming ? message.guidance : undefined;
  const supplementalGuidance = !isUser && !isSystem && !isStreaming && terminalState === 'done'
    ? message.guidance
    : undefined;
  const runReplay = !isUser && !isSystem && !isStreaming ? String(message.run_replay || '').trim() : '';
  const normalizedAutoLaunchUrl = autoLaunch?.open_url
    ? trimLinkTarget(String(autoLaunch.open_url).replace(/^open app:\s*/i, '').replace(/\*+$/g, ''))
    : '';
  const canOpenAutoLaunchUrl = normalizedAutoLaunchUrl ? isHttpUrl(normalizedAutoLaunchUrl) : false;
  const completionPreviewUrl = useMemo(() => {
    const links = message.structured?.open_links || [];
    const candidate = links.find((item) => item.kind === 'url' && isHttpUrl(String(item.target || '')));
    return candidate ? trimLinkTarget(String(candidate.target || '')) : '';
  }, [message.structured]);

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-slide-up`}
      style={{ position: 'relative', minWidth: 0 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!isUser && (
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2 mt-1"
          style={{
            backgroundColor: isSystem ? 'var(--tf-warning)' : 'var(--tf-accent)',
            color: 'var(--tf-bg)',
          }}
          title={speakerName}
        >
          {speakerInitial}
        </div>
      )}

      <div style={{ maxWidth: isUser ? '75%' : '82%', minWidth: 0, position: 'relative' }}>
        {pinned && (
          <div style={{ position: 'absolute', top: '-8px', right: isUser ? '8px' : 'auto', left: !isUser ? '8px' : 'auto', fontSize: '10px', color: 'var(--tf-warning)', zIndex: 1 }}>
            PIN
          </div>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 ${isStreaming ? 'streaming-bubble' : ''}`}
          style={{
            backgroundColor: isUser ? 'var(--tf-user-bubble)' : (isSystem ? 'rgba(43, 65, 90, 0.9)' : 'var(--tf-surface-raised)'),
            borderBottomRightRadius: isUser ? '4px' : undefined,
            borderBottomLeftRadius: !isUser ? '4px' : undefined,
            border: isStreaming
              ? '1px solid var(--tf-accent)'
              : isSystem
                ? '1px solid rgba(255,185,0,0.4)'
                : pinned
                  ? '1px solid rgba(255,180,0,0.4)'
                  : '1px solid transparent',
            transition: 'border-color 0.3s',
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold" style={{ color: isUser ? 'var(--tf-accent-blue)' : (isSystem ? 'var(--tf-warning)' : 'var(--tf-accent)') }}>
              {speakerName}
            </span>
            {message.timestamp && <span className="text-xs" style={{ color: 'var(--tf-border)' }}>{formatTime(message.timestamp)}</span>}
            {isStreaming && <span className="text-xs font-medium" style={{ color: 'var(--tf-accent)', opacity: 0.7 }}>typing…</span>}
          </div>
          {isUser ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--tf-text)' }}>
              {highlightSearch(message.content || (isStreaming ? '' : '(empty)'), searchQuery)}
            </p>
          ) : (
            <div className="text-sm leading-relaxed break-words" style={{ minWidth: 0 }}>
              {message.content ? (
                <>
                  {showStructuredCard && (
                    <StructuredCompletionCard
                      structured={message.structured || {}}
                      qualityReport={message.quality_report}
                      deliveryGates={message.delivery_gates}
                      refinement={message.refinement}
                      showFullResponse={showFullResponse}
                      onToggleFullResponse={() => setShowFullResponse((prev) => !prev)}
                      onCopyPath={onCopyPath}
                      onCopyCommand={onCopyCommand}
                    />
                  )}
                  {showStructuredCard && message.project_id && (
                    <div className="chat-completion-actions">
                      <button type="button" className="chat-summary-copy-btn" onClick={() => onDeployPreview?.(message.project_id || '')}>
                        Deploy preview
                      </button>
                      <button type="button" className="chat-summary-copy-btn" onClick={() => onPromoteProduction?.(message.project_id || '')}>
                        Promote prod
                      </button>
                      <button type="button" className="chat-summary-copy-btn" onClick={() => onGenerateReleaseNotes?.(message.project_id || '')}>
                        Release notes
                      </button>
                      {reviewActionsEnabled && (
                        <button
                          type="button"
                          className="chat-summary-copy-btn"
                          onClick={() => onStartReview?.(message.project_id || '', completionPreviewUrl || undefined)}
                        >
                          Start review
                        </button>
                      )}
                      {billingActionsEnabled && (
                        <button
                          type="button"
                          className="chat-summary-copy-btn"
                          onClick={() => onAddBillingPack?.(message.project_id || '')}
                        >
                          Add billing pack
                        </button>
                      )}
                    </div>
                  )}
                  {searchQuery
                    ? <p style={{ color: 'var(--tf-text)', fontSize: '13px', lineHeight: '1.6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{highlightSearch(message.content, searchQuery)}</p>
                    : (!showStructuredCard || showFullResponse) && <MarkdownBody content={message.content} onCopyPath={onCopyPath} />
                  }
                  {autoLaunch?.attempted && (
                    <div className="chat-auto-launch-card">
                      <div className="chat-auto-launch-header">
                        <span className={`chat-auto-launch-dot ${autoLaunch.started ? 'chat-auto-launch-dot-ok' : 'chat-auto-launch-dot-fail'}`} />
                        <span>{autoLaunch.started ? 'Auto-start completed' : 'Auto-start blocked'}</span>
                      </div>
                      {autoLaunch.command && (
                        <div className="chat-auto-launch-command-row">
                          <code className="chat-markdown-inline-code" style={{ flex: 1, minWidth: 0 }}>{autoLaunch.command}</code>
                          <button
                            type="button"
                            className="chat-summary-copy-btn"
                            onClick={() => onCopyCommand(autoLaunch.command)}
                            title={`Copy command: ${autoLaunch.command}`}
                          >
                            Copy
                          </button>
                        </div>
                      )}
                      {canOpenAutoLaunchUrl && (
                        <a href={normalizedAutoLaunchUrl} target="_blank" rel="noreferrer" className="chat-http-link">
                          Open app: {normalizedAutoLaunchUrl}
                        </a>
                      )}
                      {autoLaunch.message && (
                        <p className="chat-auto-launch-message">{autoLaunch.message}</p>
                      )}
                    </div>
                  )}
                  {supplementalGuidance?.action_required !== false && supplementalGuidance?.message && (
                    <InlineActionCard
                      title="Action Required"
                      message={supplementalGuidance.message}
                      severity={message.content.startsWith('[Warning]') ? 'warning' : 'error'}
                      correlationId={supplementalGuidance.correlation_id}
                      actions={supplementalGuidance.actions || []}
                      onAction={(action) => onGuidanceAction?.(action, message)}
                    />
                  )}
                  {terminalState && terminalState !== 'done' && (
                    <InlineActionCard
                      title={terminalStateLabel(terminalState)}
                      message={terminalGuidance?.message || terminalReason || 'The run ended before a complete delivery could be produced.'}
                      severity={terminalState === 'cancelled' ? 'warning' : 'error'}
                      correlationId={terminalGuidance?.correlation_id}
                      actions={terminalGuidance?.actions || []}
                      onAction={(action) => onGuidanceAction?.(action, message)}
                    />
                  )}
                  {runReplay && (
                    <div className="chat-run-replay-card">
                      <p className="chat-summary-label">Run Replay</p>
                      <p className="chat-summary-text">{runReplay}</p>
                    </div>
                  )}
                  {isStreaming && <span className="blink-cursor" />}
                </>
              ) : (
                isStreaming ? <span className="blink-cursor" /> : <span style={{ color: 'var(--tf-text-muted)' }}>(empty response)</span>
              )}
            </div>
          )}
        </div>

        {/* Pin/unpin button on hover */}
        {onPin && hovered && !isStreaming && !isSystem && (
          <button
            onClick={onPin}
            title={pinned ? 'Unpin' : 'Pin message'}
            style={{
              position: 'absolute', top: '4px',
              right: isUser ? 'calc(100% + 4px)' : 'auto',
              left: !isUser ? 'calc(100% + 4px)' : 'auto',
              background: 'var(--tf-surface)', border: '1px solid var(--tf-border)',
              borderRadius: '6px', padding: '2px 6px', cursor: 'pointer',
              fontSize: '11px', color: pinned ? 'var(--tf-warning)' : 'var(--tf-text-muted)',
              zIndex: 10, whiteSpace: 'nowrap',
            }}
          >
            {pinned ? 'Unpin' : 'Pin'}
          </button>
        )}
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ml-2 mt-1"
          style={{ backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)' }} title={userName}>
          {userName.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}

// ---- Empty state ----

interface PromptExamplesStarterProps {
  category: string;
  onCategoryChange: (category: string) => void;
  examples: PromptExample[];
  recentExamples: PromptExample[];
  onSelectExample: (exampleId: string) => void;
  onClose: () => void;
  showClose: boolean;
}

function PromptExamplesStarter({
  category,
  onCategoryChange,
  examples,
  recentExamples,
  onSelectExample,
  onClose,
  showClose,
}: PromptExamplesStarterProps) {
  return (
    <div className="prompt-starter-panel animate-slide-up">
      <div className="prompt-starter-header">
        <div>
          <p className="prompt-starter-title">Prompt Examples</p>
          <p className="prompt-starter-subtitle">Pick a starter app idea and we will inject the full prompt into chat.</p>
        </div>
        {showClose && (
          <button type="button" className="prompt-starter-close" onClick={onClose}>
            Hide
          </button>
        )}
      </div>

      <div className="prompt-starter-categories">
        <button
          type="button"
          className={`prompt-starter-category${category === PROMPT_CATEGORY_ALL ? ' prompt-starter-category-active' : ''}`}
          onClick={() => onCategoryChange(PROMPT_CATEGORY_ALL)}
        >
          All
        </button>
        {PROMPT_EXAMPLE_CATEGORIES.map((item) => (
          <button
            key={item}
            type="button"
            className={`prompt-starter-category${category === item ? ' prompt-starter-category-active' : ''}`}
            onClick={() => onCategoryChange(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {recentExamples.length > 0 && (
        <div className="prompt-starter-recent">
          <span className="prompt-starter-recent-label">Recent</span>
          {recentExamples.map((example) => (
            <button
              key={`recent-${example.id}`}
              type="button"
              className="prompt-starter-recent-chip"
              onClick={() => onSelectExample(example.id)}
              title={example.prompt}
            >
              {example.label}
            </button>
          ))}
        </div>
      )}

      <div className="prompt-starter-list">
        {examples.map((example) => (
          <button
            key={example.id}
            type="button"
            className="prompt-starter-card"
            onClick={() => onSelectExample(example.id)}
            title={example.prompt}
          >
            <span className="prompt-starter-card-title">{example.label}</span>
            <span className="prompt-starter-card-badge">{example.category}</span>
            <span className="prompt-starter-card-preview">{example.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ ceoName = 'CEO', requireProject = false }: { ceoName?: string; requireProject?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 py-20">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
        <svg className="w-8 h-8" style={{ color: 'var(--tf-accent)' }} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium" style={{ color: 'var(--tf-text)' }}>Chat with {ceoName}</p>
        <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
          {requireProject
            ? 'Select or create a project above, then send your first message.'
            : `Send a message to start. ${ceoName} can manage projects, tasks, and operations.`}
        </p>
      </div>
    </div>
  );
}

// ---- Action log ----

interface ActionEntry {
  text: string;
  status: 'running' | 'done';
  result?: string;
  at: string;
}

interface ActionDetailEntry {
  label: string;
  command?: string;
  tool?: string;
  file_path?: string;
  actor?: string;
  target?: string;
  flow?: string;
  cwd?: string;
  duration_ms?: number;
  exit_code?: number;
  output_preview?: string;
  state?: string;
  run_id?: string;
  at: string;
}

interface DelegationReasonItem {
  agent_id: string;
  agent_name: string;
  reason: string;
}

interface DelegationContext {
  stage: string;
  summary: string;
  reasons: DelegationReasonItem[];
}

function ActionLog({ entries, ceoName }: { entries: ActionEntry[]; ceoName: string }) {
  const [collapsed, setCollapsed] = useState(false);
  if (entries.length === 0) return null;
  const running = entries.filter((e) => e.status === 'running').length;
  const done = entries.filter((e) => e.status === 'done').length;
  // Detect if any delegation happened — if so, say "Team" not just CEO
  const hasDelegation = entries.some((e) => /delegat|is working on:/i.test(e.text));
  const headerLabel = hasDelegation ? 'Team' : ceoName;
  return (
    <div className="mx-1 mb-3 rounded-lg overflow-hidden" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
      <button onClick={() => setCollapsed((c) => !c)} className="w-full flex items-center gap-2 px-3 py-1.5 cursor-pointer text-left"
        style={{ borderBottom: collapsed ? 'none' : '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
        {running > 0
          ? <span className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot" style={{ backgroundColor: 'var(--tf-accent)' }} />
          : <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--tf-success)' }} />}
        <span className="text-xs font-medium flex-1" style={{ color: 'var(--tf-text-secondary)' }}>
          {running > 0 ? `${headerLabel} is working` : `${headerLabel} completed ${done} action${done !== 1 ? 's' : ''}`}
        </span>
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)', fontFamily: 'monospace' }}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className="px-3 py-2 space-y-1.5 max-h-44 overflow-y-auto">
          {entries.map((entry, i) => {
            const info = parseActionText(entry.text);
            return (
              <div key={i} className="flex items-start gap-2">
                {entry.status === 'done'
                  ? <span className="text-xs flex-shrink-0 w-3 text-center" style={{ color: 'var(--tf-success)' }}>✓</span>
                  : <span className="text-xs flex-shrink-0 w-3 text-center animate-pulse-dot" style={{ color: info.color }}>{info.icon}</span>}
                <div style={{ minWidth: 0 }}>
                  <div className="text-xs leading-snug" style={{ color: entry.status === 'done' ? 'var(--tf-text-muted)' : info.color }}>
                    {info.label}
                  </div>
                  {entry.result && (
                    <div
                      className="text-xs leading-snug mt-0.5"
                      style={{
                        color: 'var(--tf-text-muted)',
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.result}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DelegationReasoning({ context }: { context: DelegationContext }) {
  if (!context.summary && context.reasons.length === 0) return null;
  const stageLabel = context.stage
    ? context.stage.split('_').map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ')
    : 'Delegation Plan';
  return (
    <div
      className="mx-1 mb-2 rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}
    >
      <div
        className="px-3 py-1.5 text-xs font-medium"
        style={{ color: 'var(--tf-accent-blue)', borderBottom: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)' }}
      >
        Delegation Reasoning • {stageLabel}
      </div>
      <div className="px-3 py-2 space-y-1.5">
        {context.summary && (
          <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-muted)' }}>
            {context.summary}
          </p>
        )}
        {context.reasons.map((item) => (
          <div key={item.agent_id} className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
            <strong style={{ color: 'var(--tf-text)' }}>{item.agent_name}:</strong> {item.reason}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Project approval card ----

interface ProjectApprovalCardProps {
  project: Project;
  ceoName: string;
  onApproved: (projectId: string) => void;
  onRevise: (projectName: string) => void;
  onNavigateToProject?: (projectId: string) => void;
}

function ProjectApprovalCard({ project, ceoName, onApproved, onRevise, onNavigateToProject }: ProjectApprovalCardProps) {
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const [missingItems, setMissingItems] = useState<string[]>([]);
  const handleApprove = async () => {
    setApproving(true);
    setError('');
    setMissingItems([]);
    const result = await approveProjectPlan(project.id);
    setApproving(false);
    if (result.ok) {
      setApproved(true);
      onApproved(project.id);
      return;
    }
    if (result.missing_items?.length) setMissingItems(result.missing_items);
    setError(result.summary || 'Plan is not ready for approval yet.');
  };
  if (approved) {
    return (
      <div className="mx-1 mb-3 px-4 py-3 rounded-xl animate-slide-up flex items-center gap-2"
        style={{ backgroundColor: 'rgba(63,185,80,0.08)', border: '1px solid rgba(63,185,80,0.3)' }}>
        <span style={{ color: 'var(--tf-success)' }}>✓</span>
        <span className="text-xs font-medium" style={{ color: 'var(--tf-success)' }}>"{project.name}" approved — team is now active</span>
      </div>
    );
  }
  return (
    <div className="mx-1 mb-3 rounded-xl overflow-hidden animate-pop-in" style={{ border: '1px solid var(--tf-accent)', backgroundColor: 'var(--tf-surface)' }}>
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: 'var(--tf-surface-raised)', borderBottom: '1px solid var(--tf-border)' }}>
        <span className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot" style={{ backgroundColor: 'var(--tf-accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--tf-accent)' }}>Plan Ready for Approval</span>
      </div>
      <div className="px-4 py-3 space-y-2">
        <p className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>{ceoName} has finished planning:</p>
        <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>{project.name}</p>
        {project.description && (
          <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {project.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderTop: '1px solid var(--tf-border)' }}>
        <button onClick={handleApprove} disabled={approving}
          className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all duration-200"
          style={{ backgroundColor: approving ? 'var(--tf-surface-raised)' : 'var(--tf-accent)', color: approving ? 'var(--tf-text-muted)' : 'var(--tf-bg)', border: 'none', cursor: approving ? 'wait' : 'pointer' }}>
          {approving ? 'Approving…' : '✓ Approve & Start'}
        </button>
        <button onClick={() => onRevise(project.name)}
          className="text-xs px-3 py-1.5 rounded-lg transition-all duration-200"
          style={{ backgroundColor: 'transparent', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)'; }}>
          ✗ Request Changes
        </button>
        {onNavigateToProject && (
          <button onClick={() => onNavigateToProject(project.id)}
            className="text-xs px-3 py-1.5 rounded-lg transition-all duration-200 ml-auto"
            style={{ backgroundColor: 'transparent', color: 'var(--tf-accent-blue)', border: 'none', cursor: 'pointer' }}>
            View Plan ↗
          </button>
        )}
      </div>
      {(error || missingItems.length > 0) && (
        <div className="px-4 py-2.5" style={{ borderTop: '1px solid var(--tf-border)' }}>
          {error && <p className="text-xs font-medium" style={{ color: 'var(--tf-error)' }}>{error}</p>}
          {missingItems.length > 0 && (
            <ul className="mt-1 space-y-1">
              {missingItems.map((item, idx) => (
                <li key={`${item}-${idx}`} className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>• {item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Pinned messages overlay ----

function PinnedPanel({ messages, ceoName, userName, onClose, onUnpin }: {
  messages: ChatMessage[]; ceoName: string; userName: string;
  onClose: () => void; onUnpin: (key: string) => void;
}) {
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'var(--tf-bg)', zIndex: 20, display: 'flex', flexDirection: 'column' }}>
      <div className="flex items-center justify-between px-3 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--tf-border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>Pinned ({messages.length})</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tf-text-muted)', fontSize: '14px' }}>✕</button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0
          ? <p className="text-xs text-center py-8" style={{ color: 'var(--tf-text-muted)' }}>No pinned messages.</p>
          : messages.map((msg) => {
            const k = msgKey(msg);
            const isUser = msg.role === 'user';
            return (
              <div key={k} className="mb-3 rounded-xl p-3" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid rgba(255,180,0,0.4)' }}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold" style={{ color: isUser ? 'var(--tf-accent-blue)' : 'var(--tf-accent)' }}>
                    {isUser ? userName : ceoName}
                    <span className="font-normal ml-2" style={{ color: 'var(--tf-border)' }}>{formatTime(msg.timestamp)}</span>
                  </span>
                  <button onClick={() => onUnpin(k)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tf-warning)', fontSize: '11px' }}>Unpin</button>
                </div>
                <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--tf-text-secondary)' }}>
                  {msg.content.slice(0, 300)}{msg.content.length > 300 ? '…' : ''}
                </p>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

// ---- WebSocket types ----

interface WsMessage {
  type:
    | 'user_ack'
    | 'thinking'
    | 'chunk'
    | 'done'
    | 'error'
    | 'warning'
    | 'action'
    | 'action_result'
    | 'action_detail'
    | 'run'
    | 'run_status'
    | 'run_phase'
    | 'run_incident'
    | 'run_control_ack'
    | 'micro_project_warning'
    | 'planning_approval_required'
    | 'project_context';
  content?: string | {
    id?: string;
    status?: string;
    mode?: string;
    intent?: { intent?: string; class?: string; confidence?: number; needs_planning?: boolean; actionable?: boolean };
    intent_class?: string;
    plan_packet?: { ready?: boolean; missing_items?: string[]; summary?: string };
    planning_packet_status?: { ready?: boolean; missing_items?: string[]; summary?: string };
    reason?: string;
    run_id?: string;
    [k: string]: unknown;
  };
  message?: ChatMessage;
  project_id?: string;
  created?: boolean;
  project?: Project;
  run_id?: string;
  structured?: StructuredChatResponse;
  deploy_offer?: {
    project_id?: string;
    project_name?: string;
    target?: 'preview' | 'production';
  };
  auto_launch?: AutoLaunchStatus;
  run_status?: RunStatusEvent;
  run_incident?: RunIncidentEvent;
  terminal_state?: RunDoneTerminalState;
  error_reason?: string;
  guidance?: GuidancePayload;
  completion_celebration?: CompletionCelebrationPayload;
  run_replay?: string;
  quality_report?: QualityReport;
  delivery_gates?: DeliveryGates;
  refinement?: RefinementPayload;
}
function isWsMessage(data: unknown): data is WsMessage {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).type === 'string';
}

function wsContentObject(content: WsMessage['content']): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : null;
}

function wsContentText(content: WsMessage['content'], fallback = ''): string {
  if (typeof content === 'string') return content;
  const payload = wsContentObject(content);
  if (!payload) return fallback;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.summary === 'string') return payload.summary;
  if (typeof payload.detail === 'string') return payload.detail;
  return fallback;
}

function normalizeGuidancePayload(raw: unknown): GuidancePayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const message = String(source.message || source.detail || '').trim();
  if (!message) return undefined;
  const actions = Array.isArray(source.actions)
    ? source.actions
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      .map((entry) => {
        const id = String(entry.id || '').trim() || `action-${Math.random().toString(36).slice(2, 8)}`;
        const label = String(entry.label || entry.id || 'Action').trim() || 'Action';
        const kind = String(entry.kind || 'retry').trim();
        const target = String(entry.target || '').trim();
        const payload = entry.payload && typeof entry.payload === 'object'
          ? entry.payload as Record<string, unknown>
          : undefined;
        const action: GuidanceAction = { id, label, kind };
        if (target) action.target = target;
        if (payload && Object.keys(payload).length > 0) action.payload = payload;
        return action;
      })
    : [];
  const guidance: GuidancePayload = {
    message,
    code: String(source.code || '').trim() || undefined,
    correlation_id: String(source.correlation_id || '').trim() || undefined,
    action_required: source.action_required === undefined ? actions.length > 0 : Boolean(source.action_required),
    actions,
  };
  return guidance;
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const cfg: Record<ConnectionStatus, { color: string; label: string }> = {
    connecting:   { color: 'var(--tf-warning)',    label: 'Connecting...' },
    connected:    { color: 'var(--tf-success)',     label: 'Connected' },
    disconnected: { color: 'var(--tf-text-muted)',  label: 'Disconnected' },
    error:        { color: 'var(--tf-error)',        label: 'Error' },
  };
  const { color, label } = cfg[status];
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${status === 'connecting' ? 'animate-pulse-dot' : ''}`} style={{ backgroundColor: color }} />
      <span className="text-xs" style={{ color }}>{label}</span>
    </div>
  );
}

// ---- Thinking indicator ----

const THINKING_PHRASES = ['Thinking…', 'Analyzing your request…', 'Consulting the team…', 'Reviewing context…', 'Processing…'];
function ThinkingIndicator({ ceoName, customText }: { ceoName: string; customText?: string }) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  useEffect(() => {
    if (customText) return;
    const id = setInterval(() => setPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length), 2200);
    return () => clearInterval(id);
  }, [customText]);
  const phrase = customText || THINKING_PHRASES[phraseIdx];
  return (
    <div className="flex justify-start mb-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2"
        style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }}>
        {ceoName.charAt(0).toUpperCase()}
      </div>
      <div className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: 'var(--tf-surface-raised)', borderBottomLeftRadius: '4px' }}>
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="w-1.5 h-1.5 rounded-full animate-pulse-dot"
              style={{ backgroundColor: 'var(--tf-accent)', animationDelay: `${i * 0.2}s` }} />
          ))}
        </div>
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>{phrase}</span>
      </div>
    </div>
  );
}

// ---- Main ChatPanel ----

interface ChatPanelProps {
  floating?: boolean;
  chatOpen?: boolean;
  onNewCeoMessage?: () => void;
  ceoName?: string;
  userName?: string;
  microProjectMode?: boolean;
  onMicroProjectModeChange?: (enabled: boolean) => void;
  onNavigateToProject?: (projectId: string) => void;
  onOpenSettings?: (connector?: 'github' | 'vercel' | 'stripe') => void;
  onOpenEventLog?: () => void;
  pendingApprovalProjects?: Project[];
  onProjectApproved?: (projectId: string) => void;
  projects?: Project[];
  activeProjectId?: string;
  onActiveProjectChange?: (projectId: string) => void;
  telegramMirrorEnabled?: boolean;
  onTelegramMirrorChange?: (enabled: boolean) => void;
  microToggleRequestToken?: number;
  onAgentActivity?: (agentId: string, task: string, flow: 'down' | 'up' | 'working') => void;
  onAgentRemove?: (agentId: string) => void;
  onWorkforceRefreshRequest?: () => void;
  onProjectDataRefresh?: () => void;
  onRunStatus?: (event: RunStatusEvent) => void;
  onRunIncident?: (event: RunIncidentEvent | null) => void;
  onRunStart?: (runId: string, projectId: string) => void;
  runStatus?: RunStatusEvent | null;
  runIncident?: RunIncidentEvent | null;
  onRunControl?: (action: 'status' | 'retry_step' | 'cancel' | 'continue') => void;
  runControlBusyAction?: 'status' | 'retry_step' | 'cancel' | 'continue' | '';
  runControlMessage?: string;
  completionCelebrationEnabled?: boolean;
  previewReviewEnabled?: boolean;
  contextPacksEnabled?: boolean;
  stripeBillingPackEnabled?: boolean;
}

export default function ChatPanel({
  floating = false,
  chatOpen,
  onNewCeoMessage,
  ceoName = 'CEO',
  userName = 'You',
  microProjectMode = false,
  onMicroProjectModeChange,
  onNavigateToProject,
  pendingApprovalProjects = [],
  onProjectApproved,
  projects = [],
  activeProjectId = '',
  onActiveProjectChange,
  telegramMirrorEnabled = false,
  onTelegramMirrorChange,
  microToggleRequestToken = 0,
  onAgentActivity,
  onAgentRemove,
  onWorkforceRefreshRequest,
  onProjectDataRefresh,
  onOpenSettings,
  onOpenEventLog,
  onRunStatus,
  onRunIncident,
  onRunStart,
  runStatus = null,
  runIncident = null,
  onRunControl,
  runControlBusyAction = '',
  runControlMessage = '',
  completionCelebrationEnabled = true,
  previewReviewEnabled = true,
  contextPacksEnabled = true,
  stripeBillingPackEnabled = true,
}: ChatPanelProps) {
  const { toast } = useToast();
  // Core state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [waitElapsedSec, setWaitElapsedSec] = useState(0);
  const [streamingContent, setStreamingContent] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const showThinking = true;
  const [thinkingContent, setThinkingContent] = useState('');
  const [actionLog, setActionLog] = useState<ActionEntry[]>([]);
  const [actionDetails, setActionDetails] = useState<ActionDetailEntry[]>([]);
  const [delegationContext, setDelegationContext] = useState<DelegationContext | null>(null);
  const [showActionDetails, setShowActionDetails] = useState(false);
  const [latestRunId, setLatestRunId] = useState('');
  const [liveRunStatus, setLiveRunStatus] = useState<RunStatusEvent | null>(runStatus);
  const [liveRunIncident, setLiveRunIncident] = useState<RunIncidentEvent | null>(runIncident);
  const [planningPendingDecision, setPlanningPendingDecision] = useState<{ message: string; reason: string; missingItems?: string[] } | null>(null);
  const [dismissedProjectIds, setDismissedProjectIds] = useState<Set<string>>(new Set());
  const [deployOffer, setDeployOffer] = useState<{ projectId: string; projectName: string; target: 'preview' | 'production' } | null>(null);
  const [deployingVercel, setDeployingVercel] = useState(false);
  const [celebrationBurstId, setCelebrationBurstId] = useState('');
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  // Feature: Conversation search
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showContextPacks, setShowContextPacks] = useState(false);
  const [showPreviewReview, setShowPreviewReview] = useState(false);
  const [reviewDeploymentUrl, setReviewDeploymentUrl] = useState('');
  const [showPromptExamplesPanel, setShowPromptExamplesPanel] = useState(false);
  const [promptExampleCategory, setPromptExampleCategory] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(PROMPT_EXAMPLES_CATEGORY_KEY) || '';
      if (stored === PROMPT_CATEGORY_ALL) return PROMPT_CATEGORY_ALL;
      if (PROMPT_EXAMPLE_CATEGORIES.includes(stored as typeof PROMPT_EXAMPLE_CATEGORIES[number])) {
        return stored;
      }
    } catch {
      // Ignore storage errors and use default.
    }
    return PROMPT_CATEGORY_ALL;
  });
  const [promptRecentExampleIds, setPromptRecentExampleIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PROMPT_EXAMPLES_RECENT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .filter((id, idx, arr) => arr.indexOf(id) === idx)
        .filter((id) => PROMPT_EXAMPLES.some((example) => example.id === id))
        .slice(0, PROMPT_EXAMPLES_RECENT_LIMIT);
    } catch {
      return [];
    }
  });
  const [promptExamplesSeenByProject, setPromptExamplesSeenByProject] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(PROMPT_EXAMPLES_SEEN_BY_PROJECT_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, boolean>>((acc, [key, value]) => {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey) return acc;
        acc[normalizedKey] = Boolean(value);
        return acc;
      }, {});
    } catch {
      return {};
    }
  });
  const [promptExamplesHiddenByProject, setPromptExamplesHiddenByProject] = useState<Record<string, boolean>>({});

  // Feature: Micro Project mode (fast solo CEO path)
  const [showMicroApprovalCard, setShowMicroApprovalCard] = useState(false);
  const [microPendingDecision, setMicroPendingDecision] = useState<{ message: string; reason: string } | null>(null);

  // Feature: Pinned messages
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      const s = localStorage.getItem('tf_pinned_msgs');
      return s ? new Set(JSON.parse(s)) : new Set();
    } catch { return new Set(); }
  });
  const [showPinned, setShowPinned] = useState(false);

  // Feature: CEO Memory
  const [memoryEntries, setMemoryEntries] = useState<string[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [newMemoryText, setNewMemoryText] = useState('');
  const [memorySaving, setMemorySaving] = useState(false);
  const lastHandledMicroToggleRequestRef = useRef(0);
  const [memoryScope, setMemoryScope] = useState<'global' | 'project' | 'session-only'>('project');
  const [memoryRetentionDays, setMemoryRetentionDays] = useState(30);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  const pendingOutboundRef = useRef<string | null>(null);
  const chatOpenRef = useRef(chatOpen);
  const ceoNameRef = useRef(ceoName);
  const activeProjectIdRef = useRef(activeProjectId);
  const projectsRef = useRef(projects);
  const onActiveProjectChangeRef = useRef(onActiveProjectChange);
  const onNewCeoMessageRef = useRef(onNewCeoMessage);
  const onAgentActivityRef = useRef(onAgentActivity);
  const onAgentRemoveRef = useRef(onAgentRemove);
  const onWorkforceRefreshRequestRef = useRef(onWorkforceRefreshRequest);
  const onProjectDataRefreshRef = useRef(onProjectDataRefresh);
  const onRunStatusRef = useRef(onRunStatus);
  const onRunIncidentRef = useRef(onRunIncident);
  const onRunStartRef = useRef(onRunStart);
  const streamingAccumRef = useRef('');
  const turnErroredRef = useRef(false);
  const isWaitingRef = useRef(false);
  const lastOutboundMessageRef = useRef('');
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const telegramMirrorEnabledRef = useRef(telegramMirrorEnabled);
  const waitStartedAtRef = useRef<number | null>(null);
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenCelebrationRunsRef = useRef<Set<string>>(new Set());
  const activePromptProjectKey = activeProjectId || '__global__';

  const markPromptExamplesSeen = useCallback((projectKey: string) => {
    const normalized = String(projectKey || '').trim();
    if (!normalized) return;
    setPromptExamplesSeenByProject((prev) => {
      if (prev[normalized]) return prev;
      const next = { ...prev, [normalized]: true };
      try {
        localStorage.setItem(PROMPT_EXAMPLES_SEEN_BY_PROJECT_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage failures.
      }
      return next;
    });
  }, []);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const length = el.value.length;
      try {
        el.setSelectionRange(length, length);
      } catch {
        // ignored: some browsers may reject selection range on blurred nodes
      }
    });
  }, []);

  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);
  useEffect(() => { ceoNameRef.current = ceoName; }, [ceoName]);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { onActiveProjectChangeRef.current = onActiveProjectChange; }, [onActiveProjectChange]);
  useEffect(() => { onNewCeoMessageRef.current = onNewCeoMessage; }, [onNewCeoMessage]);
  useEffect(() => { onAgentActivityRef.current = onAgentActivity; }, [onAgentActivity]);
  useEffect(() => { onAgentRemoveRef.current = onAgentRemove; }, [onAgentRemove]);
  useEffect(() => { onWorkforceRefreshRequestRef.current = onWorkforceRefreshRequest; }, [onWorkforceRefreshRequest]);
  useEffect(() => { onProjectDataRefreshRef.current = onProjectDataRefresh; }, [onProjectDataRefresh]);
  useEffect(() => { onRunStatusRef.current = onRunStatus; }, [onRunStatus]);
  useEffect(() => { onRunIncidentRef.current = onRunIncident; }, [onRunIncident]);
  useEffect(() => { onRunStartRef.current = onRunStart; }, [onRunStart]);
  useEffect(() => { setLiveRunStatus(runStatus); }, [runStatus]);
  useEffect(() => { setLiveRunIncident(runIncident); }, [runIncident]);
  useEffect(() => { isWaitingRef.current = isWaiting; }, [isWaiting]);
  useEffect(() => { telegramMirrorEnabledRef.current = telegramMirrorEnabled; }, [telegramMirrorEnabled]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPrefersReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PROMPT_EXAMPLES_CATEGORY_KEY, promptExampleCategory || PROMPT_CATEGORY_ALL);
    } catch {
      // Ignore storage failures.
    }
  }, [promptExampleCategory]);

  useEffect(() => {
    try {
      localStorage.setItem(PROMPT_EXAMPLES_RECENT_KEY, JSON.stringify(promptRecentExampleIds.slice(0, PROMPT_EXAMPLES_RECENT_LIMIT)));
    } catch {
      // Ignore storage failures.
    }
  }, [promptRecentExampleIds]);

  useEffect(() => {
    try {
      localStorage.setItem(PROMPT_EXAMPLES_SEEN_BY_PROJECT_KEY, JSON.stringify(promptExamplesSeenByProject));
    } catch {
      // Ignore storage failures.
    }
  }, [promptExamplesSeenByProject]);

  useEffect(() => {
    setShowPromptExamplesPanel(false);
  }, [activeProjectId]);

  useEffect(() => {
    if (!isWaiting) {
      waitStartedAtRef.current = null;
      setWaitElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    waitStartedAtRef.current = startedAt;
    setWaitElapsedSec(0);
    const timer = setInterval(() => {
      const anchor = waitStartedAtRef.current || startedAt;
      setWaitElapsedSec(Math.max(0, Math.floor((Date.now() - anchor) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [isWaiting]);

  const handleInlineRunControl = useCallback((action: 'status' | 'retry_step' | 'cancel' | 'continue') => {
    onRunControl?.(action);
  }, [onRunControl]);

  const triggerCompletionCelebration = useCallback((payload?: CompletionCelebrationPayload) => {
    if (!payload || !payload.eligible) return;
    if (!completionCelebrationEnabled) return;
    if (prefersReducedMotion) return;
    const runId = String(payload.run_id || '').trim();
    if (!runId || seenCelebrationRunsRef.current.has(runId)) return;
    seenCelebrationRunsRef.current.add(runId);
    const burstKey = `${runId}-${Date.now()}`;
    setCelebrationBurstId(burstKey);
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    celebrationTimerRef.current = setTimeout(() => {
      setCelebrationBurstId('');
      celebrationTimerRef.current = null;
    }, 2100);
  }, [completionCelebrationEnabled, prefersReducedMotion]);

  // Telegram incoming message polling
  useEffect(() => {
    if (!telegramMirrorEnabled) return;
    const creds = readTelegramCredentials();
    if (!creds.configured || !creds.token) return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const msgs = await pollTelegramMessages(creds.token);
        if (cancelled) return;
        for (const msg of msgs) {
          // Skip if chat is busy (CEO is working), queue message display only
          const senderLabel = msg.from || 'Telegram';
          const content = `[via Telegram] ${msg.text}`;
          setMessages((prev) => [...prev, {
            role: 'user',
            content,
            timestamp: new Date(msg.date * 1000).toISOString(),
            project_id: activeProjectIdRef.current || '',
          }]);
          // Send to CEO via WebSocket if connected and not busy
          if (!isWaitingRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            const idempotencyKey = `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            wsRef.current.send(JSON.stringify({
              message: `[Message from ${senderLabel} via Telegram]: ${msg.text}`,
              structured_response: true,
              sandbox_profile: 'standard',
              idempotency_key: idempotencyKey,
              project_id: activeProjectIdRef.current || '',
            }));
            setIsWaiting(true);
            setStreamingContent('');
            setThinkingContent('');
            setActionLog([]);
            setActionDetails([]);
            setDelegationContext(null);
            streamingAccumRef.current = '';
          }
        }
      } catch {
        // Silently ignore polling errors
      }
    };

    const interval = setInterval(poll, 5000);
    poll(); // immediate first poll
    return () => { cancelled = true; clearInterval(interval); };
  }, [telegramMirrorEnabled]);

  useEffect(() => { if (showSearch) setTimeout(() => searchRef.current?.focus(), 50); }, [showSearch]);

  // Pin
  const handlePin = useCallback((key: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem('tf_pinned_msgs', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Derived: filtered messages (search) + pinned
  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  const pinnedMessages = useMemo(() => messages.filter((m) => pinnedIds.has(msgKey(m))), [messages, pinnedIds]);
  const memoryScopeOptions = useMemo(() => ([
    { value: 'global', label: 'Global', description: 'Shared across all projects.' },
    { value: 'project', label: 'Project', description: 'Scoped to the active project.' },
    { value: 'session-only', label: 'Session only', description: 'Temporary until this session ends.' },
  ]), []);

  // Scroll
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);
  useEffect(() => {
    scrollToBottom('smooth');
  }, [messages.length, actionLog.length, pendingApprovalProjects.length, scrollToBottom]);
  useEffect(() => {
    if (streamingContent) scrollToBottom('auto');
  }, [streamingContent, scrollToBottom]);

  // Load history
  useEffect(() => {
    fetchChatHistory(150, activeProjectId).then((history) => {
      if (!Array.isArray(history)) return;
      setMessages(history);
      const hasConversation = history.some((message) => message && (message.role === 'user' || message.role === 'ceo'));
      if (hasConversation) {
        markPromptExamplesSeen(activeProjectId || '__global__');
      }
    }).catch(() => {});
  }, [activeProjectId, markPromptExamplesSeen]);

  // Load CEO memories
  useEffect(() => {
    fetchMemory().then((m) => setMemoryEntries(m.entries)).catch(() => {});
    fetchMemoryPolicy().then((policy) => {
      if (!policy) return;
      setMemoryScope(policy.scope ?? 'project');
      setMemoryRetentionDays(policy.retention_days ?? 30);
    }).catch(() => {});
  }, []);

  const handleAddMemory = async () => {
    const text = newMemoryText.trim();
    if (!text) return;
    setMemorySaving(true);
    await addMemory(text);
    setNewMemoryText('');
    const m = await fetchMemory();
    setMemoryEntries(m.entries);
    setMemorySaving(false);
  };

  const handleClearMemory = async () => {
    await clearMemory();
    setMemoryEntries([]);
  };

  const persistMemoryPolicy = async (
    scope: 'global' | 'project' | 'session-only',
    retentionDays: number,
  ) => {
    setMemoryScope(scope);
    setMemoryRetentionDays(retentionDays);
    await updateMemoryPolicy({
      scope,
      retention_days: retentionDays,
    });
  };

  const stopTypingAnimation = useCallback(() => {
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  }, []);

  const handleCopyPath = useCallback((path: string) => {
    void navigator.clipboard.writeText(path).then(() => {
      toast('Path copied to clipboard.', 'success');
    }).catch(() => {
      toast('Unable to copy path.', 'warning');
    });
  }, [toast]);

  const handleCopyCommand = useCallback((command: string) => {
    void navigator.clipboard.writeText(command).then(() => {
      toast('Command copied to clipboard.', 'success');
    }).catch(() => {
      toast('Unable to copy command.', 'warning');
    });
  }, [toast]);

  const mirrorTelegram = useCallback(async (speaker: string, content: string, projectId: string) => {
    if (!telegramMirrorEnabledRef.current) return;
    const creds = readTelegramCredentials();
    if (!creds.configured) {
      onTelegramMirrorChange?.(false);
      return;
    }
    const projectName = projectsRef.current.find((project) => project.id === projectId)?.name || 'General';
    const body = `[${projectName}] ${speaker}: ${content}`;
    await sendTelegramMessage({
      token: creds.token,
      chat_id: creds.chatId,
      text: body,
    });
  }, [onTelegramMirrorChange]);

  const safeMirrorTelegram = useCallback(async (speaker: string, content: string, projectId: string) => {
    try {
      await mirrorTelegram(speaker, content, projectId);
    } catch {
      onTelegramMirrorChange?.(false);
      setMessages((prev) => [...prev, {
        role: 'ceo',
        content: '[Warning] Telegram mirror failed. Re-check Telegram token/chat ID in Settings and enable again.',
        timestamp: new Date().toISOString(),
        project_id: projectId || activeProjectIdRef.current,
      }]);
    }
  }, [mirrorTelegram, onTelegramMirrorChange]);

  const pushCeoMessage = useCallback((
    content: string,
    projectId: string,
    structured?: StructuredChatResponse,
    autoLaunch?: AutoLaunchStatus,
    terminalState?: RunDoneTerminalState,
    errorReason?: string,
    guidance?: GuidancePayload,
    completionCelebration?: CompletionCelebrationPayload,
    runReplay?: string,
    qualityReport?: QualityReport,
    deliveryGates?: DeliveryGates,
    refinement?: RefinementPayload,
  ) => {
    setMessages((prev) => [...prev, {
      role: 'ceo',
      content,
      timestamp: new Date().toISOString(),
      project_id: projectId,
      structured,
      auto_launch: autoLaunch,
      terminal_state: terminalState,
      error_reason: errorReason,
      guidance,
      completion_celebration: completionCelebration,
      run_replay: runReplay,
      quality_report: qualityReport,
      delivery_gates: deliveryGates,
      refinement,
    }]);
    void safeMirrorTelegram(ceoNameRef.current, content, projectId);
  }, [safeMirrorTelegram]);

  const handleDeployFromCompletion = useCallback((projectId: string, target: 'preview' | 'production') => {
    const pid = String(projectId || '').trim();
    if (!pid || deployingVercel) return;
    setDeployingVercel(true);
    void deployProjectToVercel(pid, target).then((result) => {
      setDeployingVercel(false);
      if (result.ok && result.deployment_url) {
        pushCeoMessage(
          `${target === 'production' ? 'Production' : 'Preview'} deployment ready: ${result.deployment_url}`,
          pid,
        );
        return;
      }
      const message = result.error?.message || 'Vercel deployment failed.';
      setMessages((prev) => [...prev, {
        role: 'ceo',
        content: `[Error] ${message}`,
        timestamp: new Date().toISOString(),
        project_id: pid,
      }]);
    }).catch(() => {
      setDeployingVercel(false);
      setMessages((prev) => [...prev, {
        role: 'ceo',
        content: '[Error] Deployment failed due to a network error.',
        timestamp: new Date().toISOString(),
        project_id: pid,
      }]);
    });
  }, [deployingVercel, pushCeoMessage]);

  const handleGenerateReleaseNotes = useCallback((projectId: string) => {
    const pid = String(projectId || '').trim();
    if (!pid) return;
    void fetchProjectReleaseNotes(pid).then((payload) => {
      if (!payload || payload.status !== 'ok' || !payload.notes) {
        setMessages((prev) => [...prev, {
          role: 'ceo',
          content: '[Warning] Release notes are not available yet for this project.',
          timestamp: new Date().toISOString(),
          project_id: pid,
        }]);
        return;
      }
      pushCeoMessage(payload.notes, pid);
    }).catch(() => {
      setMessages((prev) => [...prev, {
        role: 'ceo',
        content: '[Error] Unable to generate release notes right now.',
        timestamp: new Date().toISOString(),
        project_id: pid,
      }]);
    });
  }, [pushCeoMessage]);

  const handleStartReviewFromCompletion = useCallback((projectId: string, deploymentUrl?: string) => {
    if (!previewReviewEnabled) return;
    const pid = String(projectId || '').trim();
    if (!pid) return;
    if (pid !== activeProjectId && onActiveProjectChange) {
      onActiveProjectChange(pid);
    }
    setReviewDeploymentUrl(String(deploymentUrl || '').trim());
    setShowPreviewReview(true);
    setShowContextPacks(false);
    setShowMemory(false);
  }, [activeProjectId, onActiveProjectChange, previewReviewEnabled]);

  const handleAddBillingPack = useCallback((projectId: string) => {
    if (!stripeBillingPackEnabled) return;
    const pid = String(projectId || '').trim();
    if (!pid) return;
    pushCeoMessage('Generating Stripe billing pack...', pid);
    void applyStripeBillingPack(pid, { scaffold_files: false, sync_vercel_env: false }).then((result) => {
      if (!result.ok || !result.data) {
        const detail = result.detail || 'Unable to generate billing pack.';
        setMessages((prev) => [...prev, {
          role: 'ceo',
          content: `[Error] ${detail}`,
          timestamp: new Date().toISOString(),
          project_id: pid,
        }]);
        return;
      }
      const artifactPath = String(result.data.artifact_path || '').trim();
      const stack = String(result.data.stack || 'generic').trim();
      pushCeoMessage(
        `Billing pack is ready (${stack}). ${artifactPath ? `Artifact: ${artifactPath}` : ''}`.trim(),
        pid,
      );
      onProjectDataRefresh?.();
    }).catch(() => {
      setMessages((prev) => [...prev, {
        role: 'ceo',
        content: '[Error] Billing pack generation failed due to a network error.',
        timestamp: new Date().toISOString(),
        project_id: pid,
      }]);
    });
  }, [onProjectDataRefresh, pushCeoMessage, stripeBillingPackEnabled]);

  const completeAssistantTurn = useCallback(() => {
    turnErroredRef.current = false;
    setStreamingContent('');
    setThinkingContent('');
    setActionLog([]);
    setDelegationContext(null);
    setIsWaiting(false);
    focusInput();
    if (!chatOpenRef.current) onNewCeoMessageRef.current?.();
  }, [focusInput]);

  const typewriteAndCommit = useCallback((
    content: string,
    projectId: string,
    structured?: StructuredChatResponse,
    autoLaunch?: AutoLaunchStatus,
    terminalState?: RunDoneTerminalState,
    errorReason?: string,
    guidance?: GuidancePayload,
    completionCelebration?: CompletionCelebrationPayload,
    runReplay?: string,
    qualityReport?: QualityReport,
    deliveryGates?: DeliveryGates,
    refinement?: RefinementPayload,
  ) => {
    stopTypingAnimation();
    const tokens = content.split(/(\s+)/).filter((token) => token.length > 0);
    let cursor = 0;
    const pace = tokens.length > 260 ? 0.78 : tokens.length > 140 ? 0.9 : 1;

    const step = () => {
      cursor = Math.min(tokens.length, cursor + 1);
      setStreamingContent(tokens.slice(0, cursor).join(''));
      if (cursor < tokens.length) {
        const prev = (tokens[cursor - 1] || '').trim();
        let delay = Math.max(TYPEWRITER_MIN_DELAY_MS, Math.round(TYPEWRITER_BASE_DELAY_MS * pace));
        if (/[,;:]$/.test(prev)) delay += Math.round(TYPEWRITER_COMMA_DELAY_MS * pace);
        if (/[.!?]$/.test(prev)) delay += Math.round(TYPEWRITER_SENTENCE_DELAY_MS * pace);
        typingTimerRef.current = setTimeout(step, delay);
        return;
      }
      typingTimerRef.current = null;
      pushCeoMessage(
        content,
        projectId,
        structured,
        autoLaunch,
        terminalState,
        errorReason,
        guidance,
        completionCelebration,
        runReplay,
        qualityReport,
        deliveryGates,
        refinement,
      );
      completeAssistantTurn();
    };

    step();
  }, [completeAssistantTurn, pushCeoMessage, stopTypingAnimation]);

  // WebSocket
  const connectWebSocket = useCallback(function connectWebSocketImpl() {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
    setConnectionStatus('connecting');
    try {
      const ws = createChatWebSocket();
      wsRef.current = ws;
      ws.onopen = () => {
        setConnectionStatus('connected');
        if (pendingOutboundRef.current) {
          ws.send(pendingOutboundRef.current);
          pendingOutboundRef.current = null;
        }
      };
      ws.onmessage = (evt) => {
        try {
          const raw: unknown = JSON.parse(evt.data);
          if (!isWsMessage(raw)) return;
          const data: WsMessage = raw;
          switch (data.type) {
            case 'user_ack': break;
            case 'thinking':
              setThinkingContent(wsContentText(data.content, `${ceoNameRef.current} is thinking…`));
              break;
            case 'run':
              {
                const payload = wsContentObject(data.content);
                if (!payload) break;
                const rid = String(payload.id || '');
                if (rid) {
                  setLatestRunId(rid);
                  onRunStartRef.current?.(rid, activeProjectIdRef.current || '');
                }
                onWorkforceRefreshRequestRef.current?.();
                const stage = String(payload.delegation_stage || '');
                const summary = String(payload.delegation_summary || '');
                const reasonsRaw = Array.isArray(payload.delegation_reasons)
                  ? payload.delegation_reasons
                  : [];
                const reasons = reasonsRaw
                  .map((item) => {
                    if (!item || typeof item !== 'object') return null;
                    const row = item as Record<string, unknown>;
                    const agentId = String(row.agent_id || '').trim();
                    const agentName = String(row.agent_name || agentId || '').trim();
                    const reason = String(row.reason || '').trim();
                    if (!agentId || !agentName || !reason) return null;
                    return { agent_id: agentId, agent_name: agentName, reason };
                  })
                  .filter((item): item is DelegationReasonItem => item !== null);
                if (summary || reasons.length > 0) {
                  setDelegationContext({ stage, summary, reasons });
                } else {
                  setDelegationContext(null);
                }
              }
              break;
            case 'run_status':
              {
                const parsed = normalizeRunStatusEvent(data.content);
                if (!parsed) break;
                setLatestRunId(parsed.run_id);
                setLiveRunStatus(parsed);
                onRunStatusRef.current?.(parsed);
              }
              break;
            case 'run_phase':
              {
                const parsed = normalizeRunStatusEvent(data.content);
                if (!parsed) break;
                setLatestRunId(parsed.run_id);
                setLiveRunStatus(parsed);
                onRunStatusRef.current?.(parsed);
              }
              break;
            case 'run_incident':
              {
                const parsed = normalizeRunIncidentEvent(data.content);
                if (!parsed) break;
                setLiveRunIncident(parsed);
                onRunIncidentRef.current?.(parsed);
              }
              break;
            case 'run_control_ack':
              {
                const payload = wsContentObject(data.content);
                if (!payload) break;
                const message = String(payload.message || '').trim();
                if (message) toast(message, payload.acknowledged === false ? 'warning' : 'success');
              }
              break;
            case 'action':
              {
                const rawText = wsContentText(data.content, '');
                const parsed = parseActionText(rawText);
                const normalizedText = parsed.label || rawText || 'Working on task';
                setActionLog((prev) => [...prev, {
                  text: normalizedText,
                  status: 'running',
                  at: new Date().toISOString(),
                }]);
              }
              break;
            case 'action_detail':
              {
                const payload = wsContentObject(data.content);
                if (!payload) break;
                const command = payload.command ? String(payload.command) : undefined;
                const tool = payload.tool ? String(payload.tool) : undefined;
                const filePath = payload.file_path ? String(payload.file_path) : undefined;
                const actor = payload.actor ? String(payload.actor) : (payload.source_agent ? String(payload.source_agent) : undefined);
                const target = payload.target ? String(payload.target) : (payload.target_agent ? String(payload.target_agent) : undefined);
                const summaryLabel = summarizeActionPayload({
                  label: String(payload.label || 'Action detail'),
                  command,
                  tool,
                  actor,
                  target,
                  source_agent: payload.source_agent ? String(payload.source_agent) : undefined,
                  target_agent: payload.target_agent ? String(payload.target_agent) : undefined,
                  flow: payload.flow ? String(payload.flow) : undefined,
                  task: payload.task ? String(payload.task) : undefined,
                });
                setActionDetails((prev) => [...prev, {
                  label: summaryLabel,
                  command,
                  tool,
                  file_path: filePath,
                  actor,
                  target,
                  flow: payload.flow ? String(payload.flow) : undefined,
                  cwd: payload.cwd ? String(payload.cwd) : undefined,
                  duration_ms: typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined,
                  exit_code: typeof payload.exit_code === 'number' ? payload.exit_code : undefined,
                  output_preview: payload.output_preview ? String(payload.output_preview) : undefined,
                  state: payload.state ? String(payload.state) : undefined,
                  run_id: payload.run_id ? String(payload.run_id) : undefined,
                  at: new Date().toISOString(),
                }].slice(-120));
                // Bubble agent activity up for TeamPulse
                const detailFlow = String(payload.flow || '').toLowerCase();
                const detailState = String(payload.state || '').toLowerCase();
                const detailTarget = String(payload.target_agent || payload.target || '').trim().toLowerCase();
                const detailSource = String(payload.source_agent || payload.actor || '').trim().toLowerCase();
                const detailTask = String(payload.task || '').trim();
                if (detailFlow === 'down' && detailTarget && detailTarget !== 'ceo') {
                  onAgentActivityRef.current?.(detailTarget, detailTask, 'down');
                } else if (detailFlow === 'up' && detailSource && detailSource !== 'ceo') {
                  onAgentActivityRef.current?.(detailSource, detailTask, 'up');
                }
                // On completion: transition agent to 'up' flow instead of removing,
                // keeping the org chart node lit for the full expiry window.
                if (detailState === 'completed' || detailState === 'failed') {
                  const finishedAgent = detailSource !== 'ceo' ? detailSource : (detailTarget !== 'ceo' ? detailTarget : '');
                  if (finishedAgent) onAgentActivityRef.current?.(finishedAgent, detailTask || 'Completed', 'up');
                }
                // Only hard-remove on explicit failure flow (timed-out delegations)
                if (detailFlow === 'failed') {
                  const failedAgent = detailSource !== 'ceo' ? detailSource : (detailTarget !== 'ceo' ? detailTarget : '');
                  if (failedAgent) onAgentRemoveRef.current?.(failedAgent);
                }

                if (detailState === 'started') {
                  setActionLog((prev) => {
                    if (prev.length === 0) return prev;
                    const last = prev[prev.length - 1];
                    if (last.status !== 'running') return prev;
                    const nextText = summaryLabel || enrichActionText(last.text, { command, filePath, tool });
                    if (nextText === last.text) return prev;
                    return [...prev.slice(0, -1), { ...last, text: nextText }];
                  });
                }
                onWorkforceRefreshRequestRef.current?.();
              }
              break;
            case 'action_result':
              {
                const resultRaw = wsContentText(data.content, '');
                const parsedResult = parseActionText(resultRaw).label;
                const resultText = parsedResult || (resultRaw ? 'Task completed' : '');
                setActionLog((prev) => prev.length > 0 ? [
                  ...prev.slice(0, -1),
                  {
                    ...prev[prev.length - 1],
                    status: 'done',
                    result: resultText,
                  },
                ] : [{
                  text: 'Task completed',
                  status: 'done',
                  result: resultText,
                  at: new Date().toISOString(),
                }]);
              }
              break;
            case 'chunk': {
              stopTypingAnimation();
              setActionLog((prev) =>
                prev.length > 0
                  ? prev.map((entry) => (entry.status === 'running' ? { ...entry, status: 'done' } : entry))
                  : prev
              );
              const chunk = wsContentText(data.content, '');
              streamingAccumRef.current += chunk;
              // Keep stream chunks buffered and render a clean final typed bubble on "done".
              break;
            }
            case 'project_context': {
              if (data.project_id && data.project_id !== activeProjectIdRef.current) {
                onActiveProjectChangeRef.current?.(data.project_id);
                fetchChatHistory(150, data.project_id).then((history) => {
                  if (Array.isArray(history)) setMessages(history);
                }).catch(() => {});
              }
              break;
            }
            case 'done': {
              const streamedContent = streamingAccumRef.current;
              const finalContent = wsContentText(data.content, '') || streamedContent;
              const structured = normalizeStructuredResponse(data.structured);
              const autoLaunch = data.auto_launch;
              const terminalState: RunDoneTerminalState = data.terminal_state === 'failed'
                || data.terminal_state === 'cancelled'
                ? data.terminal_state
                : 'done';
              const errorReason = String(data.error_reason || '').trim();
              const guidance = normalizeGuidancePayload(data.guidance);
              const completionCelebration = data.completion_celebration;
              const runReplay = String(data.run_replay || '').trim();
              const qualityReport = normalizeQualityReport(data.quality_report);
              const deliveryGates = normalizeDeliveryGates(data.delivery_gates);
              const refinement = normalizeRefinementPayload(data.refinement);
              streamingAccumRef.current = '';
              if (data.run_id) setLatestRunId(data.run_id);
              onRunIncidentRef.current?.(null);
              setLiveRunIncident(null);
              const projectId = data.project_id || activeProjectIdRef.current;
              onProjectDataRefreshRef.current?.();
              const offer = data.deploy_offer;
              if (offer && typeof offer === 'object') {
                const offerProjectId = String(offer.project_id || projectId || '').trim();
                if (offerProjectId) {
                  setDeployOffer({
                    projectId: offerProjectId,
                    projectName: String(offer.project_name || projectsRef.current.find((project) => project.id === offerProjectId)?.name || 'Project'),
                    target: offer.target === 'production' ? 'production' : 'preview',
                  });
                }
              } else {
                setDeployOffer(null);
              }
              triggerCompletionCelebration(completionCelebration);
              if (finalContent.trim()) {
                typewriteAndCommit(
                  finalContent,
                  projectId,
                  structured,
                  autoLaunch,
                  terminalState,
                  errorReason,
                  guidance,
                  completionCelebration,
                  runReplay,
                  qualityReport,
                  deliveryGates,
                  refinement,
                );
                onWorkforceRefreshRequestRef.current?.();
                break;
              }
              if (terminalState !== 'done') {
                const fallbackContent = `[${terminalState === 'cancelled' ? 'Cancelled' : 'Error'}] ${errorReason || 'Run ended before completion.'}`;
                pushCeoMessage(
                  fallbackContent,
                  projectId,
                  structured,
                  autoLaunch,
                  terminalState,
                  errorReason,
                  guidance,
                  completionCelebration,
                  runReplay,
                  qualityReport,
                  deliveryGates,
                  refinement,
                );
              }
              completeAssistantTurn();
              onWorkforceRefreshRequestRef.current?.();
              break;
            }
            case 'error':
              stopTypingAnimation();
              turnErroredRef.current = true;
              streamingAccumRef.current = '';
              onRunIncidentRef.current?.(null);
              setLiveRunIncident(null);
              setMessages((prev) => [...prev, {
                role: 'system',
                content: `Runtime error: ${wsContentText(data.content, 'Unknown error')}`,
                timestamp: new Date().toISOString(),
                project_id: activeProjectIdRef.current,
                guidance: normalizeGuidancePayload(data.guidance),
              }]);
              setStreamingContent('');
              setThinkingContent('');
              setActionLog([]);
              setDelegationContext(null);
              setIsWaiting(false);
              focusInput();
              setDeployOffer(null);
              onWorkforceRefreshRequestRef.current?.();
              break;
            case 'warning':
              setMessages((prev) => [...prev, {
                role: 'system',
                content: `Runtime warning: ${typeof data.content === 'string' ? data.content : 'Warning received.'}`,
                timestamp: new Date().toISOString(),
                project_id: activeProjectIdRef.current,
                guidance: normalizeGuidancePayload(data.guidance),
              }]);
              break;
            case 'micro_project_warning':
              setMessages((prev) => [...prev, {
                role: 'ceo',
                content: `Micro Project warning: ${wsContentText(data.content, 'This request may need full crew mode.')}`,
                timestamp: new Date().toISOString(),
                project_id: activeProjectIdRef.current,
              }]);
              break;
            case 'planning_approval_required':
              {
                const payload = wsContentObject(data.content);
                if (!payload) break;
                const reason = String(payload.reason || 'Planning approval required.');
                const packet = payload.plan_packet && typeof payload.plan_packet === 'object'
                  ? payload.plan_packet as { missing_items?: unknown }
                  : null;
                const missingItems = Array.isArray(packet?.missing_items)
                  ? packet?.missing_items?.map((item) => String(item))
                  : [];
                setPlanningPendingDecision({
                  message: lastOutboundMessageRef.current || '',
                  reason,
                  missingItems,
                });
              }
              setIsWaiting(false);
              focusInput();
              setThinkingContent('');
              setDelegationContext(null);
              break;
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        stopTypingAnimation();
        setConnectionStatus('disconnected');
        if (!turnErroredRef.current && isWaitingRef.current) {
          setMessages((prev) => [...prev, {
            role: 'system',
            content: 'Connection lost while waiting for CEO response. Reconnecting automatically…',
            timestamp: new Date().toISOString(),
            project_id: activeProjectIdRef.current,
          }]);
        }
        setStreamingContent('');
        setThinkingContent('');
        setActionLog([]);
        setIsWaiting(false);
        focusInput();
        wsRef.current = null;
        if (shouldReconnectRef.current) {
          reconnectTimerRef.current = setTimeout(connectWebSocketImpl, 3000);
        }
      };
      ws.onerror = () => {
        setConnectionStatus('error');
        if (!turnErroredRef.current && isWaitingRef.current) {
          setMessages((prev) => [...prev, {
            role: 'system',
            content: 'Chat connection error. Please retry once connection is restored.',
            timestamp: new Date().toISOString(),
            project_id: activeProjectIdRef.current,
          }]);
          setIsWaiting(false);
          focusInput();
        }
      };
    } catch { setConnectionStatus('error'); }
  }, [completeAssistantTurn, focusInput, pushCeoMessage, stopTypingAnimation, triggerCompletionCelebration, typewriteAndCommit]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connectWebSocket();
    return () => {
      shouldReconnectRef.current = false;
      stopTypingAnimation();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
      pendingOutboundRef.current = null;
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        wsRef.current.close();
      }
      wsRef.current = null;
    };
  }, [connectWebSocket, stopTypingAnimation]);

  const setMicroMode = useCallback((enabled: boolean) => {
    onMicroProjectModeChange?.(enabled);
    setShowMicroApprovalCard(false);
    if (!enabled) {
      setMicroPendingDecision(null);
    }
  }, [onMicroProjectModeChange]);

  const tryEnableMicroMode = useCallback(() => {
    setShowMicroApprovalCard(true);
  }, []);

  useEffect(() => {
    if (microToggleRequestToken <= 0) return;
    if (microToggleRequestToken === lastHandledMicroToggleRequestRef.current) return;
    lastHandledMicroToggleRequestRef.current = microToggleRequestToken;
    if (microProjectMode) {
      setMicroMode(false);
    } else {
      tryEnableMicroMode();
    }
  }, [microProjectMode, microToggleRequestToken, setMicroMode, tryEnableMicroMode]);

  // Send message
  const sendMessage = useCallback((opts?: {
    textOverride?: string;
    forceMicroMode?: boolean;
    forceMicroOverride?: boolean;
    planningApproved?: boolean;
  }) => {
    const text = (opts?.textOverride ?? input).trim();
    if (!text || isWaiting) return;
    if (!activeProjectId && looksExecutionRequest(text)) {
      setMessages((prev) => [...prev, {
        role: 'ceo',
        content: 'This looks like an execution request. Select or create a project from the top header first (choose Local or GitHub).',
        timestamp: new Date().toISOString(),
        project_id: '',
      }]);
      return;
    }
    const ws = wsRef.current;
    stopTypingAnimation();

    const effectiveMicroMode = opts?.forceMicroMode ?? microProjectMode;
    const microOverride = opts?.forceMicroOverride ?? false;
    if (effectiveMicroMode && !microOverride) {
      const reason = microComplexityReason(text);
      if (reason) {
        setMicroPendingDecision({ message: text, reason });
        return;
      }
    }

    setMessages((prev) => [...prev, {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      project_id: activeProjectId,
    }]);
    markPromptExamplesSeen(activePromptProjectKey);
    void safeMirrorTelegram(userName, text, activeProjectId || '');
    setInput('');
    focusInput();
    setIsWaiting(true);
    setStreamingContent('');
    setThinkingContent('');
    setActionLog([]);
    setActionDetails([]);
    setDelegationContext(null);
    streamingAccumRef.current = '';
    turnErroredRef.current = false;
    setMicroPendingDecision(null);
    setPlanningPendingDecision(null);
    setDeployOffer(null);
    lastOutboundMessageRef.current = text;
    const idempotencyKey = `chat-${activeProjectId || 'global'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({
      message: text,
      micro_project_mode: effectiveMicroMode,
      micro_project_override: microOverride,
      planning_approved: Boolean(opts?.planningApproved),
      structured_response: true,
      sandbox_profile: effectiveMicroMode ? 'safe' : 'standard',
      idempotency_key: idempotencyKey,
      project_id: activeProjectId,
    });
    if (inputRef.current) inputRef.current.style.height = '44px';
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pendingOutboundRef.current = payload;
      connectWebSocket();
      return;
    }
    ws.send(payload);
  }, [activeProjectId, activePromptProjectKey, connectWebSocket, focusInput, input, isWaiting, markPromptExamplesSeen, microProjectMode, safeMirrorTelegram, stopTypingAnimation, userName]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const handleGuidanceAction = useCallback((action: GuidanceAction, message: ChatMessage) => {
    const kind = String(action.kind || '').trim().toLowerCase();
    const payload = action.payload && typeof action.payload === 'object'
      ? action.payload as Record<string, unknown>
      : {};
    if (kind === 'retry') {
      const retryText = String(lastOutboundMessageRef.current || '').trim();
      if (!retryText) {
        toast('No previous user request available to retry.', 'warning');
        return;
      }
      sendMessage({ textOverride: retryText });
      return;
    }
    if (kind === 'run_control') {
      const requested = String(payload.action || action.target || '').trim().toLowerCase();
      const control = requested === 'retry_step'
        || requested === 'cancel'
        || requested === 'continue'
        ? requested
        : 'status';
      onRunControl?.(control);
      return;
    }
    if (kind === 'open_settings') {
      const connector = String(payload.connector || '').trim().toLowerCase();
      if (connector === 'github' || connector === 'vercel' || connector === 'stripe') {
        onOpenSettings?.(connector);
      } else {
        onOpenSettings?.();
      }
      return;
    }
    if (kind === 'open_project') {
      const projectId = String(payload.project_id || action.target || message.project_id || '').trim();
      if (!projectId) {
        toast('Project id is missing for this action.', 'warning');
        return;
      }
      onNavigateToProject?.(projectId);
      return;
    }
    if (kind === 'view_events') {
      onOpenEventLog?.();
      return;
    }
    if (kind === 'copy') {
      const text = String(payload.text || action.target || '').trim();
      if (!text) {
        toast('Nothing to copy for this action.', 'warning');
        return;
      }
      void navigator.clipboard.writeText(text).then(() => {
        toast('Diagnostics copied to clipboard.', 'success');
      }).catch(() => {
        toast('Unable to copy diagnostics.', 'warning');
      });
      return;
    }
    if (kind === 'link') {
      const target = String(action.target || payload.url || '').trim();
      if (!target) {
        toast('No link target available.', 'warning');
        return;
      }
      window.open(target, '_blank', 'noopener,noreferrer');
      return;
    }
    toast(`Unsupported action: ${action.label}`, 'warning');
  }, [onNavigateToProject, onOpenEventLog, onOpenSettings, onRunControl, sendMessage, toast]);

  const handleClear = useCallback(async () => {
    stopTypingAnimation();
    await clearChatHistory(activeProjectId);
    setMessages([]); setStreamingContent(''); setThinkingContent('');
    setDelegationContext(null);
    streamingAccumRef.current = '';
    setPinnedIds(new Set()); localStorage.removeItem('tf_pinned_msgs');
  }, [activeProjectId, stopTypingAnimation]);

  // Close menus on outside click
  useEffect(() => {
    const close = () => {
      setShowMemory(false);
      setShowToolsMenu(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const visibleApprovals = pendingApprovalProjects.filter((p) => !dismissedProjectIds.has(p.id));
  const hasMessages = messages.length > 0 || streamingContent;
  const activeProject = projects.find((p) => p.id === activeProjectId) || null;
  const hasConversationHistory = useMemo(
    () => messages.some((message) => message.role === 'user' || message.role === 'ceo'),
    [messages],
  );
  const promptSeenForActiveProject = Boolean(promptExamplesSeenByProject[activePromptProjectKey]);
  const promptHiddenForActiveProject = Boolean(promptExamplesHiddenByProject[activePromptProjectKey]);
  const filteredPromptExamples = useMemo(() => {
    if (promptExampleCategory === PROMPT_CATEGORY_ALL) return PROMPT_EXAMPLES;
    return PROMPT_EXAMPLES.filter((example) => example.category === promptExampleCategory);
  }, [promptExampleCategory]);
  const recentPromptExamples = useMemo(() => {
    return promptRecentExampleIds
      .map((exampleId) => PROMPT_EXAMPLES.find((example) => example.id === exampleId) || null)
      .filter((example): example is typeof PROMPT_EXAMPLES[number] => Boolean(example))
      .slice(0, PROMPT_EXAMPLES_RECENT_LIMIT);
  }, [promptRecentExampleIds]);
  const shouldShowPromptStarter = Boolean(
    activeProjectId
    && !isWaiting
    && !streamingContent
    && !hasConversationHistory
    && !promptSeenForActiveProject
    && !promptHiddenForActiveProject,
  );
  const shouldRenderPromptStarter = Boolean(shouldShowPromptStarter || showPromptExamplesPanel);
  const applyPromptTemplate = useCallback((prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => {
      const inputEl = inputRef.current;
      if (inputEl) {
        inputEl.style.height = 'auto';
        inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
      }
      focusInput();
    });
  }, [focusInput]);
  const applyPromptExample = useCallback((exampleId: string) => {
    const nextId = String(exampleId || '').trim();
    if (!nextId) return;
    const example = PROMPT_EXAMPLES.find((entry) => entry.id === nextId);
    if (!example) return;
    applyPromptTemplate(example.prompt);
    setPromptRecentExampleIds((prev) => [nextId, ...prev.filter((id) => id !== nextId)].slice(0, PROMPT_EXAMPLES_RECENT_LIMIT));
    setPromptExamplesHiddenByProject((prev) => ({ ...prev, [activePromptProjectKey]: true }));
    setShowPromptExamplesPanel(false);
  }, [activePromptProjectKey, applyPromptTemplate]);
  const handlePromptCategoryChange = useCallback((nextCategory: string) => {
    const normalized = String(nextCategory || '').trim();
    const valid = normalized === PROMPT_CATEGORY_ALL
      || PROMPT_EXAMPLE_CATEGORIES.includes(normalized as typeof PROMPT_EXAMPLE_CATEGORIES[number]);
    setPromptExampleCategory(valid ? normalized : PROMPT_CATEGORY_ALL);
  }, []);
  const handleOpenPromptExamplesPanel = useCallback(() => {
    setPromptExamplesHiddenByProject((prev) => ({ ...prev, [activePromptProjectKey]: false }));
    setShowPromptExamplesPanel(true);
    setShowToolsMenu(false);
  }, [activePromptProjectKey]);
  const handleClosePromptExamplesPanel = useCallback(() => {
    setPromptExamplesHiddenByProject((prev) => ({ ...prev, [activePromptProjectKey]: true }));
    setShowPromptExamplesPanel(false);
  }, [activePromptProjectKey]);
  const showConversationPanel = Boolean(
    hasMessages
    || isWaiting
    || microProjectMode
    || telegramMirrorEnabled
    || showMicroApprovalCard
    || microPendingDecision
    || planningPendingDecision
    || deployOffer
    || (contextPacksEnabled && showContextPacks)
    || (previewReviewEnabled && showPreviewReview)
  );

  // ---- Shared header controls ----
  const secondaryControls = (
    <div className="chat-toolbar flex items-center gap-2" style={{ position: 'relative' }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowToolsMenu((v) => !v);
        }}
        title="Chat tools"
        style={{
          padding: '5px 10px',
          borderRadius: '6px',
          fontSize: '12px',
          cursor: 'pointer',
          border: `1px solid ${showToolsMenu ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
          backgroundColor: showToolsMenu ? 'color-mix(in srgb, var(--tf-accent-blue) 14%, transparent)' : 'transparent',
          color: showToolsMenu ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)',
          whiteSpace: 'nowrap',
        }}
      >
        Tools ▾
      </button>

      {showToolsMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 52,
            width: '220px',
            backgroundColor: 'var(--tf-surface)',
            border: '1px solid var(--tf-border)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            overflow: 'hidden',
          }}
        >
          <button
            onClick={() => {
              setShowActionDetails((v) => !v);
              setShowToolsMenu(false);
            }}
            style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showActionDetails ? 'var(--tf-success)' : 'var(--tf-text-secondary)' }}
          >
            {showActionDetails ? 'Hide Technical Details' : 'Show Technical Details'}
          </button>
          <button
            onClick={() => {
              setShowSearch((v) => {
                if (v) setSearchQuery('');
                return !v;
              });
              setShowToolsMenu(false);
            }}
            style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showSearch ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)' }}
          >
            {showSearch ? 'Hide Search' : 'Search Conversation'}
          </button>
          <button
            onClick={() => {
              setShowMemory((v) => !v);
              setShowContextPacks(false);
              setShowPreviewReview(false);
              setShowToolsMenu(false);
            }}
            style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showMemory ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)' }}
          >
            Memory{memoryEntries.length > 0 ? ` (${memoryEntries.length})` : ''}
          </button>
          {activeProjectId && contextPacksEnabled && (
            <button
              onClick={() => {
                setShowContextPacks((v) => !v);
                setShowMemory(false);
                setShowPreviewReview(false);
                setShowToolsMenu(false);
              }}
              style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showContextPacks ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)' }}
            >
              {showContextPacks ? 'Hide Context Packs' : 'Context Packs'}
            </button>
          )}
          {activeProjectId && previewReviewEnabled && (
            <button
              onClick={() => {
                setShowPreviewReview((v) => !v);
                setShowMemory(false);
                setShowContextPacks(false);
                setShowToolsMenu(false);
              }}
              style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showPreviewReview ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)' }}
            >
              {showPreviewReview ? 'Hide Preview Reviews' : 'Preview Reviews'}
            </button>
          )}
          {activeProjectId && (
            <button
              onClick={() => {
                if (showPromptExamplesPanel) {
                  handleClosePromptExamplesPanel();
                  setShowToolsMenu(false);
                  return;
                }
                handleOpenPromptExamplesPanel();
              }}
              style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showPromptExamplesPanel ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)' }}
            >
              {showPromptExamplesPanel ? 'Hide Example Prompts' : 'Show Example Prompts'}
            </button>
          )}
          {pinnedIds.size > 0 && (
            <button
              onClick={() => {
                setShowPinned((v) => !v);
                setShowToolsMenu(false);
              }}
              style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showPinned ? 'var(--tf-warning)' : 'var(--tf-text-secondary)' }}
            >
              {showPinned ? 'Hide Pinned Messages' : `Show Pinned (${pinnedIds.size})`}
            </button>
          )}
          {messages.length > 0 && (
            <button
              onClick={() => {
                void handleClear();
                setShowToolsMenu(false);
              }}
              style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: 'var(--tf-text-secondary)' }}
            >
              Clear Conversation
            </button>
          )}
        </div>
      )}

      {showMemory && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            backgroundColor: 'var(--tf-surface)',
            border: '1px solid var(--tf-border)',
            borderRadius: '8px',
            padding: '12px',
            minWidth: '260px',
            maxWidth: '320px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--tf-text)' }}>CEO Memory</p>
            {memoryEntries.length > 0 && (
              <button onClick={handleClearMemory} style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', border: '1px solid var(--tf-error)', backgroundColor: 'transparent', color: 'var(--tf-error)' }}>
                Clear all
              </button>
            )}
          </div>
          {memoryEntries.length === 0 ? (
            <p style={{ fontSize: '12px', color: 'var(--tf-text-muted)', marginBottom: '8px' }}>No memories saved yet. Add a note the CEO should always remember.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px', maxHeight: '140px', overflowY: 'auto' }}>
              {memoryEntries.map((entry, i) => (
                <li key={i} style={{ fontSize: '12px', color: 'var(--tf-text-secondary)', padding: '3px 0', borderBottom: '1px solid var(--tf-border)', lineHeight: 1.4 }}>
                  · {entry}
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: 'grid', gap: '6px', marginBottom: '8px', padding: '8px', borderRadius: '6px', border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <label style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>Memory scope</label>
              <FloatingSelect
                value={memoryScope}
                options={memoryScopeOptions}
                onChange={(nextValue) => {
                  const scope = nextValue as 'global' | 'project' | 'session-only';
                  persistMemoryPolicy(scope, memoryRetentionDays);
                }}
                ariaLabel="Memory scope"
                size="sm"
                variant="input"
                style={{ width: '146px' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <label style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>Retention (days)</label>
              <input
                type="number"
                min={1}
                max={365}
                value={memoryRetentionDays}
                onChange={(e) => {
                  const days = Math.max(1, Math.min(365, Number(e.target.value) || 30));
                  persistMemoryPolicy(memoryScope, days);
                }}
                style={{ width: '72px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)', color: 'var(--tf-text)', padding: '2px 6px' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              value={newMemoryText}
              onChange={(e) => setNewMemoryText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAddMemory(); }}
              placeholder="Add a memory..."
              style={{ flex: 1, fontSize: '11px', padding: '4px 8px', borderRadius: '5px', border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-text)', outline: 'none' }}
            />
            <button onClick={() => { void handleAddMemory(); }} disabled={memorySaving || !newMemoryText.trim()} style={{ padding: '4px 8px', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', border: 'none', backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)' }}>
              {memorySaving ? '...' : '+'}
            </button>
          </div>
        </div>
      )}

      {contextPacksEnabled && showContextPacks && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
          }}
        >
          <ContextPackPanel activeProjectId={activeProjectId} defaultScope={activeProjectId ? 'project' : 'global'} />
        </div>
      )}

      {previewReviewEnabled && showPreviewReview && activeProjectId && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
          }}
        >
          <div style={{ width: '320px', maxWidth: '80vw' }}>
            <PreviewReviewPanel projectId={activeProjectId} initialDeploymentUrl={reviewDeploymentUrl} />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col" style={{ height: '100%', minHeight: floating ? undefined : '600px', position: 'relative' }}>
      {/* Pinned messages overlay */}
      {showPinned && (
        <PinnedPanel messages={pinnedMessages} ceoName={ceoName} userName={userName}
          onClose={() => setShowPinned(false)} onUnpin={handlePin} />
      )}
      {celebrationBurstId && <CompletionCelebrationBurst burstId={celebrationBurstId} />}

      {/* Non-floating header */}
      {!floating && (
        <div className="flex items-start justify-between pb-3 flex-shrink-0 flex-wrap gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold" style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }}>
              {ceoName.charAt(0).toUpperCase()}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>{ceoName} — CEO Chat</h3>
              <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>AI Virtual Company Orchestrator</p>
              <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                Project: {activeProject ? activeProject.name : 'No project selected'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <StatusBadge status={connectionStatus} />
            {microProjectMode && (
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ color: 'var(--tf-warning)', border: '1px solid rgba(240,170,74,0.45)', backgroundColor: 'rgba(240,170,74,0.14)' }}
              >
                CEO Solo Mode
              </span>
            )}
            {secondaryControls}
          </div>
        </div>
      )}

      {/* Floating header */}
      {floating && (
        <div className="flex items-start justify-between px-3 py-2 flex-shrink-0 gap-2" style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}>
          <div className="flex items-start gap-2 flex-wrap">
            <StatusBadge status={connectionStatus} />
            {microProjectMode && (
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ color: 'var(--tf-warning)', border: '1px solid rgba(240,170,74,0.45)', backgroundColor: 'rgba(240,170,74,0.14)' }}
              >
                CEO Solo Mode
              </span>
            )}
            <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              Project: {activeProject ? activeProject.name : 'No project selected'}
            </span>
          </div>
          {secondaryControls}
        </div>
      )}

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0" style={{ backgroundColor: 'var(--tf-surface)', borderBottom: '1px solid var(--tf-border)' }}>
          <span style={{ fontSize: '13px', color: 'var(--tf-text-muted)' }}>⌕</span>
          <input ref={searchRef} type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: '12px', color: 'var(--tf-text)' }} />
          {searchQuery && <span className="text-xs flex-shrink-0" style={{ color: 'var(--tf-text-muted)' }}>{filteredMessages.length} result{filteredMessages.length !== 1 ? 's' : ''}</span>}
          {searchQuery && <button onClick={() => setSearchQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tf-text-muted)', fontSize: '12px' }}>✕</button>}
        </div>
      )}

      {/* Messages */}
      <div
        className={`flex-1 overflow-y-auto ${floating ? 'px-3 py-3' : 'rounded-xl px-4 py-4'}`}
        style={floating ? { backgroundColor: 'var(--tf-bg)' } : { backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
      >
        {!showConversationPanel ? (
          <div className="chat-empty-shell">
            <EmptyState ceoName={ceoName} requireProject={!activeProjectId} />
            {shouldRenderPromptStarter && (
              <PromptExamplesStarter
                category={promptExampleCategory}
                onCategoryChange={handlePromptCategoryChange}
                examples={filteredPromptExamples}
                recentExamples={recentPromptExamples}
                onSelectExample={applyPromptExample}
                onClose={handleClosePromptExamplesPanel}
                showClose
              />
            )}
          </div>
        ) : (
          <>
            {shouldRenderPromptStarter && (
              <PromptExamplesStarter
                category={promptExampleCategory}
                onCategoryChange={handlePromptCategoryChange}
                examples={filteredPromptExamples}
                recentExamples={recentPromptExamples}
                onSelectExample={applyPromptExample}
                onClose={handleClosePromptExamplesPanel}
                showClose
              />
            )}
            {searchQuery && (
              <div className="text-xs text-center py-1 mb-2" style={{ color: 'var(--tf-text-muted)', backgroundColor: 'color-mix(in srgb, var(--tf-accent-blue) 9%, transparent)', borderRadius: '6px' }}>
                {filteredMessages.length} of {messages.length} messages match "{searchQuery}"
              </div>
            )}

            <div
              className="mb-3 rounded-xl px-3 py-2 animate-slide-up"
              style={{
                backgroundColor: 'var(--tf-surface)',
                border: '1px solid var(--tf-border)',
              }}
            >
              <p className="text-xs font-semibold" style={{ color: 'var(--tf-text-secondary)' }}>
                Active context: {activeProject ? activeProject.name : 'No project selected'}
              </p>
              {activeProject?.workspace_path && (
                <div className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                  <span>Workspace: </span>
                  <button
                    type="button"
                    onClick={() => {
                      handleCopyPath(activeProject.workspace_path || '');
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      margin: 0,
                      color: 'var(--tf-accent)',
                      cursor: 'copy',
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                      font: 'inherit',
                    }}
                    title={`Copy path: ${activeProject.workspace_path}`}
                  >
                    {activeProject.workspace_path}
                  </button>
                </div>
              )}
              {!activeProject && (
                <p className="text-xs mt-1" style={{ color: 'var(--tf-warning)' }}>
                  Select or create a project from the top header before sending a CEO message.
                </p>
              )}
            </div>

            {microProjectMode && (
              <div
                className="mb-3 rounded-xl px-3 py-2 animate-slide-up"
                style={{
                  backgroundColor: 'rgba(240,170,74,0.1)',
                  border: '1px solid rgba(240,170,74,0.35)',
                }}
              >
                <p className="text-xs font-semibold" style={{ color: 'var(--tf-warning)' }}>
                  Micro Project mode is ON
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)' }}>
                  {ceoName} will work solo for speed. Output may be rougher than full-crew execution.
                </p>
              </div>
            )}

            {telegramMirrorEnabled && (
              <div
                className="mb-3 rounded-xl px-3 py-2 animate-slide-up"
                style={{
                  backgroundColor: 'color-mix(in srgb, var(--tf-accent-blue) 14%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--tf-accent-blue) 38%, transparent)',
                }}
              >
                <p className="text-xs font-semibold" style={{ color: 'var(--tf-accent-blue)' }}>
                  Telegram mirror is ON
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)' }}>
                  New user/CEO messages from this chat are mirrored to your configured Telegram bot conversation.
                </p>
              </div>
            )}

            {showMicroApprovalCard && (
              <div
                className="mb-3 rounded-xl px-4 py-3 animate-pop-in"
                style={{
                  backgroundColor: 'var(--tf-surface)',
                  border: '1px solid var(--tf-warning)',
                }}
              >
                <p className="text-xs font-semibold" style={{ color: 'var(--tf-warning)' }}>
                  Enable Micro Project mode?
                </p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.5 }}>
                  This mode skips delegation and deep planning. It is optimized for very small coding tasks and may produce lower-quality results.
                </p>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => {
                      setMicroMode(true);
                      setShowMicroApprovalCard(false);
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium"
                    style={{ backgroundColor: 'var(--tf-warning)', color: 'var(--tf-bg)', border: 'none', cursor: 'pointer' }}
                  >
                    I Understand, Enable
                  </button>
                  <button
                    onClick={() => setShowMicroApprovalCard(false)}
                    className="text-xs px-3 py-1.5 rounded-lg"
                    style={{ backgroundColor: 'transparent', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {microPendingDecision && (
              <div
                className="mb-3 rounded-xl px-4 py-3 animate-pop-in"
                style={{
                  backgroundColor: 'var(--tf-surface)',
                  border: '1px solid var(--tf-accent-blue)',
                }}
              >
                <p className="text-xs font-semibold" style={{ color: 'var(--tf-accent-blue)' }}>
                  This request may need the full crew
                </p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.5 }}>
                  {microPendingDecision.reason}
                </p>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    onClick={() => {
                      const queued = microPendingDecision.message;
                      setMicroMode(false);
                      setMicroPendingDecision(null);
                      sendMessage({ textOverride: queued, forceMicroMode: false });
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium"
                    style={{ backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)', border: 'none', cursor: 'pointer' }}
                  >
                    Turn Off Micro + Run Full Crew
                  </button>
                  <button
                    onClick={() => {
                      const queued = microPendingDecision.message;
                      sendMessage({
                        textOverride: queued,
                        forceMicroMode: true,
                        forceMicroOverride: true,
                      });
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg"
                    style={{ backgroundColor: 'transparent', color: 'var(--tf-warning)', border: '1px solid var(--tf-warning)', cursor: 'pointer' }}
                  >
                    Continue in Micro Mode
                  </button>
                  <button
                    onClick={() => setMicroPendingDecision(null)}
                    className="text-xs px-3 py-1.5 rounded-lg"
                    style={{ backgroundColor: 'transparent', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {planningPendingDecision && (
              <div
                className="mb-3 rounded-xl px-4 py-3 animate-pop-in"
                style={{
                  backgroundColor: 'var(--tf-surface)',
                  border: '1px solid var(--tf-accent-blue)',
                }}
              >
                <p className="text-xs font-semibold" style={{ color: 'var(--tf-accent-blue)' }}>
                  Planning approval required
                </p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.5 }}>
                  {planningPendingDecision.reason}
                </p>
                {planningPendingDecision.missingItems && planningPendingDecision.missingItems.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {planningPendingDecision.missingItems.map((item, idx) => (
                      <li key={`${item}-${idx}`} className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                        • {item}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    onClick={() => {
                      const queued = planningPendingDecision.message;
                      sendMessage({ textOverride: queued, planningApproved: true });
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium"
                    style={{ backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)', border: 'none', cursor: 'pointer' }}
                  >
                    Approve Plan + Continue
                  </button>
                  <button
                    onClick={() => setPlanningPendingDecision(null)}
                    className="text-xs px-3 py-1.5 rounded-lg"
                    style={{ backgroundColor: 'transparent', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {deployOffer && (
              <div
                className="mb-3 rounded-xl px-4 py-3 animate-pop-in"
                style={{
                  backgroundColor: 'var(--tf-surface)',
                  border: '1px solid var(--tf-accent-blue)',
                }}
              >
                <p className="text-xs font-semibold" style={{ color: 'var(--tf-accent-blue)' }}>
                  Deploy to Vercel?
                </p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.5 }}>
                  {deployOffer.projectName} looks ready. Deploy a {deployOffer.target} build to Vercel now?
                </p>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    onClick={() => {
                      const activeOffer = deployOffer;
                      if (!activeOffer) return;
                      setDeployingVercel(true);
                      void deployProjectToVercel(activeOffer.projectId, activeOffer.target).then((result) => {
                        setDeployingVercel(false);
                        if (result.ok && result.deployment_url) {
                          pushCeoMessage(
                            `Deployment complete. ${activeOffer.target === 'production' ? 'Production' : 'Preview'} URL: ${result.deployment_url}`,
                            activeOffer.projectId,
                          );
                          setDeployOffer(null);
                          return;
                        }
                        const message = result.error?.message || 'Vercel deployment failed.';
                        setMessages((prev) => [...prev, {
                          role: 'ceo',
                          content: `[Error] ${message}`,
                          timestamp: new Date().toISOString(),
                          project_id: activeOffer.projectId,
                        }]);
                        if (result.error?.settings_target === 'vercel') {
                          setMessages((prev) => [...prev, {
                            role: 'ceo',
                            content: 'Open Settings → Integrations and verify the Vercel connector, then retry deployment.',
                            timestamp: new Date().toISOString(),
                            project_id: activeOffer.projectId,
                          }]);
                        }
                      }).catch(() => {
                        setDeployingVercel(false);
                        setMessages((prev) => [...prev, {
                          role: 'ceo',
                          content: '[Error] Vercel deployment failed due to a network error.',
                          timestamp: new Date().toISOString(),
                          project_id: activeOffer.projectId,
                        }]);
                      });
                    }}
                    disabled={deployingVercel}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium"
                    style={{ backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)', border: 'none', cursor: deployingVercel ? 'wait' : 'pointer' }}
                  >
                    {deployingVercel ? 'Deploying…' : 'Yes, Deploy'}
                  </button>
                  <button
                    onClick={() => setDeployOffer(null)}
                    disabled={deployingVercel}
                    className="text-xs px-3 py-1.5 rounded-lg"
                    style={{ backgroundColor: 'transparent', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)', cursor: deployingVercel ? 'default' : 'pointer' }}
                  >
                    No, Keep Local
                  </button>
                </div>
              </div>
            )}

            {filteredMessages.map((msg, i) => {
              const key = msgKey(msg);
              return (
                <MessageBubble key={`${key}-${i}`} message={msg} ceoName={ceoName} userName={userName}
                  pinned={pinnedIds.has(key)}
                  onPin={() => handlePin(key)}
                  searchQuery={searchQuery}
                  onCopyPath={handleCopyPath}
                  onCopyCommand={handleCopyCommand}
                  onDeployPreview={(projectId) => handleDeployFromCompletion(projectId, 'preview')}
                  onPromoteProduction={(projectId) => handleDeployFromCompletion(projectId, 'production')}
                  onGenerateReleaseNotes={handleGenerateReleaseNotes}
                  onStartReview={handleStartReviewFromCompletion}
                  onAddBillingPack={handleAddBillingPack}
                  onGuidanceAction={handleGuidanceAction}
                  reviewActionsEnabled={previewReviewEnabled}
                  billingActionsEnabled={stripeBillingPackEnabled}
                />
              );
            })}

            {/* Live CEO response */}
            {isWaiting && (
              <div
                className="mb-3 rounded-xl px-3 py-2 animate-slide-up"
                style={{
                  backgroundColor: 'var(--tf-surface)',
                  border: '1px solid var(--tf-border)',
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full animate-pulse-dot"
                    style={{ backgroundColor: 'var(--tf-accent)' }}
                  />
                  <p className="text-xs font-semibold" style={{ color: 'var(--tf-text-secondary)' }}>
                    Run in progress • {formatElapsedCompact(waitElapsedSec)}
                  </p>
                </div>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                  {ceoName} is still working. This card stays active until completion.
                </p>
                {liveRunStatus && (
                  <div className="mt-2 rounded-lg px-2.5 py-2" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-semibold" style={{ color: 'var(--tf-text-secondary)' }}>
                        Phase: {liveRunStatus.phase_label || 'Execution in progress'}
                      </span>
                      <span className="text-[11px]" style={{ color: 'var(--tf-text-muted)' }}>
                        Last update: {liveRunStatus.last_activity_at ? formatTime(liveRunStatus.last_activity_at) : 'just now'}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[11px]" style={{ color: 'var(--tf-text-muted)' }}>
                      Heartbeat #{Math.max(0, Number(liveRunStatus.heartbeat_seq || 0))}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Array.isArray(liveRunStatus.active_agents) && liveRunStatus.active_agents.length > 0 ? (
                        liveRunStatus.active_agents.slice(0, 4).map((agent) => (
                          <span
                            key={`${agent.agent_id}-${agent.state}`}
                            className="px-2 py-1 rounded-full text-[11px]"
                            style={{ border: '1px solid var(--tf-border)', color: 'var(--tf-text-secondary)', backgroundColor: 'var(--tf-surface)' }}
                          >
                            {agent.agent_name} · {agent.state}
                          </span>
                        ))
                      ) : (
                        <span className="text-[11px]" style={{ color: 'var(--tf-text-muted)' }}>
                          No active agent details yet.
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {liveRunIncident && (
                  <div
                    className="mt-2 rounded-lg px-2.5 py-2"
                    style={{
                      border: `1px solid ${liveRunIncident.severity === 'critical' ? 'var(--tf-error)' : 'var(--tf-warning)'}`,
                      backgroundColor: 'var(--tf-bg)',
                    }}
                  >
                    <p className="text-xs font-semibold" style={{ color: liveRunIncident.severity === 'critical' ? 'var(--tf-error)' : 'var(--tf-warning)' }}>
                      Watchdog {liveRunIncident.severity === 'critical' ? 'critical' : 'warning'}
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)' }}>
                      {liveRunIncident.reason.replace(/_/g, ' ')} • inactive {Math.max(0, Math.floor(liveRunIncident.inactive_seconds || 0))}s
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(['status', 'retry_step', 'continue', 'cancel'] as const).map((action) => (
                        <button
                          key={action}
                          type="button"
                          onClick={() => handleInlineRunControl(action)}
                          disabled={!onRunControl || Boolean(runControlBusyAction)}
                          className="text-[11px] px-2 py-1 rounded-lg"
                          style={{
                            border: '1px solid var(--tf-border)',
                            backgroundColor: action === 'status' ? 'color-mix(in srgb, var(--tf-accent-blue) 14%, transparent)' : 'transparent',
                            color: action === 'status' ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)',
                            cursor: !onRunControl || Boolean(runControlBusyAction) ? 'default' : 'pointer',
                            opacity: !onRunControl || Boolean(runControlBusyAction) ? 0.75 : 1,
                          }}
                        >
                          {runControlBusyAction === action
                            ? '...'
                            : action === 'retry_step'
                              ? 'Retry Step'
                              : action === 'continue'
                                ? 'Continue'
                                : action === 'cancel'
                                  ? 'Cancel Run'
                                  : 'Get Status'}
                        </button>
                      ))}
                    </div>
                    {runControlMessage && (
                      <p className="text-[11px] mt-2" style={{ color: 'var(--tf-text-muted)' }}>
                        {runControlMessage}
                      </p>
                    )}
                  </div>
                )}
                {waitElapsedSec >= 180 && (
                  <p className="text-xs mt-1" style={{ color: 'var(--tf-warning)' }}>
                    Long run detected. Automatic watchdog updates are active while execution continues.
                  </p>
                )}
              </div>
            )}
            {isWaiting && showThinking && thinkingContent && (
              <div style={{ padding: '8px 12px', backgroundColor: 'var(--tf-bg)', borderRadius: '8px', marginBottom: '4px', borderLeft: '2px solid var(--tf-border)', marginLeft: '40px' }}>
                <p style={{ color: 'var(--tf-text-muted)', fontSize: '11px', fontStyle: 'italic' }}>{thinkingContent}</p>
              </div>
            )}
            {streamingContent && (
              <MessageBubble message={{ role: 'ceo', content: streamingContent, timestamp: new Date().toISOString() }}
                isStreaming
                ceoName={ceoName}
                userName={userName}
                onCopyPath={handleCopyPath}
                onCopyCommand={handleCopyCommand}
                onDeployPreview={(projectId) => handleDeployFromCompletion(projectId, 'preview')}
                onPromoteProduction={(projectId) => handleDeployFromCompletion(projectId, 'production')}
                onGenerateReleaseNotes={handleGenerateReleaseNotes}
                onStartReview={handleStartReviewFromCompletion}
                onAddBillingPack={handleAddBillingPack}
                onGuidanceAction={handleGuidanceAction}
                reviewActionsEnabled={previewReviewEnabled}
                billingActionsEnabled={stripeBillingPackEnabled}
              />
            )}
            {isWaiting && !streamingContent && actionLog.length === 0 && showThinking && (
              <ThinkingIndicator ceoName={ceoName} customText={thinkingContent || undefined} />
            )}
            {isWaiting && delegationContext && <DelegationReasoning context={delegationContext} />}
            {isWaiting && actionLog.length > 0 && <ActionLog entries={actionLog} ceoName={ceoName} />}
            {showActionDetails && actionDetails.length > 0 && (
              <div className="mx-1 mb-3 rounded-lg overflow-hidden" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
                <div className="px-3 py-1.5 text-xs font-medium" style={{ color: 'var(--tf-text-secondary)', borderBottom: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                  Technical Details {latestRunId ? `• Run ${latestRunId}` : ''}
                </div>
                <div className="px-3 py-2 space-y-2 max-h-44 overflow-y-auto">
                  {actionDetails.map((d, idx) => (
                    <div key={`${d.at}-${idx}`} style={{ borderBottom: '1px dashed var(--tf-border)', paddingBottom: '6px' }}>
                      <div className="text-xs font-medium" style={{ color: 'var(--tf-text-secondary)' }}>{d.label}</div>
                      {(d.actor || d.target || d.flow) && (
                        <div className="text-xs mt-0.5" style={{ color: 'var(--tf-text-muted)' }}>
                          flow: {d.actor || 'system'} {d.flow === 'up' ? '→' : d.flow === 'down' ? '↘' : '→'} {d.target || 'workspace'}
                        </div>
                      )}
                      {d.command && <div className="text-xs mt-0.5" style={{ color: 'var(--tf-accent)' }}>cmd: {d.command}</div>}
                      {d.cwd && <div className="text-xs mt-0.5" style={{ color: 'var(--tf-text-muted)' }}>cwd: {d.cwd}</div>}
                      {(typeof d.exit_code === 'number' || typeof d.duration_ms === 'number') && (
                        <div className="text-xs mt-0.5" style={{ color: 'var(--tf-text-muted)' }}>
                          {typeof d.exit_code === 'number' ? `exit=${d.exit_code}` : ''}{typeof d.exit_code === 'number' && typeof d.duration_ms === 'number' ? ' • ' : ''}{typeof d.duration_ms === 'number' ? `${d.duration_ms}ms` : ''}
                        </div>
                      )}
                      {d.output_preview && <div className="text-xs mt-0.5" style={{ color: 'var(--tf-text-muted)' }}>{d.output_preview}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Approval cards */}
            {visibleApprovals.map((project) => (
              <ProjectApprovalCard key={project.id} project={project} ceoName={ceoName}
                onApproved={(id) => { setDismissedProjectIds((s) => new Set([...s, id])); onProjectApproved?.(id); }}
                onRevise={(name) => { setInput(`Please revise the plan for "${name}": `); inputRef.current?.focus(); }}
                onNavigateToProject={onNavigateToProject} />
            ))}
            <div ref={messagesEndRef} className="h-1" />
          </>
        )}
      </div>

      {/* Input */}
      <div className={`flex items-end gap-2 flex-shrink-0 ${floating ? 'px-3 py-2' : 'mt-3'}`}
        style={floating ? { borderTop: '1px solid var(--tf-surface-raised)' } : undefined}>
        <div className="flex-1 rounded-xl overflow-hidden" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={isWaiting ? `${ceoName} is working…` : microProjectMode ? `Message ${ceoName} (Micro Project)…` : `Message ${ceoName}…`}
            rows={1}
            className="w-full resize-none px-4 py-3 text-sm outline-none"
            style={{ backgroundColor: 'transparent', color: 'var(--tf-text)', maxHeight: '120px', minHeight: '44px' }}
            onInput={(e) => {
              const t = e.target as HTMLTextAreaElement;
              t.style.height = 'auto';
              t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
            }} />
        </div>
        <button onClick={() => sendMessage()} disabled={isWaiting || !input.trim()}
          className="flex items-center justify-center w-11 h-11 rounded-xl transition-all duration-200 flex-shrink-0"
          style={{ backgroundColor: isWaiting || !input.trim() ? 'var(--tf-surface-raised)' : 'var(--tf-accent)', color: isWaiting || !input.trim() ? 'var(--tf-border)' : 'var(--tf-bg)', cursor: isWaiting || !input.trim() ? 'not-allowed' : 'pointer' }}
          title="Send message (Enter)" aria-label="Send message">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </div>

      {!floating && (
        <p className="text-xs mt-2 text-center" style={{ color: 'var(--tf-border)' }}>
          Enter to send · Shift+Enter for newline
        </p>
      )}
    </div>
  );
}
