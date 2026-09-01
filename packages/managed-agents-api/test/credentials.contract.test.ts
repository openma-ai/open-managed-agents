import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { CredentialsApplicationPort } from "../src/index";
import {
  environmentVariableCredentialView,
  makeCredentialsPort,
  oauthCredentialView,
  staticBearerCredentialView,
} from "./credential-fixtures";
import { buildCredentialsTestApi } from "./test-api";

function makeClient(port: CredentialsApplicationPort): Anthropic {
  const api = buildCredentialsTestApi(port);
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

describe("Managed Agents API — vault credentials", () => {
  it("maps all three credential create auth variants", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeCredentialsPort({
        createCredential: async (command) => {
          calls.push(command);
          if (command.auth.type === "mcp_oauth") {
            return { type: "created", credential: oauthCredentialView };
          }
          if (command.auth.type === "environment_variable") {
            return {
              type: "created",
              credential: environmentVariableCredentialView,
            };
          }
          return { type: "created", credential: staticBearerCredentialView };
        },
      }),
    );

    const bearer = await client.beta.vaults.credentials.create("vlt_01", {
      auth: {
        type: "static_bearer",
        token: "bearer-secret",
        mcp_server_url: "https://mcp.example.com/sse",
      },
      display_name: "MCP bearer",
      metadata: { team: "platform" },
    });
    const oauth = await client.beta.vaults.credentials.create("vlt_01", {
      auth: {
        type: "mcp_oauth",
        access_token: "access-secret",
        mcp_server_url: "https://mcp.example.com/sse",
        expires_at: "2026-08-26T12:00:00.000Z",
        refresh: {
          client_id: "client_01",
          refresh_token: "refresh-secret",
          token_endpoint: "https://auth.example.com/token",
          token_endpoint_auth: {
            type: "client_secret_basic",
            client_secret: "client-secret",
          },
          resource: "https://mcp.example.com",
          scope: "mcp:tools",
        },
      },
      display_name: "MCP OAuth",
    });
    const environmentVariable =
      await client.beta.vaults.credentials.create("vlt_01", {
        auth: {
          type: "environment_variable",
          networking: {
            type: "limited",
            allowed_hosts: ["api.example.com"],
          },
          secret_name: "EXAMPLE_TOKEN",
          secret_value: "env-secret",
          injection_location: { body: false, header: true },
        },
      });

    expect(calls).toEqual([
      {
        vaultId: "vlt_01",
        auth: {
          type: "static_bearer",
          token: "bearer-secret",
          mcpServerUrl: "https://mcp.example.com/sse",
        },
        displayName: "MCP bearer",
        metadata: { team: "platform" },
      },
      {
        vaultId: "vlt_01",
        auth: {
          type: "mcp_oauth",
          accessToken: "access-secret",
          mcpServerUrl: "https://mcp.example.com/sse",
          expiresAt: "2026-08-26T12:00:00.000Z",
          refresh: {
            clientId: "client_01",
            refreshToken: "refresh-secret",
            tokenEndpoint: "https://auth.example.com/token",
            tokenEndpointAuth: {
              type: "client_secret_basic",
              clientSecret: "client-secret",
            },
            resource: "https://mcp.example.com",
            scope: "mcp:tools",
          },
        },
        displayName: "MCP OAuth",
      },
      {
        vaultId: "vlt_01",
        auth: {
          type: "environment_variable",
          networking: {
            type: "limited",
            allowedHosts: ["api.example.com"],
          },
          secretName: "EXAMPLE_TOKEN",
          secretValue: "env-secret",
          injectionLocation: { body: false, header: true },
        },
      },
    ]);
    expect(bearer.auth).toEqual({
      type: "static_bearer",
      mcp_server_url: "https://mcp.example.com/sse",
    });
    expect(oauth.auth).toMatchObject({
      type: "mcp_oauth",
      refresh: {
        client_id: "client_01",
        token_endpoint_auth: { type: "client_secret_basic" },
      },
    });
    expect(environmentVariable.auth).toEqual({
      type: "environment_variable",
      injection_location: { body: false, header: true },
      networking: { type: "limited", allowed_hosts: ["api.example.com"] },
      secret_name: "EXAMPLE_TOKEN",
    });
  });

  it("retrieves a credential with both path identifiers", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeCredentialsPort({
        retrieveCredential: async (query) => {
          calls.push(query);
          return { type: "found", credential: staticBearerCredentialView };
        },
      }),
    );

    await client.beta.vaults.credentials.retrieve("vcrd_static_01", {
      vault_id: "vlt_01",
    });

    expect(calls).toEqual([
      { vaultId: "vlt_01", credentialId: "vcrd_static_01" },
    ]);
  });

  it("maps OAuth refresh update semantics without wire names", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeCredentialsPort({
        updateCredential: async (command) => {
          calls.push(command);
          return { type: "updated", credential: oauthCredentialView };
        },
      }),
    );

    await client.beta.vaults.credentials.update("vcrd_oauth_01", {
      vault_id: "vlt_01",
      auth: {
        type: "mcp_oauth",
        access_token: null,
        expires_at: null,
        refresh: {
          refresh_token: "new-refresh-secret",
          scope: null,
          token_endpoint_auth: {
            type: "client_secret_post",
            client_secret: null,
          },
        },
      },
      display_name: null,
      metadata: null,
    });

    expect(calls).toEqual([
      {
        vaultId: "vlt_01",
        credentialId: "vcrd_oauth_01",
        auth: {
          type: "mcp_oauth",
          accessToken: null,
          expiresAt: null,
          refresh: {
            refreshToken: "new-refresh-secret",
            scope: null,
            tokenEndpointAuth: {
              type: "client_secret_post",
              clientSecret: null,
            },
          },
        },
        displayName: null,
        metadata: null,
      },
    ]);
  });

  it("lists every credential response auth variant", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeCredentialsPort({
        listCredentials: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: {
              credentials: [
                staticBearerCredentialView,
                oauthCredentialView,
                environmentVariableCredentialView,
              ],
              nextCursor: "credential_page_02",
            },
          };
        },
      }),
    );

    const page = await client.beta.vaults.credentials.list("vlt_01", {
      limit: 10,
      page: "credential_page_01",
      include_archived: true,
    });

    expect(calls).toEqual([
      {
        vaultId: "vlt_01",
        pageSize: 10,
        cursor: "credential_page_01",
        includeArchived: true,
      },
    ]);
    expect(page.data.map((credential) => credential.auth.type)).toEqual([
      "static_bearer",
      "mcp_oauth",
      "environment_variable",
    ]);
    expect(page.next_page).toBe("credential_page_02");
  });

  it("deletes a credential and returns the official tombstone", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeCredentialsPort({
        deleteCredential: async (command) => {
          calls.push(command);
          return { type: "deleted", credentialId: "vcrd_static_01" };
        },
      }),
    );

    const deleted = await client.beta.vaults.credentials.delete(
      "vcrd_static_01",
      { vault_id: "vlt_01" },
    );

    expect(calls).toEqual([
      { vaultId: "vlt_01", credentialId: "vcrd_static_01" },
    ]);
    expect(deleted).toEqual({
      id: "vcrd_static_01",
      type: "vault_credential_deleted",
    });
  });

  it("archives a credential", async () => {
    const calls: unknown[] = [];
    const archived = {
      ...staticBearerCredentialView,
      archivedAt: "2026-08-26T11:30:00.000Z",
    };
    const client = makeClient(
      makeCredentialsPort({
        archiveCredential: async (command) => {
          calls.push(command);
          return { type: "archived", credential: archived };
        },
      }),
    );

    const credential = await client.beta.vaults.credentials.archive(
      "vcrd_static_01",
      { vault_id: "vlt_01" },
    );

    expect(calls).toEqual([
      { vaultId: "vlt_01", credentialId: "vcrd_static_01" },
    ]);
    expect(credential.archived_at).toBe("2026-08-26T11:30:00.000Z");
  });

  it("validates MCP OAuth and translates indeterminate status at the edge", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeCredentialsPort({
        validateCredential: async (command) => {
          calls.push(command);
          return {
            type: "validated",
            validation: {
              credentialId: "vcrd_oauth_01",
              hasRefreshToken: true,
              mcpProbe: {
                response: {
                  body: "scrubbed",
                  bodyTruncated: false,
                  contentType: "application/json",
                  statusCode: 503,
                },
                method: "initialize",
              },
              refresh: {
                response: null,
                status: "connect_error",
              },
              status: "indeterminate",
              validatedAt: "2026-08-26T11:40:00.000Z",
              vaultId: "vlt_01",
            },
          };
        },
      }),
    );

    const validation =
      await client.beta.vaults.credentials.mcpOAuthValidate("vcrd_oauth_01", {
        vault_id: "vlt_01",
      });

    expect(calls).toEqual([
      { vaultId: "vlt_01", credentialId: "vcrd_oauth_01" },
    ]);
    expect(validation).toEqual({
      credential_id: "vcrd_oauth_01",
      has_refresh_token: true,
      mcp_probe: {
        http_response: {
          body: "scrubbed",
          body_truncated: false,
          content_type: "application/json",
          status_code: 503,
        },
        method: "initialize",
      },
      refresh: { http_response: null, status: "connect_error" },
      status: "unknown",
      type: "vault_credential_validation",
      validated_at: "2026-08-26T11:40:00.000Z",
      vault_id: "vlt_01",
    });
  });
});
