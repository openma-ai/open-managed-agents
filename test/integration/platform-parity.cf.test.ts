// Legacy ai-sdk golden coverage; not default-Pi mixed-batch acceptance.
// Default Pi gates: mixed-process-restart.test.ts and pi-mixed-restart.cf.test.ts.
// @ts-nocheck
// Multi-platform parity gate — Cloudflare runner (design §0.7 gate 3).
// Drives the real combined worker (apps/main routes + apps/agent SessionDO,
// test/test-worker.ts) through the public /v1 API. The context-failure case
// injects a scoped dependency failure inside the DO (see its fixture).
// Model: the shared
// scripted model via the "platform-parity" harness. Sandbox: the existing CF
// test double (test/sandbox-stub.ts). Platforms using this runner:
// @open-managed-agents/agent, @open-managed-agents/main
// (packages/platform-parity/platforms.mjs).
import { runCfContextBuildFailure } from "../fixtures/cf-context-build-failure";
import { exports } from "cloudflare:workers";
import { installParityModelTransport } from "../fixtures/cf-parity-outbound";
const modelTransport = installParityModelTransport();
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AcpSandboxHarness } from "../../packages/agent-harness/src/acp-sandbox-loop";
import { DefaultHarness } from "../../packages/agent-harness/src/default-loop";
import { registerHarness } from "../../packages/agent-harness/src/registry";
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
  acpChildExitHarness,
  errorSignature,
  installLeakCapture,
  parityModels,
  registerParityRunner,
  type KnownDifference,
} from "../../packages/platform-parity/src";

registerHarness(PARITY_HARNESS, () => {
  const harness = new DefaultHarness();
  return {
    async run(ctx) {
      await harness.run({ ...ctx, model: parityModels.modelFor(ctx.agent?.name) });
    },
  };
});

// OmaSandbox.spawnDuplex streams stdout over Workers RPC; the e2e
// cf-container-acp-mm-r1 run saw the exit reported while stdout stayed open.
registerHarness(ACP_CHILD_EXIT_HARNESS, () =>
  acpChildExitHarness(() => new AcpSandboxHarness(), { stdoutEndsOnExit: false }));

registerHarness(ACP_TIMEOUT_HARNESS, () =>
  acpChildExitHarness(() => new AcpSandboxHarness(), { stdoutEndsOnExit: false, timeout: true }));

const AUTH = { "x-api-key": "test-key" };

// Rejections this platform leaks while the scenarios run. They are product
// defects, not public output, so they stay out of the golden; each one names
// the product file:line. Anything not declared here fails the file (afterAll).
const leaks = installLeakCapture([
  // Outcome evaluator judge call against the unreachable parity model card:
  // every generateText retry attempt (packages/agent-harness/src/outcome-evaluator.ts:53)
  // rejects at packages/agent-harness/src/pi-ai-sdk.ts:62 and the attempt promise
  // is left unobserved on the ai telemetry tracing-channel path
  // (ai/src/telemetry/tracing-channel-publisher.ts:109) under workerd.
  errorSignature("packages/agent-harness/src/pi-ai-sdk.ts:62 (outcome evaluator retries)", {
    message: "Connection error.",
    stack: ["generateWithPi"],
  }),
  // ACP channel configuration failures must propagate through the awaited
  // RPC boundary without a detached rejection; no leak exception is allowed.
  // user.interrupt aborts the in-flight turn; the abort reason rejects a
  // promise nobody awaits (apps/agent/src/runtime/session-do.ts:2986).
  errorSignature("apps/agent/src/runtime/session-do.ts:2986 (interrupt abort)", {
    name: "AbortError",
    message: "The operation was aborted",
    stack: ["session-do.ts"],
  }),
  // The aborted turn's ai streamText flush writes into the cancelled stream
  // (ai/src/generate-text/stream-text.ts:3070 enqueueStepPart).
  errorSignature("ai/src/generate-text/stream-text.ts:3070 (flush after interrupt)", {
    name: "TypeError",
    message: "The readable side of this TransformStream is no longer readable.",
    stack: ["stream-text"],
  }),
]);

afterAll(() => {
  leaks.dispose();
  console.log(`PARITY_LEAKS cloudflare ${JSON.stringify(leaks.absorbed())}`);
  expect(leaks.unexpected(), "undeclared unhandled rejections").toEqual([]);
});

const fetchPublic = (request) => exports.default.fetch(request);

beforeAll(async () => {
  const beforeProbe = modelTransport.calls();
  const response = await fetchPublic(new Request("http://localhost/v1/oma/model_cards", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ provider: "ant", model_id: PARITY_MODEL, api_key: "sk-ant-parity", base_url: UNREACHABLE_MODEL_BASE_URL }),
  }));
  expect(modelTransport.calls() - beforeProbe).toBe(response.status === 201 ? 1 : 0);
  if (response.status !== 201 && response.status !== 409) {
    throw new Error(`parity model card: ${response.status} ${await response.text()}`);
  }
}, 60_000);

const goldens = Object.fromEntries(
  Object.entries(import.meta.glob("../../packages/platform-parity/golden/*.json", { query: "?raw", import: "default", eager: true }))
    .map(([path, text]) => [path.split("/").at(-1).replace(/\.json$/u, ""), text]),
);

/**
 * Known differences of this platform against the golden files (generated by
 * the Node runner). Each entry becomes a Vitest test.fails that turns red the
 * moment the platform matches the golden; delete the entry then.
 */
