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

const reports = [];
const record = (name, evidence) => { reports.push({ name, evidence }); console.log(JSON.stringify(reports.at(-1))); };
const between = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source markers: ${start}`);
  return text.slice(a, b);
};
function evaluate(ts, result, bindings = {}) {
  const js = stripTypeScriptTypes(ts, { mode: 'transform' }).replace(/\bexport /g, '');
  return Function(...Object.keys(bindings), js + `\nreturn ${result};`)(...Object.values(bindings));
}
const runtime = source('packages/control-plane-node/src/lib/node-managed-session-runtime.ts');
const runner = source('packages/control-plane-node/src/lib/node-managed-session-runner.ts');
const { ScopedSessionMap } = await import(url('packages/control-plane-node/src/lib/scoped-session-map.ts'));

// A global handler does not reject the pending promise or close its Scope.
// Run intentionally uncaught exceptions in a separate, short-lived process.
const child = spawnSync(process.execPath, ['-e', `
  const {Effect,Fiber}=require(${JSON.stringify(effectEntry)});
  let released=0, caught=0;
  process.on('uncaughtException',()=>caught++);
  const fiber=Effect.runFork(Effect.scoped(Effect.gen(function*(){
    yield* Effect.acquireRelease(Effect.void,()=>Effect.sync(()=>released++));
    yield* Effect.promise(()=>new Promise(()=>setImmediate(()=>{throw Error('detached callback');})));
  })));
  setTimeout(async()=>{
    const before={caught,released};
    await Effect.runPromise(Fiber.interrupt(fiber));
    console.log(JSON.stringify({before,after:{released}}));
  },50);
