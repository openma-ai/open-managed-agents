import { describe, expect, it } from "vitest";
import type {
  StoredTunnelAggregate,
  TunnelStore,
} from "@open-managed-agents/tunnel-store";
import {
  TunnelCertificatesApplicationService,
  TunnelsApplicationService,
  type Tunnel,
  type TunnelCertificate,
  type TunnelCertificateAuthorityPort,
  type TunnelProvisionerPort,
  type TunnelTokenManagerPort,
} from "../src";

const tunnel = {
  id: "tnl_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:10:00.000Z",
  displayName: "Production gateway",
  domain: "tnl-01.tunnels.openma.test",
  connectorTokenId: "ttok_01",
} satisfies Tunnel;

const certificate = {
  id: "tcrt_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:05:00.000Z",
  expiresAt: "2027-08-26T10:05:00.000Z",
  fingerprint: "0123456789abcdef",
  tunnelId: tunnel.id,
} satisfies TunnelCertificate;

const stored = {
  aggregate: { tunnel, certificates: [certificate] },
  revision: 3,
} satisfies StoredTunnelAggregate;

function dependencies(overrides: {
  store?: Partial<TunnelStore>;
  provisioner?: Partial<TunnelProvisionerPort>;
  tokens?: Partial<TunnelTokenManagerPort>;
  certificateAuthority?: Partial<TunnelCertificateAuthorityPort>;
} = {}) {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name} call`);
  };
  return {
    workspaceId: "workspace_01",
    store: {
      insert: unexpected("insert Tunnel"),
      find: unexpected("find Tunnel"),
      list: unexpected("list Tunnels"),
      replace: unexpected("replace Tunnel"),
      ...overrides.store,
    } satisfies TunnelStore,
    provisioner: {
      provision: unexpected("provision Tunnel"),
      archive: unexpected("archive Tunnel infrastructure"),
      ...overrides.provisioner,
    } satisfies TunnelProvisionerPort,
    tokens: {
      reveal: unexpected("reveal Tunnel token"),
      rotate: unexpected("rotate Tunnel token"),
      ...overrides.tokens,
    } satisfies TunnelTokenManagerPort,
    certificateAuthority: {
      register: unexpected("register Tunnel certificate"),
      archive: unexpected("archive Tunnel certificate"),
      ...overrides.certificateAuthority,
    } satisfies TunnelCertificateAuthorityPort,
    clock: { now: () => new Date("2026-08-26T10:10:00.000Z") },
    ids: {
      nextTunnelId: () => "tnl_01",
      nextTunnelCertificateId: () => "tcrt_02",
    },
  };
}

describe("Tunnels application", () => {
  it("persists the complete aggregate returned by the provisioning boundary", async () => {
    const provisionCalls: object[] = [];
    const insertCalls: object[] = [];
    const deps = dependencies({
      provisioner: {
        provision: async (input) => {
          provisionCalls.push(input);
          return {
            type: "provisioned",
            domain: tunnel.domain,
            connectorTokenId: tunnel.connectorTokenId,
          };
        },
      },
      store: {
        insert: async (input) => {
          insertCalls.push(input);
          return { aggregate: input.aggregate, revision: 1 };
        },
      },
    });
    const service = new TunnelsApplicationService(deps);

    await expect(
      service.createTunnel({ displayName: tunnel.displayName }),
    ).resolves.toEqual({ type: "created", tunnel });
    expect(provisionCalls).toEqual([
      { workspaceId: "workspace_01", tunnelId: "tnl_01" },
    ]);
    expect(insertCalls).toEqual([
      {
        workspaceId: "workspace_01",
        aggregate: { tunnel, certificates: [] },
      },
    ]);
  });

  it("archives a Tunnel and every certificate in one aggregate CAS", async () => {
    const infrastructureCalls: object[] = [];
    const replaceCalls: object[] = [];
    const deps = dependencies({
      store: {
        find: async () => stored,
        replace: async (input) => {
          replaceCalls.push(input);
          return { type: "replaced", record: { aggregate: input.next, revision: 4 } };
        },
      },
      provisioner: {
        archive: async (input) => {
          infrastructureCalls.push(input);
        },
      },
    });
    const service = new TunnelsApplicationService(deps);

    await expect(service.archiveTunnel({ tunnelId: tunnel.id })).resolves.toEqual({
      type: "archived",
      tunnel: { ...tunnel, archivedAt: "2026-08-26T10:10:00.000Z" },
    });
    expect(infrastructureCalls).toEqual([
      { workspaceId: "workspace_01", tunnel },
    ]);
    expect(replaceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        tunnelId: tunnel.id,
        expectedRevision: 3,
        next: {
          tunnel: { ...tunnel, archivedAt: "2026-08-26T10:10:00.000Z" },
          certificates: [
            { ...certificate, archivedAt: "2026-08-26T10:10:00.000Z" },
          ],
        },
      },
    ]);
  });

  it("rotates the live token and persists only its new identifier", async () => {
    const tokenCalls: object[] = [];
    const replaceCalls: object[] = [];
    const deps = dependencies({
      store: {
        find: async () => stored,
        replace: async (input) => {
          replaceCalls.push(input);
          return { type: "replaced", record: { aggregate: input.next, revision: 4 } };
        },
      },
      tokens: {
        rotate: async (input) => {
          tokenCalls.push(input);
          return {
            type: "available",
            token: { id: "ttok_02", token: "live-secret-token" },
          };
        },
      },
    });
    const service = new TunnelsApplicationService(deps);

    await expect(
      service.rotateTunnelToken({
        tunnelId: tunnel.id,
        reason: "Scheduled rotation",
      }),
    ).resolves.toEqual({
      type: "rotated",
      token: { id: "ttok_02", token: "live-secret-token" },
    });
    expect(tokenCalls).toEqual([
      {
        workspaceId: "workspace_01",
        tunnel,
        reason: "Scheduled rotation",
      },
    ]);
    expect(replaceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        tunnelId: tunnel.id,
        expectedRevision: 3,
        next: {
          ...stored.aggregate,
          tunnel: { ...tunnel, connectorTokenId: "ttok_02" },
        },
      },
    ]);
  });

  it("registers a certificate through a dedicated CA Port before aggregate CAS", async () => {
    const authorityCalls: object[] = [];
    const replaceCalls: object[] = [];
    const deps = dependencies({
      store: {
        find: async () => ({
          aggregate: { tunnel, certificates: [] },
          revision: 1,
        }),
        replace: async (input) => {
          replaceCalls.push(input);
          return { type: "replaced", record: { aggregate: input.next, revision: 2 } };
        },
      },
      certificateAuthority: {
        register: async (input) => {
          authorityCalls.push(input);
          return {
            type: "registered",
            expiresAt: certificate.expiresAt,
            fingerprint: certificate.fingerprint,
          };
        },
      },
    });
    const service = new TunnelCertificatesApplicationService(deps);

    await expect(
      service.createTunnelCertificate({
        tunnelId: tunnel.id,
        caCertificatePem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      }),
    ).resolves.toEqual({
      type: "created",
      certificate: {
        ...certificate,
        id: "tcrt_02",
        createdAt: "2026-08-26T10:10:00.000Z",
      },
    });
    expect(authorityCalls).toEqual([
      {
        workspaceId: "workspace_01",
        tunnel,
        certificateId: "tcrt_02",
        caCertificatePem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      },
    ]);
    expect(replaceCalls[0]).toMatchObject({
      workspaceId: "workspace_01",
      tunnelId: tunnel.id,
      expectedRevision: 1,
      next: {
        tunnel,
        certificates: [{ id: "tcrt_02", fingerprint: certificate.fingerprint }],
      },
    });
  });
});
