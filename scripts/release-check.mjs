#!/usr/bin/env node
/**
 * Release gate for the Changesets packages `@openma/cli` and `@openma/sdk`.
 *
 * Pull requests:
 * - Print a non-blocking `::notice::` for each pull request merged to the base
 *   branch since that package's previous `@openma/<name>@*` tag whose commit
 *   changed files that ship in the npm package. Those notices do not fail CI.
 * - Fail when those shipped files change and the PR adds neither a changeset
 *   for the package nor an empty changeset (`pnpm changeset --empty`).
 *   Test-only edits and devDependency bumps do not need a changeset.
 * - Fail when a changeset or a version bump is minor or major and the PR does
 *   not have `release:minor` or `release:major`. A patch bump needs no label.
 * - When `package.json` version changes (the Version Packages PR), fail unless
 *   the new CHANGELOG entry covers every such pull request since the previous
 *   tag, the heading matches the version, and `.changeset/pre.json` agrees
 *   with the npm dist-tag changesets will publish (`latest`, or the pre tag).
 * - Fail when the version already has a tag at a commit that is not part of
 *   HEAD's history. A tag at HEAD, or at an ancestor of HEAD, is accepted:
 *   GitHub checks out `pull/<n>/merge`, so a post-publish sync pull request
 *   runs against an ephemeral merge commit whose history contains the release
 *   tip the tag points at.
 *
 * `node scripts/release-check.mjs --publish` is the same coverage check at
 * publish time (version ahead of the previous tag). It does not read labels.
 * The publish path keeps the stricter rule: the tag it publishes must point at
 * the exact commit that is published.
 *
 * `node scripts/release-check.mjs --audit` reports historical tags. It always
 * exits 0. `--registry` also compares npm dist-tags.
 *
 * This does not bump versions, publish, or create tags.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const TAG_RE = /^(@openma\/[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const CHANGESET_FILE_RE = /^\.changeset\/[^/]+\.md$/;
const PUBLISH_JSON_KEYS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "bin",
  "files",
  "main",
  "types",
  "exports",
  "engines",
];

export function parseVersion(version) {
  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error(`Version must be x.y.z or x.y.z-prerelease, got ${JSON.stringify(version)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: version,
  };
}

/** @returns {"major" | "minor" | "patch" | "prerelease" | "promotion" | "same" | "downgrade"} */
export function classifyBump(previous, next) {
  if (next.major !== previous.major) return next.major > previous.major ? "major" : "downgrade";
  if (next.minor !== previous.minor) return next.minor > previous.minor ? "minor" : "downgrade";
  if (next.patch !== previous.patch) return next.patch > previous.patch ? "patch" : "downgrade";
  if (previous.prerelease && !next.prerelease) return "promotion";
  if (!previous.prerelease && next.prerelease) return "downgrade";
  if (previous.prerelease && next.prerelease && previous.prerelease !== next.prerelease) {
    return "prerelease";
  }
  return "same";
}

/**
 * Label required by a package.json version change.
 * `promotion` compares the stable x.y.z with the previous stable release
 * (or 0.0.0 when this package has never had a stable tag).
 * @returns {"major" | "minor" | "downgrade" | null}
 */
export function versionBumpLabel(previous, next, previousStable) {
  const kind = classifyBump(previous, next);
  if (kind === "major" || kind === "minor" || kind === "downgrade") return kind;
  if (kind !== "promotion") return null;
  const baseline = previousStable ?? parseVersion("0.0.0");
  const promoted = classifyBump(baseline, { ...next, prerelease: null, raw: stripPrerelease(next.raw) });
  if (promoted === "major" || promoted === "minor" || promoted === "downgrade") return promoted;
  return null;
}

function stripPrerelease(version) {
  return version.split("-")[0];
}

export function parseReleaseTag(tag) {
  const match = TAG_RE.exec(tag);
  if (!match) return null;
  return { name: match[1], version: match[2], tag };
}

export function parseChangeset(markdown) {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { empty: false, releases: [] };
  const close = normalized.indexOf("\n---", 3);
  if (close === -1) return { empty: false, releases: [] };
  const body = normalized.slice(normalized.indexOf("\n") + 1, close).trim();
  if (!body) return { empty: true, releases: [] };
  const releases = [];
  for (const line of body.split(/\r?\n/)) {
    const parsed = /^["']?(@?[^"']+?)["']?\s*:\s*(patch|minor|major)\s*$/.exec(line.trim());
    if (parsed) releases.push({ name: parsed[1], type: parsed[2] });
  }
  return { empty: releases.length === 0, releases };
}

