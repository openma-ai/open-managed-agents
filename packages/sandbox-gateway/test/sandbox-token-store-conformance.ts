// Behavior suite for the sandbox token on real SQL (#561): every
// SandboxTokenStore adapter runs it — workerd D1 (test/integration/
// sandbox-gateway-d1.test.ts) and Node better-sqlite3 (apps/main-node/test/
// node-managed-acp-capability.test.ts). Interleavings are pinned with a
// statement gate (hold one statement until released), never sleeps.

import { describe, expect, it } from "vitest";
import type { SessionExecutionFence, SessionExecutionStorePort } from "@open-managed-agents/session-runtime-contract";
import {
  authenticateSandboxEgress, authenticateSandboxToken, authenticateSandboxTokenRequest, generateSandboxToken,
  issueSandboxToken, sandboxBasicCredential, sandboxTokenRandomPart, sha256Hex,
  type SandboxTokenChannel, type SandboxTokenStore,
} from "../src/index";
import { seedSandboxGatewaySessionRows, type SandboxGatewaySessionSeed } from "./gateway-store-conformance";

/** Wraps a SqlClient: counts executed statements and can hold or fail the next one matching a pattern. */
export interface StatementGate {
  count(): number;
  reset(): void;
  /** The next statement whose SQL matches waits; `reached` resolves when it is held. */
  holdNext(pattern: RegExp): { reached: Promise<void>; release(): void };
  /** The next matching statement runs, then its result is held: `reached` = it has read. */
  holdAfter(pattern: RegExp): { reached: Promise<void>; release(): void };
  failNext(pattern: RegExp, error?: Error): void;
}

interface GateSql {
  prepare(query: string): GateStatement;
  batch(statements: unknown[]): Promise<unknown>;
  exec(query: string): Promise<void>;
}
interface GateStatement {
  bind(...values: unknown[]): GateStatement;
  run(): Promise<unknown>;
  first(): Promise<unknown>;
  all(): Promise<unknown>;
}

export function gatedSql<T extends GateSql>(sql: T): { sql: T; gate: StatementGate } {
  let count = 0;
  let holds: Array<{ pattern: RegExp; reached: () => void; released: Promise<void> }> = [];
  let afterHolds: Array<{ pattern: RegExp; reached: () => void; released: Promise<void> }> = [];
  let failures: Array<{ pattern: RegExp; error: Error }> = [];
  const before = async (query: string) => {
    count++;
    const failure = failures.find((candidate) => candidate.pattern.test(query));
    if (failure !== undefined) { failures = failures.filter((candidate) => candidate !== failure); throw failure.error; }
    const hold = holds.find((candidate) => candidate.pattern.test(query));
    if (hold !== undefined) { holds = holds.filter((candidate) => candidate !== hold); hold.reached(); await hold.released; }
  };
  const after = async (query: string) => {
    const hold = afterHolds.find((candidate) => candidate.pattern.test(query));
    if (hold !== undefined) { afterHolds = afterHolds.filter((candidate) => candidate !== hold); hold.reached(); await hold.released; }
  };
  const gated = async <R>(query: string, execute: () => Promise<R>): Promise<R> => {
    await before(query); const result = await execute(); await after(query); return result;
  };
  const wrap = (query: string, statement: GateStatement): GateStatement => ({
    bind: (...values) => wrap(query, statement.bind(...values)),
    run: () => gated(query, () => statement.run()),
    first: () => gated(query, () => statement.first()),
    all: () => gated(query, () => statement.all()),
  });
  const deferred = () => {
    let reached!: () => void; let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    return { reached, reachedPromise, released, release };
  };
  const proxy = Object.create(sql) as T;
  proxy.prepare = ((query: string) => wrap(query, sql.prepare(query))) as T["prepare"];
  return {
    sql: proxy,
    gate: {
      count: () => count,
      reset: () => { count = 0; },
      holdNext(pattern) {
        const d = deferred(); holds.push({ pattern, reached: d.reached, released: d.released });
        return { reached: d.reachedPromise, release: d.release };
      },
      holdAfter(pattern) {
        const d = deferred(); afterHolds.push({ pattern, reached: d.reached, released: d.released });
        return { reached: d.reachedPromise, release: d.release };
      },
      failNext(pattern, error = new Error("database unavailable")) { failures.push({ pattern, error }); },
    },
  };
}

export interface SandboxTokenStoreFixture {
  workspaceId: string;
  /** The adapter under test, over the gated client. */
  store: SandboxTokenStore;
  gate: StatementGate;
  /** The same database, ungated (fixture writes such as a resource detach). */
  raw: GateSql;
  executions: SessionExecutionStorePort;
  seedSession(session: SandboxGatewaySessionSeed & { document?: Record<string, unknown> }): Promise<void>;
  /** Overwrites sandbox_token_hashes (to plant malformed entries). */
  setTokenColumn(executionId: string, value: string | null): Promise<void>;
  archive(sessionId: string, atMs: number): Promise<void>;
}

