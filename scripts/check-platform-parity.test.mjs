import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  affectedRunners,
  discoverPlatforms,
  parityRootImports,
  reachabilityViolations,
  readWorkspace,
  registrationViolations,
  sessionDomainPackages,
} from "./check-platform-parity.mjs";
import { PARITY_RUNNERS, PLATFORM_REGISTRATIONS } from "../packages/platform-parity/platforms.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scope = "@open-managed-agents";
const RUNNER_SOURCE = (id) => `registerParityRunner({ describe, test, expect }, { runner: "${id}", scenarios: PARITY_SCENARIOS });\n`;

/** Minimal workspace: two runners (cf, node), session-runtime + domain packages. */
function fixture(t, { apps = {}, packages = {}, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oma-parity-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const manifest = (group, dir, deps) => write(`${group}/${dir}/package.json`, JSON.stringify({
    name: `${scope}/${dir}`,
    dependencies: Object.fromEntries(deps.map((dep) => [`${scope}/${dep}`, "workspace:*"])),
  }));
  const basePackages = {
    "session-runtime": ["session-store"],
    "session-store": [],
    "session-store-sql": ["session-store"],
    "control-plane-node": ["session-runtime", "session-store-sql"],
    ...packages,
  };
  const baseApps = {
    agent: ["session-runtime"],
    main: ["session-runtime"],
    "main-node": ["control-plane-node"],
    docs: [],
    ...apps,
  };
  for (const [dir, deps] of Object.entries(basePackages)) if (deps !== null) manifest("packages", dir, deps);
  for (const [dir, deps] of Object.entries(baseApps)) if (deps !== null) manifest("apps", dir, deps);
  const allFiles = {
    "test/cf.test.ts": RUNNER_SOURCE("cloudflare"),
    "apps/main-node/test/parity.test.ts": RUNNER_SOURCE("node"),
    ...files,
  };
  for (const [rel, content] of Object.entries(allFiles)) if (content !== null) write(rel, content);
  return root;
}

const RUNNERS = {
  cloudflare: { file: "test/cf.test.ts", ciScript: "test:ci:cf", ciJob: "cf" },
  node: { file: "apps/main-node/test/parity.test.ts", ciScript: "test:ci:node", ciJob: "node" },
};
const REGISTRATIONS = {
  [`${scope}/agent`]: { kind: "runner", runner: "cloudflare" },
  [`${scope}/main`]: { kind: "runner", runner: "cloudflare" },
  [`${scope}/main-node`]: { kind: "runner", runner: "node" },
};

test("the repository passes the gate", () => {
  const workspace = readWorkspace(repoRoot);
  const registry = { registrations: PLATFORM_REGISTRATIONS, runners: PARITY_RUNNERS };
  assert.deepEqual(registrationViolations(repoRoot, workspace, registry), []);
  assert.deepEqual(reachabilityViolations(workspace, registry), []);
  const platforms = discoverPlatforms(workspace);
  for (const name of [`${scope}/agent`, `${scope}/main`, `${scope}/main-node`, `${scope}/main-fly`, `${scope}/main-vercel`]) {
    assert.ok(platforms.includes(name), `${name} discovered`);
  }
  assert.ok(!platforms.includes(`${scope}/docs`));
});

test("platforms are discovered from the dependency graph, adapters are not domain packages", (t) => {
  const root = fixture(t);
  const workspace = readWorkspace(root);
  assert.deepEqual(discoverPlatforms(workspace), [`${scope}/agent`, `${scope}/main`, `${scope}/main-node`]);
  assert.deepEqual(sessionDomainPackages(workspace), [`${scope}/session-runtime`, `${scope}/session-store`]);
});

test("a discovered platform without a registered runner fails", (t) => {
  const root = fixture(t, { apps: { "main-new": ["session-runtime"] } });
  const violations = registrationViolations(root, readWorkspace(root), { registrations: REGISTRATIONS, runners: RUNNERS });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /main-new: discovered platform \(reaches @open-managed-agents\/session-runtime via @open-managed-agents\/session-runtime\) has no parity runner registered/u);
});

