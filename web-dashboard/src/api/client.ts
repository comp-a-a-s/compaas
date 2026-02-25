import type {
  Agent,
  Project,
  Task,
  Decision,
  ActivityEvent,
  ChatMessage,
  AppConfig,
  FeatureFlags,
  PlanningPacketStatus,
} from '../types';

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

export async function fetchRecentActivity(limit = 50): Promise<ActivityEvent[]> {
  return safeFetch<ActivityEvent[]>(`${BASE}/activity/recent?limit=${limit}`, []);
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

export async function fetchChatHistory(limit = 50, projectId = ''): Promise<ChatMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (projectId) params.set('project_id', projectId);
  return safeFetch<ChatMessage[]>(`${BASE}/chat/history?${params.toString()}`, []);
}

export async function clearChatHistory(projectId = ''): Promise<void> {
  const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  await safeMutate(`${BASE}/chat/history${suffix}`, 'DELETE');
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

export interface ApproveProjectPlanResult {
  ok: boolean;
  missing_items?: string[];
  summary?: string;
}

export async function approveProjectPlan(id: string): Promise<ApproveProjectPlanResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/projects/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const detail = (payload && typeof payload === 'object' && 'detail' in payload)
      ? (payload as { detail?: unknown }).detail
      : null;
    if (res.status === 409 && detail && typeof detail === 'object') {
      const d = detail as { missing_items?: unknown; summary?: unknown };
      return {
        ok: false,
        missing_items: Array.isArray(d.missing_items) ? d.missing_items.map(String) : [],
        summary: typeof d.summary === 'string' ? d.summary : 'Planning packet is incomplete.',
      };
    }
    return { ok: false, summary: `HTTP ${res.status}` };
  } catch {
    return { ok: false, summary: 'Network error while approving plan.' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function createProject(data: {
  name: string;
  description?: string;
  type?: string;
  delivery_mode?: 'local' | 'github';
  github_repo?: string;
  github_branch?: string;
  workspace_path?: string;
}): Promise<{
  status: 'ok' | 'error';
  project?: Project;
  plan_packet?: PlanningPacketStatus;
  error?: {
    status: number;
    code?: string;
    message: string;
    settings_target?: string;
  };
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail: unknown = null;
      try {
        detail = await res.json();
      } catch {
        detail = null;
      }
      let message = `HTTP ${res.status}`;
      let code = '';
      let settingsTarget = '';
      if (detail && typeof detail === 'object') {
        const detailPayload = ('detail' in detail ? (detail as { detail?: unknown }).detail : detail);
        if (typeof detailPayload === 'string') {
          message = detailPayload;
        } else if (detailPayload && typeof detailPayload === 'object') {
          const d = detailPayload as { message?: unknown; code?: unknown; settings_target?: unknown };
          if (typeof d.message === 'string' && d.message.trim()) message = d.message;
          if (typeof d.code === 'string') code = d.code;
          if (typeof d.settings_target === 'string') settingsTarget = d.settings_target;
        }
      }
      return {
        status: 'error',
        error: {
          status: res.status,
          code: code || undefined,
          message,
          settings_target: settingsTarget || undefined,
        },
      };
    }
    const payload = await res.json();
    return payload as { status: 'ok'; project?: Project; plan_packet?: PlanningPacketStatus };
  } catch {
    return {
      status: 'error',
      error: {
        status: 0,
        message: 'Network error while creating project.',
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
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

export async function fetchMemoryPolicy(): Promise<{ scope: 'global' | 'project' | 'session-only'; retention_days: number; auto_summary_every_messages: number } | null> {
  const res = await safeFetch<{ status: string; scope: 'global' | 'project' | 'session-only'; retention_days: number; auto_summary_every_messages: number } | null>(
    `${V1}/chat/memory-policy`,
    null,
  );
  return res;
}

export async function updateMemoryPolicy(data: {
  scope?: 'global' | 'project' | 'session-only';
  retention_days?: number;
  auto_summary_every_messages?: number;
}): Promise<boolean> {
  return safeMutate(`${V1}/chat/memory-policy`, 'PATCH', data);
}

// ---- Integrations ----

export async function saveIntegrations(data: {
  github_token?: string;
  github_repo?: string;
  github_default_branch?: string;
  github_auto_push?: boolean;
  github_auto_pr?: boolean;
  github_verified?: boolean;
  github_verified_at?: string;
  github_last_error?: string;
  workspace_mode?: 'local' | 'github';
  vercel_token?: string;
  vercel_team_id?: string;
  vercel_project_name?: string;
  vercel_default_target?: 'preview' | 'production';
  vercel_verified?: boolean;
  vercel_verified_at?: string;
  vercel_last_error?: string;
  slack_token?: string;
  webhook_url?: string;
}): Promise<boolean> {
  return safeMutate(`${BASE}/integrations`, 'PATCH', data);
}

export async function sendTelegramMessage(data: {
  token: string;
  chat_id: string;
  text: string;
}): Promise<boolean> {
  return safeMutate(`${BASE}/integrations/telegram/send`, 'POST', data);
}

export interface TelegramIncomingMessage {
  text: string;
  from: string;
  date: number;
  chat_id: string;
}

export async function pollTelegramMessages(token: string): Promise<TelegramIncomingMessage[]> {
  const res = await safeFetch<{ status: string; messages: TelegramIncomingMessage[] }>(
    `${BASE}/integrations/telegram/poll`,
    { status: 'error', messages: [] },
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
  );
  return res.messages ?? [];
}

// ---- V1 capabilities ----

const V1 = '/api/v1';

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  const res = await safeFetch<{ status: string; feature_flags: FeatureFlags }>(`${V1}/feature-flags`, { status: 'error', feature_flags: {} });
  return res.feature_flags ?? {};
}

export async function updateFeatureFlags(flags: Partial<FeatureFlags>): Promise<boolean> {
  return safeMutate(`${V1}/feature-flags`, 'PATCH', flags);
}

export async function fetchGithubRepos(token: string): Promise<Array<{ full_name: string; default_branch: string }>> {
  const res = await safeFetch<{ status: string; repos?: Array<{ full_name: string; default_branch: string }> }>(
    `${V1}/github/repos`,
    { status: 'error', repos: [] },
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
  );
  return Array.isArray(res.repos) ? res.repos : [];
}

export async function createGithubRepo(data: { token: string; name: string; private?: boolean; description?: string }): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/github/repo/create`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function githubSecretScan(repoPath: string): Promise<{ clean: boolean; findings: Array<Record<string, unknown>> }> {
  return safeFetch(
    `${V1}/github/prepush/scan`,
    { clean: true, findings: [] },
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_path: repoPath }) },
  );
}

export async function githubSync(repoPath: string, defaultBranch = 'master'): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/github/sync`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_path: repoPath, default_branch: defaultBranch }) },
  );
}

