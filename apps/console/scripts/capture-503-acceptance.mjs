/** Local deterministic shell regression for issue #503 (fixtures only, no backend).
 *
 * Start Vite from apps/console first:
 *   pnpm exec vite --host 127.0.0.1 --port 5183 --strictPort
 * Then, from the repository root:
 *   node apps/console/scripts/capture-503-acceptance.mjs before   # on the base commit
 *   node apps/console/scripts/capture-503-acceptance.mjs after    # on the PR head
 *   node apps/console/scripts/capture-503-acceptance.mjs compare
 *
 * Output goes to the gitignored .docs/screenshots/503/<label>/. Every shot also
 * records computed styles for the declarations the PR touches (styles.json).
 */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outRoot = path.join(root, '.docs/screenshots/503');
const base = process.env.BASE_URL || 'http://127.0.0.1:5183';
const mode = process.argv[2];
if (!['before', 'after', 'compare'].includes(mode)) throw new Error('Usage: capture-503-acceptance.mjs before|after|compare');
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local Vite server.');

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
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

/** Renders the real BrandLoader sizes through Vite's own module graph. */
async function mountBrandLoaders(page) {
  await page.evaluate(async () => {
    const main = await (await fetch('/src/main.tsx')).text();
    const clientUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)?.[1];
    const reactUrl = main.match(/from "([^"]*\/deps\/react\.js[^"]*)"/)?.[1];
    const [{ BrandLoader }, clientNs, reactNs] = await Promise.all([
      import('/src/components/BrandLoader.tsx'),
      import(clientUrl),
      import(reactUrl),
    ]);
    const client = clientNs.default ?? clientNs;
    const React = reactNs.default ?? reactNs;
    const host = document.createElement('div');
    host.setAttribute('style', 'position:fixed;inset:0;z-index:9999;display:flex;gap:48px;align-items:center;justify-content:center;background:var(--bg)');
    document.body.append(host);
    client.createRoot(host).render(
      React.createElement(React.Fragment, null, ...['sm', 'md', 'lg'].map((size) =>
        React.createElement('span', { key: size, 'data-brand-loader-gap': size },
          React.createElement(BrandLoader, { size })))),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
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
  { name: '15-brand-loader-sizes', route: '/agents', interact: mountBrandLoaders },
  ...ROUTE_SWEEP.map(([name, route], i) => ({ name: `${20 + i}-route-${name}`, route })),
  ...LOADING_DETAILS.map(([name, route, prefix], i) => ({
    name: `${40 + i}-loading-${name}`,
    route,
    hang: (p) => p.startsWith(prefix),
    ready: 'main svg.fill-current[role="status"]',
  })),
];
const DARK_SHOTS = SHOTS.filter((shot) => /^(01|03|05|09|11)-/.test(shot.name));

async function capture(label) {
  const out = path.join(outRoot, label);
  await mkdir(out, { recursive: true });
  const styles = {};

  async function shot({ name, route, viewport = DESKTOP, hang, ready, interact }, theme) {
    const context = await browser.newContext({
      viewport,
      timezoneId: 'America/Detroit',
      locale: 'en-US',
      reducedMotion: 'reduce',
      deviceScaleFactor: 2,
    });
    await context.addInitScript((value) => {
      localStorage.setItem('oma-locale', 'en');
      localStorage.setItem('theme', value);
      localStorage.setItem('oma_active_tenant_id', 'tenant_0');
      // Empty states paint a procedural texture; seed it so runs are comparable.
      let seed = 503;
      Math.random = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
    }, theme);
    const page = await context.newPage();
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
    const file = `${name}-${theme}.png`;
    await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
    styles[file] = await page.evaluate(readStyles);
    await context.close();
    console.log('wrote', file);
  }

  for (const definition of SHOTS) await shot(definition, 'light');
  for (const definition of DARK_SHOTS) await shot(definition, 'dark');
  await writeFile(path.join(out, 'styles.json'), `${JSON.stringify(styles, null, 2)}\n`);
}

async function compare() {
  const beforeDir = path.join(outRoot, 'before');
  const afterDir = path.join(outRoot, 'after');
  const names = (await readdir(beforeDir)).filter((name) => name.endsWith('.png')).sort();
  const afterNames = new Set((await readdir(afterDir)).filter((name) => name.endsWith('.png')));
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
  if (mode === 'compare') await compare();
  else await capture(mode);
} finally {
  await browser.close();
}
