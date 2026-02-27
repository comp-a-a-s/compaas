import { test, expect } from '@playwright/test';

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
    github_auto_push: false,
    github_auto_pr: false,
    vercel_token: '',
    vercel_project_name: '',
    vercel_team_id: '',
    vercel_default_target: 'preview',
    vercel_verified: false,
    slack_token: '',
    webhook_url: '',
  },
  feature_flags: {
    onboarding_tours: false,
  },
};

const projectsPayload = [
  {
    id: 'smoke_project',
    name: 'Smoke Project',
    status: 'planning',
    type: 'app',
    description: 'Synthetic project for UI smoke',
    team: ['ceo'],
    task_counts: { todo: 1, in_progress: 0, done: 0, blocked: 0 },
    total_tasks: 1,
    plan_packet: { ready: false, missing_items: [], summary: '' },
  },
];

const projectDetailPayload = {
  project: projectsPayload[0],
  tasks: [
    {
      id: 'TASK-000001',
      title: 'Smoke task',
      description: 'Verify tab rendering',
      status: 'todo',
      priority: 'p1',
      assigned_to: 'ceo',
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: configPayload });
      return;
    }
    await route.fulfill({ json: { status: 'ok' } });
  });

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      json: [
        {
          id: 'ceo',
          name: 'Marcus',
          role: 'CEO',
          model: 'gpt-4o',
          status: 'active',
          team: 'leadership',
          recent_activity: [],
        },
      ],
    });
  });

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: projectsPayload });
      return;
    }
    await route.fulfill({ json: { status: 'ok', project: projectsPayload[0] } });
  });

  await page.route('**/api/projects/*', async (route) => {
    await route.fulfill({ json: projectDetailPayload });
  });

  await page.route('**/api/activity/recent*', async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route('**/api/activity/stream', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: ': keep-alive\n\n',
    });
  });

  await page.route('**/api/chat/history*', async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route('**/api/memory', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { entries: [], raw: '' } });
      return;
    }
    await route.fulfill({ json: { status: 'ok' } });
  });

  await page.route('**/api/v1/chat/memory-policy', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          status: 'ok',
          scope: 'project',
          retention_days: 30,
          auto_summary_every_messages: 18,
        },
      });
      return;
    }
    await route.fulfill({ json: { status: 'ok' } });
  });
});

test('dashboard navigation and connector validation @smoke', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByText('Smoke Project')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Integrations' }).click();
  await expect(page.getByText('GitHub Connector')).toBeVisible();

  await expect(page.getByText('Repository is required (owner/repo).')).toBeVisible();

  const githubRepoInput = page.getByPlaceholder('owner/repo').first();
  await githubRepoInput.fill('acme/smoke-project');
  await expect(page.getByText('Token is required for verification.')).toBeVisible();

  await page.getByPlaceholder('ghp_xxx').fill('ghp_demo_token');

  const githubVerifyButton = page.getByRole('button', { name: 'Connect & Verify' }).first();
  await expect(githubVerifyButton).toBeEnabled();
});
