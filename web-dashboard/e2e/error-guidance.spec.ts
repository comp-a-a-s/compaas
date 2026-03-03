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
    guided_errors_v1: true,
    error_contract_v1: true,
    readiness_center_v1: true,
  },
};

test.describe('guided reliability UX', () => {
  test('project creation failures show inline action card with retry', async ({ page }) => {
    let createAttempts = 0;
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
      const method = route.request().method().toUpperCase();
      if (method === 'GET') {
        await route.fulfill({ status: 200, json: [] });
        return;
      }
      if (method === 'POST') {
        createAttempts += 1;
        await route.fulfill({
          status: 500,
          json: {
            detail: 'Workspace path is not writable.',
            code: 'workspace_not_writable',
            correlation_id: 'corr-test-guided-1',
            action_required: true,
            actions: [
              { id: 'retry', label: 'Retry now', kind: 'retry' },
              { id: 'open_settings', label: 'Open Settings', kind: 'open_settings' },
            ],
          },
        });
        return;
      }
      await route.fulfill({ status: 200, json: { status: 'ok' } });
    });

    await page.route('**/api/projects/*', async (route) => {
      await route.fulfill({ status: 200, json: { project: null, tasks: [] } });
    });

    await page.route('**/api/workforce/live**', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          as_of: '2026-03-03T10:00:00.000Z',
          project_id: null,
          counts: { assigned: 0, working: 0, reporting: 0, blocked: 0 },
          workers: [],
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

    await page.route('**/api/chat/history**', async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });

    await page.route('**/api/memory**', async (route) => {
      if (route.request().method().toUpperCase() === 'GET') {
        await route.fulfill({ status: 200, json: { entries: [] } });
        return;
      }
      await route.fulfill({ status: 200, json: { status: 'ok' } });
    });

    await page.route('**/api/v1/chat/memory-policy**', async (route) => {
      const method = route.request().method().toUpperCase();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          json: {
            status: 'ok',
            memory_policy: { scope: 'project', max_entries: 10, auto_summarize: true, summarize_every: 5 },
          },
        });
        return;
      }
      await route.fulfill({ status: 200, json: { status: 'ok' } });
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
      await route.fulfill({
        status: 200,
        json: {
          status: 'ok',
          feature_flags: {
            guided_errors_v1: true,
            error_contract_v1: true,
            readiness_center_v1: true,
          },
        },
      });
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15000 });
    const projectsNavButton = page.getByRole('button', { name: 'Projects', exact: true });
    if (await projectsNavButton.count()) {
      await projectsNavButton.first().click();
    } else {
      await page.getByText('Projects', { exact: true }).first().click();
    }
    await page.getByPlaceholder('Project name').first().fill('Failure Demo');
    await page.getByRole('button', { name: 'Start Project' }).click();

    await expect(page.getByText('Project creation blocked')).toBeVisible();
    await expect(page.getByText('Workspace path is not writable.')).toBeVisible();
    await page.getByRole('button', { name: 'Retry create' }).click();

    await expect.poll(() => createAttempts).toBe(2);
  });
});
