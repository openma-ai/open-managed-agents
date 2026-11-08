#!/usr/bin/env node
/**
 * Test wiring gate (design §0.7 测试门禁): every test file in the repository
 * must be run by at least one CI step, or be allowlisted with its reason.
 *
 *   test files   git-tracked and untracked-unignored files named like tests
 *                (TEST_FILE_PATTERNS), outside generated directories.
 *   run by CI    what the `run:` steps of .github/workflows/ci.yml reach,
 *                expanded by ./test-wiring-commands.mjs; vitest calls are
 *                resolved by vitest itself (`vitest list --json`), node
 *                --test / tsx / playwright calls by their file arguments.
 *   allowlist    scripts/test-wiring-allowlist.json: tests that intentionally
 *                stay out of CI (live, credentials, Docker, deployed URL).
 *                An entry that matches nothing left out fails, so the list
 *                only shrinks; adding one needs its reason in the PR.
 *
 * Change-scoped CI steps (domain-scoped tests, Console E2E specs) count with
 * every value they can take (union of scripts/ci-console-e2e-scope.mjs).
 * A collected file counts as run even if it skips itself at runtime.
 *
 * Usage:
 *   node scripts/check-test-wiring.mjs                # gate
 *   node scripts/check-test-wiring.mjs --explain <file>   # which CI path runs it
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expandCiStep, readWorkspace, workflowSteps } from "./test-wiring-commands.mjs";

export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const ALLOWLIST_PATH = "scripts/test-wiring-allowlist.json";

/** Inventory of the naming the repository uses for runnable tests. */
export const TEST_FILE_PATTERNS = [
  // vitest, node:test and Playwright suites
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  // node --test suites and database integration suites kept in test dirs
  /(?:^|\/)(?:test|tests|__tests__)\/(?:.+\/)?[^/]+\.(?:node|integration)\.[cm]?[jt]s$/u,
  // live end-to-end harness scripts (tsx)
  /\.e2e\.[cm]?[jt]s$/u,
];

export const GENERATED_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage|\.astro|\.git|\.next|\.turbo|\.vercel|\.wrangler)\/|^apps\/agent\/build-[^/]*\/|^\.claude\/worktrees\//u;

export function isTestFile(path) {
  return !GENERATED_PATH.test(path) && TEST_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

/** Minimal glob: **, *, ?, {a,b}. */
export function globToRegExp(glob) {
  const escape = (text) => text.replace(/[.+^$()|[\]\\]/gu, "\\$&");
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{" && glob.indexOf("}", index) !== -1) {
      const end = glob.indexOf("}", index);
      source += `(?:${glob.slice(index + 1, end).split(",").map(escape).join("|")})`;
      index = end;
    } else source += escape(char);
  }
  return new RegExp(`^${source}$`, "u");
}

/**
 * The verdict, pure. `executed` maps file -> via chains; `allowlist` is
 * [{ pattern, reason }].
 */
export function evaluateWiring({ testFiles, executed, allowlist, problems = [] }) {
  const notRun = testFiles.filter((file) => !executed.has(file)).sort();
  const matchers = allowlist.map((entry) => ({ ...entry, regexp: globToRegExp(entry.pattern) }));
  const allowlisted = notRun.filter((file) => matchers.some((entry) => entry.regexp.test(file)));
  const unwired = notRun.filter((file) => !allowlisted.includes(file));
  const invalid = allowlist.filter((entry) => typeof entry.pattern !== "string" || typeof entry.reason !== "string" || entry.reason.trim() === "");
  const stale = matchers.filter((entry) => !notRun.some((file) => entry.regexp.test(file)));
  return {
    testFiles: testFiles.length,
    runByCi: testFiles.length - notRun.length,
    allowlisted,
    unwired,
    stale: stale.map(({ regexp: _regexp, ...entry }) => entry),
    invalid,
    problems,
  };
}

