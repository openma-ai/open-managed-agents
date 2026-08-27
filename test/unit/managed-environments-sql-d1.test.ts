import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../test-worker";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  SqlEnvironmentPersistence,
  SqlSessionEnvironmentSource,
} from "@open-managed-agents/managed-agents-adapters-sql";
import type { Environment } from "@open-managed-agents/managed-agents-application";

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

const environment: Environment = {
  id: "env_d1_contract",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T23:00:00.000Z",
  description: null,
  metadata: {},
  name: "D1 environment",
  updatedAt: "2026-08-26T23:00:00.000Z",
};

beforeAll(async () => {
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

describe("Managed Environment SQL adapters on Cloudflare D1", () => {
  it("uses the deployed isolated table and Session dependency source", async () => {
    const client = new CfD1SqlClient(db());
    const persistence = new SqlEnvironmentPersistence(client);
    const source = new SqlSessionEnvironmentSource(client);
    await persistence.insert({
      workspaceId: "workspace_d1_environments",
      environment,
    });
    await expect(
      source.find({
        workspaceId: "workspace_d1_environments",
        environmentId: environment.id,
      }),
    ).resolves.toEqual(environment);
  });
});
