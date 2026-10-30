import { describe, expect, it } from "vitest";
import {
  McpOAuthApplicationService,
  type CredentialView,
  type CredentialsApplicationPort,
  type CreateCredentialCommand,
  type McpOAuthPort,
} from "../src/index";

const SERVER = "https://mcp.linear.app/mcp";

function credentialsFake(existing: CredentialView[] = []) {
  const created: CreateCredentialCommand[] = [];
  const archived: string[] = [];
  const port: CredentialsApplicationPort = {
    createCredential: async (command) => {
      created.push(command);
      return {
        type: "created",
        credential: {
          id: `cred_new_${created.length}`,
          vaultId: command.vaultId,
          archivedAt: null,
          createdAt: "",
          updatedAt: "",
          metadata: {},
          auth: { type: "mcp_oauth", mcpServerUrl: SERVER },
        },
      };
    },
    listCredentials: async ({ vaultId }) =>
      vaultId === "vlt_missing"
        ? { type: "not_found" }
        : { type: "page", page: { credentials: existing, nextCursor: null } },
    archiveCredential: async ({ credentialId }) => {
      archived.push(credentialId);
      return { type: "archived", credential: { ...existing.find((c) => c.id === credentialId)!, archivedAt: "2026-09-01T00:00:00.000Z" } };
    },
    retrieveCredential: async ({ credentialId }) => {
      const credential = existing.find((c) => c.id === credentialId);
      return credential ? { type: "found", credential } : { type: "not_found" };
    },
    updateCredential: async () => ({ type: "not_found" }),
    deleteCredential: async () => ({ type: "not_found" }),
    validateCredential: async () => ({ type: "not_found" }),
  };
  return { port, created, archived };
}

const oauth: McpOAuthPort = {
  discover: async () => ({
    type: "discovered",
    metadata: {
      resource: SERVER,
      issuer: "https://linear.app",
      authorizationEndpoint: "https://linear.app/oauth/authorize",
      tokenEndpoint: "https://linear.app/oauth/token",
      scopes: ["read"],
    },
    registrationEndpoint: "https://linear.app/oauth/register",
  }),
  client: async () => ({ type: "client", client: { clientId: "dcr_client" } }),
  exchangeCode: async (input) => {
    expect(input.codeVerifier).toBe("verifier");
    expect(input.callbackUri).toBe("https://openma.test/v1/oma/oauth/callback");
    return { type: "issued", tokens: { accessToken: "at", refreshToken: "rt", expiresAt: "2026-09-01T01:00:00.000Z" } };
  },
  probe: async () => ({ ok: true }),
};

/** Identity "cipher" tagged with the workspace: enough to test binding. */
const cipher = {
  encrypt: async (plaintext: string) => `sealed:${plaintext}`,
  decrypt: async (ciphertext: string) => {
    if (!ciphertext.startsWith("sealed:")) throw new Error("bad");
    return ciphertext.slice("sealed:".length);
  },
};

function service(input: {
  workspaceId?: string;
  credentials: CredentialsApplicationPort;
  now?: number;
}) {
  return new McpOAuthApplicationService({
    workspaceId: input.workspaceId ?? "ws_1",
    credentials: input.credentials,
    oauth,
    pkce: { create: async () => ({ verifier: "verifier", challenge: "challenge" }) },
    cipher,
    clock: { now: () => new Date(input.now ?? Date.parse("2026-09-01T00:00:00.000Z")) },
    log: { warn: () => {} },
  });
}

async function authorize(credentials: CredentialsApplicationPort, credentialId?: string) {
  const result = await service({ credentials }).authorize({
    vaultId: "vlt_1",
    mcpServerUrl: SERVER,
    returnTo: "https://console.test/vaults/vlt_1",
    callbackUri: "https://openma.test/v1/oma/oauth/callback",
    userId: "user_1",
    ...(credentialId !== undefined && { credentialId }),
  });
  if (result.type !== "redirect") throw new Error(result.type);
  return new URL(result.authorizationUrl);
}

const oldCredential: CredentialView = { id: "cred_old", vaultId: "vlt_1", archivedAt: null, createdAt: "", updatedAt: "", metadata: {}, auth: { type: "mcp_oauth", mcpServerUrl: SERVER } };

