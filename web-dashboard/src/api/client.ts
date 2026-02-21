import type {
  Agent,
  Project,
  Task,
  Decision,
  ActivityEvent,
  TokenReport,
  Budget,
  ChatMessage,
  AppConfig,
  ProjectMetadata,
  RunRecord,
  FeatureFlags,
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

export async function approveProjectPlan(id: string): Promise<boolean> {
  return safeMutate(`${BASE}/projects/${encodeURIComponent(id)}/approve`, 'POST');
}

export async function createProject(data: {
  name: string;
  description?: string;
  type?: string;
}): Promise<{ status: string; project?: Project } | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
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
  workspace_mode?: 'local' | 'github';
  vercel_token?: string;
  vercel_team_id?: string;
  vercel_project_name?: string;
  slack_token?: string;
  webhook_url?: string;
}): Promise<boolean> {
  return safeMutate(`${BASE}/integrations`, 'PATCH', data);
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

export async function fetchRuns(projectId = '', limit = 100): Promise<RunRecord[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (projectId) params.set('project_id', projectId);
  const res = await safeFetch<{ status: string; runs: RunRecord[] }>(`${V1}/runs?${params.toString()}`, { status: 'error', runs: [] });
  return Array.isArray(res.runs) ? res.runs : [];
}

export async function fetchRunReplay(runId: string): Promise<{ run_id: string; timeline: unknown[] } | null> {
  const res = await safeFetch<{ status: string; replay: { run_id: string; timeline: unknown[] } | null }>(
    `${V1}/runs/${encodeURIComponent(runId)}/replay`,
    { status: 'error', replay: null },
  );
  return res.replay ?? null;
}

export async function cancelRun(runId: string, reason = 'Cancelled by user'): Promise<boolean> {
  return safeMutate(`${V1}/runs/${encodeURIComponent(runId)}/cancel`, 'POST', { reason });
}

export async function retryRunStep(runId: string, step: string): Promise<boolean> {
  return safeMutate(`${V1}/runs/${encodeURIComponent(runId)}/retry-step`, 'POST', { step });
}

export async function fetchProjectMetadata(projectId: string): Promise<ProjectMetadata | null> {
  const res = await safeFetch<{ status: string; metadata: ProjectMetadata | null }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/metadata`,
    { status: 'error', metadata: null },
  );
  return res.metadata ?? null;
}

export async function updateProjectMetadata(projectId: string, updates: Record<string, unknown>): Promise<boolean> {
  return safeMutate(`${V1}/projects/${encodeURIComponent(projectId)}/metadata`, 'PATCH', updates);
}

export async function cloneProject(projectId: string, name = ''): Promise<Project | null> {
  const res = await safeFetch<{ status: string; project: Project | null }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/clone`,
    { status: 'error', project: null },
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
  );
  return res.project ?? null;
}

export async function archiveProject(projectId: string): Promise<boolean> {
  return safeMutate(`${V1}/projects/${encodeURIComponent(projectId)}/archive`, 'POST');
}

export async function restoreProject(projectId: string): Promise<boolean> {
  return safeMutate(`${V1}/projects/${encodeURIComponent(projectId)}/restore`, 'POST');
}

export async function fetchProjectDelta(projectId: string, since = ''): Promise<{ events: ActivityEvent[]; artifacts: unknown[] } | null> {
  const suffix = since ? `?since=${encodeURIComponent(since)}` : '';
  const res = await safeFetch<{ status: string; delta: { events: ActivityEvent[]; artifacts: unknown[] } | null }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/delta${suffix}`,
    { status: 'error', delta: null },
  );
  return res.delta ?? null;
}

export async function fetchProjectReadmeQuality(projectId: string): Promise<{ score: number; checks: Record<string, boolean> } | null> {
  const res = await safeFetch<{ status: string; report: { score: number; checks: Record<string, boolean> } | null }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/readme-quality`,
    { status: 'error', report: null },
  );
  return res.report ?? null;
}

export async function fetchProjectAnalyticsV1(projectId: string): Promise<Record<string, unknown> | null> {
  const res = await safeFetch<{ status: string; analytics: Record<string, unknown> | null }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/analytics`,
    { status: 'error', analytics: null },
  );
  return res.analytics ?? null;
}

export async function fetchProjectArtifacts(projectId: string): Promise<Array<Record<string, unknown>>> {
  const res = await safeFetch<{ status: string; artifacts: Array<Record<string, unknown>> }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/artifacts`,
    { status: 'error', artifacts: [] },
  );
  return Array.isArray(res.artifacts) ? res.artifacts : [];
}

export async function registerProjectArtifact(projectId: string, payload: {
  file_path: string;
  action: string;
  run_id?: string;
  agent?: string;
}): Promise<boolean> {
  return safeMutate(`${V1}/projects/${encodeURIComponent(projectId)}/artifacts`, 'POST', payload);
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
