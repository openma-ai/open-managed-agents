// Pixel diff before/after PNGs. Usage: node diff.mjs <before dir> <after dir>
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire('/Users/minimax/.oma/backchat/projects/workspaces/thread-e577cb13fc0d1fd30410d526de919415/01-open-managed-agents/node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/package.json');
const { PNG } = require('pngjs');
const [a, b] = process.argv.slice(2);
let bad = 0;
for (const f of readdirSync(a).filter((f) => f.endsWith('.png')).sort()) {
  const A = PNG.sync.read(readFileSync(path.join(a, f)));
  const B = PNG.sync.read(readFileSync(path.join(b, f)));
  if (A.width !== B.width || A.height !== B.height) { console.log(f, 'SIZE DIFF'); bad++; continue; }
  let diff = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2] || A.data[i + 3] !== B.data[i + 3]) diff++;
  }
  if (diff) bad++;
  console.log(f.padEnd(22), `${A.width}x${A.height}`, 'differing pixels:', diff);
}
console.log(bad ? `${bad} files differ` : 'ALL IDENTICAL');
