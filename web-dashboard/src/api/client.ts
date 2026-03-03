import type {
  ApiResult,
  Agent,
  Project,
  Task,
  Decision,
  ActivityEvent,
  ChatMessage,
  AppConfig,
  FeatureFlags,
  PlanningPacketStatus,
  RunControlResponse,
  RunLiveSnapshot,
  WorkforceLiveSnapshot,
  UpdateApplyResponse,
  UpdateStatusResponse,
  PagedActivityResponse,
  PrQualityProfileResponse,
  ContextPack,
  ReviewComment,
  ReviewSession,
} from '../types';

const BASE = '/api';
const FETCH_TIMEOUT_MS = 15_000;

function normalizeErrorDetail(payload: unknown, fallback = 'Request failed'): {
  detail: string;
  code?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { detail: fallback };
  }
  const raw = (payload as { detail?: unknown }).detail ?? payload;
  if (typeof raw === 'string' && raw.trim()) {
    return { detail: raw.trim() };
  }
  if (!raw || typeof raw !== 'object') {
    return { detail: fallback };
  }
  const message = String((raw as { message?: unknown }).message || '').trim();
  const code = String((raw as { code?: unknown }).code || '').trim();
  return {
    detail: message || fallback,
    ...(code ? { code } : {}),
  };
}

async function safeFetch<T>(url: string, fallback: T, options?: RequestInit): Promise<T> {
  const externalSignal = options?.signal;
  const restOptions: RequestInit = { ...(options ?? {}) };
  delete (restOptions as { signal?: AbortSignal }).signal;
  const controller = new AbortController();
  const abortForwarder = () => controller.abort();
  externalSignal?.addEventListener('abort', abortForwarder, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...restOptions, signal: controller.signal });
    if (!res.ok) return fallback;
    const data: T = await res.json();
    return data;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortForwarder);
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