export interface SandboxTokenStoreTestHarness {
  withStore<T>(fixtureId: string, run: (fixture: SandboxTokenStoreFixture) => Promise<T>): Promise<T>;
}

export const at = (seconds: number) => new Date(Date.UTC(2026, 10, 8, 12, 0, seconds)).toISOString();
export const clock = (seconds: number) => () => Date.parse(at(seconds));
export const sessionIdOf = (fixture: SandboxTokenStoreFixture, name: string) => `${fixture.workspaceId}_${name}`;
export const seed = (id: string, overrides: Partial<SandboxGatewaySessionSeed> = {}): SandboxGatewaySessionSeed => ({
  id, environmentId: `env_${id}`, vaultIds: ["vlt_01"], agent: { id: "agent_01", version: 3 }, archivedAt: null, ...overrides,
});

export async function claim(fixture: SandboxTokenStoreFixture, sessionId: string, attemptId: string, claimedAt: number, leaseTtlMs = 30_000): Promise<SessionExecutionFence> {
  const id = `execution_${sessionId}_${attemptId}`;
  await fixture.executions.admit({
    execution: { id, workspaceId: fixture.workspaceId, sessionId, admittedAt: at(0), events: [{ id, type: "user.message", content: [{ type: "text", text: id }], processedAt: at(0) }] },
  });
  const claimed = await fixture.executions.claim({ workspaceId: fixture.workspaceId, sessionId, ownerId: `owner_${attemptId}`, attemptId, claimedAt: at(claimedAt), leaseTtlMs });
  if (claimed.type !== "claimed") throw new Error(`expected a claim for ${attemptId}`);
  return claimed.fence;
}

export const verify = (store: SandboxTokenStore, sessionId: string, token: string, channel: SandboxTokenChannel, seconds = 2) =>
  authenticateSandboxToken(store, { sessionId, token, channel }, clock(seconds)).then((decision) => decision.type);

export const api = (store: SandboxTokenStore, request: { path: string; method?: string; authorization?: string | null; apiKey?: string | null }, seconds = 2) =>
  authenticateSandboxTokenRequest(store, { method: request.method ?? "POST", path: request.path, authorization: request.authorization ?? null, apiKey: request.apiKey ?? null }, clock(seconds))
    .then((decision) => decision.type);

export const egress = (store: SandboxTokenStore, authorization: string | null, seconds = 2) =>
  authenticateSandboxEgress(store, authorization, { now: clock(seconds) }).then((decision) => decision.type);

