import { useState, useEffect, useMemo } from 'react';
import type { Agent } from '../types';
import Tooltip from './Tooltip';

/** Info about an actively-working agent, maintained by App.tsx. */
export interface ActiveAgentInfo {
  agentId: string;
  task: string;
  since: string;
  flow: 'down' | 'up' | 'working';
}

interface TeamPulseProps {
  agents: Agent[];
  liveAgents: Map<string, ActiveAgentInfo>;
  isMobile?: boolean;
}

function modelColor(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('codex')) return 'var(--tf-success)';
  if (m.includes('opus')) return 'var(--tf-accent)';
  if (m.includes('sonnet')) return 'var(--tf-accent-blue)';
  if (m.includes('haiku')) return 'var(--tf-success)';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'var(--tf-accent-blue)';
  if (m.includes('llama') || m.includes('qwen') || m.includes('mistral') || m.includes('gemma')) return 'var(--tf-warning)';
  return 'var(--tf-text-secondary)';
}

function flowLabel(flow: string): string {
  if (flow === 'down') return 'Delegated';
  if (flow === 'up') return 'Reporting';
  return 'Working';
}

const MAX_VISIBLE = 6;

export default function TeamPulse({ agents, liveAgents, isMobile = false }: TeamPulseProps) {
  const [expanded, setExpanded] = useState(false);

  // Build list of active agents with their info
  const activeList = useMemo(() => {
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    const result: Array<{ agent: Agent; info: ActiveAgentInfo }> = [];
    for (const [rawId, info] of liveAgents) {
      // Normalize key: spaces → dashes to match agent.id format
      const slug = rawId.trim().toLowerCase().replace(/\s+/g, '-');
      const agent = agentMap.get(slug) || agentMap.get(rawId);
      if (agent) {
        result.push({ agent, info });
      }
    }
    // Sort: most recent first
    result.sort((a, b) => b.info.since.localeCompare(a.info.since));
    return result;
  }, [agents, liveAgents]);

  // Close expanded mobile sheet when no agents are active
  useEffect(() => {
    if (activeList.length !== 0 || !expanded) return;
    const timer = window.setTimeout(() => setExpanded(false), 0);
    return () => window.clearTimeout(timer);
  }, [activeList.length, expanded]);

  if (activeList.length === 0) return null;

  // Mobile: compact badge
  if (isMobile) {
    return (
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 cursor-pointer"
          style={{
            height: '28px',
            padding: '0 8px',
            borderRadius: '999px',
            border: '1px solid rgba(63,185,80,0.3)',
            backgroundColor: 'rgba(63,185,80,0.08)',
            color: 'var(--tf-success)',
            fontSize: '11px',
            fontWeight: 600,
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: 'var(--tf-success)',
              animation: 'pulse-ring 1.8s ease-out infinite',
            }}
          />
          {activeList.length} working
        </button>

        {expanded && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: '6px',
              minWidth: '200px',
              maxWidth: '280px',
              borderRadius: '10px',
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-surface)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              padding: '8px',
              zIndex: 50,
              animation: 'slide-up 0.15s ease-out both',
            }}
          >
            <p
              style={{
                fontSize: '10px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--tf-text-muted)',
                padding: '4px 6px',
                marginBottom: '4px',
              }}
            >
              Active Team
            </p>
            {activeList.map(({ agent, info }) => {
              const color = modelColor(agent.runtime_model || agent.model || '');
              return (
                <div
                  key={agent.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px',
                    borderRadius: '6px',
                  }}
                >
                  <div
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '50%',
                      backgroundColor: color,
                      color: 'var(--tf-bg)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '10px',
                      fontWeight: 700,
                      flexShrink: 0,
                      boxShadow: '0 0 0 2px var(--tf-success)',
                    }}
                  >
                    {agent.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--tf-text)' }}>
                      {agent.name}
                    </p>
                    <p
                      style={{
                        fontSize: '10px',
                        color: 'var(--tf-text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {info.task || flowLabel(info.flow)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Desktop: avatar row
  const visible = activeList.slice(0, MAX_VISIBLE);
  const overflow = activeList.length - MAX_VISIBLE;

  return (
    <div className="flex items-center gap-1" style={{ height: '34px' }}>
      {visible.map(({ agent, info }) => {
        const color = modelColor(agent.runtime_model || agent.model || '');
        const tooltipText = `${agent.name} — ${info.task || flowLabel(info.flow)}`;
        return (
          <Tooltip key={agent.id} content={tooltipText} position="bottom">
            <div
              className="team-pulse-avatar"
              style={{
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                backgroundColor: color,
                color: 'var(--tf-bg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '10px',
                fontWeight: 700,
                position: 'relative',
                cursor: 'default',
                animation: 'team-pulse-in 0.25s ease-out both',
              }}
            >
              {/* Pulse ring */}
              <div
                style={{
                  position: 'absolute',
                  inset: '-3px',
                  borderRadius: '50%',
                  border: '1.5px solid var(--tf-success)',
                  opacity: 0.7,
                  animation: 'pulse-ring 2s ease-out infinite',
                }}
              />
              {agent.name.charAt(0).toUpperCase()}
            </div>
          </Tooltip>
        );
      })}
      {overflow > 0 && (
        <Tooltip
          content={activeList.slice(MAX_VISIBLE).map(({ agent }) => agent.name).join(', ')}
          position="bottom"
        >
          <div
            style={{
              height: '22px',
              padding: '0 6px',
              borderRadius: '999px',
              backgroundColor: 'rgba(63,185,80,0.12)',
              color: 'var(--tf-success)',
              fontSize: '10px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              border: '1px solid rgba(63,185,80,0.25)',
            }}
          >
            +{overflow}
          </div>
        </Tooltip>
      )}
    </div>
  );
}
