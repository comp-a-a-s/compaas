import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';

import Layout from './components/Layout';
import Overview from './components/Overview';
import AgentPanel from './components/AgentPanel';
import ProjectPanel from './components/ProjectPanel';
import RunDrawer from './components/RunDrawer';
import RunStatusChip from './components/RunStatusChip';
const ActivityPanel = lazy(() => import('./components/ActivityPanel'));
const EventLogPanel = lazy(() => import('./components/MetricsPanel'));
const ChatPanel = lazy(() => import('./components/ChatPanel'));
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));
import Walkthrough from './components/Walkthrough';
import SetupWizard from './components/SetupWizard';
import CompassRoseLogo from './components/CompassRoseLogo';

import { useThemeInit } from './hooks/useTheme';
import { useKeyboardShortcuts, useShortcutsPanel, ShortcutsModal } from './hooks/useKeyboardShortcuts';

import {
  fetchAgents,
  fetchProjects,
  fetchProjectDetail,
  fetchRecentActivity,
  fetchRecentActivityPagedV1,
  createActivityStream,
  fetchConfig,
  createProject,
  fetchWorkforceLive,
  emptyWorkforceLiveSnapshot,
  fetchRunLive,
  listRuns,
  controlRun,
} from './api/client';

import type {
  Agent,
  Project,
  Task,
  ActivityEvent,
  ActivityStreamHealth,
  ActivityStreamSource,
  AppConfig,
  RunIncidentEvent,
  RunLiveSnapshot,
  RunStatusEvent,
  WorkforceLiveSnapshot,
} from './types';

const MAX_EVENTS = 5000;
const STREAM_HEALTH_DEGRADED_THRESHOLD = 1;
const STREAM_HEALTH_FALLBACK_THRESHOLD = 2;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 30000;
const TASK_POLL_MULTIPLIER = 3;
const MIN_TASK_POLL_INTERVAL_MS = 15000;
const WORKFORCE_STALE_MULTIPLIER = 3;
const WORKFORCE_STALE_MIN_MS = 15000;
const WORKFORCE_MAX_BACKOFF_MS = 60000;
const MICRO_PROJECT_MODE_KEY = 'compaas_micro_project_mode';
const ONBOARDING_TOUR_DONE_KEY = 'compaas_onboarding_tour_done';
const TELEGRAM_KEYS = {
  token: 'compaas_telegram_token',
  chatId: 'compaas_telegram_chatid',
  configured: 'compaas_telegram_configured',
  mirror: 'compaas_telegram_mirror_enabled',
} as const;

function readTelegramSnapshot(): { configured: boolean; mirrorEnabled: boolean } {
  try {
    const token = localStorage.getItem(TELEGRAM_KEYS.token) ?? '';
    const chatId = localStorage.getItem(TELEGRAM_KEYS.chatId) ?? '';
    const configured = localStorage.getItem(TELEGRAM_KEYS.configured) === 'true' && Boolean(token && chatId);
    const mirrorEnabled = configured && localStorage.getItem(TELEGRAM_KEYS.mirror) === 'true';
    return { configured, mirrorEnabled };
  } catch {
    return { configured: false, mirrorEnabled: false };
  }
}

const ONBOARDING_STEPS: Array<{ tab: string; title: string; body: string }> = [
  { tab: 'overview', title: 'Overview', body: 'Your command center. See team status, active agents, and project health at a glance.' },
  { tab: 'projects', title: 'Projects', body: 'Create and manage projects here. Each project gets its own task board, plan, and team.' },
  { tab: 'overview', title: 'CEO Chat', body: 'Talk to your AI CEO to delegate work. Ask it to build features, fix bugs, or plan projects.' },
  { tab: 'events', title: 'Event Log', body: 'Track everything happening under the hood. All agent actions, delegations, and results flow here.' },
  { tab: 'settings', title: 'Settings', body: 'Configure your AI providers, connect GitHub, and customize your workspace.' },
];

// Agent slug/name → display name for activity tagging (Map for O(1) exact lookups)
const AGENT_SLUG_MAP = new Map<string, string>([
  ['chief-researcher', 'Chief Researcher'],
  ['chief researcher', 'Chief Researcher'],
  ['vp-engineering', 'VP Engineering'],
  ['vp engineering', 'VP Engineering'],
  ['vp-product', 'Chief Product Officer'],
  ['vp product', 'Chief Product Officer'],
  ['lead-backend', 'Lead Backend'],
  ['lead backend', 'Lead Backend'],
  ['lead-frontend', 'Lead Frontend'],
  ['lead frontend', 'Lead Frontend'],
  ['lead-designer', 'Lead Designer'],
  ['lead designer', 'Lead Designer'],
  ['security-engineer', 'Security Engineer'],
  ['security engineer', 'Security Engineer'],
  ['data-engineer', 'Data Engineer'],
  ['data engineer', 'Data Engineer'],
  ['tech-writer', 'Tech Writer'],
  ['tech writer', 'Tech Writer'],
  ['qa-lead', 'QA Lead'],
  ['qa lead', 'QA Lead'],
  ['devops', 'DevOps'],
  ['marcus', 'CEO'],
  ['elena', 'CTO'],
  ['victor', 'Chief Researcher'],
  ['rachel', 'CISO'],
  ['jonathan', 'CFO'],
  ['olivia', 'Chief Product Officer'],
  ['david', 'VP Engineering'],
  ['james', 'Lead Backend'],
  ['priya', 'Lead Frontend'],
  ['lena', 'Lead Designer'],
  ['carlos', 'QA Lead'],
  ['nina', 'DevOps'],
  ['alex', 'Security Engineer'],
  ['maya', 'Data Engineer'],
  ['tom', 'Tech Writer'],
  ['ceo', 'CEO'],
  ['cto', 'CTO'],
  ['ciso', 'CISO'],
  ['cfo', 'CFO'],
]);

// Ordered list for partial-match fallback (longest patterns first to avoid false matches)
const AGENT_PARTIAL_PATTERNS: [string, string][] = [
  ['chief-researcher', 'Chief Researcher'],
  ['vp-engineering', 'VP Engineering'],
  ['vp-product', 'Chief Product Officer'],
  ['lead-backend', 'Lead Backend'],
  ['lead-frontend', 'Lead Frontend'],
  ['lead-designer', 'Lead Designer'],
  ['security-engineer', 'Security Engineer'],
  ['data-engineer', 'Data Engineer'],
  ['tech-writer', 'Tech Writer'],
  ['qa-lead', 'QA Lead'],
  ['devops', 'DevOps'],
  ['marcus', 'CEO'],
  ['elena', 'CTO'],
  ['victor', 'Chief Researcher'],
  ['rachel', 'CISO'],
  ['jonathan', 'CFO'],
  ['olivia', 'Chief Product Officer'],
  ['david', 'VP Engineering'],
  ['james', 'Lead Backend'],
  ['priya', 'Lead Frontend'],
  ['carlos', 'QA Lead'],
  ['nina', 'DevOps'],
  ['alex', 'Security Engineer'],
  ['maya', 'Data Engineer'],
  ['ceo', 'CEO'],
  ['cto', 'CTO'],
  ['ciso', 'CISO'],
  ['cfo', 'CFO'],
];

function normalizeAgent(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // O(1) exact match (handles both slug and space-separated forms)
  const exact = AGENT_SLUG_MAP.get(lower);
  if (exact) return exact;
  // Partial match as fallback (for raw text that contains the agent name)
  for (const [pattern, name] of AGENT_PARTIAL_PATTERNS) {
    if (lower.includes(pattern)) return name;
  }
  return raw;
}

