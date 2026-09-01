import type {
  CredentialView,
  CredentialsApplicationPort,
} from "../src/index";

export const staticBearerCredentialView: CredentialView = {
  id: "vcrd_static_01",
  archivedAt: null,
  auth: {
    type: "static_bearer",
    mcpServerUrl: "https://mcp.example.com/sse",
  },
  createdAt: "2026-08-26T11:00:00.000Z",
  displayName: "MCP bearer",
  metadata: { team: "platform" },
  updatedAt: "2026-08-26T11:00:00.000Z",
  vaultId: "vlt_01",
};

export const oauthCredentialView: CredentialView = {
  id: "vcrd_oauth_01",
  archivedAt: null,
  auth: {
    type: "mcp_oauth",
    mcpServerUrl: "https://mcp.example.com/sse",
    expiresAt: "2026-08-26T12:00:00.000Z",
    refresh: {
      clientId: "client_01",
      tokenEndpoint: "https://auth.example.com/token",
      tokenEndpointAuth: { type: "client_secret_basic" },
      resource: "https://mcp.example.com",
      scope: "mcp:tools",
    },
  },
  createdAt: "2026-08-26T11:10:00.000Z",
  displayName: "MCP OAuth",
  metadata: {},
  updatedAt: "2026-08-26T11:10:00.000Z",
  vaultId: "vlt_01",
};

export const environmentVariableCredentialView: CredentialView = {
  id: "vcrd_env_01",
  archivedAt: null,
  auth: {
    type: "environment_variable",
    injectionLocation: { body: false, header: true },
    networking: { type: "limited", allowedHosts: ["api.example.com"] },
    secretName: "EXAMPLE_TOKEN",
  },
  createdAt: "2026-08-26T11:20:00.000Z",
  metadata: {},
  updatedAt: "2026-08-26T11:20:00.000Z",
  vaultId: "vlt_01",
};

export function makeCredentialsPort(
  overrides: Partial<CredentialsApplicationPort>,
): CredentialsApplicationPort {
  return {
    createCredential: async () => {
      throw new Error("unexpected createCredential application port call");
    },
    retrieveCredential: async () => {
      throw new Error("unexpected retrieveCredential application port call");
    },
    updateCredential: async () => {
      throw new Error("unexpected updateCredential application port call");
    },
    listCredentials: async () => {
      throw new Error("unexpected listCredentials application port call");
    },
    deleteCredential: async () => {
      throw new Error("unexpected deleteCredential application port call");
    },
    archiveCredential: async () => {
      throw new Error("unexpected archiveCredential application port call");
    },
    validateCredential: async () => {
      throw new Error("unexpected validateCredential application port call");
    },
    ...overrides,
  };
}
