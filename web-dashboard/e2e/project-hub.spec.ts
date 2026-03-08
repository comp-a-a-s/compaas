import { expect, test } from '@playwright/test';

const configPayload = {
  setup_complete: true,
  user: { name: 'QA User' },
  agents: { ceo: 'Marcus' },
  ui: { poll_interval_ms: 5000 },
  llm: {
    provider: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    api_key: '',
  },
  integrations: {
    workspace_mode: 'local',
    github_token: '',
    github_repo: '',
    github_default_branch: 'main',
    github_verified: false,
  },
  feature_flags: {
    onboarding_tours: false,
  },
};

const baseProject = {
  id: 'hub_project',
  name: 'Hub Project',
  status: 'active',
  type: 'app',
  description: 'Project hub regression fixture',
  team: ['ceo', 'lead-frontend'],
  tags: ['hub'],
  workspace_path: '/Users/idan/compaas/projects/hub_project',
  run_instructions: 'npm ci\nnpm run dev',
  launch_links: [
    { label: 'Preview App', target: 'https://hub.example.com', kind: 'url' },
  ],
  artifacts_preview: [
    { path: 'artifacts/02_activation_guide.md', label: '02_activation_guide.md' },
  ],
  last_run: {
    state: 'done',
    updated_at: '2026-03-08T12:00:00.000Z',
  },
  high_level_tasks: [
    { owner: 'ceo', headline: 'Finalize launch brief', status: 'in_progress' },
    { owner: 'lead-frontend', headline: 'Ship dashboard interactions', status: 'review' },
  ],
  task_counts: { todo: 0, in_progress: 1, done: 1, blocked: 0, review: 1 },
  total_tasks: 2,
  plan_packet: { ready: true, missing_items: [], summary: '' },
};

const projectTasks = [
  {
    id: 'TASK-000001',
    title: 'Finalize launch brief',
    description: 'Capture launch scope',
    status: 'in_progress',
    priority: 'p1',
    assigned_to: 'ceo',
  },
  {
    id: 'TASK-000002',
    title: 'Ship dashboard interactions',
    description: 'Polish core UX',
    status: 'review',
    priority: 'p1',
    assigned_to: 'lead-frontend',
  },
];

