// Pi host-loop golden coverage.
import { runNodeContextBuildFailure } from "./node-context-build-failure.fixture";
// Multi-platform parity gate — Node runner (design §0.7 gate 3).
// Drives the in-process Node control plane (createNodeControlPlane +
// nodeDefaults + loadNodeConfig, sqlite, local-subprocess sandbox double) only
// through the public /v1 API. The same composition entry serves
// @open-managed-agents/main-fly and @open-managed-agents/main-vercel, which
// declare reuse of this runner (packages/platform-parity/platforms.mjs; the
// gate re-proves it from the dependency graph and their entry modules).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  type HarnessContext, AcpSandboxHarness, PiHarness, registerHarness,
} from "@open-managed-agents/agent-harness";
import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import {
  revisionJudgeResponse,
  ACP_CHILD_EXIT_HARNESS,
  ACP_TIMEOUT_HARNESS,
  ACP_REVISION_TIMEOUT_HARNESS,
  PARITY_HARNESS,
  PARITY_MODEL,
  PARITY_SCENARIOS,
  ScenarioContext,
  UNREACHABLE_MODEL_BASE_URL,
  installLeakCapture,
  parityModels,
  acpChildExitHarness,
  registerParityRunner,
  type KnownDifference,
} from "../../../packages/platform-parity/src";

registerHarness(PARITY_HARNESS, () => {
  const harness = new PiHarness();
  return {
    async run(ctx: HarnessContext) {
      await harness.run({ ...ctx, pi: parityModels.piRuntimeFor(ctx.agent?.name) });
    },
  };
});

// A child process's stdout pipe ends when the process exits.
registerHarness(ACP_CHILD_EXIT_HARNESS, () =>
  acpChildExitHarness<HarnessContext>(() => new AcpSandboxHarness(), { stdoutEndsOnExit: false }));

registerHarness(ACP_TIMEOUT_HARNESS, () =>
  acpChildExitHarness<HarnessContext>(() => new AcpSandboxHarness(), { stdoutEndsOnExit: true, timeout: true }));

const dir = mkdtempSync(join(tmpdir(), "oma-platform-parity-"));
// This platform declares no leaked rejections: any unhandled rejection while
// the file runs fails it in afterAll.
const leaks = installLeakCapture([]);
let controlPlane: NodeControlPlane;

beforeAll(async () => {
  controlPlane = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    // Context dependency fixture calls the real missing-channel configuration
    // path on the SessionExecution lane, matching the CF fixture.
    PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
  })));
  // v1 executions are claimed by the poller, which only runs after start().
  await controlPlane.start();
  const card = await controlPlane.fetch(new Request("http://cp/v1/oma/model_cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "ant", model_id: PARITY_MODEL, api_key: "sk-ant-parity", base_url: UNREACHABLE_MODEL_BASE_URL }),
  }));
  if (card.status !== 201 && card.status !== 409) {
    throw new Error(`parity model card: ${card.status} ${await card.text()}`);
  }
}, 60_000);

afterAll(async () => {
  await controlPlane?.stop("test");
  rmSync(dir, { recursive: true, force: true });
  leaks.dispose();
  expect(leaks.unexpected(), "undeclared unhandled rejections").toEqual([]);
});

const goldens = Object.fromEntries(
  Object.entries(import.meta.glob("../../../packages/platform-parity/golden/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>)
    .map(([path, text]) => [path.split("/").at(-1)!.replace(/\.json$/u, ""), text]),
);

/**
 * Known differences of this platform against the golden files. Each entry
 * becomes a Vitest test.fails; delete it when the platform is fixed.
 */
const KNOWN_DIFFERENCES: KnownDifference[] = [];

registerParityRunner({ describe, test, expect }, {
  runner: "node",
  scenarios: PARITY_SCENARIOS,
  goldens,
  goldenFile: (name) => `../../../packages/platform-parity/golden/${name}.json`,
  knownDifferences: KNOWN_DIFFERENCES,
  run: async (scenario) => {
    const context = new ScenarioContext(async (request) => controlPlane.fetch(request), {}, {
      hostPaths: { [dir]: "host-workdir" },
    });
    if (scenario.name === "context-build-failure") await runNodeContextBuildFailure(context, controlPlane.components.database.sql);
    else await scenario.run(context);
    const observation = await context.observe();
    console.log(`PARITY_OBSERVATION node ${scenario.name} ${JSON.stringify(observation)}`);
    return observation;
  },
});

registerHarness(ACP_REVISION_TIMEOUT_HARNESS, () => {
  const acp = acpChildExitHarness<HarnessContext>(() => new AcpSandboxHarness(), { stdoutEndsOnExit: true, timeout: true });
  return { async run(ctx: HarnessContext) {
    if (JSON.stringify(ctx.runtime.history.getEvents()).includes("<outcome_feedback")) await acp.run(ctx);
    else ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "First attempt." }] });
  } };
});

const originalFetch = globalThis.fetch;
const unreachableModelHost = new URL(UNREACHABLE_MODEL_BASE_URL).host;
beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(init?.body).includes("parity-revision-timeout")) return revisionJudgeResponse();
    // The parity model endpoint is unreachable by contract. Fail it the way
    // undici does for an unresolvable host instead of trusting the host
    // network: an egress proxy answers HTTP 500 for it, which changed the
    // golden's "Connection error." into a machine-specific explanation.
    if (new URL(input instanceof Request ? input.url : String(input)).host === unreachableModelHost) {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${unreachableModelHost}`), { code: "ENOTFOUND" }) });
    }
    return originalFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());
