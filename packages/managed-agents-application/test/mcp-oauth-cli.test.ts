import { describe, expect, it } from "vitest";
import { McpOAuthCliService, type McpOAuthCliStore } from "../src/credentials/mcp-oauth-cli";
import type { McpOAuthApplicationPort } from "../src/ports/mcp-oauth";

function harness() {
  let now = 1000;
  let serial = 0;
  let completed = 0;
  const rows = new Map<string, string>();
  const store: McpOAuthCliStore = {
    create: async (id, value) => { rows.set(id, value); },
    read: async (id) => rows.get(id) ?? null,
    compareAndSwap: async (id, expected, value) => { if (rows.get(id) !== expected) return false; rows.set(id, value); return true; },
    consume: async (id, expected) => { if (rows.get(id) !== expected) return false; rows.delete(id); return true; },
  };
  const core: McpOAuthApplicationPort = {
    authorize: async (command) => ({ type: "redirect", authorizationUrl: `https://provider.example.test/authorize?${new URLSearchParams({ state: "console-sealed", redirect_uri: command.callbackUri })}` }),
    complete: async (command) => { completed++; expect(command.userId).toBe("user_1"); expect(command.state).toBe("console-sealed"); return { type: "connected", vaultId: "vlt_1", credentialId: "cred_1", serviceName: "Example", returnTo: "https://cp.example.test/", probeOk: true }; },
  };
  const service = new McpOAuthCliService({ store, application: (workspaceId) => { expect(workspaceId).toBe("ws_1"); return core; }, cipher: { encrypt: async (s) => `cli:${s}`, decrypt: async (s) => { if (!s.startsWith("cli:")) throw new Error("bad"); return s.slice(4); } }, secrets: { randomToken: () => `random_${++serial}`, hash: async (s) => `hash:${s}` }, clock: { now: () => new Date(now) } });
  const actor = { workspaceId: "ws_1", userId: "user_1", keyHash: "key_1" };
  const start = () => service.start({ actor, vaultId: "vlt_1", mcpServerUrl: "https://mcp.example.test/mcp", callbackUri: "https://cp.example.test/v1/oma/oauth/callback" });
  return { service, actor, start, core, completed: () => completed, expire: () => { now += 600_000; } };
}

describe("CLI MCP OAuth", () => {
  it("keeps provider callback unchanged and the claim secret out of browser state/URL", async () => {
    const h = harness();
    const started = await h.start();
    if (started.type !== "started") throw new Error(started.type);
    expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe("https://cp.example.test/v1/oma/oauth/callback");
    expect(started.authorizationUrl).not.toContain(started.claimToken);
    expect(await h.service.poll({ actor: h.actor, flowId: started.flowId, claimToken: started.claimToken })).toEqual({ type: "pending" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(await h.service.callback({ state, code: "code", callbackUri: "https://cp.example.test/v1/oma/oauth/callback" })).toEqual({ type: "completed" });
    const claims = await Promise.all([1, 2].map(() => h.service.poll({ actor: h.actor, flowId: started.flowId, claimToken: started.claimToken })));
    expect(claims).toContainEqual({ type: "ready", credentialId: "cred_1" });
    expect(claims).toContainEqual({ type: "invalid_flow" });
    expect(h.completed()).toBe(1);
    expect(JSON.stringify(claims)).not.toContain("token");
  });

  it("binds claiming to workspace, user, original API key and independent claim secret", async () => {
    const h = harness();
    const started = await h.start();
    if (started.type !== "started") throw new Error(started.type);
    for (const actor of [{ ...h.actor, workspaceId: "other" }, { ...h.actor, userId: "other" }, { ...h.actor, keyHash: "key_2" }]) {
      expect(await h.service.poll({ actor, flowId: started.flowId, claimToken: started.claimToken })).toEqual({ type: "invalid_flow" });
    }
    expect(await h.service.poll({ actor: h.actor, flowId: started.flowId, claimToken: "wrong" })).toEqual({ type: "invalid_flow" });
    expect(await h.service.callback({ state: "console-sealed", code: "c", callbackUri: "https://cp.example.test/v1/oma/oauth/callback" })).toBeNull();
  });

  it("refuses expired and replayed callbacks without running token exchange twice", async () => {
    const h = harness();
    const started = await h.start();
    if (started.type !== "started") throw new Error(started.type);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const callback = { state, code: "c", callbackUri: "https://cp.example.test/v1/oma/oauth/callback" };
    expect(await h.service.callback(callback)).toEqual({ type: "completed" });
    expect(await h.service.callback(callback)).toEqual({ type: "invalid_flow" });
    expect(h.completed()).toBe(1);
    h.expire();
    expect(await h.service.poll({ actor: h.actor, flowId: started.flowId, claimToken: started.claimToken })).toEqual({ type: "invalid_flow" });
  });

  it("does not let a different callback origin redeem a valid CLI state", async () => {
    const h = harness();
    const started = await h.start();
    if (started.type !== "started") throw new Error(started.type);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(await h.service.callback({ state, code: "c", callbackUri: "https://other.example.test/v1/oma/oauth/callback" })).toEqual({ type: "invalid_flow" });
    expect(h.completed()).toBe(0);
  });

  it("makes an internal exchange failure claimable only as a fixed failed status", async () => {
    const h = harness();
    h.core.complete = async () => { throw new Error("https://private.example.test/secret upstream body"); };
    const started = await h.start();
    if (started.type !== "started") throw new Error(started.type);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(await h.service.callback({ state, code: "c", callbackUri: "https://cp.example.test/v1/oma/oauth/callback" })).toEqual({ type: "completed" });
    expect(await h.service.poll({ actor: h.actor, flowId: started.flowId, claimToken: started.claimToken })).toEqual({ type: "failed" });
  });

  it("returns only a fixed failed status for provider denial or internal exceptions", async () => {
    const h = harness();
    const started = await h.start();
    if (started.type !== "started") throw new Error(started.type);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(await h.service.callback({ state, error: "https://private.example.test/error", callbackUri: "https://cp.example.test/v1/oma/oauth/callback" })).toEqual({ type: "completed" });
    expect(await h.service.poll({ actor: h.actor, flowId: started.flowId, claimToken: started.claimToken })).toEqual({ type: "failed" });
    expect(h.completed()).toBe(0);
  });
});