`], { encoding: 'utf8', timeout: 5_000 });
assert.equal(child.status, 0, child.stderr);
const scope = JSON.parse(child.stdout);
assert.deepEqual(scope, { before: { caught: 1, released: 0 }, after: { released: 1 } });
record('Scope does not close after detached uncaughtException', scope);

const policy = await import(url('packages/session-runtime-contract/src/coordination-policy.ts'));
const lease = { executionId: 'e', state: 'running', attemptCount: 1, maxAttempts: 10,
  leaseExpiresAtMs: 90, deadlineAtMs: 100 };
assert.equal(policy.decideLeaseRenewal(lease, 80, { leaseTtlMs: 30 }).leaseExpiresAtMs, 100);
assert.equal(policy.decideExpiredExecution(lease, 100).reason, 'deadline_exceeded');
record('Lease renewal is clamped; deadline is terminal', { renewedExpiry: 100, expiryAction: policy.decideExpiredExecution(lease, 100) });

// A session gate is deleted without checking the registering attempt/gate.
const gateSource = source('packages/control-plane-node/src/lib/node-session-budget-gates.ts');
const gates = evaluate(gateSource.slice(gateSource.indexOf('const GATES')),
  '({registerNodeSessionBudgetGate,clearNodeSessionBudgetGate,nodeSessionModelEgress})',
  { modelEgress: gate => gate }); // identity stub only for inspecting the selected gate
gates.registerNodeSessionBudgetGate('s', { owner: 'A' });
gates.registerNodeSessionBudgetGate('s', { owner: 'B' });
gates.clearNodeSessionBudgetGate('s');
assert.equal(gates.nodeSessionModelEgress('s'), null);
record('Stale gate clear removes replacement registration', { replacementSurvives: false });

const CancelDriver = evaluate('class Driver { ' +
  between(runtime, '  cancel(input: {', '  async stop(input: StopNodeManagedSessionRuntime)') + '}',
  'Driver', { cancellationError: reason => new Error(reason) });
const driver = new CancelDriver();
driver.startAborts = new ScopedSessionMap();
driver.pendingCancels = new ScopedSessionMap();
for (let i = 0; i < 100; i++) driver.cancel({ workspaceId: 'w', sessionId: `s${i}`, attemptId: `a${i}` });
for (let i = 0; i < 100; i++) driver.cancel({ workspaceId: 'w', sessionId: 's0', attemptId: `extra${i}` });
assert.equal(driver.pendingCancels.workspaces.get('w').size, 100);
assert.equal(driver.pendingCancels.get({ workspaceId: 'w', sessionId: 's0' }).size, 16);
record('Pending cancellation bounds entries per session, not session count', { retainedSessions: 100, largestSession: 16 });

const untilAborted = evaluate(between(runtime, 'export function untilAborted', '\n/** Startup failures'),
  'untilAborted', { abortedError: signal => signal.reason });
const DisposalRunner = evaluate('class Runner { ' +
  between(runner, '  private async disposeSandbox(', '  async accept(input: NodeManagedSessionRunnerAcceptInput)') + '}',
  'Runner', { untilAborted });
const disposer = new DisposalRunner();
disposer.sandboxRefreshes = new WeakMap();
disposer.pendingSandboxDisposals = new ScopedSessionMap();
disposer.dependencies = {};
let destroyCalls = 0;
const sandbox = { destroy: async () => { if (++destroyCalls === 1) throw Error('injected delete failure'); } };
const session = { workspaceId: 'w', sessionId: 's' };
await assert.rejects(disposer.disposeSandbox(session, sandbox), /injected delete failure/);
await assert.rejects(disposer.disposeSandbox(session, sandbox), /injected delete failure/);
assert.equal(destroyCalls, 1);
assert.equal(disposer.pendingSandboxDisposals.has(session), true);
record('Failed disposal reuses rejected promise instead of retrying destroy', { destroyCalls, gateRetained: true });

const CancelRunner = evaluate('class Runner { ' +
  between(runner, '  cancel(input: {', '  /** Returns only a prepared live runtime') + '}', 'Runner');
const canceller = new CancelRunner();
canceller.abortControllers = new ScopedSessionMap();
canceller.startupAborts = new ScopedSessionMap();
canceller.sandboxes = new ScopedSessionMap();
const replacementController = new AbortController();
canceller.abortControllers.set(session, replacementController);
canceller.sandboxes.set(session, sandbox);
canceller.cancel({ ...session, reason: 'lease_lost' });
assert.equal(replacementController.signal.aborted, true);
assert.equal(canceller.sandboxes.get(session), sandbox);
record('Runner cancellation has no attempt check and keeps sandbox binding',
  { currentControllerAborted: true, sandboxStillBound: true });

// An actual coordinator over native in-memory SQLite. This adapter implements
// SqlClient and preserves transaction atomicity; it is not a production driver.
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
const iso = ms => new Date(ms).toISOString();
await coordinator.admit({ execution: { id: 'e', workspaceId: 'w', sessionId: 's',
  admittedAt: iso(0), events: [{ id: 'input', type: 'user.message', content: [{ type: 'text', text: 'perform operation' }] }] } });
const a = await coordinator.claim({ ownerId: 'A', attemptId: 'a', claimedAt: iso(1), leaseTtlMs: 30 });
assert.equal(a.type, 'claimed');
// The current terminal guard only recognizes a terminal idle, not a tool use.
const terminal = evaluate(between(runtime, 'export function committedExecutionTerminal(', '\nexport interface NodeManagedSessionRunner'), 'committedExecutionTerminal');
const history = [{ executionId: 'e', event: { type: 'agent.tool_use', id: 'tool' } }];
assert.equal(terminal(history, 'e'), null);
assert.equal(terminal([...history, { executionId: 'e', event: { type: 'session.status_idle' } }], 'e').type, 'session.status_idle');
const b = await coordinator.claim({ ownerId: 'B', attemptId: 'b', claimedAt: iso(32), leaseTtlMs: 30 });
assert.equal(b.type, 'claimed');
assert.equal(b.fence.generation, 2);
assert.equal((await coordinator.renew({ fence: a.fence, renewedAt: iso(33), leaseTtlMs: 30 })).type, 'lost');
assert.equal((await coordinator.settle({ fence: a.fence, settledAt: iso(33), outcome: 'completed' })).type, 'lost');
assert.equal((await coordinator.find({ workspaceId: 'w', executionId: 'e' })).attempt.ownerId, 'B');
record('Expired coordinator attempt is reclaimed; stale renew/settle cannot mutate new owner',
  { newOwner: 'B', generation: b.fence.generation, incompleteToolTerminalGuard: null, committedIdleGuard: 'session.status_idle' });
db.close();
console.log(JSON.stringify({ probes: reports.length, passed: reports.length }));