export function renderWiring(verdict) {
  const lines = [];
  const section = (title, items) => {
    if (items.length === 0) return;
    lines.push(`${title}:`, ...items.map((item) => `  - ${item}`));
  };
  section("Test files no CI step runs (wire them into a CI script or a vitest config; allowlist only with a reason)", verdict.unwired);
  section(`Stale ${ALLOWLIST_PATH} entries: nothing left out matches them; delete them (the list only shrinks)`, verdict.stale.map((e) => `${e.pattern}  (${e.reason})`));
  section(`Invalid ${ALLOWLIST_PATH} entries (need a pattern and a non-empty reason)`, verdict.invalid.map((e) => JSON.stringify(e)));
  section("CI commands the gate cannot follow (fix the script or teach scripts/test-wiring-commands.mjs)", verdict.problems.map((p) => `${p.via.join(" › ")}: ${p.message}`));
  return lines.join("\n");
}

export function gitTestFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(output.split("\0").filter(Boolean))]
    .filter((path) => isTestFile(path) && existsSync(join(root, path)))
    .sort();
}

const VITEST_KEEP_VALUE = new Set(["--config", "-c", "--project", "--root", "-r", "--dir"]);
const VITEST_DROP_VALUE = new Set([
  "--bail", "--environment", "--hookTimeout", "--maxWorkers", "--minWorkers", "--mode", "--outputFile",
  "--pool", "--reporter", "--retry", "--shard", "--testNamePattern", "--testTimeout", "-t",
]);

/** vitest run args -> project-selecting flags (for `vitest list`) and file filters. */
export function vitestArgs(args) {
  const flags = [];
  const filters = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = arg.split("=")[0];
    if (VITEST_KEEP_VALUE.has(name)) {
      flags.push(arg);
      if (!arg.includes("=") && index + 1 < args.length) flags.push(args[++index]);
    } else if (VITEST_DROP_VALUE.has(name)) {
      if (!arg.includes("=")) index += 1;
    } else if (!arg.startsWith("-")) filters.push(arg);
  }
  return { flags, filters };
}

/** vitest's own CLI filter rule: the file path relative to the project
 * directory contains the filter (case-insensitive). */
