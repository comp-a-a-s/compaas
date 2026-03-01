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

const agentsPayload = [
  {
    id: 'ceo',
    name: 'Marcus',
    role: 'CEO',
    model: 'gpt-4o',
    status: 'active',
    team: 'leadership',
    recent_activity: [],
  },
  {
    id: 'cto',
    name: 'Elena',
    role: 'Chief Technology Officer',
    model: 'opus',
    status: 'available',
    team: 'leadership',
    recent_activity: [],
  },
  {
    id: 'vp-engineering',
    name: 'David',
    role: 'VP of Engineering',
    model: 'sonnet',
    status: 'available',
    team: 'leadership',
    recent_activity: [],
  },
  {
    id: 'vp-product',
    name: 'Olivia',
    role: 'Chief Product Officer',
    model: 'sonnet',
    status: 'available',
    team: 'leadership',
    recent_activity: [],
  },
  {
    id: 'lead-frontend',
    name: 'Priya',
    role: 'Lead Frontend Engineer',
    model: 'sonnet',
    status: 'available',
    team: 'engineering',
    recent_activity: [],
  },
  {
    id: 'qa-lead',
    name: 'Carlos',
    role: 'QA Lead',
    model: 'sonnet',
    status: 'available',
    team: 'engineering',
    recent_activity: [],
  },
  {
    id: 'tech-writer',
    name: 'Tom',
    role: 'Technical Writer',
    model: 'sonnet',
    status: 'available',
    team: 'on-demand',
    recent_activity: [],
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

const workforcePayload = {
  status: 'ok',
  as_of: '2026-02-28T10:20:00.000Z',
  project_id: null,
  counts: {
    assigned: 1,
    working: 1,
    reporting: 1,
    blocked: 0,
  },
  workers: [
    {
      work_item_id: 'run-smoke:lead-frontend',
      agent_id: 'lead-frontend',
      agent_name: 'Priya',
      state: 'working',
      project_id: 'smoke_project',
      run_id: 'run-smoke',
      task: 'Implement signup form validation',
      source: 'real',
      started_at: '2026-02-28T10:18:00.000Z',
      updated_at: '2026-02-28T10:19:45.000Z',
      elapsed_seconds: 105,
    },
    {
      work_item_id: 'run-smoke:qa-lead',
      agent_id: 'qa-lead',
      agent_name: 'Carlos',
      state: 'assigned',
      project_id: 'smoke_project',
      run_id: 'run-smoke',
      task: 'Prepare regression checklist',
      source: 'real',
      started_at: '2026-02-28T10:19:10.000Z',
      updated_at: '2026-02-28T10:19:50.000Z',
      elapsed_seconds: 40,
    },
    {
      work_item_id: 'run-smoke:tech-writer',
      agent_id: 'tech-writer',
      agent_name: 'Tom',
      state: 'reporting',
      project_id: 'smoke_project',
      run_id: 'run-smoke',
      task: 'Reporting API contract notes',
      source: 'real',
      started_at: '2026-02-28T10:18:30.000Z',
      updated_at: '2026-02-28T10:19:55.000Z',
      elapsed_seconds: 85,
    },
  ],
};

let projectsRequestCount = 0;
let chatHistoryPayload: Array<Record<string, unknown>> = [];
let projectsListPayload = projectsPayload;

test.beforeEach(async ({ page }) => {
  projectsRequestCount = 0;
  chatHistoryPayload = [];
  projectsListPayload = projectsPayload;

  await page.route('**/api/config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: configPayload });
      return;
    }
    await route.fulfill({ json: { status: 'ok' } });
  });

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({ json: agentsPayload });
  });

  await page.route('**/api/agents/*', async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').pop() || '';
    const match = agentsPayload.find((agent) => agent.id === id) || agentsPayload[0];
    await route.fulfill({ json: match });
  });

  await page.route('**/api/projects', async (route) => {
    projectsRequestCount += 1;
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: projectsListPayload });
      return;
    }
    await route.fulfill({ json: { status: 'ok', project: projectsPayload[0] || null } });
  });

  await page.route('**/api/workforce/live**', async (route) => {
    const url = new URL(route.request().url());
    const requestedProjectId = url.searchParams.get('project_id') || '';
    if (!requestedProjectId || requestedProjectId === 'smoke_project') {
      await route.fulfill({
        json: {
          ...workforcePayload,
          project_id: requestedProjectId || null,
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        status: 'ok',
        as_of: workforcePayload.as_of,
        project_id: requestedProjectId,
        counts: { assigned: 0, working: 0, reporting: 0, blocked: 0 },
        workers: [],
      },
    });
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
    await route.fulfill({ json: chatHistoryPayload });
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

  await page.route('**/api/v1/update/status', async (route) => {
    await route.fulfill({
      json: {
        status: 'ok',
        channel: 'release_tags',
        current_version: 'v1.0.0',
        latest_version: 'v1.0.1',
        update_available: true,
        dirty_repo: false,
        can_update: true,
        block_reason: '',
      },
    });
  });

  await page.route('**/api/v1/update/check', async (route) => {
    await route.fulfill({
      json: {
        status: 'ok',
        channel: 'release_tags',
        current_version: 'v1.0.0',
        latest_version: 'v1.0.1',
        update_available: true,
        dirty_repo: false,
        can_update: true,
        block_reason: '',
      },
    });
  });

  await page.route('**/api/v1/update/apply', async (route) => {
    await route.fulfill({
      json: {
        status: 'ok',
        channel: 'release_tags',
        from_version: 'v1.0.0',
        to_version: 'v1.0.1',
        update_applied: true,
        restart_required: true,
        dirty_repo: false,
        can_update: false,
        block_reason: 'Update applied. Restart COMPaaS to load the new version.',
      },
    });
  });
});

test('dashboard navigation and connector validation @smoke', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByText('Smoke Project')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Update Center')).toBeVisible();
  await expect(page.getByText('Current version')).toBeVisible();
  await expect(page.getByText('Poll Interval')).toHaveCount(0);
  await page.getByRole('button', { name: 'Integrations' }).click();
  await expect(page.getByText('GitHub Connector')).toBeVisible();

  await expect(page.getByText('Repository is required (owner/repo).')).toBeVisible();

  const githubRepoInput = page.getByPlaceholder('owner/repo').first();
  await githubRepoInput.fill('acme/smoke-project');
  await expect(page.getByText('Token is required for verification.')).toBeVisible();

  await page.getByPlaceholder('ghp_xxx').fill('ghp_demo_token');

  const githubVerifyButton = page.getByRole('button', { name: 'Connect & Verify' }).first();
  await expect(githubVerifyButton).toBeEnabled();

  expect(projectsRequestCount).toBeLessThan(20);
});