const STUB_CAUSE =
  "sandbox double: golden runs real commands (local-subprocess); the CF double test/sandbox-stub.ts:76 returns empty "
  + "stdout for every exec and :92-93 no-op read/write, so bash renders \"exit=0\", read \"(completed with no output)\" "
  + "(packages/agent-harness/src/tools.ts:212) and write \"ok\" — a test-double difference, not product behaviour. Kept: "
  + "workerd cannot run commands, and making the stub fake real output would only bend the double to the golden";
const stub = (scenario: string, paths: string[]): KnownDifference => ({
  scenario,
  title: "sandbox double tool output",
  paths,
  cause: STUB_CAUSE,
});
const FIRST_RESULT_TEXT = "/events/agent.tool_result/0/content/0/text";

const KNOWN_DIFFERENCES: KnownDifference[] = [
  stub("tool-call", [FIRST_RESULT_TEXT]),
  stub("budget-usage", [FIRST_RESULT_TEXT]),
  stub("interrupt", [FIRST_RESULT_TEXT]),
  stub("memory-read-write", [FIRST_RESULT_TEXT, "/events/agent.tool_result/1/content/0/text"]),
  stub("session-outputs", [FIRST_RESULT_TEXT]),
  stub("mixed-custom-tools", [FIRST_RESULT_TEXT]),
  {
    scenario: "memory-read-write",
    title: "agent memory write not in the store",
    paths: ["/reads/memories"],
    cause: "golden lists /learned.md written by the agent; CF lists only /seed.md: without R2 FUSE credentials the memory "
      + "store mount falls back to a local directory (apps/agent/src/runtime/sandbox.ts:463-467), so agent writes never reach the store. "
      + "Test environment, not product behaviour: the workerd suite has no R2 FUSE credentials; kept",
  },
  {
    scenario: "session-outputs",
    title: "outputs not published",
    paths: ["/reads/outputs", "/reads/output_read/status", "/reads/output_read/body"],
    cause: "golden lists report.txt and reads it (200 \"parity report\"); CF lists [] and 404s: without R2 FUSE credentials "
      + "mountSessionOutputs uses a local directory (apps/agent/src/runtime/sandbox.ts:540-570), so nothing is published. "
      + "Test environment, not product behaviour: the workerd suite has no R2 FUSE credentials; kept",
  },
  stub("requires-action", [FIRST_RESULT_TEXT]),
  {
    scenario: "interrupt",
    title: "user.interrupt listed after the aborted model span",
    paths: [],
    eventTypes: ["user.interrupt"],
    cause: "golden (Node) stamps user.interrupt when it is accepted (packages/control-plane-node/src/lib/"
      + "node-session-execution-worker.ts sessionEventsAccepted) and lists it in accept order, before the aborted "
      + "span.model_request_end; CF applies it first and appends it after the aborted turn settles "
      + "(apps/agent/src/runtime/session-do.ts user.interrupt handler, INTERRUPT_GRACE_MS: CMA \"the interrupt can take "
      + "longer to apply while tool calls are running\", processed_at null until applied). CF is the contract side here; "
      + "Node needs its accepted-input stamping and listing order reworked (Session inputs, wave 2)",
  },
  {
    scenario: "context-build-failure",
    title: "no status_running before a context-build failure",
    paths: ["/events/session.status_running"],
    eventTypes: ["session.status_running"],
    cause: "golden (Node) emits session.status_running before buildHarnessContext "
      + "(packages/control-plane-node/src/lib/node-managed-session-runner.ts runHarness); CF emits it after the "
      + "HarnessContext is built (apps/agent/src/runtime/session-do.ts runningEvent in the turn try), so a context "
      + "that fails to build goes user.message -> session.error -> idle. Both settle exhausted + retries_exhausted; kept",
  },
];

registerParityRunner({ describe, test, expect }, {
  runner: "cloudflare",
  scenarios: PARITY_SCENARIOS,
  goldens,
  goldenFile: (name) => `../../packages/platform-parity/golden/${name}.json`,
  knownDifferences: KNOWN_DIFFERENCES,
  run: async (scenario) => {
    const context = new ScenarioContext(fetchPublic, AUTH);
    const beforeModelCalls = modelTransport.calls();
    if (scenario.name === "context-build-failure") await runCfContextBuildFailure(context);
    else await scenario.run(context);
    if (scenario.name === "outcome-evaluation") expect(modelTransport.calls() - beforeModelCalls).toBe(4);
    const observation = await context.observe();
    console.log(`PARITY_OBSERVATION cloudflare ${scenario.name} ${JSON.stringify(observation)}`);
    return observation;
  },
});

registerHarness(ACP_REVISION_TIMEOUT_HARNESS, () => {
  const acp = acpChildExitHarness(() => new AcpSandboxHarness(), { stdoutEndsOnExit: false, timeout: true });
  return { async run(ctx) {
    if (JSON.stringify(ctx.runtime.history.getEvents()).includes("<outcome_feedback")) await acp.run(ctx);
    else ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "First attempt." }] });
  } };
});

const originalFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal("fetch", async (input, init) => {
    if (String(init?.body).includes("parity-revision-timeout")) return revisionJudgeResponse();
    // Keep the source rejection observed in this workerd async wrapper. Bare
    // promise adoption leaked it even though the provider handled its failure.
    return await originalFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());
