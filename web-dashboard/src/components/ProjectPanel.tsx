import { useState, useEffect, useCallback, useMemo } from 'react';
import type { GuidanceAction, Project, Task, Decision } from '../types';
import {
  fetchProjectDecisions,
  fetchProjectSpecs,
  approveProjectPlan,
  createProject,
  deleteProject as deleteProjectApi,
  updateProjectTags as updateProjectTagsApi,
  openProjectWorkspace,
} from '../api/client';
import FloatingSelect from './ui/FloatingSelect';
import InlineActionCard from './InlineActionCard';

interface ProjectPanelProps {
  projects: Project[];
  loading: boolean;
  tasksByProject: Record<string, Task[]>;
  initialProjectId?: string | null;
  selectedProjectId?: string | null;
  onSelectProject?: (projectId: string) => void;
  onProjectIdConsumed?: () => void;
  onRefresh?: () => void;
  onProjectCreated?: (projectId: string) => void;
  defaultWorkspaceMode?: 'local' | 'github';
  defaultGithubRepo?: string;
  defaultGithubBranch?: string;
  githubConfigured?: boolean;
  onGitHubSetupRequired?: () => void;
}

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

function _typeBadge(type: string): { bg: string; text: string } {
  const t = type.toLowerCase();
  if (t.includes('feature') || t.includes('infra')) return { bg: '#1c2940', text: 'var(--tf-accent-blue)' };
  if (t.includes('design')) return { bg: '#2d1519', text: 'var(--tf-accent)' };
  if (t.includes('research')) return { bg: '#2d2213', text: 'var(--tf-warning)' };
  if (t.includes('bug') || t.includes('fix')) return { bg: '#2d1519', text: 'var(--tf-error)' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)' };
}
void _typeBadge; // kept for potential future use

function taskColColor(col: string): string {
  const c = col.toLowerCase();
  if (c === 'done') return 'var(--tf-success)';
  if (c === 'in_progress' || c === 'in progress') return 'var(--tf-accent-blue)';
  if (c === 'blocked') return 'var(--tf-error)';
  if (c === 'review') return 'var(--tf-accent)';
  if (c === 'todo') return 'var(--tf-text-secondary)';
  return 'var(--tf-text-muted)';
}

interface PriorityInfo { bg: string; text: string; label: string; icon: string }

function priorityBadge(priority: string): PriorityInfo {
  const p = (priority || '').toUpperCase();
  if (p === 'P0' || p === 'CRITICAL') return { bg: '#2d1519', text: 'var(--tf-error)',    label: 'Critical', icon: '●' };
  if (p === 'P1' || p === 'HIGH')     return { bg: '#2d2213', text: 'var(--tf-warning)',  label: 'High',     icon: '●' };
  if (p === 'P2' || p === 'MEDIUM')   return { bg: '#2d2213', text: 'var(--tf-warning)',  label: 'Medium',   icon: '●' };
  if (p === 'P3' || p === 'LOW')      return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-secondary)', label: 'Low', icon: '●' };
  return { bg: 'var(--tf-surface-raised)', text: 'var(--tf-text-muted)', label: priority || 'None', icon: '○' };
}

// ---- Health Score ----
interface HealthInfo { score: number; label: string; color: string; bg: string }

function _computeHealth(tasks: Task[]): HealthInfo {
  const total = tasks.length;
  if (total === 0) return { score: 0, label: 'No Data', color: 'var(--tf-text-muted)', bg: 'var(--tf-surface-raised)' };
  const done     = tasks.filter((t) => t.status.toLowerCase() === 'done').length;
  const blocked  = tasks.filter((t) => t.status.toLowerCase() === 'blocked').length;
  const progress = tasks.filter((t) => t.status.toLowerCase().includes('progress')).length;
  const score = Math.max(0, Math.min(100, Math.round(
    (done / total) * 50 + (progress / total) * 20 - (blocked / total) * 30
  )));
  if (score >= 75) return { score, label: 'Healthy',  color: 'var(--tf-success)',       bg: '#1a2e25' };
  if (score >= 40) return { score, label: 'At Risk',  color: 'var(--tf-warning)',        bg: '#2d2213' };
  return             { score, label: 'Critical', color: 'var(--tf-error)',         bg: '#2d1519' };
}
void _computeHealth; // kept for potential future use

// ---- Task templates ----
const TASK_TEMPLATES = [
  { name: 'Bug Fix',       priority: 'P1', title: 'Fix: [describe bug]',        description: 'Steps to reproduce:\n1. \n\nExpected:\nActual:' },
  { name: 'Feature',       priority: 'P2', title: 'Implement: [feature name]',  description: 'User story:\nAs a [user] I want [feature] so that [benefit].' },
  { name: 'Research',      priority: 'P2', title: 'Research: [topic]',           description: 'Questions:\n1. \n\nDeliverables:\n- Research doc' },
  { name: 'Test Coverage', priority: 'P2', title: 'Test: [component]',           description: 'Test cases:\n1. \n\nTarget coverage: >80%' },
  { name: 'Documentation', priority: 'P3', title: 'Document: [component]',       description: 'Target audience:\nDoc type: API / User / Dev' },
] as const;

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
  onOpenWorkspace?: (project: Project) => void;
}

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'ceo': 'CEO',
  'cto': 'CTO',
  'cfo': 'CFO',
  'ciso': 'CISO',
  'vp-product': 'CPO',
  'vp-engineering': 'VP Eng',
  'chief-researcher': 'Researcher',
  'lead-backend': 'Backend',
  'lead-frontend': 'Frontend',
  'lead-designer': 'Designer',
  'qa-lead': 'QA',
  'devops': 'DevOps',
  'security-engineer': 'Security',
  'data-engineer': 'Data',
  'tech-writer': 'Writer',
};

function resolveTeamName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return AGENT_DISPLAY_NAMES[lower] || raw;
}

function normalizeTagList(rawTags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawTags) {
    const tag = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= 8) break;
  }
  return result;
}

function parseTagInput(value: string): string[] {
  return normalizeTagList(value.split(','));
}

function laneStatusColor(status: string): string {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'in_progress' || normalized === 'in progress') return 'var(--tf-accent-blue)';
  if (normalized === 'blocked') return 'var(--tf-error)';
  if (normalized === 'review') return 'var(--tf-warning)';
  if (normalized === 'done') return 'var(--tf-success)';
  return 'var(--tf-text-muted)';
}

function statusAccent(status: string): string {
  const s = status.toLowerCase();
  if (s === 'active')    return 'var(--tf-success)';
  if (s === 'completed') return 'var(--tf-accent-blue)';
  if (s === 'paused')    return 'var(--tf-warning)';
  if (s === 'planning')  return 'var(--tf-accent)';
  if (s === 'blocked')   return 'var(--tf-error)';
  return 'var(--tf-text-muted)';
}

function statusIcon(status: string): string {
  const s = status.toLowerCase();
  if (s === 'active')    return '\u25CF'; // filled circle
  if (s === 'completed') return '\u2713'; // check
  if (s === 'paused')    return '\u275A\u275A'; // pause bars
  if (s === 'planning')  return '\u25E6'; // open circle
  if (s === 'blocked')   return '\u2716'; // x
  return '\u25CB'; // open circle
}
void statusIcon; // kept for potential future use

