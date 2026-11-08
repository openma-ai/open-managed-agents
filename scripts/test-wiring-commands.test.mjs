import assert from "node:assert/strict";
import test from "node:test";

import { expandCiStep, selectPackages, shellSegments, substituteExpressions, workflowSteps } from "./test-wiring-commands.mjs";

const workspace = {
  root: {
    name: "root",
    dir: ".",
    scripts: {
      "test:ci": "pnpm run test:unit && pnpm --filter '@scope/store-*' test && node --test scripts/a.test.mjs scripts/*.node.mjs",
      "test:unit": "vitest run --config vitest.unit.config.ts",
      "test:e2e": "playwright test test/e2e/one.spec.ts --config=playwright.config.ts",
      "test:offline": "node scripts/orchestrator.mjs",
    },
  },
  packages: new Map([
    ["@scope/store-sql", { name: "@scope/store-sql", dir: "packages/store-sql", scripts: { test: "pnpm run prepare && vitest run --config vitest.config.ts" , prepare: "tsc -b" } }],
    ["@scope/store-memory", { name: "@scope/store-memory", dir: "packages/store-memory", scripts: { typecheck: "tsc --noEmit" } }],
    ["@scope/app", { name: "@scope/app", dir: "apps/app", scripts: { test: "astro build && node --test tests/*.node.mjs" } }],
  ]),
};
const step = (run, env = {}) => ({ job: "ci", name: "step", env, run });
const calls = (result) => result.calls.map(({ runner, dir, args }) => ({ runner, dir, args }));

test("workflowSteps reads inline and block run scalars and step env", () => {
  const steps = workflowSteps(`name: CI
jobs:
  build:
    runs-on: ubuntu
    steps:
      - name: Checkout
        uses: actions/checkout@v7
      - name: Test
        env:
          ONLY: "console"
          LIST: \${{ needs.changes.outputs.list }}
        run: |
          set -e
          pnpm test:ci
  other:
    steps:
      - run: node --test x.test.mjs
`);
  assert.deepEqual(steps, [
    { job: "build", name: "Checkout", env: {}, run: null },
    { job: "build", name: "Test", env: { ONLY: "console", LIST: "${{ needs.changes.outputs.list }}" }, run: "set -e\npnpm test:ci" },
    { job: "other", name: null, env: {}, run: "node --test x.test.mjs" },
  ]);
});

test("shellSegments splits simple commands and keeps quoted words whole", () => {
  assert.deepEqual(shellSegments("A=1 pnpm --filter 'a b' test && cd x || echo \"y z\"; npx vite # comment\nnode --test a \\\n  b | tee log"), [
    ["A=1", "pnpm", "--filter", "a b", "test"], ["cd", "x"], ["echo", "y z"], ["npx", "vite"], ["node", "--test", "a", "b"], ["tee", "log"],
  ]);
});

test("substituteExpressions fills needs outputs and blanks other expressions", () => {
  assert.equal(substituteExpressions("a ${{ needs.changes.outputs.specs }} ${{ runner.temp }}", { specs: "x.spec.ts" }), "a x.spec.ts ");
});

test("root scripts, filtered package scripts and node --test globs expand to runner calls", () => {
  const result = expandCiStep(step("pnpm test:ci"), workspace);
  assert.deepEqual(calls(result), [
    { runner: "vitest", dir: ".", args: ["--config", "vitest.unit.config.ts"] },
    { runner: "vitest", dir: "packages/store-sql", args: ["--config", "vitest.config.ts"] },
    { runner: "node-test", dir: ".", args: ["scripts/a.test.mjs", "scripts/*.node.mjs"] },
  ]);
  // A glob filter skips packages without the script; nothing to report.
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.calls[1].via, ["ci › step", "root test:ci", "@scope/store-sql test"]);
});

test("extra pnpm arguments reach the last command of the script", () => {
  const result = expandCiStep(step("pnpm --filter @scope/store-sql test test/one.test.ts"), workspace);
  assert.deepEqual(calls(result), [{ runner: "vitest", dir: "packages/store-sql", args: ["--config", "vitest.config.ts", "test/one.test.ts"] }]);
});

test("exec, npx, cd, env prefixes and bash -c are followed", () => {
  const result = expandCiStep(step("FOO=1 pnpm --filter @scope/app exec vitest run src && cd apps/app && npx playwright test e2e/a.spec.ts && bash -c 'node --test t.test.mjs'"), workspace);
  assert.deepEqual(calls(result), [
    { runner: "vitest", dir: "apps/app", args: ["src"] },
    { runner: "playwright", dir: "apps/app", args: ["e2e/a.spec.ts"] },
    { runner: "node-test", dir: "apps/app", args: ["t.test.mjs"] },
  ]);
});

test("the here-string command loop runs each line of its env list", () => {
  const run = 'while IFS= read -r cmd; do\n  [[ -z "$cmd" ]] && continue\n  bash -c "$cmd"\ndone <<< "$CMDS"';
  const result = expandCiStep(step(run, { CMDS: "${{ needs.changes.outputs.cmds }}" }), workspace, { outputs: { cmds: "pnpm test:unit\npnpm test:e2e" } });
  assert.deepEqual(calls(result).map((call) => call.runner), ["vitest", "playwright"]);
});

test("orchestrators expand into their child commands, or report an unmodelled mode", () => {
  const orchestrators = { "scripts/orchestrator.mjs": (env) => (env.MODE === "ok" ? ["pnpm --filter @scope/store-sql test"] : null) };
  const ok = expandCiStep(step("pnpm test:offline", { MODE: "ok" }), workspace, { orchestrators });
  assert.deepEqual(calls(ok).map((call) => call.runner), ["file", "vitest"]);
  const unmodelled = expandCiStep(step("pnpm test:offline"), workspace, { orchestrators });
  assert.match(unmodelled.problems[0].message, /orchestrator mode is not modelled/u);
});

test("broken wiring is reported: unknown filters, missing scripts, unknown root scripts", () => {
  const result = expandCiStep(step("pnpm --filter @scope/gone test && pnpm --filter @scope/store-memory test && pnpm run test:missing"), workspace);
  assert.deepEqual(result.problems.map((problem) => problem.message), [
    "pnpm --filter @scope/gone matches no workspace package",
    '@scope/store-memory: no "test" script',
    'root: no "test:missing" script',
  ]);
});

test("selectPackages supports names, globs and directory selectors", () => {
  const sink = { workspace, problems: [] };
  const context = { dir: ".", via: [] };
  assert.deepEqual(selectPackages(["@scope/store-*", "{apps/app}"], context, sink).map((p) => [p.name, p.exact]), [
    ["@scope/store-sql", false], ["@scope/store-memory", false], ["@scope/app", true],
  ]);
  selectPackages(["...@scope/app"], context, sink);
  assert.match(sink.problems[0].message, /selector form is not modelled/u);
});
