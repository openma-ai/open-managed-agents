import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/check-dependency-sources.mjs');
function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'dependency-sources-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(resolve(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    for (const args of [['init', '-q'], ['add', '.']]) {
      assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
    }
    return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('accepts registry versions, npm aliases and genuine workspace links', () => {
  const result = check({
    'package.json': JSON.stringify({ dependencies: { react: '^19.0.0', typescript: 'npm:@typescript/typescript6@^6.0.2', internal: 'workspace:*' } }),
    'packages/internal/package.json': JSON.stringify({ name: 'internal' }),
    'pnpm-lock.yaml': 'importers:\n  apps/console:\n    version: link:../../packages/internal\n',
  });
  assert.equal(result.status, 0, result.stderr);
});
for (const spec of ['file:./common.tgz', 'link:../common', '../common', '/tmp/common', 'git+https://github.com/org/common.git#abc', 'https://example.com/common.tgz', 'github:org/common', 'org/common#abc']) {
  test(`rejects unpublished dependency ${spec}`, () => {
    const result = check({ 'package.json': JSON.stringify({ optionalDependencies: { common: spec } }) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package.json.*common/);
  });
}
test('rejects local tarball references left only in lockfile', () => {
  const result = check({ 'package.json': '{}', 'pnpm-lock.yaml': "  common@file:apps/console/common.tgz:\n    resolution: {tarball: file:apps/console/common.tgz}\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pnpm-lock.yaml/);
});
test('rejects tracked tarballs even without manifest references', () => {
  const result = check({ 'package.json': '{}', 'apps/console/common.tgz': 'archive' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /apps\/console\/common.tgz/);
});
test('rejects an external dependency disguised as workspace', () => {
  const result = check({ 'package.json': JSON.stringify({ dependencies: { external: 'workspace:*' } }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /external/);
});

test('accepts an unscoped npm alias', () => {
  const result = check({ 'package.json': JSON.stringify({ dependencies: { alias: 'npm:react@^19.0.0' } }) });
  assert.equal(result.status, 0, result.stderr);
});
test('rejects lockfile links outside the workspace', () => {
  const result = check({ 'package.json': '{}', 'pnpm-lock.yaml': 'importers:\n  apps/console:\n    version: link:../../../../private-common\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pnpm-lock.yaml/);
});

test('does not confuse package names ending in file/link with protocols', () => {
  const result = check({ 'package.json': '{}', 'pnpm-lock.yaml': 'snapshots:\n  example:\n    get-caller-file: 2.0.5\n    hast-util-is-body-ok-link: 3.0.1\n' });
  assert.equal(result.status, 0, result.stderr);
});
test('accepts relative links between actual workspace packages', () => {
  const result = check({
    'package.json': '{}',
    'packages/a/package.json': JSON.stringify({ name: 'a' }),
    'packages/b/package.json': JSON.stringify({ name: 'b' }),
    'pnpm-lock.yaml': 'importers:\n  packages/a:\n    version: link:../b\n',
  });
  assert.equal(result.status, 0, result.stderr);
});
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  test(`checks ${section}`, () => {
    const result = check({ 'package.json': JSON.stringify({ [section]: { common: 'file:./common.tgz' } }) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(section));
  });
}
