// refreshManagedCredential: refresh-token source, revision conflicts, and
// failures that must not drop an issued rotation silently.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshManagedCredential,
  type ManagedProxyCredentialRecord,
  type McpProxyCredentialSource,
} from "../../apps/main/src/routes/managed-proxy-credentials";
import { resolveOutboundCredentialByHost } from "../../apps/main/src/routes/mcp-proxy";

const TOKEN_URL = "https://github.com/login/oauth/access_token";

function record(revision: number, auth: Record<string, unknown>, displayName = "gh"): ManagedProxyCredentialRecord {
  return {
    revision,
    credential: {
      id: "c_gh",
      vaultId: "vlt_a",
      archivedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      metadata: {},
      displayName,
      auth: { type: "cap_cli", cliId: "gh", ...auth } as never,
    },
  };
}

/** A source whose replace results are scripted per call; find returns `rows` in order then the last. */
function scriptedSource(opts: {
  finds: ManagedProxyCredentialRecord[];
  replaces: Array<"replaced" | "conflict" | "throw">;
}) {
  const finds = [...opts.finds];
  const writes: Array<{ expectedRevision: number; auth: Record<string, unknown> }> = [];
  let lastFind = finds[0]!;
  const source: McpProxyCredentialSource = {
    listByVaults: async () => [],
    find: async () => {
      lastFind = finds.shift() ?? lastFind;
      return lastFind;
    },
    replace: async ({ expectedRevision, next }) => {
      writes.push({ expectedRevision, auth: next.auth as never });
      const outcome = opts.replaces.shift() ?? "replaced";
      if (outcome === "throw") throw new Error("d1 unavailable");
      if (outcome === "conflict") return { type: "revision_conflict", actualRevision: expectedRevision + 1 };
      return { type: "replaced", record: { revision: expectedRevision + 1, credential: next } };
    },
  };
  return { source, writes };
}

function stubTokenEndpoint(...bodies: Array<() => Response>) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(await request.text());
    return bodies[requests.length - 1]!();
  });
  return requests;
}

function refreshFor(source: McpProxyCredentialSource) {
  return {
    refreshToken: "ghr_captured_at_resolution",
    tokenEndpoint: TOKEN_URL,
    clientId: "client",
    credentialId: "c_gh",
    vaultId: "vlt_a",
    credentialSource: source,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("refreshManagedCredential", () => {
  it("exchanges the refresh token stored now, not the one captured at resolution", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_current" })],
      replaces: ["replaced"],
    });
    const requests = stubTokenEndpoint(() =>
      Response.json({ access_token: "gho_new", refresh_token: "ghr_next" }));
    expect(await refreshManagedCredential("ws", refreshFor(source), "gho_stale")).toBe("gho_new");
    expect(requests[0]).toContain("refresh_token=ghr_current");
    expect(writes).toEqual([
      { expectedRevision: 3, auth: { type: "cap_cli", cliId: "gh", token: "gho_new", refreshToken: "ghr_next" } },
    ]);
  });

  it("on a conflict that did not rotate the token, re-applies this rotation on the winner's revision", async () => {
    const { source, writes } = scriptedSource({
      finds: [
        record(3, { token: "gho_stale", refreshToken: "ghr_1" }),
        // A concurrent rename bumped the revision but kept the stale token.
        record(4, { token: "gho_stale", refreshToken: "ghr_1" }, "renamed"),
      ],
      replaces: ["conflict", "replaced"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    expect(await refreshManagedCredential("ws", refreshFor(source), "gho_stale")).toBe("gho_new");
    expect(writes.map((write) => write.expectedRevision)).toEqual([3, 4]);
    expect(writes[1]!.auth).toMatchObject({ token: "gho_new", refreshToken: "ghr_2" });
  });

  it("on a conflict where the winner already rotated the token, uses the winner's token", async () => {
    const { source, writes } = scriptedSource({
      finds: [
        record(3, { token: "gho_stale", refreshToken: "ghr_1" }),
        record(4, { token: "gho_winner", refreshToken: "ghr_w" }),
      ],
      replaces: ["conflict"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    expect(await refreshManagedCredential("ws", refreshFor(source), "gho_stale")).toBe("gho_winner");
    expect(writes).toHaveLength(1);
  });

  it("errors instead of returning a token when the rotation keeps conflicting", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_1" })],
      replaces: ["conflict", "conflict", "conflict"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    await expect(refreshManagedCredential("ws", refreshFor(source), "gho_stale"))
      .rejects.toThrow("rotation could not be saved (revision conflict)");
    expect(writes).toHaveLength(3);
  });

  it("errors when every replace throws, after retrying on a re-read", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_1" })],
      replaces: ["throw", "throw", "throw"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    await expect(refreshManagedCredential("ws", refreshFor(source), "gho_stale"))
      .rejects.toThrow("rotation could not be saved (Error)");
    expect(writes).toHaveLength(3);
  });

  it("recovers when a transient replace error is followed by a successful write", async () => {
    const { source } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_1" })],
      replaces: ["throw", "replaced"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    expect(await refreshManagedCredential("ws", refreshFor(source), "gho_stale")).toBe("gho_new");
  });

  it("returns null and records the OAuth error when the token endpoint refuses", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_revoked" })],
      replaces: [],
    });
    stubTokenEndpoint(() => Response.json({ error: "bad_refresh_token" }, { status: 400 }));
    const failure = { code: null as string | null };
    expect(await refreshManagedCredential("ws", refreshFor(source), "gho_stale", failure)).toBeNull();
    expect(failure.code).toBe("bad_refresh_token");
    expect(writes).toEqual([]);
  });

  it("does not call the token endpoint when the stored record has no refresh token", async () => {
    const { source } = scriptedSource({ finds: [record(3, { token: "gho_stale" })], replaces: [] });
    const requests = stubTokenEndpoint();
    expect(await refreshManagedCredential("ws", refreshFor(source), "gho_stale")).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe("managed credential store failures", () => {
  it("are rethrown instead of treated as no credentials", async () => {
    const source: McpProxyCredentialSource = {
      listByVaults: async () => { throw new Error("d1 unavailable"); },
      find: async () => null,
      replace: async () => ({ type: "not_found" }),
    };
    const sessions = { find: async () => ({ archivedAt: null, vaultIds: ["vlt_a"], agent: { mcpServers: [] } }) };
    await expect(resolveOutboundCredentialByHost(
      {} as never,
      { sessions: { get: async () => null } } as never,
      "ws",
      "sess",
      "api.github.com",
      sessions,
      source,
    )).rejects.toThrow("d1 unavailable");
  });
});
