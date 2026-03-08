import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Project,
  ProjectArtifactRecord,
  ProjectLaunchLink,
  ProjectReleaseNotes,
  Task,
} from '../types';
import {
  archiveProject,
  cloneProject,
  createProject,
  deleteProject as deleteProjectApi,
  fetchArchivedProjects,
  fetchProjectArtifacts,
  fetchProjectDetail,
  fetchProjectReleaseNotes,
  openProjectWorkspace,
  restoreProject,
  updateProjectTags as updateProjectTagsApi,
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
  onAskCEO?: (projectId: string) => void;
  defaultWorkspaceMode?: 'local' | 'github';
  defaultGithubRepo?: string;
  defaultGithubBranch?: string;
  githubConfigured?: boolean;
  onGitHubSetupRequired?: () => void;
}

type ProjectMode = 'local' | 'github';
type ProjectStatusFilter =
  | 'all'
  | 'planning'
  | 'queued'
  | 'executing'
  | 'validating'
  | 'delivered'
  | 'blocked'
  | 'failed'
  | 'archived';
type ProjectDeliveryFilter = 'all' | 'local' | 'github';
type ProjectSortMode = 'recent' | 'status' | 'name';
type UtilityKind = 'clone' | 'tags' | 'release-notes' | 'artifacts' | null;

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'ceo': 'CEO',
  'cto': 'CTO',
  'cfo': 'CFO',
  'ciso': 'CISO',
  'vp-product': 'Chief Product Officer',
  'vp-engineering': 'VP Eng',
  'chief-researcher': 'Research',
  'lead-backend': 'Backend',
  'lead-frontend': 'Frontend',
  'lead-designer': 'Designer',
  'qa-lead': 'QA',
  'devops': 'DevOps',
  'security-engineer': 'Security',
  'data-engineer': 'Data',
  'tech-writer': 'Writer',
};

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
    if (result.length >= 10) break;
  }
  return result;
}

function parseTagInput(value: string): string[] {
  return normalizeTagList(value.split(','));
}

function resolveTeamName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return AGENT_DISPLAY_NAMES[lower] || raw;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return 'Unknown';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return 'Unknown';
  const deltaMs = Math.max(0, Date.now() - ts);
  if (deltaMs < 60_000) return 'Just now';
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
}

function statusAccent(status: string): string {
  const value = String(status || '').toLowerCase();
  if (value === 'active' || value === 'queued' || value === 'executing') return 'var(--tf-success)';
  if (value === 'validating') return 'var(--tf-accent-blue)';
  if (value === 'completed' || value === 'delivered') return 'var(--tf-accent-blue)';
  if (value === 'planning') return 'var(--tf-accent)';
  if (value === 'failed') return 'var(--tf-error)';
  if (value === 'blocked') return 'var(--tf-error)';
  if (value === 'archived') return 'var(--tf-text-muted)';
  return 'var(--tf-text-secondary)';
}

function statusSurface(status: string): string {
  const value = String(status || '').toLowerCase();
  if (value === 'active' || value === 'queued' || value === 'executing') return 'rgba(63,185,80,0.12)';
  if (value === 'validating') return 'rgba(59,142,255,0.1)';
  if (value === 'completed' || value === 'delivered') return 'rgba(59,142,255,0.12)';
  if (value === 'planning') return 'rgba(90,169,255,0.09)';
  if (value === 'failed') return 'rgba(234,114,103,0.14)';
  if (value === 'blocked') return 'rgba(234,114,103,0.12)';
  if (value === 'archived') return 'rgba(180,190,210,0.08)';
  return 'var(--tf-surface-raised)';
}

function inferLifecycle(project: Project): string {
  const lifecycle = String(project.lifecycle_state || '').trim().toLowerCase();
  if (lifecycle) return lifecycle;
  const legacy = String(project.status || '').trim().toLowerCase();
  if (legacy === 'active') return 'executing';
  if (legacy === 'completed' || legacy === 'done') return 'delivered';
  if (legacy === 'blocked') return 'blocked';
  if (legacy === 'archived') return 'archived';
  return 'planning';
}

function lifecycleToLegacyStatus(lifecycle: string): string {
  const normalized = String(lifecycle || '').trim().toLowerCase();
  if (normalized === 'planning') return 'planning';
  if (normalized === 'queued' || normalized === 'executing' || normalized === 'validating') return 'active';
  if (normalized === 'delivered') return 'completed';
  if (normalized === 'failed' || normalized === 'blocked') return 'blocked';
  if (normalized === 'archived') return 'archived';
  return 'planning';
}

function lifecycleLabel(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'Planning';
  return normalized.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function laneStatusColor(status: string): string {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'in_progress' || normalized === 'in progress') return 'var(--tf-accent-blue)';
  if (normalized === 'review') return 'var(--tf-warning)';
  if (normalized === 'done') return 'var(--tf-success)';
  if (normalized === 'blocked') return 'var(--tf-error)';
  return 'var(--tf-text-muted)';
}

function projectTeamLanes(project?: Project | null): Array<{ owner: string; headline: string; status: string }> {
  if (!project) return [];
  if (Array.isArray(project.team_lanes) && project.team_lanes.length > 0) return project.team_lanes;
  if (Array.isArray(project.high_level_tasks)) return project.high_level_tasks;
  return [];
}

