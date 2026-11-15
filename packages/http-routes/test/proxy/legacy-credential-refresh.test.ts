import { describe, expect, it, vi } from "vitest";
import { createInMemoryCredentialService } from "@open-managed-agents/credentials-store/test-fakes";
import { refreshLegacyCredential } from "../../src/proxy/legacy-credential-refresh";

const TENANT = "ws";
const VAULT = "vlt_1";
const TOKEN_EP = "https://auth.test/token";

async function seed(auth: Record<string, unknown>) {
  const { service } = createInMemoryCredentialService();
  const credential = await service.create({
    tenantId: TENANT,
    vaultId: VAULT,
    displayName: "oauth",
    auth: { type: "mcp_oauth", mcp_server_url: "https://docs.test/mcp", refresh_token: "refresh-1", token_endpoint: TOKEN_EP, ...auth } as never,
  });
  const row = { tenantId: TENANT, vaultId: VAULT, credentialId: credential.id };
  return {
    service,
    row,
    refresh: { refreshToken: "refresh-1", tokenEndpoint: TOKEN_EP, clientId: "client", credentialId: credential.id, vaultId: VAULT },
    stored: async () => (await service.get(row))!.auth as unknown as Record<string, unknown>,
  };
}
const tokens = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status }));

describe("refreshLegacyCredential", () => {
  it("uses a token another refresh already stored, without calling the token endpoint", async () => {
    const { service, refresh } = await seed({ access_token: "rotated-elsewhere" });
    const fetch = vi.fn();
    expect(await refreshLegacyCredential({ credentials: service, fetch }, TENANT, refresh, "stale")).toBe("rotated-elsewhere");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exchanges the refresh token and writes the rotation back with compare-and-swap", async () => {
    const { service, refresh, stored } = await seed({ access_token: "stale" });
    const cas = vi.spyOn(service, "refreshAuthCAS");
    const fetch = tokens({ access_token: "fresh", refresh_token: "refresh-2", expires_in: 3600 });
    const before = Date.now();
    expect(await refreshLegacyCredential({ credentials: service, fetch }, TENANT, refresh, "stale")).toBe("fresh");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_EP);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client" });
    expect(cas).toHaveBeenCalledOnce();
    const auth = await stored();
    expect(auth).toMatchObject({ access_token: "fresh", refresh_token: "refresh-2" });
    expect(Date.parse(String(auth.expires_at))).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it("adopts the winner's token when the compare-and-swap loses", async () => {
    const { service, row, refresh, stored } = await seed({ access_token: "stale" });
    const fetch = vi.fn(async () => {
      await service.refreshAuth({ ...row, auth: { access_token: "winner" } });
      return Response.json({ access_token: "ours", refresh_token: "refresh-2" });
    });
    expect(await refreshLegacyCredential({ credentials: service, fetch }, TENANT, refresh, "stale")).toBe("winner");
    expect((await stored()).access_token).toBe("winner");
  });

  it("adopts a concurrent winner's token when the token endpoint refuses an already rotated refresh token", async () => {
    const { service, row, refresh } = await seed({ access_token: "stale" });
    const fetch = vi.fn(async () => {
      await service.refreshAuth({ ...row, auth: { access_token: "winner" } });
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    const failure = { code: null as string | null };
    expect(await refreshLegacyCredential({ credentials: service, fetch }, TENANT, refresh, "stale", failure)).toBe("winner");
    expect(failure.code).toBe("invalid_grant");
  });

  it("returns null and the failure code when the refresh is refused and nothing rotated", async () => {
    const { service, refresh, stored } = await seed({ access_token: "stale" });
    const failure = { code: null as string | null };
    expect(await refreshLegacyCredential({ credentials: service, fetch: tokens({ error: "invalid_grant" }, 400) }, TENANT, refresh, "stale", failure)).toBeNull();
    expect(failure.code).toBe("invalid_grant");
    expect((await stored()).access_token).toBe("stale");
  });

  it("persists without compare-and-swap when the row could not be read first", async () => {
    const { service, refresh, stored } = await seed({ access_token: "stale" });
    const credentials = {
      listByVaults: service.listByVaults.bind(service),
      get: service.get.bind(service),
      getRawForRefresh: async () => { throw new Error("d1 unavailable"); },
      refreshAuth: vi.fn(service.refreshAuth.bind(service)),
      refreshAuthCAS: vi.fn(),
    };
    expect(await refreshLegacyCredential({ credentials, fetch: tokens({ access_token: "fresh" }) }, TENANT, refresh, "stale")).toBe("fresh");
    expect(credentials.refreshAuth).toHaveBeenCalledOnce();
    expect(credentials.refreshAuthCAS).not.toHaveBeenCalled();
    expect((await stored()).access_token).toBe("fresh");
  });

  it("reads and writes a cap_cli token under auth.token", async () => {
    const { service, refresh, stored } = await seed({ type: "cap_cli", cli_id: "gh", token: "stale" });
    const fetch = tokens({ access_token: "fresh", refresh_token: "refresh-2" });
    expect(await refreshLegacyCredential({ credentials: service, fetch }, TENANT, { ...refresh, tokenField: "token" }, "stale")).toBe("fresh");
    expect(await stored()).toMatchObject({ token: "fresh", refresh_token: "refresh-2" });
  });
});
