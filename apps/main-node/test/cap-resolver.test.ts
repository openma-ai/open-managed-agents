// Smoke for the oma-cap-adapter Node wire — verify a cap_cli credential
// resolves to the right token via the OmaVaultResolver. This is the
// resolver the future Node outbound proxy (mirroring CF's mcp-proxy) will
// hand to cap.handleHttp; testing here confirms the credential routing
// works in-process now even before that proxy lands.

import { describe, expect, it } from "vitest";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteVaultService } from "@open-managed-agents/vaults-store";
import { createSqliteCredentialService } from "@open-managed-agents/credentials-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { OmaVaultResolver, encodePrincipal } from "@open-managed-agents/oma-cap-adapter";

const TENANT = "tn_cap";

describe("OmaVaultResolver Node wire", () => {
  it("resolves a cap_cli credential bound to api.github.com", async () => {
    const { sql, db, cleanup } = await bootstrapTestDb();
    try {
    await sql
      .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
      .bind(TENANT, "Cap", Date.now(), Date.now())
      .run();

    const agents = createSqliteAgentService({ db });
    const vaults = createSqliteVaultService({ db });
    const credentials = createSqliteCredentialService({ db });
    const sessions = createSqliteSessionService({ db });

    const agentRow = await agents.create({
      tenantId: TENANT,
      input: { name: "Cap Agent", model: "claude-haiku-4-5-20251001" },
    });
    const vault = await vaults.create({ tenantId: TENANT, name: "GitHub vault" });
    await credentials.create({
      tenantId: TENANT,
      vaultId: vault.id,
      displayName: "gh CLI token",
      auth: {
        type: "cap_cli",
        cli_id: "gh",
        token: "ghs_test_TOKEN_value",
        provider: "github",
      },
    });
    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: agentRow.id,
      environmentId: "env-local-runtime",
      title: "cap test",
      vaultIds: [vault.id],
      agentSnapshot: agentRow as never,
      environmentSnapshot: { id: "env-local-runtime", runtime: "local", sandbox_template: null } as never,
    });

    const resolver = new OmaVaultResolver({
      sessions: {
        get: ({ tenantId, sessionId }) => sessions.get({ tenantId, sessionId }) as never,
      },
      credentials: {
        listByVaults: ({ tenantId, vaultIds }) =>
          credentials.listByVaults({ tenantId, vaultIds }) as never,
        update: ({ tenantId, vaultId, credentialId, auth }) =>
          credentials.update({ tenantId, vaultId, credentialId, auth }) as never,
        create: ({ tenantId, vaultId, displayName, auth }) =>
          credentials.create({ tenantId, vaultId, displayName, auth }) as never,
      },
    });

    const principal = encodePrincipal(TENANT, session.id);
    const resolved = await resolver.resolve({
      principal,
      cli_id: "gh",
      hostname: "api.github.com",
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.token).toBe("ghs_test_TOKEN_value");

    // Different cli_id should miss.
    const miss = await resolver.resolve({
      principal,
      cli_id: "aws",
      hostname: "ec2.amazonaws.com",
    });
    expect(miss).toBeNull();
    } finally {
      cleanup();
    }
  });
});