test("the CLI exits non-zero for an unregistered platform", (t) => {
  const root = fixture(t, {
    apps: { "main-new": ["control-plane-node"] },
    files: {
      "packages/platform-parity/platforms.mjs": `export const PARITY_RUNNERS = ${JSON.stringify(RUNNERS)};\nexport const PLATFORM_REGISTRATIONS = ${JSON.stringify(REGISTRATIONS)};\n`,
    },
  });
  const run = spawnSync(process.execPath, [join(repoRoot, "scripts/check-platform-parity.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /main-new: discovered platform .* has no parity runner registered/u);
});

test("stale registrations, unknown runners and runner files that skip the shared scenarios fail", (t) => {
  const root = fixture(t, { files: { "apps/main-node/test/parity.test.ts": "test('own scenarios', () => {});\n" } });
  const violations = registrationViolations(root, readWorkspace(root), {
    registrations: {
      ...REGISTRATIONS,
      [`${scope}/agent`]: { kind: "runner", runner: "workerd" },
      [`${scope}/docs`]: { kind: "runner", runner: "node" },
    },
    runners: RUNNERS,
  });
  assert.ok(violations.some((v) => /agent: registered runner workerd is not in PARITY_RUNNERS/u.test(v)));
  assert.ok(violations.some((v) => /docs: registered in platforms.mjs but is not a discovered platform/u.test(v)));
  assert.ok(violations.some((v) => /runner node: .* does not contain registerParityRunner\(/u.test(v)));
});

test("reuse must be proven by the graph and the entry module", (t) => {
  const entry = [
    'import { loadNodeConfig } from "@open-managed-agents/main-node/config";',
    'import { nodeDefaults } from "@open-managed-agents/main-node/components";',
    'import { createNodeControlPlane } from "@open-managed-agents/main-node/control-plane";',
    "const plane = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(process.env)));",
  ].join("\n");
  const root = fixture(t, {
    apps: { "main-fly": ["main-node"], "main-sneaky": ["main-node", "session-runtime"] },
    files: { "apps/main-fly/src/index.ts": entry, "apps/main-sneaky/src/index.ts": entry.replace("createNodeControlPlane(await", "other(await") },
  });
  const reuse = (app) => ({ kind: "reuse", runner: "node", entry: `apps/${app}/src/index.ts`, composition: `${scope}/main-node` });
  const violations = registrationViolations(root, readWorkspace(root), {
    registrations: { ...REGISTRATIONS, [`${scope}/main-fly`]: reuse("main-fly"), [`${scope}/main-sneaky`]: reuse("main-sneaky") },
    runners: RUNNERS,
  });
  assert.ok(!violations.some((v) => v.includes("main-fly")), violations.join("\n"));
  assert.ok(violations.some((v) => /main-sneaky: declared reuse of .*main-node, but its paths to .*session-runtime are \[.*main-node, .*session-runtime\]/u.test(v)));
  assert.ok(violations.some((v) => /main-sneaky: entry .* does not call createNodeControlPlane/u.test(v)));
});

test("not-a-session-host may not depend on a Session host directly", (t) => {
  const root = fixture(t, { apps: { gateway: ["control-plane-node"] } });
  const violations = registrationViolations(root, readWorkspace(root), {
    registrations: { ...REGISTRATIONS, [`${scope}/gateway`]: { kind: "not-a-session-host", cause: "test" } },
    runners: RUNNERS,
  });
  assert.deepEqual(violations, [`${scope}/gateway: registered not-a-session-host but depends on Session host(s) ${scope}/control-plane-node`]);
});

test("every deployment must reach every Session domain package or record an exception", (t) => {
  const root = fixture(t, { packages: { "session-wakeup": [] }, apps: { "main-node": ["control-plane-node", "session-wakeup"] } });
  const workspace = readWorkspace(root);
  const registry = { registrations: REGISTRATIONS, runners: RUNNERS };
  assert.deepEqual(reachabilityViolations(workspace, registry, {}), [
    `cloudflare: does not reach Session domain package ${scope}/session-wakeup; either it has its own copy (move it onto ${scope}/session-wakeup) or record the missing feature in REACHABILITY_EXCEPTIONS`,
  ]);
  assert.deepEqual(reachabilityViolations(workspace, registry, { cloudflare: { [`${scope}/session-wakeup`]: "test" } }), []);
  // An exception that is no longer true, or names something else, fails.
  assert.deepEqual(reachabilityViolations(workspace, registry, {
    cloudflare: { [`${scope}/session-wakeup`]: "test", [`${scope}/session-store`]: "stale" },
    vercel: {},
  }), [
    `cloudflare: now reaches ${scope}/session-store; delete its REACHABILITY_EXCEPTIONS entry`,
    "REACHABILITY_EXCEPTIONS has unknown deployment vercel",
  ]);
});

test("affected runners follow pnpm's reverse dependents, root suite files mark every runner", (t) => {
  const root = fixture(t, { files: { "test/fakes/model.ts": "export {};\n", "packages/platform-parity/src/index.ts": 'import "../../../test/fakes/model";\n' } });
  const workspace = readWorkspace(root);
  const base = { workspace, registrations: REGISTRATIONS, runners: RUNNERS, changedPaths: [], rootImports: parityRootImports(root, workspace, RUNNERS) };
  assert.deepEqual(base.rootImports, ["test/fakes/model.ts"]);
  // control-plane-node changed: pnpm "...[base]" = it + main-node.
  assert.deepEqual(affectedRunners({ ...base, affectedPackages: [`${scope}/control-plane-node`, `${scope}/main-node`] }).jobs, { cf: false, node: true });
  // session-store changed: every deployment reaches it.
  const all = [`${scope}/session-store`, `${scope}/session-runtime`, `${scope}/control-plane-node`, `${scope}/agent`, `${scope}/main`, `${scope}/main-node`];
  assert.deepEqual(affectedRunners({ ...base, affectedPackages: all }).jobs, { cf: true, node: true });
  assert.deepEqual(affectedRunners({ ...base, affectedPackages: [`${scope}/docs`] }).jobs, { cf: false, node: false });
  // Root files have no package; the suite's own files still mark every runner.
  for (const changed of ["test/fakes/model.ts", "packages/platform-parity/golden/one-turn.json", "test/cf.test.ts"]) {
    assert.deepEqual(affectedRunners({ ...base, affectedPackages: [], changedPaths: [changed] }).jobs, { cf: true, node: true }, changed);
  }
});

test("every Session domain package is routed to every runner whose deployment reaches it", () => {
  const workspace = readWorkspace(repoRoot);
  const registry = { registrations: PLATFORM_REGISTRATIONS, runners: PARITY_RUNNERS };
  for (const pkg of sessionDomainPackages(workspace)) {
    // What pnpm "...[base]" returns when only `pkg` changed: pkg + its reverse dependents.
    const dependents = [...workspace.keys()].filter((name) => {
      const seen = new Set([name]);
      const queue = [name];
      while (queue.length > 0) {
        const manifest = workspace.get(queue.pop())?.manifest ?? {};
        for (const [dep, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
          if (!String(spec).startsWith("workspace:") || seen.has(dep) || !workspace.has(dep)) continue;
          seen.add(dep);
          queue.push(dep);
        }
      }
      return seen.has(pkg);
    });
    const { runners } = affectedRunners({ workspace, ...registry, affectedPackages: dependents, changedPaths: [], rootImports: [] });
    assert.ok(runners.includes("node"), `${pkg} reaches node`);
    if (pkg !== `${scope}/session-realtime`) assert.ok(runners.includes("cloudflare"), `${pkg} reaches cloudflare`);
  }
});

test("CI routes the cf / node jobs by the parity graph as well as the path lists", () => {
  const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /git merge-base/u);
  assert.match(ci, /node scripts\/check-platform-parity\.mjs affected --base "\$MERGE_BASE" --write-github-output < \/tmp\/ci-changed-files\.txt/u);
  assert.match(ci, /parity_cf: \$\{\{ steps\.parity\.outputs\.parity_cf \}\}/u);
  assert.match(ci, /parity_node: \$\{\{ steps\.parity\.outputs\.parity_node \}\}/u);
  assert.match(ci, /if: needs\.changes\.outputs\.cf == 'true' \|\| needs\.changes\.outputs\.parity_cf == 'true'/u);
  assert.match(ci, /if: needs\.changes\.outputs\.node == 'true' \|\| needs\.changes\.outputs\.parity_node == 'true'/u);
  const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
  assert.match(scripts["test:architecture"], /node scripts\/check-platform-parity\.mjs/u);
  assert.match(scripts["test:architecture"], /scripts\/check-platform-parity\.test\.mjs/u);
  // Each runner is part of its CI script: root vitest for cf, main-node test for node.
  assert.match(scripts["test:ci:cf"], /pnpm exec vitest run/u);
  assert.match(scripts["test:ci:node"], /pnpm run test:packages/u);
  assert.match(scripts["test:packages"], /pnpm --filter @open-managed-agents\/main-node test/u);
});
