import { test, expect } from '@playwright/test';

let llmTestRequestBody: Record<string, unknown> | null = null;

test.beforeEach(async ({ page }) => {
  llmTestRequestBody = null;

  await page.route('**/api/config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          setup_complete: false,
          user: { name: '' },
          agents: { ceo: 'Marcus' },
          ui: { poll_interval_ms: 5000 },
          llm: {
            provider: 'openai',
            anthropic_mode: 'cli',
            openai_mode: 'codex',
            base_url: 'https://api.openai.com/v1',
            model: 'codex',
            api_key: '',
            proxy_enabled: false,
            proxy_url: 'http://localhost:4000',
          },
          integrations: {
            workspace_mode: 'local',
            github_token: '',
            github_repo: '',
            github_default_branch: 'master',
            vercel_token: '',
            vercel_project_name: '',
            vercel_team_id: '',
            vercel_default_target: 'preview',
            netlify_token: '',
            netlify_site_id: '',
            netlify_team_id: '',
            netlify_default_target: 'preview',
            deploy_provider_preference: 'vercel',
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { status: 'ok' } });
  });

  await page.route('**/api/llm/test', async (route) => {
    llmTestRequestBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { status: 'ok', message: 'Connected' } });
  });

  await page.route('**/api/v1/netlify/verify', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        site_ok: true,
        account: { id: 'acct_demo' },
        message: 'Netlify verified.',
      },
    });
  });

  await page.route('**/api/integrations', async (route) => {
    await route.fulfill({ json: { status: 'ok' } });
  });
});

test('setup wizard supports Gemini provider test and Netlify connector verify', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Welcome to COMPaaS')).toBeVisible();
  await page.getByRole('button', { name: 'Get Started' }).click();

  await expect(page.getByRole('heading', { name: 'AI Provider' })).toBeVisible();
  await page.getByRole('radio', { name: /Google Gemini/i }).click();
  await page.getByPlaceholder('AIza...').fill('AIza-demo-key');
  await page.getByRole('button', { name: 'Test Connection' }).click();
  await expect(page.getByRole('button', { name: 'Connected' })).toBeVisible();

  expect(llmTestRequestBody).not.toBeNull();
  expect(String(llmTestRequestBody?.base_url || '')).toContain('generativelanguage.googleapis.com/v1beta/openai');
  expect(String(llmTestRequestBody?.model || '')).toContain('gemini');

  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByPlaceholder('e.g. Idan').fill('Idan');
  await page.getByRole('button', { name: 'Go to next step' }).click();
  await page.getByRole('button', { name: 'Go to next step' }).click();
  await page.getByRole('button', { name: 'Go to next step' }).click();

  await expect(page.getByRole('heading', { name: 'Connectors (Optional)' })).toBeVisible();
  await page.getByPlaceholder('Site ID').fill('site_123');
  await page.getByPlaceholder('nfp_xxx').fill('nfp_demo_token');

  await page.getByRole('button', { name: 'Connect & Verify' }).nth(2).click();
  await expect(page.getByText('Netlify verified.')).toBeVisible();
});
