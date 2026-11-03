import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  changelogHasHeading,
  changesetLabelErrors,
  classifyBump,
  compareVersions,
  coverageErrors,
  distIntentErrors,
  extractPrNumbers,
  loadPublishedPackages,
  mentionsPr,
  mentionsSha,
  packageJsonAffectsPublish,
  parseChangeset,
  parseVersion,
  registryDistTagErrors,
  versionBumpLabel,
  versionLabelErrors,
} from "./release-check.mjs";

const script = fileURLToPath(new URL("./release-check.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(script), "..");
const roots = [];

test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("this repo publishes cli, sdk and the ADR 0015 packages and ignores the private harness package", () => {
  assert.deepEqual(loadPublishedPackages(repoRoot).map((pkg) => pkg.name), [
    "@openma/cli",
    "@openma/core",
    "@openma/sdk",
    "@openma/server",
    "@openma/stores-memory",
    "@openma/stores-sql",
  ]);
});

test("parses release versions including prerelease", () => {
  assert.equal(parseVersion("0.6.1").prerelease, null);
  assert.equal(parseVersion("0.6.0-beta.2").prerelease, "beta.2");
  assert.throws(() => parseVersion("v0.6.1"), /x\.y\.z/);
});

test("classifies patch, minor, major, prerelease, and promotion", () => {
  const stable = parseVersion("0.5.0");
  assert.equal(classifyBump(stable, parseVersion("0.5.1")), "patch");
  assert.equal(classifyBump(stable, parseVersion("0.6.0")), "minor");
  assert.equal(classifyBump(stable, parseVersion("0.6.0-beta.0")), "minor");
  assert.equal(classifyBump(stable, parseVersion("1.0.0")), "major");
  assert.equal(classifyBump(parseVersion("0.6.0-beta.1"), parseVersion("0.6.0-beta.2")), "prerelease");
  assert.equal(classifyBump(parseVersion("0.6.0-beta.2"), parseVersion("0.6.0")), "promotion");
  assert.equal(classifyBump(stable, parseVersion("0.4.9")), "downgrade");
  assert.equal(classifyBump(stable, stable), "same");
});

test("promotion to stable uses the previous stable version for the label", () => {
  const beta = parseVersion("0.6.0-beta.2");
  const stable = parseVersion("0.6.0");
  assert.equal(versionBumpLabel(beta, stable, parseVersion("0.5.0")), "minor");
  assert.equal(versionBumpLabel(beta, stable, parseVersion("0.6.0")), null);
  assert.equal(versionBumpLabel(parseVersion("1.0.0-beta.2"), parseVersion("1.0.0"), null), "major");
  assert.equal(versionBumpLabel(parseVersion("0.6.0"), parseVersion("0.6.1"), null), null);
});

test("patch needs no label; minor and major need their own labels", () => {
  assert.deepEqual(versionLabelErrors(null, [], "0.6.0", "0.6.1"), []);
  assert.deepEqual(versionLabelErrors("minor", [], "0.5.0", "0.6.0"), [
    "version 0.5.0 -> 0.6.0 is a minor bump; add the release:minor label or keep the bump to a patch",
  ]);
  assert.deepEqual(versionLabelErrors("minor", ["release:minor"], "0.5.0", "0.6.0"), []);
  assert.deepEqual(versionLabelErrors("major", ["release:minor"], "0.1.0", "1.0.0"), [
    "version 0.1.0 -> 1.0.0 is a major bump; add the release:major label or keep the bump to a patch",
  ]);
  assert.deepEqual(changesetLabelErrors([{ releases: [{ name: "@openma/cli", type: "patch" }] }], []), []);
  assert.match(changesetLabelErrors([{ releases: [{ name: "@openma/cli", type: "minor" }] }], []).join("\n"), /release:minor/);
  assert.match(changesetLabelErrors([{ releases: [{ name: "@openma/sdk", type: "major" }] }], ["release:minor"]).join("\n"), /release:major/);
  assert.deepEqual(changesetLabelErrors([{ releases: [{ name: "@openma/sdk", type: "major" }] }], ["release:major"]), []);
});

test("pull request numbers do not match longer numbers, and short shas must prefix the commit", () => {
  assert.deepEqual(extractPrNumbers("feat: one (#10) and (#2)"), [10, 2]);
  assert.deepEqual(extractPrNumbers("Merge pull request #5 from openma-ai/example"), []);
  assert.equal(mentionsPr("see #100 and #101", 10), false);
  assert.equal(mentionsPr("see #10", 1), false);
  assert.equal(mentionsPr("landed in [#10](https://example.test/pull/10)", 10), true);
  const sha = "a011976cec8e74b551562ffdfdc87a08d6dd79fb";
  assert.equal(mentionsSha("- a011976: shipped", sha), true);
  assert.equal(mentionsSha(`- ${sha}: shipped`, sha), true);
  assert.equal(mentionsSha("- a011976fff: other", sha), false);
  assert.equal(mentionsSha("- a01197: too short", sha), false);
});

test("empty changesets and package.json publish surface", () => {
  assert.deepEqual(parseChangeset('---\n---\n'), { empty: true, releases: [] });
  assert.deepEqual(parseChangeset('---\n"@openma/cli": minor\n"@openma/sdk": patch\n---\n\nNotes\n'), {
    empty: false,
    releases: [
      { name: "@openma/cli", type: "minor" },
      { name: "@openma/sdk", type: "patch" },
    ],
  });
  const before = JSON.stringify({ version: "0.6.0", dependencies: { zod: "1.0.0" }, devDependencies: { typescript: "5.0.0" } });
  const devDep = JSON.stringify({ version: "0.6.1", dependencies: { zod: "1.0.0" }, devDependencies: { typescript: "6.0.0" } });
  const runtime = JSON.stringify({ version: "0.6.0", dependencies: { zod: "2.0.0" }, devDependencies: { typescript: "5.0.0" } });
  assert.equal(packageJsonAffectsPublish(before, devDep), false);
  assert.equal(packageJsonAffectsPublish(before, runtime), true);
});

test("dist-tag intent follows changesets pre mode", () => {
  assert.deepEqual(distIntentErrors("0.6.1", null), []);
  assert.deepEqual(distIntentErrors("0.6.0-beta.2", { mode: "pre", tag: "beta" }), []);
  assert.match(distIntentErrors("0.6.0-beta.2", null).join("\n"), /pre mode/);
  assert.match(distIntentErrors("0.6.0", { mode: "pre", tag: "beta" }).join("\n"), /latest/);
  assert.match(distIntentErrors("1.0.0-beta.2", { mode: "pre", tag: "next" }).join("\n"), /next/);
});

test("npm dist-tags must point at the highest published version for that channel", () => {
  assert.deepEqual(registryDistTagErrors("@openma/cli", [
    "0.6.0-beta.1",
    "0.6.0-beta.2",
    "0.6.0",
    "0.6.1",
  ], { latest: "0.6.1", beta: "0.6.0-beta.2" }), []);
  assert.deepEqual(compareVersions(parseVersion("0.6.0-beta.2"), parseVersion("0.6.0-beta.10")), -8);
  const sdk = registryDistTagErrors("@openma/sdk", [
    "0.1.0-beta.2",
    "1.0.0-beta.1",
    "1.0.0-beta.2",
    "1.0.0",
  ], { latest: "1.0.0", beta: "0.1.0-beta.2" });
  assert.equal(sdk.length, 1);
  assert.match(sdk[0], /beta dist-tag is 0\.1\.0-beta\.2, expected 1\.0\.0-beta\.2/);
});

test("coverage accepts a consumed changeset or a #N that is not a prefix of a longer number", () => {
  const commits = [
    { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subject: "feat: one (#10)", publishable: true, optOut: false },
    { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", subject: "feat: two (#100)", publishable: true, optOut: false },
  ];
  assert.deepEqual(coverageErrors("@openma/cli", "0.1.1", "see #100", commits, new Set()), [
    "@openma/cli@0.1.1 changelog does not cover #10 (feat: one (#10))",
  ]);
  assert.deepEqual(coverageErrors("@openma/cli", "0.1.1", "no numbers", commits, new Set(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])), [
    "@openma/cli@0.1.1 changelog does not cover #100 (feat: two (#100))",
  ]);
  assert.equal(changelogHasHeading("## 0.6.1\n\n### Patch Changes\n", "0.6.1"), true);
  assert.equal(changelogHasHeading("## 0.6.10\n", "0.6.1"), false);
});

test("shipped cli changes need a changeset; tests, devDependencies, and an empty changeset do not", () => {
  const cwd = featureBranch(scaffold());
  writeFileSync(path.join(cwd, "packages/cli/src/index.js"), "export const value = 2;\n");
  commit(cwd, "feat: change the cli (#2)");
  const missing = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /@openma\/cli shipped files changed without a changeset/);

  const tested = featureBranch(scaffold());
  mkdirSync(path.join(tested, "packages/cli/test"), { recursive: true });
  writeFileSync(path.join(tested, "packages/cli/src/index.test.js"), "test\n");
  writeFileSync(path.join(tested, "packages/cli/test/more.js"), "test\n");
  commit(tested, "test: cover the cli (#2)");
  assert.equal(run(tested, { GITHUB_EVENT_NAME: "pull_request" }).code, 0);

  const dev = featureBranch(scaffold());
  const manifest = JSON.parse(readFileSync(path.join(dev, "packages/cli/package.json"), "utf8"));
  manifest.devDependencies.typescript = "9.0.0";
  writeFileSync(path.join(dev, "packages/cli/package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  commit(dev, "chore(deps-dev): bump typescript (#2)");
  assert.equal(run(dev, { GITHUB_EVENT_NAME: "pull_request" }).code, 0);

  const runtime = featureBranch(scaffold());
  const runtimeManifest = JSON.parse(readFileSync(path.join(runtime, "packages/cli/package.json"), "utf8"));
  runtimeManifest.dependencies.zod = "2.0.0";
  writeFileSync(path.join(runtime, "packages/cli/package.json"), `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  commit(runtime, "chore(deps): bump zod (#2)");
  const runtimeResult = run(runtime, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(runtimeResult.code, 1);
  assert.match(runtimeResult.stderr, /shipped files changed without a changeset/);

  const empty = featureBranch(scaffold());
  writeFileSync(path.join(empty, "packages/cli/src/index.js"), "export const value = 2;\n");
  writeFileSync(path.join(empty, ".changeset/empty.md"), "---\n---\n");
  commit(empty, "chore: note no release (#2)");
  assert.equal(run(empty, { GITHUB_EVENT_NAME: "pull_request" }).code, 0);
});

test("a minor changeset fails without release:minor and a patch changeset does not", () => {
  const minor = featureBranch(scaffold());
  writeFileSync(path.join(minor, "packages/cli/src/index.js"), "export const value = 2;\n");
  writeFileSync(path.join(minor, ".changeset/feature.md"), '---\n"@openma/cli": minor\n---\n\nAdd a command.\n');
  commit(minor, "feat: add a command (#2)");
  const unlabeled = run(minor, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(unlabeled.code, 1);
  assert.match(unlabeled.stderr, /release:minor/);
  const labeled = run(minor, { GITHUB_EVENT_NAME: "pull_request", RELEASE_LABELS: "release:minor" });
  assert.equal(labeled.code, 0, labeled.stderr);
  const pushed = run(minor, { GITHUB_EVENT_NAME: "push" });
  assert.equal(pushed.code, 0, pushed.stderr);

  const patch = featureBranch(scaffold());
  writeFileSync(path.join(patch, "packages/cli/README.md"), "changed\n");
  writeFileSync(path.join(patch, ".changeset/fix.md"), '---\n"@openma/cli": patch\n---\n\nFix the readme.\n');
  commit(patch, "fix: readme (#2)");
  assert.equal(run(patch, { GITHUB_EVENT_NAME: "pull_request" }).code, 0);
});

test("consuming a minor changeset in a version PR still requires release:minor", () => {
  const cwd = scaffold();
  writeFileSync(path.join(cwd, "packages/cli/src/index.js"), "export const value = 2;\n");
  writeFileSync(path.join(cwd, ".changeset/feature.md"), '---\n"@openma/cli": minor\n---\n\nAdd a command.\n');
  commit(cwd, "feat: add a command (#2)");
  checkout(cwd, "release");
  writePackage(cwd, "0.2.0");
  writeFileSync(path.join(cwd, "packages/cli/CHANGELOG.md"), "# @openma/cli\n\n## 0.2.0\n\nAdd a command (#2).\n\n## 0.1.0\n\nFirst.\n");
  rm(cwd, ".changeset/feature.md");
  commit(cwd, "chore: version packages");
  const unlabeled = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(unlabeled.code, 1);
  assert.match(unlabeled.stderr, /release:minor/);
  assert.equal(run(cwd, { GITHUB_EVENT_NAME: "pull_request", RELEASE_LABELS: "release:minor" }).code, 0);
});

test("a version bump changelog must cover the merged PR unless the changeset was consumed", () => {
  const omitted = releaseRepo({ changelogBody: "Forgot the pull request.\n" });
  const omittedResult = run(omitted, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(omittedResult.code, 1);
  assert.match(omittedResult.stderr, /does not cover #2/);
  assert.doesNotMatch(omittedResult.stderr, /#20/);

  const numbered = releaseRepo({ changelogBody: "Shipped (#2) and not (#20).\n" });
  assert.equal(run(numbered, { GITHUB_EVENT_NAME: "pull_request" }).code, 0);

  const consumed = releaseRepo({ changelogBody: "Shipped the fix without a number.\n", consume: true });
  assert.equal(run(consumed, { GITHUB_EVENT_NAME: "pull_request" }).code, 0);
});

test("promoting a beta to the next minor stable requires release:minor", () => {
  const cwd = betaRepo();
  checkout(cwd, "release");
  writePackage(cwd, "0.2.0");
  writeFileSync(path.join(cwd, "packages/cli/CHANGELOG.md"), "# @openma/cli\n\n## 0.2.0\n\nStable.\n\n## 0.2.0-beta.1\n\nBeta.\n\n## 0.1.0\n\nFirst.\n");
  rm(cwd, ".changeset/pre.json");
  commit(cwd, "chore: version packages");
  const unlabeled = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(unlabeled.code, 1);
  assert.match(unlabeled.stderr, /release:minor/);
  assert.equal(run(cwd, { GITHUB_EVENT_NAME: "pull_request", RELEASE_LABELS: "release:minor" }).code, 0);
});

test("unreleased pull requests are notices and do not fail when the version is unchanged", () => {
  const cwd = scaffold();
  writeFileSync(path.join(cwd, "packages/cli/src/index.js"), "export const value = 2;\n");
  writeFileSync(path.join(cwd, ".changeset/fix.md"), '---\n"@openma/cli": patch\n---\n\nFix it.\n');
  commit(cwd, "fix: something (#2)");
  const result = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /::notice::Unreleased @openma\/cli PR #2 on main since @openma\/cli@0\.1\.0/);
  assert.doesNotMatch(result.stdout, /::error/);
});

test("--publish checks changelog coverage and dist-tag intent without labels", () => {
  const ready = releaseRepo({ changelogBody: "Shipped (#2).\n" });
  assert.equal(run(ready, {}, ["--publish"]).code, 0);

  const beta = betaRepo();
  writePackage(beta, "0.2.0-beta.2");
  rm(beta, ".changeset/pre.json");
  writeFileSync(path.join(beta, "packages/cli/CHANGELOG.md"), "# @openma/cli\n\n## 0.2.0-beta.2\n\nNext.\n\n## 0.2.0-beta.1\n\nBeta.\n\n## 0.1.0\n\nFirst.\n");
  commit(beta, "chore: version packages");
  const drifted = run(beta, {}, ["--publish"]);
  assert.equal(drifted.code, 1);
  assert.match(drifted.stderr, /not in pre mode/);
});

function run(cwd, extra, args = []) {
  const env = { ...process.env };
  for (const key of ["GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_BASE_REF", "BASE_REF", "RELEASE_LABELS", "PR_LABELS", "GITHUB_ACTIONS"]) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function scaffold() {
  const cwd = mkdtempSync(path.join(tmpdir(), "oma-release-check-"));
  roots.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  mkdirSync(path.join(cwd, ".changeset"), { recursive: true });
  mkdirSync(path.join(cwd, "packages/cli/src"), { recursive: true });
  writeFileSync(path.join(cwd, ".changeset/config.json"), `${JSON.stringify({
    changelog: "@changesets/changelog-git",
    ignore: ["@open-managed-agents/harness-runtime-acp"],
    privatePackages: { version: false, tag: false },
    baseBranch: "main",
  }, null, 2)}\n`);
  writeFileSync(path.join(cwd, ".changeset/README.md"), "# Changesets\n");
  writePackage(cwd, "0.1.0");
  writeFileSync(path.join(cwd, "packages/cli/src/index.js"), "export const value = 1;\n");
  writeFileSync(path.join(cwd, "packages/cli/CHANGELOG.md"), "# @openma/cli\n\n## 0.1.0\n\nFirst.\n");
  commit(cwd, "chore: initial (#1)");
  git(cwd, ["tag", "@openma/cli@0.1.0"]);
  return cwd;
}

function releaseRepo({ changelogBody, consume = false }) {
  const cwd = scaffold();
  writeFileSync(path.join(cwd, "packages/cli/src/index.js"), "export const value = 2;\n");
  writeFileSync(path.join(cwd, ".changeset/fix.md"), '---\n"@openma/cli": patch\n---\n\nFix it.\n');
  commit(cwd, "fix: something (#2)");
  checkout(cwd, "release");
  writePackage(cwd, "0.1.1");
  writeFileSync(path.join(cwd, "packages/cli/CHANGELOG.md"), `# @openma/cli\n\n## 0.1.1\n\n${changelogBody}\n## 0.1.0\n\nFirst.\n`);
  if (consume) rm(cwd, ".changeset/fix.md");
  commit(cwd, "chore: version packages");
  return cwd;
}

function betaRepo() {
  const cwd = scaffold();
  writePackage(cwd, "0.2.0-beta.1");
  writeFileSync(path.join(cwd, ".changeset/pre.json"), `${JSON.stringify({ mode: "pre", tag: "beta" }, null, 2)}\n`);
  writeFileSync(path.join(cwd, "packages/cli/CHANGELOG.md"), "# @openma/cli\n\n## 0.2.0-beta.1\n\nBeta.\n\n## 0.1.0\n\nFirst.\n");
  commit(cwd, "chore: version packages (beta)");
  git(cwd, ["tag", "@openma/cli@0.2.0-beta.1"]);
  return cwd;
}

function writePackage(cwd, version) {
  writeFileSync(path.join(cwd, "packages/cli/package.json"), `${JSON.stringify({
    name: "@openma/cli",
    version,
    dependencies: { zod: "1.0.0" },
    devDependencies: { typescript: "5.0.0" },
  }, null, 2)}\n`);
}

function featureBranch(cwd) {
  git(cwd, ["checkout", "-b", "feature"]);
  return cwd;
}

function checkout(cwd, branch) {
  git(cwd, ["checkout", "-b", branch]);
}

function commit(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message]);
}

function rm(cwd, file) {
  git(cwd, ["rm", "-f", file]);
}

function git(cwd, args) {
  execFileSync("git", [
    "-c", "user.email=release-check@example.com",
    "-c", "user.name=release-check",
    "-c", "commit.gpgsign=false",
    ...args,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}
