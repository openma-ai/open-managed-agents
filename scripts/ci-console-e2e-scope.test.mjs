import assert from "node:assert/strict";
import test from "node:test";
import { selectConsoleE2E } from "./ci-console-e2e-scope.mjs";

test("Console Deployments page → Deployments frontend + deployments backend only", () => {
  const r = selectConsoleE2E(["apps/console/src/pages/DeploymentDetail.tsx"]);
  assert.deepEqual(r.layers, { deployments: ["backend", "frontend"] });
  assert.deepEqual(r.local, ["test/e2e/console-deployments.spec.ts"]);
  assert.deepEqual(r.cert, ["test/e2e/deployed-console-deployments.spec.ts"]);
  assert.ok(r.commands.some((c) => c.includes("deployments.contract.test.ts")));
  assert.ok(!r.commands.some((c) => c.includes("deployment-store-sql")), "storage is two layers away");
});

test("deployments backend → its Console, CLI, SDK and storage (one layer out)", () => {
  const r = selectConsoleE2E(["packages/managed-agents-app/src/modules/deployments.ts"]);
  assert.deepEqual(r.layers, { deployments: ["backend", "cli", "frontend", "sdk", "storage"] });
  assert.deepEqual(r.local, ["test/e2e/console-deployments.spec.ts"]);
  assert.ok(r.commands.some((c) => c.includes("deployment-store-sql")));
  assert.ok(r.commands.some((c) => c.includes("@openma/cli")));
});

test("deployments storage → storage + backend, not the Console", () => {
  const r = selectConsoleE2E(["packages/deployment-store-sql/src/index.ts"]);
  assert.deepEqual(r.layers, { deployments: ["backend", "storage"] });
  assert.equal(r.local.length + r.cert.length, 0);
});

test("agent editor change selects the agent round-trip cert spec", () => {
  const r = selectConsoleE2E(["apps/console/src/pages/agents/agentFormCodec.ts"]);
  assert.deepEqual(r.domains, ["agents"]);
  assert.deepEqual(r.cert, ["test/e2e/deployed-console.spec.ts"]);
});

test("shared Console plumbing selects frontend+backend of every domain", () => {
  const r = selectConsoleE2E(["apps/console/src/lib/api.ts"]);
  assert.deepEqual(r.domains, ["agents", "auth", "deployments", "sessions", "settings"]);
  assert.deepEqual(r.layers.deployments, ["backend", "frontend"]);
});

test("unrelated paths select nothing", () => {
  const r = selectConsoleE2E(["apps/web/src/index.ts", "docs/x.md", "packages/sandbox/src/a.ts"]);
  assert.equal(r.run, false);
});
