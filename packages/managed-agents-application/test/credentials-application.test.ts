import { describe, expect, it } from "vitest";
import type { Credential } from "../src/domain/credential";
import { CredentialsApplicationService } from "../src/index";

interface StoredCredential {
  credential: Credential;
  revision: number;
}

class InMemoryCredentialPersistence {
  readonly records = new Map<string, StoredCredential>();

  async insert(input: { workspaceId: string; credential: Credential }) {
    const record = { credential: structuredClone(input.credential), revision: 1 };
    this.records.set(
      `${input.workspaceId}:${input.credential.vaultId}:${input.credential.id}`,
      record,
    );
    return structuredClone(record);
  }

  async find(input: { workspaceId: string; vaultId: string; credentialId: string }) {
    const record = this.records.get(
      `${input.workspaceId}:${input.vaultId}:${input.credentialId}`,
    );
    return record === undefined ? null : structuredClone(record);
  }

  async replace(input: {
    workspaceId: string;
    vaultId: string;
    credentialId: string;
    expectedRevision: number;
    next: Credential;
  }) {
    const key = `${input.workspaceId}:${input.vaultId}:${input.credentialId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" as const };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict" as const,
        actualRevision: current.revision,
      };
    }
    const record = {
      credential: structuredClone(input.next),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    return { type: "replaced" as const, record: structuredClone(record) };
  }

  async archive(input: {
    workspaceId: string;
    vaultId: string;
    credentialId: string;
    archivedAt: string;
  }) {
    const key = `${input.workspaceId}:${input.vaultId}:${input.credentialId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" as const };
    const record = {
      credential: {
        ...current.credential,
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    this.records.set(key, structuredClone(record));
    return { type: "archived" as const, record: structuredClone(record) };
  }

  async delete(input: {
    workspaceId: string;
    vaultId: string;
    credentialId: string;
  }) {
    return this.records.delete(
      `${input.workspaceId}:${input.vaultId}:${input.credentialId}`,
    )
      ? { type: "deleted" as const }
      : { type: "not_found" as const };
  }

  async list(input: {
    workspaceId: string;
    vaultId: string;
    limit: number;
    includeArchived: boolean;
    position?: { createdAt: string; credentialId: string };
  }) {
    return Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:${input.vaultId}:`))
      .map(([, record]) => record)
      .filter(
        (record) => input.includeArchived || record.credential.archivedAt === null,
      )
      .filter(
        (record) =>
          input.position === undefined ||
          record.credential.createdAt > input.position.createdAt ||
          (record.credential.createdAt === input.position.createdAt &&
            record.credential.id > input.position.credentialId),
      )
      .sort(
        (left, right) =>
          left.credential.createdAt.localeCompare(right.credential.createdAt) ||
          left.credential.id.localeCompare(right.credential.id),
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }
}

const vaults = {
  find: async (input: { workspaceId: string; vaultId: string }) =>
    input.workspaceId === "workspace_01" && input.vaultId === "vlt_01"
      ? {
          id: input.vaultId,
          archivedAt: null,
          createdAt: "2026-08-26T18:00:00.000Z",
          displayName: "Production",
          metadata: {},
          updatedAt: "2026-08-26T18:00:00.000Z",
        }
      : null,
};

describe("CredentialsApplicationService", () => {
  it("persists write-only secrets while returning only an explicit redacted view", async () => {
    const persistence = new InMemoryCredentialPersistence();
    const service = new CredentialsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      vaults,
      validation: {
        validate: async () => ({
          hasRefreshToken: false,
          mcpProbe: null,
          refresh: null,
          status: "indeterminate" as const,
        }),
      },
      cliCatalog: { has: (cliId: string) => cliId === "gh" },
      clock: { now: () => new Date("2026-08-26T19:00:00.000Z") },
      ids: { nextCredentialId: () => "vcrd_01" },
    });

    const created = await service.createCredential({
      vaultId: "vlt_01",
      auth: {
        type: "static_bearer",
        token: "bearer-secret",
        mcpServerUrl: "https://mcp.example.com/sse",
      },
      displayName: "MCP bearer",
      metadata: { owner: "platform" },
    });

    expect(created).toEqual({
      type: "created",
      credential: {
        id: "vcrd_01",
        archivedAt: null,
        auth: {
          type: "static_bearer",
          mcpServerUrl: "https://mcp.example.com/sse",
        },
        createdAt: "2026-08-26T19:00:00.000Z",
        displayName: "MCP bearer",
        metadata: { owner: "platform" },
        updatedAt: "2026-08-26T19:00:00.000Z",
        vaultId: "vlt_01",
      },
    });
    expect(
      persistence.records.get("workspace_01:vlt_01:vcrd_01")?.credential.auth,
    ).toEqual({
      type: "static_bearer",
      token: "bearer-secret",
      mcpServerUrl: "https://mcp.example.com/sse",
    });
    expect(JSON.stringify(created)).not.toContain("bearer-secret");
  });

  it("patches the matching auth variant and rejects cross-variant updates", async () => {
    const persistence = new InMemoryCredentialPersistence();
    let now = new Date("2026-08-26T19:00:00.000Z");
    const service = new CredentialsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      vaults,
      validation: {
        validate: async () => ({
          hasRefreshToken: false,
          mcpProbe: null,
          refresh: null,
          status: "indeterminate" as const,
        }),
      },
      cliCatalog: { has: (cliId: string) => cliId === "gh" },
      clock: { now: () => now },
      ids: { nextCredentialId: () => "vcrd_01" },
    });
    await service.createCredential({
      vaultId: "vlt_01",
      auth: {
        type: "static_bearer",
        token: "old-secret",
        mcpServerUrl: "https://mcp.example.com/sse",
      },
      metadata: { obsolete: "yes" },
    });
    now = new Date("2026-08-26T20:00:00.000Z");

    await expect(
      service.updateCredential({
        vaultId: "vlt_01",
        credentialId: "vcrd_01",
        auth: { type: "static_bearer", token: "new-secret" },
        metadata: { obsolete: null, owner: "runtime" },
      }),
    ).resolves.toMatchObject({
      type: "updated",
      credential: { metadata: { owner: "runtime" } },
    });
    expect(
      persistence.records.get("workspace_01:vlt_01:vcrd_01")?.credential.auth,
    ).toMatchObject({ token: "new-secret" });

    await expect(
      service.updateCredential({
        vaultId: "vlt_01",
        credentialId: "vcrd_01",
        auth: {
          type: "environment_variable",
          secretValue: "wrong-kind",
        },
      }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Credential auth type is immutable",
    });
  });

  it("persists a refresh rotation without returning or logging the new secrets", async () => {
    const persistence = new InMemoryCredentialPersistence();
    const previousAccess = "previous-access-token-value";
    const previousRefresh = "previous-refresh-token-value";
    const rotatedAccess = "rotated-access-token-value";
    const rotatedRefresh = "rotated-refresh-token-value";
    const clientSecret = "rotated-client-secret-value";
    const secrets = [previousAccess, previousRefresh, rotatedAccess, rotatedRefresh, clientSecret];
    let attempts = 0;
    const replace = persistence.replace.bind(persistence);
    persistence.replace = async (input) => {
      attempts += 1;
      if (attempts === 1) {
        return { type: "revision_conflict", actualRevision: input.expectedRevision + 1 };
      }
      return replace(input);
    };
    const service = new CredentialsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      vaults,
      validation: {
        validate: async () => ({
          hasRefreshToken: true,
          mcpProbe: {
            response: {
              body: "expired [redacted]",
              bodyTruncated: false,
              contentType: "application/json",
              statusCode: 401,
            },
            method: "initialize",
          },
          refresh: { response: null, status: "succeeded" },
          status: "valid",
          rotation: {
            accessToken: rotatedAccess,
            refreshToken: rotatedRefresh,
            expiresAt: "2026-08-26T01:00:00.000Z",
          },
        }),
      },
      cliCatalog: { has: (cliId: string) => cliId === "gh" },
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextCredentialId: () => "vcrd_rotate" },
    });
    await service.createCredential({
      vaultId: "vlt_01",
      auth: {
        type: "mcp_oauth",
        accessToken: previousAccess,
        mcpServerUrl: "https://mcp.example.test/mcp",
        refresh: {
          clientId: "oauth-client",
          refreshToken: previousRefresh,
          tokenEndpoint: "https://auth.example.test/token",
          tokenEndpointAuth: { type: "client_secret_post", clientSecret },
        },
      },
    });

    const validated = await service.validateCredential({
      vaultId: "vlt_01",
      credentialId: "vcrd_rotate",
    });

    expect(attempts).toBe(2);
    expect(validated.type).toBe("validated");
    expect(JSON.stringify(validated).includes("rotation")).toBe(false);
    expect(secrets.some((secret) => JSON.stringify(validated).includes(secret))).toBe(false);
    const stored = persistence.records.get("workspace_01:vlt_01:vcrd_rotate")?.credential.auth;
    expect(stored?.type).toBe("mcp_oauth");
    if (stored?.type === "mcp_oauth") {
      expect(stored.accessToken === rotatedAccess).toBe(true);
      expect(stored.refresh?.refreshToken === rotatedRefresh).toBe(true);
      expect(stored.expiresAt).toBe("2026-08-26T01:00:00.000Z");
      expect(stored.refresh?.tokenEndpointAuth).toEqual({ type: "client_secret_post", clientSecret });
    }
  });

  it("keeps a store failure that contains credential material off the validation result", async () => {
    const persistence = new InMemoryCredentialPersistence();
    const secret = "store-failure-access-token";
    persistence.replace = async () => {
      throw new Error(`database rejected ${secret}`);
    };
    const service = new CredentialsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      vaults,
      validation: {
        validate: async () => ({
          hasRefreshToken: true,
          mcpProbe: null,
          refresh: { response: null, status: "succeeded" },
          status: "valid",
          rotation: {
            accessToken: secret,
            refreshToken: "store-failure-refresh-token",
            expiresAt: null,
          },
        }),
      },
      cliCatalog: { has: (cliId: string) => cliId === "gh" },
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextCredentialId: () => "vcrd_fail" },
    });
    await service.createCredential({
      vaultId: "vlt_01",
      auth: {
        type: "mcp_oauth",
        accessToken: "old-access-token-value",
        mcpServerUrl: "https://mcp.example.test/mcp",
        refresh: {
          clientId: "oauth-client",
          refreshToken: "old-refresh-token-value",
          tokenEndpoint: "https://auth.example.test/token",
          tokenEndpointAuth: { type: "none" },
        },
      },
    });

    try {
      const validated = await service.validateCredential({
        vaultId: "vlt_01",
        credentialId: "vcrd_fail",
      });
      expect(validated.type).toBe("validated");
      expect(JSON.stringify(validated).includes(secret)).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      throw new Error(
        message.includes(secret)
          ? "validation surfaced credential material"
          : "validation rejected a store failure",
      );
    }
  });

  describe("cap_cli (OpenMA extension)", () => {
    function capService(persistence: InMemoryCredentialPersistence) {
      let validations = 0;
      const service = new CredentialsApplicationService({
        workspaceId: "workspace_01",
        store: persistence,
        vaults,
        validation: {
          validate: async () => {
            validations += 1;
            throw new Error("cap_cli must never reach the MCP probe");
          },
        },
        cliCatalog: { has: (cliId: string) => cliId === "gh" },
        clock: { now: () => new Date("2026-08-26T19:00:00.000Z") },
        ids: { nextCredentialId: () => "vcrd_cap" },
      });
      return { service, validations: () => validations };
    }

    it("stores the tokens and returns a view without them", async () => {
      const persistence = new InMemoryCredentialPersistence();
      const { service } = capService(persistence);
      const created = await service.createCredential({
        vaultId: "vlt_01",
        auth: {
          type: "cap_cli",
          cliId: "gh",
          token: "gho_secret_token",
          refreshToken: "ghr_secret_refresh",
          expiresAt: "2026-08-27T19:00:00.000Z",
          extras: { scope: "repo" },
        },
      });
      expect(created).toEqual({
        type: "created",
        credential: {
          id: "vcrd_cap",
          archivedAt: null,
          auth: { type: "cap_cli", cliId: "gh", expiresAt: "2026-08-27T19:00:00.000Z" },
          createdAt: "2026-08-26T19:00:00.000Z",
          metadata: {},
          updatedAt: "2026-08-26T19:00:00.000Z",
          vaultId: "vlt_01",
        },
      });
      expect(persistence.records.get("workspace_01:vlt_01:vcrd_cap")?.credential.auth)
        .toEqual({
          type: "cap_cli",
          cliId: "gh",
          token: "gho_secret_token",
          refreshToken: "ghr_secret_refresh",
          expiresAt: "2026-08-27T19:00:00.000Z",
          extras: { scope: "repo" },
        });
      expect(JSON.stringify(created)).not.toContain("secret");
    });

    it("rejects a cli_id the CLI catalog does not know", async () => {
      const persistence = new InMemoryCredentialPersistence();
      const { service } = capService(persistence);
      expect(
        await service.createCredential({
          vaultId: "vlt_01",
          auth: { type: "cap_cli", cliId: "not-a-cli", token: "t" },
        }),
      ).toEqual({ type: "invalid_request", message: 'Unknown cap_cli cli_id "not-a-cli"' });
      expect(persistence.records.size).toBe(0);
    });

    it("rotates tokens in place, clears extras on null, and keeps cliId immutable", async () => {
      const persistence = new InMemoryCredentialPersistence();
      const { service } = capService(persistence);
      await service.createCredential({
        vaultId: "vlt_01",
        auth: { type: "cap_cli", cliId: "gh", token: "old", extras: { a: "b" } },
      });
      const updated = await service.updateCredential({
        vaultId: "vlt_01",
        credentialId: "vcrd_cap",
        auth: { type: "cap_cli", token: "new", refreshToken: "r2", extras: null },
      });
      expect(updated.type).toBe("updated");
      expect(persistence.records.get("workspace_01:vlt_01:vcrd_cap")?.credential.auth)
        .toEqual({ type: "cap_cli", cliId: "gh", token: "new", refreshToken: "r2" });
      expect(
        await service.updateCredential({
          vaultId: "vlt_01",
          credentialId: "vcrd_cap",
          auth: { type: "static_bearer", token: "x" },
        }),
      ).toEqual({ type: "invalid_request", message: "Credential auth type is immutable" });
    });

    it("refuses MCP validation without calling the probe", async () => {
      const persistence = new InMemoryCredentialPersistence();
      const { service, validations } = capService(persistence);
      await service.createCredential({
        vaultId: "vlt_01",
        auth: { type: "cap_cli", cliId: "gh", token: "t" },
      });
      expect(
        await service.validateCredential({ vaultId: "vlt_01", credentialId: "vcrd_cap" }),
      ).toEqual({
        type: "invalid_request",
        message: "cap_cli credentials are not MCP credentials and cannot be validated",
      });
      expect(validations()).toBe(0);
    });
  });
});
