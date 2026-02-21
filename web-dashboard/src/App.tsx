import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './App.css';

import Layout from './components/Layout';
import Overview from './components/Overview';
import AgentPanel from './components/AgentPanel';
import ProjectPanel from './components/ProjectPanel';
import ActivityPanel from './components/ActivityPanel';
import MetricsPanel from './components/MetricsPanel';
import ChatPanel from './components/ChatPanel';
import SetupWizard from './components/SetupWizard';
import SettingsPanel from './components/SettingsPanel';
import CompassRoseLogo from './components/CompassRoseLogo';

import { useThemeInit } from './hooks/useTheme';
import { useKeyboardShortcuts, useShortcutsPanel, ShortcutsModal } from './hooks/useKeyboardShortcuts';

import {
  fetchAgents,
  fetchProjects,
  fetchProjectDetail,
  fetchTokenReport,
  fetchBudgets,
  fetchRecentActivity,
  createActivityStream,
  fetchConfig,
} from './api/client';

import type { Agent, Project, Task, ActivityEvent, TokenReport, Budget, AppConfig } from './types';

const MAX_EVENTS = 200;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 30000;
const TASK_POLL_MULTIPLIER = 3;
const MIN_TASK_POLL_INTERVAL_MS = 15000;
const MICRO_PROJECT_MODE_KEY = 'compaas_micro_project_mode';

