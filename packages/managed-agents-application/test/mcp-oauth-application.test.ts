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
      return { type: "not_found" };
    },
    retrieveCredential: async () => ({ type: "not_found" }),
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
  });
}

async function authorize(credentials: CredentialsApplicationPort, credentialId?: string) {
  const result = await service({ credentials }).authorize({
    vaultId: "vlt_1",
    mcpServerUrl: SERVER,
    returnTo: "https://console.test/vaults/vlt_1",
    callbackUri: "https://openma.test/v1/oma/oauth/callback",
    ...(credentialId !== undefined && { credentialId }),
  });
  if (result.type !== "redirect") throw new Error(result.type);
  return new URL(result.authorizationUrl);
}

describe("McpOAuthApplicationService", () => {
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
    });
    expect(result).toEqual({ type: "not_found" });
  });

  it("stores a managed mcp_oauth credential with refresh metadata and archives the ones it replaces", async () => {
    const existing: CredentialView[] = [
      { id: "cred_old", vaultId: "vlt_1", archivedAt: null, createdAt: "", updatedAt: "", metadata: {}, auth: { type: "mcp_oauth", mcpServerUrl: SERVER } },
      { id: "cred_other", vaultId: "vlt_1", archivedAt: null, createdAt: "", updatedAt: "", metadata: {}, auth: { type: "mcp_oauth", mcpServerUrl: "https://mcp.other.dev/mcp" } },
    ];
    const fake = credentialsFake(existing);
    const state = (await authorize(fake.port, "cred_reauth")).searchParams.get("state")!;
    const result = await service({ credentials: fake.port }).complete({
      state,
      code: "code",
      callbackUri: "https://openma.test/v1/oma/oauth/callback",
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
    expect(await service({ workspaceId: "ws_2", credentials: fake.port }).complete({ state, code: "c", callbackUri }))
      .toEqual({ type: "invalid_state" });
    expect(await service({ credentials: fake.port }).complete({ state: "forged", code: "c", callbackUri }))
      .toEqual({ type: "invalid_state" });
    expect(await service({ credentials: fake.port, now: Date.parse("2026-09-01T00:10:00.000Z") }).complete({ state, code: "c", callbackUri }))
      .toEqual({ type: "invalid_state" });
    expect(fake.created).toEqual([]);
  });
});
