// refreshCredential: refresh-token source, revision conflicts, and failures
// that must not drop an issued rotation silently.
import { describe, expect, it } from "vitest";
import type { CredentialStore, StoredCredential } from "@open-managed-agents/credential-store";
import { refreshCredential, type ManagedCredentialResolverPorts } from "../src/index";

const unusedStore: CredentialStore = {
  insert: async () => { throw new Error("unused"); },
  find: async () => null,
  replace: async () => ({ type: "not_found" }),
  archive: async () => ({ type: "not_found" }),
  delete: async () => ({ type: "not_found" }),
  list: async () => [],
};

const TOKEN_URL = "https://github.com/login/oauth/access_token";

function record(revision: number, auth: Record<string, unknown>, displayName = "gh"): StoredCredential {
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
  finds: StoredCredential[];
  replaces: Array<"replaced" | "conflict" | "throw">;
}) {
  const finds = [...opts.finds];
  const writes: Array<{ expectedRevision: number; auth: Record<string, unknown> }> = [];
  let lastFind = finds[0]!;
  const source: CredentialStore = {
    ...unusedStore,
    find: async () => {
      lastFind = finds.shift() ?? lastFind;
      return lastFind;
    },
    replace: async ({ expectedRevision, next }) => {
      writes.push({ expectedRevision, auth: next.auth as never });
      const outcome = opts.replaces.shift() ?? "replaced";
      if (outcome === "throw") throw new Error("d1 unavailable");
      if (outcome === "conflict") return { type: "revision_conflict", actualRevision: expectedRevision + 1 };
      lastFind = { revision: expectedRevision + 1, credential: next };
      return { type: "replaced", record: lastFind };
    },
  };
  return { source, writes };
}

let tokenEndpoint: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error("token endpoint not stubbed");
};

function stubTokenEndpoint(...bodies: Array<() => Response>) {
  const requests: string[] = [];
  tokenEndpoint = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(await request.text());
    return bodies[requests.length - 1]!();
  };
  return requests;
}

function portsFor(store: CredentialStore): ManagedCredentialResolverPorts {
  return {
    credentials: store,
    vaults: { find: async () => ({ vault: { archivedAt: null } }) },
    fetch: (input, init) => tokenEndpoint(input, init),
    clock: { now: () => new Date("2026-09-02T00:00:00.000Z") },
    log: { warn: () => {} },
  };
}

const REFRESH = {
  tokenEndpoint: TOKEN_URL,
  clientId: "client",
  credentialId: "c_gh",
  vaultId: "vlt_a",
};

function refresh(store: CredentialStore, stale: string, failure?: { code: string | null }) {
  return refreshCredential(portsFor(store), "ws", REFRESH, stale, failure);
}

describe("refreshCredential", () => {
  it("exchanges the refresh token stored now, not the one captured at resolution", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_current" })],
      replaces: ["replaced"],
    });
    const requests = stubTokenEndpoint(() =>
      Response.json({ access_token: "gho_new", refresh_token: "ghr_next" }));
    expect(await refresh(source, "gho_stale")).toBe("gho_new");
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
    expect(await refresh(source, "gho_stale")).toBe("gho_new");
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
    expect(await refresh(source, "gho_stale")).toBe("gho_winner");
    expect(writes).toHaveLength(1);
  });

  it("errors instead of returning a token when the rotation keeps conflicting", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_1" })],
      replaces: ["conflict", "conflict", "conflict"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    await expect(refresh(source, "gho_stale"))
      .rejects.toThrow("rotation could not be saved (revision conflict)");
    expect(writes).toHaveLength(3);
  });

  it("errors when every replace throws, after retrying on a re-read", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_1" })],
      replaces: ["throw", "throw", "throw"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    await expect(refresh(source, "gho_stale"))
      .rejects.toThrow("rotation could not be saved (Error)");
    expect(writes).toHaveLength(3);
  });

  it("recovers when a transient replace error is followed by a successful write", async () => {
    const { source } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_1" })],
      replaces: ["throw", "replaced"],
    });
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", refresh_token: "ghr_2" }));
    expect(await refresh(source, "gho_stale")).toBe("gho_new");
  });

  it("returns null and records the OAuth error when the token endpoint refuses", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_revoked" })],
      replaces: [],
    });
    stubTokenEndpoint(() => Response.json({ error: "bad_refresh_token" }, { status: 400 }));
    const failure = { code: null as string | null };
    expect(await refresh(source, "gho_stale", failure)).toBeNull();
    expect(failure.code).toBe("bad_refresh_token");
    expect(writes).toEqual([]);
  });

  it("does not call the token endpoint when the stored record has no refresh token", async () => {
    const { source } = scriptedSource({ finds: [record(3, { token: "gho_stale" })], replaces: [] });
    const requests = stubTokenEndpoint();
    expect(await refresh(source, "gho_stale")).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe("applyRotation write-back timestamp", () => {
  it("stamps the rotation with the injected clock", async () => {
    const { source, writes } = scriptedSource({
      finds: [record(3, { token: "gho_stale", refreshToken: "ghr_1" })],
      replaces: ["replaced"],
    });
    let saved: StoredCredential["credential"] | undefined;
    const store: CredentialStore = {
      ...source,
      replace: async (input) => {
        saved = input.next;
        return source.replace(input);
      },
    };
    stubTokenEndpoint(() => Response.json({ access_token: "gho_new", expires_in: 60 }));
    expect(await refresh(store, "gho_stale")).toBe("gho_new");
    expect(writes).toHaveLength(1);
    expect(saved!.updatedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(saved!.auth).toMatchObject({ expiresAt: "2026-09-02T00:01:00.000Z" });
  });
});
