#!/usr/bin/env node
/**
 * Multi-platform parity gate, structural half (design §0.7 gates 3 and 4).
 *
 * Only two things are hand-written here, as the design asks:
 *   (a) platform discovery + runner registration: every workspace app whose
 *       dependency graph reaches @open-managed-agents/session-runtime is a
 *       platform, and must be registered in
 *       packages/platform-parity/platforms.mjs (own runner, proven reuse of
 *       another platform's runner, or a proven "not a Session host").
 *   (b) dependency-chain reachability: every Session domain package must be
 *       reachable from every Session-hosting deployment, or be listed in
 *       REACHABILITY_EXCEPTIONS below with its cause. An exception that is no
 *       longer true fails too, so the list only shrinks.
 *
 * Scenario-level parity (golden files, Vitest test.fails for known
 * differences) lives in the runners. Affected-platform selection uses pnpm's
 * own `--filter "...[<merge-base>]"`; see `affected` below.
 *
 * Usage:
 *   node scripts/check-platform-parity.mjs                      # gate
 *   node scripts/check-platform-parity.mjs affected --base <sha> [--write-github-output]
 *     (reads changed paths on stdin for root files no package owns)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const RUNTIME_PACKAGE = "@open-managed-agents/session-runtime";
export const PARITY_PACKAGE_DIR = "packages/platform-parity";

/**
 * Session domain packages are discovered by directory: every
 * packages/session-* and packages/sandbox-* that is not an adapter (design
 * §0.7 gate 1 requires each of them to be classified as domain or adapter).
 * Adapters are recognised by the same naming the structural gate uses.
 */
export const DOMAIN_PACKAGE_PREFIXES = ["packages/session-", "packages/sandbox-", "packages/sandbox"];

/** Session domain packages outside those prefixes (§0.7 table targets). */
export const EXTRA_DOMAIN_PACKAGES = [
  "@open-managed-agents/managed-agents-application",
  "@open-managed-agents/runtime-resource-contract",
];

/** Platform adapters: implement a domain Port for one platform/provider. */
export const ADAPTER_SUFFIXES = ["-sql", "-memory", "-cloudflare", "-node", "-d1"];
export const ADAPTER_PREFIXES = ["packages/sandbox-adapter-"];

export function isAdapterDir(dir) {
  return ADAPTER_SUFFIXES.some((suffix) => dir.endsWith(suffix))
    || ADAPTER_PREFIXES.some((prefix) => dir.startsWith(prefix));
}

/**
 * Domain packages a deployment does not reach today. Key: deployment id
 * (see deploymentOf), value: package -> cause. Remove an entry when the
 * deployment starts reaching the package; the gate fails until you do.
 */
export const REACHABILITY_EXCEPTIONS = {
  cloudflare: {
    "@open-managed-agents/session-realtime":
      "CF fans out live events from SessionDO WebSockets (apps/agent/src/runtime/session-do.ts /ws) instead of the session-realtime hub; Node uses MemorySessionRealtimeHub (packages/control-plane-node/src/modules/node-managed.ts:794)",
  },
};

