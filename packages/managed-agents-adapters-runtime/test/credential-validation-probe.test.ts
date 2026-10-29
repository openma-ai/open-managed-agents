import { describe, expect, it } from "vitest";
import type { Credential } from "@open-managed-agents/managed-agents-application";
import {
  IndeterminateCredentialValidationProbe,
  McpOAuthCredentialValidationProbe,
} from "../src";

const MARKERS = [
  "stored-access-",
  "stored-refresh-",
  "stored-client-",
  "fresh-access-",
  "fresh-refresh-",
  "thrown-secret-",
];

describe("IndeterminateCredentialValidationProbe", () => {
  it("reports secret capability without pretending a live network probe ran", async () => {
    const credential = oauthCredential({
      access: "access-secret",
      refresh: "refresh-secret",
    });
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

describe("cap_cli credentials (OpenMA extension)", () => {
  it("are refused by every probe instead of degrading to indeterminate", async () => {
    const credential: Credential = {
      id: "vcrd_cap",
      archivedAt: null,
      auth: { type: "cap_cli", cliId: "gh", token: "gho_secret" },
      createdAt: "2026-08-26T00:00:00.000Z",
      metadata: {},
      updatedAt: "2026-08-26T00:00:00.000Z",
      vaultId: "vlt_01",
    };
    for (const subject of [
      new IndeterminateCredentialValidationProbe(),
      new McpOAuthCredentialValidationProbe({
        fetch: async () => {
          throw new Error("no network for cap_cli");
        },
      }),
    ]) {
      await expect(
        subject.validate({ workspaceId: "workspace_01", credential }),
      ).rejects.toThrow("cap_cli credentials cannot be MCP-validated");
    }
  });
});

describe("McpOAuthCredentialValidationProbe", () => {
  it("does not log, and does not build error strings from request data", async () => {
    const fs = (await import("node:" + "fs")) as {
      readFileSync(path: URL, encoding: "utf8"): string;
    };
    const source = fs.readFileSync(
      new URL("../src/credential-validation-probe.ts", import.meta.url),
      "utf8",
    );
    expect(source.includes("console.")).toBe(false);
    expect(source.includes("throw new Error(`")).toBe(false);
  });

  it("accepts a live bearer without calling the token endpoint", async () => {
    const server = await startServer();
    try {
      const access = token("stored-access-");
      await server.reset({ accessToken: access, refreshToken: token("stored-refresh-") });
      const result = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access,
          refresh: token("stored-refresh-"),
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(result.status).toBe("valid");
      expect(result.mcpProbe).toBeNull();
      expect(result.refresh).toBeNull();
      expect(result.rotation).toBeNull();
      expect(await server.meta()).toMatchObject({ mcpRequests: 1, tokenRequests: 0 });
      assertNoMarkers(result);
    } finally {
      await server.close();
    }
  });

  it("refreshes an expired bearer and keeps the new tokens off enumerable output", async () => {
    const server = await startServer();
    try {
      const refresh = token("stored-refresh-");
      const secret = token("stored-client-");
      await server.reset({
        accessToken: "server-current-access",
        refreshToken: refresh,
        clientId: "oauth-client",
        clientSecret: secret,
        resource: "https://mcp.example.test",
        scope: "tools.read",
      });
      const result = await new McpOAuthCredentialValidationProbe({
        clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      }).validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          refresh,
          secret,
          auth: "client_secret_post",
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
          resource: "https://mcp.example.test",
          scope: "tools.read",
        }),
      });
      expect(result).toMatchObject({
        status: "valid",
        hasRefreshToken: true,
        mcpProbe: null,
        refresh: { response: null, status: "succeeded" },
      });
      expect(Object.keys(result).includes("rotation")).toBe(false);
      expect(result.rotation?.expiresAt).toBe("2026-08-26T01:00:00.000Z");
      expect((result.rotation?.accessToken ?? "") === "fresh-access-1").toBe(true);
      expect((result.rotation?.refreshToken ?? "") === "fresh-refresh-1").toBe(true);
      expect(await server.meta()).toMatchObject({
        issuedCount: 1,
        postSecretMatched: true,
        resourceMatched: true,
        scopeMatched: true,
        clientIdMatched: true,
      });
      assertNoMarkers(result);
    } finally {
      await server.close();
    }
  });

  it("reports a revoked refresh as invalid and scrubs echoed secrets", async () => {
    const server = await startServer();
    try {
      const refresh = token("stored-refresh-");
      const secret = token("stored-client-");
      await server.reset({
        accessToken: "server-current-access",
        refreshToken: refresh,
        clientSecret: secret,
        token: "invalid_grant",
      });
      const result = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          refresh,
          secret,
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(result.status).toBe("invalid");
      expect(result.rotation).toBeNull();
      expect(result.mcpProbe?.response?.statusCode).toBe(401);
      expect(result.refresh).toMatchObject({ status: "failed" });
      expect(result.refresh?.response?.statusCode).toBe(400);
      expect(result.mcpProbe?.response?.body.includes("[redacted]")).toBe(true);
      expect(result.refresh?.response?.body.includes("[redacted]")).toBe(true);
      assertNoMarkers(result);
    } finally {
      await server.close();
    }
  });

  it("treats HTTP 403 as an expired or revoked bearer", async () => {
    const server = await startServer();
    try {
      const refresh = token("stored-refresh-");
      await server.reset({
        accessToken: token("stored-access-"),
        refreshToken: refresh,
        mcp: "forbidden",
        token: "invalid_grant",
      });
      const result = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          refresh,
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(result.status).toBe("invalid");
      expect(result.mcpProbe?.response?.statusCode).toBe(403);
      expect(result.refresh?.status).toBe("failed");
      expect(result.mcpProbe?.response?.body.includes("[redacted]")).toBe(true);
      assertNoMarkers(result);
    } finally {
      await server.close();
    }
  });

  it("reports an auth rejection without a refresh token as invalid", async () => {
    const server = await startServer();
    try {
      await server.reset({
        accessToken: "server-current-access",
        refreshToken: token("stored-refresh-"),
      });
      const result = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          mcpUrl: `${server.origin}/mcp`,
        }),
      });
      expect(result).toMatchObject({
        status: "invalid",
        hasRefreshToken: false,
        refresh: { response: null, status: "no_refresh_token" },
      });
      assertNoMarkers(result);
    } finally {
      await server.close();
    }
  });

  it("returns indeterminate when the MCP server or token endpoint cannot be reached", async () => {
    const server = await startServer();
    try {
      const closed = await server.closedPort();
      const unreachable = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          refresh: token("stored-refresh-"),
          mcpUrl: `http://127.0.0.1:${closed}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(unreachable).toMatchObject({
        status: "indeterminate",
        mcpProbe: { method: "initialize", response: null },
        refresh: null,
      });
      assertNoMarkers(unreachable);

      const refresh = token("stored-refresh-");
      await server.reset({ accessToken: "server-current-access", refreshToken: refresh });
      const tokenDown = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          refresh,
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `http://127.0.0.1:${closed}/oauth/token`,
        }),
      });
      expect(tokenDown.status).toBe("indeterminate");
      expect(tokenDown.mcpProbe?.response?.statusCode).toBe(401);
      expect(tokenDown.refresh).toEqual({ response: null, status: "connect_error" });
      assertNoMarkers(tokenDown);
    } finally {
      await server.close();
    }
  });

  it("returns indeterminate for upstream 503 responses and still scrubs them", async () => {
    const server = await startServer();
    try {
      const access = token("stored-access-");
      await server.reset({
        accessToken: access,
        refreshToken: token("stored-refresh-"),
        mcp: "unavailable",
      });
      const mcpDown = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access,
          refresh: token("stored-refresh-"),
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(mcpDown.status).toBe("indeterminate");
      expect(mcpDown.refresh).toBeNull();
      expect(mcpDown.mcpProbe?.response?.statusCode).toBe(503);
      expect(mcpDown.mcpProbe?.response?.body.includes("[redacted]")).toBe(true);
      assertNoMarkers(mcpDown);

      const refresh = token("stored-refresh-");
      const secret = token("stored-client-");
      await server.reset({
        accessToken: "server-current-access",
        refreshToken: refresh,
        clientSecret: secret,
        token: "unavailable",
      });
      const tokenDown = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          refresh,
          secret,
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(tokenDown.status).toBe("indeterminate");
      expect(tokenDown.refresh?.status).toBe("failed");
      expect(tokenDown.refresh?.response?.body.includes("[redacted]")).toBe(true);
      assertNoMarkers(tokenDown);
    } finally {
      await server.close();
    }
  });

  it("does not follow a redirect with the bearer token", async () => {
    const server = await startServer();
    try {
      const access = token("stored-access-");
      await server.reset({
        accessToken: access,
        refreshToken: token("stored-refresh-"),
        mcp: "redirect",
      });
      const result = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access,
          refresh: token("stored-refresh-"),
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(result.status).toBe("indeterminate");
      expect(result.refresh).toBeNull();
      expect((await server.meta()).sinkSawAuthorization).toBe(false);
      assertNoMarkers(result);
    } finally {
      await server.close();
    }
  });

  it("sends client_secret_basic without echoing it back", async () => {
    const server = await startServer();
    try {
      const secret = token("stored-client-");
      const refresh = token("stored-refresh-");
      await server.reset({
        accessToken: "server-current-access",
        refreshToken: refresh,
        clientId: "oauth-client",
        clientSecret: secret,
      });
      const result = await probe().validate({
        workspaceId: "workspace_01",
        credential: oauthCredential({
          access: token("stored-access-"),
          refresh,
          secret,
          auth: "client_secret_basic",
          mcpUrl: `${server.origin}/mcp`,
          tokenUrl: `${server.origin}/oauth/token`,
        }),
      });
      expect(result.status).toBe("valid");
      expect(await server.meta()).toMatchObject({
        basicSecretMatched: true,
        postSecretMatched: false,
      });
      assertNoMarkers(result);
    } finally {
      await server.close();
    }
  });

  it("treats a thrown fetch error as indeterminate and does not copy its message", async () => {
    const secret = token("thrown-secret-");
    let fetched = false;
    const result = await new McpOAuthCredentialValidationProbe({
      fetch: async () => {
        fetched = true;
        throw new Error(`connect failed for ${secret}`);
      },
    }).validate({
      workspaceId: "workspace_01",
      credential: oauthCredential({
        access: token("stored-access-"),
        refresh: token("stored-refresh-"),
        mcpUrl: "https://mcp.example.test/mcp",
        tokenUrl: "https://auth.example.test/token",
      }),
    });
    expect(fetched).toBe(true);
    expect(result).toMatchObject({
      status: "indeterminate",
      mcpProbe: { method: "initialize", response: null },
      refresh: null,
    });
    assertNoMarkers(result);
  });

  it("does not call the network for an environment-variable credential", async () => {
    let fetched = false;
    const result = await new McpOAuthCredentialValidationProbe({
      fetch: async () => {
        fetched = true;
        return new Response("nope", { status: 500 });
      },
    }).validate({
      workspaceId: "workspace_01",
      credential: {
        id: "vcrd_env",
        archivedAt: null,
        auth: {
          type: "environment_variable",
          networking: { type: "unrestricted" },
          secretName: "TOKEN",
          secretValue: token("stored-client-"),
          injectionLocation: { body: false, header: true },
        },
        createdAt: "2026-08-26T18:00:00.000Z",
        metadata: {},
        updatedAt: "2026-08-26T18:00:00.000Z",
        vaultId: "vlt_01",
      },
    });
    expect(fetched).toBe(false);
    expect(result).toMatchObject({
      hasRefreshToken: false,
      mcpProbe: null,
      refresh: null,
      status: "indeterminate",
    });
    assertNoMarkers(result);
  });
});

