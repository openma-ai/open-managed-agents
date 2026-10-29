import { describe, expect, it } from "vitest";
import type { CredentialView } from "../src/index";
import { makeCredentialsPort } from "./credential-fixtures";
import { buildCredentialsTestApi } from "./test-api";

// `cap_cli` is an OpenMA extension the Anthropic SDK does not type, so these
// requests go through the HTTP surface directly.
const capCliView: CredentialView = {
  id: "vcrd_cap_01",
  archivedAt: null,
  auth: { type: "cap_cli", cliId: "gh", expiresAt: "2026-08-27T00:00:00.000Z" },
  createdAt: "2026-08-26T11:00:00.000Z",
  displayName: "GitHub CLI",
  metadata: {},
  updatedAt: "2026-08-26T11:00:00.000Z",
  vaultId: "vlt_01",
};

function call(
  api: ReturnType<typeof buildCredentialsTestApi>,
  method: string,
  path: string,
  body?: unknown,
) {
  return api.fetch(
    new Request(`http://openma.test${path}`, {
      method,
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
}

describe("Managed Agents API — cap_cli credentials (OpenMA extension)", () => {
  it("maps the snake_case create body and hides every secret on the way out", async () => {
    const calls: unknown[] = [];
    const api = buildCredentialsTestApi(
      makeCredentialsPort({
        createCredential: async (command) => {
          calls.push(command);
          return { type: "created", credential: capCliView };
        },
      }),
    );
    const response = await call(api, "POST", "/v1/vaults/vlt_01/credentials", {
      display_name: "GitHub CLI",
      auth: {
        type: "cap_cli",
        cli_id: "gh",
        token: "gho_token_secret",
        refresh_token: "ghr_refresh_secret",
        expires_at: "2026-08-27T00:00:00.000Z",
        extras: { scope: "repo" },
      },
    });
    expect(response.status).toBe(201);
    expect(calls).toEqual([
      {
        vaultId: "vlt_01",
        displayName: "GitHub CLI",
        auth: {
          type: "cap_cli",
          cliId: "gh",
          token: "gho_token_secret",
          refreshToken: "ghr_refresh_secret",
          expiresAt: "2026-08-27T00:00:00.000Z",
          extras: { scope: "repo" },
        },
      },
    ]);
    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).auth).toEqual({
      type: "cap_cli",
      cli_id: "gh",
      expires_at: "2026-08-27T00:00:00.000Z",
    });
  });

  it("maps token rotation updates and lists cap_cli credentials", async () => {
    const calls: unknown[] = [];
    const api = buildCredentialsTestApi(
      makeCredentialsPort({
        updateCredential: async (command) => {
          calls.push(command);
          return { type: "updated", credential: capCliView };
        },
        listCredentials: async () => ({
          type: "page",
          page: { credentials: [capCliView], nextCursor: null },
        }),
      }),
    );
    const updated = await call(api, "POST", "/v1/vaults/vlt_01/credentials/vcrd_cap_01", {
      auth: { type: "cap_cli", token: "rotated", refresh_token: null, extras: null },
    });
    expect(updated.status).toBe(200);
    expect(calls).toEqual([
      {
        vaultId: "vlt_01",
        credentialId: "vcrd_cap_01",
        auth: { type: "cap_cli", token: "rotated", refreshToken: null, extras: null },
      },
    ]);
    const listed = await call(api, "GET", "/v1/vaults/vlt_01/credentials");
    expect(listed.status).toBe(200);
    expect((await listed.json()).data[0].auth).toEqual({
      type: "cap_cli",
      cli_id: "gh",
      expires_at: "2026-08-27T00:00:00.000Z",
    });
  });

  it("rejects malformed cap_cli bodies and cli_id changes", async () => {
    const api = buildCredentialsTestApi(makeCredentialsPort({}));
    const missingToken = await call(api, "POST", "/v1/vaults/vlt_01/credentials", {
      auth: { type: "cap_cli", cli_id: "gh" },
    });
    expect(missingToken.status).toBe(400);
    const cliIdChange = await call(api, "POST", "/v1/vaults/vlt_01/credentials/vcrd_cap_01", {
      auth: { type: "cap_cli", cli_id: "glab" },
    });
    expect(cliIdChange.status).toBe(400);
  });

  it("surfaces an application invalid_request (e.g. unknown cli_id) as 400", async () => {
    const api = buildCredentialsTestApi(
      makeCredentialsPort({
        createCredential: async () => ({
          type: "invalid_request",
          message: 'Unknown cap_cli cli_id "nope"',
        }),
        validateCredential: async () => ({
          type: "invalid_request",
          message: "cap_cli credentials are not MCP credentials and cannot be validated",
        }),
      }),
    );
    const created = await call(api, "POST", "/v1/vaults/vlt_01/credentials", {
      auth: { type: "cap_cli", cli_id: "nope", token: "t" },
    });
    expect(created.status).toBe(400);
    expect(JSON.stringify(await created.json())).toContain('Unknown cap_cli cli_id \\"nope\\"');
    const validated = await call(
      api,
      "POST",
      "/v1/vaults/vlt_01/credentials/vcrd_cap_01/mcp_oauth_validate",
    );
    expect(validated.status).toBe(400);
  });
});