async function safeMutateResult<T = Record<string, unknown>>(
  url: string,
  method: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      const normalized = normalizeErrorDetail(payload, `HTTP ${res.status}`);
      return {
        ok: false,
        status: res.status,
        detail: normalized.detail,
        ...(normalized.code ? { code: normalized.code } : {}),
      };
    }
    let data: T | undefined;
    try {
      data = await res.json() as T;
    } catch {
      data = undefined;
    }
    return {
      ok: true,
      status: res.status,
      data,
    };
  } catch {
    return { ok: false, status: 0, detail: 'Network error' };
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

export async function fetchProjectDetail(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<{ project: Project; tasks: Task[] }> {
  const fallback = { project: { id, name: '', status: '' }, tasks: [] };
  return safeFetch(`${BASE}/projects/${encodeURIComponent(id)}`, fallback, options);
}

export async function deleteProject(projectId: string): Promise<{
  ok: boolean;
  workspaceDeleted?: boolean;
  detail?: string;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      signal: controller.signal,
    });
    // Some deployments/proxies block DELETE; fall back to POST alias.
    if (res.status === 405 || res.status === 404) {
      res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/delete`, {
        method: 'POST',
        signal: controller.signal,
      });
    }
    // Last-resort compatibility for deployments that only allow POST on canonical resource path.
    if (res.status === 405 || res.status === 404) {
      res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete' }),
        signal: controller.signal,
      });
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const payload = await res.json();
        const value = payload && typeof payload === 'object' && 'detail' in payload
          ? (payload as { detail?: unknown }).detail
          : '';
        if (typeof value === 'string' && value.trim()) detail = value.trim();
      } catch {
        // keep fallback detail
      }
      return { ok: false, detail };
    }
    const payload = await res.json();
    const workspaceDeleted = Boolean(
      payload && typeof payload === 'object' && (payload as { workspace_deleted?: unknown }).workspace_deleted
    );
    const workspaceSkipReason = payload && typeof payload === 'object'
      ? String((payload as { workspace_skip_reason?: unknown }).workspace_skip_reason || '').trim()
      : '';
    return {
      ok: true,
      workspaceDeleted,
      detail: workspaceSkipReason || undefined,
    };
  } catch {
    return { ok: false, detail: 'Network error while deleting project.' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function updateProjectTags(projectId: string, tags: string[]): Promise<{
  ok: boolean;
  project?: Project;
  detail?: string;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const payload = await res.json();
        const value = payload && typeof payload === 'object' && 'detail' in payload
          ? (payload as { detail?: unknown }).detail
          : '';
        if (typeof value === 'string' && value.trim()) detail = value.trim();
      } catch {
        // keep fallback detail
      }
      return { ok: false, detail };
    }
    const payload = await res.json();
    const project = payload && typeof payload === 'object'
      ? (payload as { project?: Project }).project
      : undefined;
    return { ok: true, project };
  } catch {
    return { ok: false, detail: 'Network error while updating project tags.' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchProjectDecisions(id: string): Promise<Decision[]> {
  return safeFetch<Decision[]>(`${BASE}/projects/${encodeURIComponent(id)}/decisions`, []);
}

export async function fetchRecentActivity(limit = 50, offset = 0): Promise<ActivityEvent[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(Math.max(0, offset)),
  });
  return safeFetch<ActivityEvent[]>(`${BASE}/activity/recent?${params.toString()}`, []);
}

export async function fetchRecentActivityPagedV1(
  limit = 50,
  cursor = '',
): Promise<PagedActivityResponse> {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(500, Number(limit) || 50))),
  });
  const normalizedCursor = String(cursor || '').trim();
  if (normalizedCursor) {
    params.set('cursor', normalizedCursor);
  }
  return safeFetch<PagedActivityResponse>(
    `${BASE}/v1/activity/recent?${params.toString()}`,
    { status: 'error', events: [], next_cursor: '', total_estimate: 0 },
  );
}

export function emptyWorkforceLiveSnapshot(projectId = ''): WorkforceLiveSnapshot {
  return {
    status: 'ok',
    as_of: new Date(0).toISOString(),
    project_id: projectId || null,
    counts: {
      assigned: 0,
      working: 0,
      reporting: 0,
      blocked: 0,
    },
    workers: [],
  };
}

export async function fetchWorkforceLive(
  projectId = '',
  options?: { signal?: AbortSignal; include_assigned?: boolean; include_reporting?: boolean },
): Promise<WorkforceLiveSnapshot> {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', projectId);
  params.set('include_assigned', String(options?.include_assigned ?? true));
  params.set('include_reporting', String(options?.include_reporting ?? true));
  return safeFetch<WorkforceLiveSnapshot>(
    `${BASE}/workforce/live?${params.toString()}`,
    emptyWorkforceLiveSnapshot(projectId),
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export async function listRuns(params?: {
  project_id?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<{
  status: 'ok' | 'error';
  runs: Array<Record<string, unknown>>;
  next_cursor?: string;
  total_estimate?: number;
}> {
  const query = new URLSearchParams();
  if (params?.project_id) query.set('project_id', params.project_id);
  if (params?.status) query.set('status', params.status);
  query.set('limit', String(Math.max(1, Math.min(500, params?.limit ?? 50))));
  if (params?.cursor) query.set('cursor', params.cursor);
  return safeFetch(
    `${BASE}/v1/runs?${query.toString()}`,
    { status: 'error', runs: [] },
    params?.signal ? { signal: params.signal } : undefined,
  );
}

export async function fetchRunLive(runId: string, options?: { signal?: AbortSignal }): Promise<RunLiveSnapshot | null> {
  if (!runId.trim()) return null;
  return safeFetch<RunLiveSnapshot | null>(
    `${BASE}/v1/runs/${encodeURIComponent(runId)}/live`,
    null,
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export async function controlRun(
  runId: string,
  action: 'status' | 'retry_step' | 'cancel' | 'continue',
  step?: string,
  force = false,
): Promise<RunControlResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v1/runs/${encodeURIComponent(runId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...(step ? { step } : {}), ...(force ? { force: true } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { status: 'error' };
    }
    return await res.json() as RunControlResponse;
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createActivityStream(
  onMessage: (line: string) => void,
  handlers?: { onError?: () => void; onOpen?: () => void },
): EventSource {
  const es = new EventSource(`${BASE}/activity/stream`);
  es.onmessage = (evt) => {
    onMessage(evt.data);
  };
  es.onopen = () => {
    handlers?.onOpen?.();
  };
  es.onerror = () => {
    handlers?.onError?.();
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
    if (!res.ok) {
      console.warn(`[COMPaaS] Setup save failed: ${res.status} ${res.statusText}`);
    }
    return res.ok;
  } catch (err) {
    console.warn('[COMPaaS] Setup save error:', err);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function updateConfig(updates: Record<string, unknown>): Promise<boolean> {
  const result = await updateConfigResult(updates);
  return result.ok;
}

export async function updateConfigResult(updates: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
      signal: controller.signal,
    });
    if (!res.ok) {
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      const normalized = normalizeErrorDetail(payload, `HTTP ${res.status}`);
      return {
        ok: false,
        status: res.status,
        detail: normalized.detail,
        ...(normalized.code ? { code: normalized.code } : {}),
      };
    }
    let data: Record<string, unknown> | undefined;
    try {
      data = await res.json() as Record<string, unknown>;
    } catch {
      data = undefined;
    }
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: 0, detail: 'Network error' };
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
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    return {
      status: 'error',
      error: {
        status: 0,
        message: isTimeout
          ? 'Request timed out. The project may have been created — check the Projects list before retrying.'
          : 'Network error while creating project.',
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

// ---- Context packs ----

export async function listContextPacks(params?: {
  scope?: 'global' | 'project';
  project_id?: string;
  enabled?: boolean;
}): Promise<ContextPack[]> {
  const query = new URLSearchParams();
  if (params?.scope) query.set('scope', params.scope);
  if (params?.project_id) query.set('project_id', params.project_id);
  if (typeof params?.enabled === 'boolean') query.set('enabled', params.enabled ? 'true' : 'false');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const payload = await safeFetch<{ status: string; packs: ContextPack[] }>(
    `${V1}/context/packs${suffix}`,
    { status: 'error', packs: [] },
  );
  return Array.isArray(payload.packs) ? payload.packs : [];
}

export async function createContextPack(data: {
  scope: 'global' | 'project';
  project_id?: string;
  kind: 'product' | 'tech' | 'design' | 'ops' | 'constraints';
  title: string;
  content: string;
  enabled?: boolean;
  pinned?: boolean;
  source?: string;
}): Promise<ApiResult<{ status: string; pack?: ContextPack }>> {
  return safeMutateResult<{ status: string; pack?: ContextPack }>(
    `${V1}/context/packs`,
    'POST',
    data,
  );
}

export async function updateContextPack(
  packId: string,
  data: Partial<{
    kind: 'product' | 'tech' | 'design' | 'ops' | 'constraints';
    title: string;
    content: string;
    enabled: boolean;
    pinned: boolean;
    source: string;
  }>,
): Promise<ApiResult<{ status: string; pack?: ContextPack }>> {
  return safeMutateResult<{ status: string; pack?: ContextPack }>(
    `${V1}/context/packs/${encodeURIComponent(packId)}`,
    'PATCH',
    data,
  );
}

export async function deleteContextPack(packId: string): Promise<ApiResult<{ status: string; deleted?: boolean }>> {
  return safeMutateResult<{ status: string; deleted?: boolean }>(
    `${V1}/context/packs/${encodeURIComponent(packId)}`,
    'DELETE',
  );
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
  stripe_secret_key?: string;
  stripe_publishable_key?: string;
  stripe_webhook_secret?: string;
  stripe_price_basic?: string;
  stripe_price_pro?: string;
  stripe_verified?: boolean;
  stripe_verified_at?: string;
  stripe_last_error?: string;
  slack_token?: string;
  webhook_url?: string;
}): Promise<boolean> {
  const result = await saveIntegrationsResult(data);
  return result.ok;
}

export async function saveIntegrationsResult(data: {
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
  stripe_secret_key?: string;
  stripe_publishable_key?: string;
  stripe_webhook_secret?: string;
  stripe_price_basic?: string;
  stripe_price_pro?: string;
  stripe_verified?: boolean;
  stripe_verified_at?: string;
  stripe_last_error?: string;
  slack_token?: string;
  webhook_url?: string;
}): Promise<ApiResult<Record<string, unknown>>> {
  return safeMutateResult<Record<string, unknown>>(`${BASE}/integrations`, 'PATCH', data);
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

export async function fetchUpdateStatus(): Promise<UpdateStatusResponse | null> {
  const fallback: UpdateStatusResponse = {
    status: 'error',
    channel: 'release_tags',
    current_version: '',
    latest_version: '',
    update_available: false,
    dirty_repo: false,
    can_update: false,
    block_reason: 'Unable to fetch update status.',
  };
  const res = await safeFetch<UpdateStatusResponse>(`${V1}/update/status`, fallback);
  return res;
}

export async function checkForUpdates(): Promise<UpdateStatusResponse | null> {
  const fallback: UpdateStatusResponse = {
    status: 'error',
    channel: 'release_tags',
    current_version: '',
    latest_version: '',
    update_available: false,
    dirty_repo: false,
    can_update: false,
    block_reason: 'Unable to check updates.',
  };
  const res = await safeFetch<UpdateStatusResponse>(
    `${V1}/update/check`,
    fallback,
    { method: 'POST' },
  );
  return res;
}

export async function applyManualUpdate(version = ''): Promise<UpdateApplyResponse | null> {
  const fallback: UpdateApplyResponse = {
    status: 'error',
    channel: 'release_tags',
    from_version: '',
    to_version: '',
    update_applied: false,
    restart_required: false,
    dirty_repo: false,
    can_update: false,
    block_reason: 'Unable to apply update.',
    error: 'Unable to apply update.',
  };
  const res = await safeFetch<UpdateApplyResponse>(
    `${V1}/update/apply`,
    fallback,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    },
  );
  return res;
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

export async function fetchPrQualityProfile(): Promise<PrQualityProfileResponse> {
  return safeFetch<PrQualityProfileResponse>(
    `${V1}/github/pr-quality-profile`,
    { status: 'error', profile: 'balanced' },
  );
}

export async function updatePrQualityProfile(profile: 'strict' | 'balanced' | 'fast'): Promise<ApiResult<Record<string, unknown>>> {
  return safeMutateResult<Record<string, unknown>>(
    `${V1}/github/pr-quality-profile`,
    'PATCH',
    { profile },
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

export async function stripeVerifyIntegration(data: { secret_key?: string }): Promise<{
  ok: boolean;
  account?: Record<string, unknown>;
  message: string;
} | null> {
  return safeFetch(
    `${V1}/stripe/verify`,
    null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
}

export async function listReviewSessions(
  projectId: string,
  params?: { status?: string; cursor?: string; limit?: number },
): Promise<{ sessions: ReviewSession[]; next_cursor: string; total: number }> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.cursor) query.set('cursor', params.cursor);
  if (typeof params?.limit === 'number') query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const fallback = { status: 'error', sessions: [] as ReviewSession[], next_cursor: '', total: 0 };
  const res = await safeFetch<{ status: string; sessions: ReviewSession[]; next_cursor: string; total: number }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/reviews/sessions${suffix}`,
    fallback,
  );
  return {
    sessions: Array.isArray(res.sessions) ? res.sessions : [],
    next_cursor: typeof res.next_cursor === 'string' ? res.next_cursor : '',
    total: Number(res.total || 0) || 0,
  };
}