test.describe('project hub flows', () => {
  test.beforeEach(async ({ page }) => {
    let activeProjects = [{ ...baseProject }];
    let archivedProjects: Array<Record<string, unknown>> = [];

    await page.route('**/api/config', async (route) => {
      if (route.request().method().toUpperCase() === 'GET') {
        await route.fulfill({ status: 200, json: configPayload });
        return;
      }
      await route.fulfill({ status: 200, json: { status: 'ok' } });
    });
    await page.route('**/api/agents', async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });
    await page.route('**/api/agents/*', async (route) => {
      await route.fulfill({ status: 200, json: null });
    });
    await page.route('**/api/projects', async (route) => {
      if (route.request().method().toUpperCase() === 'GET') {
        await route.fulfill({ status: 200, json: activeProjects });
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const name = String(body.name || '').trim() || 'Untitled Project';
      const created = {
        ...baseProject,
        id: 'new_project',
        name,
        description: String(body.description || '').trim() || 'Created from test drawer',
        delivery_mode: String(body.delivery_mode || 'local'),
        github_repo: String(body.github_repo || ''),
        github_branch: String(body.github_branch || ''),
      };
      activeProjects = [created, ...activeProjects];
      await route.fulfill({ status: 200, json: { status: 'ok', project: created } });
    });
    await page.route('**/api/projects/*', async (route) => {
      const method = route.request().method().toUpperCase();
      const url = new URL(route.request().url());
      const projectId = url.pathname.split('/').pop() || '';
      if (method === 'DELETE') {
        activeProjects = activeProjects.filter((project) => project.id !== projectId);
        archivedProjects = archivedProjects.filter((project) => project.id !== projectId);
        await route.fulfill({ status: 200, json: { status: 'ok', project_deleted: true, workspace_deleted: true } });
        return;
      }
      const project = [...activeProjects, ...archivedProjects].find((item) => item.id === projectId) || activeProjects[0];
      await route.fulfill({
        status: 200,
        json: {
          project,
          tasks: projectTasks,
          high_level_tasks: project.high_level_tasks || [],
          launch_links: project.launch_links || [],
          artifacts_preview: project.artifacts_preview || [],
          last_run: project.last_run || {},
        },
      });
    });
    await page.route('**/api/projects/*/workspace/open', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          opened: true,
          path: '/Users/idan/compaas/projects/hub_project',
          launcher: 'open',
          detail: 'Workspace folder opened.',
          correlation_id: 'corr-project-hub-open',
        },
      });
    });
    await page.route('**/api/v1/projects/archived', async (route) => {
      await route.fulfill({ status: 200, json: { status: 'ok', projects: archivedProjects } });
    });
    await page.route('**/api/v1/projects/*/clone', async (route) => {
      const cloned = {
        ...baseProject,
        id: 'hub_project_clone',
        name: 'Hub Project Clone',
      };
      activeProjects = [cloned, ...activeProjects];
      await route.fulfill({ status: 200, json: { status: 'ok', project: cloned } });
    });
    await page.route('**/api/v1/projects/*/archive', async (route) => {
      const url = new URL(route.request().url());
      const projectId = url.pathname.split('/').slice(-2)[0] || '';
      const project = activeProjects.find((item) => item.id === projectId) || null;
      if (project) {
        activeProjects = activeProjects.filter((item) => item.id !== projectId);
        archivedProjects = [{ ...project, status: 'archived' }];
      }
      await route.fulfill({ status: 200, json: { status: 'ok', metadata: { archived: true } } });
    });
    await page.route('**/api/v1/projects/*/restore', async (route) => {
      const url = new URL(route.request().url());
      const projectId = url.pathname.split('/').slice(-2)[0] || '';
      const project = archivedProjects.find((item) => item.id === projectId) || null;
      if (project) {
        archivedProjects = archivedProjects.filter((item) => item.id !== projectId);
        activeProjects = [{ ...project, status: 'active' }, ...activeProjects];
      }
      await route.fulfill({ status: 200, json: { status: 'ok', project } });
    });
    await page.route('**/api/v1/projects/*/release-notes**', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          project_id: 'hub_project',
          notes: '# Release Notes\n\n- Launched project hub redesign.',
          summary: 'Project hub release notes',
        },
      });
    });
    await page.route('**/api/v1/projects/*/artifacts', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          artifacts: [
            {
              file_path: 'artifacts/02_activation_guide.md',
              action: 'updated',
              timestamp: '2026-03-08T12:00:00.000Z',
              agent: 'Marcus',
            },
          ],
        },
      });
    });
    await page.route('**/api/activity/recent**', async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });
    await page.route('**/api/v1/activity/recent**', async (route) => {
      await route.fulfill({
        status: 200,
        json: { status: 'ok', events: [], next_cursor: '', total_estimate: 0 },
      });
    });
    await page.route('**/api/activity/stream', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ': keep-alive\n\n',
      });
    });
    await page.route('**/api/workforce/live**', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          as_of: '2026-03-08T12:00:00.000Z',
          project_id: null,
          counts: { assigned: 0, working: 0, reporting: 0, blocked: 0 },
          workers: [],
        },
      });
    });
    await page.route('**/api/chat/history**', async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });
    await page.route('**/api/memory**', async (route) => {
      await route.fulfill({ status: 200, json: { entries: [], raw: '' } });
    });
    await page.route('**/api/v1/chat/memory-policy**', async (route) => {
      await route.fulfill({ status: 200, json: { status: 'ok', scope: 'project', retention_days: 30 } });
    });
    await page.route('**/api/v1/update/status', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          channel: 'release_tags',
          current_version: 'v1.0.8',
          latest_version: 'v1.0.8',
          update_available: false,
          dirty_repo: false,
          can_update: false,
          block_reason: 'Already on the latest release.',
        },
      });
    });
    await page.route('**/api/v1/feature-flags', async (route) => {
      await route.fulfill({ status: 200, json: { status: 'ok', feature_flags: {} } });
    });
  });

  test('new project drawer creates a project and selects it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('button', { name: 'New Project' }).click();
    await expect(page.getByPlaceholder('CashTracker, Launch Desk, FounderOS...')).toBeVisible();
    await page.getByPlaceholder('CashTracker, Launch Desk, FounderOS...').fill('Launch Desk');
    await page.getByPlaceholder('A short sentence about what this project should become.').fill('A new launch operations workspace.');
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByText('Project created.')).toBeVisible();
    await expect(page.getByText('Launch Desk').first()).toBeVisible();
    await expect(page.getByText('Project Brief')).toBeVisible();
  });

  test('project overflow tools open real utility drawers and archived flow works', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByText('Hub Project').first().click();
    await expect(page.getByRole('button', { name: 'More' })).toBeVisible();

    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Release Notes' }).click();
    await expect(page.getByText('Latest notes')).toBeVisible();
    await expect(page.getByText('Launched project hub redesign.')).toBeVisible();
    await page.getByRole('button', { name: 'Close Release Notes' }).click();

    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Artifacts' }).click();
    await expect(page.getByText('Registered artifacts')).toBeVisible();
    await expect(page.getByText('artifacts/02_activation_guide.md')).toBeVisible();
    await page.getByRole('button', { name: 'Close Artifacts' }).click();

    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Clone Project' }).click();
    await expect(page.getByRole('button', { name: 'Close Clone Project' })).toBeVisible();
    await page.getByRole('button', { name: 'Clone Project', exact: true }).last().click();
    await expect(page.getByText('Project cloned.')).toBeVisible();

    await page.getByText('Hub Project').first().click();
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Archive Project' }).click();
    await expect(page.getByText('Project archived.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide Archived' })).toBeVisible();
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('button', { name: 'Restore Project' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore Project' }).click();
    await expect(page.getByText('Project restored.')).toBeVisible();
  });
});
