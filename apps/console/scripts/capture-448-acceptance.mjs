/** Local, deterministic acceptance fixtures. Run Vite first, then:
 * node apps/console/scripts/capture-448-acceptance.mjs
 * BASE_URL and CHROME_PATH may override local defaults. All API requests are intercepted.
 */
import { chromium, expect } from '@playwright/test';
import { mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = path.join(root, 'docs/screenshots/448/acceptance');
const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local Vite server.');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const environment = { id: 'env_015G274T4yMp3tsjGAWJfQ7V', type: 'environment', name: 'oma-lifecycle-probe', config: { type: 'cloud' }, scope: 'organization', created_at: '2026-10-29T10:00:00Z', updated_at: '2026-10-29T10:00:00Z', archived_at: null };
const refs = (await readdir('/workspace/cma-deployments-ui')).filter(name => /^\d\d-.*\.(png|webp)$/.test(name)).sort();
const failures = [];
async function positionAt(locator, top) {
  await locator.evaluate((element, targetTop) => {
    let ancestor = element.parentElement;
    while (ancestor) {
      if (ancestor.scrollHeight > ancestor.clientHeight && /auto|scroll/.test(getComputedStyle(ancestor).overflowY)) {
        ancestor.scrollTop += element.getBoundingClientRect().top - targetTop;
        return;
      }
      ancestor = ancestor.parentElement;
    }
    window.scrollBy(0, element.getBoundingClientRect().top - targetTop);
  }, top);
}
try {
for (let n = 1; n <= 22; n++) {
  const width = n === 1 ? 1280 : n === 3 || n === 4 ? 1910 : 1920;
  const height = n === 1 ? 800 : n === 3 ? 1115 : n === 4 ? 1405 : 1072;
  const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'America/Chicago', locale: 'en-US', reducedMotion: 'reduce' });
  await context.addInitScript(() => { localStorage.setItem('oma-locale', 'en'); localStorage.setItem('oma-theme', 'light'); });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-11-03T13:00:00Z'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    let data;
    if (p === '/auth/get-session') data = { user: { id: 'demo', name: 'Demo', email: 'demo@example.com' }, session: { id: 'demo', expiresAt: '2027-01-01T00:00:00Z' } };
    else if (p === '/v1/oma/me/tenants') data = { data: [{ id: 'demo', name: 'Default', role: 'owner' }] };
    else if (p === '/v1/files' && route.request().method() === 'POST') {
      const body = route.request().postDataBuffer()?.toString() || '';
      if (!body.includes('filename="brief.txt"') || !body.includes('acceptance upload')) failures.push('Inline upload lost its filename or content');
      data = { id: 'file_acceptance', filename: 'brief.txt', type: 'file', size_bytes: 17, media_type: 'text/plain' };
    }
    else if (p === '/v1/environments') data = { data: [environment], next_page: null };
    else if (p === `/v1/environments/${environment.id}`) data = environment;
    else if (p === '/v1/deployments' || p === '/v1/sessions') {
      if ((n === 2 && p === '/v1/deployments') || (n === 19 && p === '/v1/sessions')) return; // deliberately pending for loading state
      data = { data: [], next_page: null };
    } else if (p.startsWith('/v1/')) data = { data: [], next_page: null, has_more: false };
    else if (p.startsWith('/auth') || p === '/auth-info') data = {};
    if (data !== undefined) return route.fulfill({ json: data });
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.origin !== new URL(base).origin) { failures.push(`Unexpected external request: ${url.origin}${p}`); return route.abort(); }
    return route.continue();
  });
  const route = n <= 2 ? '/deployments' : n >= 19 && n <= 21 ? '/sessions' : n === 22 ? '/environments' : '/deployments/new';
  await page.goto(base + route);
  await page.getByRole('heading', { level: 1 }).waitFor();
  if (n === 1) await expect(page.getByText('No deployments', { exact: true })).toBeVisible();
  if (n === 2 || n === 19) await expect(page.locator('.console-data-row-skeleton')).toHaveCount(10);
  if (n >= 20 && n <= 21) await expect(page.getByText('No active sessions', { exact: true })).toBeVisible();
  if (n === 22) await expect(page.getByRole('cell', { name: environment.name, exact: true })).toBeVisible();
  if (n >= 4 && n <= 18) await page.getByRole('tab', { name: 'Schedule', exact: true }).click();
  if (n >= 11 && n <= 18) await page.getByRole('button', { name: 'Edit cron', exact: true }).click();
  if (n === 5) { await positionAt(page.locator('#deployment-frequency'), 684); await page.locator('#deployment-frequency').click(); await expect(page.getByRole('option', { name: 'Every minute', exact: true })).toBeVisible(); }
  if (n === 6) { await page.locator('#deployment-agent').click(); await expect(page.getByText('No agents yet.', {exact:true})).toBeVisible(); }
  if (n === 7) { await page.locator('#deployment-environment').click(); await expect(page.getByRole('option', {name: new RegExp(environment.name)})).toBeVisible(); }
  if (n === 8) { await page.getByRole('button', {name:'Add vault',exact:true}).click(); await expect(page.getByText('None in this workspace yet.')).toBeVisible(); }
  if (n === 9) { await page.getByRole('button', {name:'Add resource',exact:true}).click(); await expect(page.getByRole('menuitem', {name:'GitHub repository',exact:true})).toBeVisible(); }
  if (n === 10) { await positionAt(page.getByRole('button', {name:/Times shown are targets/}), 610); await page.getByRole('button', {name:/Times shown are targets/}).hover(); await expect(page.getByRole('tooltip')).toBeVisible(); }
  if (n >= 12 && n <= 18) {
    const kind = n === 13 ? 'File' : n === 14 || n === 18 ? 'Memory store' : 'GitHub repository';
    await page.getByRole('button', {name:'Add resource',exact:true}).click();
    await page.getByRole('menuitem', {name:kind,exact:true}).click();
    await page.getByRole('button', {name:'Add resource',exact:true}).scrollIntoViewIfNeeded();
    if (n === 15) { await page.locator('#deployment-resource-0-checkout').click(); await expect(page.getByRole('option', {name:'Commit',exact:true})).toBeVisible(); }
    if (n === 16 || n === 17) {
      await page.locator('#deployment-resource-0-checkout').click();
      await page.getByRole('option', {name:n === 16 ? 'Branch' : 'Commit',exact:true}).click();
      await expect(page.locator('#deployment-resource-0-ref')).toBeVisible();
    }
    if (n === 17) { await page.getByRole('button', {name:'Cancel',exact:true}).click(); await expect(page.getByRole('dialog', {name:'Unsaved changes',exact:true})).toBeVisible(); }
    if (n === 18) { await page.locator('#deployment-resource-0-access').click(); await expect(page.getByRole('option', {name:'Read only',exact:true})).toBeVisible(); }
  }
  if (n === 11) await page.getByRole('button', {name:'Add resource',exact:true}).scrollIntoViewIfNeeded();
  if (n === 21) { await page.getByRole('button', {name:'Deployment All',exact:true}).click(); await expect(page.getByText('No deployments yet.', {exact:true})).toBeVisible(); }
  if (n === 19 || n === 20 || n === 21) {
    await expect(page.getByRole('button', { name: /Status.*Active/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Created.*All time/ })).toBeVisible();
  }
  await page.waitForTimeout(200); // finish component transitions, never wait for a production response
  const name = refs[n - 1].replace(/\.(png|webp)$/, '.png');
  await page.screenshot({ path: path.join(out, name) });
  if (n === 13) {
    await page.getByLabel('Choose a file', {exact: true}).setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('acceptance upload') });
    await expect(page.getByText('brief.txt', {exact:true})).toBeVisible();
    await page.getByRole('tab', {name:'File ID', exact:true}).click();
    await expect(page.locator('#deployment-resource-0-file')).toHaveValue('file_acceptance');
  }
  console.log(`Captured ${name} (${width}×${height})`);
  await context.close();
}
} finally { await browser.close(); }
if (failures.length) throw new Error(failures.join('\n'));
// The source viewport is preserved on each half; reference images are never modified.
execFileSync('python3', ['-c', `
from PIL import Image
from pathlib import Path
refs=sorted(p for p in Path('/workspace/cma-deployments-ui').iterdir() if p.name[:2].isdigit() and p.suffix in ('.png','.webp'))
out=Path(${JSON.stringify(out)})
dest=Path('/tmp/448-accept');dest.mkdir(exist_ok=True)
for ref in refs:
    oma=out/(ref.stem+'.png')
    a,b=Image.open(ref).convert('RGB'),Image.open(oma).convert('RGB')
    combined=Image.new('RGB',(a.width+b.width,max(a.height,b.height)),'white')
    combined.paste(a,(0,0));combined.paste(b,(a.width,0));combined.save(dest/(ref.name[:2]+'.png'))
`]);
console.log('Built 22 reference-left | OMA-right composites in /tmp/448-accept/.');
