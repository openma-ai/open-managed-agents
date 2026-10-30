import { describe, expect, it } from "vitest";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import type { CredentialStore, StoredCredential } from "@open-managed-agents/credential-store";
import { ManagedCredentialResolver, egressRequestHeaders } from "../src/index";

function store(records: StoredCredential[]): CredentialStore {
  return {
    insert: async () => { throw new Error("unused"); },
    find: async ({ credentialId }) => records.find((r) => r.credential.id === credentialId) ?? null,
    replace: async (input) => {
      const index = records.findIndex((r) => r.credential.id === input.credentialId);
      if (records[index]!.revision !== input.expectedRevision) {
        return { type: "revision_conflict", actualRevision: records[index]!.revision };
      }
      records[index] = { revision: input.expectedRevision + 1, credential: input.next };
      return { type: "replaced", record: records[index]! };
    },
    archive: async () => ({ type: "not_found" }),
    delete: async () => ({ type: "not_found" }),
    list: async ({ vaultId }) => records.filter((r) => r.credential.vaultId === vaultId),
  };
}

const oauth: StoredCredential = {
  revision: 1,
  credential: {
    id: "cred_1",
    vaultId: "vlt_1",
    archivedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    metadata: {},
    auth: {
      type: "mcp_oauth",
      mcpServerUrl: "https://mcp.example/mcp",
      accessToken: "stale",
      refresh: {
        clientId: "client",
        refreshToken: "r1",
        tokenEndpoint: "https://auth.example/token",
        tokenEndpointAuth: { type: "none" },
      },
    },
  },
};

describe("ManagedCredentialResolver.forward", () => {
  it("refreshes once on 403, persists the rotation and retries with the new token", async () => {
    const records = [structuredClone(oauth)];
    const resolver = new ManagedCredentialResolver({
      credentials: store(records),
      fetch: async () => Response.json({ access_token: "fresh", refresh_token: "r2" }),
      clock: { now: () => new Date("2026-09-02T00:00:00.000Z") },
      log: { warn: () => {} },
    }, createSpecRegistry(builtinSpecs));
    const scope = { workspaceId: "ws", sessionId: "s", vaultIds: ["vlt_1"] };
    const target = await resolver.mcpTarget(scope, "https://mcp.example/mcp");
    const sent: string[] = [];
    const outcome = await resolver.forward("ws", target!, async (token) => {
      sent.push(token);
      return new Response(null, { status: token === "fresh" ? 200 : 403 });
    });
    expect(sent).toEqual(["stale", "fresh"]);
    expect(outcome).toMatchObject({ refreshed: true, refreshFailed: false });
    expect(records[0]!.revision).toBe(2);
    expect(records[0]!.credential.auth).toMatchObject({ accessToken: "fresh", refresh: { refreshToken: "r2" } });
  });

  it("logs and rethrows a store failure instead of returning no credential", async () => {
    const warnings: unknown[] = [];
    const resolver = new ManagedCredentialResolver({
      credentials: { ...store([]), list: async () => { throw new Error("db down"); } },
      fetch: async () => { throw new Error("unused"); },
      clock: { now: () => new Date() },
      log: { warn: (fields) => warnings.push(fields) },
    }, createSpecRegistry(builtinSpecs));
    await expect(resolver.outboundTarget({ workspaceId: "ws", sessionId: "s", vaultIds: ["v"] }, "api.github.com"))
      .rejects.toThrow("db down");
    expect(warnings).toHaveLength(1);
  });
});

describe("egressRequestHeaders", () => {
  it("drops hop and sandbox control headers and injects the Vault token", () => {
    const headers = egressRequestHeaders(new Headers({
      host: "api.github.com",
      "x-forwarded-for": "10.0.0.1",
      cookie: "c",
      "proxy-authorization": "Basic x",
      authorization: "Bearer sandbox",
      accept: "application/json",
    }), { token: "vault", stripAuthorization: false });
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization"]);
    expect(headers.get("authorization")).toBe("Bearer vault");
  });

  it("strips the sandbox Authorization when required and no token is selected", () => {
    const headers = egressRequestHeaders(new Headers({ authorization: "Bearer sandbox" }), {
      token: null,
      stripAuthorization: true,
    });
    expect(headers.has("authorization")).toBe(false);
  });
});