export async function createReviewSession(
  projectId: string,
  data: { deployment_url: string; run_id?: string; source?: string; created_by?: string },
): Promise<ApiResult<{ status: string; session?: ReviewSession }>> {
  return safeMutateResult<{ status: string; session?: ReviewSession }>(
    `${V1}/projects/${encodeURIComponent(projectId)}/reviews/sessions`,
    'POST',
    data,
  );
}

export async function fetchReviewSession(sessionId: string): Promise<{ session?: ReviewSession; comments: ReviewComment[]; project_id?: string }> {
  const res = await safeFetch<{ status: string; session?: ReviewSession; comments?: ReviewComment[]; project_id?: string }>(
    `${V1}/reviews/sessions/${encodeURIComponent(sessionId)}`,
    { status: 'error', comments: [] },
  );
  return {
    session: res.session,
    comments: Array.isArray(res.comments) ? res.comments : [],
    project_id: res.project_id,
  };
}

export async function addReviewComment(
  sessionId: string,
  data: {
    route?: string;
    element_hint?: string;
    note: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    status?: 'open' | 'resolved';
    author?: string;
    tags?: string[];
  },
): Promise<ApiResult<{ status: string; comment?: ReviewComment }>> {
  return safeMutateResult<{ status: string; comment?: ReviewComment }>(
    `${V1}/reviews/sessions/${encodeURIComponent(sessionId)}/comments`,
    'POST',
    data,
  );
}

