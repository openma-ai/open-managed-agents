import { describe, expect, it } from "vitest";
import type { Tunnel } from "@open-managed-agents/managed-agents-application";
import {
  LocalTunnelProvisioner,
  WebCryptoTunnelCertificateAuthority,
  WebCryptoTunnelTokenManager,
} from "../src";

const tunnel: Tunnel = {
  id: "tnl_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  displayName: null,
  domain: "tnl_01.tunnels.openma.test",
  connectorTokenId: "ttok_01",
};

describe("local Tunnel infrastructure adapters", () => {
  it("provisions a unique domain and external token identifier", async () => {
    const provisioner = new LocalTunnelProvisioner({
      domainSuffix: "tunnels.openma.test",
      nextTokenId: () => "ttok_01",
    });

    await expect(
      provisioner.provision({ workspaceId: "workspace_01", tunnelId: "tnl_01" }),
    ).resolves.toEqual({
      type: "provisioned",
      domain: "tnl_01.tunnels.openma.test",
      connectorTokenId: "ttok_01",
    });
  });

  it("derives a stable live token and rotates through a new identifier", async () => {
    const manager = new WebCryptoTunnelTokenManager({
      rootSecret: "test-root-secret",
      nextTokenId: () => "ttok_02",
    });

    const revealed = await manager.reveal({
      workspaceId: "workspace_01",
      tunnel,
    });
    const revealedAgain = await manager.reveal({
      workspaceId: "workspace_01",
      tunnel,
    });
    const rotated = await manager.rotate({
      workspaceId: "workspace_01",
      tunnel,
      reason: "Scheduled rotation",
    });

    expect(revealed).toEqual(revealedAgain);
    expect(revealed).toMatchObject({
      type: "available",
      token: { id: "ttok_01", token: expect.stringMatching(/^tnl_tok_/) },
    });
    expect(rotated).toMatchObject({
      type: "available",
      token: { id: "ttok_02", token: expect.stringMatching(/^tnl_tok_/) },
    });
    if (revealed.type === "available" && rotated.type === "available") {
      expect(rotated.token.token).not.toBe(revealed.token.token);
    }
  });

  it("validates one public certificate and returns its DER fingerprint", async () => {
    const authority = new WebCryptoTunnelCertificateAuthority();
    const pem = [
      "-----BEGIN CERTIFICATE-----",
      btoa(String.fromCharCode(0x30, 0x03, 0x02, 0x01, 0x01)),
      "-----END CERTIFICATE-----",
    ].join("\n");

    await expect(
      authority.register({
        workspaceId: "workspace_01",
        tunnel,
        certificateId: "tcrt_01",
        caCertificatePem: pem,
      }),
    ).resolves.toEqual({
      type: "registered",
      expiresAt: null,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(
      authority.register({
        workspaceId: "workspace_01",
        tunnel,
        certificateId: "tcrt_02",
        caCertificatePem: `${pem}\n-----BEGIN PRIVATE KEY-----\nsecret`,
      }),
    ).resolves.toEqual({
      type: "invalid",
      message: "CA certificate must contain one public certificate and no private key",
    });
  });
});
