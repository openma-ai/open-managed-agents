import { describe, expect, it } from "vitest";
import type { Credential } from "@open-managed-agents/managed-agents-application";
import { IndeterminateCredentialValidationProbe } from "../src";

describe("IndeterminateCredentialValidationProbe", () => {
  it("reports secret capability without pretending a live network probe ran", async () => {
    const credential: Credential = {
      id: "vcrd_01",
      archivedAt: null,
      auth: {
        type: "mcp_oauth",
        accessToken: "access-secret",
        mcpServerUrl: "https://mcp.example.com/sse",
        refresh: {
          clientId: "client_01",
          refreshToken: "refresh-secret",
          tokenEndpoint: "https://auth.example.com/token",
          tokenEndpointAuth: { type: "none" },
        },
      },
      createdAt: "2026-08-26T18:00:00.000Z",
      metadata: {},
      updatedAt: "2026-08-26T18:00:00.000Z",
      vaultId: "vlt_01",
    };

    await expect(
      new IndeterminateCredentialValidationProbe().validate({
        workspaceId: "workspace_01",
        credential,
      }),
    ).resolves.toEqual({
      hasRefreshToken: true,
      mcpProbe: null,
      refresh: null,
      status: "indeterminate",
    });
  });
});
