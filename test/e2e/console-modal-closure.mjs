// Read the real router/import graph; do not maintain a parallel route list.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../apps/console/src/', import.meta.url)));
const consoleRequire = createRequire(path.join(root, '../package.json'));
const reactPluginRequire = createRequire(consoleRequire.resolve('@vitejs/plugin-react'));
const babelRequire = createRequire(reactPluginRequire.resolve('@babel/core'));
const { parse } = babelRequire('@babel/parser');
const ast = file => parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, visit)); return; }
  visit(node);
  for (const [key, value] of Object.entries(node)) if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) walk(value, visit);
}
const prop = (node, name) => node.properties?.find(p => p.key?.name === name)?.value;

export function modalClosure() {
  let routes;
  walk(ast(path.join(root, 'main.tsx')), n => { if (n.type === 'VariableDeclarator' && n.id.name === 'protectedRoutes') routes = n.init; });
  if (!routes) throw new Error('protectedRoutes not found');
  const shellRoutes = [];
  function flatten(array, parent = '') {
    for (const node of array.elements) {
      if (node.type === 'SpreadElement') continue; // Plugin registry separately verified below.
      const pattern = `${parent}/${prop(node, 'path')?.value ?? ''}`.replace(/\/$/, '') || '/';
      const children = prop(node, 'children');
      if (children) flatten(children, pattern === '/' ? '' : pattern);
      // A group without an index still matches its own URL and mounts the
      // outer shell (e.g. /integrations with an empty Outlet).
      const shellOnlyParent = !!children && !children.elements.some(child => prop(child, 'index')?.value === true);
      if (!prop(node, 'lazy') && !prop(node, 'element') && !shellOnlyParent) continue;
      let module, redirect;
      walk(prop(node, 'lazy'), n => { if (n.type === 'CallExpression' && n.callee.type === 'Import') module = n.arguments[0]?.value; });
      walk(prop(node, 'element'), n => { if (n.type === 'JSXAttribute' && n.name.name === 'to') redirect = n.value.value; });
      const group = pattern.split('/')[1];
      const ids = { agents: 'agent_fixture', sessions: 'session_fixture', deployments: 'deployment_fixture', evals: 'eval_fixture', environments: 'env_fixture', vaults: 'vault_fixture', memory: 'ms_fixture', loops: 'loop_fixture', bonds: 'slack:fixture', integrations: 'installation_fixture' };
      shellRoutes.push({ pattern, url: pattern.replace(':id', ids[group] ?? 'fixture').replace('*', 'modal-fixture-unknown'), module, redirect, ...(shellOnlyParent ? { shellOnlyParent: true } : {}) });
    }
  }
  flatten(routes);
  let plugins;
  walk(ast(path.join(root, 'plugins/registry.ts')), n => { if (n.type === 'VariableDeclarator' && n.id.name === 'consolePlugins') plugins = n.init; });
  if (plugins?.type !== 'ArrayExpression' || plugins.elements.length) throw new Error('Plugin routes changed: extend the route inventory before capture');
  function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(path.join(dir, d.name)) : [path.join(dir, d.name)]); }
  const reverse = new Map();
  for (const file of files(root).filter(f => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\./.test(f))) {
    walk(ast(file), n => {
      const source = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type) ? n.source?.value : n.type === 'CallExpression' && n.callee.type === 'Import' ? n.arguments[0]?.value : undefined;
      if (!source?.startsWith('.') && !source?.startsWith('@/')) return;
      const stem = source.startsWith('@/') ? path.join(root, source.slice(2)) : path.resolve(path.dirname(file), source);
      const resolved = [stem, `${stem}.tsx`, `${stem}.ts`, `${stem}/index.tsx`, `${stem}/index.ts`].find(p => existsSync(p) && /\.(ts|tsx)$/.test(p));
      if (resolved) { if (!reverse.has(resolved)) reverse.set(resolved, new Set()); reverse.get(resolved).add(file); }
    });
  }
  const wrappers = {};
  for (const name of ['Modal', 'Select', 'Input', 'Avatar']) {
    const direct = [...(reverse.get(path.join(root, `components/${name}.tsx`)) ?? [])];
    const seen = new Set(), pending = [...direct];
    while (pending.length) { const f = pending.pop(); if (seen.has(f)) continue; seen.add(f); pending.push(...(reverse.get(f) ?? [])); }
    const relative = list => [...list].map(f => path.relative(root, f)).sort();
    wrappers[name] = { directCount: direct.length, direct: relative(direct), closure: relative(seen) };
  }
  return { wrappers, shellRoutes, pluginRoutes: [], shellReason: 'Modal <- TenantSwitcher <- AppSidebar <- AppShell; every protected route mounts this shell.', outsideShell: ['/join', '/login', '/cli/login', '/connect-runtime'], outsideReason: 'Separate router branches; no TenantSwitcher. Sharing a module (e.g. JoinWorkspace/WorkspaceMembers) does not mount every export in it.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(modalClosure(), null, 2));
