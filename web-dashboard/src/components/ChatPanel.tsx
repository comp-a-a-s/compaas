import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ChatMessage, Project } from '../types';
import {
  fetchChatHistory,
  clearChatHistory,
  createChatWebSocket,
  approveProjectPlan,
  sendTelegramMessage,
  fetchMemory,
  addMemory,
  clearMemory,
  fetchMemoryPolicy,
  updateMemoryPolicy,
} from '../api/client';

// ---- Helpers ----

function formatTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'Invalid time';
  }
}

function msgKey(msg: ChatMessage): string {
  return `${msg.timestamp}|${msg.role}`;
}

// ---- Action text parser ----

interface ActionInfo { label: string; icon: string; color: string; }

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
    return { label: 'Running command…', icon: '⚡', color: 'var(--tf-accent)' };
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

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;
  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/\*(.+?)\*/);
    const codeMatch = remaining.match(/`(.+?)`/);
    const matches = [
      boldMatch   ? { index: boldMatch.index!,   match: boldMatch,   type: 'bold' }   : null,
      italicMatch ? { index: italicMatch.index!, match: italicMatch, type: 'italic' } : null,
      codeMatch   ? { index: codeMatch.index!,   match: codeMatch,   type: 'code' }   : null,
    ].filter(Boolean) as { index: number; match: RegExpMatchArray; type: string }[];
    if (matches.length === 0) { parts.push(remaining); break; }
    const first = matches.reduce((a, b) => a.index <= b.index ? a : b);
    if (first.index > 0) parts.push(remaining.slice(0, first.index));
    if (first.type === 'bold')
      parts.push(<strong key={key++} style={{ fontWeight: 700, color: 'var(--tf-text)' }}>{first.match[1]}</strong>);
    else if (first.type === 'italic')
      parts.push(<em key={key++} style={{ fontStyle: 'italic' }}>{first.match[1]}</em>);
    else
      parts.push(<code key={key++} style={{ backgroundColor: 'rgba(0,0,0,0.2)', padding: '1px 4px', borderRadius: '3px', fontFamily: 'ui-monospace, monospace', fontSize: '11px' }}>{first.match[1]}</code>);
    remaining = remaining.slice(first.index + first.match[0].length);
  }
  return <>{parts}</>;
}

function renderMarkdown(content: string): React.ReactNode {
  const lines = content.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('### '))
      result.push(<h3 key={i} style={{ fontSize: '13px', fontWeight: 700, color: 'var(--tf-text)', margin: '8px 0 4px' }}>{renderInlineMarkdown(line.slice(4))}</h3>);
    else if (line.startsWith('## '))
      result.push(<h2 key={i} style={{ fontSize: '14px', fontWeight: 700, color: 'var(--tf-text)', margin: '10px 0 4px' }}>{renderInlineMarkdown(line.slice(3))}</h2>);
    else if (line.startsWith('# '))
      result.push(<h1 key={i} style={{ fontSize: '15px', fontWeight: 700, color: 'var(--tf-text)', margin: '12px 0 4px' }}>{renderInlineMarkdown(line.slice(2))}</h1>);
    else if (line.startsWith('- ') || line.startsWith('* '))
      result.push(<div key={i} style={{ display: 'flex', gap: '6px', margin: '2px 0' }}>
        <span style={{ color: 'var(--tf-accent-blue)', flexShrink: 0 }}>•</span>
        <span style={{ color: 'var(--tf-text)' }}>{renderInlineMarkdown(line.slice(2))}</span>
      </div>);
    else if (/^\d+\. /.test(line)) {
      const num = line.match(/^(\d+)\. /)?.[1] ?? '';
      result.push(<div key={i} style={{ display: 'flex', gap: '6px', margin: '2px 0' }}>
        <span style={{ color: 'var(--tf-accent-blue)', flexShrink: 0, minWidth: '16px' }}>{num}.</span>
        <span style={{ color: 'var(--tf-text)' }}>{renderInlineMarkdown(line.replace(/^\d+\. /, ''))}</span>
      </div>);
    } else if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      result.push(<pre key={i} style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)', borderRadius: '6px', padding: '10px 12px', margin: '6px 0', fontSize: '11px', color: 'var(--tf-text)', overflowX: 'auto', fontFamily: 'ui-monospace, monospace' }}><code>{codeLines.join('\n')}</code></pre>);
    } else if (line.trim() === '') {
      result.push(<div key={i} style={{ height: '6px' }} />);
    } else {
      result.push(<p key={i} style={{ color: 'var(--tf-text)', fontSize: '13px', lineHeight: '1.6', margin: '2px 0' }}>{renderInlineMarkdown(line)}</p>);
    }
    i++;
  }
  return <>{result}</>;
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
}