describe("McpOAuthApplicationService", () => {
  it("rejects state opened by another user in the same workspace before exchanging a token", async () => {
    const fake = credentialsFake();
    const state = (await authorize(fake.port)).searchParams.get("state")!;
    for (const userId of ["user_2", null]) {
      expect(await service({ credentials: fake.port }).complete({ state, code: "c", callbackUri: "https://openma.test/v1/oma/oauth/callback", userId })).toEqual({ type: "invalid_state" });
    }
    expect(fake.created).toEqual([]);
  });

  it.each([
    { type: "static_bearer" as const, mcpServerUrl: SERVER },
    { type: "mcp_oauth" as const, mcpServerUrl: "https://other.example.test/mcp" },
  ])("refuses unrelated reauthorization credential $type/$mcpServerUrl", async (auth) => {
    const fake = credentialsFake([{ ...oldCredential, auth }]);
    expect(await service({ credentials: fake.port }).authorize({ vaultId: "vlt_1", mcpServerUrl: SERVER, credentialId: "cred_old", returnTo: "https://console.test/", callbackUri: "https://openma.test/v1/oma/oauth/callback", userId: "user_1" })).toMatchObject({ type: "invalid_request" });
    expect(fake.archived).toEqual([]);
  });

  it("reports a replaced credential that could not be archived instead of returning connected", async () => {
    const fake = credentialsFake([oldCredential]);
    fake.port.archiveCredential = async () => ({ type: "not_found" });
    const state = (await authorize(fake.port)).searchParams.get("state")!;
    expect(await service({ credentials: fake.port }).complete({ state, code: "c", callbackUri: "https://openma.test/v1/oma/oauth/callback", userId: "user_1" })).toEqual({ type: "archive_failed", vaultId: "vlt_1", credentialId: "cred_new_1", unarchivedCredentialIds: ["cred_old"] });
  });

  it("reports archive transport failures without exposing the thrown error", async () => {
    const fake = credentialsFake([oldCredential]);
    fake.port.archiveCredential = async () => { throw new Error("https://private.example.test/secret"); };
    const state = (await authorize(fake.port)).searchParams.get("state")!;
    expect(await service({ credentials: fake.port }).complete({ state, code: "c", callbackUri: "https://openma.test/v1/oma/oauth/callback", userId: "user_1" })).toEqual({ type: "archive_failed", vaultId: "vlt_1", credentialId: "cred_new_1", unarchivedCredentialIds: ["cred_old"] });
  });

  it("redirects with PKCE, resource and scope, carrying the flow in a sealed state", async () => {
    const url = await authorize(credentialsFake().port);
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "dcr_client",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: SERVER,
      scope: "read",
    });
    expect(url.searchParams.get("state")).toMatch(/^sealed:/);
  });

  it("rejects an unknown Vault before discovery", async () => {
    const result = await service({ credentials: credentialsFake().port }).authorize({
      vaultId: "vlt_missing",
      mcpServerUrl: SERVER,
      returnTo: "https://console.test/",
      callbackUri: "https://openma.test/v1/oma/oauth/callback",
      userId: "user_1",
    });
    expect(result).toEqual({ type: "not_found" });
  });

  it("stores a managed mcp_oauth credential with refresh metadata and archives the ones it replaces", async () => {
    const existing: CredentialView[] = [
      { id: "cred_old", vaultId: "vlt_1", archivedAt: null, createdAt: "", updatedAt: "", metadata: {}, auth: { type: "mcp_oauth", mcpServerUrl: SERVER } },
      { id: "cred_reauth", vaultId: "vlt_1", archivedAt: "2026-08-01T00:00:00.000Z", createdAt: "", updatedAt: "", metadata: {}, auth: { type: "mcp_oauth", mcpServerUrl: SERVER } },
      { id: "cred_other", vaultId: "vlt_1", archivedAt: null, createdAt: "", updatedAt: "", metadata: {}, auth: { type: "mcp_oauth", mcpServerUrl: "https://mcp.other.dev/mcp" } },
    ];
    const fake = credentialsFake(existing);
    const state = (await authorize(fake.port, "cred_reauth")).searchParams.get("state")!;
    const result = await service({ credentials: fake.port }).complete({
      state,
      code: "code",
      callbackUri: "https://openma.test/v1/oma/oauth/callback",
      userId: "user_1",
    });
    expect(result).toMatchObject({ type: "connected", vaultId: "vlt_1", credentialId: "cred_new_1", serviceName: "linear", probeOk: true });
    expect(fake.created[0]!.auth).toEqual({
      type: "mcp_oauth",
      mcpServerUrl: SERVER,
      accessToken: "at",
      expiresAt: "2026-09-01T01:00:00.000Z",
      refresh: {
        clientId: "dcr_client",
        refreshToken: "rt",
        tokenEndpoint: "https://linear.app/oauth/token",
        tokenEndpointAuth: { type: "none" },
        resource: SERVER,
      },
    });
    expect(fake.archived).toEqual(["cred_old", "cred_reauth"]);
  });

  it("refuses a state sealed for another workspace, a forged state, and an expired one", async () => {
    const fake = credentialsFake();
    const state = (await authorize(fake.port)).searchParams.get("state")!;
    const callbackUri = "https://openma.test/v1/oma/oauth/callback";
    expect(await service({ workspaceId: "ws_2", credentials: fake.port }).complete({ state, code: "c", callbackUri, userId: "user_1" }))
      .toEqual({ type: "invalid_state" });
    expect(await service({ credentials: fake.port }).complete({ state: "forged", code: "c", callbackUri, userId: "user_1" }))
      .toEqual({ type: "invalid_state" });
    expect(await service({ credentials: fake.port, now: Date.parse("2026-09-01T00:10:00.000Z") }).complete({ state, code: "c", callbackUri, userId: "user_1" }))
      .toEqual({ type: "invalid_state" });
    expect(fake.created).toEqual([]);
  });
});
