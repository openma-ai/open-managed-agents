/** Production-build shell regression for issue #503 (API fixtures only).
 * Serve baseline and changed builds from THIS worktree with Vite preview.
 * BASE_URL=http://127.0.0.1:5183 node apps/console/scripts/capture-503-acceptance.mjs before
 * BASE_URL=http://127.0.0.1:5184 node apps/console/scripts/capture-503-acceptance.mjs after
 * node apps/console/scripts/capture-503-acceptance.mjs compare
 * BASE_URL=http://127.0.0.1:5184 node apps/console/scripts/capture-503-acceptance.mjs negative
 * Output: .docs/screenshots/503 (or SHELL_OUTPUT); CHROME_PATH is optional.
 * Every current OSS shell route, both themes/viewports/root font sizes.
 * Detail loading states test the shell, not full detail-page functionality.
 */
import assert from 'node:assert/strict';
import { modalClosure } from '../../../test/e2e/console-modal-closure.mjs';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outRoot = process.env.SHELL_OUTPUT || path.join(root, '.docs/screenshots/503');
const base = process.env.BASE_URL || 'http://127.0.0.1:5183';
const mode = process.argv[2];
if (!['before', 'after', 'compare', 'negative'].includes(mode)) throw new Error('Usage: capture-503-acceptance.mjs before|after|compare|negative');
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local preview server.');

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb', '--font-render-hinting=none'],
});

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const LONG_ID = 'agent_503_fixture_with_a_long_identifier_for_breadcrumb_truncation_checks_0123456789';
const NOW = '2026-11-05T15:00:00Z';

const agent = {
  id: LONG_ID,
  type: 'agent',
  name: 'Shell regression agent',
  description: 'Fixture for the shell token regression.',
  model: { id: 'claude-sonnet-4-6', speed: 'standard' },
  system: 'You are a helpful assistant.',
  tools: [{ type: 'agent_toolset_20260401' }],
  mcp_servers: [],
  skills: [],
  callable_agents: [],
  metadata: {},
  version: 3,
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-05T10:00:00Z',
  archived_at: null,
};
const secondAgent = { ...agent, id: 'agent_503_second', name: 'Second agent', version: 1 };
const tenants = Array.from({ length: 12 }, (_, i) => ({
  id: `tenant_${i}`,
  name: i === 0 ? 'Default' : `Workspace ${i}`,
  role: 'owner',
}));

function json(route, body, status = 200) {
  return route.fulfill({ status, json: body });
}

function fixtures({ hang = () => false } = {}) {
  return async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
      return route.fulfill({ contentType: 'text/css', body: '' });
    }
    if (url.origin !== new URL(base).origin) return route.abort();
    if (hang(p)) return; // Never fulfilled: holds the page in its loading state.
    if (p === '/auth/get-session') {
      return json(route, {
        user: { id: 'demo', name: 'Demo User', email: 'demo@example.com' },
        session: { id: 'demo', expiresAt: '2027-01-01T00:00:00Z' },
      });
    }
    if (p === '/v1/oma/me/tenants') return json(route, { data: tenants });
    if (p === '/v1/oma/stats') {
      return json(route, { agents: 2, sessions: 0, environments: 0, vaults: 0, skills: 0, model_cards: 0, api_keys: 0 });
    }
    if (p === '/v1/agents') return json(route, { data: [agent, secondAgent], next_page: null, has_more: false });
    if (p === `/v1/agents/${LONG_ID}`) return json(route, agent);
    if (p === `/v1/agents/${LONG_ID}/versions`) return json(route, { data: [agent], next_page: null, has_more: false });
    if (p.startsWith('/v1/') || p.startsWith('/auth') || p === '/auth-info' || p === '/branding' || p === '/health'
      || p.startsWith('/matter') || p.startsWith('/linear') || p.startsWith('/github')) {
      return json(route, { data: [], next_page: null, has_more: false });
    }
    return route.continue();
  };
}

