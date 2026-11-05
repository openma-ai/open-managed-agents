// @ts-nocheck
//
// Integration tests for the multi-tenant CLI bridge daemon — step 2.
//
// Covers:
//   1. authenticateRuntimeToken returns `authorized_tenants` Set populated
//      from runtime_tenants (regression on step 1).
//   2. POST /agents/runtime/:id/refresh:
//        - add path: user gains tenant membership → /refresh returns it in
//          `added` + an `agent_api_key` plaintext for the new row.
//        - revoke path: membership removed → row's revoked_at flipped, KV
//          cleaned up, response says `revoked`.
//        - no-op (stable membership): all live tenants returned with fresh
//          rotated keys (always-rotate policy documented in route comment),
//          neither `added` nor `revoked` populated.
//        - cross-runtime guard: token bound to runtime A → /refresh on B 404s.
//   3. RuntimeRoom tenant_id validation (additive, non-enforcing):
//        - daemon-side inbound: tenant_id in authorized set + matching
//          session pin → forwarded; not-in-set → dropped silently.
//        - v1 daemon (absent tenant_id) → message flows unchanged.
//        - harness-side outbound: x-harness-tenant header → forwarded
//          tenant_id injected on session.start/.prompt.
//   4. GET /agents/runtime/me — daemon-facing alternative to the absent
//      /v1/oma/runtimes/:id, used by daemon-side v1→v2 migration.
//   5. GET /v1/oma/runtimes — workspace API key: user-bound list,
//      single-user fallback, multi-user 401, foreign runtime hidden.

