import { useState, useEffect, useCallback } from 'react';
import type { Project, Task, Decision } from '../types';
import { fetchProjectDecisions } from '../api/client';

interface ProjectPanelProps {
  projects: Project[];
  loading: boolean;
  tasksByProject: Record<string, Task[]>;
}

type ProjectTab = 'tasks' | 'decisions' | 'team' | 'info';

// ---- Helpers ----
function statusBadge(status: string): { bg: string; text: string } {
  const s = status.toLowerCase();
  if (s === 'active') return { bg: '#1a2e25', text: '#3fb950' };
  if (s === 'completed') return { bg: '#1c2940', text: '#58a6ff' };
  if (s === 'paused') return { bg: '#2d2213', text: '#d29922' };
  if (s === 'planning') return { bg: '#1c2233', text: '#8b8fc7' };
  if (s === 'blocked') return { bg: '#2d1519', text: '#f85149' };
  return { bg: '#21262d', text: '#8b949e' };
}

function typeBadge(type: string): { bg: string; text: string } {
  const t = type.toLowerCase();
  if (t.includes('feature')) return { bg: '#1c2940', text: '#58a6ff' };
  if (t.includes('infra')) return { bg: '#1c2940', text: '#58a6ff' };
  if (t.includes('design')) return { bg: '#2d1519', text: '#8b8fc7' };
  if (t.includes('research')) return { bg: '#2d2213', text: '#d29922' };
  if (t.includes('bug') || t.includes('fix')) return { bg: '#2d1519', text: '#f85149' };
  return { bg: '#21262d', text: '#8b949e' };
}

function taskColColor(col: string): string {
  const c = col.toLowerCase();
  if (c === 'done') return '#3fb950';
  if (c === 'in_progress' || c === 'in progress') return '#58a6ff';
  if (c === 'blocked') return '#f85149';
  if (c === 'review') return '#8b8fc7';
  if (c === 'todo') return '#8b949e';
  return '#484f58';
}

function priorityBadge(priority: string): { bg: string; text: string } {
  const p = priority.toUpperCase();
  if (p === 'P0') return { bg: '#2d1519', text: '#f85149' };
  if (p === 'P1') return { bg: '#2d2213', text: '#d29922' };
  if (p === 'P2') return { bg: '#2d2213', text: '#d29922' };
  return { bg: '#21262d', text: '#484f58' };
}

function avatarInitial(name: string): string {
  return name ? name.charAt(0).toUpperCase() : '?';
}

function avatarBg(_name: string, index: number): string {
  const colors = ['#8b8fc7', '#58a6ff', '#3fb950', '#58a6ff', '#d29922', '#d29922', '#58a6ff', '#8b8fc7'];
  return colors[index % colors.length];
}

// ---- Skeleton ----
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} />;
}