/** Computed-style readout of every declaration this PR may change. */
function readStyles() {
  const read = (selector, props, pseudo) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el, pseudo);
    return Object.fromEntries(props.map((prop) => [prop, cs[prop]]));
  };
  const crumbItems = [...document.querySelectorAll('[data-slot="breadcrumb-item"]')];
  return {
    resizeHandle: read('.console-sidebar-resize', ['right', 'width']),
    resizeBar: read('.console-sidebar-resize', ['left', 'width', 'height', 'borderTopLeftRadius'], '::after'),
    groupLabel: read('.console-sidebar-group-label', ['paddingTop', 'paddingBottom', 'paddingLeft', 'lineHeight', 'height']),
    tenantAvatar: read('.console-sidebar-tenant [data-slot="avatar"]', ['fontSize', 'width', 'height']),
    tenantMenu: read('.console-tenant-menu', ['maxHeight', 'height']),
    tenantMenuItem: read('.console-tenant-menu-item', ['gridTemplateColumns']),
    crumbPage: read('[data-slot="breadcrumb-page"]', ['maxWidth', 'width']),
    crumbParent: crumbItems.length > 1
      ? { maxWidth: getComputedStyle(crumbItems[0]).maxWidth, width: getComputedStyle(crumbItems[0]).width }
      : null,
    navProgress: read('.nav-progress-root', ['height']),
    startupLoader: read('svg.fill-current[role="status"]', ['width', 'height']),
    brandLoaders: [...document.querySelectorAll('[data-brand-loader-gap]')].map((el) => ({
      size: el.dataset.brandLoaderGap,
      columnGap: getComputedStyle(el.querySelector('[aria-hidden="true"].inline-flex')).columnGap,
    })),
  };
}

async function hideSidebar(page) {
  await page.locator('.console-shell[data-sidebar-state="desktop-full"]').waitFor();
  await page.keyboard.press('Control+\\');
  await page.locator('.console-shell[data-sidebar-state="desktop-hidden"]').waitFor();
}

const SHELL_READY = '.console-shell';

const ROUTE_SWEEP = [
  ['sessions', '/sessions'], ['deployments', '/deployments'], ['files', '/files'], ['evals', '/evals'],
  ['environments', '/environments'], ['vaults', '/vaults'], ['skills', '/skills'], ['memory', '/memory'],
  ['model-cards', '/model-cards'], ['budget', '/budget'], ['members', '/members'], ['api-keys', '/api-keys'],
  ['runtimes', '/runtimes'], ['loops', '/loops'], ['bonds', '/bonds'],
];
const LOADING_DETAILS = [
  ['agent', `/agents/${LONG_ID}`, '/v1/agents/'],
  ['environment', '/environments/env_503', '/v1/environments/'],
  ['vault', '/vaults/vlt_503', '/v1/vaults/'],
  ['memory-store', '/memory/ms_503', '/v1/memory_stores/'],
  ['deployment', '/deployments/dep_503', '/v1/oma/deployments/'],
];

const SHOTS = [
  { name: '01-dashboard', route: '/' },
  { name: '02-list-agents', route: '/agents', ready: (page) => page.getByText('Shell regression agent').first().waitFor() },
  { name: '03-detail-agent', route: `/agents/${LONG_ID}`, ready: (page) => page.getByText('Shell regression agent').first().waitFor() },
  { name: '04-sidebar-desktop-full', route: '/agents', ready: (page) => page.getByText('Shell regression agent').first().waitFor() },
  { name: '05-sidebar-desktop-hidden-restore-gutter', route: '/agents', interact: hideSidebar },
  { name: '06-sidebar-restore-hover', route: '/agents', interact: async (page) => {
    await hideSidebar(page);
    await page.locator('.console-sidebar-restore').hover();
  } },
  { name: '07-sidebar-desktop-preview', route: '/agents', interact: async (page) => {
    await hideSidebar(page);
    await page.mouse.move(2, 400);
    await page.locator('.console-shell[data-sidebar-state="desktop-preview"]').waitFor();
  } },
  { name: '08-sidebar-resize-hover', route: '/agents', interact: (page) => page.locator('.console-sidebar-resize').hover() },
  { name: '09-tenant-menu-open', route: '/agents', interact: async (page) => {
    await page.locator('.console-sidebar-tenant-trigger').click();
    await page.locator('.console-tenant-menu').waitFor();
  } },
  { name: '10-mobile-hidden', route: '/agents', viewport: MOBILE },
  { name: '11-mobile-drawer', route: '/agents', viewport: MOBILE, interact: async (page) => {
    await page.locator('.console-sidebar-restore').click();
    await page.locator('.console-shell[data-sidebar-state="mobile-drawer"]').waitFor();
  } },
  { name: '12-mobile-detail-breadcrumb', route: `/agents/${LONG_ID}`, viewport: MOBILE },
  { name: '13-startup-loader', route: '/', hang: (p) => p === '/auth/get-session', ready: 'svg.fill-current[role="status"]' },
  { name: '14-nav-progress-forced-visible', route: '/agents', interact: (page) => page.addStyleTag({
    content: '.nav-progress-root{opacity:1!important}.nav-progress-bar{transform:scaleX(.6)!important}',
  }) },

  ...ROUTE_SWEEP.map(([name, route], i) => ({ name: `${20 + i}-route-${name}`, route })),
  ...LOADING_DETAILS.map(([name, route, prefix], i) => ({
    name: `${40 + i}-loading-${name}`,
    route,
    hang: (p) => p.startsWith(prefix),
    ready: 'main svg.fill-current[role="status"]',
  })),
];
// Inventory from the current router, including redirects and empty parent outlets.
const closure = modalClosure();
for (const [i, r] of closure.shellRoutes.entries()) {
  const route = r.url.replaceAll(':benchmarkId', 'benchmark_fixture').replaceAll(':caseName', 'case_fixture');
  if (SHOTS.some(s => s.route === route)) continue;
  // Detail contents are intentionally held loading; this is shell coverage,
  // not certification of the underlying detail API or editor.
  const detail = r.pattern.includes(':');
  SHOTS.push({name: `closure-${i}`, route,
    ...(detail ? {hang: p => p.startsWith('/v1/') && !p.startsWith('/v1/oma/me')} : {})});
}


