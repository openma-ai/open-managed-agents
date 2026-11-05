/** Local deterministic acceptance fixtures for PR #498.
 * Run Vite first, then: node apps/console/scripts/capture-498-acceptance.mjs
 */
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = path.join(root, 'docs/screenshots/498/acceptance');
const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local Vite server.');
await mkdir(out, { recursive: true });

const runtimeOnline = {
  id: '1725d28a-83d1-4434-9178-4b9a9ab93006',
  machine_id: '3a081f41-9885-40ea-a433-39497f3b708e',
  hostname: 'botty',
  os: 'darwin',
  agents: [{ id: 'probe', binary: '/usr/local/bin/probe' }],
  local_skills: {},
  version: '0.7.3-498',
  status: 'online',
  last_heartbeat: Math.floor(Date.now() / 1000) - 12,
  created_at: Math.floor(Date.now() / 1000) - 3600,
};
const environment = {
  id: 'env_498_demo',
  type: 'environment',
  name: 'pr-498-overlay',
  config: { type: 'self_hosted' },
  created_at: '2026-11-05T10:00:00Z',
  updated_at: '2026-11-05T10:00:00Z',
  archived_at: null,
  _oma: {
    runtime: {
      runtime_id: runtimeOnline.id,
      env: { OMA_498_PROBE: 'from-overlay', NODE_ENV: 'development' },
    },
  },
};
const pairing = {
  pairing_token: 'omrp_deadbeef_cafebabe',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  install_command:
    'npx -y @openma/cli bridge setup --server-url=https://managed-agents-lane-pr-498.hrhrngxy.workers.dev --token=omrp_deadbeef_cafebabe',
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

function fulfillApi(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const method = route.request().method();
  if (p === '/auth/get-session') {
    return route.fulfill({ json: { user: { id: 'demo', name: 'Demo', email: 'demo@example.com' }, session: { id: 'demo', expiresAt: '2027-01-01T00:00:00Z' } } });
  }
  if (p === '/v1/oma/me/tenants') return route.fulfill({ json: { data: [{ id: 'demo', name: 'Default', role: 'owner' }] } });
  if (p === '/v1/oma/runtimes' && method === 'GET') return route.fulfill({ json: { runtimes: [runtimeOnline] } });
  if (p === '/v1/oma/runtimes/pairing-tokens' && method === 'POST') return route.fulfill({ status: 201, json: pairing });
  if (p === '/v1/environments' && method === 'GET') return route.fulfill({ json: { data: [environment], next_page: null } });
  if (p === `/v1/environments/${environment.id}`) return route.fulfill({ json: environment });
  if (p.startsWith('/v1/') || p.startsWith('/auth') || p === '/auth-info' || p === '/branding' || p === '/health') {
    return route.fulfill({ json: { data: [], next_page: null, has_more: false } });
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    return route.fulfill({ contentType: 'text/css', body: '' });
  }
  if (url.origin !== new URL(base).origin) return route.abort();
  return route.continue();
}

async function shot(name, routePath, interact) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 980 },
    timezoneId: 'America/Detroit',
    locale: 'en-US',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    localStorage.setItem('oma-locale', 'en');
    localStorage.setItem('oma-theme', 'light');
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-11-05T15:00:00Z'));
  await page.route('**/*', fulfillApi);
  await page.goto(base + routePath, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '+ Connect machine' }).or(page.getByText('Local Runtimes')).or(page.getByText('Environments')).first().waitFor({ timeout: 20000 });
  if (interact) await interact(page);
  await page.screenshot({ path: path.join(out, name), fullPage: true });
  await context.close();
  console.log('wrote', name);
}

try {
  await shot('01-runtimes-list.png', '/runtimes', async (page) => {
    await expect(page.getByText('botty')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '+ Connect machine' })).toBeVisible();
  });
  await shot('02-connect-machine-modal.png', '/runtimes', async (page) => {
    await expect(page.getByText('botty')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '+ Connect machine' }).click();
    await expect(page.getByText('No browser on that machine?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate pairing command' })).toBeVisible();
  });
  await shot('03-generate-pairing-command.png', '/runtimes', async (page) => {
    await expect(page.getByText('botty')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '+ Connect machine' }).click();
    await page.getByRole('button', { name: 'Generate pairing command' }).click();
    await expect(page.getByTestId('pairing-command')).toContainText('bridge setup');
    await expect(page.getByTestId('pairing-command')).toContainText('managed-agents-lane-pr-498');
  });
  await shot('04-environments-new-attach-runtime.png', '/environments', async (page) => {
    await page.getByRole('button', { name: /New environment|Create environment/i }).first().click();
    await page.locator('#env-create-hosting').click();
    await page.getByRole('option', { name: 'Attach to existing Runtime' }).click();
    await expect(page.getByText('Env overlay')).toBeVisible({ timeout: 10000 });
    // Runtime select
    const runtimeSelect = page.locator('#env-create-runtime');
    await runtimeSelect.click();
    await page.getByRole('option', { name: /botty/ }).click();
    await page.locator('#env-create-env').fill('OMA_498_PROBE=from-overlay\nNODE_ENV=development');
  });
  await shot('05-environment-detail-runtime-card.png', `/environments/${environment.id}`, async (page) => {
    await expect(page.getByText('pr-498-overlay')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Runtime' })).toBeVisible();
    await expect(page.getByText('Env overlay (optional)')).toBeVisible();
  });
  console.log('OK all 498 fixture shots');
} finally {
  await browser.close();
}