export function vitestFilterMatches(relativeFile, filter) {
  const file = relativeFile.toLowerCase();
  const normalized = posix.normalize(filter.split(sep).join("/")).replace(/^\.\//u, "").toLowerCase();
  return file.includes(filter.toLowerCase()) || file.includes(normalized);
}

function vitestEntry(root, dir) {
  for (const base of [join(root, dir), root]) {
    const entry = join(base, "node_modules", "vitest", "vitest.mjs");
    if (existsSync(entry)) return entry;
  }
  return null;
}

async function listVitestProject(root, dir, flags) {
  const entry = vitestEntry(root, dir);
  // Listing needs no module cache, and vitest deletes a stale one on startup: with
  // parallel lists that delete races the others' writes and fails with ENOTEMPTY.
  // --json takes an optional output path: keep it last so no argument is read as one.
  const args = [entry, "list", "--filesOnly", "--staticParse", "--no-fsModuleCache", ...flags, "--json"];
  try {
    const { stdout } = await promisify(execFile)(process.execPath, args, {
      cwd: join(root, dir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    const start = stdout.indexOf("[");
    return { files: JSON.parse(stdout.slice(start)).map((item) => toRepoPath(root, item.file)) };
  } catch (error) {
    const text = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/gu, "");
    const message = /No test files found/u.test(text)
      ? "vitest finds no test files"
      : `vitest list failed: ${text.trim().split("\n").slice(0, 3).join(" | ")}`;
    return { files: [], problem: `${dir}: vitest ${flags.join(" ")}: ${message}` };
  }
}

/** Files one vitest call runs, from its project's file list and its filters. */
export function applyVitestFilters(call, projectFiles) {
  const { filters } = vitestArgs(call.args);
  if (filters.length === 0) return { files: projectFiles, problems: [] };
  const prefix = call.dir === "." ? "" : `${call.dir}/`;
  const relativeOf = (file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file);
  const files = projectFiles.filter((file) => filters.some((filter) => vitestFilterMatches(relativeOf(file), filter)));
  const problems = filters
    .filter((filter) => !projectFiles.some((file) => vitestFilterMatches(relativeOf(file), filter)))
    .map((filter) => `${call.dir}: vitest filter "${filter}" matches no test file of ${vitestArgs(call.args).flags.join(" ") || "the default config"}`);
  return { files, problems };
}

function toRepoPath(root, file) {
  return relative(root, file).split(sep).join("/");
}

function resolveFileArgs(root, call, testFiles) {
  const files = [];
  const problems = [];
  if (call.runner === "node-test" && call.args.length === 0) {
    problems.push(`${call.dir}: node --test without file arguments is not modelled`);
  }
  for (const arg of call.args) {
    const path = posix.normalize(posix.join(call.dir, arg));
    if (/[*?[{]/u.test(arg)) {
      files.push(...globSync(arg, { cwd: join(root, call.dir) }).map((match) => posix.normalize(posix.join(call.dir, match.split(sep).join("/")))));
    } else if (existsSync(join(root, path))) files.push(path);
    else if (call.runner === "playwright" && !arg.startsWith("-")) {
      // Playwright file filters are regular expressions over the path.
      const filter = new RegExp(arg, "u");
      files.push(...testFiles.filter((file) => file.startsWith(call.dir === "." ? "" : `${call.dir}/`) && filter.test(file)));
    } else if (!arg.startsWith("-")) problems.push(`${call.dir}: ${arg} does not exist`);
  }
  return { files, problems };
}

function resolvePlaywright(root, call, testFiles) {
  const valueFlags = new Set(["--config", "-c", "--project", "--grep", "-g", "--grep-invert", "--reporter", "--workers", "-j", "--shard", "--retries", "--timeout", "--output"]);
  const positionals = [];
  let config = "playwright.config.ts";
  for (let index = 0; index < call.args.length; index += 1) {
    const arg = call.args[index];
    const [name, inline] = arg.split("=");
    if (name === "--config" || name === "-c") config = inline ?? call.args[++index];
    else if (arg.startsWith("-")) {
      if (valueFlags.has(name) && inline === undefined) index += 1;
    } else positionals.push(arg);
  }
  if (positionals.length > 0) return resolveFileArgs(root, { ...call, args: positionals }, testFiles);
  const configPath = join(root, call.dir, config);
  const testDir = existsSync(configPath) ? /testDir:\s*["'`]([^"'`]+)["'`]/u.exec(readFileSync(configPath, "utf8"))?.[1] : undefined;
  if (testDir === undefined) return { files: [], problems: [`${call.dir}: playwright test without specs needs a literal testDir in ${config}`] };
  const base = posix.normalize(posix.join(call.dir, testDir));
  return { files: testFiles.filter((file) => file.startsWith(`${base}/`) && /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file)), problems: [] };
}

/** Union of everything the change-scoped CI outputs can select. */
export async function ciOutputUnion() {
  const { DOMAINS } = await import("./ci-console-e2e-scope.mjs");
  const layers = Object.values(DOMAINS).flatMap((domain) => Object.values(domain));
  const union = (key) => [...new Set(layers.flatMap((layer) => layer[key] ?? []))];
  return {
    console_e2e: "true",
    console_local_specs: union("local").join(" "),
    console_cert_specs: union("cert").join(" "),
    domain_test_commands: union("cmds").join("\n"),
  };
}

/** Node orchestrators CI calls whose child commands are data in the script. */
export async function ciOrchestrators() {
  const { defaultOfflineCertificationLanes } = await import("./offline-certification.mjs");
  const offline = defaultOfflineCertificationLanes().map((lane) => lane.command.join(" "));
  return {
    "scripts/offline-certification.mjs": () => offline,
    // CI runs only its console-browser step (see the ci.yml step env).
    "scripts/local-release-certification.mjs": (env) => {
      if (env.OMA_LOCAL_RELEASE_ONLY !== "console-browser") return null;
      const specs = env.OMA_E2E_CONSOLE_CERT_SPECS?.trim() || "test/e2e/deployed-console.spec.ts test/e2e/deployed-console-deployments.spec.ts";
      return [`pnpm exec playwright test ${specs} --config=playwright.config.ts`];
    },
  };
}

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

export async function collectWiring(root) {
  const workspace = readWorkspace(root);
  const steps = workflowSteps(readFileSync(join(root, CI_WORKFLOW), "utf8")).filter((step) => step.run);
  const options = { outputs: await ciOutputUnion(), orchestrators: await ciOrchestrators() };
  const calls = [];
  const problems = [];
  for (const step of steps) {
    const expanded = expandCiStep(step, workspace, options);
    calls.push(...expanded.calls);
    problems.push(...expanded.problems);
  }
  const testFiles = gitTestFiles(root);
  const executed = new Map();
  const record = (files, via) => {
    for (const file of files) {
      if (!executed.has(file)) executed.set(file, []);
      executed.get(file).push(via);
    }
  };
  const vitestProjects = new Map();
  const vitestCalls = [];
  for (const call of calls) {
    if (call.runner === "vitest") {
      const { flags } = vitestArgs(call.args);
      const key = `${call.dir}\0${flags.join("\0")}`;
      if (!vitestProjects.has(key)) vitestProjects.set(key, { dir: call.dir, flags });
      vitestCalls.push({ call, key });
      continue;
    }
    const resolved = call.runner === "playwright" ? resolvePlaywright(root, call, testFiles) : resolveFileArgs(root, call, testFiles);
    record(resolved.files, call.via);
    problems.push(...resolved.problems.map((message) => ({ via: call.via, message })));
  }
  const projectKeys = [...vitestProjects.keys()];
  const listed = await mapLimit(projectKeys, 8, (key) => listVitestProject(root, vitestProjects.get(key).dir, vitestProjects.get(key).flags));
  const projectFiles = new Map(projectKeys.map((key, index) => [key, listed[index]]));
  const reported = new Set();
  for (const { call, key } of vitestCalls) {
    const project = projectFiles.get(key);
    if (project.problem) {
      if (!reported.has(key)) problems.push({ via: call.via, message: project.problem });
      reported.add(key);
      continue;
    }
    const resolved = applyVitestFilters(call, project.files);
    record(resolved.files, call.via);
    problems.push(...resolved.problems.map((message) => ({ via: call.via, message })));
  }
  const allowlist = JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8")).entries;
  return { testFiles, executed, allowlist, problems, calls: calls.length, vitestProjects: projectKeys.length };
}

function assertInstalled(root) {
  if (vitestEntry(root, ".") === null) {
    throw new Error("check-test-wiring: node_modules/vitest is missing; run `pnpm install --frozen-lockfile` first (the gate asks vitest which files each CI call collects).");
  }
}

export async function main(argv, root = process.cwd()) {
  assertInstalled(root);
  const wiring = await collectWiring(root);
  const explain = argv.indexOf("--explain");
  if (explain !== -1) {
    const file = argv[explain + 1];
    const vias = wiring.executed.get(file) ?? [];
    console.log(vias.length === 0 ? `${file}: no CI step runs it` : vias.map((via) => `${file}: ${via.join(" › ")}`).join("\n"));
    return;
  }
  const verdict = evaluateWiring(wiring);
  const report = renderWiring(verdict);
  if (report !== "") throw new Error(`Test wiring violation(s):\n${report}`);
  console.log(
    `Test wiring check passed: ${verdict.testFiles} test files, ${verdict.runByCi} run by CI (${wiring.calls} runner calls, ${wiring.vitestProjects} vitest projects), ${verdict.allowlisted.length} allowlisted in ${ALLOWLIST_PATH}.`,
  );
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
