import { describe, expect, it } from "vitest";
import type { TunnelAggregate } from "@open-managed-agents/domain/tunnels";
import { MemoryTunnelStore } from "../src/index";

function aggregate(id: string, createdAt: string): TunnelAggregate {
  return {
    tunnel: {
      id,
      archivedAt: null,
      createdAt,
      displayName: id,
      domain: `${id}.tunnels.test`,
      connectorTokenId: `token_${id}`,
    },
    certificates: [{
      id: `certificate_${id}`,
      archivedAt: null,
      createdAt,
      expiresAt: null,
      fingerprint: `fingerprint_${id}`,
      tunnelId: id,
    }],
  };
}

describe("MemoryTunnelStore", () => {
  it("isolates workspaces, returns detached aggregates, and pages newest first", async () => {
    const store = new MemoryTunnelStore();
    const older = aggregate("tnl_older", "2026-08-26T10:00:00.000Z");
    const newer = aggregate("tnl_newer", "2026-08-26T11:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", aggregate: older });
    await store.insert({ workspaceId: "workspace_01", aggregate: newer });
    await store.insert({ workspaceId: "workspace_02", aggregate: newer });

    const page = await store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 1,
    });
    expect(page).toEqual([{ aggregate: newer, revision: 1 }]);
    page[0]!.aggregate.tunnel.displayName = "mutated";
    await expect(store.find({ workspaceId: "workspace_01", tunnelId: "tnl_newer" }))
      .resolves.toEqual({ aggregate: newer, revision: 1 });
    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
      position: { createdAt: newer.tunnel.createdAt, tunnelId: newer.tunnel.id },
    })).resolves.toEqual([{ aggregate: older, revision: 1 }]);
  });

  it("replaces the whole aggregate under revision CAS and filters archives", async () => {
    const store = new MemoryTunnelStore();
    const current = aggregate("tnl_01", "2026-08-26T10:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", aggregate: current });
    const archivedAt = "2026-08-26T12:00:00.000Z";
    const next: TunnelAggregate = {
      tunnel: { ...current.tunnel, archivedAt },
      certificates: current.certificates.map((item) => ({ ...item, archivedAt })),
    };

    await expect(store.replace({
      workspaceId: "workspace_01",
      tunnelId: current.tunnel.id,
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { aggregate: next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      tunnelId: current.tunnel.id,
      expectedRevision: 1,
      next: current,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
    })).resolves.toEqual([]);
  });

  it("rejects certificates belonging to a different Tunnel", async () => {
    const store = new MemoryTunnelStore();
    const invalid = aggregate("tnl_01", "2026-08-26T10:00:00.000Z");
    invalid.certificates[0]!.tunnelId = "tnl_other";
    await expect(store.insert({ workspaceId: "workspace_01", aggregate: invalid }))
      .rejects.toThrow(/another Tunnel/u);
  });
});
