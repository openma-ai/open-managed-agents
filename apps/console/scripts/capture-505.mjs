/** Start apps/console Vite on 5195, then run from root:
 * node apps/console/scripts/capture-505.mjs before|after
 * Optional ONLY=agents,vault-detail for focused retries. Fixtures only.
 */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { makeFixtures } from './fixtures-505.mjs';

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Expected before|after');
const base = process.env.BASE_URL || 'http://127.0.0.1:5195';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local server only');
const out = `.docs/screenshots/505/${phase}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const cases = [
  ...['agents','sessions','deployments','environments','runtimes','evals','files','skills','vaults','memory','model-cards','loops'].map(n=>[n,`/${n}`,'chips']),
  ['vault-detail','/vaults/vault_01demo','vault'],
  ['deployment-new','/deployments/new','combos'],
  ['linear-pat','/integrations/linear/install-pat','combos'],
  ['linear-publish','/integrations/linear/publish','combos'],
  ['slack-publish','/integrations/slack/publish','combos'],
  ['github-bind','/integrations/github/bind','combos'],
  ['agent-create','/agents','agent-create'],
  ['agent-edit','/agents/agent_01demo','agent-edit'],
  ['session-create','/sessions','session-create'],
];
const results = [];
try {
 for (const width of [1440,390]) for (const [name,url,kind] of cases) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) continue;
  const context = await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,timezoneId:'UTC',locale:'en-US',reducedMotion:'reduce',colorScheme:'light'});
  await context.addInitScript(()=>{localStorage.setItem('oma-locale','en');localStorage.setItem('oma-theme','light');});
  const pg = await context.newPage(); pg.setDefaultTimeout(7000);
  await pg.clock.setFixedTime(new Date('2026-11-07T12:00:00Z'));
  await pg.route('**/*',makeFixtures(base));
  const entry={name,width,url,shots:[],errors:[],styles:[]}; results.push(entry);
  pg.on('pageerror',e=>entry.errors.push(String(e)));
  async function shot(state) {
   await pg.evaluate(()=>document.fonts.ready);
   await pg.waitForTimeout(200);
   const file=`${name}-${width}-${state}.png`;
   await pg.screenshot({path:`${out}/${file}`,animations:'disabled'}); entry.shots.push(file);
  }
  async function combos() {
   const buttons=pg.locator('button[role="combobox"][aria-haspopup="listbox"]');
   const count=await buttons.count(); if (!count) throw new Error('No Combobox consumers found');
   for(let i=0;i<count;i++) {
    const button=buttons.nth(i); await button.click();
    const popup=pg.locator('[data-slot="popover-content"]').last();
    await expect(popup).toBeVisible(); await expect(popup).toHaveCSS('min-width','200px');
    entry.styles.push({control:`combobox-${i}`,minWidth:await popup.evaluate(e=>getComputedStyle(e).minWidth)});
    const options=popup.getByRole('option'); await expect(options.first()).toBeVisible();
    await shot(`combo-${i}-open`);
    const search=popup.locator('input');
    if(await search.count()) {
     await search.fill('nonexistent-505'); await expect(options).toHaveCount(0); await shot(`combo-${i}-empty`);
     await search.fill('research'); await expect(options.first()).toBeVisible();
    }
    await pg.keyboard.press('ArrowDown'); await pg.keyboard.press('Enter');
    await expect(popup).toBeHidden(); await shot(`combo-${i}-selected`);
   }
  }
  async function resetHorizontalScroll() {
   // Playwright may scroll overflow:hidden ancestors to reveal a long active
   // chip on mobile. Start each action from the same scroll position.
   await pg.evaluate(()=>{for(const e of document.querySelectorAll('*')) if(e.scrollLeft) e.scrollLeft=0;});
  }
  async function chips() {
   await expect(pg.locator('.console-filter-chip').first()).toBeVisible();
   await expect(pg.locator('tbody tr').first()).toBeVisible();
   entry.rows=await pg.locator('tbody tr').count(); await shot('populated');
   const count=await pg.locator('.console-filter-chip').count();
   for(let i=0;i<count;i++) {
    await resetHorizontalScroll();
    const chip=pg.locator('.console-filter-chip').nth(i); await chip.locator('.console-filter-chip-trigger').click();
    const popup=pg.locator('[data-slot="popover-content"]').last(); await expect(popup).toBeVisible();
    await shot(`chip-${i}-open`);
    const options=popup.getByRole('option');
    if(await options.count()>1) await options.nth(1).click();
    else if(await popup.getByRole('button',{name:'Today',exact:true}).count()) await popup.getByRole('button',{name:'Today',exact:true}).click();
    else throw new Error(`No selectable filter ${i}`);
    await pg.keyboard.press('Escape');
    const clear=chip.locator('.console-filter-chip-clear'); await expect(clear).toBeVisible();
    await expect(clear).toHaveCSS('width','20px'); await expect(clear).toHaveCSS('flex-basis','20px');
    entry.styles.push({control:`chip-${i}`,width:'20px',flexBasis:'20px'});
    await resetHorizontalScroll(); await clear.hover(); await shot(`chip-${i}-active-hover`); await clear.click(); await expect(clear).toHaveCount(0);
   }
   await shot('cleared');
  }
  try {
   await pg.goto(base+url,{waitUntil:'networkidle'});
   if(kind==='chips'||kind==='vault') await chips();
   if(kind==='combos') await combos();
   if(kind==='agent-create') {await pg.getByRole('button',{name:/New agent$/}).first().click(); await pg.getByRole('button',{name:/^Deep researcher/}).click(); await combos();}
   if(kind==='agent-edit') {await pg.getByRole('button',{name:/Edit/i}).first().click(); await combos();}
   if(kind==='session-create') {await pg.getByRole('button',{name:/Create session$/i}).first().click(); await combos();}
   if(kind==='vault') {
    await pg.getByRole('button',{name:/Add credential/i}).first().click();
    const input=pg.locator('input[role="combobox"]'); await input.focus();
    const popup=pg.locator('[data-slot="popover-content"]').last(); await expect(popup).toHaveCSS('max-height','288px');
    entry.styles.push({control:'local-combobox',maxHeight:'288px'}); await shot('local-open');
    await input.fill('nonexistent-505'); await shot('local-empty');
    await input.fill('github'); await shot('local-search');
    await popup.getByRole('button').first().click(); await expect(popup).toBeHidden(); await shot('local-selected');
    await pg.getByRole('button',{name:'Clear',exact:true}).click(); await expect(input).toHaveValue('');
   }
  } catch(e) {entry.errors.push(String(e)); await shot('ERROR');}
  console.log(name,width,entry.errors.length?'FAIL '+entry.errors.join('\n'):'PASS',entry.shots.length);
  await context.close();
  await writeFile(`${out}/results${process.env.ONLY?'-'+process.env.ONLY:''}.json`,JSON.stringify(results,null,2));
 }
} finally {await browser.close();}
if(results.some(r=>r.errors.length)) process.exitCode=1;