export function sandboxTokenStoreConformance(adapterName: string, harness: SandboxTokenStoreTestHarness): void {
  describe(`${adapterName} sandbox token (real SQL)`, () => {
    it("issues into the attempt row and verifies with one statement; issue is findSession + one CAS read + one write", () =>
      harness.withStore("counts", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        f.gate.reset();
        const token = await issueSandboxToken(f.store, fence, { scope: "all", now: clock(2) });
        expect(f.gate.count()).toBe(3);
        f.gate.reset();
        expect(await verify(f.store, id, token, "api")).toBe("accepted");
        expect(f.gate.count()).toBe(1);
      }));

    it("scope: an egress token is refused (401) on the model gateway, MCP gateway and sandbox API, and passes on egress; an all token passes everywhere", () =>
      harness.withStore("scope", async (f) => {
        const egressSession = sessionIdOf(f, "outside"); const allSession = sessionIdOf(f, "inside");
        const document = { resources: [{ type: "file", fileId: "file_01" }, { type: "memory_store", memoryStoreId: "mem_01", access: "read_write" }] };
        await f.seedSession({ ...seed(egressSession), document }); await f.seedSession({ ...seed(allSession), document });
        const egressToken = await issueSandboxToken(f.store, await claim(f, egressSession, "a1", 1), { scope: "egress", now: clock(1) });
        const allToken = await issueSandboxToken(f.store, await claim(f, allSession, "a1", 1), { scope: "all", now: clock(1) });
        const routes = (sessionId: string) => [
          `/v1/oma/inference-proxy/${sessionId}/anthropic/v1/messages`,
          `/v1/oma/mcp-proxy/${sessionId}/server`,
        ];
        for (const path of routes(egressSession)) expect(await api(f.store, { path, authorization: `Bearer ${egressToken}` })).toBe("rejected");
        for (const path of ["/v1/files/file_01", "/v1/memory_stores/mem_01/memories"]) {
          expect(await api(f.store, { path, method: "GET", authorization: sandboxBasicCredential(egressSession, egressToken) })).toBe("rejected");
          expect(await api(f.store, { path, method: "GET", authorization: sandboxBasicCredential(allSession, allToken) })).toBe("accepted");
        }
        expect(await egress(f.store, sandboxBasicCredential(egressSession, egressToken))).toBe("accepted");
        for (const path of routes(allSession)) expect(await api(f.store, { path, authorization: `Bearer ${allToken}` })).toBe("accepted");
        expect(await api(f.store, { path: routes(allSession)[0]!, apiKey: allToken })).toBe("accepted");
        expect(await egress(f.store, sandboxBasicCredential(allSession, allToken))).toBe("accepted");
      }));

    it("scope: a re-sign keeps the attempt's scope; a different scope is refused and both sets stay as they were", () =>
      harness.withStore("resign", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const first = await issueSandboxToken(f.store, fence, { scope: "egress", now: clock(1) });
        const second = await issueSandboxToken(f.store, fence, { scope: "egress", now: clock(2) });
        await expect(issueSandboxToken(f.store, fence, { scope: "all", now: clock(2) })).rejects.toThrow(/scope egress|scope all/);
        for (const token of [first, second]) {
          expect(await verify(f.store, id, token, "egress")).toBe("accepted");
          expect(await verify(f.store, id, token, "api")).toBe("rejected");
        }
        // No default: an issue without a scope never reaches the store.
        await expect(issueSandboxToken(f.store, fence, { scope: undefined as never, now: clock(2) })).rejects.toThrow(/requires a scope/);
      }));

    it.each([
      ["missing scope", (hash: string) => JSON.stringify([{ h: hash }])],
      ["unknown scope", (hash: string) => JSON.stringify([{ h: hash, s: "admin" }])],
      ["bare hash (no entry object)", (hash: string) => JSON.stringify([hash])],
    ] as const)("scope: a stored %s is a definite rejection (401) on every channel", (name, column) =>
      harness.withStore(`bad-scope-${name.split(" ")[0]}`, async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const token = generateSandboxToken();
        await f.setTokenColumn(fence.executionId, column(await sha256Hex(sandboxTokenRandomPart(token)!)));
        expect(await verify(f.store, id, token, "api")).toBe("rejected");
        expect(await verify(f.store, id, token, "egress")).toBe("rejected");
        await expect(issueSandboxToken(f.store, fence, { scope: "all", now: clock(2) })).rejects.toThrow(/scope/);
      }));

    it("Session id travels separately: a token alone, or with another Session's id, is refused", () =>
      harness.withStore("pairing", async (f) => {
        const a = sessionIdOf(f, "a"); const b = sessionIdOf(f, "b");
        await f.seedSession(seed(a)); await f.seedSession(seed(b));
        const tokenA = await issueSandboxToken(f.store, await claim(f, a, "a1", 1), { scope: "all", now: clock(1) });
        await issueSandboxToken(f.store, await claim(f, b, "a1", 1), { scope: "all", now: clock(1) });
        // No Session id on the sandbox API (bearer only): nothing to look up.
        f.gate.reset();
        expect(await api(f.store, { path: "/v1/files/file_01", method: "GET", authorization: `Bearer ${tokenA}` })).toBe("rejected");
        expect(f.gate.count()).toBe(0);
        expect(await api(f.store, { path: `/v1/oma/mcp-proxy/${b}/server`, authorization: `Bearer ${tokenA}` })).toBe("rejected");
        expect(await egress(f.store, sandboxBasicCredential(b, tokenA))).toBe("rejected");
        expect(await api(f.store, { path: `/v1/oma/mcp-proxy/${a}/server`, authorization: sandboxBasicCredential(b, tokenA) })).toBe("rejected");
      }));

    it("checksum: a one-character change is refused with no database read", () =>
      harness.withStore("checksum", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const token = await issueSandboxToken(f.store, await claim(f, id, "a1", 1), { scope: "all", now: clock(1) });
        const index = 20; const flipped = token.slice(0, index) + (token[index] === "a" ? "b" : "a") + token.slice(index + 1);
        f.gate.reset();
        expect(await verify(f.store, id, flipped, "api")).toBe("rejected");
        expect(await egress(f.store, sandboxBasicCredential(id, flipped))).toBe("rejected");
        expect(await api(f.store, { path: `/v1/oma/mcp-proxy/${id}/server`, authorization: `Bearer ${flipped}` })).toBe("rejected");
        expect(f.gate.count()).toBe(0);
      }));

    it("ends with the attempt: settle, take-over and archive each refuse the next request; an expired lease too", () =>
      harness.withStore("lifecycle", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const first = await claim(f, id, "a1", 1, 5_000);
        const old = await issueSandboxToken(f.store, first, { scope: "all", now: clock(1) });
        expect(await verify(f.store, id, old, "api", 7)).toBe("rejected"); // lease expired, not yet taken over
        const second = await f.executions.claim({ workspaceId: f.workspaceId, sessionId: id, ownerId: "owner_a2", attemptId: "a2", claimedAt: at(8), leaseTtlMs: 30_000 });
        if (second.type !== "claimed") throw new Error("expected take-over");
        expect(await verify(f.store, id, old, "egress", 9)).toBe("rejected"); // take-over reset the set
        const current = await issueSandboxToken(f.store, second.fence, { scope: "all", now: clock(9) });
        expect(await verify(f.store, id, current, "api", 9)).toBe("accepted");
        await expect(issueSandboxToken(f.store, first, { scope: "all", now: clock(9) })).rejects.toThrow(/stale/);
        await f.archive(id, Date.parse(at(10)));
        expect(await verify(f.store, id, current, "api", 10)).toBe("rejected");
        await f.executions.settle({ fence: second.fence, settledAt: at(11), outcome: "completed" });
        expect(await verify(f.store, id, current, "egress", 11)).toBe("rejected");
      }));

    it("race: settle commits while a re-sign holds its CAS write — the write misses, the re-sign is stale, no token is left", () =>
      harness.withStore("race-settle-append", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const kept = await issueSandboxToken(f.store, fence, { scope: "all", now: clock(1) });
        const held = f.gate.holdNext(/UPDATE managed_session_executions SET sandbox_token_hashes/u);
        const resign = issueSandboxToken(f.store, fence, { scope: "all", now: clock(2) });
        await held.reached;
        await f.executions.settle({ fence, settledAt: at(3), outcome: "completed" });
        held.release();
        await expect(resign).rejects.toThrow(/stale/);
        expect(await verify(f.store, id, kept, "egress", 3)).toBe("rejected");
      }));

    it("race: two re-signs interleave on one attempt — CAS keeps both hashes, both with the attempt's scope", () =>
      harness.withStore("race-append-append", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const held = f.gate.holdNext(/UPDATE managed_session_executions SET sandbox_token_hashes/u);
        const slow = issueSandboxToken(f.store, fence, { scope: "egress", now: clock(2) });
        await held.reached;
        const fast = await issueSandboxToken(f.store, fence, { scope: "egress", now: clock(2) });
        held.release();
        const slowToken = await slow;
        for (const token of [fast, slowToken]) {
          expect(await verify(f.store, id, token, "egress")).toBe("accepted");
          expect(await verify(f.store, id, token, "api")).toBe("rejected");
        }
      }));

    it("race: the scope is read in the same statement as the settle / lease state — one read decides hash, lease and scope", () =>
      harness.withStore("race-scope-settle", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const token = await issueSandboxToken(f.store, fence, { scope: "egress", now: clock(1) });
        // A verify holding its one read sees the row as of that read: settle
        // committed before the read is seen, and no second read exists in
        // which the scope or the state could differ.
        const held = f.gate.holdNext(/FROM managed_sessions s/u);
        f.gate.reset();
        const pending = verify(f.store, id, token, "egress");
        await held.reached;
        await f.executions.settle({ fence, settledAt: at(2), outcome: "completed" });
        held.release();
        expect(await pending).toBe("rejected");
        expect(f.gate.count()).toBe(1);
      }));

    it("race: a verify whose read commits before settle is accepted, and the next one is refused (linearized at the read)", () =>
      harness.withStore("race-verify-first", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const token = await issueSandboxToken(f.store, fence, { scope: "all", now: clock(1) });
        expect(await verify(f.store, id, token, "api")).toBe("accepted");
        await f.executions.settle({ fence, settledAt: at(2), outcome: "completed" });
        expect(await verify(f.store, id, token, "api")).toBe("rejected");
      }));

    it("a database error is unavailable (503), never a rejection", () =>
      harness.withStore("unavailable", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const token = await issueSandboxToken(f.store, await claim(f, id, "a1", 1), { scope: "all", now: clock(1) });
        f.gate.failNext(/FROM managed_sessions s/u);
        expect(await egress(f.store, sandboxBasicCredential(id, token))).toBe("unavailable");
        f.gate.failNext(/FROM managed_sessions s/u);
        expect(await api(f.store, { path: `/v1/oma/mcp-proxy/${id}/server`, authorization: `Bearer ${token}` })).toBe("unavailable");
        expect(await egress(f.store, sandboxBasicCredential(id, token))).toBe("accepted");
      }));
  });
}
