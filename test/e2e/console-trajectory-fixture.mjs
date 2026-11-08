/** Isolated rendering of the real TrajectoryViewerModal, not a SessionDetail route test. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const consoleRoot = path.join(repo, 'apps/console');
const output = path.resolve(process.env.MODAL_OUTPUT ?? 'test-results/modal-trajectory');
const baseRef = process.env.MODAL_BASE_REF ?? '0d26903185e3fd8bb89c6499ae21f021e3a3b23e';
await mkdir(output, { recursive: true });

if (process.argv.includes('--build')) {
  const require = createRequire(path.join(consoleRoot, 'package.json'));
  const { build } = await import(require.resolve('vite'));
  const entry = path.join(consoleRoot, 'node_modules/.cache/modal-trajectory-fixture');
  await mkdir(entry, { recursive: true });
  await writeFile(path.join(entry, 'entry.js'), `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { TrajectoryViewerModal } from ${JSON.stringify(path.join(consoleRoot, 'src/pages/session-detail/Trajectory.tsx'))};
    const trajectory = { schema_version: 'oma.trajectory.v1', trajectory_id: 'trajectory_fixture', session_id: 'session_fixture', outcome: 'success', agent_config: {}, environment_config: {}, model: { id: 'fixture', provider: 'fixture' }, started_at: '2026-11-07T00:00:00Z', events: Array.from({length:80}, (_, i) => ({ id:i, type:'agent.message', text:'Deterministic browser fixture event ' + i })), summary: { num_events:80, num_turns:1, num_tool_calls:0, num_tool_errors:0, num_threads:1, duration_ms:1000, token_usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0} } };
    function Fixture() {
      const [open,setOpen]=useState(false);
      const state = new URLSearchParams(location.search).get('state');
      return React.createElement(React.Fragment, null,
        React.createElement('p', null, 'Isolated Trajectory component fixture — not the SessionDetail route'),
        React.createElement('button', {onClick:()=>setOpen(true)}, 'Open trajectory'),
        React.createElement(TrajectoryViewerModal, {open,onClose:()=>setOpen(false),sessionId:'session_fixture',trajectory:state==='loading'?'loading':state==='error'?'error':trajectory}));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  `);
  for (const revision of ['before', 'after']) {
    const productionDir = revision === 'before' ? process.env.MODAL_BEFORE_DIST : process.env.MODAL_AFTER_DIST ?? path.join(consoleRoot, 'dist');
    assert.ok(productionDir, 'MODAL_BEFORE_DIST must point to the retained pre-change production build');
    const productionHtml = await readFile(path.join(productionDir, 'index.html'), 'utf8');
    const css = [...productionHtml.matchAll(/href="([^"]+\.css)"/g)].map(m => `<link rel="stylesheet" href="/production${m[1]}">`).join('');
    assert.ok(css, 'Production stylesheet must exist');
    await writeFile(path.join(entry, 'index.html'), `<html><head><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>`);
    const overrides = new Map(['src/components/Modal.tsx'].map(file => [path.join(consoleRoot, file), execFileSync('git', ['show', `${baseRef}:apps/console/${file}`], {cwd:repo,encoding:'utf8'})]));
    await build({ root: consoleRoot, configFile: path.join(consoleRoot, 'vite.config.ts'),
      plugins: revision === 'before' ? [{ name:'baseline-modal-sources', enforce:'pre', load(id) { return overrides.get(id); } }] : [],
      build:{ outDir:path.join(output,revision),emptyOutDir:true,rollupOptions:{input:path.join(entry,'index.html')} } });
    // Use the exact production CSS/assets, not a new Tailwind scan of old
    // class names that no longer occur in the current source tree.
    await cp(path.join(productionDir, 'assets'), path.join(output, revision, 'production/assets'), {recursive:true});
  }
  process.exit(0);
}

const browser = await chromium.launch();
const results = [];
try {
  for (const theme of ['light','dark']) for (const [width,height,font] of [[1280,900,16],[390,640,16],[390,640,20]]) for (const state of ['ready','loading','error']) {
    if (width < 600 && state !== 'ready') continue;
    const key = `trajectory-${state}-${theme}-${width}-${font}`;
    const page = await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});
    try {
      await page.goto(`${process.env.MODAL_BASE_URL ?? 'http://127.0.0.1:4188'}/node_modules/.cache/modal-trajectory-fixture/index.html?state=${state}`);
      await page.evaluate(({theme,font}) => { document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.style.fontSize=`${font}px`; },{theme,font});
      const shot = async state => { await page.evaluate(()=>document.fonts.ready); await page.screenshot({path:`${output}/${key}-${state}.jpg`,type:'jpeg',quality:80,animations:'disabled'}); };
      await shot('closed');
      await page.getByRole('button',{name:'Open trajectory',exact:true}).click();
      const modal=page.getByRole('dialog',{name:'Trajectory',exact:true});
      await expect(modal).toBeVisible();
      const metrics=await modal.evaluate(el=>{const body=el.querySelector('[data-console-modal-body]');const r=el.getBoundingClientRect();return {maxHeight:getComputedStyle(el).maxHeight,height:r.height,top:r.top,bottom:r.bottom,padding:getComputedStyle(body).padding,bodyClientHeight:body.clientHeight,bodyScrollHeight:body.scrollHeight};});
      assert.ok(Math.abs(parseFloat(metrics.maxHeight)-height*.7)<1);
      assert.ok(metrics.bottom<=height);
      assert.equal(metrics.padding,`${font}px ${font*1.5}px`);
      await shot('open');
      if (state==='ready') {
        const scrolled=await modal.locator('pre').evaluate(el=>{el.scrollTop=el.scrollHeight;return el.scrollTop;});
        assert.ok(scrolled>0,'Long trajectory must scroll');
        await shot('scrolled');
        const download=page.waitForEvent('download');
        await modal.getByRole('button',{name:'Download JSON'}).click();
        assert.equal((await download).suggestedFilename(),'trajectory-session_fixture.json');
      } else await expect(modal.getByRole('button',{name:'Download JSON'})).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
      await shot('dismissed');
      results.push({key,state,passed:true,...metrics});
      console.log(`PASS ${key}`);
    } catch(error) { results.push({key,state,passed:false,error:String(error)});console.error(`FAIL ${key}: ${error}`); }
    finally { await page.close(); }
  }
} finally { await browser.close();await writeFile(path.join(output,'results.json'),JSON.stringify({kind:'isolated real component; not route reachability',baseRef,results},null,2)); }
assert.ok(results.every(r=>r.passed));
