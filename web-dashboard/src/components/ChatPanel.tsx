import { useState, useEffect, useRef, useCallback } from 'react';
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

// ---- Message bubble ----

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-slide-up`}
    >
      {/* CEO avatar */}
      {!isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2 mt-1"
          style={{ backgroundColor: '#cba6f7', color: '#11111b' }}
          title="Marcus (CEO)"
        >
          M
        </div>
      )}

      <div
        className="max-w-[75%] rounded-2xl px-4 py-2.5"
        style={{
          backgroundColor: isUser ? '#1e3a5f' : '#313244',
          borderBottomRightRadius: isUser ? '4px' : undefined,
          borderBottomLeftRadius: !isUser ? '4px' : undefined,
        }}
      >
        {/* Sender label */}
        <div className="flex items-center gap-2 mb-1">
          <span
            className="text-xs font-semibold"
            style={{ color: isUser ? '#89b4fa' : '#cba6f7' }}
          >
            {isUser ? 'You' : 'Marcus (CEO)'}
          </span>
          {message.timestamp && (
            <span className="text-xs" style={{ color: '#45475a' }}>
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
                    backgroundColor: '#cba6f7',
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ))}
            </span>
          )}
        </div>

        {/* Message content */}
        <p
          className="text-sm leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: '#cdd6f4' }}
        >
          {message.content || (isStreaming ? '' : '(empty response)')}
        </p>
      </div>

      {/* User avatar */}
      {isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ml-2 mt-1"
          style={{ backgroundColor: '#89b4fa', color: '#11111b' }}
          title="You (Idan)"
        >
          I
        </div>
      )}
    </div>
  );
}

// ---- Empty state ----

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 py-20">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{ backgroundColor: '#313244' }}
      >
        <svg
          className="w-8 h-8"
          style={{ color: '#cba6f7' }}
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
        <p className="text-sm font-medium" style={{ color: '#cdd6f4' }}>
          Chat with Marcus, the CEO
        </p>
        <p className="text-xs mt-1" style={{ color: '#6c7086' }}>
          Send a message to start a conversation. Marcus has full access
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
    connecting: { color: '#f9e2af', label: 'Connecting...' },
    connected: { color: '#a6e3a1', label: 'Connected' },
    disconnected: { color: '#6c7086', label: 'Disconnected' },
    error: { color: '#f38ba8', label: 'Error' },
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

export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
              setIsWaiting(false);
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
  };

  const hasMessages = messages.length > 0 || streamingContent;

  return (
    <div className="flex flex-col animate-fade-in" style={{ height: '100%', minHeight: '600px' }}>
      {/* Header bar */}
      <div className="flex items-center justify-between pb-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold"
            style={{ backgroundColor: '#cba6f7', color: '#11111b' }}
          >
            M
          </div>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#cdd6f4' }}>
              Marcus — CEO Chat
            </h3>
            <p className="text-xs" style={{ color: '#6c7086' }}>
              AI Virtual Company Orchestrator
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <StatusBadge status={connectionStatus} />
          {messages.length > 0 && (
            <button
              onClick={handleClear}
              className="text-xs px-2 py-1 rounded-lg transition-colors duration-200 cursor-pointer"
              style={{
                backgroundColor: '#313244',
                color: '#6c7086',
                border: '1px solid #45475a',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = '#f38ba8';
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#f38ba8';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = '#6c7086';
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#45475a';
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div
        className="flex-1 overflow-y-auto rounded-xl px-4 py-4"
        style={{
          backgroundColor: '#181825',
          border: '1px solid #45475a',
        }}
      >
        {!hasMessages ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble
                key={`${msg.timestamp}-${msg.role}-${i}`}
                message={msg}
              />
            ))}

            {/* Streaming response */}
            {streamingContent && (
              <MessageBubble
                message={{
                  role: 'ceo',
                  content: streamingContent,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming
              />
            )}

            {/* Waiting indicator (before first chunk arrives) */}
            {isWaiting && !streamingContent && (
              <div className="flex justify-start mb-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mr-2"
                  style={{ backgroundColor: '#cba6f7', color: '#11111b' }}
                >
                  M
                </div>
                <div
                  className="rounded-2xl px-4 py-3"
                  style={{ backgroundColor: '#313244', borderBottomLeftRadius: '4px' }}
                >
                  <div className="flex gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-2 h-2 rounded-full animate-pulse-dot"
                        style={{
                          backgroundColor: '#cba6f7',
                          animationDelay: `${i * 0.3}s`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} className="h-1" />
          </>
        )}
      </div>

      {/* Input area */}
      <div
        className="flex items-end gap-3 mt-3 flex-shrink-0"
      >
        <div
          className="flex-1 rounded-xl overflow-hidden"
          style={{
            backgroundColor: '#181825',
            border: '1px solid #45475a',
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isWaiting ? 'Waiting for response...' : 'Message Marcus (CEO)...'}
            disabled={isWaiting}
            rows={1}
            className="w-full resize-none px-4 py-3 text-sm outline-none"
            style={{
              backgroundColor: 'transparent',
              color: '#cdd6f4',
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
            backgroundColor: isWaiting || !input.trim() ? '#313244' : '#cba6f7',
            color: isWaiting || !input.trim() ? '#45475a' : '#11111b',
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

      <p className="text-xs mt-2 text-center" style={{ color: '#45475a' }}>
        Press Enter to send, Shift+Enter for newline
      </p>
    </div>
  );
}
