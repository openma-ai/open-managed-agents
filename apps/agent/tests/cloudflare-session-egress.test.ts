import { describe, expect, it } from "vitest";
import { attemptSandboxTokens, sandboxTokenSha256, generateSandboxToken } from "@open-managed-agents/sandbox-gateway";
import { executionEgress, type SandboxExecutionFence } from "../src/runtime/cloudflare-session-sandbox";

const session = () => ({ tenantId: "ws", environmentId: "env", sessionId: "sess", agentId: null });
const fence = (attemptId: string): SandboxExecutionFence => ({ executionId: "exe", attemptId, ownerId: "owner", generation: 1 });

/** SessionDO's composition: one holder, the relay delivery for egress and `token` for the ACP harness. */
function harness() {
  const tokens = attemptSandboxTokens();
  const issued: string[] = [];
  const issue = async () => { const token = generateSandboxToken(); issued.push(token); return token; };
  let current: SandboxExecutionFence | undefined = fence("a1");
  const bound: unknown[] = [];
  let incarnation = "box-1";
  const runtime = { describeSandbox: async () => ({ running: true, incarnation, mounts: [] }), setOutboundContext: async (input: unknown) => { bound.push(input); } } as never;
  const warnings: string[] = [];
  const port = executionEgress({ session, fence: () => current, relayToken: (attempt, sandbox) => tokens.relayDelivery(attempt, issue, sandbox), warn: (message) => warnings.push(message) });
  const harnessToken = () => tokens.token({ workspaceId: "ws", sessionId: "sess", ...current! }, issue);
  return { port, runtime, bound, issued, warnings, harnessToken, replace: () => { incarnation = "box-2"; }, next: (f?: SandboxExecutionFence) => { current = f; } };
}

describe("Cloudflare Session egress binding: the attempt's sandbox token (#561, design §0.0b B)", () => {
  it("binds the token digest (never the token, never required, no fence) and shares it with the ACP harness", async () => {
    const h = harness();
    await h.port.attach({ runtime: h.runtime } as never);
    const shared = await h.harnessToken();
    expect(h.issued).toEqual([shared]);
    expect(h.bound).toEqual([{ tenantId: "ws", sessionId: "sess", tokenSha256: await sandboxTokenSha256(shared) }]);
    expect(JSON.stringify(h.bound)).not.toContain("oma_sbx_");
  });

  it("repeated native attach and update keep the same attempt token", async () => {
    const h = harness();
    await h.port.attach({ runtime: h.runtime } as never);
    await h.port.attach({ runtime: h.runtime } as never);
    await h.port.update({ runtime: h.runtime } as never);
    expect(h.issued).toHaveLength(1);
    expect(h.bound[0]).toEqual(h.bound[1]);
    expect(h.bound[1]).toEqual(h.bound[2]);
  });

  it("the same attempt on a new physical incarnation binds a replacement digest", async () => {
    const h = harness();
    await h.port.attach({ runtime: h.runtime } as never);
    h.replace();
    await h.port.update({ runtime: h.runtime } as never);
    await h.port.attach({ runtime: h.runtime } as never);
    expect(h.issued).toHaveLength(2);
    expect(h.bound[0]).not.toEqual(h.bound[1]);
    expect(h.bound[1]).toEqual(h.bound[2]);
    expect(await h.harnessToken()).toBe(h.issued[1]);
  });

  it("revoke unbinds the token; the next attempt binds a new one", async () => {
    const h = harness();
    await h.port.attach({ runtime: h.runtime } as never);
    await h.port.revoke({ runtime: h.runtime } as never);
    expect(h.bound[1]).toEqual({ tenantId: "ws", sessionId: "sess" });
    h.next(fence("a2"));
    await h.port.attach({ runtime: h.runtime } as never);
    expect(h.issued).toHaveLength(2);
    expect(h.bound[2]).toEqual({ tenantId: "ws", sessionId: "sess", tokenSha256: await sandboxTokenSha256(h.issued[1]!) });
    expect(await h.harnessToken()).toBe(h.issued[1]);
  });

  it("a token that cannot be issued binds none and warns (no Vault; the turn goes on)", async () => {
    const bound: unknown[] = []; const warnings: string[] = [];
    const port = executionEgress({ session: () => ({ ...session(), sessionId: "sess-legacy" }), fence: () => fence("a1"), relayToken: async () => { throw new Error("Session sess-legacy was not found"); }, warn: (m) => warnings.push(m) });
    await port.attach({ runtime: { describeSandbox: async () => ({ running: true, incarnation: "box-1", mounts: [] }), setOutboundContext: async (input: unknown) => { bound.push(input); } } } as never);
    expect(bound).toEqual([{ tenantId: "ws", sessionId: "sess-legacy" }]);
    expect(warnings).toEqual([expect.stringContaining("no sandbox token (Session sess-legacy was not found)")]);
  });

  it.each([
    ["session_managed", "Session session_managed was not found"],
    ["session_managed", "Sandbox token Session Execution fence is stale"],
    ["session_managed", "Sandbox token scope egress differs from this execution attempt's"],
    ["session_managed", "store unavailable"],
    ["sess-legacy", "Sandbox token Session Execution fence is stale"],
    ["sess-legacy", "store unavailable"],
    ["sess-legacy", "Sandbox token is malformed"],
  ])("rejects token failure without binding or warning: %s / %s", async (sessionId, message) => {
    const failure = new Error(message);
    const bound: unknown[] = [], warnings: string[] = [];
    const port = executionEgress({ session: () => ({ ...session(), sessionId }), fence: () => fence("a1"), relayToken: async () => { throw failure; }, warn: m => { warnings.push(m); } });
    const runtime = { describeSandbox: async () => ({ incarnation: "box-1" }), setOutboundContext: async (value: unknown) => { bound.push(value); } };
    await expect(port.attach({ runtime } as never)).rejects.toBe(failure);
    await expect(port.update({ runtime } as never)).rejects.toBe(failure);
    expect(bound).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("between turns (no attempt) binds no token", async () => {
    const h = harness();
    h.next(undefined);
    await h.port.attach({ runtime: h.runtime } as never);
    expect(h.bound).toEqual([{ tenantId: "ws", sessionId: "sess" }]);
    expect(h.issued).toEqual([]);
  });
});
