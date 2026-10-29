import { describe, expect, it } from "vitest";
import { createBuiltinCapDeviceFlow } from "../src/index";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");

function recordingFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses[calls.length - 1]!();
    },
  };
}

describe("CapDeviceFlow", () => {
  it("drives the gh spec's RFC 8628 endpoints and maps the issued token", async () => {
    const http = recordingFetch([
      () => Response.json({
        device_code: "dc_1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      }),
      () => Response.json({ error: "authorization_pending" }),
      () => Response.json({ error: "slow_down" }),
      () => Response.json({ access_token: "gho_1", refresh_token: "ghr_1", token_type: "bearer", expires_in: 60 }),
    ]);
    const flow = createBuiltinCapDeviceFlow({ fetch: http.fetch, clock: { nowMs: () => NOW } });

    const started = await flow.initiate("gh");
    expect(started).toEqual({
      type: "started",
      state: {
        deviceCode: "dc_1",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5,
        expiresAtMs: NOW + 900_000,
      },
    });
    expect(http.calls[0]!.url).toBe("https://github.com/login/device/code");
    if (started.type !== "started") throw new Error("not started");

    expect(await flow.poll("gh", started.state)).toEqual({ type: "pending" });
    expect(await flow.poll("gh", started.state)).toEqual({ type: "slow_down", intervalSeconds: 10 });
    expect(await flow.poll("gh", started.state)).toEqual({
      type: "ready",
      token: {
        token: "gho_1",
        refreshToken: "ghr_1",
        expiresAt: new Date(NOW + 60_000).toISOString(),
        extras: { token_type: "bearer" },
      },
    });
    expect(http.calls[1]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(new TextDecoder().decode(http.calls[1]!.init.body as ArrayBuffer)).toContain("device_code=dc_1");
  });

  it("reports unknown CLIs and CLIs without a device flow without any HTTP", async () => {
    const http = recordingFetch([]);
    const flow = createBuiltinCapDeviceFlow({ fetch: http.fetch });
    expect(await flow.initiate("not-a-cli")).toEqual({ type: "unknown_cli" });
    expect(await flow.initiate("fly")).toEqual({ type: "no_device_flow" });
    expect(http.calls).toEqual([]);
  });

  it("surfaces an unreachable or malformed upstream as an error, not a throw", async () => {
    const flow = createBuiltinCapDeviceFlow({
      fetch: async () => { throw new Error("network down"); },
    });
    expect(await flow.initiate("gh")).toMatchObject({ type: "upstream_error" });
  });
});
