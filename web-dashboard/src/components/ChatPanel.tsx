import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage, Project } from '../types';
import { fetchChatHistory, clearChatHistory, createChatWebSocket, approveProjectPlan } from '../api/client';

// ---- Helpers ----

function formatTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Invalid time';
  }
}

// Parse raw action text (tool names, file paths) into human-readable labels
interface ActionInfo {
  label: string;
  icon: string; // emoji-free: using unicode symbols
  color: string;
}

function parseActionText(text: string): ActionInfo {
  const lower = text.toLowerCase();

  if (lower.includes('delegat') || lower.includes('spawn') || lower.includes('subagent')) {
    const roleMatch = text.match(
      /\b(ceo|cto|cfo|ciso|backend|frontend|devops|qa|designer|researcher|security|writer)\b/i
    );
    const who = roleMatch ? roleMatch[1] : 'team';
    return { label: `Delegating to ${who}…`, icon: '→', color: 'var(--tf-accent)' };
  }
  if (lower.includes('task tool') || lower.includes('launching agent')) {
    return { label: 'Launching specialist agent…', icon: '→', color: 'var(--tf-accent)' };
  }
  if (lower.includes('websearch') || lower.includes('web search') || lower.includes('searching web')) {
    return { label: 'Searching the web…', icon: '⊕', color: 'var(--tf-accent-blue)' };
  }
  if (lower.includes('webfetch') || lower.includes('fetching') || lower.includes('web fetch')) {
    return { label: 'Fetching web page…', icon: '⊕', color: 'var(--tf-accent-blue)' };
  }
  if (lower.includes('grep') || lower.includes('search') || lower.includes('find')) {
    return { label: 'Searching codebase…', icon: '◎', color: 'var(--tf-warning)' };
  }
  if (lower.includes('read') || lower.includes('open file') || lower.includes('glob')) {
    const fileMatch = text.match(/[A-Za-z0-9_-]+\.[a-z]{2,5}/);
    return {
      label: fileMatch ? `Reading ${fileMatch[0]}` : 'Reading file…',
      icon: '▷',
      color: 'var(--tf-text-secondary)',
    };
  }
  if (lower.includes('write') || lower.includes('edit') || lower.includes('creat')) {
    const fileMatch = text.match(/[A-Za-z0-9_-]+\.[a-z]{2,5}/);
    return {
      label: fileMatch ? `Writing ${fileMatch[0]}` : 'Writing code…',
      icon: '✎',
      color: 'var(--tf-success)',
    };
  }
  if (lower.includes('bash') || lower.includes('run') || lower.includes('execut') || lower.includes('command')) {
    return { label: 'Running command…', icon: '⚡', color: 'var(--tf-accent)' };
  }
  if (lower.includes('plan') || lower.includes('analyz') || lower.includes('review')) {
    return { label: 'Analyzing…', icon: '◈', color: 'var(--tf-warning)' };
  }
  if (lower.includes('creat') && lower.includes('project')) {
    return { label: 'Creating project plan…', icon: '◈', color: 'var(--tf-accent)' };
  }

  // Shorten raw paths/long strings
  const clean = text
    .replace(/\/home\/[^\s/]+\/[^\s/]+\//g, '…/')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    label: clean.length > 72 ? clean.slice(0, 69) + '…' : clean,
    icon: '◦',
    color: 'var(--tf-text-muted)',
  };
}

