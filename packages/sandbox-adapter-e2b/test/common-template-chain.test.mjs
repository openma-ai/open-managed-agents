/** Offline regression: execute the real prepare-context -> verify-install file chain.
 * Linux trust checks use an existing local image, never pull or npm install.
 * Run: node --test test/common-template-chain.test.mjs (from this package).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { managedTemplate, prepareGuestSudo } from '../template/template.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const template = resolve(here, '../template');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commonFile = 'packages/acp-runtime/node_modules/@openma/common/package.json';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'oma-common-template-'));
  const source = join(root, 'source');
  const context = join(root, 'context');
  const put = (name, text) => {
    const path = join(source, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const git = (...args) => execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' }).trim();
  try {
    // Real installed release metadata and repository lock; no registry access.
    put(commonFile, readFileSync(join(repository, commonFile)));
    assert.equal(JSON.parse(readFileSync(join(source, commonFile))).version, '0.14.0');
    put('pnpm-lock.yaml', readFileSync(join(repository, 'pnpm-lock.yaml')));
    put('tracked-source.js', 'export const fixed = true;\n');
    git('init', '-q'); git('add', 'pnpm-lock.yaml', 'tracked-source.js');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed source');
    const sourceSha = git('rev-parse', 'HEAD');
    const lockSha256 = hash(readFileSync(join(source, 'pnpm-lock.yaml')));
    const tree = git('ls-tree', '-r', 'HEAD').split('\n').map(line => {
      const [header, path] = line.split('\t');
      const [mode, , oid] = header.split(' ');
      return { mode, oid, path };
    });
    put('.oma-source-sha', sourceSha + '\n');
    put('.oma-source-tree.json', JSON.stringify({ sourceSha, lockSha256, tree }));
    // Minimal built output fixture, not a substitute for full worker/build certification.
    put('packages/harness-runtime-acp/dist/node-e2b-work-item-cli.js', 'import "node:fs";\n');
    put('packages/harness-runtime-acp/dist/bundle-meta.json', JSON.stringify({ outputs: {
      'dist/node-e2b-work-item-cli.js': { imports: [{ path: 'node:fs', external: true }] },
    } }));
    const prepare = (sha = sourceSha, lock = lockSha256) => spawnSync(process.execPath,
      [join(template, 'prepare-context.mjs'), source, context, sha, lock], { encoding: 'utf8' });
    return await run({ root, source, context, put, prepare, sourceSha, lockSha256 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('prepares exact installed common 0.14.0 and hashes the copied worker with no baked ACP harness', () => fixture(({ context, prepare }) => {
  const result = prepare();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(context, 'installation.json')));
  assert.equal(manifest.common, '0.14.0');
  assert.deepEqual(manifest.harnesses, []);
  assert.equal(Object.keys(manifest.files).some(name => name.startsWith('harness/')), false);
  for (const [name, digest] of Object.entries(manifest.files)) assert.equal(hash(readFileSync(join(context, name))), digest, name);
  assert.notEqual(prepare().status, 0, 'must not overwrite a prepared context');
}));

for (const version of ['0.13.1', '0.14.0-beta.1', '0.14.1', '99.0.0']) {
  test(`rejects installed common ${version} before creating a context`, () => fixture(({ put, context, prepare }) => {
    put(commonFile, JSON.stringify({ name: '@openma/common', version }));
    const result = prepare();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Requires published common 0\.14\.0/);
    assert.equal(existsSync(context), false);
  }));
}

for (const corruption of ['source marker', 'source content', 'explicit source SHA', 'explicit lock', 'lock bytes', 'external import']) {
  test(`rejects ${corruption} corruption before creating a context`, () => fixture(({ put, context, prepare, sourceSha, lockSha256 }) => {
    let sha = sourceSha, lock = lockSha256;
    if (corruption === 'source marker') put('.oma-source-sha', '0'.repeat(40));
    if (corruption === 'source content') put('tracked-source.js', 'tampered');
    if (corruption === 'explicit source SHA') sha = '0'.repeat(40);
    if (corruption === 'explicit lock') lock = '0'.repeat(64);
    if (corruption === 'lock bytes') put('pnpm-lock.yaml', 'tampered');
    if (corruption === 'external import') put('packages/harness-runtime-acp/dist/bundle-meta.json', JSON.stringify({ outputs: {
      'dist/node-e2b-work-item-cli.js': { imports: [{ path: '@openma/common', external: true }] },
    } }));
    const result = prepare(sha, lock);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixed source|receipt|Dirty source|lock digest|Non-builtin/i);
    assert.equal(existsSync(context), false);
  }));
}

test('Linux verifier accepts the prepared release then rejects version, pin, lock, digest and trust tampering', {
  skip: !process.env.OMA_TEMPLATE_TEST_IMAGE && (process.platform !== 'linux' || process.getuid?.() !== 0) ? 'set OMA_TEMPLATE_TEST_IMAGE to an existing local Linux image with python3' : false,
}, () => fixture(({ context, prepare }) => {
  const result = prepare();
  assert.equal(result.status, 0, result.stderr);
  const args = process.env.OMA_TEMPLATE_TEST_IMAGE
    ? ['docker', ['run', '--rm', '--pull=never', '--network=none', '--entrypoint', 'python3',
      '-v', `${context}:/context:ro`, '-v', `${here}:/tests:ro`, process.env.OMA_TEMPLATE_TEST_IMAGE, '/tests/common-template-chain-linux.py']]
    : ['/usr/bin/python3', [join(here, 'common-template-chain-linux.py'), context]];
  const verified = spawnSync(args[0], args[1], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.match(verified.stdout, /common-0.14.0 file-chain: PASS/);
}));

// Inspect the real public SDK build plan, without submitting a template/build.
test('template preinstalls FUSE and the checksum-pinned rclone native-storage protocol', async () => {
  const require = createRequire(import.meta.url);
  const sdk = require(require.resolve('e2b', { paths: [join(repository, 'node_modules/.pnpm/node_modules')] }));
  const root = mkdtempSync(join(tmpdir(), 'oma-template-plan-'));
  try {
    const pin = { sourceSha: 'a'.repeat(40), lockSha256: 'b'.repeat(64) };
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ sourceSha: pin.sourceSha, sourceLockSha256: pin.lockSha256 }));
    const plan = JSON.parse(await managedTemplate(sdk, root, pin).toJSON());
    const commands = plan.steps.filter(step => step.type === 'RUN').map(step => step.args[0]);
    assert.match(commands[0], /apt-get install[^&]+\bfuse3\b/);
    const install = commands.find(command => command.includes('downloads.rclone.org'));
    assert.ok(install, 'rclone must be baked into the template, not apt-installed on first attach');
    assert.match(install, /https:\/\/downloads.rclone.org\/v1\.74\.1\/rclone-v1\.74\.1-linux-amd64\.zip/);
    assert.match(install, /67df3059a6233b6e32e604bcd637654bb294ff86291b65ede77123e94818d911/);
    assert.ok(install.indexOf('sha256sum --check') < install.indexOf('unzip '), 'verify before extracting');
    assert.match(install, /install -m 0755 .*\/usr\/local\/bin\/rclone/);
    assert.match(install, /fusermount3 --version/);
    assert.equal(spawnSync('sh', ['-n', '-c', install], { encoding: 'utf8' }).status, 0);
    if (process.env.OMA_TEMPLATE_TEST_IMAGE) {
      const rejected = spawnSync('docker', ['run', '--rm', '--pull=never', '--network=none', '-i',
        '--entrypoint', 'python3', '-v', `${here}:/tests:ro`, process.env.OMA_TEMPLATE_TEST_IMAGE,
        '/tests/template-rclone-linux.py'], { input: install, encoding: 'utf8' });
      assert.equal(rejected.status, 0, rejected.stdout + rejected.stderr);
      assert.match(rejected.stdout, /wrong checksum before installation: PASS/);
    }

  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('base template bakes no ACP agent: Environment setup installs pinned registry agents', () => {
  const source = readFileSync(join(template, 'template.mjs'), 'utf8');
  assert.doesNotMatch(source, /oma-harnesses|npm ci|pi-acp|codex-acp/);
  assert.equal(existsSync(join(template, 'harness')), false);
});

// The SDK serializes the actual image recipe; the explicit provider gate tests
// the command against the real managed UID (not a root-only mock).
test('official template prepares the Memory parent after creating the unprivileged tool user', async () => {
  const require = createRequire(import.meta.url);
  const sdk = require(require.resolve('e2b', { paths: [join(repository, 'node_modules/.pnpm/node_modules')] }));
  const root = mkdtempSync(join(tmpdir(), 'oma-memory-template-plan-'));
  try {
    const pin = { sourceSha: 'a'.repeat(40), lockSha256: 'b'.repeat(64) };
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ sourceSha: pin.sourceSha, sourceLockSha256: pin.lockSha256 }));
    const plan = JSON.parse(await managedTemplate(sdk, root, pin).toJSON());
    const commands = plan.steps.filter(step => step.type === 'RUN').map(step => step.args[0]);
    const createUser = commands.findIndex(command => command.includes('useradd --create-home oma-worker'));
    const prepare = commands.indexOf('install -d -o oma-worker -g oma-worker -m 0755 /mnt/memory');
    assert.ok(createUser >= 0 && prepare > createUser, 'worker-owned Memory parent must be in the official build plan');
    assert.ok(prepare < commands.findIndex(command => command.includes('/usr/bin/python3 -I -S /opt/oma-managed/verify-install.py')));
    assert.equal(spawnSync('sh', ['-n', '-c', commands[prepare]], { encoding: 'utf8' }).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Wiring only; actual sudo/UID/NNP behavior is the explicit provider gate.
test('official build provisions managed guest sudo after identity creation and validates it', async () => {
  const require = createRequire(import.meta.url);
  const sdk = require(require.resolve('e2b', { paths: [join(repository, 'node_modules/.pnpm/node_modules')] }));
  const root = mkdtempSync(join(tmpdir(), 'oma-sudo-plan-'));
  try {
    const pin = { sourceSha: 'a'.repeat(40), lockSha256: 'b'.repeat(64) };
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ sourceSha: pin.sourceSha, sourceLockSha256: pin.lockSha256 }));
    const plan = JSON.parse(await managedTemplate(sdk, root, pin).toJSON());
    const commands = plan.steps.filter(step => step.type === 'RUN').map(step => step.args[0]);
    const policy = commands.indexOf(prepareGuestSudo);
    assert.ok(policy > commands.findIndex(command => command.includes('useradd --create-home oma-worker')));
    assert.ok(policy < commands.findIndex(command => command.includes('/opt/oma-managed/verify-install.py')));
    assert.match(commands[0], /apt-get install[^&]+\bsudo\b/);
    assert.equal(spawnSync('sh', ['-n', '-c', prepareGuestSudo], { encoding: 'utf8' }).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
