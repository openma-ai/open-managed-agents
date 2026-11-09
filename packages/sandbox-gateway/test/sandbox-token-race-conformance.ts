// Race suite for the sandbox token (#561), run by every SandboxTokenStore
// adapter on real SQL beside sandbox-token-store-conformance.ts (workerd D1,
// Node SQLite, PostgreSQL 16, MySQL 8.4). Every interleaving is pinned with
// the statement gate: holdNext = the statement has not run yet; holdAfter =
// it has run and its result is held (the request has passed its read and is
// mid-verification). No sleeps.
//
//   A  re-sign vs an in-flight request (model gateway / egress)
//   B  resource detach / attach vs a sandbox API request

import { describe, expect, it } from "vitest";
import { issueSandboxToken, sandboxBasicCredential } from "../src/index";
import {
  api, claim, clock, egress, seed, sessionIdOf, verify,
  type SandboxTokenStoreFixture, type SandboxTokenStoreTestHarness,
} from "./sandbox-token-store-conformance";

/** The verify read (one statement): Session + running attempt holding the hash. */
const FIND = /FROM managed_sessions s/u;
/** The re-sign's compare-and-set write. */
const APPEND = /UPDATE managed_session_executions SET sandbox_token_hashes/u;

const inference = (sessionId: string) => `/v1/oma/inference-proxy/${sessionId}/anthropic/v1/messages`;

type Resource = { type: "memory_store"; memoryStoreId: string; access: "read_only" | "read_write" };

/** What SessionResources replaceCurrent writes: the Session document's resources. */
async function setResources(f: SandboxTokenStoreFixture, sessionId: string, resources: Resource[]) {
  const row = await f.raw.prepare("SELECT document FROM managed_sessions WHERE workspace_id = ? AND id = ?").bind(f.workspaceId, sessionId).first() as { document: string };
  const document = { ...JSON.parse(row.document), resources };
  await f.raw.prepare("UPDATE managed_sessions SET document = ? WHERE workspace_id = ? AND id = ?").bind(JSON.stringify(document), f.workspaceId, sessionId).run();
}

export function sandboxTokenRaceConformance(adapterName: string, harness: SandboxTokenStoreTestHarness): void {
  describe(`${adapterName} sandbox token races (real SQL)`, () => {
    // ---- A: re-sign vs in-flight request -------------------------------
    it("A: a request that has passed its read when a re-sign appends succeeds; old and new tokens both stay valid (model gateway and egress)", () =>
      harness.withStore("race-a-after-read", async (f) => {
        for (const [name, scope, check] of [
          ["gateway", "all", (id: string, token: string) => api(f.store, { path: inference(id), authorization: `Bearer ${token}` })],
          ["egress", "egress", (id: string, token: string) => egress(f.store, sandboxBasicCredential(id, token))],
        ] as const) {
          const id = sessionIdOf(f, name); await f.seedSession(seed(id));
          const fence = await claim(f, id, "a1", 1);
          const old = await issueSandboxToken(f.store, fence, { scope, now: clock(1) });
          const held = f.gate.holdAfter(FIND);
          const inFlight = check(id, old);
          await held.reached; // read done, decision not yet returned
          const fresh = await issueSandboxToken(f.store, fence, { scope, now: clock(2) });
          held.release();
          expect(await inFlight).toBe("accepted");
          expect(await check(id, old)).toBe("accepted");
          expect(await check(id, fresh)).toBe("accepted");
        }
      }));

    it("A: a request whose read runs after the append commits still finds the old token in the grown set", () =>
      harness.withStore("race-a-before-read", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const old = await issueSandboxToken(f.store, fence, { scope: "egress", now: clock(1) });
        const held = f.gate.holdNext(FIND);
        const inFlight = egress(f.store, sandboxBasicCredential(id, old));
        await held.reached; // request arrived, its read not yet run
        const fresh = await issueSandboxToken(f.store, fence, { scope: "egress", now: clock(2) });
        held.release();
        expect(await inFlight).toBe("accepted");
        expect(await egress(f.store, sandboxBasicCredential(id, fresh))).toBe("accepted");
      }));

    it("A: requests verified while the re-sign holds its CAS write are accepted, then both tokens are", () =>
      harness.withStore("race-a-during-write", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const old = await issueSandboxToken(f.store, fence, { scope: "all", now: clock(1) });
        const held = f.gate.holdNext(APPEND);
        const resign = issueSandboxToken(f.store, fence, { scope: "all", now: clock(2) });
        await held.reached;
        expect(await api(f.store, { path: inference(id), authorization: `Bearer ${old}` })).toBe("accepted");
        expect(await verify(f.store, id, old, "egress")).toBe("accepted");
        held.release();
        const fresh = await resign;
        for (const token of [old, fresh]) expect(await api(f.store, { path: inference(id), apiKey: token })).toBe("accepted");
      }));

    // ---- B: resource detach / attach vs request ------------------------
    it("B: a memory store detached while a sandbox API request holds its read: that request is decided by its read, the next is refused", () =>
      harness.withStore("race-b-detach", async (f) => {
        const id = sessionIdOf(f, "s");
        await f.seedSession({ ...seed(id), document: { resources: [{ type: "memory_store", memoryStoreId: "mem_01", access: "read_write" }] } });
        const token = await issueSandboxToken(f.store, await claim(f, id, "a1", 1), { scope: "all", now: clock(1) });
        const request = () => api(f.store, { path: "/v1/memory_stores/mem_01/memories", method: "GET", authorization: sandboxBasicCredential(id, token) });
        // 1. read before the detach (held after it ran): linearized at the read.
        const readFirst = f.gate.holdAfter(FIND);
        const before = request();
        await readFirst.reached;
        await setResources(f, id, []);
        readFirst.release();
        expect(await before).toBe("accepted");
        expect(await request()).toBe("rejected");
        // 2. detach committed while the request waits for its read: refused.
        await setResources(f, id, [{ type: "memory_store", memoryStoreId: "mem_01", access: "read_write" }]);
        const readLate = f.gate.holdNext(FIND);
        const after = request();
        await readLate.reached;
        await setResources(f, id, []);
        readLate.release();
        expect(await after).toBe("rejected");
      }));

    it("B: a memory store attached mid-execution is usable with the same token (no re-sign); access changes apply on the next request", () =>
      harness.withStore("race-b-attach", async (f) => {
        const id = sessionIdOf(f, "s"); await f.seedSession(seed(id));
        const fence = await claim(f, id, "a1", 1);
        const token = await issueSandboxToken(f.store, fence, { scope: "all", now: clock(1) });
        const call = (method: string) => api(f.store, { path: "/v1/memory_stores/mem_02/memories", method, authorization: sandboxBasicCredential(id, token) });
        expect(await call("GET")).toBe("rejected");
        await setResources(f, id, [{ type: "memory_store", memoryStoreId: "mem_02", access: "read_only" }]);
        expect(await call("GET")).toBe("accepted");
        expect(await call("POST")).toBe("rejected");
        await setResources(f, id, [{ type: "memory_store", memoryStoreId: "mem_02", access: "read_write" }]);
        expect(await call("POST")).toBe("accepted");
        // Still one token on the attempt: nothing was re-issued.
        const row = await f.raw.prepare("SELECT sandbox_token_hashes FROM managed_session_executions WHERE workspace_id = ? AND id = ?").bind(f.workspaceId, fence.executionId).first() as { sandbox_token_hashes: string };
        expect(JSON.parse(row.sandbox_token_hashes)).toHaveLength(1);
      }));
  });
}
