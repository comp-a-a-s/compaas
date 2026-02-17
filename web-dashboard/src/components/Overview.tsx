import type { Agent, Project, Task, ActivityEvent } from '../types';

interface OverviewProps {
  agents: Agent[];
  projects: Project[];
  tasks: Task[];
  events: ActivityEvent[];
  loadingAgents: boolean;
  loadingProjects: boolean;
  loadingTasks: boolean;
}

// ---- Skeleton helper ----
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} style={{ height: '1rem' }} />;
}

// ---- Stat card ----
interface StatCardProps {
  label: string;
  value: string;
  color: string;
  loading: boolean;
}
function StatCard({ label, value, color, loading }: StatCardProps) {
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-1 animate-slide-up"
      style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
    >
      <p className="text-xs uppercase tracking-widest" style={{ color: '#6c7086' }}>
        {label}
      </p>
      {loading ? (
        <Skeleton className="w-12 h-8" />
      ) : (
        <p className="text-3xl font-bold" style={{ color }}>
          {value}
        </p>
      )}
    </div>
  );
}

// ---- Model color helper ----
function modelColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return '#cba6f7';
  if (m.includes('sonnet')) return '#89b4fa';
  if (m.includes('haiku')) return '#a6e3a1';
  return '#a6adc8';
}

// ---- Org hierarchy node ----
interface OrgNodeProps {
  agent: Agent;
}
function OrgNode({ agent }: OrgNodeProps) {
  const color = modelColor(agent.model);
  const initial = agent.name.charAt(0).toUpperCase();
  return (
    <div
      className="flex flex-col items-center gap-1 px-3 py-2 rounded-xl cursor-default"
      style={{ backgroundColor: '#313244', border: '1px solid #45475a', minWidth: '96px' }}
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
        style={{ backgroundColor: color, color: '#11111b' }}
      >
        {initial}
      </div>
      <p className="text-xs font-medium text-center leading-tight" style={{ color: '#cdd6f4' }}>
        {agent.name}
      </p>
      <p className="text-xs text-center leading-tight" style={{ color: '#6c7086' }}>
        {agent.role}
      </p>
    </div>
  );
}

// ---- Connector line helper ----
function VConnector() {
  return (
    <div className="flex justify-center">
      <div className="w-px h-4" style={{ backgroundColor: '#45475a' }} />
    </div>
  );
}

function HLine({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <div className="flex justify-center">
      <div className="h-px" style={{ backgroundColor: '#45475a', width: `${(count - 1) * 120}px`, maxWidth: '100%' }} />
    </div>
  );
}