export function readWorkspace(root = process.cwd()) {
  const packages = new Map();
  for (const group of ["apps", "packages"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${group}/${entry.name}`;
      const manifestPath = join(root, dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string") continue;
      packages.set(manifest.name, { name: manifest.name, dir, manifest });
    }
  }
  return packages;
}

/** Workspace edges, every dependency kind (what pnpm's `...` filter follows). */
export function workspaceDependencies(workspace, name) {
  const manifest = workspace.get(name)?.manifest ?? {};
  const all = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  return Object.entries(all)
    .filter(([dep, spec]) => workspace.has(dep) && String(spec).startsWith("workspace:"))
    .map(([dep]) => dep)
    .sort();
}

export function reachable(workspace, name) {
  const seen = new Set();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const dep of workspaceDependencies(workspace, current)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

/** (a) Deployable apps whose graph reaches session-runtime. */
export function discoverPlatforms(workspace) {
  return [...workspace.values()]
    .filter((pkg) => pkg.dir.startsWith("apps/"))
    .filter((pkg) => reachable(workspace, pkg.name).has(RUNTIME_PACKAGE))
    .map((pkg) => pkg.name)
    .sort();
}

export function sessionDomainPackages(workspace) {
  const session = [...workspace.values()]
    .filter((pkg) => pkg.dir === "packages/sandbox"
      || DOMAIN_PACKAGE_PREFIXES.some((prefix) => prefix.endsWith("-") && pkg.dir.startsWith(prefix)))
    .filter((pkg) => !isAdapterDir(pkg.dir))
    .map((pkg) => pkg.name);
  return [...new Set([...session, ...EXTRA_DOMAIN_PACKAGES.filter((n) => workspace.has(n))])].sort();
}

/** Direct workspace deps of `name` that lead to session-runtime. */
export function runtimePaths(workspace, name) {
  return workspaceDependencies(workspace, name).filter(
    (dep) => dep === RUNTIME_PACKAGE || reachable(workspace, dep).has(RUNTIME_PACKAGE),
  );
}

/** Deployment unit a platform's reachability is judged on. */
export function deploymentOf(registration, name) {
  if (registration?.kind === "runner") return registration.runner;
  return name;
}

function moduleSpecifiers(source) {
  const found = new Set();
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/**
 * Proves a reuse declaration: the only path to session-runtime runs through
 * the composition package, and the entry assembles the control plane only
 * through that package's createNodeControlPlane + nodeDefaults + loadNodeConfig.
 */
export function reuseViolations(root, workspace, name, registration, runners) {
  const violations = [];
  const target = registration.composition;
  const targetRegistration = registration.runner;
  if (!runners[targetRegistration]) {
    violations.push(`${name}: reuses unknown runner ${targetRegistration}`);
  }
  const paths = runtimePaths(workspace, name);
  if (paths.length !== 1 || paths[0] !== target) {
    violations.push(
      `${name}: declared reuse of ${target}, but its paths to ${RUNTIME_PACKAGE} are [${paths.join(", ")}]`,
    );
  }
  const entryPath = join(root, registration.entry);
  if (!existsSync(entryPath)) {
    violations.push(`${name}: reuse entry ${registration.entry} does not exist`);
    return violations;
  }
  const source = readFileSync(entryPath, "utf8");
  const specifiers = moduleSpecifiers(source);
  for (const required of ["control-plane", "components", "config"]) {
    if (!specifiers.includes(`${target}/${required}`)) {
      violations.push(`${name}: entry ${registration.entry} does not import ${target}/${required}`);
    }
  }
  // main-fly binds loadNodeConfig(...) to a variable first; main-vercel
  // inlines it. Both must call the two composition functions.
  for (const [label, pattern] of [
    ["createNodeControlPlane(await nodeDefaults(...))", /createNodeControlPlane\(\s*await\s+nodeDefaults\(/u],
    ["loadNodeConfig(...)", /\bloadNodeConfig\(/u],
  ]) {
    if (!pattern.test(source)) {
      violations.push(`${name}: entry ${registration.entry} does not call ${label}`);
    }
  }
  const sessionHosts = [RUNTIME_PACKAGE, "@open-managed-agents/control-plane-node", "@open-managed-agents/agent"];
  for (const specifier of specifiers) {
    if (sessionHosts.some((host) => specifier === host || specifier.startsWith(`${host}/`))) {
      violations.push(`${name}: entry ${registration.entry} imports Session host ${specifier} directly`);
    }
  }
  return violations;
}

export function notHostViolations(workspace, name) {
  const paths = runtimePaths(workspace, name);
  const hosts = new Set([RUNTIME_PACKAGE, "@open-managed-agents/control-plane-node", "@open-managed-agents/agent"]);
  const direct = paths.filter((dep) => hosts.has(dep));
  return direct.length === 0
    ? []
    : [`${name}: registered not-a-session-host but depends on Session host(s) ${direct.join(", ")}`];
}

export function registrationViolations(root, workspace, { registrations, runners }) {
  const violations = [];
  const platforms = discoverPlatforms(workspace);
  for (const name of platforms) {
    const registration = registrations[name];
    if (registration === undefined) {
      violations.push(
        `${name}: discovered platform (reaches ${RUNTIME_PACKAGE} via ${runtimePaths(workspace, name).join(", ")}) has no parity runner registered in ${PARITY_PACKAGE_DIR}/platforms.mjs`,
      );
      continue;
    }
    if (registration.kind === "runner") {
      const runner = runners[registration.runner];
      if (!runner) violations.push(`${name}: registered runner ${registration.runner} is not in PARITY_RUNNERS`);
    } else if (registration.kind === "reuse") {
      violations.push(...reuseViolations(root, workspace, name, registration, runners));
    } else if (registration.kind === "not-a-session-host") {
      violations.push(...notHostViolations(workspace, name));
    } else {
      violations.push(`${name}: unknown registration kind ${registration.kind}`);
    }
  }
  for (const name of Object.keys(registrations)) {
    if (!platforms.includes(name)) {
      violations.push(`${name}: registered in platforms.mjs but is not a discovered platform; remove the registration`);
    }
  }
  for (const [id, runner] of Object.entries(runners)) {
    const file = join(root, runner.file);
    if (!existsSync(file)) {
      violations.push(`runner ${id}: file ${runner.file} does not exist`);
      continue;
    }
    // A runner exists only if it executes the shared scenario set against
    // the shared golden files; a file with the right name is not enough.
    const source = readFileSync(file, "utf8");
    for (const required of ["registerParityRunner(", "PARITY_SCENARIOS", `runner: "${id}"`]) {
      if (!source.includes(required)) {
        violations.push(`runner ${id}: ${runner.file} does not contain ${required} (it must run the shared scenarios via registerParityRunner)`);
      }
    }
  }
  return violations;
}

export function reachabilityViolations(workspace, { registrations }, exceptions = REACHABILITY_EXCEPTIONS) {
  const violations = [];
  const domain = sessionDomainPackages(workspace);
  const deployments = new Map();
  for (const name of discoverPlatforms(workspace)) {
    const registration = registrations[name];
    if (registration === undefined || registration.kind === "not-a-session-host") continue;
    const id = deploymentOf(registration, name);
    const reach = deployments.get(id) ?? new Set();
    for (const dep of reachable(workspace, name)) reach.add(dep);
    deployments.set(id, reach);
  }
  for (const [id, reach] of [...deployments].sort(([a], [b]) => a.localeCompare(b))) {
    const allowed = exceptions[id] ?? {};
    for (const pkg of domain) {
      if (!reach.has(pkg) && !(pkg in allowed)) {
        violations.push(
          `${id}: does not reach Session domain package ${pkg}; either it has its own copy (move it onto ${pkg}) or record the missing feature in REACHABILITY_EXCEPTIONS`,
        );
      }
    }
    for (const pkg of Object.keys(allowed)) {
      if (reach.has(pkg)) {
        violations.push(`${id}: now reaches ${pkg}; delete its REACHABILITY_EXCEPTIONS entry`);
      } else if (!domain.includes(pkg)) {
        violations.push(`${id}: REACHABILITY_EXCEPTIONS lists ${pkg}, which is not a Session domain package`);
      }
    }
  }
  for (const id of Object.keys(exceptions)) {
    if (!deployments.has(id)) violations.push(`REACHABILITY_EXCEPTIONS has unknown deployment ${id}`);
  }
  return violations;
}

/** Root files outside any workspace package that the parity suite imports. */
export function parityRootImports(root, workspace, runners) {
  const files = [];
  const parityDir = join(root, PARITY_PACKAGE_DIR);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "golden") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(m?[jt]s)$/u.test(entry.name)) files.push(path);
    }
  };
  if (existsSync(parityDir)) walk(parityDir);
  for (const runner of Object.values(runners)) files.push(join(root, runner.file));
  const packageDirs = [...workspace.values()].map((pkg) => pkg.dir);
  const owned = (rel) => packageDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
  const targets = new Set();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const rel = relative(root, normalize(join(dirname(file), specifier))).replaceAll("\\", "/");
      if (rel.startsWith("..") || owned(rel)) continue;
      for (const candidate of [rel, `${rel}.ts`, `${rel}.mjs`, `${rel}/index.ts`]) {
        if (existsSync(join(root, candidate))) targets.add(candidate);
      }
    }
  }
  return [...targets].sort();
}

/**
 * Affected platforms → CI jobs. `affectedPackages` is pnpm's answer to
 * `--filter "...[<merge-base>]"`. Root files have no package, so a change to
 * a runner file, the parity package, or a root file they import marks every
 * runner (pnpm cannot see those edges).
 */
export function affectedRunners({ workspace, registrations, runners, affectedPackages, changedPaths, rootImports }) {
  const affected = new Set(affectedPackages);
  const result = new Set();
  const reasons = [];
  for (const name of discoverPlatforms(workspace)) {
    if (!affected.has(name)) continue;
    const registration = registrations[name];
    if (registration === undefined || registration.kind === "not-a-session-host") continue;
    result.add(registration.runner);
    reasons.push(`${name} -> ${registration.runner}`);
  }
  const paths = changedPaths.map((p) => p.trim().replace(/^\.\//u, "")).filter(Boolean);
  const runnerFiles = Object.values(runners).map((runner) => runner.file);
  const suiteChange = paths.find((p) =>
    p.startsWith(`${PARITY_PACKAGE_DIR}/`) || runnerFiles.includes(p) || rootImports.includes(p));
  if (suiteChange !== undefined || affected.has("@open-managed-agents/platform-parity")) {
    for (const id of Object.keys(runners)) result.add(id);
    reasons.push(`parity suite changed (${suiteChange ?? "@open-managed-agents/platform-parity"}) -> all runners`);
  }
  const jobs = {};
  for (const [id, runner] of Object.entries(runners)) {
    jobs[runner.ciJob] = (jobs[runner.ciJob] ?? false) || result.has(id);
  }
  return { runners: [...result].sort(), jobs, reasons };
}

export function pnpmAffectedPackages(root, base) {
  const out = execFileSync(
    "pnpm",
    ["ls", "-r", "--depth", "-1", "--json", "--filter", `...[${base}]`],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out.trim() || "[]");
  return parsed.map((pkg) => pkg.name).filter(Boolean);
}

async function loadRegistry(root) {
  const mod = await import(pathToFileURL(join(root, PARITY_PACKAGE_DIR, "platforms.mjs")).href);
  return { registrations: mod.PLATFORM_REGISTRATIONS, runners: mod.PARITY_RUNNERS };
}

async function readStdin() {
  if (process.stdin.isTTY) return [];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/u);
}

async function main(argv) {
  const root = process.cwd();
  const workspace = readWorkspace(root);
  const registry = await loadRegistry(root);
  if (argv[0] === "affected") {
    const baseIndex = argv.indexOf("--base");
    const base = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;
    if (!base) throw new Error("affected requires --base <merge-base sha>");
    const result = affectedRunners({
      workspace,
      ...registry,
      affectedPackages: pnpmAffectedPackages(root, base),
      changedPaths: await readStdin(),
      rootImports: parityRootImports(root, workspace, registry.runners),
    });
    console.log(JSON.stringify(result, null, 2));
    if (argv.includes("--write-github-output")) {
      const out = process.env.GITHUB_OUTPUT;
      if (!out) throw new Error("--write-github-output requires GITHUB_OUTPUT");
      const lines = Object.entries(result.jobs).map(([job, run]) => `parity_${job}=${run ? "true" : "false"}`);
      writeFileSync(out, `${lines.join("\n")}\n`, { flag: "a" });
    }
    return;
  }
  const violations = [
    ...registrationViolations(root, workspace, registry),
    ...reachabilityViolations(workspace, registry),
  ];
  if (violations.length > 0) {
    throw new Error(`Platform parity violation(s):\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  }
  const platforms = discoverPlatforms(workspace);
  console.log(
    `Platform parity check passed for ${platforms.length} discovered platforms (${platforms.join(", ")}), ${Object.keys(registry.runners).length} runners, ${sessionDomainPackages(workspace).length} Session domain packages.`,
  );
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