function probe(): McpOAuthCredentialValidationProbe {
  return new McpOAuthCredentialValidationProbe();
}

function token(prefix: string): string {
  return `${prefix}${crypto.randomUUID()}`;
}

function oauthCredential(input: {
  access: string;
  refresh?: string;
  secret?: string;
  auth?: "client_secret_post" | "client_secret_basic";
  mcpUrl?: string;
  tokenUrl?: string;
  resource?: string;
  scope?: string;
}): Credential {
  return {
    id: "vcrd_01",
    archivedAt: null,
    auth: {
      type: "mcp_oauth",
      accessToken: input.access,
      mcpServerUrl: input.mcpUrl ?? "https://mcp.example.test/mcp",
      ...(input.refresh === undefined
        ? {}
        : {
            refresh: {
              clientId: "oauth-client",
              refreshToken: input.refresh,
              tokenEndpoint: input.tokenUrl ?? "https://auth.example.test/token",
              tokenEndpointAuth:
                input.auth === "client_secret_basic"
                  ? { type: "client_secret_basic", clientSecret: input.secret ?? null }
                  : input.secret === undefined
                    ? { type: "none" }
                    : { type: "client_secret_post", clientSecret: input.secret },
              ...(input.resource === undefined ? {} : { resource: input.resource }),
              ...(input.scope === undefined ? {} : { scope: input.scope }),
            },
          }),
    },
    createdAt: "2026-08-26T18:00:00.000Z",
    metadata: {},
    updatedAt: "2026-08-26T18:00:00.000Z",
    vaultId: "vlt_01",
  };
}

