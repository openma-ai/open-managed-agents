// Historical characterization of edde3af523b0e2896d018d11248f99c3d8bc5a3e.
// Run against that baseline; current acceptance tests live in packages/ and apps/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Boundary characterization using actual source functions and pinned Effect.
// No application/provider deployment or full integration coverage is implied.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(process.env.OMA_AUDIT_DEPS ?? '/tmp/oma-525-audit', 'package.json'));
const { Effect, Fiber, Cause, Exit, Option, Data, Duration, Schedule } = require('effect');
function load(path, names, bindings) {
  let js = stripTypeScriptTypes(readFileSync(resolve(root, path), 'utf8'), { mode: 'transform' });
  js = js.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*/gm, '').replace(/\bexport /g, '');
  return Function(...Object.keys(bindings), js + `\nreturn {${names.join(',')}};`)(...Object.values(bindings));
}
const { runSupervised } = load('packages/control-plane-node/src/lib/supervised-fiber.ts', ['runSupervised'], { Effect, Fiber });
const { runPortEffect } = load('packages/managed-runtime-sandbox/src/effect-kernel.ts', ['runPortEffect'], { Effect, Cause, Exit, Option });
const db = load('packages/sql-client/src/db-errors.ts', ['Timeout', 'isLeaseSafeFailure', 'processFailureRecord'], { Effect, Cause, Exit, Option, Data, Duration, Schedule });
const { handleProcessFailure } = load('packages/control-plane-node/src/lib/db-unhandled-rejection.ts', ['handleProcessFailure'], db);
const results = [];
function record(name, evidence) { results.push({name,evidence}); console.log(JSON.stringify(results.at(-1))); }
for (const kind of ['fail', 'die']) {
  const error = Error(kind);
  const reported = [];
  const fiber = runSupervised(Effect[kind](error), e => reported.push(e));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(Exit.isSuccess(exit), true);
  assert.deepEqual(reported, [error]);
  record('runSupervised ' + kind, { reported: reported.length, fiberExit: 'Success' });
}
const primary = Error('primary operation failed'), cleanup = Error('cleanup failed');
const program = Effect.fail(primary).pipe(Effect.ensuring(Effect.die(cleanup)));
const raw = await Effect.runPromiseExit(program);
assert.equal(Cause.defects(raw.cause).length, 1);
assert.equal(Option.getOrUndefined(Cause.failureOption(raw.cause)), primary);
await assert.rejects(runPortEffect(program), error => error === primary);
record('Promise boundary returns first failure from combined Cause', { rawFailure: primary.message, rawDefect: cleanup.message, returned: primary.message });
let entered, finish;
const started = new Promise(r => entered = r);
const pending = new Promise(r => finish = r);
let released = 0, externalWrites = 0;
const task = Effect.scoped(Effect.gen(function* () {
  yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => released++));
  yield* Effect.tryPromise({ try: () => { entered(); return pending.then(() => externalWrites++); }, catch: e => e });
}));
const running = Effect.runFork(task);
await started;
await Effect.runPromise(Fiber.interrupt(running));
assert.equal(released, 1);
assert.equal(externalWrites, 0);
finish(); await pending; await Promise.resolve();
assert.equal(externalWrites, 1);
record('Ignoring AbortSignal lets external work outlive scope', { released, externalWritesAfterInterrupt: externalWrites });
const before = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
try {
  const exits = [], logs = [];
  handleProcessFailure('uncaught_exception', new db.Timeout({ op: 'audit' }), { logger: { fatal: (...args) => logs.push(args) } }, code => exits.push(code));
  assert.equal(logs.length, 1); assert.equal(exits.length, 0);
  record('Process exception has same DB allowlist as rejection', { kind: 'uncaught_exception', tag: 'Timeout', fatalLogs: logs.length, exits: exits.length });
} finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
console.log(JSON.stringify({probes: results.length, passed: results.length}));
