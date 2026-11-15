import { afterEach, expect, it, vi } from "vitest";
import { CfE2BWorkLease } from "../src/runtime/cf-work-provider-lease";
import { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";

const identity = { workspaceId: "ws", sessionId: "sess", workId: "work", attemptId: "environment-work-claim:1" };
afterEach(() => vi.useRealTimers());
function fixture() {
  let current = true;
  let failure: Error | undefined;
  let release!: () => void;
  let blocked = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const timeouts: number[] = [], kills: string[] = [];
  const runtime = new E2BSandboxExecutor({ sandboxId: "physical", commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, files: { read: async () => "", write: async () => {} }, kill: async () => { throw Error("must not kill whole sandbox"); }, setTimeout: async ms => { timeouts.push(ms); if (blocked) await gate; } }, { apiKey: "test" });
  const lease = new CfE2BWorkLease();
  const target = { identity, runtime, ttlMs: 360_000, isCurrent: async () => { if (failure) throw failure; return current; }, handle: { id: "exact-process", pid: 41, getStatus: async () => kills.length ? "exited" : "running", kill: async (signal: string) => { kills.push(signal ?? ""); } } };
  lease.register(target);
  return { lease, target, timeouts, kills, lose: () => { current = false; }, fail: () => { failure = Error("SQL unavailable"); }, block: () => { blocked = true; }, release: () => release() };
}
it("renews the actual E2B provider lease independently of Work heartbeat through finalization", async () => {
  const f = fixture();
  await f.lease.maintain(); await f.lease.maintain();
  expect(f.timeouts).toEqual([360_000, 360_000]);
  expect(f.kills).toEqual([]);
  f.lose(); await f.lease.maintain(); await f.lease.maintain();
  expect(f.timeouts).toHaveLength(2); expect(f.kills).toEqual(["SIGTERM"]);
});
it("timeout and duplicate registration retain the same native RPC; losing authority cleans only the exact worker", async () => {
  vi.useFakeTimers(); const f = fixture(); f.block();
  const first = f.lease.maintain(); const rejected = expect(first).rejects.toThrow(/pending/);
  await vi.advanceTimersByTimeAsync(1_000); await rejected;
  f.lease.register({ ...f.target });
  const second = f.lease.maintain(); const secondRejected = expect(second).rejects.toThrow(/pending/);
  await vi.advanceTimersByTimeAsync(1_000); await secondRejected;
  expect(f.timeouts).toHaveLength(1);
  f.lose(); await f.lease.maintain();
  expect(f.kills).toEqual(["SIGTERM"]);
  f.release(); await Promise.resolve(); await f.lease.maintain();
  expect(f.timeouts).toHaveLength(1);
});
it("unknown authority is not lease loss and cannot kill or renew", async () => {
  const f = fixture(); f.fail();
  await expect(f.lease.maintain()).rejects.toThrow("SQL unavailable");
  expect(f.timeouts).toEqual([]); expect(f.kills).toEqual([]);
});
it("reentrant maintenance starts only one provider RPC", async () => {
  const f = fixture(); f.block();
  const first = f.lease.maintain(), second = f.lease.maintain();
  await vi.waitFor(() => expect(f.timeouts).toHaveLength(1));
  f.release(); await Promise.all([first, second]); expect(f.timeouts).toHaveLength(1);
});

it("SQL Work lease authority includes stopping but rejects holder revocation and expired claims", async () => {
  const { env, exports } = await import("cloudflare:workers");
  const { CfD1SqlClient } = await import("@open-managed-agents/sql-client/adapters/cf-d1");
  const { SqlEnvironmentWorkStore } = await import("@open-managed-agents/environment-work-store-sql");
  const { createCfE2BWorkLeaseAuthority } = await import("../src/runtime/cf-work-provider-lease");
  await exports.default.fetch(new Request("http://localhost/health"));
  const sql = new CfD1SqlClient((env as typeof env & { MAIN_DB: D1Database }).MAIN_DB);
  const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: plaintext }), open: async ({ ciphertext }) => ({ plaintext: ciphertext }) });
  const now = new Date().toISOString(), workId = "lease_" + crypto.randomUUID();
  await work.insert({ workspaceId: "default", record: { work: { id: workId, environmentId: "env", data: { type: "session", id: "sess" }, state: "active", createdAt: now, acknowledgedAt: now, latestHeartbeatAt: now, startedAt: now, metadata: {}, stopRequestedAt: null, stoppedAt: null }, secret: { sessionsToken: "sk-ant-req-v1.test" }, claim: { generation: 1, workerId: "worker", claimedAt: now }, heartbeatTtlSeconds: 90 } });
  const holderHash = "a".repeat(64);
  await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{h:holderHash,s:"all"}]),workId).run();
  const isCurrent = createCfE2BWorkLeaseAuthority({ sql, work, generation: 1, holderHash, delivery: { workspaceId: "default", environmentId: "env", sessionId: "sess", workId, apiBaseUrl: "https://control.test", workSecret: btoa(JSON.stringify({ sessions_token: "sk-ant-req-v1.test", api_base_url: "https://control.test" })) } });
  expect(await isCurrent()).toBe(true);
  await sql.prepare("UPDATE managed_environment_work SET state='stopping' WHERE id=?").bind(workId).run();
  expect(await isCurrent()).toBe(true);
  await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes='[]' WHERE id=?").bind(workId).run();
  expect(await isCurrent()).toBe(false);
  await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=?,claim_at=0 WHERE id=?").bind(JSON.stringify([{h:holderHash,s:"all"}]),workId).run();
  expect(await isCurrent()).toBe(false);
});

it("late renewal failure remains observed after timeout and never renews a successor", async () => {
  vi.useFakeTimers(); const f = fixture(); f.block();
  const pending = f.lease.maintain(); const rejected = expect(pending).rejects.toThrow(/pending/);
  await vi.advanceTimersByTimeAsync(1_000); await rejected;
  f.lose(); await f.lease.maintain(); f.release();
  await vi.advanceTimersByTimeAsync(1);
  await f.lease.maintain();
  expect(f.timeouts).toEqual([360_000]); expect(f.kills).toEqual(["SIGTERM"]);
});

it("retiring the old exact process does not kill the registered new owner's process", async () => {
  const old = fixture(), successor = fixture();
  old.lease.register({ ...successor.target, identity: { ...identity, attemptId: "environment-work-claim:2" }, handle: { ...successor.target.handle, id: "successor-process" } });
  old.lose(); await old.lease.maintain();
  expect(old.kills).toEqual(["SIGTERM"]); expect(successor.kills).toEqual([]);
  expect(old.timeouts).toEqual([]); expect(successor.timeouts).toEqual([360_000]);
  await old.lease.maintain();
  expect(old.kills).toEqual(["SIGTERM"]); expect(successor.kills).toEqual([]);
});