function inferActionFromText(lower: string): string {
  if (lower.includes('error') || lower.includes('failed') || lower.includes('fail')) return 'ERROR';
  if (lower.includes('completed') || lower.includes('finished') || lower.includes('done')) return 'COMPLETED';
  if (lower.includes('started') || lower.includes('starting') || lower.includes('begin')) return 'STARTED';
  if (lower.includes('created') || lower.includes('creating')) return 'CREATED';
  if (lower.includes('updated') || lower.includes('updating')) return 'UPDATED';
  if (lower.includes('assigned') || lower.includes('assigning')) return 'ASSIGNED';
  if (lower.includes('blocked')) return 'BLOCKED';
  if (lower.includes('review')) return 'REVIEW';
  if (lower.includes('message') || lower.includes('chat') || lower.includes('respond')) return 'MESSAGE';
  return 'EVENT';
}

function inferAgentFromText(lower: string): string {
  for (const [pattern, name] of AGENT_PARTIAL_PATTERNS) {
    if (lower.includes(pattern)) return name;
  }
  return 'System';
}

function eventKey(evt: ActivityEvent): string {
  return `${evt.timestamp}|${evt.agent}|${evt.action}|${evt.project_id ?? ''}|${evt.detail ?? ''}`;
}

function parseActivityLine(line: string): ActivityEvent | null {
  if (!line || !line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as ActivityEvent;
    if (parsed.agent) {
      parsed.agent = normalizeAgent(parsed.agent);
    }
    return parsed;
  } catch {
    // Try pipe-delimited: "timestamp | agent | action | detail"
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length >= 3) {
      return {
        timestamp: parts[0] || new Date().toISOString(),
        agent: normalizeAgent(parts[1] || 'System'),
        action: parts[2] || 'EVENT',
        detail: parts[3] || line,
      };
    }
    // Fallback: infer from raw text content
    const lower = line.toLowerCase();
    return {
      timestamp: new Date().toISOString(),
      agent: inferAgentFromText(lower),
      action: inferActionFromText(lower),
      detail: line,
    };
  }
}