import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// One-shot per-test setup: clean + seed AUTH_DB rows for a fresh runtime
// with the given memberships, mint a runtime_token, return the bearer.
async function seedRuntime(opts: {
  runtimeId: string;
  userId: string;
  ownerTenantId: string;
  memberships: Array<{ tenant_id: string; role: string; name?: string }>;
}): Promise<{ tokenPlain: string }> {
  const { runtimeId, userId, ownerTenantId, memberships } = opts;
  const now = Math.floor(Date.now() / 1000);

  // Ensure tenants exist (FK-less — schema just needs the rows for the
  // /me + /refresh join with tenant.name).
  for (const m of memberships) {
    await env.AUTH_DB
      .prepare(
        `INSERT OR IGNORE INTO "tenant" (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
      )
      .bind(m.tenant_id, m.name ?? m.tenant_id, now * 1000, now * 1000)
      .run();
  }

  // user row — better-auth schema. Tenant pinned to the owner tenant.
  await env.AUTH_DB
    .prepare(
      `INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, tenantId, role, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, "Test User", `${userId}@test.local`, 1, ownerTenantId, "owner", now * 1000, now * 1000)
    .run();

  // memberships rows
  for (const m of memberships) {
    await env.AUTH_DB
      .prepare(
        `INSERT OR REPLACE INTO "membership" (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(userId, m.tenant_id, m.role, now)
      .run();
  }

  // runtimes row
  await env.AUTH_DB
    .prepare(
      `INSERT OR REPLACE INTO "runtimes"
        (id, owner_user_id, owner_tenant_id, machine_id, hostname, os, agents_json, version, status, last_heartbeat, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'offline', NULL, ?)`,
    )
    .bind(runtimeId, userId, ownerTenantId, `machine-${runtimeId}`, "test-host", "darwin", "0.0.1-test", now)
    .run();

  // backfill runtime_tenants like migration 0018 would
  for (const m of memberships) {
    await env.AUTH_DB
      .prepare(
        `INSERT OR IGNORE INTO "runtime_tenants" (runtime_id, tenant_id, agent_api_key_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(runtimeId, m.tenant_id, "__legacy__", now)
      .run();
  }

  // runtime_token
  const tokenPlain = `sk_machine_${runtimeId}_token_${Math.random().toString(36).slice(2)}`;
  const tokenHash = await sha256Hex(tokenPlain);
  await env.AUTH_DB
    .prepare(
      `INSERT INTO "runtime_tokens" (id, runtime_id, token_hash, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(`tok_${runtimeId}_${Math.random().toString(36).slice(2)}`, runtimeId, tokenHash, userId, now)
    .run();

  return { tokenPlain };
}

describe("/agents/runtime/* — multi-tenant CLI bridge daemon (step 2)", () => {
  // ensureMigrations runs lazily on first fetch() into the worker — touch a
  // public endpoint so the AUTH_DB schema is in place before our seedRuntime
  // helper starts INSERTing into tables migrations create.
  beforeAll(async () => {
    await api("/health").catch(() => {});
  });

  describe("authenticateRuntimeToken (regression: still returns authorized_tenants)", () => {
    it("hits /me which depends on the function — exercises the join", async () => {
      const rid = `rt_auth_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_a",
        memberships: [
          { tenant_id: "tn_a", role: "owner", name: "Workspace A" },
          { tenant_id: "tn_b", role: "member", name: "Workspace B" },
        ],
      });
      const res = await api("/agents/runtime/me", {
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.tenants.map((t: { id: string }) => t.id).sort();
      expect(ids).toEqual(["tn_a", "tn_b"]);
      // Tenant names join in
      const a = body.tenants.find((t: { id: string }) => t.id === "tn_a");
      expect(a.name).toBe("Workspace A");
      expect(a.role).toBe("owner");
    });

    it("/me rejects bogus token", async () => {
      const res = await api("/agents/runtime/me", {
        headers: { authorization: "Bearer sk_machine_garbage" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /:id/refresh", () => {
    it("add path: new membership becomes a fresh runtime_tenants row with plaintext key", async () => {
      const rid = `rt_add_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_add_a",
        memberships: [{ tenant_id: "tn_add_a", role: "owner" }],
      });

      // Add second membership directly to DB (simulating user joining tenant B
      // via the console).
      await env.AUTH_DB
        .prepare(
          `INSERT INTO "tenant" (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
        )
        .bind("tn_add_b", "Workspace B", Date.now(), Date.now())
        .run();
      await env.AUTH_DB
        .prepare(
          `INSERT INTO "membership" (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(uid, "tn_add_b", "member", Math.floor(Date.now() / 1000))
        .run();

      const res = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.added).toEqual(["tn_add_b"]);
      expect(body.revoked).toEqual([]);
      const newRow = body.tenants.find((t: { id: string }) => t.id === "tn_add_b");
      expect(newRow).toBeTruthy();
      expect(typeof newRow.agent_api_key).toBe("string");
      expect(newRow.agent_api_key.startsWith("oma_")).toBe(true);

      // KV row + index updated
      const hash = await sha256Hex(newRow.agent_api_key);
      const kvRow = await env.CONFIG_KV.get(`apikey:${hash}`);
      expect(kvRow).toBeTruthy();
      const parsed = JSON.parse(kvRow!);
      expect(parsed.tenant_id).toBe("tn_add_b");
    });

    it("revoke path: removed membership flips revoked_at + deletes KV row", async () => {
      const rid = `rt_rev_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_rev_a",
        memberships: [
          { tenant_id: "tn_rev_a", role: "owner" },
          { tenant_id: "tn_rev_b", role: "member" },
        ],
      });

      // First refresh promotes the __legacy__ rows to real ids w/ KV entries.
      const r1 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      const body1 = await r1.json();
      const revBKey = body1.tenants.find((t: { id: string }) => t.id === "tn_rev_b").agent_api_key;
      const revBHash = await sha256Hex(revBKey);
      expect(await env.CONFIG_KV.get(`apikey:${revBHash}`)).toBeTruthy();

      // Now remove the tn_rev_b membership.
      await env.AUTH_DB
        .prepare(`DELETE FROM "membership" WHERE user_id = ? AND tenant_id = ?`)
        .bind(uid, "tn_rev_b")
        .run();

      const r2 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      expect(r2.status).toBe(200);
      const body2 = await r2.json();
      expect(body2.revoked).toEqual(["tn_rev_b"]);
      expect(body2.tenants.map((t: { id: string }) => t.id)).toEqual(["tn_rev_a"]);

      // runtime_tenants row soft-deleted
      const row = await env.AUTH_DB
        .prepare(
          `SELECT revoked_at FROM "runtime_tenants" WHERE runtime_id = ? AND tenant_id = ?`,
        )
        .bind(rid, "tn_rev_b")
        .first<{ revoked_at: number | null }>();
      expect(row!.revoked_at).not.toBeNull();

      // KV row gone
      expect(await env.CONFIG_KV.get(`apikey:${revBHash}`)).toBeNull();
    });

    it("no-op: stable membership returns rotated keys for every live tenant", async () => {
      const rid = `rt_noop_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      const { tokenPlain } = await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: "tn_noop_a",
        memberships: [{ tenant_id: "tn_noop_a", role: "owner" }],
      });
      const r1 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      const body1 = await r1.json();
      expect(body1.added).toEqual([]);
      expect(body1.revoked).toEqual([]);
      const firstKey = body1.tenants[0].agent_api_key;

      const r2 = await api(`/agents/runtime/${rid}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenPlain}` },
      });
      const body2 = await r2.json();
      expect(body2.added).toEqual([]);
      expect(body2.revoked).toEqual([]);
      // Always-rotate policy: second call mints a fresh key (different
      // plaintext, old hash gone).
      expect(body2.tenants[0].agent_api_key).not.toBe(firstKey);
      const firstHash = await sha256Hex(firstKey);
      expect(await env.CONFIG_KV.get(`apikey:${firstHash}`)).toBeNull();
    });

    it("cross-runtime guard: token of runtime A → /refresh on B → 404", async () => {
      const ridA = `rt_xa_${Math.random().toString(36).slice(2, 8)}`;
      const ridB = `rt_xb_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${ridA}_${ridB}`;
      const { tokenPlain: tokA } = await seedRuntime({
        runtimeId: ridA,
        userId: uid,
        ownerTenantId: "tn_xa",
        memberships: [{ tenant_id: "tn_xa", role: "owner" }],
      });
      await seedRuntime({
        runtimeId: ridB,
        userId: uid,
        ownerTenantId: "tn_xa",
        memberships: [{ tenant_id: "tn_xa", role: "owner" }],
      });
      const res = await api(`/agents/runtime/${ridB}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokA}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("RuntimeRoom — accept + validate tenant_id (additive, non-enforcing)", () => {
    // Drives the DO directly via runInDurableObject so we can poke at private
    // state. We don't open real WS attaches here — DO message handling has
    // enough surface area to test through public hooks (sendToDaemon and
    // refreshAuthorizedTenants RPCs).

    async function freshRoom(memberships: string[]) {
      const rid = `rt_ws_${Math.random().toString(36).slice(2, 8)}`;
      const uid = `u_${rid}`;
      await seedRuntime({
        runtimeId: rid,
        userId: uid,
        ownerTenantId: memberships[0] ?? "tn_default",
        memberships: memberships.map((t) => ({ tenant_id: t, role: "owner" })),
      });
      const stub = env.RUNTIME_ROOM.get(env.RUNTIME_ROOM.idFromName(rid));
      // Seed runtimeId + userId on the DO (normally set by attachDaemon) so
      // ensureAuthorizedTenants knows what to look up. Also prime the
      // authorized-tenants cache for predictable behavior.
      await runInDurableObject(stub, async (instance, _state) => {
        (instance as { runtimeId: string }).runtimeId = rid;
        (instance as { userId: string }).userId = uid;
        await _state.storage.put("runtime_id", rid);
        await _state.storage.put("user_id", uid);
        await (instance as { refreshAuthorizedTenants(): Promise<void> }).refreshAuthorizedTenants();
      });
      return { stub, runtimeId: rid, userId: uid };
    }

    // Accept the client socket and wait until the DO has finished
    // webSocketClose. Dropping the upgrade Response leaves the server socket
    // alive until the vitest worker tears the file down; that close logs
    // "harness closed" via console.log, and the onUserConsoleLog RPC is still
    // pending when the worker closes.
    async function attachHarnessClient(stub, sessionId: string, tenantId: string) {
      const response = await stub.fetch(new Request("http://runtime-room/_attach_harness", {
        headers: {
          Upgrade: "websocket",
          "x-attach-role": "harness",
          "x-session-id": sessionId,
          "x-harness-tenant": tenantId,
        },
      }));
      return response;
    }

    async function releaseHarnessSocket(stub, response, sessionId: string) {
      const socket = response.webSocket;
      if (!socket) throw new Error("harness attach did not return a websocket");
      // workerd reports the client socket OPEN before accept(), and close()
      // sends a frame, so accept() has to run first. A second accept() throws.
      try {
        socket.accept();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already accepted/i.test(message)) throw error;
      }
      if (socket.readyState !== WebSocket.CLOSED) socket.close(1000, "test finished");
      await vi.waitFor(async () => {
        let open = -1;
        await runInDurableObject(stub, async (instance) => {
          open = instance.ctx.getWebSockets(`harness:${sessionId}`).length;
        });
        expect(open).toBe(0);
      });
    }

    // The 101 client socket is an I/O object owned by the DO that created it.
    // Reading response.webSocket after runInDurableObject returns throws
    // "Cannot perform I/O on behalf of a different Durable Object", so
    // accept/close has to happen inside that callback. The wait runs in a
    // later callback, after the test's getWebSockets stub is gone.
    function closeOwnedSocket(response) {
      const socket = response?.webSocket;
      if (!socket) throw new Error("attach did not return a websocket");
      try {
        socket.accept();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already accepted/i.test(message)) throw error;
      }
      if (socket.readyState !== WebSocket.CLOSED) socket.close(1000, "test finished");
    }

    async function waitUntilNoDaemonSockets(stub) {
      // webSocketClose runs on client close (it logs daemon_close and calls
      // markOffline) while getWebSockets() can still list the hibernated
      // socket. Wait until none of those sockets are still open.
      await vi.waitFor(async () => {
        let open = -1;
        await runInDurableObject(stub, async (instance) => {
          open = instance.ctx.getWebSockets("daemon").filter((socket) =>
            socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN,
          ).length;
        });
        expect(open).toBe(0);
      });
    }

    it("persists ordered runner output before acknowledging and deduplicates reconnect replay", async () => {
      const { stub } = await freshRoom(["tn_delivery", "tn_other"]);
      await runInDurableObject(stub, async (room, state) => {
        const forwarded: any[] = [];
        const receipts: any[] = [];
        const broadcast = room.broadcastToHarness;
        room.broadcastToHarness = (_sid, frame) => forwarded.push(frame);
        const socket = { send: (text: string) => {
          const ack = JSON.parse(text);
          if (ack.type === "session.ack") {
            // A receipt may only cover frames already durable in this DO.
            const saved = state.storage.sql.exec("SELECT seq FROM runtime_delivery_frames WHERE stream = ? ORDER BY seq", ack.delivery.stream_id).toArray();
            expect(saved.map((row) => row.seq)).toContain(ack.delivery.seq);
          }
          receipts.push(ack);
        } };
        const base = { session_id: "durable-session", tenant_id: "tn_delivery", turn_id: "original-turn" };
        const frame = (seq: number, type = "session.event") => ({ ...base, type,
          ...(type === "session.event" ? { event: { type: "output", text: String(seq) } } : {}),
          delivery: { stream_id: "durable-stream", seq },
        });
        try {
          await room.onDaemonMessage(socket, frame(2));
          expect(forwarded).toEqual([]);
          expect(receipts.filter((r) => r.type === "session.ack")).toEqual([]);
          await room.onDaemonMessage(socket, frame(1));
          expect(forwarded).toEqual([frame(1), frame(2)]);
          expect(receipts.at(-1)).toEqual({ type: "session.ack", session_id: base.session_id, tenant_id: base.tenant_id, delivery: { stream_id: "durable-stream", seq: 2 } });
          await room.onDaemonMessage(socket, frame(1));
          expect(forwarded).toHaveLength(2);
          const beforeInvalid = receipts.length;
          await room.onDaemonMessage(socket, { ...frame(3), tenant_id: "unauthorized" });
          await room.onDaemonMessage(socket, { ...frame(3), tenant_id: "tn_other" });
          await room.onDaemonMessage(socket, { ...frame(3), session_id: "other-session" });
          expect(receipts).toHaveLength(beforeInvalid);
          await room.onDaemonMessage(socket, frame(3, "session.complete"));
          expect(forwarded).toEqual([frame(1), frame(2), frame(3, "session.complete")]);
          // Recreate the helper from durable storage, as after DO hibernation.
          room.deliveryLog = undefined;
          await room.onDaemonMessage(socket, frame(3, "session.complete"));
          expect(forwarded).toHaveLength(3);
          expect(receipts.at(-1).delivery.seq).toBe(3);
        } finally { room.broadcastToHarness = broadcast; }
      });
    });

    it("replays only the requested turn beyond its cursor on a new harness socket", async () => {
      const { stub } = await freshRoom(["tn_replay", "tn_wrong_replay"]);
      await runInDurableObject(stub, async (room) => {
        const base = { session_id: "replay-session", tenant_id: "tn_replay" };
        for (const [seq, turn_id, type] of [[1, "earlier", "session.event"], [2, "current", "session.event"], [3, "side", "session.event"], [4, "current", "session.event"], [5, "current", "session.complete"]]) {
          await room.onDaemonMessage({ send() {} }, { ...base, type, turn_id, ...(type === "session.event" ? { event: { text: `part-${seq}` } } : {}), delivery: { stream_id: "replay-stream", seq } });
        }
      });
      const response = await stub.fetch(new Request("http://runtime-room/_attach_harness", { headers: {
        Upgrade: "websocket", "x-attach-role": "harness", "x-session-id": "replay-session", "x-harness-tenant": "tn_replay",
        "x-runtime-replay": JSON.stringify({ turn_id: "current", after: { "replay-stream": 2 } }),
      } }));
      expect(response.status).toBe(101);
      const frames: any[] = [];
      response.webSocket.addEventListener("message", (event) => { frames.push(JSON.parse(event.data)); });
      response.webSocket.accept();
      try {
        await vi.waitFor(() => expect(frames.filter((frame) => frame.delivery).map((frame) => frame.delivery.seq)).toEqual([4, 5]), { timeout: 1000 });
        expect(frames[0]).toMatchObject({ type: "attached", capabilities: ["durable_session_events_v1"] });
      } finally {
        await releaseHarnessSocket(stub, response, "replay-session");
      }
      // The pin belongs to the task, and must survive closing its observer.
      const wrong = await stub.fetch(new Request("http://runtime-room/_attach_harness", { headers: {
        Upgrade: "websocket", "x-attach-role": "harness", "x-session-id": "replay-session", "x-harness-tenant": "tn_wrong_replay",
        "x-runtime-replay": JSON.stringify({ turn_id: "current", after: {} }),
      } }));
      expect(wrong.status).toBe(403);
    });

    it("evicts a daemon socket whose server-observed heartbeat lease expired", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_stale"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000) - 300, runtimeId)
        .run();

      let staleSocketClosed = false;
      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: { getWebSockets(tag?: string): WebSocket[] };
          attachDaemon(request: Request): Promise<Response>;
        };
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const staleSocket = {
          send() {},
          close() { staleSocketClosed = true; },
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [staleSocket] : originalGetWebSockets(tag);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );

        expect(response.status).toBe(101);
        closeOwnedSocket(response);
      });
      expect(staleSocketClosed).toBe(true);
      await waitUntilNoDaemonSockets(stub);
    });

    it("keeps the current daemon while its server-observed lease is fresh", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_fresh"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET status = 'online', last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000), runtimeId)
        .run();

      let currentSocketClosed = false;
      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: { getWebSockets(tag?: string): WebSocket[] };
          attachDaemon(request: Request): Promise<Response>;
        };
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const currentSocket = {
          send() {},
          close() { currentSocketClosed = true; },
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [currentSocket] : originalGetWebSockets(tag);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );

        expect(response.status).toBe(409);
      });
      expect(currentSocketClosed).toBe(false);
    });

    it("evicts a daemon already marked offline even when its last heartbeat is recent", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_offline"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET status = 'offline', last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000), runtimeId)
        .run();

      let offlineSocketClosed = false;
      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: { getWebSockets(tag?: string): WebSocket[] };
          attachDaemon(request: Request): Promise<Response>;
        };
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const offlineSocket = {
          send() {},
          close() { offlineSocketClosed = true; },
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [offlineSocket] : originalGetWebSockets(tag);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );

        expect(response.status).toBe(101);
        closeOwnedSocket(response);
      });
      expect(offlineSocketClosed).toBe(true);
      await waitUntilNoDaemonSockets(stub);
    });

    it("does not let an evicted daemon close mark its replacement offline", async () => {
      const { stub, runtimeId, userId } = await freshRoom(["tn_ws_fenced"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET last_heartbeat = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000) - 300, runtimeId)
        .run();

      await runInDurableObject(stub, async (instance) => {
        const room = instance as unknown as {
          ctx: {
            getTags(socket: WebSocket): string[];
            getWebSockets(tag?: string): WebSocket[];
          };
          attachDaemon(request: Request): Promise<Response>;
          webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        const staleSocket = {
          send() {},
          close() {},
        } as unknown as WebSocket;
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [staleSocket] : originalGetWebSockets(tag);
        room.ctx.getTags = (socket: WebSocket) =>
          socket === staleSocket ? ["daemon"] : originalGetTags(socket);

        const response = await room.attachDaemon(
          new Request("http://runtime-room/_attach_daemon", {
            headers: {
              Upgrade: "websocket",
              "x-runtime-id": runtimeId,
              "x-runtime-user": userId,
            },
          }),
        );
        expect(response.status).toBe(101);

        await room.webSocketClose(staleSocket, 1012, "lease expired");
        const row = await env.AUTH_DB
          .prepare(`SELECT status FROM "runtimes" WHERE id = ?`)
          .bind(runtimeId)
          .first();
        expect(row?.status).toBe("online");
        // Closing the replacement runs markOffline. That has to happen after
        // the assertion, and it has to happen here: the client socket cannot
        // leave this Durable Object.
        closeOwnedSocket(response);
      });
      await waitUntilNoDaemonSockets(stub);
    });

    it("drops messages from a daemon that no longer owns the room", async () => {
      const { stub } = await freshRoom(["tn_ws_owner"]);
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_old_owner_${Math.random().toString(36).slice(2, 6)}`;
        const staleSocket = {} as WebSocket;
        const room = instance as unknown as {
          ctx: { getTags(socket: WebSocket): string[] };
          webSocketMessage(socket: WebSocket, message: string): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        room.ctx.getTags = (socket: WebSocket) =>
          socket === staleSocket
            ? ["daemon", "daemon-owner:owner_old"]
            : originalGetTags(socket);
        await state.storage.put("active_daemon_owner", "owner_new");

        await room.webSocketMessage(
          staleSocket,
          JSON.stringify({
            type: "session.ready",
            session_id: sid,
            tenant_id: "tn_ws_owner",
            acp_session_id: "acp-from-stale-owner",
          }),
        );

        expect(await state.storage.get(`session_state:${sid}`)).toBeUndefined();
      });
    });

    it("does not let an evicted daemon error mark the active owner offline", async () => {
      const { stub, runtimeId } = await freshRoom(["tn_ws_error_fence"]);
      await env.AUTH_DB
        .prepare(`UPDATE "runtimes" SET status = 'online' WHERE id = ?`)
        .bind(runtimeId)
        .run();

      await runInDurableObject(stub, async (instance, state) => {
        const staleSocket = { close() {} } as unknown as WebSocket;
        const room = instance as unknown as {
          ctx: { getTags(socket: WebSocket): string[] };
          webSocketError(socket: WebSocket, error: unknown): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        room.ctx.getTags = (socket: WebSocket) =>
          socket === staleSocket
            ? ["daemon", "daemon-owner:owner_old"]
            : originalGetTags(socket);
        await state.storage.put("active_daemon_owner", "owner_new");

        await room.webSocketError(staleSocket, new Error("late socket error"));
      });

      const row = await env.AUTH_DB
        .prepare(`SELECT status FROM "runtimes" WHERE id = ?`)
        .bind(runtimeId)
        .first<{ status: string }>();
      expect(row?.status).toBe("online");
    });

    it("routes harness commands only to the active daemon owner", async () => {
      const { stub } = await freshRoom(["tn_ws_route_owner"]);
      await runInDurableObject(stub, async (instance, state) => {
        const oldMessages: string[] = [];
        const newMessages: string[] = [];
        const oldSocket = { send: (message: string) => oldMessages.push(message) } as unknown as WebSocket;
        const newSocket = { send: (message: string) => newMessages.push(message) } as unknown as WebSocket;
        const room = instance as unknown as {
          ctx: {
            getTags(socket: WebSocket): string[];
            getWebSockets(tag?: string): WebSocket[];
          };
          onHarnessMessage(sessionId: string, message: Record<string, unknown>): Promise<void>;
        };
        const originalGetTags = room.ctx.getTags.bind(room.ctx);
        const originalGetWebSockets = room.ctx.getWebSockets.bind(room.ctx);
        room.ctx.getWebSockets = (tag?: string) =>
          tag === "daemon" ? [oldSocket, newSocket] : originalGetWebSockets(tag);
        room.ctx.getTags = (socket: WebSocket) => {
          if (socket === oldSocket) return ["daemon", "daemon-owner:owner_old"];
          if (socket === newSocket) return ["daemon", "daemon-owner:owner_new"];
          return originalGetTags(socket);
        };
        await state.storage.put("active_daemon_owner", "owner_new");

        await room.onHarnessMessage("sess_route_owner", {
          type: "session.prompt",
          turn_id: "turn_route_owner",
          text: "route to current owner",
        });

        expect(oldMessages).toEqual([]);
        expect(newMessages).toHaveLength(1);
      });
    });

    it("refreshAuthorizedTenants RPC: revoking a row mid-life → next inbound msg for that tenant drops", async () => {
      const { stub, runtimeId } = await freshRoom(["tn_rpc_a", "tn_rpc_b"]);
      // Before revoke: both tenants accepted.
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_rpc_pre_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, tenant_id: "tn_rpc_b", acp_session_id: "acp-pre" },
        );
        expect(await state.storage.get(`session_state:${sid}`)).toBeTruthy();
      });

      // Revoke tn_rpc_b directly in DB (mimics what /refresh does internally)
      // then fire the RPC the route handler would fire.
      await env.AUTH_DB
        .prepare(
          `UPDATE "runtime_tenants" SET revoked_at = ? WHERE runtime_id = ? AND tenant_id = ?`,
        )
        .bind(Math.floor(Date.now() / 1000), runtimeId, "tn_rpc_b")
        .run();
      await (stub as unknown as { refreshAuthorizedTenants(): Promise<void> })
        .refreshAuthorizedTenants();

      // After revoke: tn_rpc_b drops, tn_rpc_a still flows.
      await runInDurableObject(stub, async (instance, state) => {
        const sidDropped = `sess_rpc_post_drop_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sidDropped, tenant_id: "tn_rpc_b", acp_session_id: "acp-post" },
        );
        expect(await state.storage.get(`session_state:${sidDropped}`)).toBeUndefined();

        const sidOk = `sess_rpc_post_ok_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sidOk, tenant_id: "tn_rpc_a", acp_session_id: "acp-ok" },
        );
        expect(await state.storage.get(`session_state:${sidOk}`)).toBeTruthy();
      });
    });

    it("inbound daemon msg with tenant_id ∉ authorized set → silent drop (no broadcast, no persist)", async () => {
      const { stub, runtimeId } = await freshRoom(["tn_ws_a"]);
      // Simulate the daemon webSocketMessage handler by calling it directly.
      // We don't have a real WS; the DO's onDaemonMessage path is invoked via
      // webSocketMessage with a tagged "daemon" socket. Easier: call the
      // private method via instance access (TypeScript can't see private
      // members at runtime).
      let dropped = true;
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_drop_${Math.random().toString(36).slice(2, 6)}`;
        const before = await state.storage.get(`session_state:${sid}`);
        expect(before).toBeUndefined();

        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, tenant_id: "tn_does_not_belong", acp_session_id: "acp-x" },
        );

        const after = await state.storage.get(`session_state:${sid}`);
        if (after !== undefined) dropped = false;
      });
      expect(dropped).toBe(true);
      void runtimeId;
    });

    it("inbound daemon msg with tenant_id ∈ authorized set → broadcast + persist", async () => {
      const { stub } = await freshRoom(["tn_ws_ok"]);
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_ok_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, tenant_id: "tn_ws_ok", acp_session_id: "acp-y" },
        );
        const after = await state.storage.get(`session_state:${sid}`);
        expect(after).toBeTruthy();
        expect((after as { tenant_id: string }).tenant_id).toBe("tn_ws_ok");
      });
    });

    it("inbound daemon msg without tenant_id (v1 daemon) → flows unchanged", async () => {
      const { stub } = await freshRoom(["tn_ws_v1"]);
      await runInDurableObject(stub, async (instance, state) => {
        const sid = `sess_v1_${Math.random().toString(36).slice(2, 6)}`;
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          { type: "session.ready", session_id: sid, acp_session_id: "acp-v1" },
        );
        const after = await state.storage.get(`session_state:${sid}`);
        expect(after).toBeTruthy();
      });
    });

    it("inbound daemon msg with tenant_id mismatching session pin → silent drop", async () => {
      const { stub } = await freshRoom(["tn_pin_a", "tn_pin_b"]);
      const sid = `sess_pin_${Math.random().toString(36).slice(2, 6)}`;
      // Pin the session by issuing a real attachHarness request — that's the
      // public path that populates #sessionTenant. Close the client before
      // the test returns so webSocketClose logs while this worker is alive.
      const attached = await attachHarnessClient(stub, sid, "tn_pin_a");
      expect(attached.status).toBe(101);
      await releaseHarnessSocket(stub, attached, sid);

      await runInDurableObject(stub, async (instance, state) => {
        await (instance as unknown as {
          onDaemonMessage(ws: unknown, parsed: Record<string, unknown>): Promise<void>;
        }).onDaemonMessage(
          { send: () => {} } as unknown,
          // Daemon claims tenant tn_pin_b for a session pinned to tn_pin_a.
          // Both are in the authorized set, so the first gate would accept;
          // the pin cross-check must drop it.
          { type: "session.ready", session_id: sid, tenant_id: "tn_pin_b", acp_session_id: "acp-mis" },
        );
        const after = await state.storage.get(`session_state:${sid}`);
        expect(after).toBeUndefined();
      });
    });

    it("outbound harness msg: pinned tenant injected into forwarded frame", async () => {
      const { stub } = await freshRoom(["tn_inj"]);
      const sid = `sess_inj_${Math.random().toString(36).slice(2, 6)}`;
      // Public path: real attach with x-harness-tenant → pin populated.
      const attached = await attachHarnessClient(stub, sid, "tn_inj");
      expect(attached.status).toBe(101);
      await releaseHarnessSocket(stub, attached, sid);

      const collected: Array<Record<string, unknown>> = [];
      await runInDurableObject(stub, async (instance) => {
        // Stub out daemon WS lookup — onHarnessMessage early-returns if no
        // daemon ws is registered, so we intercept getWebSockets to inject a
        // fake daemon collector.
        const ctx = (instance as unknown as { ctx: { getWebSockets: (tag: string) => unknown[] } }).ctx;
        const orig = ctx.getWebSockets.bind(ctx);
        ctx.getWebSockets = (tag: string) => {
          if (tag === "daemon") {
            return [{ send: (s: string) => collected.push(JSON.parse(s)) }];
          }
          return orig(tag);
        };

        await (instance as unknown as {
          onHarnessMessage(sid: string, parsed: Record<string, unknown>): Promise<void>;
        }).onHarnessMessage(sid, { type: "session.prompt", turn_id: "t1", text: "hi" });
        await instance.onHarnessMessage(sid, {
          type: "session.response", session_id: "forged-session", tenant_id: "forged-tenant",
          turn_id: "original-turn", request_id: "original-request",
          response: { outcome: { outcome: "selected", optionId: "original-choice" } },
        });
      });

      expect(collected.length).toBe(2);
      const f = collected[0];
      expect(f.type).toBe("session.prompt");
      expect(f.tenant_id).toBe("tn_inj");
      expect(collected[1]).toEqual({
        type: "session.response", session_id: sid, tenant_id: "tn_inj",
        turn_id: "original-turn", request_id: "original-request",
        response: { outcome: { outcome: "selected", optionId: "original-choice" } },
      });
    });
  });
});

