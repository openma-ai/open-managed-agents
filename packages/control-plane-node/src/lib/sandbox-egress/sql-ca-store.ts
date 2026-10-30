import type { SqlClient } from "@open-managed-agents/sql-client";
import type { PurposeCipher } from "../../secrets.js";
import type { EgressCaMaterial, EgressCaStore } from "./ca-store.js";

// Deployment-owned row, outside workspace KV namespaces. No TTL: losing this
// material changes the trust anchor of every already-prepared sandbox.
const TENANT = "__platform__";
const KEY = "sandbox-egress.ca.v1";

/** Encrypted shared CA in the existing platform KV table (no schema changes). */
export class SqlEgressCaStore implements EgressCaStore {
  constructor(private readonly sql: SqlClient, private readonly cipher: PurposeCipher) {}

  async load(): Promise<EgressCaMaterial | null> {
    const row = await this.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id = ? AND "key" = ?')
      .bind(TENANT, KEY).first<{ value: string }>();
    if (row === null) return null;
    let material: unknown;
    try {
      material = JSON.parse(await this.cipher.decrypt(row.value));
    } catch {
      // JSON/decryption exceptions may contain fragments of private material.
      throw new Error("Cannot decode persisted sandbox egress CA material");
    }
    if (typeof material !== "object" || material === null
      || !("cert" in material) || typeof material.cert !== "string" || material.cert === ""
      || !("key" in material) || typeof material.key !== "string" || material.key === "") {
      throw new Error("Invalid persisted sandbox egress CA material");
    }
    return { cert: material.cert, key: material.key };
  }

  async createIfAbsent(material: EgressCaMaterial): Promise<void> {
    const value = await this.cipher.encrypt(JSON.stringify(material));
    await this.sql.prepare(`INSERT INTO kv_entries (tenant_id, "key", value, expires_at)
      VALUES (?, ?, ?, NULL) ON CONFLICT (tenant_id, "key") DO NOTHING`)
      .bind(TENANT, KEY, value).run();
  }
}
