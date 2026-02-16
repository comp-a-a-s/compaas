import { useState, useEffect, useCallback } from 'react';
import './App.css';

import Layout from './components/Layout';
import OrgChart from './components/OrgChart';
import ProjectList from './components/ProjectList';
import TaskBoard from './components/TaskBoard';
import ActivityFeed, { parseEvent } from './components/ActivityFeed';
import type { ActivityEvent } from './components/ActivityFeed';
import TokenMetrics from './components/TokenMetrics';

import { fetchOrgChart, fetchProjects, fetchProjectDetail, fetchTokenReport, createActivityStream } from './api/client';
import type { Agent, Project, Task, TokenReport } from './types';

const MAX_EVENTS = 100;
const POLL_INTERVAL_MS = 5000;

function SectionCard({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`bg-gray-900 rounded-2xl border border-gray-800 p-5 ${className}`}>
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </section>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('overview');

  // Data state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [tokenReport, setTokenReport] = useState<TokenReport | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);

  // Loading state
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingTokens, setLoadingTokens] = useState(true);

  // Event ID counter
  const [eventIdCounter, setEventIdCounter] = useState(0);

  const loadAgents = useCallback(async () => {
    try {
      const data = await fetchOrgChart();
      setAgents(Array.isArray(data) ? data : []);
    } catch {
      // Backend may not be running — keep previous state silently
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchProjects();
      const list = Array.isArray(data) ? data : [];
      setProjects(list);
      // Load tasks for all projects
      setLoadingTasks(true);
      const taskResults = await Promise.allSettled(
        list.map((p) => fetchProjectDetail(p.id))
      );
      const merged: Task[] = [];
      taskResults.forEach((r) => {
        if (r.status === 'fulfilled' && r.value?.tasks) {
          merged.push(...r.value.tasks);
        }
      });
      setAllTasks(merged);
    } catch {
      // keep previous
    } finally {
      setLoadingProjects(false);
      setLoadingTasks(false);
    }
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      const data = await fetchTokenReport();
      setTokenReport(data);
    } catch {
      // endpoint may not exist
    } finally {
      setLoadingTokens(false);
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    loadAgents();
    loadProjects();
    loadTokens();

    const interval = setInterval(() => {
      loadAgents();
      loadProjects();
      loadTokens();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [loadAgents, loadProjects, loadTokens]);

  // SSE activity stream
  useEffect(() => {
    let es: EventSource | null = null;
    let counter = 0;

    try {
      es = createActivityStream((line: string) => {
        if (!line.trim()) return;
        counter += 1;
        const event = parseEvent(line, counter);
        setActivityEvents((prev) => {
          const next = [...prev, event];
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
        setEventIdCounter(counter);
      });
    } catch {
      // SSE not available
    }

    return () => {
      es?.close();
    };
  }, []);

  // Suppress unused warning for eventIdCounter
  void eventIdCounter;

  const renderOverview = () => (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Agents', value: loadingAgents ? '—' : agents.length.toString(), color: 'text-violet-400' },
          { label: 'Projects', value: loadingProjects ? '—' : projects.length.toString(), color: 'text-blue-400' },
          { label: 'Tasks', value: loadingTasks ? '—' : allTasks.length.toString(), color: 'text-green-400' },
          { label: 'Live Events', value: activityEvents.length.toString(), color: 'text-orange-400' },
        ].map((stat) => (
          <div key={stat.label} className="bg-gray-800 border border-gray-700 rounded-xl p-4">
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">{stat.label}</p>
            <p className={`text-3xl font-bold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Org Chart */}
      <SectionCard title="Organization — AI Agents">
        <OrgChart agents={agents} loading={loadingAgents} />
      </SectionCard>

      {/* Projects + Tasks */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SectionCard title="Projects">
          <ProjectList projects={projects} loading={loadingProjects} />
        </SectionCard>
        <SectionCard title="Task Board">
          <TaskBoard tasks={allTasks} loading={loadingTasks} />
        </SectionCard>
      </div>

      {/* Activity Feed */}
      <SectionCard title="Live Activity Feed">
        <ActivityFeed events={activityEvents} />
      </SectionCard>

      {/* Token Metrics */}
      <SectionCard title="Token Metrics">
        <TokenMetrics report={tokenReport} loading={loadingTokens} />
      </SectionCard>
    </div>
  );

  const renderProjects = () => (
    <div className="space-y-6">
      <SectionCard title="All Projects">
        <ProjectList projects={projects} loading={loadingProjects} />
      </SectionCard>
      <SectionCard title="Task Board — All Projects">
        <TaskBoard tasks={allTasks} loading={loadingTasks} />
      </SectionCard>
    </div>
  );

  const renderAgents = () => (
    <SectionCard title="Organization Chart">
      <OrgChart agents={agents} loading={loadingAgents} />
    </SectionCard>
  );

  const renderTokens = () => (
    <div className="space-y-6">
      <SectionCard title="Token Usage Report">
        <TokenMetrics report={tokenReport} loading={loadingTokens} />
      </SectionCard>
      <SectionCard title="Live Activity Feed">
        <ActivityFeed events={activityEvents} />
      </SectionCard>
    </div>
  );

  const renderContent = () => {
    switch (activeTab) {
      case 'overview': return renderOverview();
      case 'projects': return renderProjects();
      case 'agents': return renderAgents();
      case 'tokens': return renderTokens();
      default: return renderOverview();
    }
  };

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {renderContent()}
    </Layout>
  );
}
