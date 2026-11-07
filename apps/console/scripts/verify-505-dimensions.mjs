// Run from repo root after starting Vite on 5195. Actual components, fixture API only.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('package.json'));
const { chromium, expect } = require('@playwright/test');
const { makeFixtures } = await import(pathToFileURL(resolve('apps/console/scripts/fixtures-505.mjs')));
const base = process.env.BASE_URL || 'http://127.0.0.1:5195';
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local server only');
const browser = await chromium.launch();
const results=[];
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.addInitScript(()=>{localStorage.setItem('oma-locale','en');localStorage.setItem('oma-theme','light');});
 await page.route('**/*',makeFixtures(base));
 await page.goto(base+'/integrations/linear/install-pat',{waitUntil:'networkidle'});
 const trigger=page.locator('button[role="combobox"]').first();
 await trigger.evaluate(e=>e.style.width='160px'); await trigger.click();
 const popup=page.locator('[data-slot="popover-content"]').last();
 await expect(popup).toHaveCSS('min-width','200px');
 await expect(popup).toHaveCSS('width','200px');
 await page.evaluate(()=>document.documentElement.style.setProperty('--combobox-menu-min-w','260px'));
 await expect(popup).toHaveCSS('min-width','260px'); await expect(popup).toHaveCSS('width','260px');
 results.push('Combobox 160px trigger: menu floor 200px; token override 260px changes actual width to 260px');
 await page.goto(base+'/agents',{waitUntil:'networkidle'});
 const chip=page.locator('.console-filter-chip').first(); await chip.locator('.console-filter-chip-trigger').click();
 await page.getByRole('option').nth(1).click(); await page.keyboard.press('Escape');
 const clear=chip.locator('.console-filter-chip-clear'); await expect(clear).toHaveCSS('width','20px');
 await page.evaluate(()=>document.documentElement.style.setProperty('--filter-chip-clear-w','24px'));
 await expect(clear).toHaveCSS('width','24px'); await expect(clear).toHaveCSS('flex-basis','24px');
 results.push('FilterChip clear: 20px default; token override changes width and flex basis together to 24px');
 // Mount the existing LocalCombobox for its public maxHeight prop contract.
 // Route screenshots separately cover its actual VaultDetail caller.
 await page.evaluate(async()=>{
  const main=await (await fetch('/src/main.tsx')).text();
  const clientUrl=main.match(/from "([^"]*react-dom_client[^"]*)"/)[1];
  const reactUrl=main.match(/from "([^"]*\/deps\/react\.js[^"]*)"/)[1];
  const [{LocalCombobox},clientNs,reactNs]=await Promise.all([import('/src/components/LocalCombobox.tsx'),import(clientUrl),import(reactUrl)]);
  const React=reactNs.default??reactNs,client=clientNs.default??clientNs;
  const host=document.createElement('div'); host.style.cssText='position:fixed;inset:40px;z-index:9999;background:var(--bg)'; document.body.append(host);
  const root=client.createRoot(host);
  window.renderHeight=(maxHeight)=>root.render(React.createElement(LocalCombobox,{value:'',onChange:()=>{},options:Array.from({length:20},(_,i)=>`Option ${i}`),getKey:x=>x,renderItem:x=>x,...(maxHeight===undefined?{}:{maxHeight})}));
  window.renderHeight();
 });
 await page.locator('input[role="combobox"]').focus();
 await expect(popup).toHaveCSS('max-height','288px');
 await page.evaluate(()=>document.documentElement.style.fontSize='20px');
 await expect(popup).toHaveCSS('max-height','360px');
 await page.evaluate(()=>window.renderHeight('112px')); await expect(popup).toHaveCSS('max-height','112px');
 await page.evaluate(()=>document.documentElement.style.setProperty('--local-combobox-menu-max-h','400px'));
 await expect(popup).toHaveCSS('max-height','112px');
 await page.evaluate(()=>window.renderHeight()); await expect(popup).toHaveCSS('max-height','400px');
 results.push('LocalCombobox: 18rem = 288px at 16px root, 360px at 20px root; caller 112px survives token override; removing prop resumes token 400px');
 await writeFile('.docs/screenshots/505/dimension-contracts.json',JSON.stringify(results,null,2));
 console.log(results.join('\n'));
} finally {await browser.close();}
