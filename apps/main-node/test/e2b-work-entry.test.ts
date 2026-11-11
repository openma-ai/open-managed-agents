import { expect, it } from "vitest";
import { createNodeEnvironmentWorkWorker, WORK_RESERVATION_RECLAIM_MS } from "../../../packages/control-plane-node/src/lib/node-environment-work-worker";
import type { NodeConfig } from "../src/config";

it.each([
 ["/usr/local/bin/node", ["/workspace/worker.js"]],
 ["/usr/local/bin/node", ["--import", "/workspace/hook.mjs", "/opt/oma-managed/worker/node-e2b-work-item-cli.js"]],
 ["/workspace/node", ["/opt/oma-managed/worker/node-e2b-work-item-cli.js"]],
])("rejects writable or loader-hook E2B worker launch %s %j before dispatch", (command, args) => {
 const config = { sandbox: { environment: { SANDBOX_PROVIDER: "e2b", OPENMA_WORK_RUNNER_COMMAND: command, OPENMA_WORK_RUNNER_ARGS: JSON.stringify(args) } }, http: {} } as NodeConfig;
 expect(() => createNodeEnvironmentWorkWorker({ config } as Parameters<typeof createNodeEnvironmentWorkWorker>[0])).toThrow(/trusted E2B worker/);
});

// Multi-replica Node: an unacknowledged reservation must outlive the launch
// (open + restore + native start + worker ACK) or a peer reclaims it mid-launch.
it("polls with a reservation reclaim window that covers one sandbox launch", async () => {
 const polls: Array<{ reclaimOlderThanMilliseconds?: number }> = [];
 const sql = { prepare: (query: string) => ({
  all: async () => ({ results: query.includes("SELECT DISTINCT workspace_id") ? [{ workspace_id: "ws", environment_id: "env" }] : [] }),
  bind: () => ({ first: async () => ({ document: JSON.stringify({ id: "env", config: { type: "cloud" } }), updated_at: 0, archived_at: null }), all: async () => ({ results: [] }) }),
 }) };
 const config = { sandbox: { environment: { SANDBOX_PROVIDER: "e2b", OPENMA_WORK_RUNNER_COMMAND: "/usr/local/bin/node", OPENMA_WORK_RUNNER_ARGS: JSON.stringify(["/opt/oma-managed/worker/node-e2b-work-item-cli.js"]) } },
  http: { publicBaseUrl: "https://node.example" }, execution: { ownerId: "node-a" } } as unknown as NodeConfig;
 const worker = createNodeEnvironmentWorkWorker({ config, sql, work: {}, sandboxes: {}, capabilities: {}, onError: () => {},
  application: () => ({ pollEnvironmentWork: async (query: { reclaimOlderThanMilliseconds?: number }) => { polls.push(query); return { type: "empty" }; } }),
 } as never);
 await worker.start(); await worker.stop();
 expect(polls.length).toBeGreaterThan(0);
 expect(polls.every(query => query.reclaimOlderThanMilliseconds === WORK_RESERVATION_RECLAIM_MS)).toBe(true);
 expect(WORK_RESERVATION_RECLAIM_MS).toBeGreaterThanOrEqual(30_000);
 expect(WORK_RESERVATION_RECLAIM_MS).toBeLessThan(90_000); // a peer must be able to reclaim before the claim TTL expires
});
it.each(["0", "-1", "90000", "1.5", "abc"])("rejects reservation reclaim override %s", value => {
 const config = { sandbox: { environment: { OPENMA_WORK_RESERVATION_RECLAIM_MS: value } }, http: {}, execution: { ownerId: "n" } } as unknown as NodeConfig;
 expect(() => createNodeEnvironmentWorkWorker({ config } as never)).toThrow(/OPENMA_WORK_RESERVATION_RECLAIM_MS/);
});
