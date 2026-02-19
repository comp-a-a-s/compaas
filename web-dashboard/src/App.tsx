import { useState, useEffect, useCallback, useMemo } from 'react';
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
const POLL_INTERVAL_MS = 5000;

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
  return `${evt.timestamp}|${evt.agent}|${evt.action}`;
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

  // Project navigation from CEO chat
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const navigateToProject = (projectId: string) => {
    setActiveTab('projects');
    setPendingProjectId(projectId);
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

  const loadProjects = useCallback(async () => {
    try {
      const projectList = await fetchProjects();
      const list = Array.isArray(projectList) ? projectList : [];
      setProjects(list);

      // Fetch tasks for each project in parallel
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
    } catch {
      // keep previous
    } finally {
      setLoadingProjects(false);
      setLoadingTasks(false);
    }
  }, []);

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

  // ---- Initial load + polling ----
  useEffect(() => {
    if (showWizard) return; // Don't load data while wizard is shown

    loadAgents();
    loadProjects();
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

    const interval = setInterval(() => {
      loadAgents();
      loadProjects();
      loadMetrics();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [loadAgents, loadProjects, loadMetrics, showWizard]);

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

  // ---- Loading / wizard screens ----

  if (configLoading) {
    return (
      <div
        className="flex items-center justify-center h-screen"
        style={{ backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text-muted)' }}
      >
        <div className="text-center">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center mx-auto mb-3"
            style={{ backgroundColor: 'var(--tf-accent)' }}
          >
            <svg className="w-5 h-5" style={{ color: 'var(--tf-bg)' }} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p className="text-sm">Loading ThunderFlow...</p>
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
          />
        );

      case 'projects':
        return (
          <ProjectPanel
            projects={projects}
            loading={loadingProjects}
            tasksByProject={tasksByProject}
            initialProjectId={pendingProjectId}
            onProjectIdConsumed={() => setPendingProjectId(null)}
            onRefresh={loadProjects}
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
        return <SettingsPanel onConfigUpdated={() => { loadAgents(); }} />;

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

  // Projects waiting for chairman approval (planning state, not yet approved)
  const pendingApprovalProjects = useMemo(
    () => projects.filter((p) => p.plan_approved !== true && p.status === 'planning'),
    [projects]
  );

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
        chatPanel={
          <ChatPanel
            floating
            chatOpen={chatOpen}
            onNewCeoMessage={() => {
              if (!chatOpen) setChatHasUnread(true);
            }}
            ceoName={ceoName}
            userName={userName}
            onNavigateToProjects={() => {
              setActiveTab('projects');
              setChatOpen(false);
            }}
            onNavigateToProject={navigateToProject}
            pendingApprovalProjects={pendingApprovalProjects}
            onProjectApproved={() => loadProjects()}
          />
        }
      >
        {renderContent()}
      </Layout>
      {shortcutsVisible && <ShortcutsModal onClose={hideShortcuts} />}
    </>
  );
}
