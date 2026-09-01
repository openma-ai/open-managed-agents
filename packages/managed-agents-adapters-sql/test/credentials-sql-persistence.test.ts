import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Credential,
  Vault,
} from "@open-managed-agents/managed-agents-application";
import {
  SqlCredentialPersistence,
  SqlCredentialVaultSource,
  type CredentialDocumentCipher,
} from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_vaults (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_credentials (
  workspace_id text NOT NULL,
  vault_id text NOT NULL,
  id text NOT NULL,
  sealed_document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_credentials_workspace_vault_created_id
  ON managed_credentials (workspace_id, vault_id, created_at, id);
`;

class TestCredentialDocumentCipher implements CredentialDocumentCipher {
  async seal(input: { plaintext: string }) {
    return { ciphertext: `sealed:${btoa(input.plaintext)}` };
  }

  async open(input: { ciphertext: string }) {
    if (!input.ciphertext.startsWith("sealed:")) {
      throw new Error("Unexpected credential ciphertext");
    }
    return { plaintext: atob(input.ciphertext.slice("sealed:".length)) };
  }
}

const credential = (
  id: string,
  createdAt: string,
  token = "bearer-secret",
): Credential => ({
  id,
  archivedAt: null,
  auth: {
    type: "static_bearer",
    token,
    mcpServerUrl: "https://mcp.example.com/sse",
  },
  createdAt,
  displayName: "MCP bearer",
  metadata: { owner: "platform" },
  updatedAt: createdAt,
  vaultId: "vlt_01",
});

describe("SqlCredentialPersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("stores only sealed credential documents and restores the complete aggregate", async () => {
    const persistence = new SqlCredentialPersistence(
      client,
      new TestCredentialDocumentCipher(),
    );
    const initial = credential("vcrd_01", "2026-08-26T18:00:00.000Z");

    await expect(
      persistence.insert({ workspaceId: "workspace_01", credential: initial }),
    ).resolves.toEqual({ credential: initial, revision: 1 });

    const raw = await client
      .prepare(
        `SELECT sealed_document
           FROM managed_credentials
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind("workspace_01", initial.id)
      .first<{ sealed_document: string }>();
    expect(raw?.sealed_document).toMatch(/^sealed:/);
    expect(raw?.sealed_document).not.toContain("bearer-secret");
    expect(raw?.sealed_document).not.toContain("mcp.example.com");
    await expect(
      persistence.find({
        workspaceId: "workspace_01",
        vaultId: "vlt_01",
        credentialId: initial.id,
      }),
    ).resolves.toEqual({ credential: initial, revision: 1 });
    await expect(
      persistence.find({
        workspaceId: "workspace_other",
        vaultId: "vlt_01",
        credentialId: initial.id,
      }),
    ).resolves.toBeNull();
  });

  it("replaces with compare-and-swap and pages within workspace and Vault scope", async () => {
    const persistence = new SqlCredentialPersistence(
      client,
      new TestCredentialDocumentCipher(),
    );
    const first = credential("vcrd_01", "2026-08-26T18:00:00.000Z");
    const second = credential(
      "vcrd_02",
      "2026-08-26T19:00:00.000Z",
      "second-secret",
    );
    await persistence.insert({ workspaceId: "workspace_01", credential: first });
    await persistence.insert({ workspaceId: "workspace_01", credential: second });
    await persistence.insert({ workspaceId: "workspace_other", credential: first });

    if (first.auth.type !== "static_bearer") {
      throw new Error("Test fixture must use static bearer auth");
    }
    const next = {
      ...first,
      auth: { ...first.auth, token: "rotated-secret" },
      updatedAt: "2026-08-26T20:00:00.000Z",
    } satisfies Credential;
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        vaultId: "vlt_01",
        credentialId: first.id,
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { credential: next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        vaultId: "vlt_01",
        credentialId: first.id,
        expectedRevision: 1,
        next: first,
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        vaultId: "vlt_01",
        limit: 10,
        includeArchived: false,
        position: { createdAt: first.createdAt, credentialId: first.id },
      }),
    ).resolves.toEqual([{ credential: second, revision: 1 }]);
  });

  it("archives and deletes without crossing workspace scope", async () => {
    const persistence = new SqlCredentialPersistence(
      client,
      new TestCredentialDocumentCipher(),
    );
    const initial = credential("vcrd_01", "2026-08-26T18:00:00.000Z");
    await persistence.insert({ workspaceId: "workspace_01", credential: initial });
    await persistence.insert({ workspaceId: "workspace_other", credential: initial });

    await expect(
      persistence.archive({
        workspaceId: "workspace_01",
        vaultId: "vlt_01",
        credentialId: initial.id,
        archivedAt: "2026-08-26T20:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      type: "archived",
      record: { credential: { archivedAt: "2026-08-26T20:00:00.000Z" } },
    });
    await expect(
      persistence.delete({
        workspaceId: "workspace_01",
        vaultId: "vlt_01",
        credentialId: initial.id,
      }),
    ).resolves.toEqual({ type: "deleted" });
    await expect(
      persistence.find({
        workspaceId: "workspace_other",
        vaultId: "vlt_01",
        credentialId: initial.id,
      }),
    ).resolves.not.toBeNull();
  });
});

describe("SqlCredentialVaultSource", () => {
  it("returns the complete workspace-scoped Vault snapshot", async () => {
    const client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    const vault: Vault = {
      id: "vlt_01",
      archivedAt: null,
      createdAt: "2026-08-26T18:00:00.000Z",
      displayName: "Production",
      metadata: { owner: "platform" },
      updatedAt: "2026-08-26T18:00:00.000Z",
    };
    await client
      .prepare(
        `INSERT INTO managed_vaults
          (workspace_id, id, document, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        vault.id,
        JSON.stringify(vault),
        1,
        Date.parse(vault.createdAt),
        Date.parse(vault.updatedAt),
        null,
      )
      .run();
    const source = new SqlCredentialVaultSource(client);

    await expect(
      source.find({ workspaceId: "workspace_01", vaultId: vault.id }),
    ).resolves.toEqual(vault);
    await expect(
      source.find({ workspaceId: "workspace_other", vaultId: vault.id }),
    ).resolves.toBeNull();
  });
});
