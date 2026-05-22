import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { credentials } from "@open-managed-agents/db-schema/cf-auth";
import type { CredentialAuth } from "@open-managed-agents/shared";
import { CredentialDuplicateMcpUrlError, CredentialNotFoundError } from "../errors";
import type {
  CredentialRepo,
  CredentialUpdateFields,
  Crypto,
  NewCredentialInput,
} from "../ports";
import type { CredentialRow } from "../types";


/**
 * Drizzle implementation of {@link CredentialRepo}. Owns the queries against
 * the `credentials` table defined in apps/main/migrations/0009_credentials_table.sql.
 *
 * Hot fields (auth_type, mcp_server_url, provider) are denormalized into their
 * own columns for indexing; the full CredentialAuth lives in the `auth` JSON
 * column. Writers must keep them in sync.
 *
 * The `auth` column is encrypted via the {@link Crypto} port. The denormalized
 * hot-path columns stay plaintext (they're SQL index keys, not secrets).
 * See ports.ts for the rationale on placing crypto at the repo layer.
 */
export class SqlCredentialRepo implements CredentialRepo {
  private readonly db: OmaDbBuilder;
  private readonly crypto: Crypto;

  constructor(db: OmaDb, opts?: { crypto?: Crypto }) {
    this.db = asBuilder(db);
    this.crypto = opts?.crypto ?? identityCrypto;
  }

  async insert(input: NewCredentialInput): Promise<CredentialRow> {
    const authCipher = await this.crypto.encrypt(JSON.stringify(input.auth));
    // Pre-check the partial unique index condition. Cheaper than rolling
    // back a failed INSERT and dialect-blind (the prior try/catch sniffed
    // the driver's "UNIQUE constraint failed" message string, which broke
    // after the Drizzle port wrapped errors and changed the format).
    // Concurrent inserts of the same URL still race past this check, but
    // the partial unique index catches the second one at INSERT time and
    // bubbles as 500 — rare (the UI never races credentials).
    if (input.auth.mcp_server_url) {
      const existing = await getOne<{ id: string }>(
        this.db
          .select({ id: credentials.id })
          .from(credentials)
          .where(
            and(
              eq(credentials.tenant_id, input.tenantId),
              eq(credentials.vault_id, input.vaultId),
              eq(credentials.mcp_server_url, input.auth.mcp_server_url),
              isNull(credentials.archived_at),
            ),
          )
          .limit(1),
      );
      if (existing) throw new CredentialDuplicateMcpUrlError();
    }
    await runOnce(
      this.db.insert(credentials).values({
        id: input.id,
        tenant_id: input.tenantId,
        vault_id: input.vaultId,
        display_name: input.displayName,
        auth_type: input.auth.type,
        mcp_server_url: input.auth.mcp_server_url ?? null,
        provider: input.auth.provider ?? null,
        auth: authCipher,
        created_at: input.createdAt,
      }),
    );
    const row = await this.get(input.tenantId, input.vaultId, input.id);
    if (!row) throw new Error("credential vanished after insert");
    return row;
  }