// GET /v1/oma/runtimes — workspace API key auth (OMA-2)
describe("GET /v1/oma/runtimes — workspace API key", () => {
  beforeAll(async () => {
    await api("/health").catch(() => {});
  });

  async function putWorkspaceApiKey(opts: {
    plain: string;
    tenantId: string;
    userId?: string;
  }): Promise<void> {
    const hash = await sha256Hex(opts.plain);
    await env.CONFIG_KV.put(
      `apikey:${hash}`,
      JSON.stringify({
        id: `ak_${Math.random().toString(36).slice(2, 10)}`,
        tenant_id: opts.tenantId,
        ...(opts.userId ? { user_id: opts.userId } : {}),
        name: "test key",
        created_at: new Date().toISOString(),
        credential: { type: "workspace" },
      }),
    );
  }

  async function seedTenantUser(opts: {
    tenantId: string;
    userId: string;
    tenantName?: string;
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await env.AUTH_DB
      .prepare(
        `INSERT OR IGNORE INTO "tenant" (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
      )
      .bind(opts.tenantId, opts.tenantName ?? opts.tenantId, now * 1000, now * 1000)
      .run();
    await env.AUTH_DB
      .prepare(
        `INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, tenantId, role, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        opts.userId,
        "Test User",
        `${opts.userId}@test.local`,
        1,
        opts.tenantId,
        "owner",
        now * 1000,
        now * 1000,
      )
      .run();
    await env.AUTH_DB
      .prepare(
        `INSERT OR REPLACE INTO "membership" (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(opts.userId, opts.tenantId, "owner", now)
      .run();
  }

  async function insertRuntimeRow(opts: {
    runtimeId: string;
    ownerUserId: string;
    ownerTenantId: string;
    hostname?: string;
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await env.AUTH_DB
      .prepare(
        `INSERT OR REPLACE INTO "runtimes"
          (id, owner_user_id, owner_tenant_id, machine_id, hostname, os, agents_json, version, status, last_heartbeat, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        opts.runtimeId,
        opts.ownerUserId,
        opts.ownerTenantId,
        `machine-${opts.runtimeId}`,
        opts.hostname ?? "test-host",
        "darwin",
        '[{"id":"claude-acp"}]',
        "0.0.1-test",
        "online",
        now,
        now,
      )
      .run();
  }

  it("user-bound workspace key lists only that user's machines", async () => {
    const tenantId = `tn_ub_${Math.random().toString(36).slice(2, 8)}`;
    const userId = `u_ub_${Math.random().toString(36).slice(2, 8)}`;
    const ridMine = `rt_ub_mine_${Math.random().toString(36).slice(2, 8)}`;
    const ridOther = `rt_ub_other_${Math.random().toString(36).slice(2, 8)}`;
    const otherUser = `u_ub_other_${Math.random().toString(36).slice(2, 8)}`;

    await seedTenantUser({ tenantId, userId });
    await seedTenantUser({ tenantId, userId: otherUser });
    await insertRuntimeRow({ runtimeId: ridMine, ownerUserId: userId, ownerTenantId: tenantId, hostname: "mine" });
    await insertRuntimeRow({ runtimeId: ridOther, ownerUserId: otherUser, ownerTenantId: tenantId, hostname: "other" });

    const keyPlain = `oma_ub_${Math.random().toString(36).slice(2)}`;
    await putWorkspaceApiKey({ plain: keyPlain, tenantId, userId });

    const res = await api("/v1/oma/runtimes", {
      headers: { "x-api-key": keyPlain },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimes).toHaveLength(1);
    expect(body.runtimes[0].id).toBe(ridMine);
    expect(body.runtimes[0].hostname).toBe("mine");
    expect(body.runtimes[0].status).toBe("online");
    expect(body.runtimes[0].last_heartbeat).toEqual(expect.any(Number));
    expect(body.runtimes[0].agents).toEqual([{ id: "claude-acp" }]);
  });

  it("single-user tenant fills in user_id for a key with no user_id", async () => {
    const tenantId = `tn_su_${Math.random().toString(36).slice(2, 8)}`;
    const userId = `u_su_${Math.random().toString(36).slice(2, 8)}`;
    const rid = `rt_su_${Math.random().toString(36).slice(2, 8)}`;

    await seedTenantUser({ tenantId, userId });
    await insertRuntimeRow({ runtimeId: rid, ownerUserId: userId, ownerTenantId: tenantId });

    const keyPlain = `oma_su_${Math.random().toString(36).slice(2)}`;
    await putWorkspaceApiKey({ plain: keyPlain, tenantId });

    const res = await api("/v1/oma/runtimes", { headers: { "x-api-key": keyPlain } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimes.map((r: { id: string }) => r.id)).toEqual([rid]);
  });

  it("multi-user tenant returns 401 when the key has no user_id", async () => {
    const tenantId = `tn_mu_${Math.random().toString(36).slice(2, 8)}`;
    await seedTenantUser({ tenantId, userId: `u_mu_a_${Math.random().toString(36).slice(2, 8)}` });
    await seedTenantUser({ tenantId, userId: `u_mu_b_${Math.random().toString(36).slice(2, 8)}` });

    const keyPlain = `oma_mu_${Math.random().toString(36).slice(2)}`;
    await putWorkspaceApiKey({ plain: keyPlain, tenantId });

    const res = await api("/v1/oma/runtimes", { headers: { "x-api-key": keyPlain } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatchObject({ type: "authentication_error", message: "unauthorized" });
  });

  it("legacy env API_KEY resolves with no user and gets 401", async () => {
    const res = await api("/v1/oma/runtimes", { headers: { "x-api-key": "test-key" } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatchObject({ type: "authentication_error", message: "unauthorized" });
  });

  it("does not list another user's runtime in the same tenant", async () => {
    const tenantId = `tn_iso_${Math.random().toString(36).slice(2, 8)}`;
    const userA = `u_iso_a_${Math.random().toString(36).slice(2, 8)}`;
    const userB = `u_iso_b_${Math.random().toString(36).slice(2, 8)}`;
    const ridA = `rt_iso_a_${Math.random().toString(36).slice(2, 8)}`;
    const ridB = `rt_iso_b_${Math.random().toString(36).slice(2, 8)}`;

    await seedTenantUser({ tenantId, userId: userA });
    await seedTenantUser({ tenantId, userId: userB });
    await insertRuntimeRow({ runtimeId: ridA, ownerUserId: userA, ownerTenantId: tenantId });
    await insertRuntimeRow({ runtimeId: ridB, ownerUserId: userB, ownerTenantId: tenantId });

    const keyPlain = `oma_iso_${Math.random().toString(36).slice(2)}`;
    await putWorkspaceApiKey({ plain: keyPlain, tenantId, userId: userA });

    const res = await api("/v1/oma/runtimes", { headers: { "x-api-key": keyPlain } });
    expect(res.status).toBe(200);
    const ids = (await res.json()).runtimes.map((r: { id: string }) => r.id);
    expect(ids).toEqual([ridA]);
    expect(ids).not.toContain(ridB);
  });
});

describe("Runtime pairing tokens + Environment env overlay", () => {
  beforeAll(async () => {
    await api("/health").catch(() => {});
  });

  async function seedUserWithKey(): Promise<{ tenantId: string; userId: string; key: string }> {
    const suffix = Math.random().toString(36).slice(2, 8);
    const tenantId = `tn_pair_${suffix}`;
    const userId = `u_pair_${suffix}`;
    const now = Math.floor(Date.now() / 1000);
    await env.AUTH_DB
      .prepare(`INSERT OR IGNORE INTO "tenant" (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`)
      .bind(tenantId, tenantId, now * 1000, now * 1000)
      .run();
    await env.AUTH_DB
      .prepare(
        `INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, tenantId, role, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, "Pair User", `${userId}@test.local`, 1, tenantId, "owner", now * 1000, now * 1000)
      .run();
    await env.AUTH_DB
      .prepare(`INSERT OR REPLACE INTO "membership" (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)`)
      .bind(userId, tenantId, "owner", now)
      .run();
    const key = `oma_pair_${Math.random().toString(36).slice(2)}`;
    await env.CONFIG_KV.put(
      `apikey:${await sha256Hex(key)}`,
      JSON.stringify({
        id: `ak_${suffix}`,
        tenant_id: tenantId,
        user_id: userId,
        name: "pair key",
        created_at: new Date().toISOString(),
        credential: { type: "workspace" },
      }),
    );
    return { tenantId, userId, key };
  }

  function mint(key: string, body: unknown = {}) {
    return api("/v1/oma/runtimes/pairing-tokens", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function bundleFixture(skills = []) {
    const { key, tenantId, userId } = await seedUserWithKey();
    const runtimeId = `rt_bundle_${tenantId}`;
    const { tokenPlain } = await seedRuntime({
      runtimeId, userId, ownerTenantId: tenantId,
      memberships: [{ tenant_id: tenantId, role: "owner" }],
    });
    const post = async (path: string, body: unknown, status = 201) => {
      const response = await api(path, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(status);
      return result;
    };
    const environment = await post("/v1/environments", {
      name: "bundle host", config: { type: "self_hosted" },
      _oma: { runtime: { runtime_id: runtimeId, env: { OVERLAY: "from-environment" } } },
    });
    const agent = await post("/v1/agents", {
      name: "bundle agent", model: "claude-sonnet-4-6", system: "Pinned bundle instructions", skills,
      _oma: { harness: "acp-proxy", runtime_binding: { runtime_id: runtimeId, acp_agent_id: "claude-code" } },
    });
    // No messages/turns: exercise persistence and delivery without model inference.
    const session = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
    expect(session.environment_id).toBe(environment.id);
    const bundle = (sid = session.id, token = tokenPlain, cache = false) => api(
      `/agents/runtime/sessions/${sid}/bundle?agent_id=claude-code${cache ? "&skill_cache=1" : ""}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    return { bundle, post, session, environment, agent, runtimeId, tenantId, userId };
  }

  it("delivers the overlay and pinned agent for a session created through the public managed API", async () => {
    const { bundle, post, agent } = await bundleFixture();
    await post(`/v1/agents/${agent.id}`, { system: "Later agent instructions" }, 200);
    const response = await bundle();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.env).toEqual([{ name: "OVERLAY", value: "from-environment" }]);
    expect(result.files).toContainEqual({ path: "AGENTS.md", content: expect.stringContaining("Pinned bundle instructions") });
    expect(JSON.stringify(result.files)).not.toContain("Later agent instructions");
  });

  it("delivers explicit sandbox placement and runtime ownership in the bundle", async () => {
    const { bundle, post, environment, runtimeId } = await bundleFixture();
    expect((await (await bundle()).json()).runtime).toEqual({ runtime_id: runtimeId, placement: "host" });
    await post(`/v1/environments/${environment.id}`, { _oma: { runtime: { runtime_id: runtimeId, placement: "sandbox" } } }, 200);
    expect((await (await bundle()).json()).runtime).toEqual({ runtime_id: runtimeId, placement: "sandbox" });
    await post(`/v1/environments/${environment.id}`, { _oma: { runtime: { runtime_id: "rt_elsewhere", placement: "sandbox" } } }, 200);
    expect((await bundle()).status).toBe(500);
  });

  it("serves managed skill references from the Session snapshot without text extracts", async () => {
    const skills = [{ type: "custom", skill_id: "skill_cache_latest" },
      { type: "custom", skill_id: "skill_cache_pinned", version: "version_1" }];
    const { bundle, post, agent, session } = await bundleFixture(skills);
    await post(`/v1/agents/${agent.id}`, { skills: [] }, 200);
    const response = await bundle(session.id, undefined, true);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.managed_skills).toEqual([
      { ...skills[0], version: "latest" }, skills[1],
    ]);
    expect(result.files).toEqual([{ path: "AGENTS.md", content: expect.stringContaining("Pinned bundle instructions") }]);
    expect(result.files[0].content).not.toContain("content unavailable");
    expect((await (await bundle()).json()).managed_skills).toBeUndefined();
  });

  it("hides bundles from another runtime/workspace and after session archive", async () => {
    const { bundle, post, session, tenantId, userId } = await bundleFixture();
    for (const workspace of [tenantId, `${tenantId}_other`]) {
      const { tokenPlain } = await seedRuntime({
        runtimeId: `rt_other_${workspace}`, userId, ownerTenantId: workspace,
        memberships: [{ tenant_id: workspace, role: "owner" }],
      });
      const denied = await bundle(session.id, tokenPlain);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toMatchObject({ error: { type: "not_found_error", message: "session not found" } });
    }
    expect((await bundle("session_missing")).status).toBe(404);
    expect((await bundle(session.id, "invalid")).status).toBe(401);
    await post(`/v1/sessions/${session.id}/archive`, {}, 200);
    expect((await bundle()).status).toBe(404);
  });

  it("reads current overlay edits and rejects unavailable or mismatched Environment policy", async () => {
    const { bundle, post, environment, runtimeId } = await bundleFixture();
    for (const [runtime, expected] of [
      [{ runtime_id: runtimeId, env: { OVERLAY: "edited", EMPTY: "" } }, [{ name: "OVERLAY", value: "edited" }, { name: "EMPTY", value: "" }]],
      [null, []],
    ] as const) {
      await post(`/v1/environments/${environment.id}`, { _oma: { runtime } }, 200);
      const response = await bundle();
      expect(response.status).toBe(200);
      expect((await response.json()).env).toEqual(expected);
    }
    await post(`/v1/environments/${environment.id}`, {
      _oma: { runtime: { runtime_id: runtimeId, env: { OVERLAY: "archived" } } },
    }, 200);
    await post(`/v1/environments/${environment.id}/archive`, {}, 200);
    expect((await bundle()).status).toBe(500);
  });

  it("preserves legacy session env precedence and blocks archived legacy bundles", async () => {
    const { bundle, environment, agent, tenantId } = await bundleFixture();
    const { getCfServicesForTenant } = await import("@open-managed-agents/services");
    const { loadRuntimeAgentSnapshot } = await import("@open-managed-agents/managed-agents-adapters-runtime");
    const services = await getCfServicesForTenant(env, tenantId);
    const agentSnapshot = await loadRuntimeAgentSnapshot(services.agents, tenantId, agent.id);
    const { session, resources } = await services.sessions.create({
      tenantId, agentId: agent.id, environmentId: environment.id,
      agentSnapshot,
      resources: [{ type: "env", name: "OVERLAY" }, { type: "env", name: "SESSION_ONLY" }],
    });
    for (const resource of resources) {
      await services.sessionSecrets.put({ tenantId, sessionId: session.id, resourceId: resource.id, value: "from-session" });
    }
    const response = await bundle(session.id);
    expect(response.status).toBe(200);
    expect((await response.json()).env).toEqual([
      { name: "OVERLAY", value: "from-session" }, { name: "SESSION_ONLY", value: "from-session" },
    ]);
    await services.sessions.archive({ tenantId, sessionId: session.id });
    expect((await bundle(session.id)).status).toBe(404);
  });

  it("mints a single-use token that the unchanged /exchange accepts once", async () => {
    const { parseRuntimePairingToken } = await import("@open-managed-agents/api-types");
    const { key, tenantId } = await seedUserWithKey();

    const res = await mint(key, { ttl_seconds: 600 });
    expect(res.status).toBe(201);
    const minted = await res.json();
    expect(minted.pairing_token).toMatch(/^omrp_[0-9a-f]+_[0-9a-f]+$/);
    expect(minted.install_command).toContain(`--token=${minted.pairing_token}`);
    expect(minted.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(590);

    const parts = parseRuntimePairingToken(minted.pairing_token);
    expect(parts).not.toBeNull();
    const exchange = (machine: string) => api("/agents/runtime/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...parts, machine_id: machine, hostname: "headless", os: "linux", version: "0.0.1-test", multi_tenant: true,
      }),
    });
    const first = await exchange(`m_${tenantId}`);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.token).toMatch(/^sk_machine_/);
    expect(body.tenants.map((t: { id: string }) => t.id)).toEqual([tenantId]);

    const replay = await exchange(`m2_${tenantId}`);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toMatchObject({ message: "code already used" });
  });

  it("rejects out-of-range ttl and unauthenticated callers", async () => {
    const { key } = await seedUserWithKey();
    for (const ttl_seconds of [10, 7 * 24 * 3600, 1.5, "3600"]) {
      expect((await mint(key, { ttl_seconds })).status).toBe(400);
    }
    const anon = await api("/v1/oma/runtimes/pairing-tokens", { method: "POST" });
    expect(anon.status).toBe(401);
  });

  it("serves an Environment overlay only to the runtime it is attached to", async () => {
    const { runtimeEnvironmentOverlay } = await import("../../apps/main/src/routes/runtimes");
    const workspaceId = `tn_ovl_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const put = async (id: string, document: object, archivedAt: number | null = null) => {
      await env.MAIN_DB
        .prepare(
          `INSERT INTO managed_environments (workspace_id, id, document, revision, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(workspaceId, id, JSON.stringify(document), now, now, archivedAt)
        .run();
    };
    const base = { config: { type: "self_hosted" }, metadata: {}, name: "laptop", description: null };
    await put("env_attached", { ...base, id: "env_attached", openma: { runtime: { runtimeId: "rt_a", env: { FOO: "bar" } } } });
    await put("env_archived", { ...base, id: "env_archived", openma: { runtime: { runtimeId: "rt_a", env: { FOO: "x" } } } }, now);
    await put("env_plain", { ...base, id: "env_plain" });

    await expect(runtimeEnvironmentOverlay(env.MAIN_DB, workspaceId, "env_attached", "rt_a")).resolves.toEqual({ FOO: "bar" });
    await expect(runtimeEnvironmentOverlay(env.MAIN_DB, workspaceId, "env_attached", "rt_b")).rejects.toThrow("does not match");
    await expect(runtimeEnvironmentOverlay(env.MAIN_DB, "tn_other", "env_attached", "rt_a")).rejects.toThrow("unavailable");
    await expect(runtimeEnvironmentOverlay(env.MAIN_DB, workspaceId, "env_archived", "rt_a")).rejects.toThrow("unavailable");
    await expect(runtimeEnvironmentOverlay(env.MAIN_DB, workspaceId, "env_plain", "rt_a")).resolves.toEqual({});
    await expect(runtimeEnvironmentOverlay(env.MAIN_DB, workspaceId, null, "rt_a")).resolves.toEqual({});
  });
});