export function isChangesetPath(file) {
  return CHANGESET_FILE_RE.test(file) && file !== ".changeset/README.md";
}

/** Pull request numbers from GitHub squash subjects. `(#10)` only. */
export function extractPrNumbers(message) {
  const numbers = [];
  for (const match of message.matchAll(/\(#(\d+)\)/g)) numbers.push(Number(match[1]));
  return numbers;
}

export function mentionsPr(notes, number) {
  return new RegExp(`(^|[^0-9])#${number}(?![0-9])`).test(notes);
}

/** Accept a 7+ hex token that is a prefix of `sha`, or the full sha. */
export function mentionsSha(notes, sha) {
  const full = sha.toLowerCase();
  for (const match of notes.matchAll(/(?:^|[^0-9a-f])([0-9a-f]{7,})/gi)) {
    const token = match[1].toLowerCase();
    if (full.startsWith(token) || token.startsWith(full)) return true;
  }
  return false;
}

export function changelogHasHeading(markdown, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+v?${escaped}(?:\\s|$)`, "m").test(markdown);
}

export function changelogVersions(markdown) {
  const versions = [];
  for (const match of markdown.matchAll(/^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/gm)) {
    versions.push(match[1]);
  }
  return versions;
}

/**
 * @param {"major" | "minor" | "downgrade" | null} kind
 * @param {readonly string[]} labels
 */
export function versionLabelErrors(kind, labels, previous, next) {
  if (kind == null) return [];
  const present = new Set(labels);
  if (kind === "minor") {
    if (present.has("release:minor")) return [];
    return [`version ${previous} -> ${next} is a minor bump; add the release:minor label or keep the bump to a patch`];
  }
  if (kind === "major") {
    if (present.has("release:major")) return [];
    return [`version ${previous} -> ${next} is a major bump; add the release:major label or keep the bump to a patch`];
  }
  return [`version ${previous} -> ${next} does not increase the version`];
}

export function changesetLabelErrors(changesets, labels) {
  const present = new Set(labels);
  const errors = [];
  const needs = new Set();
  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      if (release.type === "minor" || release.type === "major") needs.add(release.type);
    }
  }
  if (needs.has("minor") && !present.has("release:minor")) {
    errors.push("a changeset requests a minor bump; add the release:minor label or change it to a patch");
  }
  if (needs.has("major") && !present.has("release:major")) {
    errors.push("a changeset requests a major bump; add the release:major label or change it to a patch");
  }
  return errors;
}

export function distIntentErrors(version, preState) {
  let parsed;
  try {
    parsed = parseVersion(version);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (parsed.prerelease) {
    const ident = parsed.prerelease.split(".")[0];
    if (!preState || preState.mode !== "pre") {
      return [`version ${version} is a prerelease but .changeset/pre.json is not in pre mode, so changesets would not publish the ${ident} dist-tag`];
    }
    if (preState.tag !== ident) {
      return [`version ${version} uses prerelease ${ident} but .changeset/pre.json tag is ${JSON.stringify(preState.tag)}`];
    }
    return [];
  }
  if (preState?.mode === "pre") {
    return [`version ${version} is stable but .changeset/pre.json is in pre mode, so changesets would publish dist-tag ${JSON.stringify(preState.tag)} instead of latest`];
  }
  return [];
}

export function compareVersions(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const a = left.prerelease.split(".");
  const b = right.prerelease.split(".");
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNum = /^\d+$/.test(a[index]) ? Number(a[index]) : null;
    const bNum = /^\d+$/.test(b[index]) ? Number(b[index]) : null;
    if (aNum != null && bNum != null && aNum !== bNum) return aNum - bNum;
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function registryDistTagErrors(packageName, versions, distTags) {
  const parsed = [];
  for (const version of versions) {
    try {
      parsed.push(parseVersion(version));
    } catch {
      // Ignore non-semver rows from the registry.
    }
  }
  const errors = [];
  const stables = parsed.filter((version) => !version.prerelease);
  const highestStable = maxVersion(stables);
  if (highestStable && distTags.latest !== highestStable.raw) {
    errors.push(`${packageName} latest dist-tag is ${distTags.latest ?? "(missing)"}, expected ${highestStable.raw}`);
  }
  const idents = new Set(
    parsed.filter((version) => version.prerelease).map((version) => version.prerelease.split(".")[0]),
  );
  for (const ident of [...idents].sort()) {
    const group = parsed.filter((version) => version.prerelease?.split(".")[0] === ident);
    const highest = maxVersion(group);
    if (highest && distTags[ident] !== highest.raw) {
      errors.push(`${packageName} ${ident} dist-tag is ${distTags[ident] ?? "(missing)"}, expected ${highest.raw}`);
    }
  }
  return errors;
}

function maxVersion(versions) {
  return versions.reduce((best, version) => (best == null || compareVersions(version, best) > 0 ? version : best), null);
}

export function packageJsonAffectsPublish(beforeText, afterText) {
  if (afterText == null) return beforeText != null;
  let after;
  let before;
  try {
    after = JSON.parse(afterText);
  } catch {
    return true;
  }
  try {
    before = beforeText ? JSON.parse(beforeText) : {};
  } catch {
    before = {};
  }
  return PUBLISH_JSON_KEYS.some((key) => JSON.stringify(after[key] ?? null) !== JSON.stringify(before[key] ?? null));
}

export function isPublishableRelativePath(relativePath) {
  if (relativePath === "CHANGELOG.md") return false;
  if (relativePath.startsWith("test/") || relativePath.includes("/test/")) return false;
  if (/(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath)) return false;
  return relativePath.startsWith("src/") || relativePath === "README.md" || relativePath === "package.json";
}

/**
 * @param {readonly { sha: string, subject: string, publishable: boolean, optOut: boolean }[]} commits
 * @param {ReadonlySet<string>} consumedCommits feature commits whose changeset was released into this changelog
 */
export function coverageErrors(packageName, version, notes, commits, consumedCommits) {
  const errors = [];
  for (const commit of commits) {
    if (!commit.publishable || commit.optOut) continue;
    if (consumedCommits.has(commit.sha)) continue;
    const numbers = extractPrNumbers(commit.subject);
    const covered = (numbers.length > 0 && numbers.every((number) => mentionsPr(notes, number)))
      || mentionsSha(notes, commit.sha);
    if (covered) continue;
    const label = numbers.length > 0 ? numbers.map((number) => `#${number}`).join(", ") : commit.sha.slice(0, 7);
    errors.push(`${packageName}@${version} changelog does not cover ${label} (${commit.subject})`);
  }
  return errors;
}

export function unreleasedNotices(packageName, previousTag, baseName, commits) {
  if (!previousTag) {
    return [`::notice::No previous ${packageName}@* tag is reachable from ${baseName}; unreleased pull requests were not listed.`];
  }
  const notices = [];
  const seen = new Set();
  for (const commit of commits) {
    if (!commit.publishable || commit.optOut) continue;
    const numbers = extractPrNumbers(commit.subject);
    if (numbers.length === 0) {
      notices.push(`::notice::Unreleased ${packageName} commit ${commit.sha.slice(0, 7)} on ${baseName} since ${previousTag} has no (#N): ${commit.subject}`);
      continue;
    }
    for (const number of numbers) {
      if (seen.has(number)) continue;
      seen.add(number);
      notices.push(`::notice::Unreleased ${packageName} PR #${number} on ${baseName} since ${previousTag}: ${commit.subject}`);
    }
  }
  return notices;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

function gitOk(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function resolveBase(cwd, env) {
  const name = [env.BASE_REF, env.GITHUB_BASE_REF, "main"].find((value) => value && value.length > 0) ?? "main";
  for (const ref of [`origin/${name}`, name]) {
    if (gitOk(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) != null) {
      return { name, ref };
    }
  }
  throw new Error(`Cannot resolve base ref ${name}`);
}

function readJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadPublishedPackages(cwd) {
  const configPath = path.join(cwd, ".changeset", "config.json");
  const config = existsSync(configPath) ? readJsonText(readFileSync(configPath, "utf8"), configPath) : {};
  const ignore = new Set(config.ignore ?? []);
  const packages = [];
  for (const parent of ["packages", "apps"]) {
    const directory = path.join(cwd, parent);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const manifestPath = path.join(directory, name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = readJsonText(readFileSync(manifestPath, "utf8"), manifestPath);
      if (manifest.private === true) continue;
      if (typeof manifest.name !== "string" || ignore.has(manifest.name)) continue;
      packages.push({
        name: manifest.name,
        dir: path.posix.join(parent, name),
      });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function packageTags(cwd, packageName) {
  const listed = gitOk(cwd, ["tag", "--list", `${packageName}@*`]) ?? "";
  const tags = [];
  for (const tag of listed.split("\n").filter(Boolean)) {
    const parsed = parseReleaseTag(tag);
    if (!parsed || parsed.name !== packageName) continue;
    const sha = gitOk(cwd, ["rev-parse", `${tag}^{commit}`]);
    if (!sha) continue;
    const date = gitOk(cwd, ["log", "-1", "--format=%cI", sha]) ?? "";
    tags.push({ ...parsed, sha, date });
  }
  return tags;
}

function execStatus(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    return 0;
  } catch (error) {
    return typeof error === "object" && error && "status" in error ? error.status ?? 1 : 1;
  }
}

export function closestAncestorTag(cwd, tags, sha) {
  const ancestors = tags.filter((tag) => tag.sha !== sha && execStatus(cwd, ["merge-base", "--is-ancestor", tag.sha, sha]) === 0);
  const tips = ancestors.filter((tag) => !ancestors.some((other) => other.sha !== tag.sha
    && execStatus(cwd, ["merge-base", "--is-ancestor", tag.sha, other.sha]) === 0));
  tips.sort((left, right) => left.date < right.date ? -1 : left.date > right.date ? 1 : 0);
  return tips.at(-1) ?? null;
}

function fileList(cwd, sha, parent) {
  const args = parent
    ? ["diff", "--name-status", parent, sha]
    : ["diff-tree", "--no-commit-id", "--name-status", "-r", sha];
  const raw = gitOk(cwd, args) ?? "";
  const files = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    files.push({ status: parts[0][0], path: parts[parts.length - 1] });
  }
  return files;
}

function showText(cwd, rev, file) {
  return gitOk(cwd, ["show", `${rev}:${file}`]);
}

function listCommits(cwd, range) {
  const raw = gitOk(cwd, ["log", "--reverse", "--format=%H%x09%P%x09%s", range]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [sha, parents, subject] = line.split("\t");
    const parentList = (parents || "").split(" ").filter(Boolean);
    return { sha, parents: parentList, parent: parentList[0] ?? null, subject };
  });
}

function classifyCommit(cwd, commit, pkg) {
  if (commit.parents.length > 1) return { publishable: false, optOut: false, added: [] };
  const files = fileList(cwd, commit.sha, commit.parent);
  const added = [];
  let publishable = false;
  for (const file of files) {
    if (file.status === "A" && isChangesetPath(file.path)) {
      const text = showText(cwd, commit.sha, file.path);
      if (text) added.push({ path: file.path, parsed: parseChangeset(text) });
    }
    if (!file.path.startsWith(`${pkg.dir}/`)) continue;
    const relative = file.path.slice(pkg.dir.length + 1);
    if (!isPublishableRelativePath(relative)) continue;
    if (relative === "package.json") {
      const after = file.status === "D" ? null : showText(cwd, commit.sha, file.path);
      const before = commit.parent ? showText(cwd, commit.parent, file.path) : null;
      if (!packageJsonAffectsPublish(before, after)) continue;
    }
    publishable = true;
  }
  const forPackage = added.flatMap((entry) => entry.parsed.releases.filter((release) => release.name === pkg.name));
  const optOut = publishable && forPackage.length === 0 && added.some((entry) => entry.parsed.empty);
  return { publishable, optOut, added };
}

function commitsTouchingPackage(cwd, fromSha, toSha, pkg) {
  if (!fromSha) return [];
  const listed = listCommits(cwd, `${fromSha}..${toSha}`);
  const described = listed.map((commit) => ({ ...commit, ...classifyCommit(cwd, commit, pkg) }));
  const addedByPath = new Map();
  for (const commit of described) {
    for (const entry of commit.added) addedByPath.set(entry.path, { commit: commit.sha, parsed: entry.parsed });
  }
  const consumed = new Set();
  for (const commit of described) {
    if (commit.parents.length > 1) continue;
    const files = fileList(cwd, commit.sha, commit.parent);
    const changelogUpdated = files.some((file) => file.path === `${pkg.dir}/CHANGELOG.md`);
    if (!changelogUpdated) continue;
    for (const file of files) {
      if (file.status !== "D") continue;
      const added = addedByPath.get(file.path);
      if (!added) continue;
      const listsPackage = added.parsed.releases.some((release) => release.name === pkg.name);
      if (listsPackage || added.parsed.empty) consumed.add(added.commit);
    }
  }
  return { commits: described, consumed };
}

function addedChangelog(cwd, fromSha, toSha, pkgDir) {
  if (!fromSha) return showText(cwd, toSha, `${pkgDir}/CHANGELOG.md`) ?? "";
  const diff = gitOk(cwd, ["diff", "-U0", fromSha, toSha, "--", `${pkgDir}/CHANGELOG.md`]) ?? "";
  return diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
}

function readPreState(text) {
  if (text == null) return null;
  const parsed = readJsonText(text, ".changeset/pre.json");
  return parsed;
}

function releaseLabels(env) {
  return (env.RELEASE_LABELS ?? env.PR_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function enforceLabels(env) {
  return env.GITHUB_EVENT_NAME !== "push" && env.GITHUB_EVENT_NAME !== "workflow_dispatch";
}

function emitNotice(line) {
  const message = line.startsWith("::notice::") ? line.slice("::notice::".length) : line;
  const escaped = process.env.GITHUB_ACTIONS === "true"
    ? message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
    : message;
  console.log(`::notice::${escaped}`);
}

function fail(title, errors) {
  console.error(`${title}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

function workingVersion(cwd, pkg) {
  const manifestPath = path.join(cwd, pkg.dir, "package.json");
  const manifest = readJsonText(readFileSync(manifestPath, "utf8"), manifestPath);
  if (typeof manifest.version !== "string") throw new Error(`${pkg.dir}/package.json has no string version`);
  return manifest.version;
}

function versionAt(cwd, rev, pkg) {
  const text = showText(cwd, rev, `${pkg.dir}/package.json`);
  if (text == null) return null;
  const manifest = readJsonText(text, `${rev}:${pkg.dir}/package.json`);
  return typeof manifest.version === "string" ? manifest.version : null;
}

function previousStableVersion(cwd, pkg, rev) {
  const tags = packageTags(cwd, pkg.name).filter((tag) => !parseVersion(tag.version).prerelease);
  const previous = closestAncestorTag(cwd, tags, rev);
  return previous ? parseVersion(previous.version) : null;
}

function diffFiles(cwd, baseRef) {
  const raw = git(cwd, ["diff", "--name-status", `${baseRef}...HEAD`]);
  const files = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    files.push({ status: parts[0][0], path: parts[parts.length - 1] });
  }
  return files;
}

function changesetFromDiff(cwd, baseRef, file) {
  if (file.status === "D") {
    const text = showText(cwd, baseRef, file.path);
    return text ? parseChangeset(text) : null;
  }
  if (file.status === "A" || file.status === "M") {
    const absolute = path.join(cwd, file.path);
    if (!existsSync(absolute)) return null;
    return parseChangeset(readFileSync(absolute, "utf8"));
  }
  return null;
}

function missingChangesetErrors(cwd, baseRef, packages, files) {
  const errors = [];
  const added = [];
  for (const file of files) {
    if (!isChangesetPath(file.path) || file.status === "D") continue;
    const parsed = changesetFromDiff(cwd, baseRef, file);
    if (parsed) added.push(parsed);
  }
  if (added.some((changeset) => changeset.empty)) return errors;
  for (const pkg of packages) {
    const shipped = files.some((file) => {
      if (!file.path.startsWith(`${pkg.dir}/`)) return false;
      const relative = file.path.slice(pkg.dir.length + 1);
      if (!isPublishableRelativePath(relative)) return false;
      if (relative !== "package.json") return true;
      const before = showText(cwd, baseRef, file.path);
      const afterPath = path.join(cwd, file.path);
      const after = existsSync(afterPath) ? readFileSync(afterPath, "utf8") : null;
      return packageJsonAffectsPublish(before, after);
    });
    if (!shipped) continue;
    const covered = added.some((changeset) => changeset.releases.some((release) => release.name === pkg.name));
    if (!covered) {
      errors.push(`${pkg.name} shipped files changed without a changeset; add one, or \`pnpm changeset --empty\` when no release is intended`);
    }
  }
  return errors;
}

function evaluatePackageRelease(cwd, pkg, fromSha, toSha, version) {
  const errors = [];
  const changelog = showText(cwd, toSha, `${pkg.dir}/CHANGELOG.md`) ?? "";
  if (!changelogHasHeading(changelog, version)) {
    errors.push(`${pkg.dir}/CHANGELOG.md has no entry for ${version}`);
  }
  let preState = null;
  const preText = showText(cwd, toSha, ".changeset/pre.json");
  if (preText != null) preState = readPreState(preText);
  errors.push(...distIntentErrors(version, preState).map((error) => `${pkg.name}: ${error}`));
  if (!fromSha) return errors;
  const { commits, consumed } = commitsTouchingPackage(cwd, fromSha, toSha, pkg);
  const notes = addedChangelog(cwd, fromSha, toSha, pkg.dir);
  errors.push(...coverageErrors(pkg.name, version, notes, commits, consumed));
  return errors;
}

export function auditTag(cwd, tagName) {
  const parsed = parseReleaseTag(tagName);
  if (!parsed) return null;
  const packages = loadPublishedPackages(cwd);
  const pkg = packages.find((item) => item.name === parsed.name);
  if (!pkg) return null;
  const tags = packageTags(cwd, pkg.name);
  const tag = tags.find((item) => item.tag === tagName);
  if (!tag) return null;
  const previous = closestAncestorTag(cwd, tags, tag.sha);
  const version = versionAt(cwd, tag.sha, pkg);
  const changelog = showText(cwd, tag.sha, `${pkg.dir}/CHANGELOG.md`) ?? "";
  let preState = null;
  const preText = showText(cwd, tag.sha, ".changeset/pre.json");
  if (preText != null) preState = readPreState(preText);
  const versionMatch = version === parsed.version;
  const heading = changelogHasHeading(changelog, parsed.version);
  const distErrors = version ? distIntentErrors(version, preState) : ["missing package.json version"];
  const missing = [];
  if (previous && version) {
    const { commits, consumed } = commitsTouchingPackage(cwd, previous.sha, tag.sha, pkg);
    const notes = addedChangelog(cwd, previous.sha, tag.sha, pkg.dir);
    for (const commit of commits) {
      if (!commit.publishable || commit.optOut || consumed.has(commit.sha)) continue;
      const numbers = extractPrNumbers(commit.subject);
      const covered = (numbers.length > 0 && numbers.every((number) => mentionsPr(notes, number)))
        || mentionsSha(notes, commit.sha);
      if (!covered) missing.push({ sha: commit.sha, subject: commit.subject });
    }
  }
  return {
    tag: tag.tag,
    package: pkg.name,
    version: parsed.version,
    previousTag: previous?.tag ?? null,
    versionMatch,
    heading,
    distErrors,
    missing,
  };
}

export function changelogVersionsMissingTags(cwd) {
  const missing = [];
  for (const pkg of loadPublishedPackages(cwd)) {
    const markdown = existsSync(path.join(cwd, pkg.dir, "CHANGELOG.md"))
      ? readFileSync(path.join(cwd, pkg.dir, "CHANGELOG.md"), "utf8")
      : "";
    const tagged = new Set(packageTags(cwd, pkg.name).map((tag) => tag.version));
    const legacyPrefix = pkg.name === "@openma/cli" ? "cli-v" : pkg.name === "@openma/sdk" ? "sdk-v" : null;
    if (legacyPrefix) {
      const legacy = gitOk(cwd, ["tag", "--list", `${legacyPrefix}*`]) ?? "";
      for (const tag of legacy.split("\n").filter(Boolean)) {
        if (tag.startsWith(legacyPrefix)) tagged.add(tag.slice(legacyPrefix.length));
      }
    }
    for (const version of changelogVersions(markdown)) {
      if (!tagged.has(version)) missing.push({ package: pkg.name, version });
    }
  }
  return missing;
}

export function auditRepository(cwd) {
  const tags = [];
  for (const pkg of loadPublishedPackages(cwd)) {
    for (const tag of packageTags(cwd, pkg.name)) tags.push(tag.tag);
  }
  return {
    tags: tags.map((tag) => auditTag(cwd, tag)).filter(Boolean),
    untagged: changelogVersionsMissingTags(cwd),
  };
}

/**
 * The `@openma/<pkg>@<version>` tag this release would publish may already
 * exist:
 *
 * - No tag: the tag name is free.
 * - At HEAD: the release is already tagged at this commit.
 * - At an ancestor of HEAD: the release was tagged at an earlier commit that
 *   HEAD contains. GitHub checks out `pull/<n>/merge` for pull requests, so
 *   HEAD is an ephemeral merge commit whose history holds the release tip the
 *   tag points at. Post-publish sync pull requests look exactly like this.
 * - Anywhere else: the tag points at a history HEAD does not contain. That is a
 *   conflicting retag and must fail.
 *
 * `allowAncestor` is off for the publish path: there the tag has to point at
 * the exact commit that gets published.
 *
 * @returns {string|null} error message, or null when the tag is acceptable
 */
function plannedTagConflict(cwd, planned, headSha, { allowAncestor = false } = {}) {
  const existing = gitOk(cwd, ["rev-parse", `${planned}^{commit}`]);
  if (!existing || existing === headSha) return null;
  if (allowAncestor && execStatus(cwd, ["merge-base", "--is-ancestor", existing, headSha]) === 0) return null;
  return `${planned} already points at ${existing.slice(0, 7)}, not ${headSha.slice(0, 7)}`;
}

function checkPullRequest(cwd, env) {
  const base = resolveBase(cwd, env);
  const packages = loadPublishedPackages(cwd);
  const labels = releaseLabels(env);
  const files = diffFiles(cwd, base.ref);
  const errors = [];
  if (enforceLabels(env)) {
    const changesets = [];
    for (const file of files) {
      if (!isChangesetPath(file.path)) continue;
      const parsed = changesetFromDiff(cwd, base.ref, file);
      if (parsed) changesets.push(parsed);
    }
    errors.push(...changesetLabelErrors(changesets, labels));
  }
  errors.push(...missingChangesetErrors(cwd, base.ref, packages, files));

  for (const pkg of packages) {
    const tags = packageTags(cwd, pkg.name);
    const baseSha = git(cwd, ["rev-parse", `${base.ref}^{commit}`]);
    const previous = closestAncestorTag(cwd, tags, baseSha);
    const range = previous ? commitsTouchingPackage(cwd, previous.sha, baseSha, pkg) : { commits: [] };
    const notices = unreleasedNotices(pkg.name, previous?.tag ?? null, base.ref, range.commits);
    for (const notice of notices) emitNotice(notice);
    if (notices.length === 0 && previous) {
      console.log(`No unreleased ${pkg.name} changes on ${base.ref} since ${previous.tag}.`);
    }

    const baseVersion = versionAt(cwd, base.ref, pkg);
    const headVersion = workingVersion(cwd, pkg);
    if (!baseVersion || baseVersion === headVersion) continue;
    if (enforceLabels(env)) {
      let previousParsed;
      let nextParsed;
      try {
        previousParsed = parseVersion(baseVersion);
        nextParsed = parseVersion(headVersion);
      } catch (error) {
        errors.push(`${pkg.name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const headSha = git(cwd, ["rev-parse", "HEAD"]);
      const stable = previousStableVersion(cwd, pkg, headSha);
      const kind = versionBumpLabel(previousParsed, nextParsed, stable);
      errors.push(...versionLabelErrors(kind, labels, baseVersion, headVersion).map((error) => `${pkg.name}: ${error}`));
    }
    const headSha = git(cwd, ["rev-parse", "HEAD"]);
    const fromSha = previous?.sha ?? null;
    if (fromSha && execStatus(cwd, ["merge-base", "--is-ancestor", fromSha, headSha]) === 0) {
      errors.push(...evaluatePackageRelease(cwd, pkg, fromSha, "HEAD", headVersion));
    } else {
      errors.push(...evaluatePackageRelease(cwd, pkg, null, "HEAD", headVersion));
    }
    const planned = `${pkg.name}@${headVersion}`;
    const conflict = plannedTagConflict(cwd, planned, headSha, { allowAncestor: true });
    if (conflict) errors.push(conflict);
  }
  if (errors.length > 0) fail("release check failed", errors);
  else console.log("release check passed.");
}

function checkPublish(cwd, env) {
  const packages = loadPublishedPackages(cwd);
  const headSha = git(cwd, ["rev-parse", "HEAD"]);
  const errors = [];
  for (const pkg of packages) {
    const tags = packageTags(cwd, pkg.name);
    const previous = closestAncestorTag(cwd, tags, headSha);
    const headVersion = workingVersion(cwd, pkg);
    const previousVersion = previous ? versionAt(cwd, previous.sha, pkg) : null;
    const releasing = previousVersion !== headVersion;
    const range = previous && !releasing ? commitsTouchingPackage(cwd, previous.sha, headSha, pkg) : { commits: [] };
    const notices = unreleasedNotices(pkg.name, previous?.tag ?? null, "HEAD", range.commits);
    if (!releasing) {
      for (const notice of notices) emitNotice(notice);
      if (notices.length === 0 && previous) {
        console.log(`No unreleased ${pkg.name} changes since ${previous.tag}.`);
      }
      continue;
    }
    console.log(`Publishing ${pkg.name}@${headVersion} (previous tag ${previous?.tag ?? "(none)"}).`);
    errors.push(...evaluatePackageRelease(cwd, pkg, previous?.sha ?? null, "HEAD", headVersion));
    const planned = `${pkg.name}@${headVersion}`;
    // The publish path stays strict: the tag must point at the commit that is
    // published, not merely at one of its ancestors.
    const conflict = plannedTagConflict(cwd, planned, headSha);
    if (conflict) errors.push(conflict);
  }
  if (env.GITHUB_REF?.startsWith("refs/tags/")) {
    const tag = env.GITHUB_REF.slice("refs/tags/".length);
    const parsed = parseReleaseTag(tag);
    if (!parsed) errors.push(`tag ${tag} is not an @openma/<package>@<version> tag`);
    else {
      const pkg = packages.find((item) => item.name === parsed.name);
      if (!pkg) errors.push(`tag ${tag} does not name a published package`);
      else if (workingVersion(cwd, pkg) !== parsed.version) {
        errors.push(`tag ${tag} does not match ${pkg.dir}/package.json version ${workingVersion(cwd, pkg)}`);
      }
    }
  }
  if (errors.length > 0) fail("release publish check failed", errors);
  else console.log("release publish check passed.");
}

function printAudit(cwd, registry) {
  const report = auditRepository(cwd);
  for (const tag of report.tags) {
    const problems = [
      ...(!tag.versionMatch ? ["package.json version does not match the tag"] : []),
      ...(!tag.heading ? ["CHANGELOG has no heading for the tag version"] : []),
      ...tag.distErrors,
      ...tag.missing.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`),
    ];
    if (problems.length === 0) {
      console.log(`PASS ${tag.tag} previous=${tag.previousTag ?? "(none)"}`);
    } else {
      console.log(`FAIL ${tag.tag} previous=${tag.previousTag ?? "(none)"}`);
      for (const problem of problems) console.log(`  ${problem}`);
    }
  }
  if (report.untagged.length === 0) console.log("PASS every CHANGELOG version has a git tag");
  else {
    console.log("FAIL CHANGELOG versions with no git tag:");
    for (const entry of report.untagged) console.log(`  ${entry.package}@${entry.version}`);
  }
  if (registry) {
    for (const pkg of loadPublishedPackages(cwd)) {
      const versions = JSON.parse(execFileSync("npm", ["view", pkg.name, "versions", "--json"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }));
      const distTags = JSON.parse(execFileSync("npm", ["view", pkg.name, "dist-tags", "--json"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }));
      const errors = registryDistTagErrors(pkg.name, versions, distTags);
      if (errors.length === 0) console.log(`PASS ${pkg.name} npm dist-tags`);
      else {
        console.log(`FAIL ${pkg.name} npm dist-tags`);
        for (const error of errors) console.log(`  ${error}`);
      }
    }
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

export function runReleaseCheck(cwd, env, argv) {
  if (argv.includes("--audit")) {
    printAudit(cwd, argv.includes("--registry"));
    return;
  }
  if (argv.includes("--publish")) checkPublish(cwd, env);
  else if (argv.length === 0) checkPullRequest(cwd, env);
  else {
    console.error(`Unknown arguments: ${argv.join(" ")}`);
    process.exitCode = 1;
  }
}

if (isDirectRun()) {
  try {
    runReleaseCheck(process.cwd(), process.env, process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