function parseRunCommands(runInstructions?: string): string[] {
  return String(runInstructions || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function projectLaunchLinks(project: Project): ProjectLaunchLink[] {
  return Array.isArray(project.launch_links) ? project.launch_links : [];
}

function primaryLaunchUrl(project: Project): ProjectLaunchLink | null {
  const launchUrl = projectLaunchLinks(project).find((link) => link.kind === 'url' && /^https?:\/\//i.test(link.target));
  return launchUrl || null;
}

function buildLaunchPack(project: Project): string {
  const commands = parseRunCommands(project.run_instructions);
  const launchLinks = projectLaunchLinks(project);
  const lines = [
    `Project: ${project.name}`,
    '',
    'Run Commands:',
    ...(commands.length > 0 ? commands.map((command) => `- ${command}`) : ['- No run commands captured.']),
    '',
    'Launch Links:',
    ...(launchLinks.length > 0 ? launchLinks.map((link) => `- ${link.label}: ${link.target}`) : ['- No launch links captured.']),
  ];
  if (project.workspace_path) {
    lines.push('', `Workspace: ${project.workspace_path}`);
  }
  return lines.join('\n');
}

function sortProjects(projects: Project[], sortMode: ProjectSortMode): Project[] {
  const statusRank = (status: string): number => {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'executing') return 0;
    if (normalized === 'queued') return 1;
    if (normalized === 'validating') return 2;
    if (normalized === 'planning') return 3;
    if (normalized === 'blocked') return 4;
    if (normalized === 'failed') return 5;
    if (normalized === 'delivered') return 6;
    if (normalized === 'archived') return 7;
    return 5;
  };

  const sorted = [...projects];
  sorted.sort((a, b) => {
    if (sortMode === 'name') {
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    }
    if (sortMode === 'status') {
      const rankDelta = statusRank(inferLifecycle(a)) - statusRank(inferLifecycle(b));
      if (rankDelta !== 0) return rankDelta;
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    }
    const aTs = new Date(String(a.last_run?.updated_at || a.updated_at || a.created_at || '')).getTime() || 0;
    const bTs = new Date(String(b.last_run?.updated_at || b.updated_at || b.created_at || '')).getTime() || 0;
    if (bTs !== aTs) return bTs - aTs;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });
  return sorted;
}

function matchesProject(
  project: Project,
  query: string,
  status: ProjectStatusFilter,
  delivery: ProjectDeliveryFilter,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  const lifecycle = inferLifecycle(project);
  const projectStatus = lifecycleToLegacyStatus(lifecycle);
  const deliveryMode = String(project.delivery_mode || 'local').toLowerCase();
  if (status !== 'all') {
    const target = String(status || '').toLowerCase();
    if (target === 'delivered') {
      if (lifecycle !== 'delivered') return false;
    } else if (target === 'failed') {
      if (lifecycle !== 'failed') return false;
    } else if (target === 'queued' || target === 'executing' || target === 'validating' || target === 'planning' || target === 'blocked' || target === 'archived') {
      if (lifecycle !== target) return false;
    } else if (projectStatus !== target) {
      return false;
    }
  }
  if (delivery !== 'all' && deliveryMode !== delivery) return false;
  if (!normalizedQuery) return true;
  const haystack = [
    project.name,
    project.description,
    ...(project.team || []),
    ...(project.tags || []),
    ...(projectTeamLanes(project).map((lane) => `${lane.owner} ${lane.headline}`)),
  ].join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

function buttonStyle(primary = false, disabled = false): React.CSSProperties {
  return {
    border: primary ? 'none' : '1px solid var(--tf-border)',
    backgroundColor: primary ? 'var(--tf-accent)' : 'var(--tf-surface-raised)',
    color: primary ? 'var(--tf-bg)' : 'var(--tf-text-secondary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    borderRadius: '10px',
    padding: '8px 12px',
    fontSize: '12px',
    fontWeight: 600,
  };
}

function actionChipStyle(): React.CSSProperties {
  return {
    border: '1px solid var(--tf-border)',
    backgroundColor: 'var(--tf-bg)',
    color: 'var(--tf-text-secondary)',
    cursor: 'pointer',
    borderRadius: '999px',
    padding: '5px 10px',
    fontSize: '11px',
    fontWeight: 600,
  };
}

interface ProjectRailCardProps {
  project: Project;
  selected: boolean;
  archived: boolean;
  onSelect: () => void;
  onAskCEO?: () => void;
  onOpenWorkspace?: () => void;
  onCopyLaunchPack?: () => void;
}

function ProjectRailCard({
  project,
  selected,
  archived,
  onSelect,
  onAskCEO,
  onOpenWorkspace,
  onCopyLaunchPack,
}: ProjectRailCardProps) {
  const teamLanes = projectTeamLanes(project).slice(0, 3);
  const launchUrl = primaryLaunchUrl(project);
  const commands = parseRunCommands(project.run_instructions);
  const freshness = formatRelativeTime(project.last_run?.updated_at || project.updated_at || project.created_at);
  const lifecycle = inferLifecycle(project);
  const lifecycleText = lifecycleLabel(lifecycle);
  const statusColor = statusAccent(lifecycle);
  const statusBg = statusSurface(lifecycle);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={selected ? 'project-card-completed-glow' : undefined}
      style={{
        width: '100%',
        textAlign: 'left',
        borderRadius: '18px',
        border: `1px solid ${selected ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
        background: selected
          ? 'linear-gradient(180deg, color-mix(in srgb, var(--tf-accent-blue) 10%, var(--tf-surface)) 0%, var(--tf-surface) 100%)'
          : 'linear-gradient(180deg, color-mix(in srgb, var(--tf-surface-raised) 55%, transparent) 0%, var(--tf-surface) 100%)',
        padding: '15px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        cursor: 'pointer',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div style={{ minWidth: 0 }}>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold truncate" style={{ color: 'var(--tf-text)' }}>
              {project.name}
            </p>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: statusColor,
                backgroundColor: statusBg,
                border: `1px solid color-mix(in srgb, ${statusColor} 30%, transparent)`,
              }}
            >
              {lifecycleText}
            </span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'var(--tf-text-muted)',
                backgroundColor: 'var(--tf-bg)',
                border: '1px solid var(--tf-border)',
              }}
            >
              {project.delivery_mode === 'github' ? 'GitHub' : 'Local'}
            </span>
          </div>
          <p className="text-[11px] mt-1" style={{ color: 'var(--tf-text-muted)' }}>
            {archived ? 'Archived' : `Updated ${freshness}`}
          </p>
        </div>
        <span
          aria-hidden="true"
          style={{
            width: '11px',
            height: '11px',
            borderRadius: '999px',
            flexShrink: 0,
            marginTop: '4px',
            backgroundColor: statusColor,
            boxShadow: `0 0 10px color-mix(in srgb, ${statusColor} 45%, transparent)`,
          }}
        />
      </div>

      <p
        className="text-xs"
        style={{
          color: 'var(--tf-text-secondary)',
          lineHeight: 1.55,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: '38px',
        }}
      >
        {project.description || 'No brief yet. Ask the CEO to update this project.'}
      </p>

      <div className="flex flex-wrap gap-2">
        <span className="text-[10px]" style={{ color: commands.length > 0 ? 'var(--tf-success)' : 'var(--tf-text-muted)' }}>
          {commands.length > 0 ? 'Run ready' : 'Run missing'}
        </span>
        <span className="text-[10px]" style={{ color: launchUrl ? 'var(--tf-accent-blue)' : 'var(--tf-text-muted)' }}>
          {launchUrl ? 'App link ready' : 'App link missing'}
        </span>
        <span className="text-[10px]" style={{ color: project.workspace_path ? 'var(--tf-text-secondary)' : 'var(--tf-text-muted)' }}>
          {project.workspace_path ? 'Workspace ready' : 'Workspace missing'}
        </span>
      </div>

      {teamLanes.length > 0 && (
        <div
          style={{
            borderRadius: '12px',
            border: '1px solid var(--tf-border)',
            backgroundColor: 'color-mix(in srgb, var(--tf-bg) 80%, transparent)',
            padding: '10px',
          }}
        >
          <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Team Lanes
          </p>
          <div className="space-y-1.5">
            {teamLanes.map((lane, index) => (
              <div key={`${lane.owner}-${index}`} className="flex items-start gap-2">
                <span
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '999px',
                    backgroundColor: laneStatusColor(lane.status),
                    flexShrink: 0,
                    marginTop: '4px',
                  }}
                />
                <p className="text-[11px]" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.4 }}>
                  <span style={{ color: 'var(--tf-text)', fontWeight: 700 }}>{resolveTeamName(lane.owner)}</span>{' '}
                  {lane.headline}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!archived && onAskCEO && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAskCEO();
            }}
            style={actionChipStyle()}
          >
            Ask CEO
          </button>
        )}
        {project.workspace_path && onOpenWorkspace && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenWorkspace();
            }}
            style={actionChipStyle()}
          >
            Workspace
          </button>
        )}
        {onCopyLaunchPack && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCopyLaunchPack();
            }}
            style={actionChipStyle()}
          >
            Copy Launch Pack
          </button>
        )}
      </div>
    </div>
  );
}

interface DrawerShellProps {
  open: boolean;
  title: string;
  subtitle: string;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}

function DrawerShell({ open, title, subtitle, onClose, width = 380, children }: DrawerShellProps) {
  if (!open) return null;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(2, 8, 23, 0.45)',
        backdropFilter: 'blur(2px)',
      }}
      onClick={onClose}
    >
      <div
        className="animate-slide-in-right"
        style={{
          width: `min(${width}px, 100vw)`,
          height: '100%',
          borderLeft: '1px solid var(--tf-border)',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--tf-surface-raised) 40%, var(--tf-surface)) 0%, var(--tf-surface) 100%)',
          padding: '20px',
          overflowY: 'auto',
          boxShadow: '-14px 0 40px rgba(0,0,0,0.28)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4" style={{ marginBottom: '18px' }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>{title}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)', lineHeight: 1.5 }}>{subtitle}</p>
          </div>
          <button type="button" aria-label={`Close ${title}`} onClick={onClose} style={actionChipStyle()}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface CreateProjectDrawerProps {
  open: boolean;
  onClose: () => void;
  projectModeOptions: Array<{ value: string; label: string; description?: string; badge?: string; keywords?: string[] }>;
  githubConfigured: boolean;
  newProjectName: string;
  setNewProjectName: (value: string) => void;
  newProjectDescription: string;
  setNewProjectDescription: (value: string) => void;
  newProjectMode: ProjectMode;
  setNewProjectMode: (value: ProjectMode) => void;
  newProjectRepo: string;
  setNewProjectRepo: (value: string) => void;
  newProjectBranch: string;
  setNewProjectBranch: (value: string) => void;
  creatingProject: boolean;
  projectError: string;
  onCreate: () => void;
  onGitHubSetupRequired?: () => void;
}

function CreateProjectDrawer({
  open,
  onClose,
  projectModeOptions,
  githubConfigured,
  newProjectName,
  setNewProjectName,
  newProjectDescription,
  setNewProjectDescription,
  newProjectMode,
  setNewProjectMode,
  newProjectRepo,
  setNewProjectRepo,
  newProjectBranch,
  setNewProjectBranch,
  creatingProject,
  projectError,
  onCreate,
  onGitHubSetupRequired,
}: CreateProjectDrawerProps) {
  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      title="New Project"
      subtitle="Start a project from a clean, focused drawer instead of carrying creation controls inside the rail."
      width={420}
    >
      {projectError && (
        <div style={{ marginBottom: '14px' }}>
          <InlineActionCard
            title="Project creation blocked"
            message={projectError}
            severity="error"
            actions={[
              { id: 'retry-create', label: 'Retry create', kind: 'retry' },
              ...(newProjectMode === 'github'
                ? [{ id: 'open-settings', label: 'Open GitHub settings', kind: 'open_settings' } as const]
                : []),
            ]}
            onAction={(action) => {
              if (action.id === 'retry-create') {
                onCreate();
                return;
              }
              if (action.id === 'open-settings') {
                onGitHubSetupRequired?.();
              }
            }}
          />
        </div>
      )}
      <div className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Project name
          </p>
          <input
            type="text"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            placeholder="CashTracker, Launch Desk, FounderOS..."
            style={{
              width: '100%',
              borderRadius: '12px',
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-bg)',
              color: 'var(--tf-text)',
              padding: '10px 12px',
              fontSize: '13px',
            }}
          />
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Brief
          </p>
          <textarea
            value={newProjectDescription}
            onChange={(event) => setNewProjectDescription(event.target.value)}
            placeholder="A short sentence about what this project should become."
            style={{
              width: '100%',
              minHeight: '96px',
              borderRadius: '12px',
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-bg)',
              color: 'var(--tf-text)',
              padding: '10px 12px',
              fontSize: '13px',
              resize: 'vertical',
            }}
          />
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
            Delivery mode
          </p>
          <FloatingSelect
            value={newProjectMode}
            options={projectModeOptions}
            onChange={(value) => setNewProjectMode(value === 'github' ? 'github' : 'local')}
            ariaLabel="Project delivery mode"
            searchable={false}
            variant="card"
            size="sm"
            style={{ width: '100%' }}
          />
        </div>
        {newProjectMode === 'github' && (
          <div className="space-y-3">
            <input
              type="text"
              value={newProjectRepo}
              onChange={(event) => setNewProjectRepo(event.target.value)}
              placeholder="owner/repo"
              style={{
                width: '100%',
                borderRadius: '12px',
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-bg)',
                color: 'var(--tf-text)',
                padding: '10px 12px',
                fontSize: '13px',
              }}
            />
            <input
              type="text"
              value={newProjectBranch}
              onChange={(event) => setNewProjectBranch(event.target.value)}
              placeholder="branch (main)"
              style={{
                width: '100%',
                borderRadius: '12px',
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-bg)',
                color: 'var(--tf-text)',
                padding: '10px 12px',
                fontSize: '13px',
              }}
            />
            {!githubConfigured && (
              <InlineActionCard
                title="GitHub connector required"
                message="GitHub projects need a verified connector before COMPaaS can route branches and repository actions."
                severity="warning"
                actions={[{ id: 'open-github-settings', label: 'Open Settings', kind: 'open_settings' }]}
                onAction={(action) => {
                  if (action.id === 'open-github-settings') {
                    onGitHubSetupRequired?.();
                  }
                }}
              />
            )}
          </div>
        )}
        <div className="flex items-center gap-2 justify-end">
          <button type="button" onClick={onClose} style={buttonStyle(false)}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={!newProjectName.trim() || creatingProject || (newProjectMode === 'github' && !githubConfigured)}
            style={buttonStyle(true, !newProjectName.trim() || creatingProject || (newProjectMode === 'github' && !githubConfigured))}
          >
            {creatingProject ? 'Creating…' : 'Create Project'}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

interface UtilityDrawerProps {
  open: boolean;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}

function UtilityDrawer({ open, title, subtitle, onClose, children }: UtilityDrawerProps) {
  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width={420}
    >
      {children}
    </DrawerShell>
  );
}

function UtilitySection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: '14px' }}>
      <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>
        {label}
      </p>
      {children}
    </section>
  );
}

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
  onAskCEO,
  defaultWorkspaceMode = 'local',
  defaultGithubRepo = '',
  defaultGithubBranch = 'master',
  githubConfigured = false,
  onGitHubSetupRequired,
}: ProjectPanelProps) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [showCreateDrawer, setShowCreateDrawer] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);
  const [detailTasks, setDetailTasks] = useState<Task[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailReloadNonce, setDetailReloadNonce] = useState(0);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>('all');
  const [deliveryFilter, setDeliveryFilter] = useState<ProjectDeliveryFilter>('all');
  const [sortMode, setSortMode] = useState<ProjectSortMode>('recent');
  const [projectError, setProjectError] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [newProjectMode, setNewProjectMode] = useState<ProjectMode>(defaultWorkspaceMode === 'github' ? 'github' : 'local');
  const [newProjectRepo, setNewProjectRepo] = useState(defaultGithubRepo);
  const [newProjectBranch, setNewProjectBranch] = useState(defaultGithubBranch || 'master');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [utilityKind, setUtilityKind] = useState<UtilityKind>(null);
  const [utilityLoading, setUtilityLoading] = useState(false);
  const [utilityError, setUtilityError] = useState('');
  const [utilityNotes, setUtilityNotes] = useState<ProjectReleaseNotes | null>(null);
  const [utilityArtifacts, setUtilityArtifacts] = useState<ProjectArtifactRecord[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const detailAbortRef = useRef<AbortController | null>(null);

  const deferredFilterText = useDeferredValue(filterText);
  const isNarrowViewport = viewportWidth <= 1100;

  const projectModeOptions = useMemo(() => ([
    {
      value: 'local',
      label: 'Local workspace',
      description: 'Write project files under the COMPaaS projects folder.',
      badge: 'Ready',
      keywords: ['local', 'workspace'],
    },
    {
      value: 'github',
      label: 'GitHub repository',
      description: githubConfigured ? 'Route delivery into a connected repository.' : 'GitHub connector setup is required.',
      badge: githubConfigured ? 'Ready' : 'Setup required',
      keywords: ['github', 'repo', 'branch'],
    },
  ]), [githubConfigured]);

  const statusOptions = useMemo(() => ([
    { value: 'all', label: 'All statuses' },
    { value: 'planning', label: 'Planning' },
    { value: 'queued', label: 'Queued' },
    { value: 'executing', label: 'Executing' },
    { value: 'validating', label: 'Validating' },
    { value: 'delivered', label: 'Delivered' },
    { value: 'blocked', label: 'Blocked' },
    { value: 'failed', label: 'Failed' },
    { value: 'archived', label: 'Archived' },
  ]), []);

  const deliveryOptions = useMemo(() => ([
    { value: 'all', label: 'All locations' },
    { value: 'local', label: 'Local workspace' },
    { value: 'github', label: 'GitHub repo' },
  ]), []);

  const sortOptions = useMemo(() => ([
    { value: 'recent', label: 'Recently updated' },
    { value: 'status', label: 'Status' },
    { value: 'name', label: 'Name' },
  ]), []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
    if (initialProjectId) {
      setSelectedId(initialProjectId);
      onProjectIdConsumed?.();
      return;
    }
    if (!selectedId && selectedProjectId) {
      setSelectedId(selectedProjectId);
    }
  }, [initialProjectId, onProjectIdConsumed, selectedId, selectedProjectId]);

  const loadArchived = async () => {
    setArchivedLoading(true);
    const list = await fetchArchivedProjects();
    setArchivedProjects(Array.isArray(list) ? list : []);
    setArchivedLoading(false);
  };

  useEffect(() => {
    void loadArchived();
  }, []);

  const activeProjects = useMemo(
    () => projects.filter((project) => inferLifecycle(project) !== 'archived'),
    [projects],
  );
  const archivedIds = useMemo(() => new Set(archivedProjects.map((project) => project.id)), [archivedProjects]);
  const selectedIsArchived = Boolean(selectedId && archivedIds.has(selectedId) && !activeProjects.some((project) => project.id === selectedId));
  const selectedSummaryProject = useMemo(
    () => [...activeProjects, ...archivedProjects].find((project) => project.id === selectedId) || null,
    [activeProjects, archivedProjects, selectedId],
  );

  useEffect(() => {
    if (!selectedId) {
      setDetailProject(null);
      setDetailTasks([]);
      setDetailError('');
      return;
    }
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setDetailLoading(true);
    setDetailError('');
    void fetchProjectDetail(selectedId, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setDetailProject(payload.project || selectedSummaryProject);
        setDetailTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setDetailProject(selectedSummaryProject);
        setDetailTasks(tasksByProject[selectedId] || []);
        setDetailError('Unable to load fresh project detail. Showing cached data when available.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDetailLoading(false);
        }
      });
    return () => controller.abort();
  }, [detailReloadNonce, selectedId, selectedSummaryProject, tasksByProject]);

  useEffect(() => {
    const target = detailProject || selectedSummaryProject;
    if (!target) {
      setTagDraft('');
      setCloneName('');
      return;
    }
    setTagDraft(normalizeTagList(target.tags || []).join(', '));
    setCloneName(`${target.name} Copy`);
  }, [detailProject, selectedSummaryProject]);

  const selectedProject = detailProject || selectedSummaryProject;
  const selectedTasks = detailTasks.length > 0
    ? detailTasks
    : selectedProject
      ? (tasksByProject[selectedProject.id] || [])
      : [];

  const filteredActiveProjects = useMemo(() => {
    const baseStatus = statusFilter === 'archived' ? 'all' : statusFilter;
    return sortProjects(
      activeProjects.filter((project) => matchesProject(project, deferredFilterText, baseStatus, deliveryFilter)),
      sortMode,
    );
  }, [activeProjects, deferredFilterText, deliveryFilter, sortMode, statusFilter]);

  const filteredArchivedProjects = useMemo(() => {
    if (!showArchived) return [];
    const effectiveStatus = statusFilter === 'all' || statusFilter === 'archived' ? 'all' : statusFilter;
    return sortProjects(
      archivedProjects.filter((project) => matchesProject(project, deferredFilterText, effectiveStatus, deliveryFilter)),
      sortMode,
    );
  }, [archivedProjects, deferredFilterText, deliveryFilter, showArchived, sortMode, statusFilter]);

  const summaryCounts = useMemo(() => {
    const counts = { active: 0, planning: 0, completed: 0, blocked: 0 };
    for (const project of activeProjects) {
      const lifecycle = inferLifecycle(project);
      if (lifecycle === 'planning') counts.planning += 1;
      if (lifecycle === 'delivered') counts.completed += 1;
      if (lifecycle === 'blocked' || lifecycle === 'failed') counts.blocked += 1;
      if (lifecycle === 'queued' || lifecycle === 'executing' || lifecycle === 'validating') counts.active += 1;
    }
    return counts;
  }, [activeProjects]);

  const visibleProjectsCount = filteredActiveProjects.length + filteredArchivedProjects.length;

  const closeUtility = () => {
    setUtilityKind(null);
    setUtilityLoading(false);
    setUtilityError('');
    setMenuOpen(false);
  };

  const setSuccess = (message: string) => {
    setFeedbackMessage(message);
    setFeedbackError('');
  };

  const setError = (message: string) => {
    setFeedbackError(message);
    setFeedbackMessage('');
  };

  const handleSelect = (projectId: string, archived = false) => {
    setSelectedId(projectId);
    setMenuOpen(false);
    setFeedbackError('');
    setFeedbackMessage('');
    if (archived) return;
    onSelectProject?.(projectId);
  };

  const handleCloseSelectedProject = () => {
    if (selectedProject && !selectedIsArchived) {
      onSelectProject?.('');
    }
    setSelectedId(null);
    setDetailProject(null);
    setDetailTasks([]);
    setMenuOpen(false);
  };

  const handleOpenWorkspace = async (project: Project) => {
    if (!project.id) return;
    const result = await openProjectWorkspace(project.id);
    if (result.ok && result.data?.opened) {
      setSuccess(result.data.detail || 'Workspace folder opened.');
      return;
    }
    const detail = result.detail || result.data?.detail || 'Unable to open workspace folder.';
    const workspacePath = String(project.workspace_path || '').trim();
    if (workspacePath) {
      void navigator.clipboard.writeText(workspacePath).catch(() => undefined);
      setError(`${detail} Path copied to clipboard.`);
      return;
    }
    setError(detail);
  };

  const handleCopyLaunchPack = async (project: Project) => {
    await navigator.clipboard.writeText(buildLaunchPack(project));
    setSuccess('Launch pack copied.');
  };

  const handleOpenApp = (project: Project) => {
    const launchLink = primaryLaunchUrl(project);
    if (!launchLink) {
      setError('No app link is available for this project yet.');
      return;
    }
    window.open(launchLink.target, '_blank', 'noopener,noreferrer');
    setSuccess(`Opened ${launchLink.label}.`);
  };

  const handleAskCEO = (project: Project) => {
    if (!project.id || selectedIsArchived) return;
    onAskCEO?.(project.id);
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name || creatingProject) return;
    if (newProjectMode === 'github' && !newProjectRepo.trim()) {
      setProjectError('GitHub mode requires a repository in owner/repo format.');
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
    if (created.status !== 'ok' || !created.project?.id) {
      const createError = created.error;
      if (createError?.code === 'github_not_configured' || createError?.settings_target === 'github') {
        setProjectError(createError.message || 'GitHub connector is not configured.');
        onGitHubSetupRequired?.();
        return;
      }
      setProjectError(createError?.message || 'Unable to create project.');
      return;
    }
    setNewProjectName('');
    setNewProjectDescription('');
    setNewProjectMode(defaultWorkspaceMode === 'github' ? 'github' : 'local');
    setNewProjectRepo(defaultGithubRepo);
    setNewProjectBranch(defaultGithubBranch || 'master');
    setShowCreateDrawer(false);
    setSuccess('Project created.');
    onProjectCreated?.(created.project.id);
    onRefresh?.();
    onSelectProject?.(created.project.id);
    setSelectedId(created.project.id);
  };

  const handleDeleteProject = async () => {
    if (!selectedProject || busyAction) return;
    const confirmed = window.confirm(
      `Delete project "${selectedProject.name}"?\n\nThis permanently deletes the project data and its workspace files.`,
    );
    if (!confirmed) return;
    setBusyAction('delete');
    const result = await deleteProjectApi(selectedProject.id);
    setBusyAction('');
    if (!result.ok) {
      setError(result.detail || 'Unable to delete project.');
      return;
    }
    setMenuOpen(false);
    setSuccess(result.detail ? `Project deleted. ${result.detail}` : 'Project deleted.');
    setSelectedId(null);
    setDetailProject(null);
    setDetailTasks([]);
    onSelectProject?.('');
    onRefresh?.();
    void loadArchived();
  };

  const handleArchiveProject = async () => {
    if (!selectedProject || busyAction) return;
    const confirmed = window.confirm(`Archive "${selectedProject.name}"?`);
    if (!confirmed) return;
    setBusyAction('archive');
    const result = await archiveProject(selectedProject.id);
    setBusyAction('');
    if (!result.ok) {
      setError(result.detail || 'Unable to archive project.');
      return;
    }
    setMenuOpen(false);
    setShowArchived(true);
    setSelectedId(selectedProject.id);
    onSelectProject?.('');
    onRefresh?.();
    await loadArchived();
    setSuccess('Project archived.');
  };

  const handleRestoreProject = async () => {
    if (!selectedProject || busyAction) return;
    setBusyAction('restore');
    const result = await restoreProject(selectedProject.id);
    setBusyAction('');
    if (!result.ok) {
      setError(result.detail || 'Unable to restore project.');
      return;
    }
    setMenuOpen(false);
    await loadArchived();
    onRefresh?.();
    onSelectProject?.(selectedProject.id);
    setSelectedId(selectedProject.id);
    setShowArchived(false);
    setSuccess('Project restored.');
  };

  const handleOpenUtility = async (kind: UtilityKind) => {
    if (!selectedProject || !kind) return;
    setUtilityKind(kind);
    setUtilityLoading(kind === 'release-notes' || kind === 'artifacts');
    setUtilityError('');
    setMenuOpen(false);
    if (kind === 'release-notes') {
      const result = await fetchProjectReleaseNotes(selectedProject.id);
      if (!result.ok || !result.data) {
        setUtilityNotes(null);
        setUtilityError(result.detail || 'Unable to load release notes.');
        setUtilityLoading(false);
        return;
      }
      setUtilityNotes(result.data);
      setUtilityArtifacts([]);
      setUtilityLoading(false);
      return;
    }
    if (kind === 'artifacts') {
      const result = await fetchProjectArtifacts(selectedProject.id);
      if (!result.ok) {
        setUtilityArtifacts([]);
        setUtilityError(result.detail || 'Unable to load artifacts.');
        setUtilityLoading(false);
        return;
      }
      setUtilityArtifacts(Array.isArray(result.data?.artifacts) ? result.data!.artifacts! : []);
      setUtilityNotes(null);
      setUtilityLoading(false);
      return;
    }
    setUtilityNotes(null);
    setUtilityArtifacts([]);
  };

  const handleCloneProject = async () => {
    if (!selectedProject || !cloneName.trim() || busyAction) return;
    setBusyAction('clone');
    const result = await cloneProject(selectedProject.id, cloneName.trim());
    setBusyAction('');
    if (!result.ok || !result.data?.project?.id) {
      setUtilityError(result.detail || 'Unable to clone project.');
      return;
    }
    setUtilityKind(null);
    onRefresh?.();
    setSelectedId(result.data.project.id);
    onSelectProject?.(result.data.project.id);
    setSuccess('Project cloned.');
  };

  const handleSaveTags = async () => {
    if (!selectedProject || busyAction) return;
    setBusyAction('tags');
    const result = await updateProjectTagsApi(selectedProject.id, parseTagInput(tagDraft));
    setBusyAction('');
    if (!result.ok) {
      setUtilityError(result.detail || 'Unable to update tags.');
      return;
    }
    setUtilityKind(null);
    onRefresh?.();
    setDetailProject((current) => current ? { ...current, tags: parseTagInput(tagDraft) } : current);
    setSuccess('Project tags updated.');
  };

  const activeProjectForRail = filteredActiveProjects;
  const showArchivedToggle = archivedProjects.length > 0 || archivedLoading || showArchived;
  const qualitySnapshot = selectedProject?.quality_latest?.quality_report;
  const teamMembers = useMemo(() => {
    if (!selectedProject) return [] as string[];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const member of selectedProject.team || []) {
      const name = String(member || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      ordered.push(name);
    }
    for (const lane of projectTeamLanes(selectedProject)) {
      const owner = String(lane.owner || '').trim();
      if (!owner || seen.has(owner)) continue;
      seen.add(owner);
      ordered.push(owner);
    }
    for (const task of selectedTasks) {
      const assignee = String(task.assigned_to || '').trim();
      if (!assignee || seen.has(assignee)) continue;
      seen.add(assignee);
      ordered.push(assignee);
    }
    return ordered;
  }, [selectedProject, selectedTasks]);

  const lanesByOwner = useMemo(() => {
    const grouped = new Map<string, Array<{ headline: string; status: string }>>();
    for (const lane of projectTeamLanes(selectedProject)) {
      const owner = String(lane.owner || '').trim();
      const headline = String(lane.headline || '').trim();
      if (!owner || !headline) continue;
      const list = grouped.get(owner) || [];
      list.push({ headline, status: String(lane.status || '').trim() });
      grouped.set(owner, list);
    }
    return grouped;
  }, [selectedProject]);

  const tasksByAssignee = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const task of selectedTasks) {
      const assignee = String(task.assigned_to || '').trim();
      const title = String(task.title || '').trim();
      if (!assignee || !title) continue;
      const list = grouped.get(assignee) || [];
      if (!list.includes(title)) list.push(title);
      grouped.set(assignee, list);
    }
    return grouped;
  }, [selectedTasks]);

  const launchLinks = selectedProject ? projectLaunchLinks(selectedProject) : [];
  const runCommands = selectedProject ? parseRunCommands(selectedProject.run_instructions) : [];
  const launchUrl = selectedProject ? primaryLaunchUrl(selectedProject) : null;
  const selectedLifecycle = selectedProject ? inferLifecycle(selectedProject) : '';
  const selectedLifecycleLabel = lifecycleLabel(selectedLifecycle);
  const selectedLifecycleAccent = statusAccent(selectedLifecycle);
  const selectedLifecycleSurface = statusSurface(selectedLifecycle);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((row) => (
          <div key={row} className="rounded-xl p-4 skeleton" style={{ height: '88px' }} />
        ))}
      </div>
    );
  }

  const hasNoProjects = activeProjects.length === 0 && archivedProjects.length === 0;

  return (
    <div style={{ position: 'relative', minHeight: 0 }}>
      <CreateProjectDrawer
        open={showCreateDrawer}
        onClose={() => setShowCreateDrawer(false)}
        projectModeOptions={projectModeOptions}
        githubConfigured={githubConfigured}
        newProjectName={newProjectName}
        setNewProjectName={setNewProjectName}
        newProjectDescription={newProjectDescription}
        setNewProjectDescription={setNewProjectDescription}
        newProjectMode={newProjectMode}
        setNewProjectMode={setNewProjectMode}
        newProjectRepo={newProjectRepo}
        setNewProjectRepo={setNewProjectRepo}
        newProjectBranch={newProjectBranch}
        setNewProjectBranch={setNewProjectBranch}
        creatingProject={creatingProject}
        projectError={projectError}
        onCreate={handleCreateProject}
        onGitHubSetupRequired={onGitHubSetupRequired}
      />

      <UtilityDrawer
        open={Boolean(selectedProject && utilityKind)}
        onClose={closeUtility}
        title={
          utilityKind === 'clone' ? 'Clone Project'
            : utilityKind === 'tags' ? 'Edit Tags'
              : utilityKind === 'release-notes' ? 'Release Notes'
                : 'Artifacts'
        }
        subtitle={
          utilityKind === 'clone' ? 'Create a new project from the current one without leaving the hub.'
            : utilityKind === 'tags' ? 'Manage tags without adding form clutter to the main project brief.'
              : utilityKind === 'release-notes' ? 'View the latest generated release notes for this project.'
                : 'Review the latest artifacts registered for this project.'
        }
      >
        {utilityError && (
          <div style={{ marginBottom: '14px' }}>
            <InlineActionCard
              title="Project tool failed"
              message={utilityError}
              severity="error"
              actions={[]}
            />
          </div>
        )}
        {utilityKind === 'clone' && (
          <div>
            <UtilitySection label="Clone name">
              <input
                type="text"
                value={cloneName}
                onChange={(event) => setCloneName(event.target.value)}
                style={{
                  width: '100%',
                  borderRadius: '12px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-bg)',
                  color: 'var(--tf-text)',
                  padding: '10px 12px',
                  fontSize: '13px',
                }}
              />
            </UtilitySection>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleCloneProject}
                disabled={!cloneName.trim() || busyAction === 'clone'}
                style={buttonStyle(true, !cloneName.trim() || busyAction === 'clone')}
              >
                {busyAction === 'clone' ? 'Cloning…' : 'Clone Project'}
              </button>
            </div>
          </div>
        )}
        {utilityKind === 'tags' && (
          <div>
            <UtilitySection label="Tags">
              <input
                type="text"
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                placeholder="frontend, urgent, billing"
                style={{
                  width: '100%',
                  borderRadius: '12px',
                  border: '1px solid var(--tf-border)',
                  backgroundColor: 'var(--tf-bg)',
                  color: 'var(--tf-text)',
                  padding: '10px 12px',
                  fontSize: '13px',
                }}
              />
            </UtilitySection>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveTags}
                disabled={busyAction === 'tags'}
                style={buttonStyle(true, busyAction === 'tags')}
              >
                {busyAction === 'tags' ? 'Saving…' : 'Save Tags'}
              </button>
            </div>
          </div>
        )}
        {utilityKind === 'release-notes' && (
          <div>
            {utilityLoading ? (
              <div className="rounded-xl p-4 skeleton" style={{ height: '220px' }} />
            ) : (
              <UtilitySection label="Latest notes">
                <pre
                  style={{
                    borderRadius: '14px',
                    border: '1px solid var(--tf-border)',
                    backgroundColor: 'var(--tf-bg)',
                    color: 'var(--tf-text-secondary)',
                    padding: '14px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: '12px',
                    lineHeight: 1.55,
                    maxHeight: '60vh',
                    overflowY: 'auto',
                  }}
                >
                  {utilityNotes?.notes || 'No release notes available.'}
                </pre>
              </UtilitySection>
            )}
          </div>
        )}
        {utilityKind === 'artifacts' && (
          <div>
            {utilityLoading ? (
              <div className="rounded-xl p-4 skeleton" style={{ height: '220px' }} />
            ) : (
              <UtilitySection label="Registered artifacts">
                {utilityArtifacts.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                    No artifacts registered for this project yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {utilityArtifacts.map((artifact, index) => (
                      <div
                        key={`${artifact.file_path}-${index}`}
                        className="rounded-xl"
                        style={{
                          border: '1px solid var(--tf-border)',
                          backgroundColor: 'var(--tf-bg)',
                          padding: '10px 12px',
                        }}
                      >
                        <p className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>
                          {artifact.file_path}
                        </p>
                        <p className="text-[11px] mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                          {artifact.action || 'updated'}{artifact.timestamp ? ` · ${formatRelativeTime(artifact.timestamp)}` : ''}{artifact.agent ? ` · ${artifact.agent}` : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </UtilitySection>
            )}
          </div>
        )}
      </UtilityDrawer>

      <div
        className="animate-fade-in"
        style={{
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div
          style={{
            borderRadius: '18px',
            border: '1px solid var(--tf-border)',
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--tf-surface-raised) 45%, var(--tf-surface)) 0%, var(--tf-surface) 100%)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
          }}
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-lg font-semibold" style={{ color: 'var(--tf-text)' }}>
                Projects Hub
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                Browse, launch, and operate projects without carrying utility clutter in the main workspace.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => void onRefresh?.()} style={buttonStyle(false)}>
                Refresh
              </button>
              <button type="button" onClick={() => setShowCreateDrawer(true)} style={buttonStyle(true)}>
                New Project
              </button>
            </div>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            {[
              { label: 'Active', value: summaryCounts.active, color: 'var(--tf-success)' },
              { label: 'Planning', value: summaryCounts.planning, color: 'var(--tf-accent)' },
              { label: 'Completed', value: summaryCounts.completed, color: 'var(--tf-accent-blue)' },
              { label: 'Blocked', value: summaryCounts.blocked, color: 'var(--tf-error)' },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl"
                style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)', padding: '12px 14px' }}
              >
                <p className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
                  {stat.label}
                </p>
                <p className="text-2xl font-semibold mt-1" style={{ color: stat.color }}>
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(220px, 1.5fr) repeat(3, minmax(150px, 0.7fr)) auto' }}>
            <input
              type="text"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="Search projects, tags, people, lanes..."
              style={{
                borderRadius: '12px',
                border: '1px solid var(--tf-border)',
                backgroundColor: 'var(--tf-bg)',
                color: 'var(--tf-text)',
                padding: '10px 12px',
                fontSize: '13px',
                minWidth: 0,
              }}
            />
            <FloatingSelect
              value={statusFilter}
              options={statusOptions}
              onChange={(value) => setStatusFilter(value as ProjectStatusFilter)}
              ariaLabel="Project status filter"
              searchable={false}
              size="sm"
              variant="card"
              style={{ width: '100%' }}
            />
            <FloatingSelect
              value={deliveryFilter}
              options={deliveryOptions}
              onChange={(value) => setDeliveryFilter(value as ProjectDeliveryFilter)}
              ariaLabel="Project delivery filter"
              searchable={false}
              size="sm"
              variant="card"
              style={{ width: '100%' }}
            />
            <FloatingSelect
              value={sortMode}
              options={sortOptions}
              onChange={(value) => setSortMode(value as ProjectSortMode)}
              ariaLabel="Project sort order"
              searchable={false}
              size="sm"
              variant="card"
              style={{ width: '100%' }}
            />
            {showArchivedToggle ? (
              <button
                type="button"
                onClick={() => setShowArchived((value) => !value)}
                style={{
                  ...buttonStyle(false),
                  backgroundColor: showArchived ? 'rgba(59,142,255,0.12)' : 'var(--tf-surface-raised)',
                  color: showArchived ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)',
                  border: `1px solid ${showArchived ? 'var(--tf-accent-blue)' : 'var(--tf-border)'}`,
                }}
              >
                {showArchived ? 'Hide Archived' : 'Show Archived'}
              </button>
            ) : (
              <div />
            )}
          </div>
        </div>

        {(feedbackMessage || feedbackError) && (
          <div
            className="rounded-xl px-4 py-3"
            style={{
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-surface)',
              color: feedbackError ? 'var(--tf-warning)' : 'var(--tf-success)',
              fontSize: '12px',
            }}
          >
            {feedbackError || feedbackMessage}
          </div>
        )}

        {hasNoProjects ? (
          <div
            className="rounded-2xl"
            style={{
              border: '1px solid var(--tf-border)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--tf-accent-blue) 6%, var(--tf-surface)) 0%, var(--tf-surface) 100%)',
              padding: '28px',
            }}
          >
            <p className="text-lg font-semibold" style={{ color: 'var(--tf-text)' }}>
              No projects yet
            </p>
            <p className="text-sm mt-2" style={{ color: 'var(--tf-text-secondary)', maxWidth: '640px', lineHeight: 1.6 }}>
              Start with a clean project drawer, or open CEO chat and ask COMPaaS to create the first project from a delivery request.
            </p>
            <div className="flex items-center gap-2 mt-4">
              <button type="button" onClick={() => setShowCreateDrawer(true)} style={buttonStyle(true)}>
                Create First Project
              </button>
              <button type="button" onClick={() => onRefresh?.()} style={buttonStyle(false)}>
                Refresh
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              gap: '18px',
              minHeight: 0,
              flexDirection: isNarrowViewport ? 'column' : 'row',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: isNarrowViewport ? '100%' : '360px',
                minWidth: isNarrowViewport ? 0 : '360px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
                  Active Projects
                </p>
                <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                  {visibleProjectsCount} visible
                </p>
              </div>

              <div className="space-y-3" style={{ overflowY: 'auto', paddingRight: '2px' }}>
                {activeProjectForRail.length === 0 ? (
                  <div className="rounded-xl p-4" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                    <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>No matching projects</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>
                      Adjust the search or filters to find a project faster.
                    </p>
                  </div>
                ) : (
                  activeProjectForRail.map((project) => (
                    <ProjectRailCard
                      key={project.id}
                      project={project}
                      selected={selectedId === project.id}
                      archived={false}
                      onSelect={() => handleSelect(project.id, false)}
                      onAskCEO={onAskCEO ? () => handleAskCEO(project) : undefined}
                      onOpenWorkspace={project.workspace_path ? () => void handleOpenWorkspace(project) : undefined}
                      onCopyLaunchPack={() => void handleCopyLaunchPack(project)}
                    />
                  ))
                )}

                {showArchived && (
                  <div style={{ marginTop: '18px' }}>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
                        Archived
                      </p>
                      {archivedLoading && (
                        <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>Loading…</p>
                      )}
                    </div>
                    <div className="space-y-3">
                      {filteredArchivedProjects.length === 0 ? (
                        <div className="rounded-xl p-4" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                          <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                            No archived projects match the current filters.
                          </p>
                        </div>
                      ) : (
                        filteredArchivedProjects.map((project) => (
                          <ProjectRailCard
                            key={project.id}
                            project={project}
                            selected={selectedId === project.id}
                            archived
                            onSelect={() => handleSelect(project.id, true)}
                            onOpenWorkspace={project.workspace_path ? () => void handleOpenWorkspace(project) : undefined}
                            onCopyLaunchPack={() => void handleCopyLaunchPack(project)}
                          />
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {selectedProject && !isNarrowViewport && (
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  position: 'relative',
                  border: '1px solid var(--tf-border)',
                  borderRadius: '22px',
                  background: 'linear-gradient(180deg, color-mix(in srgb, var(--tf-surface-raised) 40%, var(--tf-surface)) 0%, var(--tf-surface) 100%)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: '22px 22px 0', display: 'flex', flexDirection: 'column', gap: '18px' }}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div style={{ minWidth: 0 }}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-lg font-semibold truncate" style={{ color: 'var(--tf-text)' }}>
                          {selectedProject.name}
                        </h3>
                        <span
                          style={{
                            padding: '4px 10px',
                            borderRadius: '999px',
                            fontSize: '10px',
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            color: selectedLifecycleAccent,
                            backgroundColor: selectedLifecycleSurface,
                            border: `1px solid color-mix(in srgb, ${selectedLifecycleAccent} 28%, transparent)`,
                          }}
                        >
                          {selectedLifecycleLabel}
                        </span>
                        <span
                          style={{
                            padding: '4px 10px',
                            borderRadius: '999px',
                            fontSize: '10px',
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            color: 'var(--tf-text-muted)',
                            backgroundColor: 'var(--tf-bg)',
                            border: '1px solid var(--tf-border)',
                          }}
                        >
                          {selectedProject.delivery_mode === 'github' ? 'GitHub' : 'Local'}
                        </span>
                        {selectedProject.last_run?.state && (
                          <span className="text-[11px]" style={{ color: 'var(--tf-text-muted)' }}>
                            Last run {selectedProject.last_run.state} · {formatRelativeTime(selectedProject.last_run.updated_at)}
                          </span>
                        )}
                      </div>
                      <p className="text-xs mt-2" style={{ color: 'var(--tf-text-muted)' }}>
                        {selectedProject.delivery_mode === 'github'
                          ? `${selectedProject.github_repo || 'Repository not set'}${selectedProject.github_branch ? ` · ${selectedProject.github_branch}` : ''}`
                          : selectedProject.workspace_path || 'Local workspace path not set'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {!selectedIsArchived && onAskCEO && (
                        <button type="button" onClick={() => handleAskCEO(selectedProject)} style={buttonStyle(false)}>
                          Ask CEO
                        </button>
                      )}
                      {selectedProject.workspace_path && (
                        <button type="button" onClick={() => void handleOpenWorkspace(selectedProject)} style={buttonStyle(false)}>
                          Open Workspace
                        </button>
                      )}
                      {launchUrl && (
                        <button type="button" onClick={() => handleOpenApp(selectedProject)} style={buttonStyle(false)}>
                          Open App
                        </button>
                      )}
                      <button type="button" onClick={() => void handleCopyLaunchPack(selectedProject)} style={buttonStyle(false)}>
                        Copy Launch Pack
                      </button>
                      <div style={{ position: 'relative' }}>
                        <button type="button" onClick={() => setMenuOpen((value) => !value)} style={buttonStyle(false)}>
                          More
                        </button>
                        {menuOpen && (
                          <div
                            style={{
                              position: 'absolute',
                              top: 'calc(100% + 8px)',
                              right: 0,
                              zIndex: 4,
                              width: '220px',
                              borderRadius: '14px',
                              border: '1px solid var(--tf-border)',
                              backgroundColor: 'var(--tf-surface)',
                              boxShadow: '0 18px 32px rgba(0,0,0,0.28)',
                              padding: '8px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '4px',
                            }}
                          >
                            {!selectedIsArchived && (
                              <>
                                <button type="button" onClick={() => void handleOpenUtility('clone')} style={{ ...buttonStyle(false), textAlign: 'left' }}>
                                  Clone Project
                                </button>
                                <button type="button" onClick={() => void handleOpenUtility('tags')} style={{ ...buttonStyle(false), textAlign: 'left' }}>
                                  Edit Tags
                                </button>
                                <button type="button" onClick={() => void handleArchiveProject()} style={{ ...buttonStyle(false), textAlign: 'left' }}>
                                  {busyAction === 'archive' ? 'Archiving…' : 'Archive Project'}
                                </button>
                              </>
                            )}
                            {selectedIsArchived && (
                              <button type="button" onClick={() => void handleRestoreProject()} style={{ ...buttonStyle(false), textAlign: 'left' }}>
                                {busyAction === 'restore' ? 'Restoring…' : 'Restore Project'}
                              </button>
                            )}
                            <button type="button" onClick={() => void handleOpenUtility('release-notes')} style={{ ...buttonStyle(false), textAlign: 'left' }}>
                              Release Notes
                            </button>
                            <button type="button" onClick={() => void handleOpenUtility('artifacts')} style={{ ...buttonStyle(false), textAlign: 'left' }}>
                              Artifacts
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteProject()}
                              style={{
                                ...buttonStyle(false),
                                textAlign: 'left',
                                color: 'var(--tf-error)',
                                borderColor: 'color-mix(in srgb, var(--tf-error) 35%, var(--tf-border))',
                              }}
                            >
                              {busyAction === 'delete' ? 'Deleting…' : 'Delete Project'}
                            </button>
                          </div>
                        )}
                      </div>
                      <button type="button" onClick={handleCloseSelectedProject} style={buttonStyle(false)}>
                        Close
                      </button>
                    </div>
                  </div>
                  {selectedProject.status_reason && (
                    <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                      {selectedProject.status_reason}
                      {selectedProject.last_status_change_at ? ` · ${formatRelativeTime(selectedProject.last_status_change_at)}` : ''}
                    </p>
                  )}

                  {detailError && (
                    <InlineActionCard
                      title="Project detail is stale"
                      message={detailError}
                      severity="warning"
                      actions={[{ id: 'retry-project-detail', label: 'Refresh detail', kind: 'retry' }]}
                      onAction={(action) => {
                        if (action.id === 'retry-project-detail' && selectedProject.id) {
                          setDetailReloadNonce((value) => value + 1);
                        }
                      }}
                    />
                  )}

                  <div className="flex flex-wrap gap-2">
                    {(selectedProject.tags || []).map((tag) => (
                      <span
                        key={tag}
                        style={{
                          padding: '4px 10px',
                          borderRadius: '999px',
                          fontSize: '11px',
                          color: 'var(--tf-accent-blue)',
                          backgroundColor: 'color-mix(in srgb, var(--tf-accent-blue) 10%, transparent)',
                          border: '1px solid var(--tf-border)',
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                    {selectedProject.artifacts_preview && selectedProject.artifacts_preview.length > 0 && (
                      <span className="text-[11px]" style={{ color: 'var(--tf-text-muted)' }}>
                        {selectedProject.artifacts_preview.length} recent artifacts
                      </span>
                    )}
                    {qualitySnapshot && (
                      <span className="text-[11px]" style={{ color: 'var(--tf-text-muted)' }}>
                        Quality: code {qualitySnapshot.code_quality} · ux {qualitySnapshot.ux_quality} · visual {qualitySnapshot.visual_distinctiveness}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ padding: '0 22px 22px', overflowY: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
                  {detailLoading ? (
                    <div className="space-y-3">
                      {[1, 2, 3].map((row) => (
                        <div key={row} className="rounded-xl p-5 skeleton" style={{ height: '120px' }} />
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <section
                        className="rounded-2xl"
                        style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)', padding: '18px' }}
                      >
                        <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'var(--tf-text-muted)' }}>
                          Project Brief
                        </p>
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--tf-text-secondary)' }}>
                          {selectedProject.description || 'No project brief yet. Ask the CEO to generate a concise delivery summary.'}
                        </p>
                      </section>

                      <section
                        className="rounded-2xl"
                        style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)', padding: '18px' }}
                      >
                        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                          <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
                            Team Lanes
                          </p>
                          <p className="text-[11px]" style={{ color: 'var(--tf-text-muted)' }}>
                            {teamMembers.length} members
                          </p>
                        </div>
                        {teamMembers.length === 0 ? (
                          <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                            No team members are assigned yet. Ask the CEO to delegate work and the lanes will populate here.
                          </p>
                        ) : (
                          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                            {teamMembers.map((member) => {
                              const memberLanes = (lanesByOwner.get(member) || []).slice(0, 3);
                              const memberTasks = (tasksByAssignee.get(member) || []).slice(0, 3);
                              const workload = (tasksByAssignee.get(member) || []).length;
                              return (
                                <div
                                  key={member}
                                  className="rounded-xl"
                                  style={{
                                    border: '1px solid var(--tf-border)',
                                    backgroundColor: 'var(--tf-surface)',
                                    padding: '14px',
                                  }}
                                >
                                  <div className="flex items-center justify-between gap-3 mb-2">
                                    <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>
                                      {resolveTeamName(member)}
                                    </p>
                                    <span
                                      className="text-[10px]"
                                      style={{
                                        color: 'var(--tf-accent-blue)',
                                        backgroundColor: 'color-mix(in srgb, var(--tf-accent-blue) 10%, transparent)',
                                        border: '1px solid var(--tf-border)',
                                        borderRadius: '999px',
                                        padding: '3px 8px',
                                      }}
                                    >
                                      {workload} items
                                    </span>
                                  </div>
                                  {memberLanes.length > 0 ? (
                                    <div className="space-y-2">
                                      {memberLanes.map((lane, index) => (
                                        <div key={`${member}-${lane.headline}-${index}`} className="flex items-start gap-2">
                                          <span
                                            style={{
                                              width: '8px',
                                              height: '8px',
                                              borderRadius: '999px',
                                              backgroundColor: laneStatusColor(lane.status),
                                              flexShrink: 0,
                                              marginTop: '4px',
                                            }}
                                          />
                                          <p className="text-xs" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.5 }}>
                                            {lane.headline}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  ) : memberTasks.length > 0 ? (
                                    <div className="space-y-2">
                                      {memberTasks.map((taskTitle) => (
                                        <p key={`${member}-${taskTitle}`} className="text-xs" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.5 }}>
                                          {taskTitle}
                                        </p>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                                      No high-level task is visible yet.
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>

                      <section
                        className="rounded-2xl"
                        style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)', padding: '18px' }}
                      >
                        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                          <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--tf-text-muted)' }}>
                            Launch Pad
                          </p>
                          <div className="flex items-center gap-2 flex-wrap">
                            {launchUrl && (
                              <button type="button" onClick={() => handleOpenApp(selectedProject)} style={actionChipStyle()}>
                                Open App
                              </button>
                            )}
                            {selectedProject.workspace_path && (
                              <button type="button" onClick={() => void handleOpenWorkspace(selectedProject)} style={actionChipStyle()}>
                                Open Workspace
                              </button>
                            )}
                            <button type="button" onClick={() => void handleCopyLaunchPack(selectedProject)} style={actionChipStyle()}>
                              Copy Launch Pack
                            </button>
                          </div>
                        </div>
                        {runCommands.length === 0 ? (
                          <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>
                            No run commands are available yet. Complete a build and COMPaaS will summarize launch instructions here.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {runCommands.map((command, index) => (
                              <div
                                key={`${command}-${index}`}
                                className="flex items-center gap-2"
                                style={{
                                  border: '1px solid var(--tf-border)',
                                  backgroundColor: 'var(--tf-surface)',
                                  borderRadius: '14px',
                                  padding: '10px 12px',
                                }}
                              >
                                <code
                                  className="text-xs"
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    color: 'var(--tf-text-secondary)',
                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                    overflowWrap: 'anywhere',
                                  }}
                                >
                                  {command}
                                </code>
                                <button
                                  type="button"
                                  onClick={() => void navigator.clipboard.writeText(command)}
                                  style={actionChipStyle()}
                                >
                                  Copy
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        {launchLinks.length > 0 && (
                          <div style={{ marginTop: '14px' }}>
                            <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--tf-text-secondary)' }}>
                              Launch links
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {launchLinks.map((link) => (
                                <button
                                  key={`${link.kind}-${link.target}`}
                                  type="button"
                                  onClick={() => {
                                    if (link.kind === 'url') {
                                      window.open(link.target, '_blank', 'noopener,noreferrer');
                                    } else {
                                      void navigator.clipboard.writeText(link.target);
                                      setSuccess(`${link.label} copied.`);
                                    }
                                  }}
                                  style={actionChipStyle()}
                                >
                                  {link.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </section>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedProject && isNarrowViewport && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 12,
            backgroundColor: 'rgba(2,8,23,0.45)',
          }}
        >
          <div
            className="animate-slide-up"
            style={{
              position: 'absolute',
              inset: '8px',
              borderRadius: '22px',
              border: '1px solid var(--tf-border)',
              backgroundColor: 'var(--tf-surface)',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--tf-border)' }}>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--tf-text)' }}>{selectedProject.name}</p>
                <p className="text-xs mt-1" style={{ color: 'var(--tf-text-muted)' }}>Project workspace</p>
              </div>
              <button type="button" onClick={handleCloseSelectedProject} style={buttonStyle(false)}>
                Close
              </button>
            </div>
            <div style={{ padding: '16px', overflowY: 'auto', height: 'calc(100% - 74px)' }}>
              <div className="space-y-4">
                <div className="rounded-xl p-4" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
                  <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>Project Brief</p>
                  <p className="text-sm" style={{ color: 'var(--tf-text-secondary)', lineHeight: 1.6 }}>
                    {selectedProject.description || 'No project brief yet.'}
                  </p>
                </div>
                <div className="rounded-xl p-4" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
                  <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>Team Lanes</p>
                  {teamMembers.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>No team lanes yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {teamMembers.map((member) => (
                        <div key={member}>
                          <p className="text-xs font-semibold" style={{ color: 'var(--tf-text)' }}>{resolveTeamName(member)}</p>
                          {((lanesByOwner.get(member) || []).slice(0, 2)).map((lane, index) => (
                            <p key={`${member}-${index}`} className="text-xs mt-1" style={{ color: 'var(--tf-text-secondary)' }}>
                              {lane.headline}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-xl p-4" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-bg)' }}>
                  <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--tf-text-muted)' }}>Launch Pad</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {!selectedIsArchived && onAskCEO && (
                      <button type="button" onClick={() => handleAskCEO(selectedProject)} style={actionChipStyle()}>
                        Ask CEO
                      </button>
                    )}
                    {selectedProject.workspace_path && (
                      <button type="button" onClick={() => void handleOpenWorkspace(selectedProject)} style={actionChipStyle()}>
                        Open Workspace
                      </button>
                    )}
                    {launchUrl && (
                      <button type="button" onClick={() => handleOpenApp(selectedProject)} style={actionChipStyle()}>
                        Open App
                      </button>
                    )}
                    <button type="button" onClick={() => void handleCopyLaunchPack(selectedProject)} style={actionChipStyle()}>
                      Copy Launch Pack
                    </button>
                  </div>
                  {runCommands.length > 0 ? (
                    <div className="space-y-2">
                      {runCommands.map((command, index) => (
                        <div key={`${command}-${index}`} className="rounded-lg px-3 py-2" style={{ border: '1px solid var(--tf-border)', backgroundColor: 'var(--tf-surface)' }}>
                          <code className="text-xs" style={{ color: 'var(--tf-text-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}>
                            {command}
                          </code>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs" style={{ color: 'var(--tf-text-muted)' }}>No run commands yet.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
