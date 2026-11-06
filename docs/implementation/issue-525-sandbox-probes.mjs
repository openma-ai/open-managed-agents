// Historical characterization of edde3af523b0e2896d018d11248f99c3d8bc5a3e.
// Run against that baseline; current acceptance tests live in packages/ and apps/.
// Characterization probes: actual managed-runtime and Sprites adapter source,
// actual Effect kernel, fake provider API. No remote resources or credentials.
// These assert current defects, NOT desired behavior or production incidence.
// Node 24+, effect@3.22.1 in OMA_AUDIT_DEPS (default /tmp/oma-525-audit).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dependencies = process.env.OMA_AUDIT_DEPS ?? '/tmp/oma-525-audit';
const effect = createRequire(resolve(dependencies, 'package.json'))('effect');
function compile(path, exported, bindings = {}) {
  const source = readFileSync(resolve(root, path), 'utf8')
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, '');
  const js = stripTypeScriptTypes(source, { mode: 'transform' })
    .replace(/\bexport /g, '');
  return Function(...Object.keys(bindings), js + `\nreturn { ${exported} };`)
    (...Object.values(bindings));
}
const unexpected = () => { throw new Error('Probe reached an unstubbed, unrelated path'); };
const kernel = compile('packages/managed-runtime-sandbox/src/effect-kernel.ts',
  'runPortEffect, tryPortPromise, waitForAbortableDelay', effect);
const runtime = compile('packages/managed-runtime-sandbox/src/provider-runtime.ts',
  'createProviderManagedRuntime, createPreinstalledRuntimeEnvironment, requireRuntimeEnvironmentArtifact', {
    Effect: effect.Effect, ...kernel,
    supportsDuplexProcess: unexpected, sandboxMemoryStoreSync: unexpected,
  });
const { createSpritesManagedRuntime } = compile('packages/managed-runtime-sprites/src/sprites.ts',
  'createSpritesManagedRuntime', {
    ...runtime, createHash, Buffer, Readable, Writable,
    rejectPreparedBase: unexpected, rejectSandboxImageSelection: unexpected,
  });
const { createManagedRuntimeOrphanReconciler } = compile(
  'packages/managed-runtime-host/src/orphan-reconciler.ts', 'createManagedRuntimeOrphanReconciler');

function fakeProviderApi() {
  const resources = new Map();
  let deleted = 0;
  const missing = () => Object.assign(new Error('not found'), { status: 404 });
  const client = {
    async getSprite(name) {
      if (!resources.has(name)) throw missing();
      return resources.get(name);
    },
    async createSprite(name, options) {
      assert.ok(!resources.has(name));
      const sprite = {
        name, labels: options.labels,
        async check() {
          if (!resources.has(name)) throw missing();
          return { status: 'running' };
        },
        async execFileHTTP(_file, args = []) {
          if (!resources.has(name)) throw missing();
          return { stdout: args.some(arg => arg.includes('__OPENMA_RUNTIME_READY__'))
            ? '__OPENMA_RUNTIME_READY__' : '', stderr: '', exitCode: 0 };
        },
        closeControlConnection() {},
      };
      resources.set(name, sprite);
      return sprite;
    },
    async deleteSprite(name) {
      assert.ok(resources.has(name));
      resources.delete(name);
      deleted++;
    },
  };
  return { client, resources, deleted: () => deleted };
}
const scope = { workspaceId: 'workspace', environmentId: 'environment', sessionId: 'session', workId: 'work' };
const fenceA = { ...scope, ownerId: 'A', generation: 1, token: 'test-only-A', expiresAt: '2026-01-01T00:00:00Z' };
const fenceB = { ...fenceA, ownerId: 'B', generation: 2, token: 'test-only-B', expiresAt: '2099-01-01T00:00:00Z' };
const plan = { workspaceStrategy: 'retained_runtime', outputStrategy: null, runtimeCheckpoint: null,
  driver: { type: 'ama_worker', process: { command: 'worker' } } };
const composition = api => createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
async function acquire(host, fence) {
  const signal = new AbortController().signal;
  const workspace = await host.workspace.materialize({ scope, fence, strategy: 'retained_runtime',
    activeCheckpoint: null, idempotencyKey: `binding-${fence.generation}`, signal });
  return host.sandbox.acquire({ scope, fence, plan, workspace, outputs: null, signal });
}
const observations = [];
const record = (name, evidence) => {
  observations.push({ name, evidence });
  console.log(JSON.stringify(observations.at(-1)));
};

// New composition has no SDK-object cache, despite a live provider resource
// and a serialized identity sufficient for the provider's getSprite API.
{
  const api = fakeProviderApi();
  const first = composition(api);
  const handle = JSON.parse(JSON.stringify(await acquire(first, fenceA)));
  const restarted = composition(api);
  assert.equal(api.resources.has(handle.runtimeId), true);
  assert.deepEqual(await restarted.sandbox.inspect(handle), { state: 'unknown' });
  assert.deepEqual(await restarted.sandbox.heartbeat({ scope, fence: fenceB, lease: handle }), { type: 'lost' });
  record('Fresh composition treats live serialized handle as unknown/lost', {
    providerResourceExists: true, inspect: 'unknown', heartbeat: 'lost',
  });
}

// Two independent actual Sprites compositions attach to the same resource:
// managed context omits allocationId and create() uses a stable Session name.
// The stale fence is passed unchanged into actual terminate(), which ignores it.
{
  const api = fakeProviderApi();
  const oldHost = composition(api), newHost = composition(api);
  const oldHandle = await acquire(oldHost, fenceA);
  const currentHandle = await acquire(newHost, fenceB);
  assert.deepEqual(oldHandle, currentHandle);
  assert.equal(api.resources.size, 1);
  await oldHost.sandbox.terminate({ scope, fence: fenceA, lease: oldHandle, reason: 'lease_lost' });
  assert.equal(api.deleted(), 1);
  assert.deepEqual(await newHost.sandbox.inspect(currentHandle), { state: 'stopped' });
  record('Stale owner termination deletes resource attached by replacement', {
    samePhysicalHandle: true, deletes: api.deleted(), replacementState: 'stopped',
  });
}

// Persisted orphan from A is delivered to a brand-new reconciler after B
// attaches. Actual reap validates Session labels but not current ownership.
{
  const api = fakeProviderApi();
  const oldHandle = await acquire(composition(api), fenceA);
  const newHost = composition(api);
  const currentHandle = await acquire(newHost, fenceB);
  const orphan = JSON.parse(JSON.stringify({ id: 'orphan-A', scope, generation: 1, ownerId: 'A',
    sandbox: oldHandle, reason: 'lease_lost' }));
  const resolved = [];
  const reconciler = createManagedRuntimeOrphanReconciler({
    sandbox: composition(api).sandbox,
    orphans: { list: async () => [orphan], resolve: async ({ id }) => { resolved.push(id); }, failed: unexpected },
  });
  assert.deepEqual(await reconciler.runOnce({ limit: 10 }), { inspected: 1, resolved: 1, remaining: 0 });
  assert.deepEqual(resolved, ['orphan-A']);
  assert.equal(api.deleted(), 1);
  assert.deepEqual(await newHost.sandbox.inspect(currentHandle), { state: 'stopped' });
  record('Old durable orphan deletes replacement-owned resource and reports resolved', {
    deletes: api.deleted(), orphanResolved: true, replacementState: 'stopped',
  });
}
console.log(JSON.stringify({ probes: observations.length, passed: observations.length }));
