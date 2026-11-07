/**
 * Production-browser regression for #506. Serve a console build, then run:
 * MODAL_BASE_URL=http://127.0.0.1:4186 node test/e2e/console-modal-tokens.mjs
 * MODAL_BASELINE=1 skips token override checks for the pre-change build.
 * API responses are browser fixtures, never a live backend certification.
 */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { modalClosure } from './console-modal-closure.mjs';

const baseURL = process.env.MODAL_BASE_URL ?? 'http://127.0.0.1:4186';
const output = process.env.MODAL_OUTPUT ?? 'test-results/modal-tokens';
const baseline = process.env.MODAL_BASELINE === '1';
const browser = await chromium.launch();
const results = [];
const date = '2026-11-07T00:00:00.000Z';
const agent = { id: 'agent_fixture', name: 'Modal fixture agent', model: 'claude-sonnet-4-6', system: 'Fixture', version: 1, tools: [], skills: [], mcp_servers: [], created_at: date, updated_at: date };
const store = { id: 'ms_fixture', name: 'Modal fixture memory', description: 'Browser fixture', created_at: date, updated_at: date, status: 'active' };
const vault = { id: 'vault_fixture', name: 'Modal fixture vault', display_name: 'Modal fixture vault', created_at: date, updated_at: date };
const tenant = { id: 'tenant_fixture', name: 'Modal fixture workspace', role: 'owner' };
const empty = { data: [], has_more: false, next_page: null, next_cursor: null };
const button = (page, name) => page.getByRole('button', { name, exact: true }).first().click();
const shell = process.env.MODAL_SHELL === '1';
const closure = shell ? modalClosure() : undefined;
const scenarios = shell ? closure.shellRoutes.map(r => ['shell-' + (r.pattern === '/*' ? 'fallback' : r.pattern.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'), r.url, async p => { await button(p, 'Switch workspace'); await p.locator('[data-create-workspace]').click(); }]) : [
  ['api-keys', '/api-keys', p => button(p, '+ New API key')],
  ['environments', '/environments', p => button(p, '+ New environment')],
  ['memory', '/memory', p => button(p, '+ New memory store')],
  ['memory-detail', '/memory/ms_fixture', p => button(p, '+ New memory')],
  ['model-cards', '/model-cards', p => button(p, '+ New model card')],
  ['runtimes', '/runtimes', p => button(p, '+ Connect machine')],
  ['sessions', '/sessions', p => button(p, 'Create session')],
  ['skills', '/skills', p => button(p, '+ New skill')],
  ['skill-sources', '/skills', p => button(p, 'Install from URL')],
  ['skill-updates', '/skills', p => button(p, 'Check for updates')],
  ['vaults', '/vaults', p => button(p, '+ New vault')],
  ['vault-detail', '/vaults/vault_fixture', p => button(p, 'Rename')],
  ['vault-credential', '/vaults/vault_fixture', p => button(p, '+ Add credential')],
  ['members', '/members', p => button(p, 'Remove Fixture member')],
  ['trajectory', '/sessions/session_fixture', p => button(p, 'Trajectory')],
  ['agent-mcp', '/agents', async p => { await button(p, '+ New agent'); await p.getByRole('button', { name: /Blank agent config/ }).click(); await p.getByRole('tab', { name: 'MCP Servers' }).click(); await button(p, '+ Pick known'); }],
  ['agent-detail-mcp', '/agents/agent_fixture', async p => { await button(p, 'Edit'); await p.getByRole('tab', { name: 'MCP Servers' }).click(); await button(p, '+ Pick known'); }],
  ['workspace', '/agents', async p => { await button(p, 'Switch workspace'); await p.locator('[data-create-workspace]').click(); }],
  ['confirmation', '/deployments/new', async p => { await p.locator('#deployment-name').fill('Unsaved fixture'); await button(p, 'Cancel'); }],
];

// The bare /loops/new route intentionally redirects to the template chooser.
// Also mount its real edit form by selecting an existing fixture template.
if (shell) scenarios.push(['shell-loops-new-configured', '/loops/new?template=slack-agent', async p => { await button(p, 'Switch workspace'); await p.locator('[data-create-workspace]').click(); }]);

assert.equal(new Set(scenarios.map(s => s[0])).size, scenarios.length, 'Screenshot case names must be unique');

async function fixture(page) {
  await page.clock.setFixedTime(new Date(date));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body;
    if (path === '/auth/get-session') body = { session: { id: 'auth_fixture', userId: 'user_fixture', expiresAt: '2099-01-01T00:00:00Z' }, user: { id: 'user_fixture', name: 'Browser fixture', email: 'fixture@example.test' } };
    else if (path === '/branding/branding.json') return route.fulfill({ status: 404, body: '' });
    else if (path.startsWith('/matter/')) {
      const template = { id: 'slack-agent', version: '1', provider: 'slack', description: 'Browser fixture', configSchema: { properties: {}, required: [] } };
      const bond = { id: 'slack:fixture', provider: 'slack', label: 'Fixture bond', connectedAt: date, running: true, loops: 1, details: {} };
      const loop = { id: 'loop_fixture', template: 'slack-agent', templateId: 'slack-agent', enabled: true, config: { bond: 'slack:fixture', agentId: 'agent_fixture' }, state: { running: true }, createdAt: date, updatedAt: date };
      assert.equal(route.request().method(), 'GET', `Unexpected Matter write: ${path}`);
      body = { data: path === '/matter/loop-templates' ? [template] : path === '/matter/bonds' ? [bond] : path === '/matter/loops' ? [loop] : [] };
    }
    else if (path === '/auth-info') body = { providers: [], emailPassword: true };
    else if (path.startsWith('/v1/')) {
      assert.ok(route.request().method() === 'GET' || path === '/v1/oma/skill-sources/check-updates', `Unexpected write: ${path}`);
      body = empty;
      if (path === '/v1/oma/stats') body = { agents: 1, sessions: 0, environments: 0, vaults: 0, skills: 0, model_cards: 0, api_keys: 0 };
      if (path === '/v1/deployments/deployment_fixture') body = { id: 'deployment_fixture', name: 'Fixture deployment', status: 'active', agent, agent_id: agent.id, environment_id: 'env_fixture', initial_events: [], vault_ids: [], resources: [], triggers: [{ type: 'manual' }], created_at: date, updated_at: date };
      if (path === '/v1/oma/evals/runs/eval_fixture') body = { id: 'eval_fixture', agent_id: agent.id, environment_id: 'env_fixture', status: 'completed', started_at: date, ended_at: date, task_count: 0, completed_count: 0, failed_count: 0, tasks: [] };
      if (path === '/v1/environments/env_fixture') body = { id: 'env_fixture', name: 'Fixture environment', status: 'ready', created_at: date, config: { type: 'cloud', networking: { type: 'unrestricted' }, packages: { pip: [], npm: [], apt: [], cargo: [], gem: [], go: [] } } };
      if (/^\/v1\/oma\/integrations\/(linear|github|slack)\/installations$/.test(path)) body = { data: [{ id: 'installation_fixture', workspace_name: 'Fixture workspace', workspace_id: 'workspace_fixture', account_login: 'fixture', account_type: 'Organization', bot_login: 'fixture[bot]', status: 'active', created_at: date }] };
      if (path === '/v1/oma/skill-sources/installed') body = { data: [{ skill_id: 'skill_fixture', name: 'Fixture skill', source_url: 'https://example.test/skills', digest: 'fixture', version: '1', installed_at: date, updated_at: date }] };
      if (path === '/v1/oma/skill-sources/check-updates') body = { sources: [], skills: [] };
      if (path === '/v1/agents') body = { ...empty, data: [agent] };
      if (path === '/v1/agents/agent_fixture') body = agent;
      if (path === '/v1/memory_stores/ms_fixture') body = store;
      if (path === '/v1/vaults/vault_fixture') body = vault;
      if (path === '/v1/oma/me/tenants') body = { data: [tenant] };
      if (path === '/v1/oma/me') body = { tenant };
      if (path.endsWith('/members')) body = { role: 'owner', user_id: 'user_fixture', data: [{ user_id: 'member_fixture', name: 'Fixture member', role: 'member' }] };
      if (path === '/v1/oma/harnesses') body = { object: 'list', default_harness_id: 'fixture', data: [{ id: 'fixture', label: 'Fixture harness', execution: { placement: 'host' }, capabilities: { runtime_binding: false }, requirements: [] }] };
      if (path === '/v1/sessions/session_fixture') body = { id: 'session_fixture', title: 'Fixture session', status: 'idle', agent, created_at: date };
      if (path.endsWith('/events/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    } else if (url.origin !== new URL(baseURL).origin) return route.abort();
    if (body !== undefined) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    return route.continue();
  });
}

async function metrics(page) {
  return page.locator('.console-modal').last().evaluate(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const body = el.querySelector('[data-console-modal-body]');
    const overlay = [...document.querySelectorAll('[data-slot="dialog-overlay"]')].at(-1);
    return { cap: s.getPropertyValue('--modal-viewport-cap'), rootCap: getComputedStyle(document.documentElement).getPropertyValue('--modal-viewport-cap'), className: el.className, maxHeight: s.maxHeight, height: r.height, top: r.top, bottom: r.bottom, padding: getComputedStyle(body).padding, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, overlay: getComputedStyle(overlay).backgroundColor };
  });
}

await mkdir(output, { recursive: true });
if (shell) await writeFile(`${output}/closure.json`, JSON.stringify(closure, null, 2));
try {
  for (const theme of (process.env.MODAL_THEME ? [process.env.MODAL_THEME] : ['light', 'dark'])) {
    for (const [width, height, font] of [[1280, 900, 16], [390, 640, 16], [390, 640, 20]]) {
      for (const [name, path, open] of scenarios) {
        if (process.env.MODAL_DESKTOP && width < 600) continue;
        if (width < 600 && !(shell ? ['shell-home', 'shell-environments-id', 'shell-loops-new', 'shell-loops-new-configured', 'shell-integrations-github-bind', 'shell-skills'] : ['sessions', 'confirmation', 'workspace']).includes(name)) continue;
        if (process.env.MODAL_CASE && !process.env.MODAL_CASE.split(',').includes(name)) continue;
        const key = `${name}-${theme}-${width}-${font}`;
        const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        const consoleErrors = [];
        const requests = [];
        page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/v1/')) requests.push(url.pathname); });
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('pageerror', e => errors.push(e.message));
        try {
          await context.addInitScript(({ theme, font }) => {
            localStorage.setItem('theme', theme);
            localStorage.setItem('oma-locale', 'en');
            document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${font}px`; });
          }, { theme, font });
          await fixture(page);
          await page.goto(`${baseURL}${path}`);
          await page.getByRole('button', { name: 'Switch workspace', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
          await page.waitForTimeout(300);
          await mkdir(output, { recursive: true });
          const shot = async state => {
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(200);
            return page.screenshot({ path: `${output}/${key}-${state}.jpg`, type: 'jpeg', quality: 80, animations: 'disabled' });
          };
          await shot('closed');
          if (width < 600 && (name === 'workspace' || shell)) {
            // The mobile sidebar is normally hidden until explicitly opened.
            await page.getByRole('button', { name: /sidebar/i }).first().click();
          }
          if (name === 'trajectory') {
            const trigger = page.getByRole('button', { name: 'Trajectory', exact: true });
            await expect(trigger).toBeDisabled();
            let clickError;
            try { await trigger.click({ timeout: 500 }); } catch (error) { clickError = String(error); }
            assert.match(clickError ?? '', /not enabled/);
            assert.equal(await page.locator('.console-modal').count(), 0);
            assert.deepEqual(errors, []);
            results.push({ key, path, finalUrl: page.url(), passed: true, disabled: true, clickError, requests: [...new Set(requests)], limitation: 'Existing SessionDetail never loads trajectory; normal click times out because the button is disabled. No route open-state coverage.' });
            console.log(`PASS ${key} (verified disabled route; open state blocked)`);
            continue;
          }
          await open(page);
          const modal = page.locator('.console-modal').last();
          await modal.waitFor({ state: 'visible' });
          await page.waitForTimeout(150);
          const actual = await metrics(page);
          assert.ok(Math.abs(parseFloat(actual.maxHeight) - height * .7) < 1, JSON.stringify(actual));
          if (name === 'confirmation') assert.ok(['rgba(0, 0, 0, 0.35)', 'oklab(0 0 0 / 0.35)'].includes(actual.overlay));
          else assert.equal(actual.overlay, 'rgba(0, 0, 0, 0)');
          assert.equal(actual.padding, `${font}px ${font * 1.5}px`);
          assert.ok(actual.bottom <= height, `Modal exceeds viewport: ${JSON.stringify(actual)}`);
          await shot('open');
          if (name === 'sessions' && width < 600) assert.ok(actual.scrollHeight > actual.clientHeight, 'Mobile long form must overflow its capped body');
          if (actual.scrollHeight > actual.clientHeight) {
            const scrollTop = await modal.locator('[data-console-modal-body]').evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
            assert.ok(scrollTop > 0, 'Overflow must remain scrollable');
          }
          if (!baseline) {
            // Negative controls: these must fail if the production utility is
            // absent, or if a literal still overrides the inherited token.
            await page.evaluate(() => document.documentElement.style.setProperty('--modal-viewport-cap', '75vh'));
            await expect.poll(async () => parseFloat((await metrics(page)).maxHeight)).toBeCloseTo(height * .6, 0);
            await page.evaluate(() => {
              document.documentElement.style.removeProperty('--modal-viewport-cap');
              document.documentElement.style.setProperty('--overlay-top', '10vh');
            });
            await expect.poll(async () => parseFloat((await metrics(page)).maxHeight)).toBeCloseTo(height * .75, 0);
            await page.evaluate(() => document.documentElement.style.removeProperty('--overlay-top'));
            const variant = await page.addStyleTag({ content: `${theme === 'dark' ? '.dark' : ':root'} { --modal-viewport-cap: 65vh; }` });
            await expect.poll(async () => parseFloat((await metrics(page)).maxHeight)).toBeCloseTo(height * .5, 0);
            await variant.evaluate(el => el.remove());
            if (name === 'confirmation') {
              await page.evaluate(() => document.documentElement.style.setProperty('--modal-confirmation-dim', 'rgba(10, 20, 30, .6)'));
              await expect.poll(async () => (await metrics(page)).overlay).toBe('rgba(10, 20, 30, 0.6)');
              await page.evaluate(() => document.documentElement.style.removeProperty('--modal-confirmation-dim'));
            }
          }
          await page.keyboard.press('Escape');
          await modal.waitFor({ state: 'hidden' });
          await shot('dismissed');
          assert.deepEqual(errors, [], 'Unhandled browser exceptions');
          assert.deepEqual(consoleErrors.filter(e => /React Router caught|TypeError:|ReferenceError:/.test(e)), [], 'Caught render exceptions');
          results.push({ key, path, finalUrl: page.url(), passed: true, ...actual });
          console.log(`PASS ${key}`);
        } catch (error) {
          results.push({ key, path, finalUrl: page.url(), passed: false, error: String(error), browserErrors: errors, consoleErrors });
          await page.screenshot({ path: `${output}/${key}-failure.jpg`, type: 'jpeg', quality: 80 });
          console.error(`FAIL ${key}: ${error}`);
          await writeFile(`${output}/${key}-failure.txt`, await page.locator('body').innerText());
        } finally { await context.close(); }
      }
    }
  }
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ baseline, baseURL, results }, null, 2));
  await browser.close();
}
assert.ok(results.length > 0 && results.every(r => r.passed), 'Some browser cases failed; see results.json');