// ---- Org chart ----
interface OrgChartProps {
  agents: Agent[];
  loading: boolean;
}
function OrgChart({ agents, loading }: OrgChartProps) {
  if (loading) {
    return (
      <div className="space-y-2 py-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm py-4 text-center" style={{ color: '#6c7086' }}>
        No agents found
      </p>
    );
  }

  // Classify agents by role keywords
  const findByRole = (keyword: string) =>
    agents.filter((a) => a.role.toLowerCase().includes(keyword.toLowerCase()));

  const boardHead = agents.filter(
    (a) =>
      a.role.toLowerCase().includes('board') ||
      a.role.toLowerCase().includes('chairman') ||
      a.role.toLowerCase().includes('idan')
  );
  const ceo = agents.filter(
    (a) =>
      a.role.toLowerCase().includes('ceo') ||
      a.role.toLowerCase().includes('chief executive')
  );
  const leadership = agents.filter(
    (a) =>
      !boardHead.includes(a) &&
      !ceo.includes(a) &&
      (a.role.toLowerCase().includes('chief') ||
        a.role.toLowerCase().includes('cto') ||
        a.role.toLowerCase().includes('coo') ||
        a.role.toLowerCase().includes('vp') ||
        a.role.toLowerCase().includes('head of') ||
        a.role.toLowerCase().includes('lead') ||
        a.team?.toLowerCase() === 'leadership')
  );
  const engineering = findByRole('engineer').filter(
    (a) => !leadership.includes(a)
  );
  const onDemand = agents.filter(
    (a) =>
      !boardHead.includes(a) &&
      !ceo.includes(a) &&
      !leadership.includes(a) &&
      !engineering.includes(a) &&
      (a.status === 'on_demand' || a.status === 'available')
  );
  const others = agents.filter(
    (a) =>
      !boardHead.includes(a) &&
      !ceo.includes(a) &&
      !leadership.includes(a) &&
      !engineering.includes(a) &&
      !onDemand.includes(a)
  );

  type OrgRow = { label: string; agents: Agent[] };
  const rows: OrgRow[] = [];
  if (boardHead.length > 0) rows.push({ label: 'Board', agents: boardHead });
  if (ceo.length > 0) rows.push({ label: 'Executive', agents: ceo });
  if (leadership.length > 0) rows.push({ label: 'Leadership', agents: leadership });
  if (engineering.length > 0) rows.push({ label: 'Engineering', agents: engineering });
  if (onDemand.length > 0) rows.push({ label: 'On-demand', agents: onDemand });
  if (others.length > 0) rows.push({ label: 'Other', agents: others });

  // fallback: just show all in one row
  if (rows.length === 0) {
    rows.push({ label: 'All', agents });
  }

  return (
    <div className="space-y-2 overflow-x-auto py-2">
      {rows.map((row, ri) => (
        <div key={row.label}>
          {ri > 0 && (
            <div className="flex flex-col items-center">
              <VConnector />
              <HLine count={row.agents.length} />
              <div className="flex gap-2 justify-center mt-0">
                {row.agents.map((a) => (
                  <div key={a.id} className="flex flex-col items-center">
                    <VConnector />
                    <OrgNode agent={a} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {ri === 0 && (
            <div className="flex gap-2 justify-center">
              {row.agents.map((a) => (
                <OrgNode key={a.id} agent={a} />
              ))}
            </div>
          )}
          <div className="flex justify-center mt-1">
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ color: '#6c7086', backgroundColor: '#1e1e2e' }}
            >
              {row.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Project progress bar ----
interface ProjectProgressProps {
  project: Project;
}
function ProjectProgress({ project }: ProjectProgressProps) {
  const counts = project.task_counts ?? {};
  const done = counts['done'] ?? 0;
  const total = project.total_tasks ?? Object.values(counts).reduce((s, v) => s + v, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const statusColor =
    project.status === 'active'
      ? '#a6e3a1'
      : project.status === 'completed'
      ? '#89b4fa'
      : project.status === 'paused'
      ? '#f9e2af'
      : '#a6adc8';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium truncate" style={{ color: '#cdd6f4', maxWidth: '160px' }}>
          {project.name}
        </span>
        <span className="text-xs flex-shrink-0 ml-2" style={{ color: statusColor }}>
          {pct}%
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: '#313244' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: statusColor }}
        />
      </div>
      <p className="text-xs" style={{ color: '#6c7086' }}>
        {done}/{total} tasks · {project.status}
      </p>
    </div>
  );
}

// ---- Activity event row ----
interface ActivityRowProps {
  event: ActivityEvent;
}
function actionBadgeStyle(action: string): { bg: string; text: string } {
  const a = action.toUpperCase();
  if (a.includes('STARTED') || a.includes('START')) return { bg: '#1e3a5f', text: '#89b4fa' };
  if (a.includes('COMPLETED') || a.includes('DONE') || a.includes('FINISH')) return { bg: '#1a3a2a', text: '#a6e3a1' };
  if (a.includes('BLOCKED') || a.includes('ERROR') || a.includes('FAIL')) return { bg: '#3a1a1e', text: '#f38ba8' };
  if (a.includes('ASSIGNED') || a.includes('ASSIGN')) return { bg: '#2a1e3a', text: '#cba6f7' };
  if (a.includes('UPDATED') || a.includes('UPDATE')) return { bg: '#3a3010', text: '#f9e2af' };
  if (a.includes('CREATED') || a.includes('CREATE')) return { bg: '#103a35', text: '#94e2d5' };
  return { bg: '#313244', text: '#a6adc8' };
}

function ActivityRow({ event }: ActivityRowProps) {
  const badge = actionBadgeStyle(event.action);
  const initial = event.agent ? event.agent.charAt(0).toUpperCase() : '?';
  const agentColor = modelColor('');

  return (
    <div className="flex items-start gap-3 py-2" style={{ borderBottom: '1px solid #1e1e2e' }}>
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
        style={{ backgroundColor: agentColor, color: '#11111b' }}
      >
        {initial}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold" style={{ color: '#cdd6f4' }}>
            {event.agent || 'System'}
          </span>
          <span
            className="text-xs px-1.5 py-0.5 rounded-full font-medium"
            style={{ backgroundColor: badge.bg, color: badge.text }}
          >
            {event.action}
          </span>
          <span className="text-xs ml-auto flex-shrink-0" style={{ color: '#6c7086' }}>
            {event.timestamp
              ? new Date(event.timestamp).toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : ''}
          </span>
        </div>
        <p className="text-xs mt-0.5 truncate" style={{ color: '#a6adc8' }}>
          {event.detail}
        </p>
      </div>
    </div>
  );
}

// ---- Task status summary ----
function taskStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return '#a6e3a1';
  if (s === 'in_progress' || s === 'in progress') return '#89b4fa';
  if (s === 'blocked') return '#f38ba8';
  if (s === 'review') return '#cba6f7';
  if (s === 'todo') return '#a6adc8';
  return '#6c7086';
}

// ---- Main Overview component ----
export default function Overview({
  agents,
  projects,
  tasks,
  events,
  loadingAgents,
  loadingProjects,
  loadingTasks,
}: OverviewProps) {
  // Compute task status distribution
  const statusCounts: Record<string, number> = {};
  for (const t of tasks) {
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
  }

  const recentEvents = events.slice(-20).reverse();

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard
          label="Agents"
          value={agents.length.toString()}
          color="#cba6f7"
          loading={loadingAgents}
        />
        <StatCard
          label="Projects"
          value={projects.length.toString()}
          color="#89b4fa"
          loading={loadingProjects}
        />
        <StatCard
          label="Tasks"
          value={tasks.length.toString()}
          color="#a6e3a1"
          loading={loadingTasks}
        />
        <StatCard
          label="Live Events"
          value={events.length.toString()}
          color="#f9e2af"
          loading={false}
        />
      </div>

      {/* Org chart + Activity row */}
      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Org hierarchy */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#6c7086' }}>
            Organization Hierarchy
          </h3>
          <OrgChart agents={agents} loading={loadingAgents} />
        </div>

        {/* Recent Activity */}
        <div
          className="rounded-xl p-5 flex flex-col"
          style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-3 flex-shrink-0" style={{ color: '#6c7086' }}>
            Recent Activity
          </h3>
          <div className="flex-1 overflow-y-auto" style={{ maxHeight: '280px' }}>
            {recentEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <div className="flex gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-2 h-2 rounded-full animate-pulse-dot"
                      style={{ backgroundColor: '#45475a', animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
                </div>
                <p className="text-xs" style={{ color: '#6c7086' }}>
                  Waiting for events...
                </p>
              </div>
            ) : (
              recentEvents.map((e, i) => (
                <ActivityRow key={`${e.timestamp}-${i}`} event={e} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Task status + Project progress row */}
      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Task status summary */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#6c7086' }}>
            Task Status Summary
          </h3>
          {loadingTasks ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : Object.keys(statusCounts).length === 0 ? (
            <p className="text-xs" style={{ color: '#6c7086' }}>
              No tasks loaded
            </p>
          ) : (
            <div className="space-y-3">
              {Object.entries(statusCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => {
                  const pct = tasks.length > 0 ? Math.round((count / tasks.length) * 100) : 0;
                  const color = taskStatusColor(status);
                  return (
                    <div key={status} className="flex flex-col gap-1">
                      <div className="flex justify-between">
                        <span className="text-xs capitalize" style={{ color: '#cdd6f4' }}>
                          {status.replace(/_/g, ' ')}
                        </span>
                        <span className="text-xs" style={{ color }}>
                          {count} ({pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full" style={{ backgroundColor: '#313244' }}>
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Project progress */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#6c7086' }}>
            Project Progress
          </h3>
          {loadingProjects ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <p className="text-xs" style={{ color: '#6c7086' }}>
              No projects found
            </p>
          ) : (
            <div className="space-y-4">
              {projects.map((p) => (
                <ProjectProgress key={p.id} project={p} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
