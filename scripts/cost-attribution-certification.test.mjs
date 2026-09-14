import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultCostAttributionCertificationLanes,
  parseCostAttributionCertificationArguments,
  runCostAttributionCertification,
  runCostAttributionCertificationCli,
} from "./cost-attribution-certification.mjs";

test("cost attribution certification covers every adapter with explicit credentials", () => {
  const lanes = defaultCostAttributionCertificationLanes();
  assert.deepEqual(lanes.map(({ provider }) => provider), [
    "cost-attribution-cloudflare",
    "cost-attribution-vercel",
    "cost-attribution-blaxel",
  ]);
  for (const lane of lanes) {
    assert.ok(lane.credentialRequirements.length > 0);
    assert.deepEqual(lane.command.slice(0, 3), [
      "pnpm",
      "exec",
      "tsx",
    ]);
    assert.equal(lane.command.at(-1), lane.provider.replace("cost-attribution-", ""));
  }
});

test("missing provider credentials are reported and never executed", async () => {
  let executions = 0;
  const report = await runCostAttributionCertification({
    env: {},
    cwd: process.cwd(),
    commit: { sha: "abc", dirty: false },
    execute: async () => {
      executions += 1;
      return { exitCode: 0 };
    },
  });

  assert.equal(executions, 0);
  assert.deepEqual(report.summary, {
    total: 3,
    pass: 0,
    fail: 0,
    not_run_no_credential: 3,
  });
  assert.ok(report.results.every(({ status }) => status === "NOT_RUN_NO_CREDENTIAL"));
  assert.equal(report.kind, "openma.cost_attribution_certification");
});

test("the credentialed lane delegates to the real adapter probe", async () => {
  const observed = [];
  const lane = defaultCostAttributionCertificationLanes()[1];
  const report = await runCostAttributionCertification({
    lanes: [lane],
    env: { VERCEL_TOKEN: "secret", VERCEL_TEAM_ID: "team_123" },
    cwd: process.cwd(),
    commit: { sha: "abc", dirty: false },
    execute: async (selected) => {
      observed.push(selected.command);
      return { exitCode: 0, stdout: "provider=vercel status=PASS", stderr: "" };
    },
  });

  assert.deepEqual(observed, [[
    "pnpm",
    "exec",
    "tsx",
    "scripts/cost-attribution-live-probe.ts",
    "vercel",
  ]]);
  assert.equal(report.results[0].status, "PASS");
});

test("cost attribution certification CLI is strict by default and can inventory missing credentials", async () => {
  const output = [];
  const written = [];
  const lane = defaultCostAttributionCertificationLanes()[0];
  const strict = await runCostAttributionCertificationCli({
    argv: ["--", "--report", "strict.json"],
    lanes: [lane],
    env: {},
    cwd: process.cwd(),
    commit: { sha: "abc", dirty: false },
    stdout: { write: (value) => output.push(value) },
    writeReport: async (report, path) => written.push({ report, path }),
  });
  assert.equal(strict, 2);
  assert.match(output.join(""), /NOT_RUN_NO_CREDENTIAL/);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, new URL("strict.json", `file://${process.cwd()}/`).pathname);

  const inventory = await runCostAttributionCertificationCli({
    argv: ["--allow-missing"],
    lanes: [lane],
    env: {},
    cwd: process.cwd(),
    commit: { sha: "abc", dirty: false },
    stdout: { write: () => {} },
    writeReport: async () => {},
  });
  assert.equal(inventory, 0);
});

test("cost attribution certification CLI validates arguments", () => {
  assert.equal(parseCostAttributionCertificationArguments([]).allowMissing, false);
  assert.equal(
    parseCostAttributionCertificationArguments(["--allow-missing"]).allowMissing,
    true,
  );
  assert.throws(
    () => parseCostAttributionCertificationArguments(["--report"]),
    /--report requires a value/,
  );
  assert.throws(
    () => parseCostAttributionCertificationArguments(["--report", "--bad"]),
    /--report requires a value/,
  );
  assert.throws(
    () => parseCostAttributionCertificationArguments(["--bad"]),
    /unknown cost attribution certification option/,
  );
});
