// Historical characterization of edde3af523b0e2896d018d11248f99c3d8bc5a3e.
// Run against that baseline; current acceptance tests live in packages/ and apps/.
// Characterization probes for issue #525's IO/error-policy assessment.
// These assert existing behavior, including gaps; passing is not a fix.
// Node 24+; install effect@3.22.1 into OMA_AUDIT_DEPS (default below).
//
// The PostgreSQL probe uses the production adapter with a fake driver that
// applies a write before reporting CONNECTION_CLOSED. It proves the adapter's
// retry policy, not that a real PostgreSQL network failure was reproduced.
// The timeout probe uses the production DB boundary and a controlled promise.
// The harness probe extracts the current classifier without loading providers;
// it does not execute a real model request or a complete harness turn.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootUrl = pathToFileURL(root + '/').href;
const deps = resolve(process.env.OMA_AUDIT_DEPS ?? '/tmp/oma-525-audit');
const external = createRequire(resolve(deps, 'package.json'));
// Resolve before installing hooks so this lookup cannot recurse through them.
const effectEntry = external.resolve('effect');
const sourceUrl = (path) => pathToFileURL(resolve(root, path)).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'effect') {
      return next(pathToFileURL(effectEntry).href, context);
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(rootUrl)) {
      const candidate = fileURLToPath(new URL(specifier, context.parentURL));
      for (const path of [candidate, candidate + '.ts', candidate.replace(/\.js$/, '.ts')]) {
        if (existsSync(path)) return next(pathToFileURL(path).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(rootUrl) && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
      };
    }
    return next(url, context);
  },
});

const results = [];
function record(name, evidence) {
  const result = { name, evidence };
  results.push(result);
  console.log(JSON.stringify(result));
}

const { PostgresSqlClient } = await import(sourceUrl('packages/sql-client/src/adapters/postgres.ts'));
const { withDbBoundary, setDbBoundaryLogger } = await import(sourceUrl('packages/sql-client/src/db-errors.ts'));
setDbBoundaryLogger(() => {});

// Unknown commit outcome: the first request applied its mutation but lost its
// response. The fake driver's error matches postgres.js's mapped error code.
let committed = 0;
let calls = 0;
const client = new PostgresSqlClient({
  async unsafe() {
    committed += 1;
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error('response lost after commit'), { code: 'CONNECTION_CLOSED' });
    }
    return Object.assign([], { count: 1 });
  },
});
await client.prepare('UPDATE test_counter SET n = n + 1').run();
assert.equal(calls, 2);
assert.equal(committed, 2);
record('Postgres adapter repeats a write after an unknown commit outcome', { calls, committed });

// Wait for the actual deadline rejection before releasing the operation; no
// sleep-based assumption about when the timeout occurred is necessary.
let lateWrites = 0;
let finish;
const pending = new Promise((resolvePending) => {
  finish = () => {
    lateWrites += 1;
    resolvePending('committed');
  };
});
await assert.rejects(
  withDbBoundary({ op: 'audit.write', timeoutMs: 5 }, () => pending),
  (error) => error._tag === 'Timeout',
);
assert.equal(lateWrites, 0);
const lateWritesAtTimeout = lateWrites;
finish();
await pending;
assert.equal(lateWrites, 1);
record('DB boundary timeout does not cancel the pending write', { lateWritesAtTimeout, lateWritesAfterCompletion: lateWrites });

const { AuthError, PaymentRequiredError, ConfigError } = await import(sourceUrl('packages/shared/src/errors.ts'));
const runner = readFileSync(resolve(root, 'packages/control-plane-node/src/lib/node-managed-session-runner.ts'), 'utf8');
const marker = 'function isNonRetryableHarnessError';
const start = runner.indexOf(marker);
assert.ok(start >= 0, 'The production harness retry classifier must exist');
const classifier = runner.slice(start);
const nonretry = Function(
  stripTypeScriptTypes(classifier, { mode: 'transform' }) + '\nreturn isNonRetryableHarnessError;',
)();
const classification = {
  authNonretry: nonretry(new AuthError('401')),
  paymentNonretry: nonretry(new PaymentRequiredError('402')),
  configNonretry: nonretry(new ConfigError('missing')),
};
assert.deepEqual(classification, { authNonretry: false, paymentNonretry: false, configNonretry: true });
record('Node harness classifier only excludes ConfigError from retries', classification);

console.log(JSON.stringify({ probes: results.length, passed: results.length, scope: 'isolated characterization; no real database or provider calls' }));
