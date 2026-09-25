import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'openma-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  await cp(join(root, 'scripts/setup-docker.sh'), join(dir, 'scripts/setup-docker.sh'));
  const run = async (env = {}, args = ['--configure-only']) => {
    try {
      const result = await exec('bash', ['scripts/setup-docker.sh', ...args], {
        cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMA_DOCKER_PROVIDER: 'e2b', E2B_API_KEY: 'test-key-$literal', ...env },
      });
      return { ...result, code: 0 };
    } catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  };
  return { dir, run };
}
test('fresh setup creates private configuration with distinct secrets and literal provider credentials', async t => {
  const {dir, run} = await fixture(t);
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const value = await readFile(join(dir, '.env.openma'), 'utf8');
  assert.match(value, /^E2B_API_KEY='test-key-\$literal'$/m);
  const auth = value.match(/^BETTER_AUTH_SECRET='([a-f0-9]{64})'$/m)?.[1];
  const rootSecret = value.match(/^PLATFORM_ROOT_SECRET='([a-f0-9]{64})'$/m)?.[1];
  assert.ok(auth); assert.ok(rootSecret); assert.notEqual(auth, rootSecret);
  assert.match(value, /^OPENMA_BIND_HOST='127.0.0.1'$/m);
  assert.equal((await stat(join(dir, '.env.openma'))).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, /test-key|BETTER_AUTH_SECRET=|PLATFORM_ROOT_SECRET=/);
});
test('rerunning setup preserves credentials and leaves a preexisting .env untouched', async t => {
  const {dir, run} = await fixture(t);
  await writeFile(join(dir, '.env'), 'USER_CONFIG=keep\n');
  assert.equal((await run()).code, 0);
  const first = await readFile(join(dir, '.env.openma'), 'utf8');
  assert.equal((await run({ E2B_API_KEY: 'replacement' })).code, 0);
  assert.equal(await readFile(join(dir, '.env.openma'), 'utf8'), first);
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'USER_CONFIG=keep\n');
});
test('invalid provider or missing credentials fails before creating configuration', async t => {
  const {dir, run} = await fixture(t);
  for (const env of [{OPENMA_DOCKER_PROVIDER: 'subprocess'}, {E2B_API_KEY: ''}, {OPENMA_DOCKER_PORT: '70000'}, {OPENMA_DOCKER_DATA_MODE: 'mysql'}, {E2B_API_KEY: 'key\nAUTH_DISABLED=1'}]) {
    const result = await run(env);
    assert.notEqual(result.code, 0);
    await assert.rejects(readFile(join(dir, '.env.openma')), { code: 'ENOENT' });
  }
});
test('postgres setup generates a database password and rejects changing existing storage mode', async t => {
  const {dir, run} = await fixture(t);
  assert.equal((await run({ OPENMA_DOCKER_DATA_MODE: 'postgres' })).code, 0);
  const value = await readFile(join(dir, '.env.openma'), 'utf8');
  assert.match(value, /^OPENMA_POSTGRES_PASSWORD='[a-f0-9]{64}'$/m);
  assert.notEqual((await run({ OPENMA_DOCKER_DATA_MODE: 'sqlite' })).code, 0);
  assert.equal(await readFile(join(dir, '.env.openma'), 'utf8'), value);
});
test('configuration refuses symlink destinations without modifying their targets', async t => {
  const {symlink} = await import('node:fs/promises');
  const {dir, run} = await fixture(t);
  await writeFile(join(dir, 'untouched'), 'keep');
  await symlink(join(dir, 'untouched'), join(dir, '.env.openma'));
  assert.notEqual((await run()).code, 0);
  assert.equal(await readFile(join(dir, 'untouched'), 'utf8'), 'keep');
});

test('Compose consumes the generated env literally and persists SQLite or Postgres state', async t => {
  try { await exec('docker', ['compose', 'version']); } catch { t.skip('Docker Compose is required for configuration integration'); return; }
  for (const mode of ['sqlite', 'postgres']) {
    const {dir, run} = await fixture(t);
    assert.equal((await run({ OPENMA_DOCKER_DATA_MODE: mode })).code, 0);
    const files = ['compose.quickstart.yml', ...(mode === 'postgres' ? ['compose.quickstart.postgres.yml'] : [])];
    for (const file of files) { try { await cp(join(root, file), join(dir, file)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    let result;
    try { result = await exec('docker', ['compose', '--env-file', '.env.openma', ...files.flatMap(f => ['-f', f]), 'config', '--format', 'json'], {cwd: dir}); }
    catch (e) { assert.fail(`Compose configuration failed: ${e.stderr}`); }
    const services = JSON.parse(result.stdout).services;
    // Compose escapes literal dollars in its serialized config for round-tripping.
    assert.equal(services['oma-server'].environment.E2B_API_KEY, 'test-key-$$literal');
    assert.equal(services['oma-server'].environment.AUTH_DISABLED, undefined);
    assert.equal(services['oma-server'].ports[0].host_ip, '127.0.0.1');
    assert.equal(services['oma-server'].volumes[0].target, '/app/data');
    assert.equal(services['oma-server'].volumes[0].type, 'volume');
    assert.ok(services['oma-server'].healthcheck.test.join(' ').includes('/health'));
    if (mode === 'postgres') {
      const password = services.postgres.environment.POSTGRES_PASSWORD;
      assert.match(password, /^[a-f0-9]{64}$/);
      assert.equal(services['oma-server'].environment.DATABASE_URL, `postgres://oma:${password}@postgres:5432/oma`);
      assert.equal(services.postgres.ports, undefined);
    } else assert.equal(services['oma-server'].environment.DATABASE_PATH, '/app/data/oma.db');
  }
});

test('installer starts the saved topology, waits for health, and propagates Docker failure', async t => {
  const {dir, run} = await fixture(t);
  await mkdir(join(dir, 'bin'));
  const log = join(dir, 'calls');
  await writeFile(join(dir, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\ncase "$*" in *" up "*) exit "${DOCKER_EXIT:-0}";; esac\n', {mode:0o755});
  const env = {PATH: `${join(dir,'bin')}:${process.env.PATH}`, CALLS: log, OPENMA_DOCKER_DATA_MODE:'postgres'};
  assert.equal((await run(env, [])).code, 0);
  const calls = await readFile(log,'utf8');
  assert.match(calls, /-f compose.quickstart.yml -f compose.quickstart.postgres.yml up --build --wait --wait-timeout 180/);
  const failed = await run({...env, DOCKER_EXIT:'17'}, []);
  assert.equal(failed.code, 17);
  assert.doesNotMatch(failed.stdout, /OpenMA is healthy/);
});

test('failed entropy generation never writes an installation', async t => {
  const {dir, run} = await fixture(t);
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin/openssl'), '#!/bin/sh\nexit 23\n', {mode:0o755});
  assert.notEqual((await run({PATH:`${join(dir, 'bin')}:${process.env.PATH}`})).code, 0);
  await assert.rejects(readFile(join(dir, '.env.openma')), {code:'ENOENT'});
});
