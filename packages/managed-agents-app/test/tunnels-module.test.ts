import { describe, expect, it } from "vitest";
import { MemoryTunnelStore } from "@open-managed-agents/tunnel-store-memory";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { createApp, providePort } from "../src/index";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  tunnelCertificateAuthorityPort,
  tunnelCertificatesModule,
  tunnelProvisionerPort,
  tunnelStorePort,
  tunnelTokenManagerPort,
  tunnelsModule,
} from "../src/modules/tunnels";

describe("Tunnels modules", () => {
  it("composes Tunnels and Certificates over one aggregate Store", async () => {
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T10:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => {
            if (namespace === "tunnel") return "tnl_01";
            if (namespace === "tunnel-certificate") return "tcrt_01";
            throw new Error(`unexpected ID namespace ${namespace}`);
          },
        }),
        providePort(tunnelStorePort, new MemoryTunnelStore()),
        providePort(tunnelProvisionerPort, {
          provision: async () => ({
            type: "provisioned" as const,
            domain: "tnl-01.tunnels.test",
            connectorTokenId: "ttok_01",
          }),
          archive: async () => {},
        }),
        providePort(tunnelTokenManagerPort, {
          reveal: async () => ({
            type: "available" as const,
            token: { id: "ttok_01", token: "secret" },
          }),
          rotate: async () => ({
            type: "available" as const,
            token: { id: "ttok_02", token: "rotated" },
          }),
        }),
        providePort(tunnelCertificateAuthorityPort, {
          register: async () => ({
            type: "registered" as const,
            expiresAt: null,
            fingerprint: "0123456789abcdef",
          }),
          archive: async () => {},
        }),
        tunnelsModule(),
        tunnelCertificatesModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.tunnels).createTunnel({
      displayName: "Gateway",
    })).resolves.toMatchObject({
      type: "created",
      tunnel: { id: "tnl_01", domain: "tnl-01.tunnels.test" },
    });
    await expect(app.port(managedAgentsPortTokens.tunnelCertificates)
      .createTunnelCertificate({
        tunnelId: "tnl_01",
        caCertificatePem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      })).resolves.toMatchObject({
        type: "created",
        certificate: { id: "tcrt_01", tunnelId: "tnl_01" },
      });
  });
});