function assertNoMarkers(value: unknown): void {
  const text = JSON.stringify(value);
  for (const marker of MARKERS) {
    expect(text.includes(marker), marker).toBe(false);
  }
  expect(text.includes("server-current-access"), "server access").toBe(false);
}

interface ServerHandle {
  origin: string;
  close(): Promise<void>;
  reset(control: Record<string, unknown>): Promise<void>;
  meta(): Promise<Record<string, unknown>>;
  closedPort(): Promise<number>;
}

async function startServer(): Promise<ServerHandle> {
  const serverSpecifier = new URL(
    "../../../test/fixtures/oauth-mcp-local-server.ts",
    import.meta.url,
  ).href;
  const endpointSpecifier = new URL(
    "../../../test/fixtures/oauth-mcp-local-endpoint.ts",
    import.meta.url,
  ).href;
  const loaded = (await import(serverSpecifier)) as {
    startOauthMcpTestServer(options?: { port?: number }): Promise<{
      origin: string;
      close(): Promise<void>;
    }>;
    reserveClosedPort(): Promise<number>;
  };
  const endpoint = (await import(endpointSpecifier)) as {
    resetOauthMcpTestServer(origin: string, control: Record<string, unknown>): Promise<void>;
    readOauthMcpTestMeta(origin: string): Promise<Record<string, unknown>>;
  };
  const server = await loaded.startOauthMcpTestServer();
  return {
    origin: server.origin,
    close: () => server.close(),
    reset: (control) => endpoint.resetOauthMcpTestServer(server.origin, control),
    meta: () => endpoint.readOauthMcpTestMeta(server.origin),
    closedPort: () => loaded.reserveClosedPort(),
  };
}
