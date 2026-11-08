import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  applyVitestFilters, collectWiring, evaluateWiring, globToRegExp, isTestFile, renderWiring, vitestArgs, vitestFilterMatches,
} from "./check-test-wiring.mjs";

test("isTestFile covers the repository's test naming and skips generated trees", () => {
  for (const path of ["a/b.test.ts", "a/b.spec.tsx", "scripts/x.test.mjs", "apps/web/tests/seo.node.mjs",
    "packages/p/test/relay.node.ts", "apps/m/test/db.mysql.integration.ts", "apps/m/scripts/live.e2e.ts"]) {
    assert.equal(isTestFile(path), true, path);
  }
  for (const path of ["src/logger.node.ts", "src/db.integration.ts", "a/node_modules/x.test.ts", "packages/p/dist/x.test.js",
    "apps/agent/build-1/x.test.ts", "tsconfig.test.json", "packages/p/test/helper.ts", "packages/p/test/a.typecheck.ts"]) {
    assert.equal(isTestFile(path), false, path);
  }
});

test("globToRegExp handles **, *, ? and braces", () => {
  assert.ok(globToRegExp("packages/*/test/*.e2e.test.ts").test("packages/runtime/test/docker.e2e.test.ts"));
  assert.ok(!globToRegExp("packages/*/test/*.ts").test("packages/a/test/deep/x.ts"));
  assert.ok(globToRegExp("apps/**/*.e2e.ts").test("apps/main-node/scripts/live.e2e.ts"));
  assert.ok(globToRegExp("apps/**/*.e2e.ts").test("apps/live.e2e.ts"));
  assert.ok(globToRegExp("test/{a,b}.spec.ts").test("test/b.spec.ts"));
  assert.ok(globToRegExp("x?.ts").test("x1.ts"));
});

test("vitest args split into project flags and file filters", () => {
  assert.deepEqual(vitestArgs(["--config", "v.ts", "--coverage", "--reporter", "dot", "-t", "name", "test/node", "--project=a"]), {
    flags: ["--config", "v.ts", "--project=a"], filters: ["test/node"],
  });
});

test("vitest filters follow vitest's own rule and report filters that match nothing", () => {
  assert.ok(vitestFilterMatches("test/node/proxy.test.ts", "test/node"));
  assert.ok(vitestFilterMatches("src/Pages/A.test.tsx", "./src/pages"));
  assert.ok(!vitestFilterMatches("test/a.test.ts", "test/b"));
  const call = { dir: "apps/app", args: ["--config", "v.ts", "test/a", "test/gone.test.ts"] };
  assert.deepEqual(applyVitestFilters(call, ["apps/app/test/a.test.ts", "apps/app/test/b.test.ts"]), {
    files: ["apps/app/test/a.test.ts"],
    problems: ['apps/app: vitest filter "test/gone.test.ts" matches no test file of --config v.ts'],
  });
});

test("evaluateWiring separates unwired, allowlisted, stale and invalid entries", () => {
  const verdict = evaluateWiring({
    testFiles: ["a.test.ts", "b.test.ts", "live/c.e2e.ts", "d.test.ts"],
    executed: new Map([["a.test.ts", [["ci"]]]]),
    allowlist: [
      { pattern: "live/*.e2e.ts", reason: "needs a key" },
      { pattern: "gone.test.ts", reason: "deleted" },
      { pattern: "d.test.ts", reason: "" },
    ],
  });
  assert.deepEqual(verdict.unwired, ["b.test.ts"]);
  assert.deepEqual(verdict.allowlisted, ["d.test.ts", "live/c.e2e.ts"]);
  assert.deepEqual(verdict.stale, [{ pattern: "gone.test.ts", reason: "deleted" }]);
  assert.deepEqual(verdict.invalid, [{ pattern: "d.test.ts", reason: "" }]);
  assert.match(renderWiring(verdict), /no CI step runs[\s\S]*b\.test\.ts[\s\S]*Stale[\s\S]*gone\.test\.ts[\s\S]*Invalid/u);
  assert.equal(renderWiring(evaluateWiring({ testFiles: ["a.test.ts"], executed: new Map([["a.test.ts", []]]), allowlist: [] })), "");
});

test("collectWiring follows a workflow to node --test and playwright files in a fixture repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-wiring-"));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    write("package.json", JSON.stringify({ name: "fixture", scripts: { "test:ci": "node --test scripts/*.test.mjs && pnpm --filter app test" } }));
    write("apps/app/package.json", JSON.stringify({ name: "app", scripts: { test: "playwright test e2e/wired.spec.ts --config=pw.config.ts" } }));
    write(".github/workflows/ci.yml", "jobs:\n  ci:\n    steps:\n      - name: Tests\n        run: pnpm test:ci\n");
    write("scripts/test-wiring-allowlist.json", JSON.stringify({ entries: [{ pattern: "live/*.e2e.ts", reason: "needs a key" }] }));
    for (const file of ["scripts/one.test.mjs", "apps/app/e2e/wired.spec.ts", "apps/app/e2e/orphan.spec.ts", "live/run.e2e.ts"]) write(file, "");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const wiring = await collectWiring(root);
    const verdict = evaluateWiring(wiring);
    assert.deepEqual(verdict.unwired, ["apps/app/e2e/orphan.spec.ts"]);
    assert.deepEqual(verdict.allowlisted, ["live/run.e2e.ts"]);
    assert.deepEqual([...wiring.executed.keys()].sort(), ["apps/app/e2e/wired.spec.ts", "scripts/one.test.mjs"]);
    assert.deepEqual(wiring.executed.get("apps/app/e2e/wired.spec.ts")[0], ["ci › Tests", "root test:ci", "app test"]);
    assert.deepEqual(verdict.problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