async function capture(label) {
  const out = path.join(outRoot, label);
  await mkdir(out, { recursive: true });
  const styles = {};

  async function shot({ name, route, viewport, hang, ready, interact }, theme, font, mobile) {
    const context = await browser.newContext({
      viewport: viewport || (mobile ? MOBILE : DESKTOP),
      timezoneId: 'America/Detroit',
      locale: 'en-US',
      reducedMotion: 'reduce',
      deviceScaleFactor: 1,
    });
    await context.addInitScript(({value, font}) => {
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${font}px`; });
      localStorage.setItem('oma-locale', 'en');
      localStorage.setItem('theme', value);
      localStorage.setItem('oma_active_tenant_id', 'tenant_0');
      // Empty states paint a procedural texture; seed it so runs are comparable.
      let seed = 503;
      Math.random = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
    }, {value: theme, font});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.setFixedTime(new Date(NOW));
    await page.route('**/*', fixtures({ hang }));
    await page.goto(base + route, { waitUntil: 'domcontentloaded' });
    if (typeof ready === 'string') await page.locator(ready).first().waitFor({ timeout: 20000 });
    else await page.locator(SHELL_READY).first().waitFor({ timeout: 20000 });
    if (typeof ready === 'function') await ready(page);
    if (interact) await interact(page);
    await page.waitForLoadState('networkidle', { timeout: hang ? 1500 : 10000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    assert.deepEqual(errors, [], `Browser errors: ${route}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), `${font}px`);
    const file = `${name}-${theme}-${mobile ? 'mobile' : 'desktop'}-${font}.png`;
    await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
    styles[file] = await page.evaluate(readStyles);
    await context.close();
    console.log('wrote', file);
  }

  const queue = [];
  for (const theme of ['light', 'dark']) for (const font of [16, 20]) for (const mobile of [false, true]) {
    for (const definition of SHOTS) {
      // Desktop-only interactions cannot run in the mobile-hidden shell.
      if (mobile && /^(04|05|06|07|08|09)-/.test(definition.name)) continue;
      if (!mobile && definition.viewport) continue;
      queue.push(() => shot(definition, theme, font, mobile));
    }
  }
  await writeFile(path.join(out, 'closure.json'), JSON.stringify({ routes: closure.shellRoutes, cases: SHOTS.map(({name,route})=>({name,route})), detailState: 'loading', outsideShell: closure.outsideShell }, null, 2));
  await Promise.all(Array.from({length:4}, async () => { while(queue.length) await queue.shift()(); }));
  await writeFile(path.join(out, 'styles.json'), `${JSON.stringify(styles, null, 2)}\n`);
}