  async get(
    tenantId: string,
    vaultId: string,
    credentialId: string,
  ): Promise<CredentialRow | null> {
    const row = await getOne<typeof credentials.$inferSelect>(
      this.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
          ),
        ),
    );
    return row ? await this.toRow(row) : null;
  }

  async getRaw(
    tenantId: string,
    vaultId: string,
    credentialId: string,
  ): Promise<{ row: CredentialRow; authCipher: string } | null> {
    const row = await getOne<typeof credentials.$inferSelect>(
      this.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
          ),
        ),
    );
    if (!row) return null;
    return { row: await this.toRow(row), authCipher: row.auth };
  }

  async updateIfAuthMatches(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    expectedAuthCipher: string,
    update: CredentialUpdateFields,
  ): Promise<CredentialRow | null> {
    if (update.auth === undefined) {
      throw new Error("updateIfAuthMatches requires update.auth — call update() for non-auth field changes");
    }
    const authCipher = await this.crypto.encrypt(JSON.stringify(update.auth));
    // CAS lost: another in-flight refresh persisted first. Caller's
    // contract is to re-read and use the winner's token, so we return
    // null instead of throwing — this isn't an error condition, it's
    // an expected race outcome that the caller routes around.
    //
    // Drizzle SQLite/PG run() doesn't reliably surface rowsAffected via the
    // OmaDb union, so we check the current row's auth ciphertext after the
    // UPDATE — the winner's ciphertext will not equal expectedAuthCipher.
    const existing = await this.getRaw(tenantId, vaultId, credentialId);
    if (!existing) return null;
    if (existing.authCipher !== expectedAuthCipher) return null;
    await runOnce(
      this.db
        .update(credentials)
        .set({
          auth_type: update.auth.type,
          mcp_server_url: update.auth.mcp_server_url ?? null,
          provider: update.auth.provider ?? null,
          auth: authCipher,
          updated_at: update.updatedAt,
        })
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
            eq(credentials.auth, expectedAuthCipher),
          ),
        ),
    );
    // Re-read to confirm we won the CAS. If another writer slipped in between
    // our pre-check and the UPDATE, our auth predicate failed and the row
    // still has someone else's ciphertext — return null in that case.
    const after = await this.getRaw(tenantId, vaultId, credentialId);
    if (!after) return null;
    if (after.authCipher !== authCipher) return null;
    return after.row;
  }

  async list(
    tenantId: string,
    vaultId: string,
    opts: { includeArchived: boolean },
  ): Promise<CredentialRow[]> {
    const conds = [
      eq(credentials.tenant_id, tenantId),
      eq(credentials.vault_id, vaultId),
    ];
    if (!opts.includeArchived) conds.push(isNull(credentials.archived_at));
    const rows = await getAll<typeof credentials.$inferSelect>(
      this.db
        .select()
        .from(credentials)
        .where(and(...conds))
        .orderBy(asc(credentials.created_at)),
    );
    return await this.toRows(rows);
  }

  async countAll(tenantId: string, vaultId: string): Promise<number> {
    const row = await getOne<{ c: number }>(
      this.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(credentials)
        .where(
          and(
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
          ),
        ),
    );
    return row?.c ?? 0;
  }

  async findActiveByMcpUrl(
    tenantId: string,
    vaultId: string,
    mcpServerUrl: string,
  ): Promise<CredentialRow | null> {
    const row = await getOne<typeof credentials.$inferSelect>(
      this.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
            eq(credentials.mcp_server_url, mcpServerUrl),
            isNull(credentials.archived_at),
          ),
        )
        .limit(1),
    );
    return row ? await this.toRow(row) : null;
  }

  async listByVaults(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const rows = await getAll<typeof credentials.$inferSelect>(
      this.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.tenant_id, tenantId),
            inArray(credentials.vault_id, vaultIds),
          ),
        )
        .orderBy(asc(credentials.vault_id), asc(credentials.created_at)),
    );
    return await this.toRows(rows);
  }

  async listProviderTagged(tenantId: string, vaultIds: string[]): Promise<CredentialRow[]> {
    if (!vaultIds.length) return [];
    const rows = await getAll<typeof credentials.$inferSelect>(
      this.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.tenant_id, tenantId),
            inArray(credentials.vault_id, vaultIds),
            isNull(credentials.archived_at),
            isNotNull(credentials.provider),
          ),
        ),
    );
    return await this.toRows(rows);
  }

  async update(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    update: CredentialUpdateFields,
  ): Promise<CredentialRow> {
    // Pre-check existence — Drizzle's run() result shape is dialect-specific,
    // so we read first to throw a domain error if the row is missing.
    const existing = await this.get(tenantId, vaultId, credentialId);
    if (!existing) throw new CredentialNotFoundError();

    const set: Record<string, unknown> = { updated_at: update.updatedAt };
    if (update.displayName !== undefined) {
      set.display_name = update.displayName;
    }
    if (update.auth !== undefined) {
      // Keep denormalized columns in sync with the JSON blob. mcp_server_url
      // is immutable per service-layer check, but we still rewrite it for
      // correctness if a caller ever bypasses the service. The JSON blob is
      // encrypted; the denormalized columns stay plaintext for indexing.
      const authCipher = await this.crypto.encrypt(JSON.stringify(update.auth));
      set.auth_type = update.auth.type;
      set.mcp_server_url = update.auth.mcp_server_url ?? null;
      set.provider = update.auth.provider ?? null;
      set.auth = authCipher;
    }
    await runOnce(
      this.db
        .update(credentials)
        .set(set)
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
          ),
        ),
    );
    const row = await this.get(tenantId, vaultId, credentialId);
    if (!row) throw new CredentialNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    vaultId: string,
    credentialId: string,
    archivedAt: number,
  ): Promise<CredentialRow> {
    const existing = await this.get(tenantId, vaultId, credentialId);
    if (!existing) throw new CredentialNotFoundError();
    await runOnce(
      this.db
        .update(credentials)
        .set({ archived_at: archivedAt, updated_at: archivedAt })
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
          ),
        ),
    );
    const row = await this.get(tenantId, vaultId, credentialId);
    if (!row) throw new CredentialNotFoundError();
    return row;
  }

  async archiveByVault(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<void> {
    // Single UPDATE replaces the KV list+loop in the old vaults.ts:91-104.
    // Atomic by D1 default, no FK needed — soft FK on vault_id is enough.
    await runOnce(
      this.db
        .update(credentials)
        .set({ archived_at: archivedAt, updated_at: archivedAt })
        .where(
          and(
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
            isNull(credentials.archived_at),
          ),
        ),
    );
  }

  async delete(tenantId: string, vaultId: string, credentialId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(credentials)
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.tenant_id, tenantId),
            eq(credentials.vault_id, vaultId),
          ),
        ),
    );
  }

  private async toRow(r: typeof credentials.$inferSelect): Promise<CredentialRow> {
    const authJson = await this.crypto.decrypt(r.auth);
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      vault_id: r.vault_id,
      display_name: r.display_name,
      auth: JSON.parse(authJson) as CredentialAuth,
      created_at: msToIso(r.created_at),
      updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
      archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
    };
  }

  private async toRows(rs: (typeof credentials.$inferSelect)[]): Promise<CredentialRow[]> {
    return Promise.all(rs.map((r) => this.toRow(r)));
  }
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Identity (passthrough) crypto — used as the default when callers don't wire
 * a real one. Matches the legacy plaintext-on-disk behavior so existing tests
 * keep working without ceremony. Production wiring MUST override this.
 */
const identityCrypto: Crypto = {
  async encrypt(plaintext) {
    return plaintext;
  },
  async decrypt(ciphertext) {
    return ciphertext;
  },
};
