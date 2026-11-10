import { expect, it } from "vitest";
import { createNodeEnvironmentWorkWorker } from "../../../packages/control-plane-node/src/lib/node-environment-work-worker";
import type { NodeConfig } from "../src/config";

it.each([
 ["/usr/local/bin/node", ["/workspace/worker.js"]],
 ["/usr/local/bin/node", ["--import", "/workspace/hook.mjs", "/opt/oma-managed/worker/node-e2b-work-item-cli.js"]],
 ["/workspace/node", ["/opt/oma-managed/worker/node-e2b-work-item-cli.js"]],
])("rejects writable or loader-hook E2B worker launch %s %j before dispatch", (command, args) => {
 const config = { sandbox: { environment: { SANDBOX_PROVIDER: "e2b", OPENMA_WORK_RUNNER_COMMAND: command, OPENMA_WORK_RUNNER_ARGS: JSON.stringify(args) } }, http: {} } as NodeConfig;
 expect(() => createNodeEnvironmentWorkWorker({ config } as Parameters<typeof createNodeEnvironmentWorkWorker>[0])).toThrow(/trusted E2B worker/);
});