async function compare() {
  const beforeDir = path.join(outRoot, 'before');
  const afterDir = path.join(outRoot, 'after');
  const names = (await readdir(beforeDir)).filter((name) => name.endsWith('.png')).sort();
  const afterNames = new Set((await readdir(afterDir)).filter((name) => name.endsWith('.png')));
  assert.ok(names.length > 0, 'Baseline screenshots must exist');
  assert.deepEqual([...afterNames].sort(), names, 'Both captures must contain the same cases');
  const page = await browser.newPage();
  await page.goto('about:blank');
  const rows = [];
  for (const name of names) {
    if (!afterNames.has(name)) {
      rows.push({ name, identical: false, missing: true });
      continue;
    }
    const [a, b] = await Promise.all([readFile(path.join(beforeDir, name)), readFile(path.join(afterDir, name))]);
    const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
    if (sha(a) === sha(b)) {
      rows.push({ name, identical: true, differentPixels: 0 });
      continue;
    }
    const diff = await page.evaluate(async ([left, right]) => {
      const decode = async (data) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const [l, r] = await Promise.all([decode(left), decode(right)]);
      const pixels = (bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      if (l.width !== r.width || l.height !== r.height) return { sizeMismatch: true };
      const lp = pixels(l);
      const rp = pixels(r);
      let count = 0;
      const box = { left: l.width, top: l.height, right: -1, bottom: -1 };
      for (let i = 0; i < lp.length; i += 4) {
        if (lp[i] !== rp[i] || lp[i + 1] !== rp[i + 1] || lp[i + 2] !== rp[i + 2] || lp[i + 3] !== rp[i + 3]) {
          count += 1;
          const x = (i / 4) % l.width;
          const y = Math.floor(i / 4 / l.width);
          box.left = Math.min(box.left, x);
          box.top = Math.min(box.top, y);
          box.right = Math.max(box.right, x);
          box.bottom = Math.max(box.bottom, y);
        }
      }
      return { differentPixels: count, box };
    }, [a.toString('base64'), b.toString('base64')]);
    rows.push({ name, identical: diff.differentPixels === 0, ...diff });
  }
  const stylesBefore = JSON.parse(await readFile(path.join(beforeDir, 'styles.json'), 'utf8'));
  const stylesAfter = JSON.parse(await readFile(path.join(afterDir, 'styles.json'), 'utf8'));
  const styleDiffs = Object.keys(stylesBefore).filter(
    (name) => JSON.stringify(stylesBefore[name]) !== JSON.stringify(stylesAfter[name]),
  );
  const summary = {
    shots: rows.length,
    pixelIdentical: rows.filter((row) => row.identical).length,
    different: rows.filter((row) => !row.identical),
    computedStyleDifferences: styleDiffs.map((name) => ({ name, before: stylesBefore[name], after: stylesAfter[name] })),
  };
  await writeFile(path.join(outRoot, 'compare.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.different.length > 0 || summary.computedStyleDifferences.length > 0) process.exitCode = 1;
}

try {
  if (mode === 'negative') {
    const page = await browser.newPage({viewport: DESKTOP});
    await page.route('**/*', fixtures());
    await page.goto(base + '/agents');
    await page.locator('.console-sidebar-group-label').first().waitFor();
    const before = await page.evaluate(readStyles);
    assert.equal(before.resizeHandle.width, '20px');
    assert.equal(before.groupLabel.lineHeight, '18px');
    assert.equal(before.resizeBar.borderTopLeftRadius, '999px');
    await page.evaluate(() => {
      // Scope overrides to changed consumers so unrelated users cannot make
      // this negative control pass accidentally.
      document.querySelectorAll('.console-sidebar-group-label').forEach(el => el.style.setProperty('--type-line', '23px'));
      document.querySelector('.console-sidebar-resize').style.setProperty('--console-radius-pill', '0px');
    });
    const after = await page.evaluate(readStyles);
    assert.equal(after.groupLabel.lineHeight, '23px');
    assert.equal(after.resizeBar.borderTopLeftRadius, '0px');
    assert.equal(after.resizeHandle.width, '20px');
    await mkdir(outRoot, {recursive:true});
    await page.screenshot({path:path.join(outRoot, 'negative.png'), animations:'disabled'});
    await writeFile(path.join(outRoot, 'negative.json'), JSON.stringify({before,after,passed:true},null,2));
    console.log('PASS: both changed declarations consume tokens; resize hit area remains 20px');
  } else if (mode === 'compare') await compare();
  else await capture(mode);
} finally {
  await browser.close();
}
