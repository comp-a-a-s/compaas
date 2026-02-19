import { useState, useEffect, useCallback } from 'react';
import type { Project, Task, Decision } from '../types';
import { fetchProjectDecisions, fetchProjectSpecs, approveProjectPlan } from '../api/client';

interface ProjectPanelProps {
  projects: Project[];
  loading: boolean;
  tasksByProject: Record<string, Task[]>;
  initialProjectId?: string | null;
  onProjectIdConsumed?: () => void;
  onRefresh?: () => void;
}

type ProjectTab = 'tasks' | 'plan' | 'discussions' | 'team' | 'info';

// ---- Helpers ----
function statusBadge(status: string): { bg: string; text: string } {
  const s = status.toLowerCase();
  if (s === 'active') return { bg: '#1a2e25', text: 'var(--tf-success)' };
  if (s === 'completed') return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (s === 'paused') return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (s === 'planning') return { bg: '#1c2233', text: 'var(--tf-accent)' };
  if (s === 'blocked') return { bg: '#2d1519', text: 'var(--tf-error)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)' };
}

function typeBadge(type: string): { bg: string; text: string } {
  const t = type.toLowerCase();
  if (t.includes('feature')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (t.includes('infra')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (t.includes('design')) return { bg: '#2d1519', text: 'var(--tf-accent)' };
  if (t.includes('research')) return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (t.includes('bug') || t.includes('fix')) return { bg: '#2d1519', text: 'var(--tf-error)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)' };
}

function taskColColor(col: string): string {
  const c = col.toLowerCase();
  if (c === 'done') return 'var(--tf-success)';
  if (c === 'in_progress' || c === 'in progress') return 'var(--tf-accent-blue)';
  if (c === 'blocked') return 'var(--tf-error)';
  if (c === 'review') return 'var(--tf-accent)';
  if (c === 'todo') return 'var(--tf-text-secondary)';
  return 'var(--tf-text-muted)';
}

function priorityBadge(priority: string): { bg: string; text: string } {
  const p = priority.toUpperCase();
  if (p === 'P0') return { bg: '#2d1519', text: 'var(--tf-error)' };
  if (p === 'P1') return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (p === 'P2') return { bg: '#2d2213', text: 'var(--tf-warning)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-muted)' };
}

function avatarInitial(name: string): string {
  return name ? name.charAt(0).toUpperCase() : '?';
}

function avatarBg(_name: string, index: number): string {
  const colors = ['var(--tf-accent)', 'var(--tf-accent-blue)', 'var(--tf-success)', 'var(--tf-accent-blue)', 'var(--tf-warning)', 'var(--tf-warning)', 'var(--tf-accent-blue)', 'var(--tf-accent)'];
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
        backgroundColor: selected ? 'var(--tf-surface-raised)' : 'var(--tf-surface)',
        border: `1px solid ${selected ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.borderColor = '#6e7681';
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-border)';
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-tight" style={{ color: 'var(--tf-text)' }}>
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
          style={{ color: 'var(--tf-text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
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
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
          {total} tasks
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span style={{ color: 'var(--tf-text-muted)' }}>Progress</span>
          <span style={{ color: 'var(--tf-success)' }}>{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: 'var(--tf-success)' }}
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
      <p className="text-xs py-4 text-center" style={{ color: 'var(--tf-text-muted)' }}>
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
              backgroundColor: 'var(--tf-surface)',
              border: '1px solid var(--tf-surface-raised)',
              minHeight: '200px',
            }}
          >
            {/* Column header */}
            <div
              className="px-3 py-2.5 flex items-center justify-between flex-shrink-0 rounded-t-xl"
              style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
            >
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>
                {KANBAN_LABELS[col]}
              </span>
              <span
                className="text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold"
                style={{ backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-text-secondary)' }}
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
                    style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium leading-tight" style={{ color: 'var(--tf-text)' }}>
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
                          color: 'var(--tf-text-secondary)',
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
                          style={{ backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)' }}
                        >
                          {avatarInitial(task.assigned_to)}
                        </div>
                        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
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

// ---- Plan tab ----
interface PlanTabProps {
  project: Project;
  onApproved: () => void;
}
function PlanTab({ project, onApproved }: PlanTabProps) {
  const [specs, setSpecs] = useState<{ filename: string; content: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(project.plan_approved ?? false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  useEffect(() => {
    setApproved(project.plan_approved ?? false);
    setLoading(true);
    fetchProjectSpecs(project.id)
      .then(setSpecs)
      .finally(() => setLoading(false));
  }, [project.id, project.plan_approved]);

  const handleApprove = async () => {
    setApproving(true);
    const ok = await approveProjectPlan(project.id);
    setApproving(false);
    if (ok) {
      setApproved(true);
      onApproved();
    }
  };

  return (
    <div className="space-y-4">
      {/* Approval banner */}
      {approved ? (
        <div
          className="flex items-center gap-2 px-4 py-3 rounded-xl"
          style={{ backgroundColor: 'rgba(63,185,80,0.08)', border: '1px solid rgba(63,185,80,0.25)' }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 8l4 4 8-8" stroke="var(--tf-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-xs font-medium" style={{ color: 'var(--tf-success)' }}>
            Plan approved — project is active
          </span>
        </div>
      ) : (
        <div
          className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl"
          style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}
        >
          <p className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
            Review the plan below and approve it to activate the project.
          </p>
          <button
            onClick={handleApprove}
            disabled={approving}
            className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-all duration-200 cursor-pointer"
            style={{
              backgroundColor: approving ? 'var(--tf-surface)' : 'var(--tf-accent)',
              color: approving ? 'var(--tf-text-muted)' : 'var(--tf-bg)',
              border: 'none',
              cursor: approving ? 'wait' : 'pointer',
            }}
          >
            {approving ? 'Approving…' : '✓ Approve Plan'}
          </button>
        </div>
      )}

      {/* Project description as plan overview */}
      {project.description && (
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Overview
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
            {project.description}
          </p>
        </div>
      )}

      {/* Spec files */}
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : specs.length === 0 ? (
        <p className="text-xs py-2" style={{ color: 'var(--tf-text-muted)' }}>
          No spec files yet. The CEO will generate these after planning is complete.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Spec Files
          </p>
          {specs.map((spec) => (
            <div
              key={spec.filename}
              className="rounded-xl overflow-hidden"
              style={{ border: '1px solid var(--tf-border)' }}
            >
              <button
                onClick={() => setExpandedFile(expandedFile === spec.filename ? null : spec.filename)}
                className="w-full flex items-center justify-between px-4 py-2.5 cursor-pointer text-left"
                style={{ backgroundColor: 'var(--tf-surface-raised)' }}
              >
                <span className="text-xs font-medium" style={{ color: 'var(--tf-text)' }}>
                  {spec.filename}
                </span>
                <svg
                  width="12" height="12"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  style={{
                    color: 'var(--tf-text-muted)',
                    transform: expandedFile === spec.filename ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                  }}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {expandedFile === spec.filename && (
                <pre
                  className="px-4 py-3 text-xs overflow-x-auto"
                  style={{
                    color: 'var(--tf-text-secondary)',
                    backgroundColor: 'var(--tf-bg)',
                    fontFamily: 'ui-monospace, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: '300px',
                    overflowY: 'auto',
                  }}
                >
                  {spec.content}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Discussions tab (decisions grouped as meeting sessions) ----
interface DiscussionsTabProps {
  projectId: string;
}

interface MeetingSession {
  title: string;
  date: string;
  attendees: string[];
  decisions: Decision[];
}

function groupDecisionsIntoMeetings(decisions: Decision[]): MeetingSession[] {
  if (decisions.length === 0) return [];
  const sorted = [...decisions].sort(
    (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
  );
  const sessions: MeetingSession[] = [];
  const GAP_MS = 60 * 60 * 1000; // 1-hour gap = new session

  for (const d of sorted) {
    const t = new Date(d.timestamp || 0).getTime();
    const last = sessions[sessions.length - 1];
    const lastTime = last?.decisions.length
      ? new Date(last.decisions[last.decisions.length - 1].timestamp || 0).getTime()
      : -Infinity;

    if (!last || t - lastTime > GAP_MS) {
      const dateLabel = d.timestamp
        ? new Date(d.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Unknown date';
      sessions.push({
        title: `Planning Session — ${dateLabel}`,
        date: d.timestamp || '',
        attendees: [],
        decisions: [],
      });
    }
    const session = sessions[sessions.length - 1];
    session.decisions.push(d);
    const agent = d.decided_by;
    if (agent && !session.attendees.includes(agent)) {
      session.attendees.push(agent);
    }
  }
  return sessions;
}

function DiscussionsTab({ projectId }: DiscussionsTabProps) {
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

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="space-y-3 py-2">{[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>;
  }

  const sessions = groupDecisionsIntoMeetings(decisions);

  if (sessions.length === 0) {
    return (
      <p className="text-xs py-4" style={{ color: 'var(--tf-text-muted)' }}>
        No internal discussions recorded yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {sessions.map((session, si) => (
        <div
          key={si}
          className="rounded-xl overflow-hidden"
          style={{ border: '1px solid var(--tf-border)' }}
        >
          {/* Session header */}
          <div
            className="px-4 py-3 flex items-start justify-between gap-3"
            style={{ backgroundColor: 'var(--tf-surface-raised)', borderBottom: '1px solid var(--tf-border)' }}
          >
            <div>
              <h4 className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>
                {session.title}
              </h4>
              {session.attendees.length > 0 && (
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>Present:</span>
                  {session.attendees.map((a, i) => (
                    <span
                      key={i}
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: 'var(--tf-surface)', color: 'var(--tf-accent)', border: '1px solid var(--tf-border)' }}
                    >
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <span className="text-xs flex-shrink-0" style={{ color: 'var(--tf-text-muted)' }}>
              {session.decisions.length} decision{session.decisions.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Decision list */}
          <div className="divide-y" style={{ borderColor: 'var(--tf-border)' }}>
            {session.decisions.map((d, di) => (
              <div key={di} className="px-4 py-3 space-y-1">
                <p className="text-xs font-medium" style={{ color: 'var(--tf-text)' }}>{d.title}</p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
                  <span style={{ color: 'var(--tf-accent-blue)' }}>Decision: </span>{d.decision}
                </p>
                {d.rationale && (
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
                    <span style={{ color: 'var(--tf-text-muted)' }}>Rationale: </span>{d.rationale}
                  </p>
                )}
                <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>— {d.decided_by}</p>
              </div>
            ))}
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
      <p className="text-xs py-4" style={{ color: 'var(--tf-text-muted)' }}>
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
          style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold"
            style={{ backgroundColor: avatarBg(member, i), color: 'var(--tf-bg)' }}
          >
            {avatarInitial(member)}
          </div>
          <p className="text-xs text-center font-medium" style={{ color: 'var(--tf-text)' }}>
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
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--tf-text-muted)' }}>
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
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--tf-text-muted)' }}>
              Type
            </p>
            <p className="text-xs" style={{ color: 'var(--tf-text)' }}>
              {project.type}
            </p>
          </div>
        )}

        {project.created_at && (
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--tf-text-muted)' }}>
              Created
            </p>
            <p className="text-xs" style={{ color: 'var(--tf-text)' }}>
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
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--tf-text-muted)' }}>
              Last Updated
            </p>
            <p className="text-xs" style={{ color: 'var(--tf-text)' }}>
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
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Description
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
            {project.description}
          </p>
        </div>
      )}

      {project.phases && project.phases.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Phases
          </p>
          <div className="flex flex-wrap gap-1.5">
            {project.phases.map((phase, i) => (
              <span
                key={i}
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-accent)', border: '1px solid var(--tf-border)' }}
              >
                {phase}
              </span>
            ))}
          </div>
        </div>
      )}

      {project.task_counts && (
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Task Counts
          </p>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))' }}>
            {Object.entries(project.task_counts).map(([status, count]) => (
              <div
                key={status}
                className="rounded-lg px-3 py-2 text-center"
                style={{ backgroundColor: 'var(--tf-surface-raised)' }}
              >
                <p className="text-base font-bold" style={{ color: taskColColor(status) }}>
                  {count}
                </p>
                <p className="text-xs capitalize" style={{ color: 'var(--tf-text-muted)' }}>
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
  initialTab?: ProjectTab;
  onApproved?: () => void;
}
function ProjectDetail({ project, tasks, onClose, initialTab, onApproved }: ProjectDetailProps) {
  const [activeTab, setActiveTab] = useState<ProjectTab>(initialTab ?? 'tasks');
  const [localProject, setLocalProject] = useState(project);
  const sbadge = statusBadge(localProject.status);

  useEffect(() => {
    setLocalProject(project);
  }, [project]);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  const tabs: { id: ProjectTab; label: string }[] = [
    { id: 'tasks', label: 'Tasks' },
    { id: 'plan', label: 'Plan' },
    { id: 'discussions', label: 'Discussions' },
    { id: 'team', label: 'Team' },
    { id: 'info', label: 'Info' },
  ];

  const team = project.team ?? [];

  return (
    <div
      className="rounded-xl flex flex-col h-full animate-slide-in-right overflow-hidden"
      style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 flex items-start justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
      >
        <div className="flex-1 min-w-0 pr-4">
          <h3 className="text-sm font-bold truncate" style={{ color: 'var(--tf-text)' }}>
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
              <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                {project.type}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer flex-shrink-0"
          style={{ color: 'var(--tf-text-muted)', backgroundColor: 'transparent' }}
          aria-label="Close project detail"
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--tf-surface-raised)';
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
        style={{ borderBottom: '1px solid var(--tf-surface-raised)' }}
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
              color: activeTab === tab.id ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)',
              borderBottom: activeTab === tab.id ? '2px solid var(--tf-accent-blue)' : '2px solid transparent',
              backgroundColor: 'transparent',
              outline: 'none',
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.id) (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-secondary)';
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.id) (e.currentTarget as HTMLButtonElement).style.color = 'var(--tf-text-muted)';
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4" role="tabpanel">
        {activeTab === 'tasks' && <KanbanBoard tasks={tasks} />}
        {activeTab === 'plan' && (
          <PlanTab
            project={localProject}
            onApproved={() => {
              setLocalProject((p) => ({ ...p, plan_approved: true, status: 'active' }));
              onApproved?.();
            }}
          />
        )}
        {activeTab === 'discussions' && <DiscussionsTab projectId={project.id} />}
        {activeTab === 'team' && <TeamTab team={team} />}
        {activeTab === 'info' && <InfoTab project={localProject} />}
      </div>
    </div>
  );
}

// ---- Main ProjectPanel ----
export default function ProjectPanel({ projects, loading, tasksByProject, initialProjectId, onProjectIdConsumed, onRefresh }: ProjectPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [initialTab, setInitialTab] = useState<ProjectTab | undefined>(undefined);

  // When a navigation request arrives, open the specified project
  useEffect(() => {
    if (initialProjectId) {
      setSelectedId(initialProjectId);
      setInitialTab('plan');
      onProjectIdConsumed?.();
    }
  }, [initialProjectId, onProjectIdConsumed]);

  const selectedProject = projects.find((p) => p.id === selectedId) ?? null;
  const selectedTasks = selectedId ? (tasksByProject[selectedId] ?? []) : [];

  const handleSelect = (id: string) => {
    setInitialTab(undefined);
    setSelectedId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-xl p-4 space-y-2"
            style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}
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
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <p className="text-sm" style={{ color: 'var(--tf-text-muted)' }}>
          No projects found. Ask the CEO to start a project, or check the backend is running.
        </p>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="text-xs px-4 py-2 rounded-lg transition-colors"
            style={{ backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-text)', border: '1px solid var(--tf-border)', cursor: 'pointer' }}
          >
            Retry
          </button>
        )}
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
            initialTab={initialTab}
            onApproved={() => setInitialTab(undefined)}
          />
        </div>
      )}
    </div>
  );
}