export async function githubDrift(repoPath: string, defaultBranch = 'master'): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/github/drift`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_path: repoPath, default_branch: defaultBranch }) },
  );
}

export async function githubRollback(repoPath: string, commitSha: string): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/github/rollback`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_path: repoPath, commit_sha: commitSha }) },
  );
}

export async function vercelLinkProject(data: { token: string; project_name: string; team_id?: string }): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/vercel/link`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function vercelDeploy(data: { token: string; project_name: string; team_id?: string; target: 'preview' | 'production'; git_source?: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/vercel/deploy`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function vercelAssignDomain(data: { token: string; project_name: string; domain: string; team_id?: string }): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/vercel/domain`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function vercelSetEnv(data: { token: string; project_name: string; key: string; value: string; target?: string[]; team_id?: string }): Promise<Record<string, unknown> | null> {
  return safeFetch<Record<string, unknown> | null>(
    `${V1}/vercel/env`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function githubVerifyIntegration(data: { token?: string; repo?: string }): Promise<{
  ok: boolean;
  account?: Record<string, unknown>;
  repo_ok?: boolean;
  message: string;
} | null> {
  return safeFetch(
    `${V1}/github/verify`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function vercelVerifyIntegration(data: { token?: string; project_name?: string; team_id?: string }): Promise<{
  ok: boolean;
  account?: Record<string, unknown>;
  project_ok?: boolean;
  message: string;
} | null> {
  return safeFetch(
    `${V1}/vercel/verify`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function deployProjectToVercel(projectId: string, target: 'preview' | 'production' = 'preview'): Promise<{
  ok: boolean;
  deployment_url?: string;
  target?: 'preview' | 'production';
  error?: {
    status: number;
    code?: string;
    message: string;
    settings_target?: string;
  };
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * 2);
  try {
    const res = await fetch(`${V1}/projects/${encodeURIComponent(projectId)}/deploy/vercel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail: unknown = null;
      try {
        detail = await res.json();
      } catch {
        detail = null;
      }
      let message = `HTTP ${res.status}`;
      let code = '';
      let settingsTarget = '';
      if (detail && typeof detail === 'object') {
        const payload = ('detail' in detail ? (detail as { detail?: unknown }).detail : detail);
        if (typeof payload === 'string') {
          message = payload;
        } else if (payload && typeof payload === 'object') {
          const d = payload as { message?: unknown; code?: unknown; settings_target?: unknown };
          if (typeof d.message === 'string' && d.message.trim()) message = d.message;
          if (typeof d.code === 'string') code = d.code;
          if (typeof d.settings_target === 'string') settingsTarget = d.settings_target;
        }
      }
      return {
        ok: false,
        error: {
          status: res.status,
          code: code || undefined,
          message,
          settings_target: settingsTarget || undefined,
        },
      };
    }
    const payload = await res.json() as { ok?: boolean; deployment_url?: string; target?: 'preview' | 'production' };
    return {
      ok: Boolean(payload.ok),
      deployment_url: payload.deployment_url,
      target: payload.target,
    };
  } catch {
    return {
      ok: false,
      error: {
        status: 0,
        message: 'Network error while deploying to Vercel.',
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
