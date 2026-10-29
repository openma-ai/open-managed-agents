// Managed (v1) Session egress for cap_cli credentials: selection reads the
// managed domain shape from `managed_credentials`, and refresh writes the
// rotation back through the managed source with a revision check.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forwardWithRefresh,
  resolveOutboundCredentialByHost,
  resolveProxyTargetByTenant,
  type ManagedProxyCredentialRecord,
  type McpProxyCredentialSource,
} from "../../apps/main/src/routes/mcp-proxy";

const WORKSPACE = "workspace_01";
const SESSION = "session_01";

function capRecord(input: {
  id: string;
  vaultId?: string;
  cliId?: string;
  token: string | null;
  refreshToken?: string;
  updatedAt: string;
  archivedAt?: string | null;
  revision?: number;
}): ManagedProxyCredentialRecord {
  return {
    revision: input.revision ?? 1,
    credential: {
      id: input.id,
      vaultId: input.vaultId ?? "vlt_a",
      archivedAt: input.archivedAt ?? null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: input.updatedAt,
      metadata: {},
      auth: {
        type: "cap_cli",
        cliId: input.cliId ?? "gh",
        token: input.token,
        ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
      },
    },
  };
}

function managedSessions(vaultIds: string[]) {
  return {
    find: vi.fn(async () => ({
      archivedAt: null,
      vaultIds,
      agent: { mcpServers: [{ type: "url", name: "docs", url: "https://mcp.example.com/mcp" }] },
    })),
  };
}

function legacyServicesThatMustNotBeRead() {
  return {
    sessions: { get: vi.fn(async () => { throw new Error("legacy sessions read"); }) },
    credentials: {
      listByVaults: vi.fn(async () => { throw new Error("legacy credentials read"); }),
      get: vi.fn(async () => { throw new Error("legacy credentials read"); }),
      getRawForRefresh: vi.fn(async () => { throw new Error("legacy credentials read"); }),
      refreshAuth: vi.fn(async () => { throw new Error("legacy credentials write"); }),
      refreshAuthCAS: vi.fn(async () => { throw new Error("legacy credentials write"); }),
    },
  } as never;
}