function MessageBubble({ message, isStreaming, ceoName = 'CEO', userName = 'You', pinned, onPin, searchQuery }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-slide-up`}
      style={{ position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!isUser && (
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2 mt-1"
          style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }} title={ceoName}>
          {ceoName.charAt(0).toUpperCase()}
        </div>
      )}

      <div style={{ maxWidth: '75%', position: 'relative' }}>
        {pinned && (
          <div style={{ position: 'absolute', top: '-8px', right: isUser ? '8px' : 'auto', left: !isUser ? '8px' : 'auto', fontSize: '10px', color: 'var(--tf-warning)', zIndex: 1 }}>
            PIN
          </div>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 ${isStreaming ? 'streaming-bubble' : ''}`}
          style={{
            backgroundColor: isUser ? 'var(--tf-user-bubble)' : 'var(--tf-surface-raised)',
            borderBottomRightRadius: isUser ? '4px' : undefined,
            borderBottomLeftRadius: !isUser ? '4px' : undefined,
            border: isStreaming ? '1px solid var(--tf-accent)' : pinned ? '1px solid rgba(255,180,0,0.4)' : '1px solid transparent',
            transition: 'border-color 0.3s',
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold" style={{ color: isUser ? 'var(--tf-accent-blue)' : 'var(--tf-accent)' }}>
              {isUser ? userName : ceoName}
            </span>
            {message.timestamp && <span className="text-xs" style={{ color: 'var(--tf-border)' }}>{formatTime(message.timestamp)}</span>}
            {isStreaming && <span className="text-xs font-medium" style={{ color: 'var(--tf-accent)', opacity: 0.7 }}>typing…</span>}
          </div>
          {isUser ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--tf-text)' }}>
              {highlightSearch(message.content || (isStreaming ? '' : '(empty)'), searchQuery)}
            </p>
          ) : (
            <div className="text-sm leading-relaxed break-words">
              {message.content ? (
                <>
                  {searchQuery
                    ? <p style={{ color: 'var(--tf-text)', fontSize: '13px', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>{highlightSearch(message.content, searchQuery)}</p>
                    : renderMarkdown(message.content)
                  }
                  {isStreaming && <span className="blink-cursor" />}
                </>
              ) : (
                isStreaming ? <span className="blink-cursor" /> : <span style={{ color: 'var(--tf-text-muted)' }}>(empty response)</span>
              )}
            </div>
          )}
        </div>

        {/* Pin/unpin button on hover */}
        {onPin && hovered && !isStreaming && (
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
  cwd?: string;
  duration_ms?: number;
  exit_code?: number;
  output_preview?: string;
  state?: string;
  run_id?: string;
  at: string;
}

function ActionLog({ entries, ceoName }: { entries: ActionEntry[]; ceoName: string }) {
  const [collapsed, setCollapsed] = useState(false);
  if (entries.length === 0) return null;
  const running = entries.filter((e) => e.status === 'running').length;
  const done = entries.filter((e) => e.status === 'done').length;
  return (
    <div className="mx-1 mb-3 rounded-lg overflow-hidden" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
      <button onClick={() => setCollapsed((c) => !c)} className="w-full flex items-center gap-2 px-3 py-1.5 cursor-pointer text-left"
        style={{ borderBottom: collapsed ? 'none' : '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
        {running > 0
          ? <span className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot" style={{ backgroundColor: 'var(--tf-accent)' }} />
          : <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--tf-success)' }} />}
        <span className="text-xs font-medium flex-1" style={{ color: 'var(--tf-text-secondary)' }}>
          {running > 0 ? `${ceoName} is working` : `${ceoName} completed ${done} action${done !== 1 ? 's' : ''}`}
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
  const handleApprove = async () => {
    setApproving(true);
    const ok = await approveProjectPlan(project.id);
    setApproving(false);
    if (ok) { setApproved(true); onApproved(project.id); }
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
    | 'micro_project_warning'
    | 'planning_approval_required'
    | 'project_context';
  content?: string | {
    id?: string;
    status?: string;
    mode?: string;
    intent?: { intent?: string; confidence?: number; needs_planning?: boolean };
    reason?: string;
    run_id?: string;
    [k: string]: unknown;
  };
  message?: ChatMessage;
  project_id?: string;
  created?: boolean;
  project?: Project;
  run_id?: string;
  structured?: {
    summary?: string;
    delegations?: Array<Record<string, unknown>>;
    risks?: string[];
    next_actions?: string[];
  };
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
  pendingApprovalProjects?: Project[];
  onProjectApproved?: (projectId: string) => void;
  projects?: Project[];
  activeProjectId?: string;
  onActiveProjectChange?: (projectId: string) => void;
  telegramMirrorEnabled?: boolean;
  onTelegramMirrorChange?: (enabled: boolean) => void;
  microToggleRequestToken?: number;
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
}: ChatPanelProps) {
  // Core state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const showThinking = true;
  const [thinkingContent, setThinkingContent] = useState('');
  const [actionLog, setActionLog] = useState<ActionEntry[]>([]);
  const [actionDetails, setActionDetails] = useState<ActionDetailEntry[]>([]);
  const [showActionDetails, setShowActionDetails] = useState(false);
  const [latestRunId, setLatestRunId] = useState('');
  const [planningPendingDecision, setPlanningPendingDecision] = useState<{ message: string; reason: string } | null>(null);
  const [dismissedProjectIds, setDismissedProjectIds] = useState<Set<string>>(new Set());

  // Feature: Conversation search
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);

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
  const streamingAccumRef = useRef('');
  const turnErroredRef = useRef(false);
  const isWaitingRef = useRef(false);
  const lastOutboundMessageRef = useRef('');
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const telegramMirrorEnabledRef = useRef(telegramMirrorEnabled);

  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);
  useEffect(() => { ceoNameRef.current = ceoName; }, [ceoName]);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { onActiveProjectChangeRef.current = onActiveProjectChange; }, [onActiveProjectChange]);
  useEffect(() => { onNewCeoMessageRef.current = onNewCeoMessage; }, [onNewCeoMessage]);
  useEffect(() => { isWaitingRef.current = isWaiting; }, [isWaiting]);
  useEffect(() => { telegramMirrorEnabledRef.current = telegramMirrorEnabled; }, [telegramMirrorEnabled]);
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
      if (Array.isArray(history)) setMessages(history);
    }).catch(() => {});
  }, [activeProjectId]);

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

  const pushCeoMessage = useCallback((content: string, projectId: string) => {
    setMessages((prev) => [...prev, {
      role: 'ceo',
      content,
      timestamp: new Date().toISOString(),
      project_id: projectId,
    }]);
    void safeMirrorTelegram(ceoNameRef.current, content, projectId);
  }, [safeMirrorTelegram]);

  const completeAssistantTurn = useCallback(() => {
    turnErroredRef.current = false;
    setStreamingContent('');
    setThinkingContent('');
    setActionLog([]);
    setIsWaiting(false);
    if (!chatOpenRef.current) onNewCeoMessageRef.current?.();
  }, []);

  const typewriteAndCommit = useCallback((content: string, projectId: string) => {
    stopTypingAnimation();
    const chars = Array.from(content);
    let cursor = 0;
    const stride = chars.length > 900 ? 12 : chars.length > 350 ? 8 : 5;

    const step = () => {
      cursor = Math.min(chars.length, cursor + stride);
      setStreamingContent(chars.slice(0, cursor).join(''));
      if (cursor < chars.length) {
        typingTimerRef.current = setTimeout(step, 18);
        return;
      }
      typingTimerRef.current = null;
      pushCeoMessage(content, projectId);
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
                if (rid) setLatestRunId(rid);
              }
              break;
            case 'action':
              setActionLog((prev) => [...prev, {
                text: wsContentText(data.content, ''),
                status: 'running',
                at: new Date().toISOString(),
              }]);
              break;
            case 'action_detail':
              {
                const payload = wsContentObject(data.content);
                if (!payload) break;
                const command = payload.command ? String(payload.command) : undefined;
                const tool = payload.tool ? String(payload.tool) : undefined;
                const filePath = payload.file_path ? String(payload.file_path) : undefined;
                setActionDetails((prev) => [...prev, {
                  label: String(payload.label || 'Action detail'),
                  command,
                  tool,
                  file_path: filePath,
                  cwd: payload.cwd ? String(payload.cwd) : undefined,
                  duration_ms: typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined,
                  exit_code: typeof payload.exit_code === 'number' ? payload.exit_code : undefined,
                  output_preview: payload.output_preview ? String(payload.output_preview) : undefined,
                  state: payload.state ? String(payload.state) : undefined,
                  run_id: payload.run_id ? String(payload.run_id) : undefined,
                  at: new Date().toISOString(),
                }].slice(-120));
                if (String(payload.state || '').toLowerCase() === 'started') {
                  setActionLog((prev) => {
                    if (prev.length === 0) return prev;
                    const last = prev[prev.length - 1];
                    if (last.status !== 'running') return prev;
                    const nextText = enrichActionText(last.text, { command, filePath, tool });
                    if (nextText === last.text) return prev;
                    return [...prev.slice(0, -1), { ...last, text: nextText }];
                  });
                }
              }
              break;
            case 'action_result':
              setActionLog((prev) => prev.length > 0 ? [
                ...prev.slice(0, -1),
                {
                  ...prev[prev.length - 1],
                  status: 'done',
                  result: wsContentText(data.content, prev[prev.length - 1].result || ''),
                },
              ] : [{
                text: 'Action completed',
                status: 'done',
                result: wsContentText(data.content, ''),
                at: new Date().toISOString(),
              }]);
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
              streamingAccumRef.current = '';
              if (data.run_id) setLatestRunId(data.run_id);
              const projectId = data.project_id || activeProjectIdRef.current;
              if (!turnErroredRef.current && finalContent.trim()) {
                typewriteAndCommit(finalContent, projectId);
                break;
              }
              completeAssistantTurn();
              break;
            }
            case 'error':
              stopTypingAnimation();
              turnErroredRef.current = true;
              streamingAccumRef.current = '';
              setMessages((prev) => [...prev, {
                role: 'ceo',
                content: `[Error] ${wsContentText(data.content, 'Unknown error')}`,
                timestamp: new Date().toISOString(),
                project_id: activeProjectIdRef.current,
              }]);
              setStreamingContent('');
              setThinkingContent('');
              setActionLog([]);
              setIsWaiting(false);
              break;
            case 'warning':
              setMessages((prev) => [...prev, {
                role: 'ceo',
                content: `[Warning] ${typeof data.content === 'string' ? data.content : 'Warning received.'}`,
                timestamp: new Date().toISOString(),
                project_id: activeProjectIdRef.current,
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
                setPlanningPendingDecision({
                  message: lastOutboundMessageRef.current || '',
                  reason,
                });
              }
              setIsWaiting(false);
              setThinkingContent('');
              break;
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        stopTypingAnimation();
        setConnectionStatus('disconnected');
        if (!turnErroredRef.current && isWaitingRef.current) {
          setMessages((prev) => [...prev, {
            role: 'ceo',
            content: '[Error] Connection lost while waiting for CEO response. Reconnecting automatically…',
            timestamp: new Date().toISOString(),
            project_id: activeProjectIdRef.current,
          }]);
        }
        setStreamingContent('');
        setThinkingContent('');
        setActionLog([]);
        setIsWaiting(false);
        wsRef.current = null;
        if (shouldReconnectRef.current) {
          reconnectTimerRef.current = setTimeout(connectWebSocketImpl, 3000);
        }
      };
      ws.onerror = () => {
        setConnectionStatus('error');
        if (!turnErroredRef.current && isWaitingRef.current) {
          setMessages((prev) => [...prev, {
            role: 'ceo',
            content: '[Error] Chat connection error. Please retry once connection is restored.',
            timestamp: new Date().toISOString(),
            project_id: activeProjectIdRef.current,
          }]);
          setIsWaiting(false);
        }
      };
    } catch { setConnectionStatus('error'); }
  }, [completeAssistantTurn, stopTypingAnimation, typewriteAndCommit]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connectWebSocket();
    return () => {
      shouldReconnectRef.current = false;
      stopTypingAnimation();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      pendingOutboundRef.current = null;
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        wsRef.current.close();
      }
      wsRef.current = null;
    };
  }, [connectWebSocket, stopTypingAnimation]);

  const setMicroMode = useCallback((enabled: boolean) => {
    onMicroProjectModeChange?.(enabled);
    if (!enabled) {
      setShowMicroApprovalCard(false);
      setMicroPendingDecision(null);
    }
  }, [onMicroProjectModeChange]);

  const tryEnableMicroMode = useCallback(() => {
    setShowMicroApprovalCard(true);
  }, []);

  useEffect(() => {
    if (microToggleRequestToken <= 0) return;
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
    if (!activeProjectId) {
      setMessages((prev) => [...prev, {
        role: 'ceo',
        content: 'Select or create a project from the top header before starting CEO execution.',
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
    void safeMirrorTelegram(userName, text, activeProjectId || '');
    setInput('');
    setIsWaiting(true);
    setStreamingContent('');
    setThinkingContent('');
    setActionLog([]);
    setActionDetails([]);
    streamingAccumRef.current = '';
    turnErroredRef.current = false;
    setMicroPendingDecision(null);
    setPlanningPendingDecision(null);
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
  }, [activeProjectId, connectWebSocket, input, isWaiting, microProjectMode, safeMirrorTelegram, stopTypingAnimation, userName]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const handleClear = useCallback(async () => {
    stopTypingAnimation();
    await clearChatHistory(activeProjectId);
    setMessages([]); setStreamingContent(''); setThinkingContent('');
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
  const showConversationPanel = Boolean(
    hasMessages
    || isWaiting
    || microProjectMode
    || telegramMirrorEnabled
    || showMicroApprovalCard
    || microPendingDecision
    || planningPendingDecision
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
            {showActionDetails ? 'Hide Live Logs' : 'Show Live Logs'}
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
              setShowToolsMenu(false);
            }}
            style={{ width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: showMemory ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)' }}
          >
            Memory{memoryEntries.length > 0 ? ` (${memoryEntries.length})` : ''}
          </button>
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
              <select
                value={memoryScope}
                onChange={(e) => {
                  const scope = e.target.value as 'global' | 'project' | 'session-only';
                  persistMemoryPolicy(scope, memoryRetentionDays);
                }}
                style={{ fontSize: '11px', borderRadius: '4px', border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)', color: 'var(--tf-text)', padding: '2px 6px' }}
              >
                <option value="global">Global</option>
                <option value="project">Project</option>
                <option value="session-only">Session only</option>
              </select>
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
    </div>
  );

  return (
    <div className="flex flex-col" style={{ height: '100%', minHeight: floating ? undefined : '600px', position: 'relative' }}>
      {/* Pinned messages overlay */}
      {showPinned && (
        <PinnedPanel messages={pinnedMessages} ceoName={ceoName} userName={userName}
          onClose={() => setShowPinned(false)} onUnpin={handlePin} />
      )}

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
            {secondaryControls}
          </div>
        </div>
      )}

      {/* Floating header */}
      {floating && (
        <div className="flex items-start justify-between px-3 py-2 flex-shrink-0 gap-2" style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}>
          <div className="flex items-start gap-2 flex-wrap">
            <StatusBadge status={connectionStatus} />
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
          <EmptyState ceoName={ceoName} requireProject={!activeProjectId} />
        ) : (
          <>
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
                <p
                  className="text-xs mt-1"
                  style={{
                    color: 'var(--tf-text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Workspace: {activeProject.workspace_path}
                </p>
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

            {filteredMessages.map((msg, i) => {
              const key = msgKey(msg);
              return (
                <MessageBubble key={`${key}-${i}`} message={msg} ceoName={ceoName} userName={userName}
                  pinned={pinnedIds.has(key)} onPin={() => handlePin(key)} searchQuery={searchQuery} />
              );
            })}

            {/* Live CEO response */}
            {isWaiting && showThinking && thinkingContent && (
              <div style={{ padding: '8px 12px', backgroundColor: 'var(--tf-bg)', borderRadius: '8px', marginBottom: '4px', borderLeft: '2px solid var(--tf-border)', marginLeft: '40px' }}>
                <p style={{ color: 'var(--tf-text-muted)', fontSize: '11px', fontStyle: 'italic' }}>{thinkingContent}</p>
              </div>
            )}
            {streamingContent && (
              <MessageBubble message={{ role: 'ceo', content: streamingContent, timestamp: new Date().toISOString() }}
                isStreaming ceoName={ceoName} userName={userName} />
            )}
            {isWaiting && !streamingContent && actionLog.length === 0 && showThinking && (
              <ThinkingIndicator ceoName={ceoName} customText={thinkingContent || undefined} />
            )}
            {isWaiting && actionLog.length > 0 && <ActionLog entries={actionLog} ceoName={ceoName} />}
            {showActionDetails && actionDetails.length > 0 && (
              <div className="mx-1 mb-3 rounded-lg overflow-hidden" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
                <div className="px-3 py-1.5 text-xs font-medium" style={{ color: 'var(--tf-text-secondary)', borderBottom: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                  Execution Details {latestRunId ? `• Run ${latestRunId}` : ''}
                </div>
                <div className="px-3 py-2 space-y-2 max-h-44 overflow-y-auto">
                  {actionDetails.map((d, idx) => (
                    <div key={`${d.at}-${idx}`} style={{ borderBottom: '1px dashed var(--tf-border)', paddingBottom: '6px' }}>
                      <div className="text-xs font-medium" style={{ color: 'var(--tf-text-secondary)' }}>{d.label}</div>
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
            disabled={isWaiting} rows={1}
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
