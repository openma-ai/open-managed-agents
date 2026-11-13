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

it("preserves scheduling and tick exceptions for dispatch diagnostics", async () => {
 const reported: unknown[] = [];
 const scheduling = new Error("scheduling diagnostic sentinel");
 const tick = new Error("tick diagnostic sentinel");
 const worker = createNodeEnvironmentWorkWorker({
  config: { sandbox: { environment: {} }, http: {} } as NodeConfig,
  recovery: { recoverSchedulingPage: async ({ onError }) => { onError(scheduling); throw tick; } },
  onError: error => { reported.push(error); },
 } as Parameters<typeof createNodeEnvironmentWorkWorker>[0]);
 await worker.start(); await worker.stop();
 expect(reported).toEqual([scheduling, tick]);
});

it("logs bounded exception causes without SDK credential fields", async () => {
 const { describeWorkDispatchError } = await import("../../../packages/control-plane-node/src/lib/work-dispatch-error");
 const cause = Object.assign(new Error("GET https://user:password@example.test/sandbox?token=query-secret returned 404"), { headers: { authorization: "never-serialize-me" } });
 const error = new Error("dispatch known-secret sk-ant-req-v1.dynamic-token Bearer bearer-secret", { cause });
 const diagnostic = describeWorkDispatchError(error, ["known-secret"]);
 const serialized = JSON.stringify(diagnostic);
 expect(diagnostic.causes).toHaveLength(2);
 expect(diagnostic.causes[1].message).toContain("returned 404");
 for (const secret of ["known-secret", "dynamic-token", "bearer-secret", "query-secret", "password", "never-serialize-me"]) expect(serialized).not.toContain(secret);
 expect(describeWorkDispatchError({ authorization: "secret" })).toEqual({ causes: [], thrownType: "object" });
});

it("preserves the dispatcher exception passed to onError", async () => {
 const failure = new Error("dispatch diagnostic sentinel");
 const reported: unknown[] = [];
 const sql = { prepare: (query: string) => ({
  all: async () => ({ results: query.includes("SELECT DISTINCT workspace_id") ? [{ workspace_id: "ws", environment_id: "env" }] : [] }),
  bind: () => ({ first: async () => ({ document: JSON.stringify({ id: "env", config: { type: "cloud" } }), updated_at: 0, archived_at: null }), all: async () => ({ results: [] }) }),
 }) };
 const config = { sandbox: { environment: { OPENMA_WORK_RUNNER_COMMAND: "/usr/local/bin/node" } }, http: { publicBaseUrl: "https://node.example" }, execution: { ownerId: "node-a" } } as unknown as NodeConfig;
 const worker = createNodeEnvironmentWorkWorker({ config, sql, work: {}, sandboxes: {}, capabilities: {}, onError: (error: unknown) => { reported.push(error); },
  application: () => ({ pollEnvironmentWork: async () => { throw failure; } }),
 } as never);
 await worker.start(); await worker.stop();
 expect(reported.length).toBeGreaterThan(0);
 expect(reported.every(error => error === failure)).toBe(true);
});

it("tracing records a dispatch rejected before openSandbox without fabricating an open span", async () => {
 const { NoopTracer } = await import("@open-managed-agents/observability");
 const rows: Array<{name: string; status?: number}> = [];
 class Recorder extends NoopTracer {
  override startActiveSpan<T>(name: string, fn: (span: import("@open-managed-agents/observability").Span) => T | Promise<T>): T | Promise<T> {
   const row: typeof rows[number] = { name }; rows.push(row); const span = super.startSpan(name);
   span.setStatus = status => { row.status = status.code; };
   return Promise.resolve(fn(span)).finally(() => span.end());
  }
 }
 const reported: unknown[] = [];
 const sql = { prepare: (query: string) => ({
  all: async () => ({ results: query.includes("SELECT DISTINCT workspace_id") ? [{ workspace_id: "ws", environment_id: "env" }] : [] }),
  bind: () => ({ first: async () => ({ document: JSON.stringify({ id: "env", config: { type: "cloud" } }), updated_at: 0, archived_at: null }), all: async () => ({ results: [] }) }),
 }) };
 const config = { sandbox: { environment: { OPENMA_WORK_RUNNER_COMMAND: "/usr/local/bin/node" } }, http: { publicBaseUrl: "https://node.example" }, execution: { ownerId: "node-a" } } as unknown as NodeConfig;
 const worker = createNodeEnvironmentWorkWorker({ config, sql, tracer: new Recorder(), work: { find: async () => null }, sandboxes: {}, capabilities: {}, onError: (error: unknown) => { reported.push(error); },
  application: () => ({ pollEnvironmentWork: async () => ({ type: "work", work: { id: "work", environmentId: "env", data: { type: "session", id: "sess" }, secret: null, state: "queued" } }) }),
 } as never);
 await worker.start(); await worker.stop();
 expect(rows.length).toBeGreaterThan(0);
 expect(rows.every(row => row.name === "work.dispatch" && row.status === 2)).toBe(true);
 expect(reported.some(error => error instanceof Error && error.message === "Work delivery rejected")).toBe(true);
});
