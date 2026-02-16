import type { Task } from '../types';

interface TaskBoardProps {
  tasks: Task[];
  loading: boolean;
}

const COLUMNS: { key: string; label: string; headerColor: string }[] = [
  { key: 'todo', label: 'Todo', headerColor: 'border-gray-500' },
  { key: 'in_progress', label: 'In Progress', headerColor: 'border-blue-500' },
  { key: 'review', label: 'Review', headerColor: 'border-violet-500' },
  { key: 'done', label: 'Done', headerColor: 'border-green-500' },
  { key: 'blocked', label: 'Blocked', headerColor: 'border-red-500' },
];

function normalizeStatus(status: string): string {
  const s = status?.toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'in_progress' || s === 'inprogress') return 'in_progress';
  if (s === 'review' || s === 'in_review') return 'review';
  if (s === 'done' || s === 'completed' || s === 'complete') return 'done';
  if (s === 'blocked') return 'blocked';
  return 'todo';
}

function priorityBadge(priority: string): { classes: string; label: string } {
  switch (priority?.toUpperCase()) {
    case 'P0': return { classes: 'bg-red-900 text-red-300 border-red-700', label: 'P0' };
    case 'P1': return { classes: 'bg-orange-900 text-orange-300 border-orange-700', label: 'P1' };
    case 'P2': return { classes: 'bg-yellow-900 text-yellow-300 border-yellow-700', label: 'P2' };
    case 'P3': return { classes: 'bg-gray-800 text-gray-300 border-gray-600', label: 'P3' };
    default: return { classes: 'bg-gray-800 text-gray-400 border-gray-600', label: priority || '—' };
  }
}

function columnHeaderDot(key: string): string {
  switch (key) {
    case 'todo': return 'bg-gray-400';
    case 'in_progress': return 'bg-blue-400';
    case 'review': return 'bg-violet-400';
    case 'done': return 'bg-green-400';
    case 'blocked': return 'bg-red-400';
    default: return 'bg-gray-400';
  }
}

function TaskCard({ task }: { task: Task }) {
  const badge = priorityBadge(task.priority);
  return (
    <article className="bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2 hover:border-gray-500 transition-colors duration-150">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-gray-100 leading-snug flex-1">{task.title}</p>
        <span className={`text-xs font-mono border px-1.5 py-0.5 rounded flex-shrink-0 ${badge.classes}`}>
          {badge.label}
        </span>
      </div>
      {task.description && (
        <p className="text-xs text-gray-500 line-clamp-2">{task.description}</p>
      )}
      <div className="flex items-center gap-1.5 pt-0.5">
        <div className="w-4 h-4 rounded-full bg-violet-800 flex items-center justify-center text-violet-200 text-xs flex-shrink-0" aria-hidden="true">
          {task.assigned_to?.charAt(0)?.toUpperCase() ?? '?'}
        </div>
        <span className="text-xs text-gray-400 truncate">{task.assigned_to || 'Unassigned'}</span>
      </div>
      {task.depends_on && task.depends_on.length > 0 && (
        <p className="text-xs text-gray-600">Depends on: {task.depends_on.join(', ')}</p>
      )}
    </article>
  );
}

function SkeletonTask() {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 animate-pulse space-y-2">
      <div className="h-3 bg-gray-700 rounded w-full" />
      <div className="h-3 bg-gray-700 rounded w-3/4" />
      <div className="h-3 bg-gray-700 rounded w-1/2" />
    </div>
  );
}

export default function TaskBoard({ tasks, loading }: TaskBoardProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {COLUMNS.map((col) => (
          <div key={col.key} className="space-y-2">
            <div className={`border-t-2 ${col.headerColor} pt-2 mb-3`}>
              <div className="h-4 bg-gray-700 rounded w-20 animate-pulse" />
            </div>
            <SkeletonTask />
            <SkeletonTask />
          </div>
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        No tasks available. Select a project or check the backend connection.
      </div>
    );
  }

  const grouped: Record<string, Task[]> = {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    blocked: [],
  };

  tasks.forEach((task) => {
    const key = normalizeStatus(task.status);
    if (key in grouped) grouped[key].push(task);
    else grouped['todo'].push(task);
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4" role="region" aria-label="Task board">
      {COLUMNS.map((col) => {
        const colTasks = grouped[col.key] ?? [];
        return (
          <div key={col.key} className="flex flex-col" role="group" aria-label={`${col.label} column`}>
            {/* Column header */}
            <div className={`border-t-2 ${col.headerColor} pt-2 mb-3`}>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${columnHeaderDot(col.key)}`} aria-hidden="true" />
                <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">{col.label}</h3>
                <span className="ml-auto text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded-full">{colTasks.length}</span>
              </div>
            </div>

            {/* Tasks */}
            <div className="flex flex-col gap-2 min-h-16">
              {colTasks.length === 0 ? (
                <div className="text-xs text-gray-600 italic text-center py-4">Empty</div>
              ) : (
                colTasks.map((task) => <TaskCard key={task.id} task={task} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