test('workforce states stay consistent across overview and agents @smoke', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('1 working — collaborating')).toBeVisible();
  await expect(page.getByText('1 assigned')).toBeVisible();
  await expect(page.getByText('1 reporting')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Live Truth' })).toBeVisible();

  await page.getByRole('button', { name: 'Live Truth' }).click();
  await expect(page.getByText('Live Workforce Truth').first()).toBeVisible();
  await expect(page.getByText('run run-smoke').first()).toBeVisible();
  await expect(page.getByText('source real').first()).toBeVisible();

  await page.getByRole('button', { name: 'Agents' }).click();
  await page.getByRole('button', { name: /Priya/i }).first().click();

  await expect(page.getByRole('heading', { name: 'Live State: Working' })).toBeVisible();
  await expect(page.getByText('Implement signup form validation').first()).toBeVisible();
});

test('ceo chat renders structured response with links, wrapping, and maximize toggle @smoke', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  chatHistoryPayload = [
    {
      role: 'ceo',
      content: [
        '## Outcome',
        'CashTracker build is complete.',
        '',
        '## Deliverables',
        '- [Activation Guide](/Users/idan/compaas/projects/cashtracker/artifacts/02_activation_guide.md)',
        '- [Dashboard URL](https://cashtracker.example.com)',
        '',
        '## Validation',
        '- npm run build passed.',
        '',
        '## Run Commands',
        '- npm ci',
        '- npm run dev',
        '',
        '## Open Links',
        '- [Local App](http://localhost:5173)',
        '',
        '## Next Steps',
        '1. Open the activation guide.',
      ].join('\n'),
      timestamp: '2026-02-28T10:22:00.000Z',
      project_id: '',
      structured: {
        summary: 'CashTracker build is complete.',
        deliverables: [
          {
            label: 'Activation Guide',
            target: '/Users/idan/compaas/projects/cashtracker/artifacts/02_activation_guide.md',
            kind: 'path',
          },
          {
            label: 'Dashboard URL',
            target: 'https://cashtracker.example.com',
            kind: 'url',
          },
        ],
        validation: ['npm run build passed.'],
        run_commands: ['npm ci', 'npm run dev'],
        open_links: [
          {
            label: 'Local App',
            target: 'http://localhost:5173',
            kind: 'url',
          },
        ],
        completion_kind: 'build_complete',
        next_actions: ['Open the activation guide.'],
        delegations: [],
        risks: [],
      },
    },
  ];
  projectsListPayload = [];

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  const openChatButton = page.getByRole('button', { name: 'Open CEO chat' });
  if (await openChatButton.count()) {
    await openChatButton.first().click();
  }
  await expect(page.locator('aside.split-chat-panel.split-chat-panel-open')).toBeVisible();

  const chatPane = page.locator('aside.split-chat-panel');
  const widthBefore = await chatPane.evaluate((el) => el.getBoundingClientRect().width);
  await page.getByRole('button', { name: 'Maximize' }).click();
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
  const widthAfter = await chatPane.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthAfter).toBeGreaterThan(widthBefore + 40);
  await page.getByRole('button', { name: 'Restore' }).click();

  await expect(page.getByText('Completion Summary')).toBeVisible();
  await page.getByRole('button', { name: /Activation Guide/i }).click();
  await expect(page.getByText(/Path copied to clipboard|Unable to copy path/i)).toBeVisible();

  const dashboardLink = page.getByRole('link', { name: 'Dashboard URL' });
  await expect(dashboardLink).toHaveAttribute('href', 'https://cashtracker.example.com');
  await expect(dashboardLink).toHaveAttribute('target', '_blank');
  await expect(page.getByText('Run Commands')).toBeVisible();
  await page.getByRole('button', { name: 'Copy' }).first().click();
  await expect(page.getByText(/Command copied to clipboard|Unable to copy command/i)).toBeVisible();
  const localAppLink = page.getByRole('link', { name: 'Local App' });
  await expect(localAppLink).toHaveAttribute('href', 'http://localhost:5173');

  await page.getByRole('button', { name: 'Show full response' }).click();
  await expect(page.getByRole('heading', { name: 'Outcome' })).toBeVisible();
  const markdownWraps = await page.locator('.chat-markdown').first().evaluate(
    (el) => el.scrollWidth <= (el.clientWidth + 2),
  );
  expect(markdownWraps).toBeTruthy();
});
