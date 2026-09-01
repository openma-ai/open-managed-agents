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
});