function memorySource(initial: ManagedProxyCredentialRecord[]) {
  const records = new Map(initial.map((record) => [record.credential.id, record]));
  const replaced: Array<{ vaultId: string; credentialId: string; expectedRevision: number }> = [];
  const source: McpProxyCredentialSource = {
    listByVaults: async ({ vaultIds }) =>
      [...records.values()].filter((record) => vaultIds.includes(record.credential.vaultId)),
    find: async ({ vaultId, credentialId }) => {
      const record = records.get(credentialId);
      return record !== undefined && record.credential.vaultId === vaultId ? record : null;
    },
    replace: async ({ vaultId, credentialId, expectedRevision, next }) => {
      replaced.push({ vaultId, credentialId, expectedRevision });
      const current = records.get(credentialId);
      if (current === undefined || current.credential.vaultId !== vaultId) return { type: "not_found" };
      if (current.revision !== expectedRevision) {
        return { type: "revision_conflict", actualRevision: current.revision };
      }
      const record = { revision: current.revision + 1, credential: next };
      records.set(credentialId, record);
      return { type: "replaced", record };
    },
  };
  return { source, records, replaced };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed Session cap_cli egress", () => {
  it("picks the newest active cap_cli credential for the host's CLI across vaults", async () => {
    const { source } = memorySource([
      capRecord({ id: "c_old", token: "old", updatedAt: "2026-09-01T00:00:00.000Z" }),
      capRecord({ id: "c_new", vaultId: "vlt_b", token: "new", updatedAt: "2026-09-03T00:00:00.000Z" }),
      capRecord({ id: "c_archived", token: "archived", updatedAt: "2026-09-04T00:00:00.000Z", archivedAt: "2026-09-04T00:00:00.000Z" }),
      capRecord({ id: "c_other_cli", cliId: "glab", token: "glab", updatedAt: "2026-09-05T00:00:00.000Z" }),
      capRecord({ id: "c_no_token", token: null, updatedAt: "2026-09-06T00:00:00.000Z" }),
    ]);
    const target = await resolveOutboundCredentialByHost(
      {} as never,
      legacyServicesThatMustNotBeRead(),
      WORKSPACE,
      SESSION,
      "api.github.com",
      managedSessions(["vlt_a", "vlt_b"]),
      source,
    );
    expect(target?.upstreamToken).toBe("new");
    expect(target?.upstreamUrl).toBe("https://api.github.com/");
  });

  it("carries the CLI spec's device-flow refresh metadata at the real vault/credential ids", async () => {
    const { source } = memorySource([
      capRecord({ id: "c_gh", vaultId: "vlt_b", token: "gho_old", refreshToken: "ghr_1", updatedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    const target = await resolveOutboundCredentialByHost(
      {} as never,
      legacyServicesThatMustNotBeRead(),
      WORKSPACE,
      SESSION,
      "api.github.com",
      managedSessions(["vlt_b"]),
      source,
    );
    expect(target?.refresh).toMatchObject({
      refreshToken: "ghr_1",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      credentialId: "c_gh",
      vaultId: "vlt_b",
      credentialSource: source,
    });
  });

  it("returns null for a CLI host with no matching managed cap_cli credential", async () => {
    const { source } = memorySource([
      capRecord({ id: "c_glab", cliId: "glab", token: "glab", updatedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    expect(
      await resolveOutboundCredentialByHost(
        {} as never,
        legacyServicesThatMustNotBeRead(),
        WORKSPACE,
        SESSION,
        "api.github.com",
        managedSessions(["vlt_a"]),
        source,
      ),
    ).toBeNull();
  });

  it("never offers a cap_cli credential as an MCP server credential", async () => {
    const { source } = memorySource([
      capRecord({ id: "c_gh", token: "gho", updatedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    expect(
      await resolveProxyTargetByTenant(
        {} as never,
        legacyServicesThatMustNotBeRead(),
        WORKSPACE,
        SESSION,
        "docs",
        managedSessions(["vlt_a"]),
        source,
      ),
    ).toBeNull();
  });

  it("refreshes on 401 and writes the rotated cap_cli tokens back with a revision check", async () => {
    const { source, records, replaced } = memorySource([
      capRecord({ id: "c_gh", vaultId: "vlt_b", token: "gho_old", refreshToken: "ghr_1", updatedAt: "2026-09-01T00:00:00.000Z", revision: 4 }),
    ]);
    const target = await resolveOutboundCredentialByHost(
      {} as never,
      legacyServicesThatMustNotBeRead(),
      WORKSPACE,
      SESSION,
      "api.github.com",
      managedSessions(["vlt_b"]),
      source,
    );
    const calls: Request[] = [];
    const responses = [
      () => new Response("unauthorized", { status: 401 }),
      () => Response.json({ access_token: "gho_new", refresh_token: "ghr_2", expires_in: 3600 }),
      () => new Response("ok", { status: 200 }),
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(input instanceof Request ? input : new Request(input, init));
      return responses[calls.length - 1]!();
    });

    const response = await forwardWithRefresh(
      legacyServicesThatMustNotBeRead(),
      WORKSPACE,
      { ...target!, upstreamUrl: "https://api.github.com/user" },
      "GET",
      new Headers(),
      null,
    );

    expect(response.status).toBe(200);
    expect(calls[1]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(calls[1]!.headers.get("accept")).toBe("application/json");
    expect(calls[2]!.headers.get("authorization")).toBe("Bearer gho_new");
    expect(replaced).toEqual([{ vaultId: "vlt_b", credentialId: "c_gh", expectedRevision: 4 }]);
    expect(records.get("c_gh")).toMatchObject({
      revision: 5,
      credential: { auth: { type: "cap_cli", cliId: "gh", token: "gho_new", refreshToken: "ghr_2" } },
    });
  });

  it("uses a token another refresh already stored instead of calling the token endpoint", async () => {
    const { source, replaced } = memorySource([
      capRecord({ id: "c_gh", token: "gho_rotated_elsewhere", refreshToken: "ghr_1", updatedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    const calls: Request[] = [];
    const responses = [
      () => new Response("unauthorized", { status: 401 }),
      () => new Response("ok", { status: 200 }),
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(input instanceof Request ? input : new Request(input, init));
      return responses[calls.length - 1]!();
    });
    const response = await forwardWithRefresh(
      legacyServicesThatMustNotBeRead(),
      WORKSPACE,
      {
        upstreamUrl: "https://api.github.com/user",
        upstreamToken: "gho_stale",
        refresh: {
          refreshToken: "ghr_1",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
          credentialId: "c_gh",
          vaultId: "vlt_a",
          credentialSource: source,
        },
      },
      "GET",
      new Headers(),
      null,
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer gho_rotated_elsewhere");
    expect(replaced).toEqual([]);
  });
});
