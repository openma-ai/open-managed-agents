import { expect, it } from "vitest";
import { attemptSandboxTokens } from "../../sandbox-gateway/src/attempt-sandbox-token";
import { memorySandboxTokens } from "../../sandbox-gateway/test/memory-sandbox-token-store";
import { authenticateSandboxToken } from "../../sandbox-gateway/src/sandbox-token-authority";
import { createSandboxPorts } from "../src/create-sandbox-ports";
import type { SandboxAdapterPort, SandboxPortDeps } from "../src/ports";

// A native/no-relay adapter must not bypass incarnation binding. The env
// consumer and relay delivery read the real shared holder, not a fake issuer.
for (const native of [false, true]) {
  it(`binds before consumers with ${native ? "native" : "bundled"} egress, independent of Vault`, async () => {
    const memory = memorySandboxTokens({ vaultIds: () => [] });
    const holder = attemptSandboxTokens();
    let issued = 0;
    const issue = async () => { issued++; return memory.issue("all"); };
    const harnessEnv = async () => ({ ANTHROPIC_AUTH_TOKEN: await holder.token(memory.fence, issue) });
    const relayDelivery = () => holder.token(memory.fence, issue);
    const adapter: SandboxAdapterPort<{ id: string }> = {
      name: "test",
      lifecycle: {} as never,
      vendor: { sandboxIdentity: box => box.id, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => null, writeFile: async () => {}, setEnv: async () => {} },
      ...(native ? { native: { egress: () => ({ port: { attach: async () => {}, update: async () => {}, revoke: async () => {} } }) } } : {}),
    };
    const { ports } = createSandboxPorts(adapter, { storage: {} as never, egress: { gateway: {
      endpoint: { url: "https://gateway.test" },
      issueToken: ({ attempt, sandbox }) => holder.relayDelivery(attempt!, issue, sandbox),
      authenticate: async () => null, handle: async () => new Response(null, { status: 403 }),
    } } } satisfies SandboxPortDeps);
    const scope = { workspaceId: "ws", sessionId: memory.sessionId, environmentId: "env", workId: "exe" };
    const attach = (id: string) => ports.egress.attach({ runtime: { id }, scope, fence: { ...scope, ownerId: "owner", generation: 1, token: "att", expiresAt: "2030-01-01T00:00:00Z" }, policy: null, signal: new AbortController().signal });
    const old = (await harnessEnv()).ANTHROPIC_AUTH_TOKEN;
    await attach("box-1");
    await attach("box-1");
    expect(await relayDelivery()).toBe(old);
    expect((await harnessEnv()).ANTHROPIC_AUTH_TOKEN).toBe(old);
    expect(issued).toBe(1);
    await attach("box-2");
    const fresh = (await harnessEnv()).ANTHROPIC_AUTH_TOKEN;
    expect(fresh).not.toBe(old);
    expect(await relayDelivery()).toBe(fresh);
    expect(issued).toBe(2);
    expect((await authenticateSandboxToken(memory.store, { sessionId: memory.sessionId, token: old, channel: "api" })).type).toBe("rejected");
    expect((await authenticateSandboxToken(memory.store, { sessionId: memory.sessionId, token: fresh, channel: "api" })).type).toBe("accepted");
  });
}