export async function updateReviewComment(
  commentId: string,
  data: Partial<{
    status: 'open' | 'resolved';
    severity: 'low' | 'medium' | 'high' | 'critical';
    note: string;
    route: string;
    element_hint: string;
    tags: string[];
  }>,
): Promise<ApiResult<{ status: string; comment?: ReviewComment }>> {
  return safeMutateResult<{ status: string; comment?: ReviewComment }>(
    `${V1}/reviews/comments/${encodeURIComponent(commentId)}`,
    'PATCH',
    data,
  );
}

export async function fetchStripeBillingStatus(projectId: string): Promise<{
  status: string;
  project_id: string;
  artifact_exists: boolean;
  artifact_path: string;
  artifact_updated_at?: string;
  stripe_configured: boolean;
  stripe_verified: boolean;
  stripe_publishable_configured: boolean;
  stripe_last_error?: string;
  last_applied_at?: string;
  detected_stack?: string;
} | null> {
  return safeFetch(
    `${V1}/projects/${encodeURIComponent(projectId)}/billing/stripe/status`,
    null,
  );
}

export async function applyStripeBillingPack(
  projectId: string,
  data?: { scaffold_files?: boolean; sync_vercel_env?: boolean },
): Promise<ApiResult<{
  status: string;
  project_id: string;
  stack: string;
  artifact_path: string;
  scaffolded_files: string[];
}>> {
  return safeMutateResult(
    `${V1}/projects/${encodeURIComponent(projectId)}/billing/stripe/apply`,
    'POST',
    data || {},
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

export async function fetchProjectReleaseNotes(
  projectId: string,
  runId = '',
): Promise<{
  status: 'ok' | 'error';
  notes?: string;
  run_id?: string;
  summary?: string;
  timeline?: string[];
  run_commands?: string[];
}> {
  if (!projectId.trim()) return { status: 'error' };
  const params = new URLSearchParams();
  if (runId.trim()) params.set('run_id', runId.trim());
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return safeFetch(
    `${V1}/projects/${encodeURIComponent(projectId)}/release-notes${suffix}`,
    { status: 'error' },
  );
}
