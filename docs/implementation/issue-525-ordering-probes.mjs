// Historical characterization of edde3af523b0e2896d018d11248f99c3d8bc5a3e.
// Run against that baseline; current acceptance tests live in packages/ and apps/.
// Isolated characterization probes, NOT a full service/provider certification.
// Node 24+. Install effect@3.22.1 in OMA_AUDIT_DEPS (an external temp directory).
// Source methods are extracted unchanged where loading the whole app would
// require unrelated providers. SQL uses production coordinator + native SQLite.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes, createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const deps = process.env.OMA_AUDIT_DEPS ?? '/tmp/oma-525-audit';
const external = createRequire(resolve(deps, 'package.json'));
const effectEntry = external.resolve('effect');
const source = path => readFileSync(resolve(root, path), 'utf8');
const url = path => pathToFileURL(resolve(root, path)).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'effect') return next(pathToFileURL(effectEntry).href, context);
    if (specifier.startsWith('@open-managed-agents/')) {
      const [, name, ...subpath] = specifier.split('/');
      const pkg = JSON.parse(source(`packages/${name}/package.json`));
      const entry = pkg.exports[subpath.length ? `./${subpath.join('/')}` : '.'];
      assert.equal(typeof entry, 'string');
      return next(url(`packages/${name}/${entry}`), context);
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(root).href)) {
      const candidate = fileURLToPath(new URL(specifier, context.parentURL));
      for (const path of [candidate, candidate + '.ts', candidate.replace(/\.js$/, '.ts')]) {
        if (existsSync(path)) return next(pathToFileURL(path).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
    };
    return next(url, context);
  },
});

const db = new DatabaseSync(':memory:');
const sql = {
  prepare(query) {
    let values = [];
    const statement = () => db.prepare(query);
    return {
      bind(...args) { values = args; return this; },
      async first() { return statement().get(...values) ?? null; },
      async all() { return { results: statement().all(...values) }; },
      async run() {
        const stmt = statement();
        if (stmt.columns().length) {
          const results = stmt.all(...values);
          return { results, meta: { changes: db.prepare('SELECT changes() AS n').get().n } };
        }
        return { meta: stmt.run(...values) };
      },
    };
  },
  async exec(query) { db.exec(query); },
  async batch(statements) {
    db.exec('BEGIN');
    try { const results = []; for (const stmt of statements) results.push(await stmt.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const { SqlSessionExecutionCoordinator, ensureSessionExecutionCoordinatorSchema } =
  await import(url('packages/session-runtime-sql/src/coordination.ts'));
await ensureSessionExecutionCoordinatorSchema(sql);
const coordinator = new SqlSessionExecutionCoordinator(sql);
// Characterizes FIFO tie-breaking, not a full-service or production-driver test.
// The exact coordinator runs over the atomic native SQLite adapter above.
const iso = ms => new Date(ms).toISOString();
const admit = async (id, sessionId, at) => coordinator.admit({ execution: {
  id, workspaceId: 'w', sessionId, admittedAt: iso(at),
  events: [{ id, type: 'user.message', content: [{ type: 'text', text: id }] }],
} });
await admit('z_first', 'same-time', 1000);
await admit('a_second', 'same-time', 1000);
const tie = await coordinator.claim({ workspaceId: 'w', sessionId: 'same-time',
  ownerId: 'worker', attemptId: 'tie', claimedAt: iso(1001), leaseTtlMs: 100 });
assert.equal(tie.type, 'claimed');
assert.equal(tie.execution.id, 'a_second');
console.log(JSON.stringify({ probe: 'same timestamp uses ID rather than admission order',
  admitted: ['z_first', 'a_second'], claimed: tie.execution.id }));
await admit('first', 'clock-order', 1000);
await admit('second', 'clock-order', 999);
const clock = await coordinator.claim({ workspaceId: 'w', sessionId: 'clock-order',
  ownerId: 'worker', attemptId: 'clock', claimedAt: iso(1001), leaseTtlMs: 100 });
assert.equal(clock.type, 'claimed');
assert.equal(clock.execution.id, 'second');
console.log(JSON.stringify({ probe: 'earlier timestamp takes priority over admission order',
  admitted: ['first', 'second'], claimed: clock.execution.id }));
db.close();
console.log(JSON.stringify({ probes: 2, passed: 2 }));
