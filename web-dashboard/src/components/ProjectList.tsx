import { useState } from 'react';
import type { Project, Task } from '../types';
import { fetchProjectDetail } from '../api/client';

interface ProjectListProps {
  projects: Project[];
  loading: boolean;
}

function statusBadge(status: string): string {
  switch (status?.toLowerCase()) {
    case 'active': return 'bg-green-900 text-green-300 border-green-700';
    case 'completed': return 'bg-blue-900 text-blue-300 border-blue-700';
    case 'planning': return 'bg-yellow-900 text-yellow-300 border-yellow-700';
    case 'on_hold':
    case 'on hold': return 'bg-orange-900 text-orange-300 border-orange-700';
    case 'cancelled': return 'bg-red-900 text-red-300 border-red-700';
    default: return 'bg-gray-800 text-gray-300 border-gray-600';
  }
}

function priorityBadge(priority: string): string {
  switch (priority?.toUpperCase()) {
    case 'P0': return 'bg-red-900 text-red-300 border-red-700';
    case 'P1': return 'bg-orange-900 text-orange-300 border-orange-700';
    case 'P2': return 'bg-yellow-900 text-yellow-300 border-yellow-700';
    case 'P3': return 'bg-gray-800 text-gray-300 border-gray-600';
    default: return 'bg-gray-800 text-gray-300 border-gray-600';
  }
}

function taskStatusColor(status: string): string {
  switch (status?.toLowerCase()) {
    case 'done': return 'text-green-400';
    case 'in_progress':
    case 'in progress': return 'text-blue-400';
    case 'review': return 'text-violet-400';
    case 'blocked': return 'text-red-400';
    default: return 'text-gray-400';
  }
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function ProgressBar({ progress }: { progress?: Project['progress'] }) {
  if (!progress) return null;
  const pct = Math.min(100, Math.max(0, progress.percentage));
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{progress.done} / {progress.total} tasks</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div
          className="h-full bg-violet-500 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ProjectDetailPanel({ tasks, onClose }: { tasks: Task[]; onClose: () => void }) {
  const grouped: Record<string, Task[]> = {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    blocked: [],
  };
  tasks.forEach((t) => {
    const key = t.status?.toLowerCase().replace(/\s/g, '_');
    if (key in grouped) grouped[key].push(t);
    else grouped['todo'].push(t);
  });

  return (
    <div className="mt-4 border-t border-gray-700 pt-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-gray-200">Tasks ({tasks.length})</h4>
        <button
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          aria-label="Close task details"
        >
          Close
        </button>
      </div>
      {tasks.length === 0 ? (
        <p className="text-xs text-gray-500">No tasks found for this project.</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-start gap-2 bg-gray-900 rounded-lg p-2.5 border border-gray-700">
              <span className={`text-xs font-mono border px-1.5 py-0.5 rounded flex-shrink-0 ${priorityBadge(task.priority)}`}>
                {task.priority || 'P3'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-200 truncate">{task.title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-xs ${taskStatusColor(task.status)}`}>{task.status}</span>
                  <span className="text-xs text-gray-500 truncate">— {task.assigned_to}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  async function handleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (tasks.length === 0) {
      setLoadingDetail(true);
      try {
        const detail = await fetchProjectDetail(project.id);
        setTasks(detail.tasks ?? []);
      } catch {
        setTasks([]);
      } finally {
        setLoadingDetail(false);
      }
    }
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex flex-col gap-3 hover:border-violet-600 transition-colors duration-150">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-white truncate">{project.name}</h3>
          {project.description && (
            <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{project.description}</p>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${statusBadge(project.status)}`}>
          {project.status}
        </span>
      </div>

      {/* Meta */}
      <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
        {project.type && <span className="bg-gray-700 px-2 py-0.5 rounded text-gray-400">{project.type}</span>}
        {project.created_at && <span>{formatDate(project.created_at)}</span>}
      </div>

      {/* Progress */}
      <ProgressBar progress={project.progress} />

      {/* Expand button */}
      <button
        onClick={handleExpand}
        className="text-xs text-violet-400 hover:text-violet-300 text-left transition-colors cursor-pointer"
        aria-expanded={expanded}
      >
        {expanded ? 'Hide tasks' : 'Show tasks'}
      </button>

      {/* Detail panel */}
      {expanded && (
        loadingDetail ? (
          <div className="mt-2 text-xs text-gray-400 animate-pulse">Loading tasks...</div>
        ) : (
          <ProjectDetailPanel tasks={tasks} onClose={() => setExpanded(false)} />
        )
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 animate-pulse space-y-3">
      <div className="flex justify-between">
        <div className="h-4 bg-gray-700 rounded w-2/3" />
        <div className="h-5 bg-gray-700 rounded-full w-16" />
      </div>
      <div className="h-3 bg-gray-700 rounded w-full" />
      <div className="h-3 bg-gray-700 rounded w-3/4" />
      <div className="h-1.5 bg-gray-700 rounded-full w-full" />
    </div>
  );
}

export default function ProjectList({ projects, loading }: ProjectListProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        No projects found. Is the VirtualTree backend running?
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}
