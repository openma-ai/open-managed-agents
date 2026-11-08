// Exact RGBA comparison of before/after captures, using Chromium's PNG decoder.
// Run from repo root: node apps/console/scripts/compare-505.mjs
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const require=createRequire(resolve('package.json'));
const {chromium}=require('@playwright/test');
const root='.docs/screenshots/505';
const before=JSON.parse(await readFile(`${root}/before/results.json`));
const after=JSON.parse(await readFile(`${root}/after/results.json`));
if(before.length!==after.length || [...before,...after].some(x=>x.errors.length)) throw new Error('Incomplete or failed capture matrix');
const browser=await chromium.launch();
const results=[];
try {
 const page=await browser.newPage();
 for(let i=0;i<before.length;i++) {
  const a=before[i],b=after[i];
  if(JSON.stringify(a.shots)!==JSON.stringify(b.shots) || JSON.stringify(a.styles)!==JSON.stringify(b.styles)) throw new Error(`Capture/style mismatch: ${a.name} ${a.width}`);
  for(const file of a.shots) {
   const bytes=await Promise.all(['before','after'].map(async phase=>(await readFile(`${root}/${phase}/${file}`)).toString('base64')));
   const diff=await page.evaluate(async bytes=>{
    const decoded=await Promise.all(bytes.map(async s=>{
     const bitmap=await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
     const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
     ctx.drawImage(bitmap,0,0); return {width:bitmap.width,height:bitmap.height,data:ctx.getImageData(0,0,bitmap.width,bitmap.height).data};
    }));
    const [a,b]=decoded; if(a.width!==b.width||a.height!==b.height) throw new Error('Image dimensions differ');
    let pixels=0;for(let i=0;i<a.data.length;i+=4) if(a.data[i]!==b.data[i]||a.data[i+1]!==b.data[i+1]||a.data[i+2]!==b.data[i+2]||a.data[i+3]!==b.data[i+3]) pixels++;
    return pixels;
   },bytes);
   results.push({file,differentPixels:diff});
   if(diff) console.log(file,diff);
  }
 }
} finally {await browser.close();}
await writeFile(`${root}/pixel-comparison.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify({pairs:results.length,identical:results.filter(r=>!r.differentPixels).length,stylesIdentical:true}));
