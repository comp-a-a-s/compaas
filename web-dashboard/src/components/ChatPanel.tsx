import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage } from '../types';
import { fetchChatHistory, clearChatHistory, createChatWebSocket } from '../api/client';

// ---- Helpers ----

function formatTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return ts;
  }
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
    // H3
    if (line.startsWith('### ')) {
      result.push(<h3 key={i} style={{ color: 'var(--tf-text)', fontSize: '13px', fontWeight: 700, margin: '8px 0 4px' }}>{line.slice(4)}</h3>);
    }
    // H2
    else if (line.startsWith('## ')) {
      result.push(<h2 key={i} style={{ color: 'var(--tf-text)', fontSize: '14px', fontWeight: 700, margin: '8px 0 4px' }}>{line.slice(3)}</h2>);
    }
    // H1
    else if (line.startsWith('# ')) {
      result.push(<h1 key={i} style={{ color: 'var(--tf-text)', fontSize: '15px', fontWeight: 700, margin: '8px 0 4px' }}>{line.slice(2)}</h1>);
    }
    // Bullet list
    else if (line.startsWith('- ') || line.startsWith('* ')) {
      result.push(<div key={i} style={{ display: 'flex', gap: '6px', margin: '2px 0' }}>
        <span style={{ color: 'var(--tf-accent-blue)', flexShrink: 0 }}>•</span>
        <span style={{ color: 'var(--tf-text)' }}>{renderInlineMarkdown(line.slice(2))}</span>
      </div>);
    }
    // Numbered list
    else if (/^\d+\. /.test(line)) {
      const num = line.match(/^(\d+)\. /)?.[1] ?? '';
      result.push(<div key={i} style={{ display: 'flex', gap: '6px', margin: '2px 0' }}>
        <span style={{ color: 'var(--tf-accent-blue)', flexShrink: 0, minWidth: '16px' }}>{num}.</span>
        <span style={{ color: 'var(--tf-text)' }}>{renderInlineMarkdown(line.replace(/^\d+\. /, ''))}</span>
      </div>);
    }
    // Code block
    else if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      result.push(<pre key={i} style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)', borderRadius: '6px', padding: '10px 12px', margin: '6px 0', fontSize: '11px', color: 'var(--tf-text)', overflowX: 'auto', fontFamily: 'ui-monospace, monospace' }}><code>{codeLines.join('\n')}</code></pre>);
    }
    // Empty line -> spacer
    else if (line.trim() === '') {
      result.push(<div key={i} style={{ height: '6px' }} />);
    }
    // Normal paragraph
    else {
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
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-slide-up`}
    >
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
        className="max-w-[75%] rounded-2xl px-4 py-2.5"
        style={{
          backgroundColor: isUser ? '#1c2940' : 'var(--tf-surface-raised)',
          borderBottomRightRadius: isUser ? '4px' : undefined,
          borderBottomLeftRadius: !isUser ? '4px' : undefined,
        }}
      >
        {/* Sender label */}
        <div className="flex items-center gap-2 mb-1">
          <span
            className="text-xs font-semibold"
            style={{ color: isUser ? 'var(--tf-accent-blue)' : 'var(--tf-accent)' }}
          >
            {isUser ? userName : ceoName}
          </span>
          {message.timestamp && (
            <span className="text-xs" style={{ color: 'var(--tf-border)' }}>
              {formatTime(message.timestamp)}
            </span>
          )}
          {isStreaming && (
            <span className="flex gap-0.5 ml-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full animate-pulse-dot"
                  style={{
                    backgroundColor: 'var(--tf-accent)',
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ))}
            </span>
          )}
        </div>

        {/* Message content — rendered as markdown for CEO messages */}
        {isUser ? (
          <p
            className="text-sm leading-relaxed whitespace-pre-wrap break-words"
            style={{ color: 'var(--tf-text)' }}
          >
            {message.content || (isStreaming ? '' : '(empty response)')}
          </p>
        ) : (
          <div className="text-sm leading-relaxed break-words">
            {message.content
              ? renderMarkdown(message.content)
              : (isStreaming ? null : <span style={{ color: 'var(--tf-text-muted)' }}>(empty response)</span>)
            }
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
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{ backgroundColor: 'var(--tf-surface-raised)' }}
      >
        <svg
          className="w-8 h-8"
          style={{ color: 'var(--tf-accent)' }}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium" style={{ color: 'var(--tf-text)' }}>
          Chat with {ceoName}, the CEO
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
          Send a message to start a conversation. {ceoName} has full access
          to company tools and can manage projects, tasks, and team operations.
        </p>
      </div>
    </div>
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
      <span className="text-xs" style={{ color }}>
        {label}
      </span>
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
}

export default function ChatPanel({ floating = false, chatOpen, onNewCeoMessage, ceoName = 'CEO', userName = 'You' }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [showThinking, setShowThinking] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatOpenRef = useRef(chatOpen);
  const onNewCeoMessageRef = useRef(onNewCeoMessage);

  // Keep refs to avoid stale closures in ws handlers
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  useEffect(() => {
    onNewCeoMessageRef.current = onNewCeoMessage;
  }, [onNewCeoMessage]);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  // Load chat history on mount
  useEffect(() => {
    fetchChatHistory(100).then((history) => {
      if (Array.isArray(history) && history.length > 0) {
        setMessages(history);
      }
    }).catch(() => {});
  }, []);

  // WebSocket connection management
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setConnectionStatus('connecting');

    try {
      const ws = createChatWebSocket();
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);

          switch (data.type) {
            case 'user_ack':
              // User message acknowledged — already added optimistically
              break;

            case 'thinking':
              setThinkingContent(data.content || `${ceoName} is thinking...`);
              break;

            case 'chunk':
              setStreamingContent((prev) => prev + (data.content || ''));
              break;

            case 'done': {
              const ceoMessage: ChatMessage = {
                role: 'ceo',
                content: data.content || '',
                timestamp: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, ceoMessage]);
              setStreamingContent('');
              setThinkingContent('');
              setIsWaiting(false);
              // Notify parent if chat is not open
              if (!chatOpenRef.current) {
                onNewCeoMessageRef.current?.();
              }
              break;
            }

            case 'error':
              setMessages((prev) => [
                ...prev,
                {
                  role: 'ceo',
                  content: `[Error] ${data.content || 'Unknown error'}`,
                  timestamp: new Date().toISOString(),
                },
              ]);
              setStreamingContent('');
              setThinkingContent('');
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
        // Auto-reconnect after 3 seconds
        reconnectTimerRef.current = setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = () => {
        setConnectionStatus('error');
      };
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

    // Optimistically add user message
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

    ws.send(JSON.stringify({ message: text }));
  }, [input, isWaiting, connectWebSocket]);

  // Handle Enter key (Shift+Enter for newline)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Clear chat
  const handleClear = async () => {
    await clearChatHistory();
    setMessages([]);
    setStreamingContent('');
    setThinkingContent('');
  };

  const hasMessages = messages.length > 0 || streamingContent;

  return (
    <div className="flex flex-col" style={{ height: '100%', minHeight: floating ? undefined : '600px' }}>
      {/* Header bar — hidden in floating mode (parent provides header) */}
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
              onClick={() => setShowThinking(t => !t)}
              title={showThinking ? 'Hide thinking' : 'Show thinking'}
              className="text-xs px-2 py-1 rounded-lg transition-colors duration-200 cursor-pointer"
              style={{
                backgroundColor: showThinking ? 'var(--tf-surface-raised)' : 'transparent',
                color: 'var(--tf-text-muted)',
                border: '1px solid var(--tf-border)',
              }}
            >
              {showThinking ? '◎ thinking' : '○ thinking'}
            </button>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="text-xs px-2 py-1 rounded-lg transition-colors duration-200 cursor-pointer"
                style={{
                  backgroundColor: 'var(--tf-surface-raised)',
                  color: 'var(--tf-text-muted)',
                  border: '1px solid var(--tf-border)',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-error)';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-error)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-border)';
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Floating header: status + thinking toggle + clear */}
      {floating && (
        <div className="flex items-center justify-between px-3 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}>
          <StatusBadge status={connectionStatus} />
          <div className="flex items-center gap-2">
            {/* Thinking toggle */}
            <button
              onClick={() => setShowThinking(t => !t)}
              title={showThinking ? 'Hide thinking' : 'Show thinking'}
              style={{
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid var(--tf-border)',
                backgroundColor: showThinking ? 'var(--tf-surface-raised)' : 'transparent',
                color: 'var(--tf-text-muted)',
                fontSize: '10px',
                cursor: 'pointer',
              }}
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
        style={floating ? { backgroundColor: 'var(--tf-bg)' } : {
          backgroundColor: 'var(--tf-surface)',
          border: '1px solid var(--tf-border)',
        }}
      >
        {!hasMessages ? (
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

            {/* Streaming response */}
            {streamingContent && (
              <>
                {/* Thinking display — shown when showThinking toggle is on */}
                {showThinking && thinkingContent && (
                  <div style={{ padding: '8px 12px', backgroundColor: 'var(--tf-bg)', borderRadius: '8px', marginBottom: '4px', borderLeft: '2px solid var(--tf-border)' }}>
                    <p style={{ color: 'var(--tf-text-muted)', fontSize: '11px', fontStyle: 'italic' }}>{thinkingContent}</p>
                  </div>
                )}
                <MessageBubble
                  message={{
                    role: 'ceo',
                    content: streamingContent,
                    timestamp: new Date().toISOString(),
                  }}
                  isStreaming
                  ceoName={ceoName}
                  userName={userName}
                />
              </>
            )}

            {/* Waiting indicator (before first chunk arrives) */}
            {isWaiting && !streamingContent && (
              <>
                {/* Thinking display during wait — always shown when thinkingContent is non-empty */}
                {thinkingContent && (
                  <div style={{ padding: '8px 12px', backgroundColor: 'var(--tf-bg)', borderRadius: '8px', marginBottom: '4px', borderLeft: '2px solid var(--tf-border)' }}>
                    <p style={{ color: 'var(--tf-text-muted)', fontSize: '11px', fontStyle: 'italic' }}>{thinkingContent}</p>
                  </div>
                )}
                <div className="flex justify-start mb-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2"
                    style={{ backgroundColor: 'var(--tf-accent)', color: 'var(--tf-bg)' }}
                  >
                    {ceoName.charAt(0).toUpperCase()}
                  </div>
                  <div
                    className="rounded-2xl px-4 py-3"
                    style={{ backgroundColor: 'var(--tf-surface-raised)', borderBottomLeftRadius: '4px' }}
                  >
                    <div className="flex gap-1.5">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="w-2 h-2 rounded-full animate-pulse-dot"
                          style={{
                            backgroundColor: 'var(--tf-accent)',
                            animationDelay: `${i * 0.3}s`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}

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
          style={{
            backgroundColor: 'var(--tf-surface)',
            border: '1px solid var(--tf-border)',
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isWaiting ? 'Waiting for response...' : `Message ${ceoName}...`}
            disabled={isWaiting}
            rows={1}
            className="w-full resize-none px-4 py-3 text-sm outline-none"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--tf-text)',
              maxHeight: '120px',
              minHeight: '44px',
            }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
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
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
            />
          </svg>
        </button>
      </div>

      {!floating && (
        <p className="text-xs mt-2 text-center" style={{ color: 'var(--tf-border)' }}>
          Press Enter to send, Shift+Enter for newline
        </p>
      )}
    </div>
  );
}
