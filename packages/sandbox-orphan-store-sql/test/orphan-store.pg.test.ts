import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";

import { getStorageIntegrationConfig } from "../../../test/storage-integration";
import { ensureRuntimeOrphanSchema, SqlRuntimeOrphanPort } from "../src/index";

const url = getStorageIntegrationConfig().postgres.runtimeOrphans;
let connection: ReturnType<typeof postgres>;
let sql: PostgresSqlClient;

beforeAll(async () => {
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing runtime orphan test against non-loopback PostgreSQL");
  }
  connection = postgres(url, {
    max: 2,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => value.toString(),
        parse: (value: string) => Number(value),
      },
    },
  });
  sql = new PostgresSqlClient(
    connection as unknown as ConstructorParameters<typeof PostgresSqlClient>[0],
  );
  await ensureRuntimeOrphanSchema(sql);
  await sql.prepare("DELETE FROM runtime_resource_orphans").run();
});

afterAll(async () => connection.end({ timeout: 5 }));

describe("SqlRuntimeOrphanPort on PostgreSQL", () => {
  it("round-trips the provider-neutral orphan retry queue", async () => {
    const orphans = new SqlRuntimeOrphanPort(sql);
    const scope = {
      workspaceId: "pg-orphan-workspace",
      environmentId: "pg-orphan-environment",
      sessionId: "pg-orphan-session",
      workId: "pg-orphan-work",
    };
    await orphans.enqueue({
      scope,
      generation: 7,
      ownerId: "pg-orphan-owner",
      sandbox: { provider: "docker", runtimeId: "pg-orphan-runtime" },
      reason: "lease_lost",
      error: new Error("partition"),
    });
    const [record] = await orphans.list({ limit: 10 });
    expect(record).toMatchObject({ scope, generation: 7, attempts: 0 });
    await orphans.resolve({ id: record!.id });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([]);
  });
});
