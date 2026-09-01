import { beforeEach, describe, expect, it } from "vitest";
import type { TunnelAggregate } from "@open-managed-agents/domain/tunnels";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlTunnelStore } from "../src/index";

const SCHEMA = `
CREATE TABLE managed_tunnels (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_tunnels_workspace_created_id
  ON managed_tunnels (workspace_id, created_at, id);
`;

const aggregate: TunnelAggregate = {
  tunnel: {
    id: "tnl_01",
    archivedAt: null,
    createdAt: "2026-08-26T10:00:00.000Z",
    displayName: "Production gateway",
    domain: "tnl-01.tunnels.openma.test",
    connectorTokenId: "ttok_01",
  },
  certificates: [{
    id: "tcrt_01",
    archivedAt: null,
    createdAt: "2026-08-26T10:05:00.000Z",
    expiresAt: "2027-08-26T10:05:00.000Z",
    fingerprint: "0123456789abcdef",
    tunnelId: "tnl_01",
  }],
};

describe("SqlTunnelStore", () => {
  let client: SqlClient;
  let store: SqlTunnelStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    store = new SqlTunnelStore(client);
  });

  it("stores the full aggregate with workspace isolation", async () => {
    await expect(store.insert({ workspaceId: "workspace_01", aggregate }))
      .resolves.toEqual({ aggregate, revision: 1 });
    await expect(store.find({ workspaceId: "workspace_other", tunnelId: "tnl_01" }))
      .resolves.toBeNull();
    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
    })).resolves.toEqual([{ aggregate, revision: 1 }]);
  });

  it("atomically replaces Tunnel and certificates under one CAS", async () => {
    await store.insert({ workspaceId: "workspace_01", aggregate });
    const archivedAt = "2026-08-26T11:00:00.000Z";
    const next: TunnelAggregate = {
      tunnel: { ...aggregate.tunnel, archivedAt },
      certificates: aggregate.certificates.map((item) => ({ ...item, archivedAt })),
    };
    await expect(store.replace({
      workspaceId: "workspace_01",
      tunnelId: "tnl_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { aggregate: next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      tunnelId: "tnl_01",
      expectedRevision: 1,
      next: aggregate,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });
});