// ---- Project list card ----
interface ProjectListCardProps {
  project: Project;
  selected: boolean;
  onSelect: () => void;
}
function ProjectListCard({ project, selected, onSelect }: ProjectListCardProps) {
  const sbadge = statusBadge(project.status);
  const tbadge = project.type ? typeBadge(project.type) : null;

  const counts = project.task_counts ?? {};
  const done = counts['done'] ?? 0;
  const total = project.total_tasks ?? Object.values(counts).reduce((s, v) => s + v, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <button
      onClick={onSelect}
      className="w-full text-left rounded-xl p-4 flex flex-col gap-3 transition-all duration-200 cursor-pointer"
      style={{
        backgroundColor: selected ? '#21262d' : '#161b22',
        border: `1px solid ${selected ? '#58a6ff' : '#30363d'}`,
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.borderColor = '#6e7681';
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.borderColor = '#30363d';
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-tight" style={{ color: '#e6edf3' }}>
          {project.name}
        </h3>
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
          style={{ backgroundColor: sbadge.bg, color: sbadge.text }}
        >
          {project.status}
        </span>
      </div>

      {project.description && (
        <p
          className="text-xs leading-relaxed"
          style={{ color: '#8b949e', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {project.description}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {tbadge && (
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ backgroundColor: tbadge.bg, color: tbadge.text }}
          >
            {project.type}
          </span>
        )}
        <span className="text-xs" style={{ color: '#484f58' }}>
          {total} tasks
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span style={{ color: '#484f58' }}>Progress</span>
          <span style={{ color: '#3fb950' }}>{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full" style={{ backgroundColor: '#21262d' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: '#3fb950' }}
          />
        </div>
      </div>
    </button>
  );
}

// ---- Kanban board ----
const KANBAN_COLS = ['todo', 'in_progress', 'review', 'done', 'blocked'];
const KANBAN_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
};

interface KanbanProps {
  tasks: Task[];
}
function KanbanBoard({ tasks }: KanbanProps) {
  const grouped: Record<string, Task[]> = {};
  for (const col of KANBAN_COLS) grouped[col] = [];

  for (const task of tasks) {
    const s = task.status.toLowerCase().replace(' ', '_');
    if (s in grouped) {
      grouped[s].push(task);
    } else {
      // put unknown statuses in todo
      grouped['todo'].push(task);
    }
  }

  if (tasks.length === 0) {
    return (
      <p className="text-xs py-4 text-center" style={{ color: '#484f58' }}>
        No tasks in this project
      </p>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {KANBAN_COLS.map((col) => {
        const colTasks = grouped[col];
        const color = taskColColor(col);
        return (
          <div
            key={col}
            className="flex-shrink-0 flex flex-col rounded-xl"
            style={{
              width: '220px',
              backgroundColor: '#161b22',
              border: '1px solid #21262d',
              minHeight: '200px',
            }}
          >
            {/* Column header */}
            <div
              className="px-3 py-2.5 flex items-center justify-between flex-shrink-0 rounded-t-xl"
              style={{ borderBottom: '1px solid #21262d' }}
            >
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>
                {KANBAN_LABELS[col]}
              </span>
              <span
                className="text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold"
                style={{ backgroundColor: '#21262d', color: '#8b949e' }}
              >
                {colTasks.length}
              </span>
            </div>

            {/* Tasks */}
            <div className="flex-1 p-2 space-y-2 overflow-y-auto">
              {colTasks.map((task) => {
                const pri = priorityBadge(task.priority);
                return (
                  <div
                    key={task.id}
                    className="rounded-lg p-3 flex flex-col gap-2"
                    style={{ backgroundColor: '#21262d', border: '1px solid #30363d' }}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium leading-tight" style={{ color: '#e6edf3' }}>
                        {task.title}
                      </p>
                      <span
                        className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 font-medium"
                        style={{ backgroundColor: pri.bg, color: pri.text }}
                      >
                        {task.priority}
                      </span>
                    </div>

                    {task.description && (
                      <p
                        className="text-xs leading-relaxed"
                        style={{
                          color: '#8b949e',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {task.description}
                      </p>
                    )}

                    {task.assigned_to && (
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
                          style={{ backgroundColor: '#58a6ff', color: '#0d1117' }}
                        >
                          {avatarInitial(task.assigned_to)}
                        </div>
                        <span className="text-xs" style={{ color: '#484f58' }}>
                          {task.assigned_to}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Decisions timeline ----
interface DecisionsTabProps {
  projectId: string;
}
function DecisionsTab({ projectId }: DecisionsTabProps) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchProjectDecisions(projectId);
      setDecisions(data);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-3 py-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (decisions.length === 0) {
    return (
      <p className="text-xs py-4" style={{ color: '#484f58' }}>
        No decisions recorded for this project
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {decisions.map((d, i) => (
        <div
          key={i}
          className="rounded-xl p-4 flex flex-col gap-2"
          style={{ backgroundColor: '#21262d', border: '1px solid #30363d' }}
        >
          <div className="flex items-start justify-between gap-3">
            <h4 className="text-sm font-semibold" style={{ color: '#e6edf3' }}>
              {d.title}
            </h4>
            <span className="text-xs flex-shrink-0" style={{ color: '#484f58' }}>
              {d.timestamp
                ? new Date(d.timestamp).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })
                : ''}
            </span>
          </div>

          <p className="text-xs leading-relaxed" style={{ color: '#8b949e' }}>
            <span style={{ color: '#58a6ff' }}>Decision: </span>
            {d.decision}
          </p>

          {d.rationale && (
            <p className="text-xs leading-relaxed" style={{ color: '#8b949e' }}>
              <span style={{ color: '#58a6ff' }}>Rationale: </span>
              {d.rationale}
            </p>
          )}

          {d.alternatives && (
            <p className="text-xs leading-relaxed" style={{ color: '#8b949e' }}>
              <span style={{ color: '#d29922' }}>Alternatives: </span>
              {d.alternatives}
            </p>
          )}

          <div className="flex items-center gap-1.5 mt-1">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
              style={{ backgroundColor: '#8b8fc7', color: '#0d1117' }}
            >
              {avatarInitial(d.decided_by)}
            </div>
            <span className="text-xs" style={{ color: '#484f58' }}>
              {d.decided_by}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Team tab ----
interface TeamTabProps {
  team: string[];
}
function TeamTab({ team }: TeamTabProps) {
  if (team.length === 0) {
    return (
      <p className="text-xs py-4" style={{ color: '#484f58' }}>
        No team members assigned
      </p>
    );
  }

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
      {team.map((member, i) => (
        <div
          key={member}
          className="flex flex-col items-center gap-2 rounded-xl p-4"
          style={{ backgroundColor: '#21262d', border: '1px solid #30363d' }}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold"
            style={{ backgroundColor: avatarBg(member, i), color: '#0d1117' }}
          >
            {avatarInitial(member)}
          </div>
          <p className="text-xs text-center font-medium" style={{ color: '#e6edf3' }}>
            {member}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---- Info tab ----
interface InfoTabProps {
  project: Project;
}
function InfoTab({ project }: InfoTabProps) {
  const sbadge = statusBadge(project.status);

  return (
    <div className="space-y-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div>
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: '#484f58' }}>
            Status
          </p>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium"
            style={{ backgroundColor: sbadge.bg, color: sbadge.text }}
          >
            {project.status}
          </span>
        </div>

        {project.type && (
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: '#484f58' }}>
              Type
            </p>
            <p className="text-xs" style={{ color: '#e6edf3' }}>
              {project.type}
            </p>
          </div>
        )}

        {project.created_at && (
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: '#484f58' }}>
              Created
            </p>
            <p className="text-xs" style={{ color: '#e6edf3' }}>
              {new Date(project.created_at).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>
          </div>
        )}

        {project.updated_at && (
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: '#484f58' }}>
              Last Updated
            </p>
            <p className="text-xs" style={{ color: '#e6edf3' }}>
              {new Date(project.updated_at).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>
          </div>
        )}
      </div>

      {project.description && (
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
            Description
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#8b949e' }}>
            {project.description}
          </p>
        </div>
      )}

      {project.phases && project.phases.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
            Phases
          </p>
          <div className="flex flex-wrap gap-1.5">
            {project.phases.map((phase, i) => (
              <span
                key={i}
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ backgroundColor: '#21262d', color: '#8b8fc7', border: '1px solid #30363d' }}
              >
                {phase}
              </span>
            ))}
          </div>
        </div>
      )}

      {project.task_counts && (
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: '#484f58' }}>
            Task Counts
          </p>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))' }}>
            {Object.entries(project.task_counts).map(([status, count]) => (
              <div
                key={status}
                className="rounded-lg px-3 py-2 text-center"
                style={{ backgroundColor: '#21262d' }}
              >
                <p className="text-base font-bold" style={{ color: taskColColor(status) }}>
                  {count}
                </p>
                <p className="text-xs capitalize" style={{ color: '#484f58' }}>
                  {status.replace(/_/g, ' ')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Project detail panel ----
interface ProjectDetailProps {
  project: Project;
  tasks: Task[];
  onClose: () => void;
}
function ProjectDetail({ project, tasks, onClose }: ProjectDetailProps) {
  const [activeTab, setActiveTab] = useState<ProjectTab>('tasks');
  const sbadge = statusBadge(project.status);

  const tabs: { id: ProjectTab; label: string }[] = [
    { id: 'tasks', label: 'Tasks' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'team', label: 'Team' },
    { id: 'info', label: 'Info' },
  ];

  const team = project.team ?? [];

  return (
    <div
      className="rounded-xl flex flex-col h-full animate-slide-in-right overflow-hidden"
      style={{ backgroundColor: '#161b22', border: '1px solid #30363d' }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 flex items-start justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid #21262d' }}
      >
        <div className="flex-1 min-w-0 pr-4">
          <h3 className="text-sm font-bold truncate" style={{ color: '#e6edf3' }}>
            {project.name}
          </h3>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ backgroundColor: sbadge.bg, color: sbadge.text }}
            >
              {project.status}
            </span>
            {project.type && (
              <span className="text-xs" style={{ color: '#484f58' }}>
                {project.type}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer flex-shrink-0"
          style={{ color: '#484f58', backgroundColor: 'transparent' }}
          aria-label="Close project detail"
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#21262d';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-1 px-4 pt-3 flex-shrink-0"
        style={{ borderBottom: '1px solid #21262d' }}
        role="tablist"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="px-3 py-1.5 text-xs font-medium rounded-t-lg transition-all duration-200 cursor-pointer"
            style={{
              color: activeTab === tab.id ? '#58a6ff' : '#484f58',
              borderBottom: activeTab === tab.id ? '2px solid #58a6ff' : '2px solid transparent',
              backgroundColor: 'transparent',
              outline: 'none',
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.id) (e.currentTarget as HTMLButtonElement).style.color = '#8b949e';
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.id) (e.currentTarget as HTMLButtonElement).style.color = '#484f58';
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4" role="tabpanel">
        {activeTab === 'tasks' && <KanbanBoard tasks={tasks} />}
        {activeTab === 'decisions' && <DecisionsTab projectId={project.id} />}
        {activeTab === 'team' && <TeamTab team={team} />}
        {activeTab === 'info' && <InfoTab project={project} />}
      </div>
    </div>
  );
}

// ---- Main ProjectPanel ----
export default function ProjectPanel({ projects, loading, tasksByProject }: ProjectPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedProject = projects.find((p) => p.id === selectedId) ?? null;
  const selectedTasks = selectedId ? (tasksByProject[selectedId] ?? []) : [];

  const handleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-xl p-4 space-y-2"
            style={{ backgroundColor: '#161b22', border: '1px solid #30363d' }}
          >
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm" style={{ color: '#484f58' }}>
          No projects found. Make sure the backend is running.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-5 animate-fade-in" style={{ minHeight: '600px' }}>
      {/* Project list */}
      <div
        className="flex flex-col gap-3 overflow-y-auto"
        style={{ flex: '0 0 auto', width: selectedProject ? '300px' : '100%', maxWidth: selectedProject ? '300px' : 'none' }}
      >
        {projects.map((project) => (
          <ProjectListCard
            key={project.id}
            project={project}
            selected={selectedId === project.id}
            onSelect={() => handleSelect(project.id)}
          />
        ))}
      </div>

      {/* Detail panel */}
      {selectedProject && (
        <div className="flex-1 overflow-hidden" style={{ minWidth: 0 }}>
          <ProjectDetail
            project={selectedProject}
            tasks={selectedTasks}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </div>
  );
}
