// Controlled OAuth/upstream transports, real memory and SQLite stores.
// These regressions are not live-provider OAuth acceptance tests.
import { describe, expect, it } from "vitest";
import { builtinSpecs, createSpecRegistry } from "../../cap/src/index";
import type { CredentialStore } from "../../credential-store/src/index";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { SqlCredentialStore } from "../../credential-store-sql/src/index";
import { MemoryVaultStore } from "../../vault-store-memory/src/index";
import { SqlVaultStore } from "../../vault-store-sql/src/index";
import { createBetterSqlite3SqlClient } from "../../sql-client/src/index";
import { ManagedCredentialResolver } from "../src/resolver";
import { createCredentialEgressRelay } from "../src/relay";

const CREATED = "2026-09-01T00:00:00.000Z";
const ARCHIVED = "2026-10-01T00:00:00.000Z";
const LOCATION = { workspaceId: "ws", vaultId: "v", credentialId: "c" };
const SCOPE = { workspaceId: "ws", sessionId: "s", vaultIds: ["v"] };
const SCHEMA = `
CREATE TABLE managed_credentials (
  workspace_id text NOT NULL, vault_id text NOT NULL, id text NOT NULL,
  sealed_document text NOT NULL, revision integer NOT NULL,
  created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer,
  PRIMARY KEY (workspace_id, id));
CREATE TABLE managed_vaults (
  workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL,
  revision integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL,
  archived_at integer, PRIMARY KEY (workspace_id, id));
`;

type Backend = "memory" | "sql";
type AuthType = "mcp_oauth" | "cap_cli";
type ArchiveKind = "credential" | "vault";

async function setup(backend: Backend, authType: AuthType) {
  let credentials: CredentialStore = new MemoryCredentialStore();
  let vaults: MemoryVaultStore | SqlVaultStore = new MemoryVaultStore();
  if (backend === "sql") {
    const client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    credentials = new SqlCredentialStore(client, {
      seal: async ({ plaintext }) => ({ ciphertext: `sealed:${btoa(plaintext)}` }),
      open: async ({ ciphertext }) => ({ plaintext: atob(ciphertext.slice(7)) }),
    });
    vaults = new SqlVaultStore(client);
  }
  await vaults.insert({ workspaceId: "ws", vault: {
    id: "v", archivedAt: null, createdAt: CREATED, updatedAt: CREATED,
    metadata: {}, displayName: "test",
  } });
  const auth = authType === "mcp_oauth" ? {
    type: "mcp_oauth" as const, mcpServerUrl: "https://mcp.example/mcp", accessToken: "stale",
    refresh: { clientId: "client", refreshToken: "r1", tokenEndpoint: "https://auth.example/token",
      tokenEndpointAuth: { type: "none" as const } },
  } : { type: "cap_cli" as const, cliId: "gh", token: "stale", refreshToken: "r1" };
  await credentials.insert({ workspaceId: "ws", credential: {
    id: "c", vaultId: "v", archivedAt: null, createdAt: CREATED, updatedAt: CREATED,
    metadata: {}, auth,
  } });
  const events: string[] = [];
  const writes: string[] = [];
  const baseReplace = credentials.replace.bind(credentials);
  let afterReplace: (() => Promise<void>) | undefined;
  credentials.replace = async input => {
    const result = await baseReplace(input);
    writes.push(`${input.expectedRevision}:${result.type}`);
    if (result.type === "replaced" && afterReplace) {
      const hook = afterReplace;
      afterReplace = undefined;
      await hook();
    }
    return result;
  };
  let exchange = async () => Response.json({ access_token: "fresh", refresh_token: "r2" });
  const resolver = new ManagedCredentialResolver({
    credentials, vaults, clock: { now: () => new Date(ARCHIVED) }, log: { warn() {} },
    fetch: async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toContain("refresh_token=r1");
      events.push("exchange");
      return exchange();
    },
  }, createSpecRegistry(builtinSpecs));
  const resolve = () => authType === "mcp_oauth"
    ? resolver.mcpTarget(SCOPE, "https://mcp.example/mcp")
    : resolver.outboundTarget(SCOPE, "api.github.com");
  async function archive(kind: ArchiveKind) {
    const result = kind === "credential"
      ? await credentials.archive({ ...LOCATION, archivedAt: ARCHIVED })
      : await vaults.archive({ workspaceId: "ws", vaultId: "v", archivedAt: ARCHIVED });
    expect(result.type).toBe("archived");
    events.push(`archived:${kind}`);
  }
  async function rotateWinner() {
    const record = (await credentials.find(LOCATION))!;
    const next = structuredClone(record.credential);
    if (next.auth.type === "mcp_oauth") {
      next.auth.accessToken = "winner";
      next.auth.refresh!.refreshToken = "winner-refresh";
    } else if (next.auth.type === "cap_cli") {
      next.auth.token = "winner";
      next.auth.refreshToken = "winner-refresh";
    }
    expect((await baseReplace({ ...LOCATION, expectedRevision: record.revision, next })).type).toBe("replaced");
  }
  async function forward(onFirst?: () => Promise<void>) {
    const target = (await resolve())!;
    expect(target).not.toBeNull();
    return resolver.forward("ws", target, async token => {
      events.push(`send:${token}`);
      if (token === "stale") {
        await onFirst?.();
        return new Response("original rejection", { status: 401 });
      }
      return new Response("retried", { status: 200 });
    });
  }
  async function expectStored(token: string, refreshToken: string, archived: boolean) {
    const record = (await credentials.find(LOCATION))!;
    expect(record.credential.archivedAt).toBe(archived ? ARCHIVED : null);
    expect(record.credential.auth).toMatchObject(authType === "mcp_oauth"
      ? { accessToken: token, refresh: { refreshToken } } : { token, refreshToken });
  }
  return { resolver, credentials, vaults, events, writes, resolve, archive, forward, rotateWinner, expectStored,
    setExchange: (fn: typeof exchange) => { exchange = fn; },
    setAfterReplace: (fn: () => Promise<void>) => { afterReplace = fn; },
  };
}