function ProjectListCard({ project, selected, onSelect, onOpenWorkspace }: ProjectListCardProps) {
  const accent = statusAccent(project.status);
  const isCompleted = String(project.status || '').toLowerCase() === 'completed';

  const teamNames = project.team ?? [];
  const tagLabels = normalizeTagList(project.tags ?? []);
  const teamLanes = Array.isArray(project.high_level_tasks) ? project.high_level_tasks.slice(0, 3) : [];

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-xl transition-all duration-200 cursor-pointer group${isCompleted ? ' project-card-completed-glow' : ''}`}
      style={{
        backgroundColor: selected ? 'var(--tf-surface-raised)' : 'var(--tf-surface)',
        border: `1px solid ${selected ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
        outline: 'none',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-border-subtle)';
          (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--tf-border)';
          (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
        }
      }}
    >
      <div className="flex">
        {/* Left accent strip */}
        <div
          className="flex-shrink-0"
          style={{
            width: '3px',
            backgroundColor: accent,
            borderRadius: '3px 0 0 3px',
            opacity: selected ? 1 : 0.6,
            transition: 'opacity 0.2s',
          }}
        />

        <div className="flex-1 p-3.5 flex flex-col gap-2 min-w-0">
          {/* Row 1: Name + status */}
          <div className="flex items-center gap-2 min-w-0">
            <h3
              className="text-sm font-semibold truncate"
              style={{ color: 'var(--tf-text)', lineHeight: '1.3' }}
            >
              {project.name}
            </h3>
          </div>

          {/* Description */}
          {project.description && (
            <p
              className="text-xs"
              style={{ color: 'var(--tf-text-muted)', lineHeight: '1.5', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {project.description}
            </p>
          )}

          {/* Team */}
          {teamNames.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: '10px', color: 'var(--tf-text-secondary)' }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flexShrink: 0, opacity: 0.6 }}>
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
              </svg>
              <span>{teamNames.map(resolveTeamName).join(', ')}</span>
            </div>
          )}

          {teamLanes.length > 0 && (
            <div className="rounded-md px-2 py-1.5" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
              <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--tf-text-muted)' }}>
                Team Lanes
              </p>
              <div className="space-y-1">
                {teamLanes.map((lane, index) => (
                  <div key={`${lane.owner}-${index}`} className="flex items-start gap-1.5">
                    <span
                      aria-hidden="true"
                      style={{
                        width: '7px',
                        height: '7px',
                        borderRadius: '999px',
                        backgroundColor: laneStatusColor(lane.status),
                        marginTop: '4px',
                        flexShrink: 0,
                      }}
                    />
                    <p
                      className="text-[10px]"
                      style={{ color: 'var(--tf-text-secondary)', lineHeight: '1.35', overflowWrap: 'anywhere' }}
                    >
                      <span style={{ color: 'var(--tf-text)', fontWeight: 600 }}>{resolveTeamName(lane.owner)}:</span>{' '}
                      {lane.headline}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tagLabels.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {tagLabels.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 rounded-full text-[10px]"
                  style={{
                    border: '1px solid var(--tf-border)',
                    color: 'var(--tf-accent-blue)',
                    backgroundColor: 'color-mix(in srgb, var(--tf-accent-blue) 10%, transparent)',
                  }}
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* How to run */}
          {project.run_instructions && (
            <div style={{ position: 'relative' }}>
              <div
                className="text-xs rounded-md px-2 py-1.5"
                style={{
                  backgroundColor: 'var(--tf-bg)',
                  border: '1px solid var(--tf-border)',
                  color: 'var(--tf-text-secondary)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '10px',
                  lineHeight: '1.4',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '48px',
                  overflow: 'hidden',
                  paddingRight: '28px',
                }}
              >
                {project.run_instructions}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(project.run_instructions!);
                  const btn = e.currentTarget;
                  btn.textContent = '✓';
                  setTimeout(() => { btn.textContent = '⎘'; }, 1200);
                }}
                title="Copy to clipboard"
                style={{
                  position: 'absolute',
                  top: '4px',
                  right: '4px',
                  width: '20px',
                  height: '20px',
                  borderRadius: '4px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-surface)',
                  color: 'var(--tf-text-muted)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                ⎘
              </button>
            </div>
          )}

          {project.workspace_path && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenWorkspace?.(project);
                }}
                className="text-[10px] px-2 py-1 rounded-md"
                style={{
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-bg)',
                  color: 'var(--tf-text-secondary)',
                  cursor: 'pointer',
                }}
                title="Open workspace folder (copies path as fallback)"
              >
                Open Workspace
              </button>
            </div>
          )}

          {/* Empty state when no details available */}
          {!project.description && teamNames.length === 0 && !project.run_instructions && (
            <p className="text-xs italic" style={{ color: 'var(--tf-text-muted)' }}>
              No details yet — ask the CEO to plan this project.
            </p>
          )}
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
  const [showTemplates, setShowTemplates] = useState(false);
  const [copiedTemplate, setCopiedTemplate] = useState<string | null>(null);

  const handleCopyTemplate = (tmpl: typeof TASK_TEMPLATES[number]) => {
    const text = `Title: ${tmpl.title}\nPriority: ${tmpl.priority}\n\n${tmpl.description}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedTemplate(tmpl.name);
      setTimeout(() => setCopiedTemplate(null), 1500);
    });
  };

  // Build a map of task id → title for dependency display
  const taskMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of tasks) m[t.id] = t.title;
    return m;
  }, [tasks]);
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
      <div>
        <p className="text-xs py-4 text-center" style={{ color: 'var(--tf-text-muted)' }}>
          No tasks yet. Ask the CEO to create tasks, or use a template below.
        </p>
        <button
          onClick={() => setShowTemplates((v) => !v)}
          className="text-xs px-3 py-1.5 rounded-lg cursor-pointer"
          style={{ backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-accent)', border: '1px solid var(--tf-border)' }}
        >
          {showTemplates ? '▲ Hide Templates' : '▼ Task Templates'}
        </button>
        {showTemplates && <TemplatesPanel templates={TASK_TEMPLATES} onCopy={handleCopyTemplate} copied={copiedTemplate} />}
      </div>
    );
  }

  return (
    <div>
      {/* Templates bar */}
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => setShowTemplates((v) => !v)}
          className="text-xs px-3 py-1.5 rounded-lg cursor-pointer transition-all"
          style={{ backgroundColor: 'var(--tf-surface-raised)', color: 'var(--tf-accent)', border: '1px solid var(--tf-border)' }}
        >
          {showTemplates ? '▲ Hide Templates' : '▼ Task Templates'}
        </button>
        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>{tasks.length} tasks</span>
      </div>
      {showTemplates && <TemplatesPanel templates={TASK_TEMPLATES} onCopy={handleCopyTemplate} copied={copiedTemplate} />}
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
                const deps = task.depends_on ?? [];
                return (
                  <div
                    key={task.id}
                    className="rounded-lg p-3 flex flex-col gap-2"
                    style={{ backgroundColor: 'var(--tf-surface-raised)', border: `1px solid ${task.status.toLowerCase() === 'blocked' ? 'var(--tf-error)' : 'var(--tf-border)'}` }}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium leading-tight" style={{ color: 'var(--tf-text)' }}>
                        {task.title}
                      </p>
                      <span
                        title={pri.label}
                        className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 font-medium"
                        style={{ backgroundColor: pri.bg, color: pri.text }}
                      >
                        {pri.label}
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

                    {/* Dependencies */}
                    {deps.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>Blocked by:</span>
                        {deps.map((depId) => (
                          <span
                            key={depId}
                            className="text-xs px-1.5 py-0.5 rounded"
                            title={taskMap[depId] ?? depId}
                            style={{ backgroundColor: '#2d1519', color: 'var(--tf-error)' }}
                          >
                            {taskMap[depId] ? taskMap[depId].slice(0, 20) : depId.slice(0, 8)}
                          </span>
                        ))}
                      </div>
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
    </div>
  );
}
void KanbanBoard; // retained for potential future expansion

// ---- Task templates panel ----
interface TemplatesPanelProps {
  templates: typeof TASK_TEMPLATES;
  onCopy: (t: typeof TASK_TEMPLATES[number]) => void;
  copied: string | null;
}
function TemplatesPanel({ templates, onCopy, copied }: TemplatesPanelProps) {
  return (
    <div
      className="mb-4 rounded-xl overflow-hidden"
      style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}
    >
      <div className="px-4 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--tf-border)' }}>
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
          Task Templates — click to copy
        </p>
      </div>
      <div className="flex flex-wrap gap-2 p-3">
        {templates.map((tmpl) => {
          const pri = priorityBadge(tmpl.priority);
          const isCopied = copied === tmpl.name;
          return (
            <button
              key={tmpl.name}
              onClick={() => onCopy(tmpl)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer transition-all duration-200"
              style={{
                backgroundColor: isCopied ? pri.bg : 'var(--tf-surface-raised)',
                border: `1px solid ${isCopied ? pri.text : 'var(--tf-border)'}`,
                color: isCopied ? pri.text : 'var(--tf-text)',
              }}
            >
              <span>{isCopied ? '✓ Copied!' : tmpl.name}</span>
              <span className="px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: pri.bg, color: pri.text }}>
                {pri.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="px-4 pb-3 text-xs" style={{ color: 'var(--tf-text-muted)' }}>
        Paste the copied template into CEO chat to create the task.
      </p>
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
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState('');
  const [missingItems, setMissingItems] = useState<string[]>([]);
  const approved = project.plan_approved ?? false;
  const planPacket = project.plan_packet;

  useEffect(() => {
    let cancelled = false;
    fetchProjectSpecs(project.id)
      .then((data) => {
        if (!cancelled) setSpecs(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const handleApprove = async () => {
    setApproving(true);
    setApprovalError('');
    setMissingItems([]);
    const result = await approveProjectPlan(project.id);
    setApproving(false);
    if (result.ok) {
      onApproved();
      return;
    }
    if (result.missing_items?.length) setMissingItems(result.missing_items);
    setApprovalError(result.summary || 'Unable to approve plan yet.');
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
            disabled={approving || !planPacket?.ready}
            className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-all duration-200 cursor-pointer"
            style={{
              backgroundColor: approving || !planPacket?.ready ? 'var(--tf-surface)' : 'var(--tf-accent)',
              color: approving || !planPacket?.ready ? 'var(--tf-text-muted)' : 'var(--tf-bg)',
              border: 'none',
              cursor: approving || !planPacket?.ready ? 'not-allowed' : 'pointer',
            }}
          >
            {approving ? 'Approving…' : '✓ Approve Plan'}
          </button>
        </div>
      )}
      {!approved && planPacket && (
        <div
          className="rounded-xl px-4 py-3"
          style={{
            backgroundColor: planPacket.ready ? 'rgba(63,185,80,0.08)' : 'rgba(240,170,74,0.1)',
            border: planPacket.ready ? '1px solid rgba(63,185,80,0.25)' : '1px solid rgba(240,170,74,0.3)',
          }}
        >
          <p className="text-xs font-semibold" style={{ color: planPacket.ready ? 'var(--tf-success)' : 'var(--tf-warning)' }}>
            {planPacket.ready ? 'Planning packet ready for approval' : 'Planning packet still incomplete'}
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)' }}>
            {planPacket.summary}
          </p>
          {!planPacket.ready && planPacket.missing_items?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {planPacket.missing_items.map((item, idx) => (
                <li key={`${item}-${idx}`} className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                  • {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(approvalError || missingItems.length > 0) && (
        <div className="rounded-xl px-4 py-3" style={{ backgroundColor: 'rgba(255,95,109,0.08)', border: '1px solid rgba(255,95,109,0.3)' }}>
          {approvalError && <p className="text-xs font-semibold" style={{ color: 'var(--tf-error)' }}>{approvalError}</p>}
          {missingItems.length > 0 && (
            <ul className="mt-1 space-y-1">
              {missingItems.map((item, idx) => (
                <li key={`${item}-${idx}`} className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
                  • {item}
                </li>
              ))}
            </ul>
          )}
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

      <div>
        <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
          Delivery
        </p>
        <p className="text-xs" style={{ color: 'var(--tf-text)' }}>
          Mode: {project.delivery_mode === 'github' ? 'GitHub' : 'Local workspace'}
        </p>
        {project.delivery_mode === 'github' && (
          <>
            {project.github_repo && (
              <p className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)' }}>
                Repo: {project.github_repo}
              </p>
            )}
            {project.github_branch && (
              <p className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)' }}>
                Branch: {project.github_branch}
              </p>
            )}
          </>
        )}
        {project.workspace_path && (
          <p className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)', wordBreak: 'break-all' }}>
            Workspace: {project.workspace_path}
          </p>
        )}
      </div>

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
void PlanTab; // retained for potential future expansion

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
void DiscussionsTab; // retained for potential future expansion

// ---- Overview tab (project summary, team, stats, how-to-run) ----
interface OverviewTabProps {
  project: Project;
  tasks: Task[];
}
function OverviewTab({ project, tasks }: OverviewTabProps) {
  // Derive team from project.team or task assignees
  const team = useMemo(() => {
    if (project.team && project.team.length > 0) return project.team;
    const assignees = new Set<string>();
    for (const t of tasks) {
      if (t.assigned_to) assignees.add(t.assigned_to);
    }
    return Array.from(assignees);
  }, [project.team, tasks]);

  // Task stats
  const counts = project.task_counts ?? {};
  const done = counts['done'] ?? 0;
  const total = project.total_tasks ?? Object.values(counts).reduce((s, v) => s + v, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const inProgress = counts['in_progress'] ?? 0;
  const blocked = counts['blocked'] ?? 0;
  const todo = counts['todo'] ?? 0;

  const isCompleted = project.status.toLowerCase() === 'completed';
  const isActive = project.status.toLowerCase() === 'active';

  return (
    <div className="space-y-5">
      {/* About */}
      <div>
        <p className="text-xs uppercase tracking-widest mb-1.5 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
          About
        </p>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
          {project.description || 'No description yet. The CEO will update this once planning begins.'}
        </p>
      </div>

      {/* Stats row */}
      <div>
        <p className="text-xs uppercase tracking-widest mb-2 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
          Stats
        </p>
        {total > 0 ? (
          <div className="rounded-xl p-3" style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}>
            {/* Progress bar */}
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-xs font-medium" style={{ color: 'var(--tf-text)' }}>
                {isCompleted ? 'Completed' : `${pct}% complete`}
              </span>
              <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>{done}/{total} tasks</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden mb-3" style={{ backgroundColor: 'var(--tf-surface)' }}>
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: isCompleted ? 'var(--tf-success)' : 'var(--tf-accent-blue)' }} />
            </div>
            {/* Stat chips */}
            <div className="flex flex-wrap gap-2">
              {done > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: '#1a2e25', color: 'var(--tf-success)' }}>
                  {done} done
                </span>
              )}
              {inProgress > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: '#1c2940', color: 'var(--tf-accent-blue)' }}>
                  {inProgress} in progress
                </span>
              )}
              {todo > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--tf-surface)', color: 'var(--tf-text-muted)' }}>
                  {todo} to do
                </span>
              )}
              {blocked > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: '#2d1519', color: 'var(--tf-error)' }}>
                  {blocked} blocked
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
            {isActive ? 'Tasks will appear here once the CEO starts delegating work.' : 'No tasks yet.'}
          </p>
        )}
      </div>

      {/* Team */}
      <div>
        <p className="text-xs uppercase tracking-widest mb-2 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
          Team
        </p>
        {team.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>No team members assigned yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {team.map((member, i) => (
              <div
                key={member}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
                style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}
              >
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ backgroundColor: avatarBg(member, i), color: 'var(--tf-bg)' }}
                >
                  {avatarInitial(member)}
                </div>
                <span className="text-xs font-medium" style={{ color: 'var(--tf-text)' }}>
                  {member}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* How to Run */}
      {(project.run_instructions || isCompleted) && (
        <div>
          <p className="text-xs uppercase tracking-widest mb-1.5 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
            How to Run
          </p>
          {project.run_instructions ? (
            <pre
              className="text-xs leading-relaxed rounded-xl p-3"
              style={{
                color: 'var(--tf-text)',
                backgroundColor: 'var(--tf-surface-raised)',
                border: '1px solid var(--tf-border)',
                fontFamily: 'ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {project.run_instructions}
            </pre>
          ) : (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              Run instructions not provided yet. Ask the CEO to update this.
            </p>
          )}
        </div>
      )}

      {/* Location */}
      <div>
        <p className="text-xs uppercase tracking-widest mb-1.5 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
          Location
        </p>
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
          {project.delivery_mode === 'github' ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          )}
          <span>
            {project.delivery_mode === 'github' ? 'GitHub' : 'Local'}
            {project.github_repo ? ` — ${project.github_repo}` : ''}
            {project.github_branch ? ` (${project.github_branch})` : ''}
          </span>
        </div>
        {project.workspace_path && (
          <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)', wordBreak: 'break-all' }}>
            {project.workspace_path}
          </p>
        )}
      </div>
    </div>
  );
}
void OverviewTab; // retained for potential future expansion

// ---- Milestones tab (available for future use) ----
interface MilestonesTabProps {
  project: Project;
  tasks: Task[];
}
export function MilestonesTab({ project, tasks }: MilestonesTabProps) {
  const done   = tasks.filter((t) => t.status.toLowerCase() === 'done').length;
  const total  = tasks.length;

  // Derive milestones from phases; if no phases, group by priority tiers
  const milestones = useMemo(() => {
    const phases = project.phases ?? [];
    if (phases.length > 0) {
      return phases.map((phase, i) => {
        const chunk = Math.ceil(total / phases.length);
        const doneInRange = Math.min(done, (i + 1) * chunk) - i * chunk;
        const chunkDone = Math.max(0, doneInRange);
        const pct = chunk > 0 ? Math.round((chunkDone / chunk) * 100) : 0;
        return { name: phase, pct, status: pct === 100 ? 'done' : pct > 0 ? 'active' : 'pending' };
      });
    }
    // Fallback: synthesize milestones from priority tiers
    const p0Tasks = tasks.filter((t) => t.priority.toUpperCase() === 'P0');
    const p1Tasks = tasks.filter((t) => t.priority.toUpperCase() === 'P1');
    const p2Tasks = tasks.filter((t) => ['P2', 'P3'].includes(t.priority.toUpperCase()));
    const milestoneFor = (name: string, group: Task[]) => {
      if (group.length === 0) return null;
      const doneCnt = group.filter((t) => t.status.toLowerCase() === 'done').length;
      const pct = Math.round((doneCnt / group.length) * 100);
      return { name, pct, status: pct === 100 ? 'done' : pct > 0 ? 'active' : 'pending' };
    };
    return [
      milestoneFor('Critical Tasks (P0)', p0Tasks),
      milestoneFor('High Priority (P1)',   p1Tasks),
      milestoneFor('Remaining Work (P2+)', p2Tasks),
    ].filter(Boolean) as { name: string; pct: number; status: string }[];
  }, [project.phases, tasks, done, total]);

  if (milestones.length === 0) {
    return <p className="text-xs py-4" style={{ color: 'var(--tf-text-muted)' }}>No milestones defined. Add phases to the project to see milestones.</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>Project Milestones</p>
      {milestones.map((ms, i) => {
        const color = ms.status === 'done' ? 'var(--tf-success)' : ms.status === 'active' ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)';
        return (
          <div key={i} className="rounded-xl p-4 flex flex-col gap-2" style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-base">{ms.status === 'done' ? '●' : ms.status === 'active' ? '◉' : '○'}</span>
                <span className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>{ms.name}</span>
              </div>
              <span className="text-xs font-bold" style={{ color }}>{ms.pct}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--tf-surface)' }}>
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${ms.pct}%`, backgroundColor: color }} />
            </div>
          </div>
        );
      })}
      {/* Overall progress */}
      <div className="rounded-xl p-4" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
        <div className="flex justify-between mb-2">
          <span className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>Overall Progress</span>
          <span className="text-xs font-bold" style={{ color: 'var(--tf-success)' }}>{total > 0 ? Math.round((done / total) * 100) : 0}%</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%`, backgroundColor: 'var(--tf-success)' }} />
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--tf-text-muted)' }}>{done} of {total} tasks completed</p>
      </div>
    </div>
  );
}

// ---- Burndown chart (available for future use) ----
interface BurndownChartProps {
  tasks: Task[];
}
export function BurndownChart({ tasks }: BurndownChartProps) {
  const DAYS = 14;
  const W = 480; const H = 120;

  const data = useMemo(() => {
    if (tasks.length === 0) return null;
    const dayMs = 86400_000;
    const startTs = tasks.reduce((min, t) => {
      const created = t.created_at ? new Date(t.created_at).getTime() : Number.POSITIVE_INFINITY;
      const updated = t.updated_at ? new Date(t.updated_at).getTime() : Number.POSITIVE_INFINITY;
      const ts = Math.min(created, updated);
      return ts < min ? ts : min;
    }, Number.POSITIVE_INFINITY);
    const safeStartTs = Number.isFinite(startTs) ? startTs : 0;
    const endTs = tasks.reduce((max, t) => {
      const created = t.created_at ? new Date(t.created_at).getTime() : Number.NEGATIVE_INFINITY;
      const updated = t.updated_at ? new Date(t.updated_at).getTime() : Number.NEGATIVE_INFINITY;
      const ts = Math.max(created, updated);
      return ts > max ? ts : max;
    }, safeStartTs);
    const totalDays = Math.max(DAYS, Math.ceil((endTs - safeStartTs) / dayMs) + 1);

    // Ideal burn: linear from total tasks to 0
    const ideal: number[] = [];
    for (let d = 0; d <= totalDays; d++) {
      ideal.push(tasks.length * (1 - d / totalDays));
    }

    // Actual: count tasks NOT done at end of each day
    const actual: number[] = [];
    for (let d = 0; d <= totalDays; d++) {
      const dayEnd = safeStartTs + d * dayMs;
      const remaining = tasks.filter((t) => {
        const doneAt = t.updated_at ? new Date(t.updated_at).getTime() : null;
        if (!doneAt) return true; // not done yet
        const isDone = t.status.toLowerCase() === 'done';
        return !(isDone && doneAt <= dayEnd);
      }).length;
      actual.push(remaining);
    }
    return { ideal, actual, totalDays };
  }, [tasks]);

  if (!data) return <p className="text-xs py-4" style={{ color: 'var(--tf-text-muted)' }}>No task data for burndown chart.</p>;

  const { ideal, actual, totalDays } = data;
  const maxY = tasks.length;
  const toX = (d: number) => (d / totalDays) * W;
  const toY = (v: number) => H - (v / maxY) * H;

  const idealPath = ideal.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const actualPath = actual.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  return (
    <div className="space-y-4">
      <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>Burndown Chart</p>
      <div className="rounded-xl p-4" style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H + 20}`} style={{ overflow: 'visible' }}>
          {/* Grid lines */}
          {[0.25, 0.5, 0.75, 1].map((r) => (
            <line key={r} x1={0} y1={toY(maxY * r)} x2={W} y2={toY(maxY * r)}
              stroke="var(--tf-border)" strokeDasharray="4 4" strokeWidth={1} />
          ))}
          {/* Ideal line */}
          <path d={idealPath} fill="none" stroke="var(--tf-text-muted)" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.6} />
          {/* Actual line */}
          <path d={actualPath} fill="none" stroke="var(--tf-accent-blue)" strokeWidth={2} />
          {/* Labels */}
          <text x={4} y={toY(maxY) - 4} fontSize={9} fill="var(--tf-text-muted)">{maxY}</text>
          <text x={4} y={H - 2} fontSize={9} fill="var(--tf-text-muted)">0</text>
        </svg>
        <div className="flex items-center gap-4 mt-2">
          <div className="flex items-center gap-1.5">
            <div className="w-8 h-0.5" style={{ borderTop: '2px dashed var(--tf-text-muted)' }} />
            <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>Ideal</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-8 h-0.5" style={{ backgroundColor: 'var(--tf-accent-blue)' }} />
            <span className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>Actual</span>
          </div>
        </div>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {[
          { label: 'Total Tasks', value: tasks.length.toString(), color: 'var(--tf-text)' },
          { label: 'Completed', value: tasks.filter((t) => t.status.toLowerCase() === 'done').length.toString(), color: 'var(--tf-success)' },
          { label: 'Remaining', value: tasks.filter((t) => t.status.toLowerCase() !== 'done').length.toString(), color: 'var(--tf-accent-blue)' },
        ].map((s) => (
          <div key={s.label} className="rounded-lg p-3 text-center" style={{ backgroundColor: 'var(--tf-surface-raised)' }}>
            <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Sprint planning tab (available for future use) ----
interface SprintTabProps {
  tasks: Task[];
}
export function SprintTab({ tasks }: SprintTabProps) {
  const SPRINT_SIZE = 8;
  const sprints = useMemo(() => {
    // Group tasks into sprints by creation order / priority
    const sorted = [...tasks].sort((a, b) => {
      const priOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      return (priOrder[a.priority?.toUpperCase()] ?? 4) - (priOrder[b.priority?.toUpperCase()] ?? 4);
    });
    const result: { name: string; tasks: Task[] }[] = [];
    for (let i = 0; i < sorted.length; i += SPRINT_SIZE) {
      result.push({ name: `Sprint ${result.length + 1}`, tasks: sorted.slice(i, i + SPRINT_SIZE) });
    }
    return result;
  }, [tasks]);

  const [activeSprint, setActiveSprint] = useState(0);

  if (sprints.length === 0) {
    return <p className="text-xs py-4" style={{ color: 'var(--tf-text-muted)' }}>No tasks to plan sprints for.</p>;
  }

  const sprint = sprints[activeSprint];
  const sprintDone = sprint.tasks.filter((t) => t.status.toLowerCase() === 'done').length;
  const sprintPct = sprint.tasks.length > 0 ? Math.round((sprintDone / sprint.tasks.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Sprint selector */}
      <div className="flex gap-2 flex-wrap">
        {sprints.map((s, i) => {
          const sDone = s.tasks.filter((t) => t.status.toLowerCase() === 'done').length;
          const sPct = s.tasks.length > 0 ? Math.round((sDone / s.tasks.length) * 100) : 0;
          const isActive = activeSprint === i;
          return (
            <button
              key={i}
              onClick={() => setActiveSprint(i)}
              className="text-xs px-3 py-1.5 rounded-lg cursor-pointer transition-all"
              style={{
                backgroundColor: isActive ? 'var(--tf-accent-blue)' : 'var(--tf-surface-raised)',
                color: isActive ? 'var(--tf-bg)' : 'var(--tf-text-secondary)',
                border: `1px solid ${isActive ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
              }}
            >
              {s.name} ({sPct}%)
            </button>
          );
        })}
      </div>

      {/* Sprint header */}
      <div className="rounded-xl p-4" style={{ backgroundColor: 'var(--tf-surface-raised)', border: '1px solid var(--tf-border)' }}>
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>{sprint.name}</span>
          <span className="text-xs font-bold" style={{ color: 'var(--tf-accent-blue)' }}>{sprintDone}/{sprint.tasks.length} done</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--tf-surface)' }}>
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${sprintPct}%`, backgroundColor: 'var(--tf-accent-blue)' }} />
        </div>
      </div>

      {/* Sprint tasks */}
      <div className="space-y-2">
        {sprint.tasks.map((task) => {
          const pri = priorityBadge(task.priority);
          const isDone = task.status.toLowerCase() === 'done';
          return (
            <div
              key={task.id}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5"
              style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)', opacity: isDone ? 0.6 : 1 }}
            >
              <span style={{ color: isDone ? 'var(--tf-success)' : 'var(--tf-text-muted)' }}>{isDone ? '✓' : '○'}</span>
              <span className="flex-1 text-xs truncate" style={{ color: isDone ? 'var(--tf-text-muted)' : 'var(--tf-text)', textDecoration: isDone ? 'line-through' : 'none' }}>
                {task.title}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: pri.bg, color: pri.text }}>
                {pri.label}
              </span>
              {task.assigned_to && (
                <span className="text-xs flex-shrink-0" style={{ color: 'var(--tf-text-muted)' }}>{task.assigned_to.split(' ')[0]}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Team tab (available for future use) ----
interface TeamTabProps {
  team: string[];
}
export function TeamTab({ team }: TeamTabProps) {
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

// ---- Info tab (available for future use) ----
interface InfoTabProps {
  project: Project;
}
export function InfoTab({ project }: InfoTabProps) {
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
            {project.phases.map((phase) => (
              <span
                key={phase}
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
  onOpenWorkspace?: (project: Project) => void;
  onDelete?: () => void;
  deleting?: boolean;
  deleteError?: string;
  onSaveTags?: (tags: string[]) => void;
  savingTags?: boolean;
  tagsError?: string;
  workspaceMessage?: string;
  workspaceError?: string;
}
function ProjectDetail({
  project,
  tasks,
  onClose,
  onOpenWorkspace,
  onDelete,
  deleting = false,
  deleteError = '',
  onSaveTags,
  savingTags = false,
  tagsError = '',
  workspaceMessage = '',
  workspaceError = '',
}: ProjectDetailProps) {
  const highLevelLanes = useMemo(
    () => (Array.isArray(project.high_level_tasks) ? project.high_level_tasks : []),
    [project.high_level_tasks],
  );
  const teamMembers = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const member of project.team ?? []) {
      const name = String(member || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      ordered.push(name);
    }
    for (const task of tasks) {
      const assignee = String(task.assigned_to || '').trim();
      if (!assignee || seen.has(assignee)) continue;
      seen.add(assignee);
      ordered.push(assignee);
    }
    for (const lane of highLevelLanes) {
      const owner = String(lane?.owner || '').trim();
      if (!owner || seen.has(owner)) continue;
      seen.add(owner);
      ordered.push(owner);
    }
    return ordered;
  }, [highLevelLanes, project.team, tasks]);

  const tasksByAssignee = useMemo(() => {
    const grouped: Record<string, string[]> = {};
    for (const task of tasks) {
      const assignee = String(task.assigned_to || '').trim();
      const title = String(task.title || '').trim();
      if (!assignee || !title) continue;
      if (!grouped[assignee]) grouped[assignee] = [];
      if (!grouped[assignee].includes(title)) grouped[assignee].push(title);
    }
    return grouped;
  }, [tasks]);

  const lanesByOwner = useMemo(() => {
    const grouped: Record<string, Array<{ headline: string; status: string }>> = {};
    for (const lane of highLevelLanes) {
      const owner = String(lane.owner || '').trim();
      const headline = String(lane.headline || '').trim();
      const status = String(lane.status || '').trim();
      if (!owner || !headline) continue;
      if (!grouped[owner]) grouped[owner] = [];
      grouped[owner].push({ headline, status });
    }
    return grouped;
  }, [highLevelLanes]);

  const runCommands = useMemo(() => (
    String(project.run_instructions || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  ), [project.run_instructions]);
  const qualitySnapshot = useMemo(() => {
    const snapshot = project.quality_latest;
    return snapshot && typeof snapshot === 'object' ? snapshot : undefined;
  }, [project.quality_latest]);
  const qualityReport = qualitySnapshot?.quality_report;
  const deliveryGates = qualitySnapshot?.delivery_gates;
  const refinement = qualitySnapshot?.refinement;
  const tagLabels = useMemo(() => normalizeTagList(project.tags ?? []), [project.tags]);
  const [tagDraft, setTagDraft] = useState(() => tagLabels.join(', '));

  useEffect(() => {
    setTagDraft(tagLabels.join(', '));
  }, [project.id, tagLabels]);

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
          <p className="text-xs mt-1.5" style={{ color: 'var(--tf-text-muted)' }}>{project.status}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {onDelete && (
            <button
              onClick={onDelete}
              disabled={deleting}
              className="px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed"
              style={{
                backgroundColor: deleting ? 'var(--tf-surface-raised)' : '#2d1519',
                border: '1px solid var(--tf-error)',
                color: deleting ? 'var(--tf-text-muted)' : 'var(--tf-error)',
              }}
              aria-label="Delete Project"
              title="Delete project permanently"
            >
              {deleting ? 'Deleting…' : 'Delete Project'}
            </button>
          )}
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
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {deleteError && (
          <InlineActionCard
            title="Project deletion failed"
            message={deleteError}
            severity="error"
            actions={onDelete ? [{ id: 'retry-delete', label: 'Retry delete', kind: 'retry' } as GuidanceAction] : []}
            onAction={(action) => {
              if (action.id === 'retry-delete') {
                onDelete?.();
              }
            }}
          />
        )}
        {tagsError && (
          <InlineActionCard
            title="Tag update failed"
            message={tagsError}
            severity="warning"
            actions={onSaveTags ? [{ id: 'retry-tags', label: 'Retry save tags', kind: 'retry' } as GuidanceAction] : []}
            onAction={(action) => {
              if (action.id === 'retry-tags') {
                onSaveTags?.(parseTagInput(tagDraft));
              }
            }}
          />
        )}
        <section>
          <p className="text-xs uppercase tracking-widest mb-2 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
            Project Description
          </p>
          {tagLabels.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mb-2">
              {tagLabels.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 rounded-full text-[11px]"
                  style={{
                    border: '1px solid var(--tf-border)',
                    color: 'var(--tf-accent-blue)',
                    backgroundColor: 'color-mix(in srgb, var(--tf-accent-blue) 10%, transparent)',
                  }}
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
          <p className="text-sm leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
            {project.description || 'No description yet. Ask the CEO for a completion summary.'}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              placeholder="Add tags (comma-separated)"
              className="text-xs px-2 py-1.5 rounded-md flex-1 min-w-0"
              style={{
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-bg)',
                color: 'var(--tf-text)',
              }}
            />
            <button
              type="button"
              onClick={() => onSaveTags?.(parseTagInput(tagDraft))}
              disabled={!onSaveTags || savingTags}
              className="text-xs px-2.5 py-1.5 rounded-md"
              style={{
                border: '1px solid var(--tf-border)',
                backgroundColor: savingTags ? 'var(--tf-surface-raised)' : 'transparent',
                color: savingTags ? 'var(--tf-text-muted)' : 'var(--tf-text-secondary)',
                cursor: !onSaveTags || savingTags ? 'not-allowed' : 'pointer',
              }}
            >
              {savingTags ? 'Saving…' : 'Save Tags'}
            </button>
          </div>
        </section>

        <section>
          <p className="text-xs uppercase tracking-widest mb-2 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
            Team + High-Level Tasks
          </p>
          {teamMembers.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              No team members yet.
            </p>
          ) : (
            <div className="space-y-2">
              {teamMembers.map((member, idx) => {
                const memberLanes = (lanesByOwner[member] || []).slice(0, 3);
                const memberTasks = (tasksByAssignee[member] || []).slice(0, 3);
                return (
                  <div
                    key={`${member}-${idx}`}
                    className="rounded-lg px-3 py-2"
                    style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)' }}
                  >
                    <p className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>{resolveTeamName(member)}</p>
                    {memberLanes.length > 0 ? (
                      <ul className="mt-1 space-y-1">
                        {memberLanes.map((lane, laneIdx) => (
                          <li
                            key={`${member}-${lane.headline}-${laneIdx}`}
                            className="text-xs flex items-start gap-1.5"
                            style={{ color: 'var(--tf-text-secondary)' }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                width: '7px',
                                height: '7px',
                                borderRadius: '999px',
                                backgroundColor: laneStatusColor(lane.status),
                                marginTop: '4px',
                                flexShrink: 0,
                              }}
                            />
                            <span>{lane.headline}</span>
                          </li>
                        ))}
                      </ul>
                    ) : memberTasks.length > 0 ? (
                      <ul className="mt-1 space-y-1">
                        {memberTasks.map((taskTitle) => (
                          <li key={`${member}-${taskTitle}`} className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
                            • {taskTitle}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                        No high-level tasks assigned yet.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <p className="text-xs uppercase tracking-widest mb-2 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
            Final Run Commands
          </p>
          {project.workspace_path && (
            <button
              type="button"
              onClick={() => onOpenWorkspace?.(project)}
              className="text-xs px-2.5 py-1.5 rounded-md mb-2"
              style={{
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-surface-raised)',
                color: 'var(--tf-text-secondary)',
                cursor: 'pointer',
              }}
            >
              Open Workspace Folder
            </button>
          )}
          {runCommands.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              No run commands yet.
            </p>
          ) : (
            <div className="space-y-2">
              {runCommands.map((command, idx) => (
                <div
                  key={`${command}-${idx}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-2"
                  style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}
                >
                  <code
                    className="text-xs"
                    style={{
                      color: 'var(--tf-text-secondary)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      flex: 1,
                      minWidth: 0,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {command}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(command);
                    }}
                    title="Copy command"
                    className="text-xs px-2 py-1 rounded-md"
                    style={{
                      border: '1px solid var(--tf-border)',
                      backgroundColor: 'transparent',
                      color: 'var(--tf-text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    Copy
                  </button>
                </div>
              ))}
            </div>
          )}
          {workspaceMessage && (
            <p className="text-xs mt-2" style={{ color: 'var(--tf-success)' }}>
              {workspaceMessage}
            </p>
          )}
          {workspaceError && (
            <p className="text-xs mt-2" style={{ color: 'var(--tf-warning)' }}>
              {workspaceError}
            </p>
          )}
        </section>

        <section>
          <p className="text-xs uppercase tracking-widest mb-2 font-semibold" style={{ color: 'var(--tf-text-muted)' }}>
            Latest Quality Snapshot
          </p>
          {!qualitySnapshot || !qualityReport ? (
            <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
              No quality snapshot yet. Complete a build to populate quality metrics.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs px-2 py-1 rounded-full" style={{ border: '1px solid var(--tf-border)', color: 'var(--tf-accent-blue)' }}>
                  Code {qualityReport.code_quality}
                </span>
                <span className="text-xs px-2 py-1 rounded-full" style={{ border: '1px solid var(--tf-border)', color: 'var(--tf-accent-blue)' }}>
                  UX {qualityReport.ux_quality}
                </span>
                <span className="text-xs px-2 py-1 rounded-full" style={{ border: '1px solid var(--tf-border)', color: 'var(--tf-accent-blue)' }}>
                  Visual {qualityReport.visual_distinctiveness}
                </span>
              </div>
              {deliveryGates && (
                <p className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
                  Gates passed: {deliveryGates.passed.length}/{deliveryGates.required.length}
                </p>
              )}
              {qualityReport.failed_gates.length > 0 && (
                <ul className="space-y-1">
                  {qualityReport.failed_gates.map((gate) => (
                    <li key={gate} className="text-xs" style={{ color: 'var(--tf-warning)' }}>
                      • {gate.replace(/_/g, ' ')}
                    </li>
                  ))}
                </ul>
              )}
              {refinement?.attempted && (
                <p className="text-xs" style={{ color: 'var(--tf-text-secondary)' }}>
                  Refinement pass {refinement.pass_index}/{Math.max(refinement.pass_index, refinement.max_passes)} executed.
                  {refinement.reason ? ` ${refinement.reason}` : ''}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ---- Main ProjectPanel ----
export default function ProjectPanel({
  projects,
  loading,
  tasksByProject,
  initialProjectId,
  selectedProjectId,
  onSelectProject,
  onProjectIdConsumed,
  onRefresh,
  onProjectCreated,
  defaultWorkspaceMode = 'local',
  defaultGithubRepo = '',
  defaultGithubBranch = 'master',
  githubConfigured = false,
  onGitHubSetupRequired,
}: ProjectPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [creatingProject, setCreatingProject] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deleteProjectError, setDeleteProjectError] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const [tagsError, setTagsError] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [newProjectMode, setNewProjectMode] = useState<'local' | 'github'>(defaultWorkspaceMode === 'github' ? 'github' : 'local');
  const [newProjectRepo, setNewProjectRepo] = useState(defaultGithubRepo);
  const [newProjectBranch, setNewProjectBranch] = useState(defaultGithubBranch || 'master');
  const [projectError, setProjectError] = useState('');
  const [workspaceMessage, setWorkspaceMessage] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');

  const projectModeOptions = useMemo(() => ([
    {
      value: 'local',
      label: 'Local workspace',
      description: 'Write project files under the COMPaaS projects folder.',
      badge: 'Ready',
      keywords: ['local', 'workspace', 'filesystem'],
    },
    {
      value: 'github',
      label: 'GitHub repository',
      description: githubConfigured
        ? 'Use connected repository defaults and branch routing.'
        : 'GitHub connector setup is required in Settings.',
      badge: githubConfigured ? 'Ready' : 'Setup required',
      keywords: ['github', 'repo', 'branch', 'remote'],
    },
  ]), [githubConfigured]);

  useEffect(() => {
    setNewProjectMode(defaultWorkspaceMode === 'github' ? 'github' : 'local');
  }, [defaultWorkspaceMode]);

  useEffect(() => {
    setNewProjectRepo(defaultGithubRepo);
  }, [defaultGithubRepo]);

  useEffect(() => {
    setNewProjectBranch(defaultGithubBranch || 'master');
  }, [defaultGithubBranch]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Acknowledge one-shot navigation requests from chat.
  useEffect(() => {
    if (initialProjectId) {
      onProjectIdConsumed?.();
    }
  }, [initialProjectId, onProjectIdConsumed]);

  const effectiveSelectedId = initialProjectId ?? selectedProjectId ?? selectedId;
  const selectedProject = projects.find((p) => p.id === effectiveSelectedId) ?? null;
  const selectedTasks = effectiveSelectedId ? (tasksByProject[effectiveSelectedId] ?? []) : [];
  const isNarrowViewport = viewportWidth <= 1100;

  const handleSelect = (id: string) => {
    const next = effectiveSelectedId === id ? null : id;
    setSelectedId(next);
    setDeleteProjectError('');
    setTagsError('');
    setWorkspaceMessage('');
    setWorkspaceError('');
    onSelectProject?.(next || '');
  };

  const handleOpenWorkspace = useCallback(async (project: Project) => {
    if (!project || !project.id) return;
    setWorkspaceMessage('');
    setWorkspaceError('');

    const result = await openProjectWorkspace(project.id);
    const workspacePath = String(project.workspace_path || '').trim();
    if (result.ok && result.data?.opened) {
      setWorkspaceMessage(result.data.detail || 'Workspace folder opened.');
      return;
    }

    const detail = result.detail
      || result.data?.detail
      || 'Unable to open workspace folder from this environment.';
    if (workspacePath) {
      void navigator.clipboard.writeText(workspacePath).catch(() => undefined);
      setWorkspaceError(`${detail} Path copied to clipboard.`);
      return;
    }
    setWorkspaceError(detail);
  }, []);

  const handleDeleteProject = useCallback(async () => {
    if (!selectedProject || deletingProjectId) return;
    const projectName = selectedProject.name || selectedProject.id;
    const confirmed = window.confirm(
      `Delete project "${projectName}"?\n\nThis permanently deletes the project data and its workspace files. This action cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleteProjectError('');
    setWorkspaceMessage('');
    setWorkspaceError('');
    setDeletingProjectId(selectedProject.id);
    const result = await deleteProjectApi(selectedProject.id);
    setDeletingProjectId(null);
    if (!result.ok) {
      setDeleteProjectError(result.detail || 'Unable to delete project.');
      return;
    }
    if (result.detail) {
      window.alert(`Project deleted, but workspace cleanup was skipped: ${result.detail}`);
    }
    setSelectedId(null);
    onSelectProject?.('');
    onRefresh?.();
  }, [deletingProjectId, onRefresh, onSelectProject, selectedProject]);

  const handleSaveTags = useCallback(async (tags: string[]) => {
    if (!selectedProject || savingTags) return;
    setTagsError('');
    setSavingTags(true);
    const result = await updateProjectTagsApi(selectedProject.id, tags);
    setSavingTags(false);
    if (!result.ok) {
      setTagsError(result.detail || 'Unable to save project tags.');
      return;
    }
    onRefresh?.();
  }, [onRefresh, savingTags, selectedProject]);

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name || creatingProject) return;
    if (newProjectMode === 'github' && !newProjectRepo.trim()) {
      setProjectError('GitHub mode requires a repository (owner/repo).');
      return;
    }
    setCreatingProject(true);
    setProjectError('');
    const created = await createProject({
      name,
      description: newProjectDescription.trim(),
      type: 'app',
      delivery_mode: newProjectMode,
      github_repo: newProjectMode === 'github' ? newProjectRepo.trim() : '',
      github_branch: newProjectMode === 'github' ? (newProjectBranch.trim() || 'master') : '',
    });
    setCreatingProject(false);
    const createError = created.error;
    if (created.status !== 'ok' || !created.project?.id) {
      const settingsTarget = createError?.settings_target || '';
      if (createError?.code === 'github_not_configured' || settingsTarget === 'github') {
        setProjectError(createError?.message || 'GitHub connector is not configured. Open Settings → Integrations and verify GitHub.');
        onGitHubSetupRequired?.();
        return;
      }
      setProjectError(createError?.message || 'Unable to create project. Try again.');
      return;
    }
    setNewProjectName('');
    setNewProjectDescription('');
    setNewProjectMode(defaultWorkspaceMode === 'github' ? 'github' : 'local');
    setNewProjectRepo(defaultGithubRepo);
    setNewProjectBranch(defaultGithubBranch || 'master');
    setProjectError('');
    onProjectCreated?.(created.project.id);
    onRefresh?.();
    onSelectProject?.(created.project.id);
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
          No projects found yet. Start one here or ask the CEO to initialize one from chat.
        </p>
        <div className="w-full max-w-xl rounded-xl p-4" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
          <div className="text-xs mb-2 font-semibold" style={{ color: 'var(--tf-text-secondary)' }}>Start New Project</div>
          <input
            type="text"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="Project name"
            style={{
              width: '100%',
              marginBottom: '8px',
              backgroundColor: 'var(--tf-bg)',
              border: '1px solid var(--tf-border)',
              borderRadius: '8px',
              color: 'var(--tf-text)',
              fontSize: '13px',
              padding: '8px 10px',
            }}
          />
          <textarea
            value={newProjectDescription}
            onChange={(e) => setNewProjectDescription(e.target.value)}
            placeholder="Brief description (optional)"
            style={{
              width: '100%',
              minHeight: '66px',
              resize: 'vertical',
              marginBottom: '10px',
              backgroundColor: 'var(--tf-bg)',
              border: '1px solid var(--tf-border)',
              borderRadius: '8px',
              color: 'var(--tf-text)',
              fontSize: '13px',
              padding: '8px 10px',
            }}
          />
          <div className="flex items-center gap-2 mb-2">
            <label className="text-xs font-medium" style={{ color: 'var(--tf-text-secondary)' }}>Location</label>
            <FloatingSelect
              value={newProjectMode}
              options={projectModeOptions}
              onChange={(nextMode) => setNewProjectMode(nextMode === 'github' ? 'github' : 'local')}
              variant="card"
              searchable={false}
              ariaLabel="Project delivery mode"
              size="sm"
              style={{
                width: '230px',
              }}
            />
          </div>
          {newProjectMode === 'github' && (
            <>
              <input
                type="text"
                value={newProjectRepo}
                onChange={(e) => setNewProjectRepo(e.target.value)}
                placeholder="owner/repo"
                style={{
                  width: '100%',
                  marginBottom: '8px',
                  backgroundColor: 'var(--tf-bg)',
                  border: '1px solid var(--tf-border)',
                  borderRadius: '8px',
                  color: 'var(--tf-text)',
                  fontSize: '13px',
                  padding: '8px 10px',
                }}
              />
              <input
                type="text"
                value={newProjectBranch}
                onChange={(e) => setNewProjectBranch(e.target.value)}
                placeholder="Branch (default: master)"
                style={{
                  width: '100%',
                  marginBottom: '10px',
                  backgroundColor: 'var(--tf-bg)',
                  border: '1px solid var(--tf-border)',
                  borderRadius: '8px',
                  color: 'var(--tf-text)',
                  fontSize: '13px',
                  padding: '8px 10px',
                }}
              />
            </>
          )}
          {newProjectMode === 'github' && !githubConfigured && (
            <div
              className="text-xs mb-2 rounded-lg px-2 py-1.5"
              style={{ color: 'var(--tf-warning)', border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)' }}
            >
              GitHub connector is not verified yet.
              <button
                type="button"
                onClick={() => onGitHubSetupRequired?.()}
                style={{ marginLeft: '6px', border: 'none', background: 'transparent', color: 'var(--tf-accent-blue)', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Open Settings
              </button>
            </div>
          )}
          {projectError && (
            <div className="mb-2">
              <InlineActionCard
                title="Project creation blocked"
                message={projectError}
                severity="error"
                actions={[
                  { id: 'retry-create', label: 'Retry create', kind: 'retry' },
                  ...(newProjectMode === 'github' ? [{ id: 'open-settings', label: 'Open GitHub settings', kind: 'open_settings' }] : []),
                ]}
                onAction={(action) => {
                  if (action.id === 'retry-create') {
                    void handleCreateProject();
                    return;
                  }
                  if (action.id === 'open-settings') {
                    onGitHubSetupRequired?.();
                  }
                }}
              />
            </div>
          )}
          <button
            onClick={handleCreateProject}
            disabled={!newProjectName.trim() || creatingProject || (newProjectMode === 'github' && !githubConfigured)}
            className="text-xs px-4 py-2 rounded-lg transition-colors"
            style={{
              backgroundColor: creatingProject ? 'var(--tf-surface-raised)' : 'var(--tf-accent)',
              color: creatingProject ? 'var(--tf-text-muted)' : 'var(--tf-bg)',
              border: 'none',
              cursor: creatingProject ? 'wait' : 'pointer',
            }}
          >
            {creatingProject ? 'Creating…' : 'Start Project'}
          </button>
        </div>
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
    <div className="flex gap-5 animate-fade-in" style={{ minHeight: 0, flexDirection: isNarrowViewport ? 'column' : 'row' }}>
      {/* Project list */}
      <div
        className="flex flex-col gap-3 overflow-y-auto"
        style={{
          flex: selectedProject && !isNarrowViewport ? '0 0 auto' : '1',
          width: selectedProject && !isNarrowViewport ? '300px' : '100%',
          maxWidth: selectedProject && !isNarrowViewport ? '300px' : 'none',
        }}
      >
        <div className="rounded-xl p-3" style={{ backgroundColor: 'var(--tf-surface)', border: '1px solid var(--tf-border)' }}>
          <div className="text-xs mb-2 font-semibold" style={{ color: 'var(--tf-text-secondary)' }}>Start New Project</div>
          <input
            type="text"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="Project name"
            style={{
              width: '100%',
              marginBottom: '8px',
              backgroundColor: 'var(--tf-bg)',
              border: '1px solid var(--tf-border)',
              borderRadius: '8px',
              color: 'var(--tf-text)',
              fontSize: '12px',
              padding: '7px 9px',
            }}
          />
          <FloatingSelect
            value={newProjectMode}
            options={projectModeOptions}
            onChange={(nextMode) => setNewProjectMode(nextMode === 'github' ? 'github' : 'local')}
            variant="card"
            searchable={false}
            ariaLabel="Project delivery mode"
            size="sm"
            style={{
              width: '100%',
              marginBottom: '8px',
            }}
          />
          {newProjectMode === 'github' && (
            <>
              <input
                type="text"
                value={newProjectRepo}
                onChange={(e) => setNewProjectRepo(e.target.value)}
                placeholder="owner/repo"
                style={{
                  width: '100%',
                  marginBottom: '8px',
                  backgroundColor: 'var(--tf-bg)',
                  border: '1px solid var(--tf-border)',
                  borderRadius: '8px',
                  color: 'var(--tf-text)',
                  fontSize: '12px',
                  padding: '7px 9px',
                }}
              />
              <input
                type="text"
                value={newProjectBranch}
                onChange={(e) => setNewProjectBranch(e.target.value)}
                placeholder="branch (master)"
                style={{
                  width: '100%',
                  marginBottom: '8px',
                  backgroundColor: 'var(--tf-bg)',
                  border: '1px solid var(--tf-border)',
                  borderRadius: '8px',
                  color: 'var(--tf-text)',
                  fontSize: '12px',
                  padding: '7px 9px',
                }}
              />
            </>
          )}
          {newProjectMode === 'github' && !githubConfigured && (
            <div
              className="text-xs mb-2 rounded-lg px-2 py-1.5"
              style={{ color: 'var(--tf-warning)', border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface-raised)' }}
            >
              GitHub connector is not verified yet.
              <button
                type="button"
                onClick={() => onGitHubSetupRequired?.()}
                style={{ marginLeft: '6px', border: 'none', background: 'transparent', color: 'var(--tf-accent-blue)', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Open Settings
              </button>
            </div>
          )}
          <button
            onClick={handleCreateProject}
            disabled={!newProjectName.trim() || creatingProject || (newProjectMode === 'github' && !githubConfigured)}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{
              backgroundColor: creatingProject ? 'var(--tf-surface-raised)' : 'var(--tf-accent)',
              color: creatingProject ? 'var(--tf-text-muted)' : 'var(--tf-bg)',
              border: 'none',
              cursor: creatingProject ? 'wait' : 'pointer',
              width: '100%',
            }}
          >
            {creatingProject ? 'Creating…' : 'Start Project'}
          </button>
          {projectError && (
            <div className="mt-2">
              <InlineActionCard
                title="Project creation blocked"
                message={projectError}
                severity="error"
                actions={[
                  { id: 'retry-create', label: 'Retry create', kind: 'retry' },
                  ...(newProjectMode === 'github' ? [{ id: 'open-settings', label: 'Open GitHub settings', kind: 'open_settings' }] : []),
                ]}
                onAction={(action) => {
                  if (action.id === 'retry-create') {
                    void handleCreateProject();
                    return;
                  }
                  if (action.id === 'open-settings') {
                    onGitHubSetupRequired?.();
                  }
                }}
              />
            </div>
          )}
        </div>
        {(workspaceMessage || workspaceError) && (
          <div
            className="rounded-lg px-3 py-2 text-xs"
            style={{
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-surface-raised)',
              color: workspaceError ? 'var(--tf-warning)' : 'var(--tf-success)',
            }}
          >
            {workspaceError || workspaceMessage}
          </div>
        )}
        {projects.map((project) => (
          <ProjectListCard
            key={project.id}
            project={project}
            selected={effectiveSelectedId === project.id}
            onSelect={() => handleSelect(project.id)}
            onOpenWorkspace={handleOpenWorkspace}
          />
        ))}
      </div>

      {/* Detail panel */}
      {selectedProject && (
        <div className="flex-1 overflow-hidden" style={{ minWidth: 0, minHeight: isNarrowViewport ? '520px' : 0 }}>
          <ProjectDetail
            project={selectedProject}
            tasks={selectedTasks}
            onClose={() => {
              setDeleteProjectError('');
              setTagsError('');
              setWorkspaceMessage('');
              setWorkspaceError('');
              setSelectedId(null);
              onSelectProject?.('');
            }}
            onOpenWorkspace={handleOpenWorkspace}
            onDelete={handleDeleteProject}
            deleting={deletingProjectId === selectedProject.id}
            deleteError={deleteProjectError}
            onSaveTags={handleSaveTags}
            savingTags={savingTags}
            tagsError={tagsError}
            workspaceMessage={workspaceMessage}
            workspaceError={workspaceError}
          />
        </div>
      )}
    </div>
  );
}
