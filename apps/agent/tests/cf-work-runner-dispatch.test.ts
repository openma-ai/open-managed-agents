import { expect, it } from "vitest";
import { createCfWorkRunnerDispatch } from "../src/runtime/cf-work-runner-dispatch";
import { attemptSandboxTokens, generateSandboxToken, sandboxTokenSha256 } from "@open-managed-agents/sandbox-gateway";
const delivery = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work", apiBaseUrl: "https://control.test", workSecret: "poll-secret" };
function fixture(options: { current?: boolean; outside?: boolean } = {}) {
  const calls: unknown[] = []; let issued = 0;
  const tokens = attemptSandboxTokens(); const token = generateSandboxToken();
  const sandbox = { runtimeHandle: () => ({ provider: "cloudflare", runtimeId: "physical" }), async setOutboundContext(input: unknown) { calls.push(["egress", input]); }, async startWorkRunner(input: unknown) { calls.push(["start", input]); return { id: "p", pid: 1, kill: async () => {}, getStatus: async () => "running" }; } };
  const dispatch = createCfWorkRunnerDispatch({
    command: "/opt/openma/bin/openma-acp-work-item",
    async authorize(input) { calls.push(["authorize", input]); if (options.current === false) return null; return { generation: 1, environment: { config: { type: "cloud" } }, session: { id: "sess", environmentId: "env", agent: { openma: { harness: options.outside ? "default" : "acp-sandbox" } } }, harness: { id: "pinned-acp", version: "1.2.3" } }; },
    tokens,
    async issueToken(_input, scope) { issued++; calls.push(["issue", scope]); return token; },
    async sandbox() { calls.push(["sandbox"]); return sandbox; },
  });
  return { dispatch, calls, token, issued: () => issued };
}
it("trusted pin fixes all before first issuance and shares the same token with egress and runner", async () => {
  const f = fixture(); await f.dispatch.dispatch({ ...delivery, signal: new AbortController().signal, selection: { sandboxTokenScope: "egress" } } as never);
  expect(f.calls.map(c => (c as unknown[])[0])).toEqual(["authorize", "sandbox", "issue", "egress", "start"]);
  expect(f.calls[2]).toEqual(["issue", "all"]);
  const egress = (f.calls[3] as unknown[])[1] as { tokenSha256: string }; expect(egress.tokenSha256).toBe(await sandboxTokenSha256(f.token));
  const launch = (f.calls[4] as unknown[])[1] as { env: Record<string, string> };
  expect(launch.env.OPENMA_HARNESS_ID).toBe("pinned-acp"); expect(launch.env.OPENMA_HARNESS_VERSION).toBe("1.2.3");
  expect(launch.env.ANTHROPIC_WORK_SECRET).toBe(delivery.workSecret);
  expect(launch.env.OPENMA_SANDBOX_TOKEN).toBe(f.token);
  expect(launch.env.ANTHROPIC_ENVIRONMENT_KEY).toBeUndefined();
});
it("repeated delivery reuses existing attempt holder rather than adding an egress token", async () => {
  const f = fixture(); await f.dispatch.dispatch({ ...delivery, signal: new AbortController().signal }); await f.dispatch.dispatch({ ...delivery, signal: new AbortController().signal }); expect(f.issued()).toBe(1);
});
it("lost claim never reaches token or provider", async () => {
  const f = fixture({ current: false }); await expect(f.dispatch.dispatch({ ...delivery, signal: new AbortController().signal })).rejects.toThrow(); expect(f.calls.map(c => (c as unknown[])[0])).toEqual(["authorize"]);
});
it("outside MA cloud placement is not bootstrapped as another brain", async () => {
  const f = fixture({ outside: true }); await expect(f.dispatch.dispatch({ ...delivery, signal: new AbortController().signal })).rejects.toThrow(); expect(f.calls.map(c => (c as unknown[])[0])).toEqual(["authorize"]);
});
it("already aborted delivery has no authority or provider effects", async () => {
  const f = fixture(); const signal = AbortSignal.abort(); await expect(f.dispatch.dispatch({ ...delivery, signal })).rejects.toThrow(); expect(f.calls).toEqual([]);
});

it.each(["workspaceId", "environmentId", "sessionId", "workId", "workSecret"] as const)("missing %s is rejected before authority or provider", async key => {
  const f = fixture(); await expect(f.dispatch.dispatch({ ...delivery, [key]: "", signal: new AbortController().signal })).rejects.toThrow(); expect(f.calls).toEqual([]);
});
