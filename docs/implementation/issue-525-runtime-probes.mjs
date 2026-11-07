// Historical characterization of edde3af523b0e2896d018d11248f99c3d8bc5a3e.
// Run against that baseline; current acceptance tests live in packages/ and apps/.
// Local characterization probes for the Node exception-system assessment.
// These execute production source (or exact source fragments) with injected
// in-memory collaborators. They are NOT live-provider, full-service, or
// production-concurrency reproductions. Assertions characterize current bugs,
// not the desired behavior; change them when implementing the fixes.
//
// Node 24+, Effect 3.22.1:
// npm install --prefix /tmp/oma-525-audit --ignore-scripts --no-audit --no-fund effect@3.22.1
// OMA_AUDIT_DEPS=/tmp/oma-525-audit node /absolute/path/to/this-file.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dependencies = process.env.OMA_AUDIT_DEPS ?? '/tmp/oma-525-audit';
const { Effect, Fiber } = createRequire(resolve(dependencies, 'package.json'))('effect');
const prefix = 'packages/control-plane-node/src/lib/';
const source = path => readFileSync(resolve(root, path), 'utf8');
const results = [];

function between(text, begin, end, from = 0) {
  const a = text.indexOf(begin, from);
  const b = text.indexOf(end, a + begin.length);
  assert.ok(a >= 0 && b > a, `Source markers must exist: ${begin}`);
  return text.slice(a, b);
}

function evaluate(text, result, bindings = {}) {
  const stripped = stripTypeScriptTypes(text, { mode: 'transform' })
    .replace(/\bexport /g, '');
  return Function(...Object.keys(bindings), stripped + `\nreturn ${result};`)(...Object.values(bindings));
}

function compileFile(path, result, bindings = {}) {
  const text = source(path).replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, '');
  return evaluate(text, result, bindings);
}

function record(name, evidence) {
  results.push({ name, evidence });
  console.log(JSON.stringify(results.at(-1)));
}

const runtime = source(prefix + 'node-managed-session-runtime.ts');
const runner = source(prefix + 'node-managed-session-runner.ts');
const ScopedSessionMap = compileFile(prefix + 'scoped-session-map.ts', 'ScopedSessionMap');

// Probe 1: use the actual runtime-driver start() method. The callback created
// for A reads the session's current fence on every emission, even after A ends.
const Driver = evaluate('class Driver { ' + between(runtime,
  '  async start(input:', '\n  /** Stops an in-flight',
  runtime.indexOf('export class DefaultNodeManagedSessionRuntimeDriver')) + '\n}', 'Driver');
const driver = new Driver();
driver.starts = new ScopedSessionMap();
driver.executionFences = new ScopedSessionMap();
let emit;
driver.dependencies = { engine: { start: async (_input, output) => { emit = output; } } };
const observedFences = [];
driver.enqueueOutput = async (_workspace, _session, _frame, fence) => {
  observedFences.push(fence?.attemptId ?? null);
};
const session = { workspaceId: 'workspace', sessionId: 'session' };
driver.executionFences.set(session, { attemptId: 'A' });
await driver.start(session);
await emit('output from A');
driver.executionFences.set(session, { attemptId: 'B' });
await emit('late output from A');
driver.executionFences.delete(session);
await emit('later output from A');
assert.deepEqual(observedFences, ['A', 'B', null]);
record('One attempt callback changes to replacement fence and then no fence', {
  fencesAssignedToSameOutputCallback: observedFences,
});

// Probe 2: exact buildModel/buildTools acquisition and disposeTools conditional
// from runner.accept(). This models the Promise.all early-rejection path.
const acquisition = between(runner, '      const toolsPromise =', '      const runHarness =');
const cleanup = between(runner,
  '        if (turnTools !== undefined) {', '      } catch (error) {');
const acquireThenCleanup = evaluate(`async function run(dependencies) {
  const context = {}, subagentContext = {}, sandbox = {};
  let turnTools;
  return (async function () {
    try { ${acquisition} }
    catch (error) { if (error.message !== 'injected model failure') throw error; }
    finally { ${cleanup} }
    return () => turnTools;
  }).call({ dependencies });
}`, 'run');
let releaseTools;
let disposedTools = 0;
const toolsPending = new Promise(resolve => { releaseTools = resolve; });
const inspectTools = await acquireThenCleanup({
  buildModel: async () => { throw new Error('injected model failure'); },
  buildTools: () => toolsPending,
  disposeTools: async () => { disposedTools++; },
});
releaseTools({ openConnection: true });
await Promise.resolve();
assert.equal(inspectTools()?.openConnection, true);
assert.equal(disposedTools, 0);
record('Tools acquired after model failure escape the completed cleanup', {
  lateToolsAcquired: true, disposed: disposedTools,
});

// Probe 3: full original worker class and supervision helper, actual Effect,
// but an in-memory coordinator queue and a manually controlled runtime.
const runSupervised = compileFile(prefix + 'supervised-fiber.ts', 'runSupervised', { Effect, Fiber });
const interruptFiber = compileFile(prefix + 'supervised-fiber.ts', 'interruptFiber', { Effect, Fiber });
const Worker = compileFile(prefix + 'node-session-execution-worker.ts', 'NodeSessionExecutionWorker', {
  Effect, Fiber, runSupervised, interruptFiber,
  errorHoldsQueuedOnLane: () => false,
});
const queue = ['first'];
const runs = [], errors = [];
let releaseFirst, firstEntered, secondEntered;
const firstStarted = new Promise(resolve => { firstEntered = resolve; });
const secondStarted = new Promise(resolve => { secondEntered = resolve; });
const firstPending = new Promise(resolve => { releaseFirst = resolve; });
let attempt = 0;
const worker = new Worker({
  ownerId: 'owner', maxConcurrent: 1,
  clock: { now: () => new Date() },
  ids: { nextAttemptId: () => `attempt-${++attempt}` },
  context: { find: async () => ({ session: {}, environment: {} }) },
  coordinator: {
    claim: async () => {
      const id = queue.shift();
      return id ? { type: 'claimed', execution: { id, ...session, events: [] }, fence: {} }
        : { type: 'empty' };
    },
    settle: async () => ({ type: 'settled' }),
  },
  runtime: {
    run: async input => {
      runs.push(input.executionId);
      if (input.executionId === 'first') { firstEntered(); await firstPending; }
      else secondEntered();
    },
    cancel: async () => {},
  },
  onError: error => { errors.push(error); },
});
let timeout;
try {
  worker.start();
  await firstStarted;
  worker.stop();
  queue.push('after-stop');
  releaseFirst();
  await Promise.race([
    secondStarted,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('No after-stop run observed')), 2_000);
    }),
  ]);
  await worker.waitForIdle();
} finally {
  clearTimeout(timeout);
  worker.stop();
}
assert.deepEqual(errors, []);
assert.deepEqual(runs, ['first', 'after-stop']);
record('Completing an active attempt claims new work after worker.stop()', {
  runs, claimedAfterStop: true,
});

console.log(JSON.stringify({ probes: results.length, passed: results.length, scope: 'local characterization only' }));
