import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { TunnelCertificatesApplicationPort } from "../src/index";
import {
  makeTunnelCertificatesPort,
  tunnelCertificateView,
} from "./tunnel-fixtures";
import { buildTunnelsTestApi } from "./test-api";

function makeClient(port: TunnelCertificatesApplicationPort): Anthropic {
  const api = buildTunnelsTestApi({ tunnelCertificates: port });
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    },
  });
}

describe("MCP Tunnels API — certificates", () => {
  it("creates a tunnel certificate", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelCertificatesPort({
        createTunnelCertificate: async (command) => {
          calls.push(command);
          return { type: "created", certificate: tunnelCertificateView };
        },
      }),
    );

    const certificate = await client.beta.tunnels.certificates.create("tnl_01", {
      ca_certificate_pem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
    });

    expect(calls).toEqual([
      {
        tunnelId: "tnl_01",
        caCertificatePem:
          "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      },
    ]);
    expect(certificate).toEqual({
      id: "tcrt_01",
      archived_at: null,
      created_at: "2026-08-26T17:05:00.000Z",
      expires_at: "2027-08-26T17:05:00.000Z",
      fingerprint: "0123456789abcdef",
      tunnel_id: "tnl_01",
      type: "tunnel_certificate",
    });
  });

  it("retrieves a certificate with both path identities", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelCertificatesPort({
        retrieveTunnelCertificate: async (query) => {
          calls.push(query);
          return { type: "found", certificate: tunnelCertificateView };
        },
      }),
    );

    await client.beta.tunnels.certificates.retrieve("tcrt_01", {
      tunnel_id: "tnl_01",
    });

    expect(calls).toEqual([
      { tunnelId: "tnl_01", certificateId: "tcrt_01" },
    ]);
  });

  it("lists certificates with semantic pagination", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelCertificatesPort({
        listTunnelCertificates: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: {
              certificates: [tunnelCertificateView],
              nextCursor: "certificate_page_02",
            },
          };
        },
      }),
    );

    const page = await client.beta.tunnels.certificates.list("tnl_01", {
      limit: 10,
      page: "certificate_page_01",
      include_archived: true,
    });

    expect(calls).toEqual([
      {
        tunnelId: "tnl_01",
        pageSize: 10,
        cursor: "certificate_page_01",
        includeArchived: true,
      },
    ]);
    expect(page.next_page).toBe("certificate_page_02");
  });

  it("archives a certificate through its own port", async () => {
    const calls: unknown[] = [];
    const archived = {
      ...tunnelCertificateView,
      archivedAt: "2026-08-26T18:00:00.000Z",
    };
    const client = makeClient(
      makeTunnelCertificatesPort({
        archiveTunnelCertificate: async (command) => {
          calls.push(command);
          return { type: "archived", certificate: archived };
        },
      }),
    );

    const certificate = await client.beta.tunnels.certificates.archive(
      "tcrt_01",
      { tunnel_id: "tnl_01" },
    );

    expect(calls).toEqual([
      { tunnelId: "tnl_01", certificateId: "tcrt_01" },
    ]);
    expect(certificate.archived_at).toBe("2026-08-26T18:00:00.000Z");
  });
});