// ---- Markdown renderer ----

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;
  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/\*(.+?)\*/);
    const codeMatch = remaining.match(/`(.+?)`/);
    const matches = [
      boldMatch ? { index: boldMatch.index!, match: boldMatch, type: 'bold' } : null,
      italicMatch ? { index: italicMatch.index!, match: italicMatch, type: 'italic' } : null,
      codeMatch ? { index: codeMatch.index!, match: codeMatch, type: 'code' } : null,
    ].filter(Boolean) as { index: number; match: RegExpMatchArray; type: string }[];
    matches.sort((a, b) => a.index - b.index);
    if (matches.length === 0) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
    const first = matches[0];
    if (first.index > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, first.index)}</span>);
    }
    if (first.type === 'bold') {
      parts.push(<strong key={key++} style={{ fontWeight: 700, color: 'var(--tf-text)' }}>{first.match[1]}</strong>);
    } else if (first.type === 'italic') {
      parts.push(<em key={key++} style={{ fontStyle: 'italic' }}>{first.match[1]}</em>);
    } else {
      parts.push(<code key={key++} style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)', borderRadius: '3px', padding: '0 4px', fontSize: '11px', fontFamily: 'ui-monospace, monospace' }}>{first.match[1]}</code>);
    }
    remaining = remaining.slice(first.index + first.match[0].length);
  }
  return <>{parts}</>;
}

function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('### ')) {
      result.push(<h3 key={i} style={{ color: 'var(--tf-text)', fontSize: '13px', fontWeight: 700, margin: '8px 0 4px' }}>{line.slice(4)}</h3>);
    } else if (line.startsWith('## ')) {
      result.push(<h2 key={i} style={{ color: 'var(--tf-text)', fontSize: '14px', fontWeight: 700, margin: '8px 0 4px' }}>{line.slice(3)}</h2>);
    } else if (line.startsWith('# ')) {
      result.push(<h1 key={i} style={{ color: 'var(--tf-text)', fontSize: '15px', fontWeight: 700, margin: '8px 0 4px' }}>{line.slice(2)}</h1>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      result.push(<div key={i} style={{ display: 'flex', gap: '6px', margin: '2px 0' }}>
        <span style={{ color: 'var(--tf-accent-blue)', flexShrink: 0 }}>•</span>
        <span style={{ color: 'var(--tf-text)' }}>{renderInlineMarkdown(line.slice(2))}</span>
      </div>);
    } else if (/^\d+\. /.test(line)) {
      const num = line.match(/^(\d+)\. /)?.[1] ?? '';
      result.push(<div key={i} style={{ display: 'flex', gap: '6px', margin: '2px 0' }}>
        <span style={{ color: 'var(--tf-accent-blue)', flexShrink: 0, minWidth: '16px' }}>{num}.</span>
        <span style={{ color: 'var(--tf-text)' }}>{renderInlineMarkdown(line.replace(/^\d+\. /, ''))}</span>
      </div>);
    } else if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
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

// ---- Message bubble ----

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  ceoName?: string;
  userName?: string;
}

function MessageBubble({ message, isStreaming, ceoName = 'CEO', userName = 'You' }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const ceoInitial = ceoName.charAt(0).toUpperCase();
  const userInitial = userName.charAt(0).toUpperCase();

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-slide-up`}>
      {/* CEO avatar */}
      {!isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2 mt-1"
          style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }}
          title={ceoName}
        >
          {ceoInitial}
        </div>
      )}

      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${isStreaming ? 'streaming-bubble' : ''}`}
        style={{
          backgroundColor: isUser ? 'var(--tf-user-bubble)' : 'var(--tf-surface-raised)',
          borderBottomRightRadius: isUser ? '4px' : undefined,
          borderBottomLeftRadius: !isUser ? '4px' : undefined,
          border: isStreaming ? '1px solid var(--tf-accent)' : '1px solid transparent',
          transition: 'border-color 0.3s',
        }}
      >
        {/* Sender label + timestamp */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold" style={{ color: isUser ? 'var(--tf-accent-blue)' : 'var(--tf-accent)' }}>
            {isUser ? userName : ceoName}
          </span>
          {message.timestamp && (
            <span className="text-xs" style={{ color: 'var(--tf-border)' }}>
              {formatTime(message.timestamp)}
            </span>
          )}
          {isStreaming && (
            <span className="text-xs font-medium" style={{ color: 'var(--tf-accent)', opacity: 0.7 }}>
              typing…
            </span>
          )}
        </div>

        {/* Content */}
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--tf-text)' }}>
            {message.content || (isStreaming ? '' : '(empty response)')}
          </p>
        ) : (
          <div className="text-sm leading-relaxed break-words">
            {message.content ? (
              <>
                {renderMarkdown(message.content)}
                {/* Blinking typewriter cursor while streaming */}
                {isStreaming && <span className="blink-cursor" />}
              </>
            ) : (
              isStreaming
                ? <span className="blink-cursor" />
                : <span style={{ color: 'var(--tf-text-muted)' }}>(empty response)</span>
            )}
          </div>
        )}
      </div>

      {/* User avatar */}
      {isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ml-2 mt-1"
          style={{ backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)' }}
          title={userName}
        >
          {userInitial}
        </div>
      )}
    </div>
  );
}