export default function App() {
  useThemeInit();

  const [activeTab, setActiveTab] = useState<string>('overview');
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');

  // Config / setup state
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);

  // Floating chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatHasUnread, setChatHasUnread] = useState(false);
  const [microProjectMode, setMicroProjectMode] = useState(() => {
    try {
      return localStorage.getItem(MICRO_PROJECT_MODE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [microToggleRequestToken, setMicroToggleRequestToken] = useState(0);
  const [telegramMirrorEnabled, setTelegramMirrorEnabled] = useState(() => readTelegramSnapshot().mirrorEnabled);
  const [activeRunId, setActiveRunId] = useState('');
  const [runLiveSnapshot, setRunLiveSnapshot] = useState<RunLiveSnapshot | null>(null);
  const [runStatusEvent, setRunStatusEvent] = useState<RunStatusEvent | null>(null);
  const [runIncidentEvent, setRunIncidentEvent] = useState<RunIncidentEvent | null>(null);
  const [runDrawerOpen, setRunDrawerOpen] = useState(false);
  const [runControlBusyAction, setRunControlBusyAction] = useState<'' | 'status' | 'retry_step' | 'cancel' | 'continue'>('');
  const [runControlMessage, setRunControlMessage] = useState('');

  // Create-project modal state
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectMode, setNewProjectMode] = useState<'local' | 'github'>('local');
  const [newProjectRepo, setNewProjectRepo] = useState('');
  const [newProjectBranch, setNewProjectBranch] = useState('master');
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState('');

  // Project navigation from CEO chat
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [settingsConnectorFocus, setSettingsConnectorFocus] = useState<'github' | 'vercel' | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  const navigateToProject = useCallback((projectId: string) => {
    setActiveTab('projects');
    setPendingProjectId(projectId);
    setActiveProjectId(projectId);
    setChatOpen(false);
  }, []);

  const handleActiveProjectChange = useCallback((projectId: string) => {
    setActiveProjectId(projectId);
  }, []);

  const openConnectorSetup = useCallback((connector: 'github' | 'vercel') => {
    setSettingsConnectorFocus(connector);
    setActiveTab('settings');
    setChatOpen(false);
  }, []);

  const requestMicroToggle = useCallback(() => {
    setMicroToggleRequestToken((prev) => prev + 1);
  }, []);

  const handleTelegramMirrorChange = useCallback((enabled: boolean) => {
    const snapshot = readTelegramSnapshot();
    const nextEnabled = enabled && snapshot.configured;
    setTelegramMirrorEnabled(nextEnabled);
    try {
      localStorage.setItem(TELEGRAM_KEYS.mirror, nextEnabled ? 'true' : 'false');
    } catch {
      // ignore localStorage failures
    }
  }, []);

  const handleToggleTelegramMirror = useCallback(() => {
    const snapshot = readTelegramSnapshot();
    if (!snapshot.configured) {
      setActiveTab('settings');
      setChatOpen(false);
      setTelegramMirrorEnabled(false);
      try {
        localStorage.setItem(TELEGRAM_KEYS.mirror, 'false');
      } catch {
        // ignore localStorage failures
      }
      return;
    }
    handleTelegramMirrorChange(!telegramMirrorEnabled);
  }, [handleTelegramMirrorChange, telegramMirrorEnabled]);

  // Shortcuts panel
  const { visible: shortcutsVisible, hide: hideShortcuts } = useShortcutsPanel();

  // Data state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({});
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  // Project-selection required modal for CEO chat
  const [showProjectRequired, setShowProjectRequired] = useState(false);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [liveEventsCount, setLiveEventsCount] = useState(0);
  const [activityStreamHealth, setActivityStreamHealth] = useState<ActivityStreamHealth>('live');
  const [activityStreamSource, setActivityStreamSource] = useState<ActivityStreamSource>('SSE');
  const [activityTotalEstimate, setActivityTotalEstimate] = useState(0);
  const [workforceLive, setWorkforceLive] = useState<WorkforceLiveSnapshot>(() => emptyWorkforceLiveSnapshot(''));

  // Loading states
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const previousTabRef = useRef<string>('overview');
  const loadProjectsInFlightRef = useRef<Promise<void> | null>(null);
  const pendingProjectLoadRef = useRef(false);
  const pendingProjectLoadWithTasksRef = useRef(false);
  const projectDetailAbortRef = useRef<AbortController | null>(null);
  const projectRefreshTimestampsRef = useRef<number[]>([]);
  const loadWorkforceInFlightRef = useRef<Promise<void> | null>(null);
  const pendingWorkforceLoadRef = useRef(false);
  const pendingWorkforceForceRef = useRef(false);
  const workforceAbortRef = useRef<AbortController | null>(null);
  const workforceFailureCountRef = useRef(0);
  const workforceNextAllowedAtRef = useRef(0);
  const workforceLastSuccessAtRef = useRef(0);
  const runLivePollAbortRef = useRef<AbortController | null>(null);
  const activityErrorCountRef = useRef(0);
  const fallbackPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activitySeenKeysRef = useRef<Set<string>>(new Set());

  // ---- Config check ----
  useEffect(() => {
    fetchConfig().then((cfg) => {
      setConfig(cfg);
      if (!cfg || !cfg.setup_complete) {
        setShowWizard(true);
      }
      setConfigLoading(false);
    }).catch(() => {
      setConfigLoading(false);
    });
  }, []);

  useEffect(() => {
    if (configLoading || showWizard) return;
    const toursEnabled = config?.feature_flags?.onboarding_tours !== false;
    if (!toursEnabled) return;
    try {
      if (localStorage.getItem(ONBOARDING_TOUR_DONE_KEY) === '1') return;
    } catch {
      // ignore localStorage access issues
    }
    setTourStep(0);
    setActiveTab(ONBOARDING_STEPS[0].tab);
    setTourOpen(true);
  }, [config?.feature_flags?.onboarding_tours, configLoading, showWizard]);

  const handleSetupComplete = useCallback(() => {
    setShowWizard(false);
    // Reload config
    fetchConfig().then((cfg) => {
      if (cfg) setConfig(cfg);
    });
  }, []);

  const pollIntervalMs = useMemo(() => {
    const configured = config?.ui?.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
    return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, configured));
  }, [config?.ui?.poll_interval_ms]);

  const runHeartbeatIntervalMs = useMemo(() => {
    const configured = Number(config?.ui?.run_heartbeat_seconds ?? 5);
    const seconds = Number.isFinite(configured) ? configured : 5;
    return Math.max(2000, Math.min(30000, Math.round(seconds * 1000)));
  }, [config?.ui?.run_heartbeat_seconds]);

  const activityFallbackEnabled = useMemo(() => (
    config?.ui?.activity_stream_fallback_enabled !== false
  ), [config?.ui?.activity_stream_fallback_enabled]);

  const activityFallbackMs = useMemo(() => {
    const configured = Number(config?.ui?.activity_stream_fallback_ms ?? 15000);
    const safe = Number.isFinite(configured) ? configured : 15000;
    return Math.max(5000, Math.min(120000, Math.round(safe)));
  }, [config?.ui?.activity_stream_fallback_ms]);

  const taskPollIntervalMs = useMemo(() => (
    Math.max(MIN_TASK_POLL_INTERVAL_MS, pollIntervalMs * TASK_POLL_MULTIPLIER)
  ), [pollIntervalMs]);

  // ---- Data loaders ----

  const loadAgents = useCallback(async () => {
    try {
      const data = await fetchAgents();
      if (Array.isArray(data)) setAgents(data);
    } catch {
      // backend may not be running — keep previous state
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  const loadProjects = useCallback(async (includeTasks: boolean = true) => {
    pendingProjectLoadRef.current = true;
    pendingProjectLoadWithTasksRef.current = pendingProjectLoadWithTasksRef.current || includeTasks;
    if (loadProjectsInFlightRef.current) {
      return loadProjectsInFlightRef.current;
    }

    const runner = (async () => {
      while (pendingProjectLoadRef.current) {
        const runIncludeTasks = pendingProjectLoadWithTasksRef.current;
        pendingProjectLoadRef.current = false;
        pendingProjectLoadWithTasksRef.current = false;
        try {
          const now = Date.now();
          const recent = projectRefreshTimestampsRef.current.filter((ts) => now - ts < 60_000);
          recent.push(now);
          projectRefreshTimestampsRef.current = recent;
          if (recent.length > 24) {
            console.warn('[COMPaaS] High /api/projects refresh rate detected', { countLastMinute: recent.length });
          }
          const projectList = await fetchProjects();
          const list = Array.isArray(projectList) ? projectList : [];
          setProjects(list);
          if (activeProjectId && !list.some((p) => p.id === activeProjectId)) {
            setActiveProjectId('');
          }

          if (runIncludeTasks) {
            // Fetch task details only when needed. Abort stale detail fetches on newer refreshes.
            projectDetailAbortRef.current?.abort();
            const controller = new AbortController();
            projectDetailAbortRef.current = controller;
            setLoadingTasks(true);

            const results = await Promise.allSettled(
              list.map((p) => (
                fetchProjectDetail(p.id, { signal: controller.signal })
                  .then((r) => ({ id: p.id, tasks: r.tasks ?? [] }))
              ))
            );
            if (!controller.signal.aborted) {
              const byProject: Record<string, Task[]> = {};
              const merged: Task[] = [];
              for (const result of results) {
                if (result.status === 'fulfilled') {
                  byProject[result.value.id] = result.value.tasks;
                  merged.push(...result.value.tasks);
                }
              }
              setTasksByProject(byProject);
              setAllTasks(merged);
            }
          }
        } catch {
          // keep previous
        } finally {
          setLoadingProjects(false);
          if (runIncludeTasks) {
            setLoadingTasks(false);
          }
        }
      }
    })().finally(() => {
      loadProjectsInFlightRef.current = null;
    });

    loadProjectsInFlightRef.current = runner;
    return runner;
  }, [activeProjectId]);

  const loadWorkforce = useCallback(async (force: boolean = false) => {
    pendingWorkforceLoadRef.current = true;
    pendingWorkforceForceRef.current = pendingWorkforceForceRef.current || force;
    if (loadWorkforceInFlightRef.current) {
      return loadWorkforceInFlightRef.current;
    }

    const runner = (async () => {
      while (pendingWorkforceLoadRef.current) {
        const runForce = pendingWorkforceForceRef.current;
        pendingWorkforceLoadRef.current = false;
        pendingWorkforceForceRef.current = false;
        const now = Date.now();
        if (!runForce && now < workforceNextAllowedAtRef.current) {
          continue;
        }
        try {
          workforceAbortRef.current?.abort();
          const controller = new AbortController();
          workforceAbortRef.current = controller;
          const snapshot = await fetchWorkforceLive(activeProjectId, { signal: controller.signal });
          if (!controller.signal.aborted) {
            const successAt = Date.now();
            workforceFailureCountRef.current = 0;
            workforceLastSuccessAtRef.current = successAt;
            workforceNextAllowedAtRef.current = successAt + pollIntervalMs;
            setWorkforceLive({
              ...snapshot,
              client_meta: {
                last_success_at: new Date(successAt).toISOString(),
                stale: false,
                failure_count: 0,
                next_retry_in_ms: pollIntervalMs,
                heartbeat_age_ms: 0,
              },
            });
          }
        } catch (err) {
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (!isAbort) {
            const failures = workforceFailureCountRef.current + 1;
            workforceFailureCountRef.current = failures;
            const nextRetryMs = Math.min(pollIntervalMs * Math.pow(2, Math.min(failures, 4)), WORKFORCE_MAX_BACKOFF_MS);
            const failedAt = Date.now();
            workforceNextAllowedAtRef.current = failedAt + nextRetryMs;
            const lastSuccessAt = workforceLastSuccessAtRef.current;
            const staleThresholdMs = Math.max(WORKFORCE_STALE_MIN_MS, pollIntervalMs * WORKFORCE_STALE_MULTIPLIER);
            const stale = !lastSuccessAt || (failedAt - lastSuccessAt) > staleThresholdMs;
            setWorkforceLive((prev) => {
              const base = stale ? emptyWorkforceLiveSnapshot(activeProjectId) : prev;
              return {
                ...base,
                client_meta: {
                  last_success_at: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : '',
                  stale,
                  failure_count: failures,
                  next_retry_in_ms: nextRetryMs,
                  heartbeat_age_ms: lastSuccessAt ? Math.max(0, failedAt - lastSuccessAt) : undefined,
                },
              };
            });
          }
        }
      }
    })().finally(() => {
      loadWorkforceInFlightRef.current = null;
    });

    loadWorkforceInFlightRef.current = runner;
    return runner;
  }, [activeProjectId, pollIntervalMs]);

  const applyRunLiveSnapshot = useCallback((snapshot: RunLiveSnapshot | null) => {
    if (!snapshot) return;
    setRunLiveSnapshot(snapshot);
    if (snapshot.run_status) {
      setRunStatusEvent(snapshot.run_status);
      if (snapshot.run_status.run_id) {
        setActiveRunId(snapshot.run_status.run_id);
      }
    }
    setRunIncidentEvent(snapshot.incident ?? null);
  }, []);

  const refreshRunLive = useCallback(async (runId: string) => {
    const normalized = runId.trim();
    if (!normalized) return;
    runLivePollAbortRef.current?.abort();
    const controller = new AbortController();
    runLivePollAbortRef.current = controller;
    const snapshot = await fetchRunLive(normalized, { signal: controller.signal });
    if (!controller.signal.aborted && snapshot) {
      applyRunLiveSnapshot(snapshot);
    }
  }, [applyRunLiveSnapshot]);

  const handleRunControl = useCallback(async (action: 'status' | 'retry_step' | 'cancel' | 'continue') => {
    const runId = activeRunId.trim();
    if (!runId || runControlBusyAction) return;
    setRunControlBusyAction(action);
    setRunControlMessage('');
    const response = await controlRun(runId, action, action === 'retry_step' ? 'watchdog retry' : undefined);
    setRunControlBusyAction('');
    if (response.status !== 'ok') {
      setRunControlMessage('Run control request failed.');
      return;
    }
    const ackMessage = response.run_control_ack?.message || 'Run control request completed.';
    setRunControlMessage(ackMessage);
    if (
      response.run
      && response.run_status
      && response.guardrails
      && response.workforce
    ) {
      applyRunLiveSnapshot({
        status: 'ok',
        run: response.run,
        run_status: response.run_status,
        guardrails: response.guardrails,
        workforce: response.workforce,
        incident: response.incident ?? null,
      });
    } else {
      void refreshRunLive(runId);
    }
  }, [activeRunId, applyRunLiveSnapshot, refreshRunLive, runControlBusyAction]);

  useEffect(() => () => {
    projectDetailAbortRef.current?.abort();
    workforceAbortRef.current?.abort();
    runLivePollAbortRef.current?.abort();
    if (fallbackPollTimerRef.current) {
      clearInterval(fallbackPollTimerRef.current);
      fallbackPollTimerRef.current = null;
    }
  }, []);

  const handleCreateProjectFromHeader = useCallback(() => {
    const defaultMode = config?.integrations?.workspace_mode === 'github' ? 'github' : 'local';
    setNewProjectName(`Project ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
    setNewProjectMode(defaultMode === 'github' ? 'github' : 'local');
    setNewProjectRepo(config?.integrations?.github_repo?.trim() || '');
    setNewProjectBranch(config?.integrations?.github_default_branch?.trim() || 'master');
    setCreateProjectError('');
    setShowCreateProject(true);
  }, [config?.integrations?.workspace_mode, config?.integrations?.github_repo, config?.integrations?.github_default_branch]);

  const submitCreateProject = useCallback(async () => {
    if (!newProjectName.trim() || creatingProject) return;
    if (newProjectMode === 'github' && !newProjectRepo.trim()) {
      setCreateProjectError('GitHub mode requires a repository (owner/repo).');
      return;
    }
    setCreatingProject(true);
    setCreateProjectError('');
    const created = await createProject({
      name: newProjectName.trim(),
      description: `Created by ${config?.user?.name || 'Chairman'}.`,
      type: 'app',
      delivery_mode: newProjectMode,
      github_repo: newProjectMode === 'github' ? newProjectRepo : '',
      github_branch: newProjectMode === 'github' ? newProjectBranch : 'master',
    });
    setCreatingProject(false);
    if (created.status !== 'ok' || !created.project?.id) {
      if (created.error?.settings_target === 'github' || created.error?.code === 'github_not_configured') {
        setShowCreateProject(false);
        openConnectorSetup('github');
        return;
      }
      setCreateProjectError(created.error?.message || 'Unable to create project. Please try again.');
      return;
    }
    setCreateProjectError('');
    setNewProjectName('');
    setActiveProjectId(created.project.id);
    setShowCreateProject(false);
    setSettingsConnectorFocus(null);
    await loadProjects(true);
  }, [newProjectName, newProjectMode, newProjectRepo, newProjectBranch, creatingProject, config?.user?.name, loadProjects, openConnectorSetup]);

  // Metrics loading removed — replaced by Event Log panel that uses activityEvents directly
  const loadMetrics = useCallback(async () => { /* no-op */ }, []);

  const appendActivityEvents = useCallback((
    incoming: ActivityEvent[],
    source: ActivityStreamSource,
    totalEstimate?: number,
  ) => {
    if (!Array.isArray(incoming) || incoming.length === 0) {
      if (Number.isFinite(totalEstimate) && (totalEstimate ?? 0) > 0) {
        setActivityTotalEstimate((prev) => Math.max(prev, Number(totalEstimate)));
      }
      return;
    }
    setActivityEvents((prev) => {
      const seen = activitySeenKeysRef.current;
      if (prev.length === 0 && seen.size === 0) {
        // Keep the initial load stable and avoid repeated set churn.
        for (const event of incoming) {
          seen.add(eventKey(event));
        }
        const seeded = incoming.slice(-MAX_EVENTS);
        setLiveEventsCount((count) => Math.max(count, seeded.length));
        setActivityStreamSource(source);
        if (Number.isFinite(totalEstimate) && (totalEstimate ?? 0) > 0) {
          setActivityTotalEstimate((count) => Math.max(count, Number(totalEstimate)));
        }
        return seeded;
      }
      let added = 0;
      const next = [...prev];
      for (const event of incoming) {
        const key = eventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(event);
        added += 1;
      }
      if (added <= 0) {
        if (Number.isFinite(totalEstimate) && (totalEstimate ?? 0) > 0) {
          setActivityTotalEstimate((count) => Math.max(count, Number(totalEstimate)));
        }
        return prev;
      }
      const sliced = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      setLiveEventsCount((count) => count + added);
      setActivityStreamSource(source);
      if (Number.isFinite(totalEstimate) && (totalEstimate ?? 0) > 0) {
        setActivityTotalEstimate((count) => Math.max(count, Number(totalEstimate)));
      }
      return sliced;
    });
  }, []);

  const stopFallbackPolling = useCallback(() => {
    if (fallbackPollTimerRef.current) {
      clearInterval(fallbackPollTimerRef.current);
      fallbackPollTimerRef.current = null;
    }
  }, []);

  const refreshActivityFallback = useCallback(async () => {
    const paged = await fetchRecentActivityPagedV1(200);
    if (paged.status === 'ok') {
      appendActivityEvents(
        Array.isArray(paged.events) ? paged.events : [],
        'Poll',
        Number.isFinite(paged.total_estimate) ? paged.total_estimate : undefined,
      );
      setActivityStreamHealth('fallback_polling');
    }
  }, [appendActivityEvents]);

  const startFallbackPolling = useCallback(() => {
    if (!activityFallbackEnabled) return;
    if (fallbackPollTimerRef.current) return;
    setActivityStreamHealth('fallback_polling');
    void refreshActivityFallback();
    fallbackPollTimerRef.current = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshActivityFallback();
    }, activityFallbackMs);
  }, [activityFallbackEnabled, activityFallbackMs, refreshActivityFallback]);

  // ---- Initial load ----
  useEffect(() => {
    if (showWizard) return; // Don't load data while wizard is shown

    loadAgents();
    loadProjects(true);
    loadWorkforce(true);
    loadMetrics();

    // Seed activity from paged v1 endpoint first, fallback to legacy endpoint.
    fetchRecentActivityPagedV1(200).then((paged) => {
      if (paged.status === 'ok' && Array.isArray(paged.events)) {
        appendActivityEvents(
          paged.events,
          'Poll',
          Number.isFinite(paged.total_estimate) ? paged.total_estimate : undefined,
        );
        return;
      }
      throw new Error('v1 activity endpoint unavailable');
    }).catch(() => {
      fetchRecentActivity(200).then((fetched) => {
        if (Array.isArray(fetched) && fetched.length > 0) {
          appendActivityEvents(fetched, 'Poll');
        }
      }).catch(() => {
        // activity endpoint unavailable
      });
    });

  }, [appendActivityEvents, loadAgents, loadMetrics, loadProjects, loadWorkforce, showWizard]);

  // ---- Tab-aware polling ----
  useEffect(() => {
    if (showWizard) return;

    const shouldRefreshAgents = activeTab === 'overview' || activeTab === 'agents';
    const shouldRefreshMetrics = false; // metrics polling removed
    const shouldRefreshProjectSummaries =
      chatOpen || activeTab === 'overview' || activeTab === 'activity';
    const shouldRefreshWorkforce = true;

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (shouldRefreshAgents) loadAgents();
      if (shouldRefreshProjectSummaries) loadProjects(false);
      if (shouldRefreshWorkforce) loadWorkforce(false);
      if (shouldRefreshMetrics) loadMetrics();
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [activeTab, chatOpen, loadAgents, loadMetrics, loadProjects, loadWorkforce, pollIntervalMs, showWizard]);

  // Fast refresh after tab visibility returns
  useEffect(() => {
    if (showWizard) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (activeTab === 'overview' || activeTab === 'agents') {
        loadAgents();
      }
      if (chatOpen || activeTab === 'overview' || activeTab === 'activity') {
        loadProjects(false);
      }
      loadWorkforce(true);
      // metrics polling removed
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [activeTab, chatOpen, loadAgents, loadProjects, loadWorkforce, showWizard]);

  useEffect(() => {
    if (showWizard) return;
    workforceNextAllowedAtRef.current = 0;
    loadWorkforce(true);
  }, [activeProjectId, loadWorkforce, showWizard]);

  useEffect(() => {
    if (!activeRunId) return;
    const terminal = runStatusEvent
      ? ['done', 'failed', 'cancelled'].includes(String(runStatusEvent.state || '').toLowerCase())
      : false;
    void refreshRunLive(activeRunId);
    if (terminal) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshRunLive(activeRunId);
    }, runHeartbeatIntervalMs);
    return () => clearInterval(interval);
  }, [activeRunId, refreshRunLive, runHeartbeatIntervalMs, runStatusEvent]);

  useEffect(() => {
    if (showWizard) return;
    if (activeRunId) return;
    let cancelled = false;
    void listRuns({
      project_id: activeProjectId || '',
      limit: 40,
    }).then((result) => {
      if (cancelled) return;
      if (result.status !== 'ok' || !Array.isArray(result.runs)) return;
      const candidate = result.runs.find((run) => {
        if (!run || typeof run !== 'object') return false;
        const status = String((run as { status?: unknown }).status || '').toLowerCase();
        return status === 'queued' || status === 'planning' || status === 'executing' || status === 'verifying';
      }) as { id?: unknown } | undefined;
      const runId = String(candidate?.id || '').trim();
      if (!runId) return;
      setActiveRunId(runId);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProjectId, activeRunId, showWizard]);

  // Refresh detailed task boards only on project-focused views.
  useEffect(() => {
    const wasProjectTab = previousTabRef.current === 'projects';
    const isProjectTab = activeTab === 'projects';
    previousTabRef.current = activeTab;
    if (showWizard || !isProjectTab) return;

    // Initial data load already fetched tasks; refresh immediately only when returning to projects.
    if (!wasProjectTab) {
      loadProjects(true);
    }

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadProjects(true);
    }, taskPollIntervalMs);
    return () => clearInterval(interval);
  }, [activeTab, loadProjects, showWizard, taskPollIntervalMs]);

  // ---- Debounced project refresh on activity events ----
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkforceRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefreshProjects = useCallback(() => {
    if (pendingRefreshRef.current) return; // already scheduled
    pendingRefreshRef.current = setTimeout(() => {
      pendingRefreshRef.current = null;
      loadProjects(true);
    }, 2000);
  }, [loadProjects]);
  const requestWorkforceRefresh = useCallback((delayMs: number = 300) => {
    if (pendingWorkforceRefreshRef.current) return;
    pendingWorkforceRefreshRef.current = setTimeout(() => {
      pendingWorkforceRefreshRef.current = null;
      loadWorkforce(true);
    }, Math.max(100, delayMs));
  }, [loadWorkforce]);
  const handleAgentActivity = useCallback((agentId: string, task: string, flow: 'down' | 'up' | 'working') => {
    void agentId;
    void task;
    void flow;
    requestWorkforceRefresh(120);
  }, [requestWorkforceRefresh]);

  const removeLiveAgent = useCallback((agentId: string) => {
    void agentId;
    requestWorkforceRefresh(120);
  }, [requestWorkforceRefresh]);

  // ---- SSE activity stream ----
  useEffect(() => {
    if (showWizard) return;

    let es: EventSource | null = null;

    const handleParsedEvent = (event: ActivityEvent) => {
      appendActivityEvents([event], 'SSE');

      // Extract agent activity for TeamPulse + org chart from SSE events
      const meta = (event.metadata || {}) as Record<string, unknown>;
      const flow = String(meta.flow || '').toLowerCase();
      const source = String(meta.source_agent || '').trim().toLowerCase();
      const target = String(meta.target_agent || '').trim().toLowerCase();
      const eventAgent = String(event.agent || '').trim().toLowerCase();
      const task = String(meta.task || event.detail || '').trim();
      const action = (event.action || '').toUpperCase();
      const state = String(meta.state || '').toLowerCase();

      // Normalize agent key to canonical slug format (spaces → dashes)
      const toSlug = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '-');

      // Resolve the affected non-CEO agent from metadata (prefer target for
      // downward flow, source for upward) with eventAgent as last resort.
      const agentDown = (target && target !== 'ceo') ? toSlug(target) : '';
      const agentUp = (source && source !== 'ceo') ? toSlug(source) : '';
      const agentAny = agentDown || agentUp || (eventAgent && eventAgent !== 'ceo' ? toSlug(eventAgent) : '');

      // Each event should produce exactly ONE handleAgentActivity call to
      // avoid conflicting flow values when multiple conditions overlap.
      let handled = false;

      if (action === 'DELEGATED' && agentDown) {
        handleAgentActivity(agentDown, task, 'down');
        handled = true;
      } else if (action === 'STARTED' && agentAny) {
        handleAgentActivity(agentAny, task, 'working');
        handled = true;
      } else if ((action === 'COMPLETED' || action === 'FAILED' || state === 'completed' || state === 'failed') && agentAny) {
        handleAgentActivity(agentAny, task || 'Completed', 'up');
        handled = true;
      }

      // If no action-based match, fall back to metadata flow direction.
      if (!handled) {
        if (flow === 'down' && agentDown) {
          handleAgentActivity(agentDown, task, 'down');
        } else if (flow === 'up' && agentUp) {
          handleAgentActivity(agentUp, task, 'up');
        }
      }

      // Only hard-remove on explicit failure flow (timed-out delegations).
      if (flow === 'failed' && agentAny) {
        removeLiveAgent(agentAny);
      }

      // Trigger reactive project refresh on data-changing events.
      if (['COMPLETED', 'ASSIGNED', 'UPDATED', 'CREATED', 'STARTED', 'BLOCKED'].includes(action)) {
        debouncedRefreshProjects();
        requestWorkforceRefresh(180);
      }
    };

    try {
      es = createActivityStream((line: string) => {
        const event = parseActivityLine(line);
        if (!event) return;
        handleParsedEvent(event);
      }, {
        onOpen: () => {
          activityErrorCountRef.current = 0;
          setActivityStreamHealth('live');
          setActivityStreamSource('SSE');
          stopFallbackPolling();
        },
        onError: () => {
          activityErrorCountRef.current += 1;
          const failures = activityErrorCountRef.current;
          if (failures >= STREAM_HEALTH_FALLBACK_THRESHOLD) {
            startFallbackPolling();
            return;
          }
          if (failures >= STREAM_HEALTH_DEGRADED_THRESHOLD) {
            setActivityStreamHealth('degraded');
          }
        },
      });
    } catch {
      startFallbackPolling();
    }

    return () => {
      es?.close();
      stopFallbackPolling();
      activityErrorCountRef.current = 0;
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current);
        pendingRefreshRef.current = null;
      }
      if (pendingWorkforceRefreshRef.current) {
        clearTimeout(pendingWorkforceRefreshRef.current);
        pendingWorkforceRefreshRef.current = null;
      }
    };
  }, [
    appendActivityEvents,
    debouncedRefreshProjects,
    handleAgentActivity,
    removeLiveAgent,
    requestWorkforceRefresh,
    showWizard,
    startFallbackPolling,
    stopFallbackPolling,
  ]);

  // ---- Keyboard shortcuts ----
  const shortcuts = useMemo(() => ({
    '1': () => setActiveTab('overview'),
    '2': () => setActiveTab('agents'),
    '3': () => setActiveTab('projects'),
    '4': () => setActiveTab('activity'),
    '5': () => setActiveTab('events'),
    '6': () => setActiveTab('settings'),
    'c': () => setChatOpen((prev) => {
      const next = !prev;
      if (next) setChatHasUnread(false);
      return next;
    }),
  }), []);

  useKeyboardShortcuts(shortcuts);

  // Must be declared before any early returns to satisfy Rules of Hooks
  const pendingApprovalProjects = useMemo(() => {
    if (!activeProjectId) return [];
    return projects.filter(
      (project) =>
        project.id === activeProjectId
        && project.plan_approved !== true
        && project.status === 'planning'
        && Boolean(project.plan_packet?.ready)
    );
  }, [projects, activeProjectId]);
  const handleConfigUpdated = useCallback(() => {
    loadAgents();
    fetchConfig().then((cfg) => {
      if (cfg) setConfig(cfg);
    });
  }, [loadAgents]);

  useEffect(() => {
    try {
      localStorage.setItem(MICRO_PROJECT_MODE_KEY, microProjectMode ? 'true' : 'false');
    } catch {
      // ignore localStorage failures
    }
  }, [microProjectMode]);

  useEffect(() => {
    try {
      localStorage.setItem(TELEGRAM_KEYS.mirror, telegramMirrorEnabled ? 'true' : 'false');
    } catch {
      // ignore localStorage failures
    }
  }, [telegramMirrorEnabled]);

  useEffect(() => {
    const syncTelegram = () => {
      setTelegramMirrorEnabled(readTelegramSnapshot().mirrorEnabled);
    };
    syncTelegram();
    window.addEventListener('storage', syncTelegram);
    window.addEventListener('focus', syncTelegram);
    return () => {
      window.removeEventListener('storage', syncTelegram);
      window.removeEventListener('focus', syncTelegram);
    };
  }, []);

  const normalizedSearch = globalSearchQuery.trim().toLowerCase();

  const filteredProjects = useMemo(() => {
    if (!normalizedSearch) return projects;
    return projects.filter((p) => {
      const hay = `${p.name} ${p.description ?? ''} ${p.type ?? ''} ${p.status ?? ''} ${(p.tags ?? []).join(' ')}`.toLowerCase();
      return hay.includes(normalizedSearch);
    });
  }, [projects, normalizedSearch]);

  const filteredTasksByProject = useMemo(() => {
    if (!normalizedSearch) return tasksByProject;
    const next: Record<string, Task[]> = {};
    for (const [pid, tasks] of Object.entries(tasksByProject)) {
      next[pid] = tasks.filter((t) => {
        const hay = `${t.title} ${t.description ?? ''} ${t.assigned_to ?? ''} ${t.priority ?? ''} ${t.status ?? ''}`.toLowerCase();
        return hay.includes(normalizedSearch);
      });
    }
    return next;
  }, [tasksByProject, normalizedSearch]);

  const filteredAllTasks = useMemo(() => {
    if (!normalizedSearch) return allTasks;
    return allTasks.filter((t) => {
      const hay = `${t.title} ${t.description ?? ''} ${t.assigned_to ?? ''} ${t.priority ?? ''} ${t.status ?? ''}`.toLowerCase();
      return hay.includes(normalizedSearch);
    });
  }, [allTasks, normalizedSearch]);

  const filteredActivityEvents = useMemo(() => {
    if (!normalizedSearch) return activityEvents;
    return activityEvents.filter((evt) => {
      const hay = `${evt.agent ?? ''} ${evt.action ?? ''} ${evt.detail ?? ''} ${evt.project_id ?? ''}`.toLowerCase();
      return hay.includes(normalizedSearch);
    });
  }, [activityEvents, normalizedSearch]);

  const filteredAgents = useMemo(() => {
    if (!normalizedSearch) return agents;
    return agents.filter((a) => {
      const hay = `${a.name} ${a.role} ${a.model} ${a.status} ${a.team ?? ''}`.toLowerCase();
      return hay.includes(normalizedSearch);
    });
  }, [agents, normalizedSearch]);

  const handleRunStart = useCallback((runId: string, projectId: string) => {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    setActiveRunId(normalizedRunId);
    setRunControlMessage('');
    if (projectId && projectId !== activeProjectId) {
      setActiveProjectId(projectId);
    }
    void refreshRunLive(normalizedRunId);
  }, [activeProjectId, refreshRunLive]);

  const handleRunStatusEvent = useCallback((event: RunStatusEvent) => {
    setRunStatusEvent(event);
    setRunLiveSnapshot((prev) => {
      const sameRun = prev?.run?.id === event.run_id;
      return {
        status: 'ok',
        run: sameRun
          ? prev!.run
          : {
              id: event.run_id,
              project_id: event.project_id,
              status: event.state,
              timeline: [],
            },
        run_status: event,
        guardrails: sameRun && prev?.guardrails
          ? prev.guardrails
          : {
              command_budget_remaining: event.guardrails.command_budget_remaining,
              file_budget_remaining: event.guardrails.file_budget_remaining,
              runtime_budget_remaining: event.guardrails.runtime_budget_remaining,
              over_budget: event.guardrails.over_budget,
            },
        workforce: sameRun && prev?.workforce
          ? prev.workforce
          : emptyWorkforceLiveSnapshot(event.project_id),
        incident: sameRun ? (prev?.incident ?? null) : null,
      };
    });
    if (!activeRunId || activeRunId !== event.run_id) {
      setActiveRunId(event.run_id);
    }
    const state = String(event.state || '').toLowerCase();
    if (state === 'done' || state === 'failed' || state === 'cancelled') {
      setRunIncidentEvent(null);
    }
  }, [activeRunId]);

  const handleRunIncidentEvent = useCallback((event: RunIncidentEvent | null) => {
    setRunIncidentEvent(event);
    setRunLiveSnapshot((prev) => (prev ? { ...prev, incident: event } : prev));
    if (event?.run_id && event.run_id !== activeRunId) {
      setActiveRunId(event.run_id);
    }
  }, [activeRunId]);

  // ---- Loading / wizard screens ----

  if (configLoading) {
    return (
      <div
        className="flex items-center justify-center h-screen"
        style={{ backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text-muted)' }}
      >
        <div className="text-center">
          <div className="mx-auto mb-3" style={{ width: '40px' }}>
            <CompassRoseLogo size={40} />
          </div>
          <p className="text-sm">Loading COMPaaS...</p>
        </div>
      </div>
    );
  }

  if (showWizard) {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  // ---- Render ----

  const renderContent = () => {
    const content = (() => {
      switch (activeTab) {
        case 'overview':
          if (normalizedSearch && filteredProjects.length === 0 && filteredAgents.length === 0 && filteredAllTasks.length === 0) {
            return (
              <div className="rounded-xl p-6" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>No results</p>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                  No overview data matches "{globalSearchQuery}". Refine or clear the search query.
                </p>
              </div>
            );
          }
          return (
            <Overview
              agents={filteredAgents}
              projects={filteredProjects}
              tasks={filteredAllTasks}
              events={filteredActivityEvents}
              activeProjectId={activeProjectId}
              microProjectMode={microProjectMode}
              loadingAgents={loadingAgents}
              loadingProjects={loadingProjects}
              loadingTasks={loadingTasks}
              workforceLive={workforceLive}
            />
          );

        case 'agents':
          if (normalizedSearch && filteredAgents.length === 0) {
            return (
              <div className="rounded-xl p-6" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>No matching agents</p>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                  No agent matches "{globalSearchQuery}".
                </p>
              </div>
            );
          }
          return (
            <AgentPanel
              agents={filteredAgents}
              loading={loadingAgents}
              microProjectMode={microProjectMode}
              workforceLive={workforceLive}
            />
          );

        case 'projects':
          if (normalizedSearch && filteredProjects.length === 0) {
            return (
              <div className="rounded-xl p-6" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>No matching projects</p>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                  No project or task matches "{globalSearchQuery}".
                </p>
              </div>
            );
          }
          return (
            <ProjectPanel
              projects={filteredProjects}
              loading={loadingProjects}
              tasksByProject={filteredTasksByProject}
              initialProjectId={pendingProjectId}
              selectedProjectId={activeProjectId}
              onSelectProject={(projectId) => setActiveProjectId(projectId)}
              onProjectIdConsumed={() => setPendingProjectId(null)}
              onRefresh={loadProjects}
              defaultWorkspaceMode={config?.integrations?.workspace_mode === 'github' ? 'github' : 'local'}
              defaultGithubRepo={config?.integrations?.github_repo || ''}
              defaultGithubBranch={config?.integrations?.github_default_branch || 'master'}
              githubConfigured={githubConfigured}
              onProjectCreated={(projectId) => {
                setActiveProjectId(projectId);
                setPendingProjectId(projectId);
                loadProjects(true);
              }}
              onGitHubSetupRequired={() => openConnectorSetup('github')}
            />
          );

        case 'activity':
          if (normalizedSearch && filteredActivityEvents.length === 0) {
            return (
              <div className="rounded-xl p-6" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>No matching activity</p>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                  No activity entry matches "{globalSearchQuery}".
                </p>
              </div>
            );
          }
          return (
            <ActivityPanel
              events={filteredActivityEvents}
              streamHealth={activityStreamHealth}
              streamSource={activityStreamSource}
              totalEstimate={Math.max(activityTotalEstimate, liveEventsCount)}
            />
          );

        case 'events':
          return (
            <EventLogPanel
              events={filteredActivityEvents}
              streamHealth={activityStreamHealth}
              streamSource={activityStreamSource}
              totalEstimate={Math.max(activityTotalEstimate, liveEventsCount)}
            />
          );

        case 'settings':
          return (
            <SettingsPanel
              onConfigUpdated={handleConfigUpdated}
              initialTab={settingsConnectorFocus ? 'integrations' : 'general'}
              focusConnector={settingsConnectorFocus}
            />
          );

        default:
          return (
            <Overview
              agents={filteredAgents}
              projects={filteredProjects}
              tasks={filteredAllTasks}
              events={filteredActivityEvents}
              liveEventCount={Math.max(activityTotalEstimate, liveEventsCount, filteredActivityEvents.length)}
              streamSource={activityStreamSource}
              activeProjectId={activeProjectId}
              microProjectMode={microProjectMode}
              loadingAgents={loadingAgents}
              loadingProjects={loadingProjects}
              loadingTasks={loadingTasks}
              workforceLive={workforceLive}
            />
          );
      }
    })();
    return <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', color: 'var(--tf-text-muted)' }}>Loading…</div>}>{content}</Suspense>;
  };

  const ceoName = config?.agents?.['ceo'] || 'CEO';
  const userName = config?.user?.name || 'You';
  const telegramConfigured = readTelegramSnapshot().configured;
  const githubConfigured = Boolean(
    config?.integrations?.github_token
    && config?.integrations?.github_repo
    && config?.integrations?.github_verified
  );
  const currentTourStep = ONBOARDING_STEPS[Math.max(0, Math.min(tourStep, ONBOARDING_STEPS.length - 1))];
  // Inline-only progress mode: keep drawer surfaces disabled.
  const runDrawerEnabled = false;
  const effectiveRunStatus = runStatusEvent ?? runLiveSnapshot?.run_status ?? null;
  const effectiveRunIncident = runIncidentEvent ?? runLiveSnapshot?.incident ?? null;

  const finishTour = () => {
    setTourOpen(false);
    try {
      localStorage.setItem(ONBOARDING_TOUR_DONE_KEY, '1');
    } catch {
      // ignore storage failures
    }
  };

  return (
    <>
      <Layout
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          if (tab !== 'settings') {
            setSettingsConnectorFocus(null);
          }
        }}
        chatOpen={chatOpen}
        onChatToggle={() => {
          if (!chatOpen && !activeProjectId && projects.length > 0) {
            // Require project selection before opening CEO chat
            setShowProjectRequired(true);
            return;
          }
          setChatOpen((prev) => {
            const next = !prev;
            if (next) setChatHasUnread(false);
            return next;
          });
        }}
        chatHasUnread={chatHasUnread}
        ceoName={ceoName}
        pollIntervalMs={pollIntervalMs}
        microProjectMode={microProjectMode}
        globalSearchQuery={globalSearchQuery}
        onGlobalSearchQueryChange={setGlobalSearchQuery}
        projects={projects}
        activeProjectId={activeProjectId}
        onActiveProjectChange={handleActiveProjectChange}
        onCreateProjectRequest={() => { void handleCreateProjectFromHeader(); }}
        telegramMirrorEnabled={telegramMirrorEnabled}
        telegramConfigured={telegramConfigured}
        onToggleTelegramMirror={handleToggleTelegramMirror}
        onRequestMicroToggle={requestMicroToggle}
        agents={agents}
        workforceLive={workforceLive}
        runStatusChip={runDrawerEnabled ? (
          <RunStatusChip
            status={effectiveRunStatus}
            incident={effectiveRunIncident}
            open={runDrawerOpen}
            onToggle={() => setRunDrawerOpen((prev) => !prev)}
          />
        ) : null}
        runDrawer={runDrawerEnabled ? (
          <RunDrawer
            open={runDrawerOpen}
            snapshot={runLiveSnapshot}
            incident={effectiveRunIncident}
            controlBusyAction={runControlBusyAction}
            controlMessage={runControlMessage}
            onClose={() => setRunDrawerOpen(false)}
            onControl={(action) => { void handleRunControl(action); }}
          />
        ) : null}
        chatPanel={
          <Suspense fallback={null}>
            <ChatPanel
              floating
              chatOpen={chatOpen}
              onNewCeoMessage={() => {
                if (!chatOpen) setChatHasUnread(true);
              }}
              ceoName={ceoName}
              userName={userName}
              microProjectMode={microProjectMode}
              onMicroProjectModeChange={setMicroProjectMode}
              onNavigateToProject={navigateToProject}
              pendingApprovalProjects={pendingApprovalProjects}
              onProjectApproved={() => loadProjects()}
              projects={projects}
              activeProjectId={activeProjectId}
              onActiveProjectChange={handleActiveProjectChange}
              telegramMirrorEnabled={telegramMirrorEnabled}
              onTelegramMirrorChange={handleTelegramMirrorChange}
              microToggleRequestToken={microToggleRequestToken}
              onAgentActivity={handleAgentActivity}
              onAgentRemove={removeLiveAgent}
              onWorkforceRefreshRequest={() => requestWorkforceRefresh(120)}
              onProjectDataRefresh={() => {
                void loadProjects(true);
              }}
              onRunStart={handleRunStart}
              onRunStatus={handleRunStatusEvent}
              onRunIncident={handleRunIncidentEvent}
              runStatus={effectiveRunStatus}
              runIncident={effectiveRunIncident}
              onRunControl={(action) => { void handleRunControl(action); }}
              runControlBusyAction={runControlBusyAction}
              runControlMessage={runControlMessage}
              completionCelebrationEnabled={config?.ui?.completion_celebration_enabled !== false}
            />
          </Suspense>
        }
      >
        {renderContent()}
      </Layout>

      {/* Create Project Modal */}
      {showCreateProject && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
          }}
          onClick={() => setShowCreateProject(false)}
        >
          <div
            style={{
              width: 'min(400px, 90vw)',
              borderRadius: '12px',
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-surface)',
              boxShadow: '0 20px 45px rgba(0,0,0,0.4)',
              padding: '20px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--tf-text)', marginBottom: '16px' }}>
              Create New Project
            </h3>
            {/* Name */}
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--tf-text-secondary)', marginBottom: '5px' }}>
              Project Name
            </label>
            <input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void submitCreateProject(); }}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: '8px',
                border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)',
                color: 'var(--tf-text)', fontSize: '13px', outline: 'none', boxSizing: 'border-box',
                marginBottom: '14px',
              }}
            />
            {/* Location */}
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--tf-text-secondary)', marginBottom: '5px' }}>
              Location
            </label>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
              {(['local', 'github'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setNewProjectMode(mode)}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: '6px', padding: '8px', borderRadius: '8px', cursor: 'pointer',
                    border: `1px solid ${newProjectMode === mode ? 'var(--tf-accent)' : 'var(--tf-border)'}`,
                    backgroundColor: newProjectMode === mode ? 'rgba(168,131,255,0.1)' : 'var(--tf-surface-raised)',
                    color: newProjectMode === mode ? 'var(--tf-accent)' : 'var(--tf-text-secondary)',
                    fontSize: '12px', fontWeight: 500,
                  }}
                >
                  {mode === 'github' ? (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  )}
                  {mode === 'github' ? 'GitHub' : 'Local'}
                </button>
              ))}
            </div>
            {/* GitHub fields */}
            {newProjectMode === 'github' && (
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--tf-text-secondary)', marginBottom: '5px' }}>
                  Repository (owner/repo)
                </label>
                <input
                  value={newProjectRepo}
                  onChange={(e) => setNewProjectRepo(e.target.value)}
                  placeholder="owner/repo"
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: '8px',
                    border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)',
                    color: 'var(--tf-text)', fontSize: '13px', outline: 'none', boxSizing: 'border-box',
                    marginBottom: '8px',
                  }}
                />
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--tf-text-secondary)', marginBottom: '5px' }}>
                  Branch
                </label>
                <input
                  value={newProjectBranch}
                  onChange={(e) => setNewProjectBranch(e.target.value)}
                  placeholder="master"
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: '8px',
                    border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)',
                    color: 'var(--tf-text)', fontSize: '13px', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
            )}
            {/* Error message */}
            {createProjectError && (
              <p style={{ fontSize: '12px', color: 'var(--tf-error, #f87171)', margin: '0 0 10px 0' }}>
                {createProjectError}
              </p>
            )}
            {/* Buttons */}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowCreateProject(false)}
                style={{
                  padding: '7px 14px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  border: '1px solid var(--tf-border)', backgroundColor: 'transparent',
                  color: 'var(--tf-text-secondary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void submitCreateProject()}
                disabled={!newProjectName.trim() || creatingProject}
                style={{
                  padding: '7px 14px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  border: '1px solid var(--tf-accent)',
                  backgroundColor: !newProjectName.trim() ? 'var(--tf-surface-raised)' : 'var(--tf-accent)',
                  color: !newProjectName.trim() ? 'var(--tf-text-muted)' : 'var(--tf-bg)',
                  fontWeight: 600,
                  opacity: creatingProject ? 0.6 : 1,
                }}
              >
                {creatingProject ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {tourOpen && (
        <Walkthrough
          step={tourStep}
          totalSteps={ONBOARDING_STEPS.length}
          title={currentTourStep.title}
          body={currentTourStep.body}
          onNext={() => {
            const nextIndex = tourStep + 1;
            setTourStep(nextIndex);
            setActiveTab(ONBOARDING_STEPS[nextIndex].tab);
          }}
          onSkip={finishTour}
          onFinish={finishTour}
        />
      )}

      {/* Project selection required modal */}
      {showProjectRequired && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
          }}
          onClick={() => setShowProjectRequired(false)}
        >
          <div
            style={{
              width: 'min(380px, 90vw)',
              borderRadius: '12px',
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-surface)',
              boxShadow: '0 20px 45px rgba(0,0,0,0.4)',
              padding: '20px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--tf-text)', marginBottom: '8px' }}>
              Select a Project First
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--tf-text-secondary)', lineHeight: 1.5, marginBottom: '16px' }}>
              Choose an existing project or create a new one to start chatting with the CEO.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setActiveProjectId(p.id);
                    setShowProjectRequired(false);
                    setChatOpen(true);
                    setChatHasUnread(false);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '10px 12px', borderRadius: '8px', cursor: 'pointer',
                    border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)',
                    color: 'var(--tf-text)', fontSize: '13px', fontWeight: 500, textAlign: 'left',
                  }}
                >
                  <span style={{ flex: 1 }}>{p.name}</span>
                  <span style={{ fontSize: '11px', color: 'var(--tf-text-muted)' }}>{p.status}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowProjectRequired(false)}
                style={{
                  padding: '7px 14px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  border: '1px solid var(--tf-border)', backgroundColor: 'transparent',
                  color: 'var(--tf-text-muted)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowProjectRequired(false);
                  handleCreateProjectFromHeader();
                }}
                style={{
                  padding: '7px 14px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  border: '1px solid var(--tf-accent)', backgroundColor: 'var(--tf-accent)',
                  color: 'var(--tf-bg)', fontWeight: 600,
                }}
              >
                Create New Project
              </button>
            </div>
          </div>
        </div>
      )}
      {shortcutsVisible && <ShortcutsModal onClose={hideShortcuts} />}
    </>
  );
}
