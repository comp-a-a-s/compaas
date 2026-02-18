import type { Agent, Project, Task, Decision, ActivityEvent, TokenReport, Budget, ChatMessage, AppConfig } from '../types';

const BASE = '/api';

async function safeFetch<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url);
    if (!res.ok) return fallback;
    const data: T = await res.json();
    return data;
  } catch {
    return fallback;
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  return safeFetch<Agent[]>(`${BASE}/agents`, []);
}

export async function fetchAgentDetail(id: string): Promise<Agent | null> {
  return safeFetch<Agent | null>(`${BASE}/agents/${encodeURIComponent(id)}`, null);
}

export async function fetchProjects(): Promise<Project[]> {
  return safeFetch<Project[]>(`${BASE}/projects`, []);
}

export async function fetchProjectDetail(id: string): Promise<{ project: Project; tasks: Task[] }> {
  const fallback = { project: { id, name: '', status: '' }, tasks: [] };
  return safeFetch(`${BASE}/projects/${encodeURIComponent(id)}`, fallback);
}

export async function fetchProjectDecisions(id: string): Promise<Decision[]> {
  return safeFetch<Decision[]>(`${BASE}/projects/${encodeURIComponent(id)}/decisions`, []);
}

export async function fetchTaskBoard(id: string): Promise<Task[]> {
  return safeFetch<Task[]>(`${BASE}/tasks/${encodeURIComponent(id)}`, []);
}

export async function fetchTokenReport(): Promise<TokenReport | null> {
  return safeFetch<TokenReport | null>(`${BASE}/metrics/tokens`, null);
}

export async function fetchBudgets(): Promise<Budget[]> {
  return safeFetch<Budget[]>(`${BASE}/metrics/budgets`, []);
}

export async function fetchRecentActivity(limit = 50): Promise<ActivityEvent[]> {
  return safeFetch<ActivityEvent[]>(`${BASE}/activity/recent?limit=${limit}`, []);
}

export async function fetchOrgChart(): Promise<Agent[]> {
  return safeFetch<Agent[]>(`${BASE}/org-chart`, []);
}

export function createActivityStream(onMessage: (line: string) => void): EventSource {
  const es = new EventSource(`${BASE}/activity/stream`);
  es.onmessage = (evt) => {
    onMessage(evt.data);
  };
  es.onerror = () => {
    // silently ignore — SSE may not be available
  };
  return es;
}

export async function fetchChatHistory(limit = 50): Promise<ChatMessage[]> {
  return safeFetch<ChatMessage[]>(`${BASE}/chat/history?limit=${limit}`, []);
}

export async function clearChatHistory(): Promise<void> {
  try {
    await fetch(`${BASE}/chat/history`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

export function createChatWebSocket(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/api/chat/ws`);
}

export async function fetchConfig(): Promise<AppConfig | null> {
  return safeFetch<AppConfig | null>(`${BASE}/config`, null);
}

export async function saveSetupConfig(config: Partial<AppConfig>): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/config/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function updateConfig(updates: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function testLlmConnection(opts: {
  base_url: string;
  model: string;
  api_key: string;
}): Promise<{ status: 'ok' | 'error'; message: string }> {
  try {
    const res = await fetch(`${BASE}/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    return res.json();
  } catch (err) {
    return { status: 'error', message: String(err) };
  }
}
