import { beforeEach, describe, expect, it } from "vitest";
import type { Credential } from "@open-managed-agents/domain/credentials";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  SqlCredentialStore,
  type CredentialDocumentCipher,
} from "../src/index";

const SCHEMA_SQL = `
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

class TestCipher implements CredentialDocumentCipher {
  async seal(input: { plaintext: string }) {
    return { ciphertext: `sealed:${btoa(input.plaintext)}` };
  }

  async open(input: { ciphertext: string }) {
    return { plaintext: atob(input.ciphertext.slice("sealed:".length)) };
  }
}

function credential(id: string, createdAt: string): Credential {
  return {
    id,
    archivedAt: null,
    auth: {
      type: "static_bearer",
      token: `${id}-secret`,
      mcpServerUrl: "https://mcp.example.com/sse",
    },
    createdAt,
    metadata: {},
    updatedAt: createdAt,
    vaultId: "vlt_01",
  };
}

describe("SqlCredentialStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("seals the complete aggregate and preserves scoped CAS/list behavior", async () => {
    const store = new SqlCredentialStore(client, new TestCipher());
    const first = credential("vcrd_01", "2026-08-26T10:00:00.000Z");
    const second = credential("vcrd_02", "2026-08-26T11:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", credential: first });
    await store.insert({ workspaceId: "workspace_01", credential: second });
    await store.insert({ workspaceId: "workspace_02", credential: first });

    const raw = await client.prepare(
      "SELECT sealed_document FROM managed_credentials WHERE workspace_id = ? AND id = ?",
    ).bind("workspace_01", first.id).first<{ sealed_document: string }>();
    expect(raw?.sealed_document).toMatch(/^sealed:/);
    expect(raw?.sealed_document).not.toContain("vcrd_01-secret");

    const next = {
      ...first,
      auth: { ...first.auth, token: "rotated-secret" },
      updatedAt: "2026-08-26T12:00:00.000Z",
    };
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      credentialId: first.id,
      expectedRevision: 1,
      next,
    })).resolves.toMatchObject({
      type: "replaced",
      record: { revision: 2, credential: { auth: { token: "rotated-secret" } } },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      credentialId: first.id,
      expectedRevision: 1,
      next,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.list({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      limit: 10,
      includeArchived: false,
      position: { createdAt: first.createdAt, credentialId: first.id },
    })).resolves.toEqual([{ credential: second, revision: 1 }]);
    await expect(store.find({
      workspaceId: "workspace_02",
      vaultId: "vlt_01",
      credentialId: first.id,
    })).resolves.toEqual({ credential: first, revision: 1 });
  });
});
