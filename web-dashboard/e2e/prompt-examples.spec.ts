import { test, expect, type Page } from '@playwright/test';

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
    id: 'prompt_examples_project',
    name: 'Prompt Examples Project',
    status: 'planning',
    type: 'app',
    description: 'Synthetic project for prompt examples UI tests',
    team: ['ceo'],
    workspace_path: '/Users/idan/compaas/projects/prompt_examples_project',
    run_instructions: 'npm install\nnpm run dev',
    task_counts: { todo: 1, in_progress: 0, done: 0, blocked: 0 },
    total_tasks: 1,
    plan_packet: { ready: false, missing_items: [], summary: '' },
  },
];

const projectDetailPayload = {
  project: projectsPayload[0],
  tasks: [],
};

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
];

test.beforeEach(async ({ page }) => {
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
    await route.fulfill({ json: agentsPayload[0] });
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

  await page.route('**/api/workforce/live**', async (route) => {
    await route.fulfill({
      json: {
        status: 'ok',
        as_of: '2026-03-03T12:00:00.000Z',
        project_id: 'prompt_examples_project',
        counts: { assigned: 0, working: 0, reporting: 0, blocked: 0 },
        workers: [],
      },
    });
  });

  await page.route('**/api/activity/recent*', async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route('**/api/v1/activity/recent*', async (route) => {
    await route.fulfill({ json: { status: 'ok', events: [], next_cursor: '', total_estimate: 0 } });
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

async function openChatPanel(page: Page) {
  const projectSelector = page.getByRole('button', { name: 'Global project selector' });
  if (await projectSelector.count()) {
    await projectSelector.first().click();
    const projectOption = page.getByRole('option', { name: /Prompt Examples Project/i });
    if (await projectOption.count()) {
      await projectOption.first().click();
    } else {
      await page.keyboard.press('Escape');
    }
  }

  const openChatButton = page.getByRole('button', { name: 'Open CEO chat' });
  if (await openChatButton.count()) {
    await openChatButton.first().click();
  }

  const projectRequiredModal = page.getByRole('heading', { name: 'Select a Project First' });
  if (await projectRequiredModal.count()) {
    const modalProjectButton = page.getByRole('button', { name: /Prompt Examples Project/i });
    if (await modalProjectButton.count()) {
      await modalProjectButton.first().click();
    } else if (await page.getByRole('button', { name: 'Cancel' }).count()) {
      await page.getByRole('button', { name: 'Cancel' }).first().click();
    }
  }

  await expect(page.locator('textarea').first()).toBeVisible();
}

test('prompt starter supports first-message gating, recents, and manual reopen @smoke', async ({ page }) => {
  await page.goto('/');
  await openChatPanel(page);

  const chatInput = page.locator('textarea').first();
  const starterTitle = page.locator('.prompt-starter-title');
  await expect(starterTitle).toHaveText('Prompt Examples');
  await page.getByRole('button', { name: 'Finance' }).first().click();
  await expect(page.getByRole('button', { name: /Budget Tracker/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Task Manager/i })).toHaveCount(0);

  await page.getByRole('button', { name: /Budget Tracker/i }).first().click();
  await expect(chatInput).toHaveValue(/personal budget app/i);
  await expect(starterTitle).toHaveCount(0);

  await page.getByRole('button', { name: 'Tools ▾' }).click();
  await page.getByRole('button', { name: 'Show Example Prompts' }).click();
  await expect(page.locator('.prompt-starter-recent')).toContainText('Budget Tracker');
  await chatInput.fill('temporary draft');
  await page.getByRole('button', { name: /Portfolio Tracker/i }).first().click();
  await expect(chatInput).toHaveValue(/investment portfolio tracker/i);

  const sendButton = page.getByRole('button', { name: 'Send message' });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(sendButton).toBeDisabled();
  await expect(starterTitle).toHaveCount(0);

  await page.getByRole('button', { name: 'Tools ▾' }).click();
  await page.getByRole('button', { name: 'Show Example Prompts' }).click();
  await expect(starterTitle).toHaveText('Prompt Examples');

  await page.reload();
  await openChatPanel(page);
  await expect(starterTitle).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools ▾' }).click();
  await page.getByRole('button', { name: 'Show Example Prompts' }).click();
  await expect(page.locator('.prompt-starter-recent')).toContainText('Portfolio Tracker');
  await expect(page.locator('.prompt-starter-recent')).toContainText('Budget Tracker');
});

test('prompt starter panel stays responsive on mobile @smoke', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openChatPanel(page);
  await expect(page.locator('.prompt-starter-title')).toHaveText('Prompt Examples');

  const noOverflow = await page.locator('.prompt-starter-panel').first().evaluate(
    (el) => el.scrollWidth <= el.clientWidth + 2,
  );
  expect(noOverflow).toBeTruthy();
});
