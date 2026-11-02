import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { execFileSync } from 'node:child_process';

// No dependencies: this guard must run before pnpm install (and its scripts).
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const manifests = files.filter(path => /(^|\/)package\.json$/.test(path)).map(path => ({
  path, json: JSON.parse(readFileSync(path, 'utf8')),
}));
const workspaceNames = new Set(manifests.filter(({ path }) => /^(apps|packages)\/[^/]+\/package\.json$/.test(path)).map(({ json }) => json.name));
const problems = [];
// Ordinary semver ranges/tags and npm aliases are registry sources. Reject
// paths, tarballs, Git URLs/shorthands and arbitrary network sources.
const registrySpec = /^(?:npm:)?(?:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@)?[a-z0-9*~^<>=|. +_-]+$/i;
for (const { path, json } of manifests) {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(json[section] ?? {})) {
      const allowed = typeof spec === 'string' && (spec.startsWith('workspace:')
        ? workspaceNames.has(name) && /^workspace:(?:\*|\^|~|[0-9][0-9.*^~<>=| -]*)$/.test(spec)
        : registrySpec.test(spec));
      if (!allowed) problems.push(`${path}: ${section}.${name} = ${JSON.stringify(spec)}; use a published registry version or a real workspace package`);
    }
  }
}
for (const path of files) {
  if (/\.(?:tgz|tar\.gz)$/i.test(path)) problems.push(`${path}: committed package archives are forbidden`);
  if (path === 'pnpm-lock.yaml') {
    let importer;
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      const heading = /^  ([^ ].*):$/.exec(line);
      if (heading) importer = heading[1].replace(/^['"]|['"]$/g, '');
      const link = /^\s+version:\s+['"]?link:([^'"\s]+)/.exec(line);
      const badLink = link && !manifests.some(m => m.path === posix.join(importer ?? '', link[1], 'package.json'));
      const badSource = /(?:^|[\s'"@{,])(?:file|git\+https?|git\+ssh|github):/.test(line);
      const badTarball = /tarball:\s*['"]?(?!https:\/\/registry\.npmjs\.org\/)/.test(line);
      if (badLink || badSource || badTarball) {
        problems.push(`${path}:${index + 1}: non-registry package resolution: ${line.trim()}`);
      }
    });
  }
}
if (problems.length) {
  console.error(`Dependency source policy failed:\n${problems.map(p => `- ${p}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Dependency source policy passed.');
}
