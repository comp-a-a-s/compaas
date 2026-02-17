import { useState, useEffect, useCallback } from 'react';
import './App.css';

import Layout from './components/Layout';
import Overview from './components/Overview';
import AgentPanel from './components/AgentPanel';
import ProjectPanel from './components/ProjectPanel';
import ActivityPanel from './components/ActivityPanel';
import MetricsPanel from './components/MetricsPanel';

import {
  fetchAgents,
  fetchProjects,
  fetchProjectDetail,
  fetchTokenReport,
  fetchBudgets,
  fetchRecentActivity,
  createActivityStream,
} from './api/client';

import type { Agent, Project, Task, ActivityEvent, TokenReport, Budget } from './types';

const MAX_EVENTS = 200;
const POLL_INTERVAL_MS = 5000;

function parseActivityLine(line: string): ActivityEvent | null {
  if (!line || !line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as ActivityEvent;
    return parsed;
  } catch {
    // Try to parse as a simple text event: "timestamp | agent | action | detail"
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length >= 3) {
      return {
        timestamp: parts[0] || new Date().toISOString(),
        agent: parts[1] || 'System',
        action: parts[2] || 'EVENT',
        detail: parts[3] || line,
      };
    }
    return {
      timestamp: new Date().toISOString(),
      agent: 'System',
      action: 'EVENT',
      detail: line,
    };
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('overview');

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
    loadAgents();
    loadProjects();
    loadMetrics();

    // Also seed recent activity
    fetchRecentActivity(50).then((events) => {
      if (Array.isArray(events) && events.length > 0) {
        setActivityEvents((prev) => {
          const merged = [...events, ...prev];
          return merged.slice(0, MAX_EVENTS);
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
  }, [loadAgents, loadProjects, loadMetrics]);

  // ---- SSE activity stream ----
  useEffect(() => {
    let es: EventSource | null = null;

    try {
      es = createActivityStream((line: string) => {
        const event = parseActivityLine(line);
        if (!event) return;
        setActivityEvents((prev) => {
          const next = [event, ...prev];
          return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
        });
      });
    } catch {
      // SSE not available
    }

    return () => {
      es?.close();
    };
  }, []);

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

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {renderContent()}
    </Layout>
  );
}