// Agent slug/name → display name for activity tagging (Map for O(1) exact lookups)
const AGENT_SLUG_MAP = new Map<string, string>([
  ['chief-researcher', 'Chief Researcher'],
  ['chief researcher', 'Chief Researcher'],
  ['vp-engineering', 'VP Engineering'],
  ['vp engineering', 'VP Engineering'],
  ['vp-product', 'VP Product'],
  ['vp product', 'VP Product'],
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
  ['sarah', 'VP Product'],
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
  ['vp-product', 'VP Product'],
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
  ['sarah', 'VP Product'],
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

  // Project navigation from CEO chat
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string>('');

  const navigateToProject = (projectId: string) => {
    setActiveTab('projects');
    setPendingProjectId(projectId);
    setActiveProjectId(projectId);
    setChatOpen(false);
  };

  // Shortcuts panel
  const { visible: shortcutsVisible, hide: hideShortcuts } = useShortcutsPanel();

  // Data state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({});
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [tokenReport, setTokenReport] = useState<TokenReport | null>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);

  // Loading states
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const previousTabRef = useRef<string>('overview');

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
    try {
      const projectList = await fetchProjects();
      const list = Array.isArray(projectList) ? projectList : [];
      setProjects(list);
      if (activeProjectId && !list.some((p) => p.id === activeProjectId)) {
        setActiveProjectId('');
      }

      if (includeTasks) {
        // Fetch task details only when needed to keep UI responsive on larger project sets.
        setLoadingTasks(true);
        const results = await Promise.allSettled(
          list.map((p) => fetchProjectDetail(p.id).then((r) => ({ id: p.id, tasks: r.tasks ?? [] })))
        );

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
    } catch {
      // keep previous
    } finally {
      setLoadingProjects(false);
      if (includeTasks) {
        setLoadingTasks(false);
      }
    }
  }, [activeProjectId]);

  const loadMetrics = useCallback(async () => {
    try {
      const [report, budgetList] = await Promise.allSettled([
        fetchTokenReport(),
        fetchBudgets(),
      ]);
      if (report.status === 'fulfilled') setTokenReport(report.value);
      if (budgetList.status === 'fulfilled') setBudgets(budgetList.value);
    } catch {
      // endpoint may not exist
    } finally {
      setLoadingMetrics(false);
    }
  }, []);

  // ---- Initial load ----
  useEffect(() => {
    if (showWizard) return; // Don't load data while wizard is shown

    loadAgents();
    loadProjects(true);
    loadMetrics();

    // Seed recent activity (deduplicated to avoid duplicates with SSE stream)
    fetchRecentActivity(50).then((fetched) => {
      if (Array.isArray(fetched) && fetched.length > 0) {
        setActivityEvents((prev) => {
          const seen = new Set(prev.map(eventKey));
          const newEvents = fetched.filter((e) => !seen.has(eventKey(e)));
          const merged = [...newEvents, ...prev].slice(0, MAX_EVENTS);
          return merged;
        });
      }
    }).catch(() => {
      // no recent activity endpoint
    });

  }, [loadAgents, loadMetrics, loadProjects, showWizard]);

  // ---- Tab-aware polling ----
  useEffect(() => {
    if (showWizard) return;

    const shouldRefreshAgents = activeTab === 'overview' || activeTab === 'agents';
    const shouldRefreshMetrics = activeTab === 'overview' || activeTab === 'metrics';
    const shouldRefreshProjectSummaries =
      chatOpen || activeTab === 'overview' || activeTab === 'projects' || activeTab === 'activity';

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (shouldRefreshAgents) loadAgents();
      if (shouldRefreshProjectSummaries) loadProjects(false);
      if (shouldRefreshMetrics) loadMetrics();
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [activeTab, chatOpen, loadAgents, loadMetrics, loadProjects, pollIntervalMs, showWizard]);

  // Fast refresh after tab visibility returns
  useEffect(() => {
    if (showWizard) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (activeTab === 'overview' || activeTab === 'agents') {
        loadAgents();
      }
      if (chatOpen || activeTab === 'overview' || activeTab === 'projects' || activeTab === 'activity') {
        loadProjects(false);
      }
      if (activeTab === 'overview' || activeTab === 'metrics') {
        loadMetrics();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [activeTab, chatOpen, loadAgents, loadProjects, loadMetrics, showWizard]);

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

  // ---- SSE activity stream ----
  useEffect(() => {
    if (showWizard) return;

    let es: EventSource | null = null;

    try {
      es = createActivityStream((line: string) => {
        const event = parseActivityLine(line);
        if (!event) return;
        setActivityEvents((prev) => {
          // Deduplicate: skip if identical event already present in last 10 entries
          const key = eventKey(event);
          const tail = prev.slice(-10);
          if (tail.some((e) => eventKey(e) === key)) return prev;
          const next = [...prev, event];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
      });
    } catch {
      // SSE not available
    }

    return () => {
      es?.close();
    };
  }, [showWizard]);

  // ---- Keyboard shortcuts ----
  const shortcuts = useMemo(() => ({
    '1': () => setActiveTab('overview'),
    '2': () => setActiveTab('agents'),
    '3': () => setActiveTab('projects'),
    '4': () => setActiveTab('activity'),
    '5': () => setActiveTab('metrics'),
    '6': () => setActiveTab('settings'),
    'c': () => setChatOpen((prev) => {
      const next = !prev;
      if (next) setChatHasUnread(false);
      return next;
    }),
  }), []);

  useKeyboardShortcuts(shortcuts);

  // Must be declared before any early returns to satisfy Rules of Hooks
  const pendingApprovalProjects = useMemo(
    () => projects.filter((p) => p.plan_approved !== true && p.status === 'planning'),
    [projects]
  );
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
    switch (activeTab) {
      case 'overview':
        return (
          <Overview
            agents={agents}
            projects={projects}
            tasks={allTasks}
            events={activityEvents}
            loadingAgents={loadingAgents}
            loadingProjects={loadingProjects}
            loadingTasks={loadingTasks}
          />
        );

      case 'agents':
        return (
          <AgentPanel
            agents={agents}
            loading={loadingAgents}
            microProjectMode={microProjectMode}
          />
        );

      case 'projects':
        return (
          <ProjectPanel
            projects={projects}
            loading={loadingProjects}
            tasksByProject={tasksByProject}
            initialProjectId={pendingProjectId}
            selectedProjectId={activeProjectId}
            onSelectProject={(projectId) => setActiveProjectId(projectId)}
            onProjectIdConsumed={() => setPendingProjectId(null)}
            onRefresh={loadProjects}
            onProjectCreated={(projectId) => {
              setActiveProjectId(projectId);
              setPendingProjectId(projectId);
              loadProjects(true);
            }}
          />
        );

      case 'activity':
        return (
          <ActivityPanel
            events={activityEvents}
          />
        );

      case 'metrics':
        return (
          <MetricsPanel
            tokenReport={tokenReport}
            budgets={budgets}
            loading={loadingMetrics}
          />
        );

      case 'settings':
        return <SettingsPanel onConfigUpdated={handleConfigUpdated} />;

      default:
        return (
          <Overview
            agents={agents}
            projects={projects}
            tasks={allTasks}
            events={activityEvents}
            loadingAgents={loadingAgents}
            loadingProjects={loadingProjects}
            loadingTasks={loadingTasks}
          />
        );
    }
  };

  const ceoName = config?.agents?.['ceo'] || 'CEO';
  const userName = config?.user?.name || 'You';

  return (
    <>
      <Layout
        activeTab={activeTab}
        onTabChange={setActiveTab}
        chatOpen={chatOpen}
        onChatToggle={() => {
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
        chatPanel={
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
            onNavigateToProjects={() => {
              setActiveTab('projects');
              setChatOpen(false);
            }}
            onNavigateToProject={navigateToProject}
            pendingApprovalProjects={pendingApprovalProjects}
            onProjectApproved={() => loadProjects()}
            projects={projects}
            activeProjectId={activeProjectId}
            onActiveProjectChange={(projectId) => setActiveProjectId(projectId)}
          />
        }
      >
        {renderContent()}
      </Layout>
      {shortcutsVisible && <ShortcutsModal onClose={hideShortcuts} />}
    </>
  );
}
