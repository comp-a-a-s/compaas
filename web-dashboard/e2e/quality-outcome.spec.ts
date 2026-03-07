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
    github_default_branch: 'master',
    github_verified: false,
    vercel_token: '',
    vercel_project_name: '',
    vercel_verified: false,
  },
  feature_flags: {
    onboarding_tours: false,
  },
};

const projectsPayload = [
  {
    id: 'quality_project',
    name: 'Quality Project',
    status: 'active',
    type: 'app',
    description: 'AAA quality delivery flow',
    team: ['ceo', 'lead-frontend', 'qa-lead'],
    tags: ['quality'],
    workspace_path: '/Users/idan/compaas/projects/quality_project',
    run_instructions: 'npm ci\nnpm run dev',
    high_level_tasks: [
      { owner: 'lead-frontend', headline: 'Implement purpose-driven UX layout', status: 'in_progress' },
      { owner: 'qa-lead', headline: 'Validate smoke and regression checks', status: 'review' },
    ],
    quality_latest: {
      quality_report: {
        code_quality: 88,
        ux_quality: 84,
        visual_distinctiveness: 79,
        validation_passed: true,
        failed_gates: [],
      },
      delivery_gates: {
        required: ['run_commands', 'open_targets', 'deliverables', 'validation'],
        passed: ['run_commands', 'open_targets', 'deliverables', 'validation'],
        blocked: [],
      },
      refinement: { attempted: true, pass_index: 1, max_passes: 1, reason: 'Automatic quality refinement improved completion quality.' },
      updated_at: '2026-03-07T10:00:00.000Z',
    },
    quality_updated_at: '2026-03-07T10:00:00.000Z',
    task_counts: { todo: 0, in_progress: 1, done: 0, blocked: 0, review: 1 },
    total_tasks: 2,
    plan_packet: { ready: true, missing_items: [], summary: '' },
  },
];

test.describe('quality outcome surfacing', () => {
  test('project detail shows latest quality snapshot metrics', async ({ page }) => {
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
        await route.fulfill({ status: 200, json: projectsPayload });
        return;
      }
      await route.fulfill({ status: 200, json: { status: 'ok' } });
    });
    await page.route('**/api/projects/*', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          ...projectsPayload[0],
          project: projectsPayload[0],
          tasks: [],
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
    await page.route('**/api/workforce/live**', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          as_of: '2026-03-07T10:00:00.000Z',
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
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          memory_policy: { scope: 'project', max_entries: 10, auto_summarize: true, summarize_every: 5 },
        },
      });
    });
    await page.route('**/api/org-chart', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          board_head: { id: 'board', name: 'Idan', role: 'Board Head', reports_to: null },
          ceo: { id: 'ceo', name: 'Marcus', role: 'CEO', reports_to: 'board' },
          leadership: {},
          engineering: {},
          on_demand: {},
        },
      });
    });
    await page.route('**/api/v1/feature-flags', async (route) => {
      await route.fulfill({ status: 200, json: { status: 'ok', feature_flags: {} } });
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15000 });
    const projectsNavButton = page.getByRole('button', { name: 'Projects', exact: true });
    if (await projectsNavButton.count()) {
      await projectsNavButton.first().click();
    } else {
      await page.getByText('Projects', { exact: true }).first().click();
    }

    await page.getByText('Quality Project').first().click();
    await expect(page.getByText('Latest Quality Snapshot')).toBeVisible();
    await expect(page.getByText('Code 88')).toBeVisible();
    await expect(page.getByText('UX 84')).toBeVisible();
    await expect(page.getByText('Visual 79')).toBeVisible();
    await expect(page.getByText('Refinement pass 1/1 executed.')).toBeVisible();
  });
});