// ---- Empty state ----

function EmptyState({ ceoName = 'CEO' }: { ceoName?: string }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 py-20">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
        <svg className="w-8 h-8" style={{ color: 'var(--tf-accent)' }} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium" style={{ color: 'var(--tf-text)' }}>
          Chat with {ceoName}, the CEO
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
          Send a message to start a conversation. {ceoName} has full access to company tools and can manage projects, tasks, and team operations.
        </p>
      </div>
    </div>
  );
}

// ---- Action log ----
// Shows what the CEO is doing (tool calls, file reads, etc.) in human-readable form.
// Rendered BELOW the streaming text bubble so the chairman reads the response first.

interface ActionEntry {
  text: string;
  status: 'running' | 'done';
}

function ActionLog({ entries, ceoName }: { entries: ActionEntry[]; ceoName: string }) {
  const [collapsed, setCollapsed] = useState(false);
  if (entries.length === 0) return null;

  const running = entries.filter((e) => e.status === 'running').length;
  const done = entries.filter((e) => e.status === 'done').length;

  return (
    <div
      className="mx-1 mb-3 rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}
    >
      {/* Header — click to collapse */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-3 py-1.5 cursor-pointer text-left"
        style={{ borderBottom: collapsed ? 'none' : '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}
      >
        {running > 0 ? (
          <span className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot" style={{ backgroundColor: 'var(--tf-accent)' }} />
        ) : (
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--tf-success)' }} />
        )}
        <span className="text-xs font-medium flex-1" style={{ color: 'var(--tf-text-secondary)' }}>
          {running > 0 ? `${ceoName} is working` : `${ceoName} completed ${done} action${done !== 1 ? 's' : ''}`}
        </span>
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)', fontFamily: 'monospace' }}>
          {collapsed ? '▸' : '▾'}
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 py-2 space-y-1.5 max-h-44 overflow-y-auto">
          {entries.map((entry, i) => {
            const info = parseActionText(entry.text);
            return (
              <div key={i} className="flex items-center gap-2">
                {entry.status === 'done' ? (
                  <span className="text-xs flex-shrink-0 w-3 text-center" style={{ color: 'var(--tf-success)' }}>✓</span>
                ) : (
                  <span className="text-xs flex-shrink-0 w-3 text-center animate-pulse-dot" style={{ color: info.color }}>
                    {info.icon}
                  </span>
                )}
                <span
                  className="text-xs leading-snug"
                  style={{ color: entry.status === 'done' ? 'var(--tf-text-muted)' : info.color }}
                >
                  {info.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Project approval card ----
// Appears in the chat when the CEO has finished planning a project
// and the chairman (user) needs to approve or send back for revisions.

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
    if (ok) {
      setApproved(true);
      onApproved(project.id);
    }
  };

  if (approved) {
    return (
      <div
        className="mx-1 mb-3 px-4 py-3 rounded-xl animate-slide-up flex items-center gap-2"
        style={{ backgroundColor: 'rgba(63,185,80,0.08)', border: '1px solid rgba(63,185,80,0.3)' }}
      >
        <span style={{ color: 'var(--tf-success)' }}>✓</span>
        <span className="text-xs font-medium" style={{ color: 'var(--tf-success)' }}>
          "{project.name}" approved — team is now active
        </span>
      </div>
    );
  }

  return (
    <div
      className="mx-1 mb-3 rounded-xl overflow-hidden animate-pop-in"
      style={{ border: '1px solid var(--tf-accent)', backgroundColor: 'var(--tf-surface)' }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-2.5"
        style={{ backgroundColor: 'var(--tf-surface-raised)', borderBottom: '1px solid var(--tf-border)' }}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot"
          style={{ backgroundColor: 'var(--tf-accent)' }}
        />
        <span className="text-xs font-semibold" style={{ color: 'var(--tf-accent)' }}>
          Plan Ready for Chairman Review
        </span>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2">
        <p className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
          {ceoName} has finished planning:
        </p>
        <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>
          {project.name}
        </p>
        {project.description && (
          <p
            className="text-xs leading-relaxed"
            style={{
              color: 'var(--tf-text-muted)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {project.description}
          </p>
        )}
      </div>

      {/* Actions */}
      <div
        className="flex items-center gap-2 px-4 py-2.5"
        style={{ borderTop: '1px solid var(--tf-border)' }}
      >
        <button
          onClick={handleApprove}
          disabled={approving}
          className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all duration-200 cursor-pointer"
          style={{
            backgroundColor: approving ? 'var(--tf-surface-raised)' : 'var(--tf-accent)',
            color: approving ? 'var(--tf-text-muted)' : 'var(--tf-bg)',
            border: 'none',
            cursor: approving ? 'wait' : 'pointer',
          }}
        >
          {approving ? 'Approving…' : '✓ Approve & Start'}
        </button>
        <button
          onClick={() => onRevise(project.name)}
          className="text-xs px-3 py-1.5 rounded-lg transition-all duration-200 cursor-pointer"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--tf-text-muted)',
            border: '1px solid var(--tf-border)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)'; }}
        >
          ✗ Request Changes
        </button>
        {onNavigateToProject && (
          <button
            onClick={() => onNavigateToProject(project.id)}
            className="text-xs px-3 py-1.5 rounded-lg transition-all duration-200 cursor-pointer ml-auto"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--tf-accent-blue)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            View Plan ↗
          </button>
        )}
      </div>
    </div>
  );
}

// ---- WebSocket message type ----

interface WsMessage {
  type: 'user_ack' | 'thinking' | 'chunk' | 'done' | 'error' | 'action' | 'action_result';
  content?: string;
  message?: ChatMessage;
}

function isWsMessage(data: unknown): data is WsMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).type === 'string'
  );
}

// ---- Connection status ----

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const config: Record<ConnectionStatus, { color: string; label: string }> = {
    connecting: { color: 'var(--tf-warning)', label: 'Connecting...' },
    connected: { color: 'var(--tf-success)', label: 'Connected' },
    disconnected: { color: 'var(--tf-text-muted)', label: 'Disconnected' },
    error: { color: 'var(--tf-error)', label: 'Error' },
  };
  const { color, label } = config[status];
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${status === 'connecting' ? 'animate-pulse-dot' : ''}`}
        style={{ backgroundColor: color }}
      />
      <span className="text-xs" style={{ color }}>{label}</span>
    </div>
  );
}

// ---- Thinking status message (alive feel while waiting for first chunk) ----

const THINKING_PHRASES = [
  'Thinking…',
  'Analyzing your request…',
  'Consulting the team…',
  'Reviewing context…',
  'Processing…',
];

function ThinkingIndicator({ ceoName, customText }: { ceoName: string; customText?: string }) {
  const [phraseIdx, setPhraseIdx] = useState(0);

  useEffect(() => {
    if (customText) return;
    const id = setInterval(() => {
      setPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length);
    }, 2200);
    return () => clearInterval(id);
  }, [customText]);

  const phrase = customText || THINKING_PHRASES[phraseIdx];

  return (
    <div className="flex justify-start mb-3">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2"
        style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }}
      >
        {ceoName.charAt(0).toUpperCase()}
      </div>
      <div
        className="rounded-2xl px-4 py-3 flex items-center gap-3"
        style={{ backgroundColor: 'var(--tf-surface-raised)', borderBottomLeftRadius: '4px' }}
      >
        {/* Bouncing dots */}
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full animate-pulse-dot"
              style={{ backgroundColor: 'var(--tf-accent)', animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
          {phrase}
        </span>
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
  onNavigateToProject?: (projectId: string) => void;
  onNavigateToProjects?: () => void;
  pendingApprovalProjects?: Project[];
  onProjectApproved?: (projectId: string) => void;
}

export default function ChatPanel({
  floating = false,
  chatOpen,
  onNewCeoMessage,
  ceoName = 'CEO',
  userName = 'You',
  onNavigateToProjects,
  onNavigateToProject,
  pendingApprovalProjects = [],
  onProjectApproved,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [showThinking, setShowThinking] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [actionLog, setActionLog] = useState<ActionEntry[]>([]);
  // Dismissed approval cards (approved or user dismissed)
  const [dismissedProjectIds, setDismissedProjectIds] = useState<Set<string>>(new Set());

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatOpenRef = useRef(chatOpen);
  const onNewCeoMessageRef = useRef(onNewCeoMessage);
  // Ref to accumulate streaming content (avoids stale closure in 'done' handler)
  const streamingAccumRef = useRef('');

  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);
  useEffect(() => { onNewCeoMessageRef.current = onNewCeoMessage; }, [onNewCeoMessage]);

  // Auto-scroll
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, streamingContent, actionLog, scrollToBottom]);

  // Load chat history on mount
  useEffect(() => {
    fetchChatHistory(100).then((history) => {
      if (Array.isArray(history) && history.length > 0) setMessages(history);
    }).catch(() => {});
  }, []);

  // WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setConnectionStatus('connecting');

    try {
      const ws = createChatWebSocket();
      wsRef.current = ws;

      ws.onopen = () => setConnectionStatus('connected');

      ws.onmessage = (evt) => {
        try {
          const raw: unknown = JSON.parse(evt.data);
          if (!isWsMessage(raw)) return;
          const data: WsMessage = raw;

          switch (data.type) {
            case 'user_ack':
              break;

            case 'thinking':
              setThinkingContent(data.content || `${ceoName} is thinking…`);
              break;

            case 'action':
              setActionLog((prev) => [...prev, { text: data.content || '', status: 'running' }]);
              break;

            case 'action_result':
              setActionLog((prev) =>
                prev.length > 0
                  ? [...prev.slice(0, -1), { ...prev[prev.length - 1], status: 'done' }]
                  : prev
              );
              break;

            case 'chunk': {
              // Mark last running action as done when text starts flowing
              setActionLog((prev) =>
                prev.length > 0 && prev[prev.length - 1].status === 'running'
                  ? [...prev.slice(0, -1), { ...prev[prev.length - 1], status: 'done' }]
                  : prev
              );
              const chunk = data.content || '';
              streamingAccumRef.current += chunk;
              setStreamingContent(streamingAccumRef.current);
              break;
            }

            case 'done': {
              // Use accumulated content (reliable across async renders)
              const finalContent = streamingAccumRef.current || data.content || '';
              streamingAccumRef.current = '';

              const ceoMessage: ChatMessage = {
                role: 'ceo',
                content: finalContent,
                timestamp: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, ceoMessage]);
              setStreamingContent('');
              setThinkingContent('');
              setActionLog([]);
              setIsWaiting(false);
              if (!chatOpenRef.current) {
                onNewCeoMessageRef.current?.();
              }
              break;
            }

            case 'error':
              streamingAccumRef.current = '';
              setMessages((prev) => [
                ...prev,
                { role: 'ceo', content: `[Error] ${data.content || 'Unknown error'}`, timestamp: new Date().toISOString() },
              ]);
              setStreamingContent('');
              setThinkingContent('');
              setActionLog([]);
              setIsWaiting(false);
              break;
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnectionStatus('disconnected');
        wsRef.current = null;
        reconnectTimerRef.current = setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = () => setConnectionStatus('error');
    } catch {
      setConnectionStatus('error');
    }
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connectWebSocket]);

  // Send message
  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || isWaiting) return;

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
      return;
    }

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsWaiting(true);
    setStreamingContent('');
    setThinkingContent('');
    setActionLog([]);
    streamingAccumRef.current = '';

    ws.send(JSON.stringify({ message: text }));
  }, [input, isWaiting, connectWebSocket]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleClear = async () => {
    await clearChatHistory();
    setMessages([]);
    setStreamingContent('');
    setThinkingContent('');
    streamingAccumRef.current = '';
  };

  // Pending approval projects (filter out already dismissed)
  const visibleApprovals = pendingApprovalProjects.filter(
    (p) => !dismissedProjectIds.has(p.id)
  );

  const hasMessages = messages.length > 0 || streamingContent;

  return (
    <div className="flex flex-col" style={{ height: '100%', minHeight: floating ? undefined : '600px' }}>
      {/* Header — full (non-floating) mode */}
      {!floating && (
        <div className="flex items-center justify-between pb-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }}
            >
              {ceoName.charAt(0).toUpperCase()}
            </div>
            <div>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>
                {ceoName} — CEO Chat
              </h3>
              <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                AI Virtual Company Orchestrator
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={connectionStatus} />
            <button
              onClick={() => setShowThinking((t) => !t)}
              title={showThinking ? 'Hide thinking' : 'Show thinking'}
              className="text-xs px-2 py-1 rounded-lg transition-colors duration-200 cursor-pointer"
              style={{ backgroundColor: showThinking ? 'var(--tf-surface-raised)' : 'transparent', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)' }}
            >
              {showThinking ? '◎ thinking' : '○ thinking'}
            </button>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="text-xs px-2 py-1 rounded-lg transition-colors duration-200 cursor-pointer"
                style={{ backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-text-muted)', border: '1px solid var(--tf-border)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-error)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-error)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-border)'; }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Floating header */}
      {floating && (
        <div className="flex items-center justify-between px-3 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}>
          <div className="flex items-center gap-2">
            <StatusBadge status={connectionStatus} />
            {onNavigateToProjects && (
              <button
                onClick={onNavigateToProjects}
                title="Go to Projects"
                className="text-xs px-2 py-0.5 rounded cursor-pointer"
                style={{ color: 'var(--tf-accent-blue)', backgroundColor: 'transparent', border: 'none' }}
              >
                Projects ↗
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowThinking((t) => !t)}
              title={showThinking ? 'Hide thinking' : 'Show thinking'}
              style={{ padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--tf-border)', backgroundColor: showThinking ? 'var(--tf-surface-raised)' : 'transparent', color: 'var(--tf-text-muted)', fontSize: '10px', cursor: 'pointer' }}
            >
              {showThinking ? '◎ thinking' : '○ thinking'}
            </button>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="text-xs px-2 py-0.5 rounded transition-colors duration-200 cursor-pointer"
                style={{ color: 'var(--tf-text-muted)', background: 'none', border: 'none' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-error)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)'; }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Messages area */}
      <div
        className={`flex-1 overflow-y-auto ${floating ? 'px-3 py-3' : 'rounded-xl px-4 py-4'}`}
        style={floating
          ? { backgroundColor: 'var(--tf-bg)' }
          : { backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }
        }
      >
        {!hasMessages && !isWaiting ? (
          <EmptyState ceoName={ceoName} />
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble
                key={`${msg.timestamp}-${msg.role}-${i}`}
                message={msg}
                ceoName={ceoName}
                userName={userName}
              />
            ))}

            {/* ---- Live CEO response section ---- */}

            {/* 1. Thinking display (opt-in via toggle) */}
            {isWaiting && showThinking && thinkingContent && (
              <div style={{ padding: '8px 12px', backgroundColor: 'var(--tf-bg)', borderRadius: '8px', marginBottom: '4px', borderLeft: '2px solid var(--tf-border)', marginLeft: '40px' }}>
                <p style={{ color: 'var(--tf-text-muted)', fontSize: '11px', fontStyle: 'italic' }}>{thinkingContent}</p>
              </div>
            )}

            {/* 2. Streaming text bubble (shows as soon as first chunk arrives) */}
            {streamingContent && (
              <MessageBubble
                message={{ role: 'ceo', content: streamingContent, timestamp: new Date().toISOString() }}
                isStreaming
                ceoName={ceoName}
                userName={userName}
              />
            )}

            {/* 3. Waiting indicator — only before any text arrives */}
            {isWaiting && !streamingContent && (
              <ThinkingIndicator ceoName={ceoName} customText={thinkingContent || undefined} />
            )}

            {/* 4. Action log — BELOW the streaming text so the chairman reads the response first */}
            {isWaiting && actionLog.length > 0 && (
              <ActionLog entries={actionLog} ceoName={ceoName} />
            )}

            {/* ---- Project approval cards ---- */}
            {visibleApprovals.map((project) => (
              <ProjectApprovalCard
                key={project.id}
                project={project}
                ceoName={ceoName}
                onApproved={(id) => {
                  setDismissedProjectIds((s) => new Set([...s, id]));
                  onProjectApproved?.(id);
                }}
                onRevise={(name) => {
                  setInput(`Please revise the plan for "${name}": `);
                  inputRef.current?.focus();
                }}
                onNavigateToProject={onNavigateToProject}
              />
            ))}

            <div ref={messagesEndRef} className="h-1" />
          </>
        )}
      </div>

      {/* Input area */}
      <div
        className={`flex items-end gap-2 flex-shrink-0 ${floating ? 'px-3 py-2' : 'mt-3'}`}
        style={floating ? { borderTop: '1px solid var(--tf-surface-raised)' } : undefined}
      >
        <div
          className="flex-1 rounded-xl overflow-hidden"
          style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isWaiting ? `${ceoName} is working…` : `Message ${ceoName}…`}
            disabled={isWaiting}
            rows={1}
            className="w-full resize-none px-4 py-3 text-sm outline-none"
            style={{ backgroundColor: 'transparent', color: 'var(--tf-text)', maxHeight: '120px', minHeight: '44px' }}
            onInput={(e) => {
              const t = e.target as HTMLTextAreaElement;
              t.style.height = 'auto';
              t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
            }}
          />
        </div>

        <button
          onClick={sendMessage}
          disabled={isWaiting || !input.trim()}
          className="flex items-center justify-center w-11 h-11 rounded-xl transition-all duration-200 flex-shrink-0"
          style={{
            backgroundColor: isWaiting || !input.trim() ? 'var(--tf-surface-raised)' : 'var(--tf-accent)',
            color: isWaiting || !input.trim() ? 'var(--tf-border)' : 'var(--tf-bg)',
            cursor: isWaiting || !input.trim() ? 'not-allowed' : 'pointer',
          }}
          title="Send message (Enter)"
          aria-label="Send message"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </div>

      {!floating && (
        <p className="text-xs mt-2 text-center" style={{ color: 'var(--tf-border)' }}>
          Press Enter to send · Shift+Enter for newline
        </p>
      )}
    </div>
  );
}
