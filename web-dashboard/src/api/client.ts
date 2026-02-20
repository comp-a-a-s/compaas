import type { Agent, Project, Task, Decision, ActivityEvent, TokenReport, Budget, ChatMessage, AppConfig } from '../types';

const BASE = '/api';
const FETCH_TIMEOUT_MS = 15_000;

async function safeFetch<T>(url: string, fallback: T, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return fallback;
    const data: T = await res.json();
    return data;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Shared helper for POST/PATCH/DELETE mutations with timeout. Returns true on success. */
async function safeMutate(url: string, method: string, body?: unknown): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
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
  await safeMutate(`${BASE}/chat/history`, 'DELETE');
}

export function createChatWebSocket(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/api/chat/ws`);
}

export async function fetchConfig(): Promise<AppConfig | null> {
  return safeFetch<AppConfig | null>(`${BASE}/config`, null);
}

export async function saveSetupConfig(config: Partial<AppConfig>): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/config/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function updateConfig(updates: Record<string, unknown>): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchProjectSpecs(id: string): Promise<{ filename: string; content: string }[]> {
  return safeFetch(`${BASE}/projects/${encodeURIComponent(id)}/specs`, []);
}

export async function approveProjectPlan(id: string): Promise<boolean> {
  return safeMutate(`${BASE}/projects/${encodeURIComponent(id)}/approve`, 'POST');
}

export async function testLlmConnection(opts: {
  base_url: string;
  model: string;
  api_key: string;
}): Promise<{ status: 'ok' | 'error'; message: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * 2); // 30s for LLM test
  try {
    const res = await fetch(`${BASE}/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
      signal: controller.signal,
    });
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    return res.json();
  } catch (err) {
    return { status: 'error', message: String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- CEO Memory ----

export async function fetchMemory(): Promise<{ entries: string[]; raw: string }> {
  return safeFetch(`${BASE}/memory`, { entries: [], raw: '' });
}

export async function addMemory(entry: string): Promise<boolean> {
  return safeMutate(`${BASE}/memory`, 'POST', { entry });
}

export async function clearMemory(): Promise<boolean> {
  return safeMutate(`${BASE}/memory`, 'DELETE');
}

// ---- Context auto-summary ----

export async function summarizeChat(): Promise<{ status: 'ok' | 'error' | 'too_short'; messages_kept: number }> {
  const result = await safeFetch<{ status: 'ok' | 'error' | 'too_short'; messages_kept: number }>(
    `${BASE}/chat/summarize`,
    { status: 'error', messages_kept: 0 },
    { method: 'POST' },
  );
  return result;
}

// ---- Integrations ----

export async function saveIntegrations(data: {
  github_token?: string;
  github_repo?: string;
  github_default_branch?: string;
  github_auto_push?: boolean;
  github_auto_pr?: boolean;
  workspace_mode?: 'local' | 'github';
  vercel_token?: string;
  vercel_team_id?: string;
  vercel_project_name?: string;
  slack_token?: string;
  webhook_url?: string;
}): Promise<boolean> {
  return safeMutate(`${BASE}/integrations`, 'PATCH', data);
}
