import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditRepository, loadPublishedPackages, parseVersion } from "./release-check.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/release-check.mjs");

/** CHANGELOG versions with no git tag yet, excluding the pending publish version in package.json. */
function untaggedExcludingPendingPublish(cwd, untagged, packageVersionOverrides = null) {
  const pending = new Set(
    loadPublishedPackages(cwd).map((pkg) => {
      const manifest = JSON.parse(readFileSync(path.join(cwd, pkg.dir, "package.json"), "utf8"));
      const version = packageVersionOverrides?.[pkg.name] ?? manifest.version;
      return `${pkg.name}@${version}`;
    }),
  );
  return untagged.filter((entry) => !pending.has(`${entry.package}@${entry.version}`));
}

/** Stable @openma/cli version one patch ahead of the given x.y.z. */
function bumpCliPatch(version) {
  const parsed = parseVersion(version);
  assert.equal(parsed.prerelease, null);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/**
 * Version on a changesets "Version Packages" PR: package.json on that branch is already
 * bumped. On main, simulate the next patch release (current + 1).
 */
function pendingCliPublishVersion(cwd, untagged) {
  const current = JSON.parse(readFileSync(path.join(cwd, "packages/cli/package.json"), "utf8")).version;
  if (untagged.some((entry) => entry.package === "@openma/cli" && entry.version === current)) {
    return current;
  }
  return bumpCliPatch(current);
}

const historicalUntaggedVersions = [
  "@openma/cli@0.3.2",
  "@openma/cli@0.5.1",
  "@openma/cli@0.6.0-beta.0",
  "@openma/sdk@0.1.0",
  "@openma/sdk@1.0.0-beta.0",
];

const cleanTags = [
  "@openma/cli@0.4.0",
  "@openma/cli@0.4.1",
  "@openma/cli@0.5.0",
  "@openma/cli@0.6.0-beta.2",
  "@openma/cli@0.6.0",
  "@openma/cli@0.6.1",
  "@openma/sdk@1.0.0-beta.1",
  "@openma/sdk@1.0.0-beta.2",
  "@openma/sdk@1.0.0",
];

test("historical tags: complete releases pass and @openma/cli@0.6.0-beta.1 is missing four changes", () => {
  const report = auditRepository(repoRoot);
  const byTag = new Map(report.tags.map((tag) => [tag.tag, tag]));

  for (const tag of cleanTags) {
    const row = byTag.get(tag);
    assert.ok(row, `missing audit row for ${tag}`);
    assert.equal(row.versionMatch, true, tag);
    assert.equal(row.heading, true, tag);
    assert.deepEqual(row.distErrors, [], `${tag} ${row.distErrors.join("; ")}`);
    assert.deepEqual(row.missing, [], `${tag}\n${row.missing.map((commit) => `${commit.sha.slice(0, 9)} ${commit.subject}`).join("\n")}`);
  }

  // @openma/cli@0.4.1 is not an ancestor of main. Treating it as the previous
  // release of 0.5.0 would flag the whole unrelated history.
  assert.equal(byTag.get("@openma/cli@0.5.0").previousTag, null);
  assert.equal(byTag.get("@openma/cli@0.4.1").previousTag, "@openma/cli@0.4.0");
  assert.equal(byTag.get("@openma/cli@0.6.1").previousTag, "@openma/cli@0.6.0");

  const beta1 = byTag.get("@openma/cli@0.6.0-beta.1");
  assert.equal(beta1.previousTag, "@openma/cli@0.5.0");
  assert.deepEqual(beta1.missing.map((commit) => commit.sha.slice(0, 9)).sort(), [
    "870b9e29a",
    "8ac334116",
    "f0c9aed38",
    "fc24017cf",
  ]);
  assert.equal(beta1.missing.some((commit) => commit.subject.includes("(#120)")), false);
  assert.equal(beta1.missing.some((commit) => commit.subject.includes("(#173)")), false);
  assert.equal(beta1.missing.some((commit) => commit.subject.includes("(#183)")), true);

  assert.deepEqual(
    untaggedExcludingPendingPublish(repoRoot, report.untagged)
      .map((entry) => `${entry.package}@${entry.version}`)
      .sort(),
    historicalUntaggedVersions,
  );
});

test("version PR adds one untagged new version: pending package.json version is ignored", () => {
  const report = auditRepository(repoRoot);
  const pendingVersion = pendingCliPublishVersion(repoRoot, report.untagged);
  const versionPrUntagged = [...report.untagged, { package: "@openma/cli", version: pendingVersion }];
  assert.deepEqual(
    untaggedExcludingPendingPublish(repoRoot, versionPrUntagged, { "@openma/cli": pendingVersion })
      .map((entry) => `${entry.package}@${entry.version}`)
      .sort(),
    historicalUntaggedVersions,
  );
});

test("--audit reports those findings and exits 0", () => {
  const result = spawnSync(process.execPath, [script, "--audit"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS @openma\/cli@0\.6\.1/);
  assert.match(result.stdout, /FAIL @openma\/cli@0\.6\.0-beta\.1/);
  assert.match(result.stdout, /8ac3341/);
  assert.match(result.stdout, /#183/);
  assert.match(result.stdout, /@openma\/cli@0\.5\.1/);
  assert.match(result.stdout, /@openma\/sdk@1\.0\.0-beta\.0/);
});