for (const backend of ["memory", "sql"] as const) {
  for (const authType of ["mcp_oauth", "cap_cli"] as const) {
    describe(`refresh revocation (${backend}/${authType}, controlled transports)`, () => {
      for (const kind of ["credential", "vault"] as const) {
        it(`does not exchange or retry when ${kind} was archived before the 401`, async () => {
          const h = await setup(backend, authType);
          const result = await h.forward(() => h.archive(kind));
          expect(h.events).toEqual(["send:stale", `archived:${kind}`]);
          expect(result).toMatchObject({ refreshed: false, refreshFailed: true, refreshFailureCode: null });
          expect(result.response.status).toBe(401);
          expect(await result.response.text()).toBe("original rejection");
          expect(h.writes).toEqual([]);
          expect(await h.resolve()).toBeNull();
        });

        it(`persists issued tokens without dispatch or reactivation when ${kind} is archived during exchange`, async () => {
          const h = await setup(backend, authType);
          h.setExchange(async () => {
            await h.archive(kind);
            return Response.json({ access_token: "fresh", refresh_token: "r2" });
          });
          const result = await h.forward();
          expect(h.events).toEqual(["send:stale", "exchange", `archived:${kind}`]);
          expect(result).toMatchObject({ refreshed: false, refreshFailed: true });
          expect(await result.response.text()).toBe("original rejection");
          expect(h.writes).toEqual(kind === "credential"
            ? ["1:revision_conflict", "2:replaced"] : ["1:replaced"]);
          await h.expectStored("fresh", "r2", kind === "credential");
          expect(await h.resolve()).toBeNull();
        });

        it(`returns no refresh token when ${kind} is archived after rotation CAS succeeds`, async () => {
          const h = await setup(backend, authType);
          const target = (await h.resolve())!;
          h.setAfterReplace(() => h.archive(kind));
          expect(await h.resolver.refresh("ws", target, "stale")).toBeNull();
          expect(h.events).toEqual(["exchange", `archived:${kind}`]);
          await h.expectStored("fresh", "r2", kind === "credential");
        });

        it(`rechecks ${kind} immediately before retry dispatch after refresh returns`, async () => {
          const h = await setup(backend, authType);
          const refresh = h.resolver.refresh.bind(h.resolver);
          h.resolver.refresh = async (...args) => {
            const token = await refresh(...args);
            expect(token).toBe("fresh");
            await h.archive(kind);
            return token;
          };
          const result = await h.forward();
          expect(h.events).toEqual(["send:stale", "exchange", `archived:${kind}`]);
          expect(result).toMatchObject({ refreshed: false, refreshFailed: true });
          expect(await result.response.text()).toBe("original rejection");
        });

        it(`does not return an already rotated token from an archived ${kind}`, async () => {
          const h = await setup(backend, authType);
          const target = (await h.resolve())!;
          await h.rotateWinner();
          await h.archive(kind);
          expect(await h.resolver.refresh("ws", target, "stale")).toBeNull();
          expect(h.events).toEqual([`archived:${kind}`]);
          await h.expectStored("winner", "winner-refresh", kind === "credential");
        });

        for (const rejected of [false, true]) {
          it(`does not return an archived ${kind} winner after ${rejected ? "OAuth rejection" : "CAS conflict"}`, async () => {
            const h = await setup(backend, authType);
            const target = (await h.resolve())!;
            h.setExchange(async () => {
              await h.rotateWinner();
              await h.archive(kind);
              return rejected ? Response.json({ error: "invalid_grant" }, { status: 400 })
                : Response.json({ access_token: "fresh", refresh_token: "r2" });
            });
            const failure = { code: null as string | null };
            expect(await h.resolver.refresh("ws", target, "stale", failure)).toBeNull();
            expect(failure.code).toBe(rejected ? "invalid_grant" : null);
            expect(h.events).toEqual(["exchange", `archived:${kind}`]);
            await h.expectStored("winner", "winner-refresh", kind === "credential");
          });
        }
      }

      for (const kind of ["credential", "vault"] as const) {
        it(`does not dispatch after a committed rotation write throws and ${kind} is archived`, async () => {
          const h = await setup(backend, authType);
          const target = (await h.resolve())!;
          h.setAfterReplace(async () => {
            await h.archive(kind);
            throw new Error("connection lost after commit");
          });
          expect(await h.resolver.refresh("ws", target, "stale")).toBeNull();
          await h.expectStored("fresh", "r2", kind === "credential");
          expect(h.events).toEqual(["exchange", `archived:${kind}`]);
        });
      }

      it("keeps an active concurrent winner when a rotation write throws", async () => {
        const h = await setup(backend, authType);
        h.setAfterReplace(async () => {
          await h.rotateWinner();
          throw new Error("connection lost after commit");
        });
        const result = await h.forward();
        expect(h.events).toEqual(["send:stale", "exchange", "send:winner"]);
        expect(result.refreshed).toBe(true);
        await h.expectStored("winner", "winner-refresh", false);
      });

      it("does not exchange or retry when the Vault is missing", async () => {
        const h = await setup(backend, authType);
        const result = await h.forward(async () => {
          expect((await h.vaults.delete({ workspaceId: "ws", vaultId: "v" })).type).toBe("deleted");
        });
        expect(h.events).toEqual(["send:stale"]);
        expect(result).toMatchObject({ refreshed: false, refreshFailed: true });
        expect(result.response.status).toBe(401);
      });

      it("still reports an unsaved issued rotation when an archived revision keeps conflicting", async () => {
        const h = await setup(backend, authType);
        const target = (await h.resolve())!;
        h.setExchange(async () => {
          await h.archive("credential");
          h.credentials.replace = async () => ({ type: "revision_conflict", actualRevision: 2 });
          return Response.json({ access_token: "fresh", refresh_token: "r2" });
        });
        await expect(h.resolver.refresh("ws", target, "stale"))
          .rejects.toThrow("rotation could not be saved (revision conflict)");
        expect(h.events).toEqual(["exchange", "archived:credential"]);
        await h.expectStored("stale", "r1", true);
      });

      for (const kind of ["credential", "vault"] as const) {
        it(`propagates ${kind} read failure at final retry check without another send`, async () => {
          const h = await setup(backend, authType);
          const refresh = h.resolver.refresh.bind(h.resolver);
          h.resolver.refresh = async (...args) => {
            const token = await refresh(...args);
            expect(token).toBe("fresh");
            if (kind === "credential") h.credentials.find = async () => { throw new Error("read unavailable"); };
            else h.vaults.find = async () => { throw new Error("read unavailable"); };
            return token;
          };
          await expect(h.forward()).rejects.toThrow("read unavailable");
          expect(h.events).toEqual(["send:stale", "exchange"]);
        });
      }

      it("does not refresh or retry after the credential is deleted", async () => {
        const h = await setup(backend, authType);
        const result = await h.forward(async () => {
          expect((await h.credentials.delete(LOCATION)).type).toBe("deleted");
        });
        expect(h.events).toEqual(["send:stale"]);
        expect(result).toMatchObject({ refreshed: false, refreshFailed: true });
        expect(result.response.status).toBe(401);
      });

      for (const rejected of [false, true]) {
        it(`keeps the active concurrent winner after ${rejected ? "OAuth rejection" : "CAS conflict"}`, async () => {
          const h = await setup(backend, authType);
          h.setExchange(async () => {
            await h.rotateWinner();
            return rejected ? Response.json({ error: "invalid_grant" }, { status: 400 })
              : Response.json({ access_token: "fresh", refresh_token: "r2" });
          });
          const result = await h.forward();
          expect(h.events).toEqual(["send:stale", "exchange", "send:winner"]);
          expect(result).toMatchObject({ refreshed: true, refreshFailed: false, refreshFailureCode: null });
          await h.expectStored("winner", "winner-refresh", false);
        });
      }

      for (const kind of ["credential", "vault"] as const) {
        it(`shared relay sends a POST only once after ${kind} archive; next request is denied`, async () => {
          const h = await setup(backend, authType);
          const seen: Array<{ token: string | null; body: string; method: string }> = [];
          const relay = createCredentialEgressRelay({
            passes: { issue: async () => "pass", verify: async () => ({ workspaceId: "ws", sessionId: "s", expiresAt: Date.now() + 60000 }) },
            findSession: async () => ({ vaultIds: ["v"], archivedAt: null }), credentials: h.resolver,
            send: async request => {
              seen.push({ token: request.headers.get("authorization"), body: await request.text(), method: request.method });
              await h.archive(kind);
              return new Response("original rejection", { status: 401 });
            },
          });
          const request = () => new Request("https://control.example/v1/oma/egress/forward", {
            method: "POST", body: "write operation", headers: {
              authorization: "Bearer pass",
              "x-oma-egress-target": authType === "mcp_oauth" ? "https://mcp.example/mcp" : "https://api.github.com/user",
              "x-oma-egress-method": "POST",
              "x-oma-egress-headers": JSON.stringify({ authorization: "Bearer __cap_managed__" }),
            },
          });
          const response = await relay.handle("forward", request());
          expect(response.status).toBe(401);
          expect(await response.text()).toBe("original rejection");
          expect(seen).toEqual([{ token: "Bearer stale", body: "write operation", method: "POST" }]);
          expect(h.events).toEqual([`archived:${kind}`]);
          expect((await relay.handle("forward", request())).status).toBe(403);
          expect(seen).toHaveLength(1);
        });
      }
    });
  }
}
