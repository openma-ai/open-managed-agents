import { describe, expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox, type SessionSandboxExecutor, type SessionSandboxState } from "@open-managed-agents/session-runtime";

// Characterization (#545 sandbox core move): what the Session sandbox runtime
// does today at the points the core-driven lifecycle (design §0.1 steps 7–9)
// changes. Kept green across the move; deliberate changes are made in their
// own commit with the reason next to each assertion.

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };

function harness(opts: { key?: () => string } = {}) {
  const log: string[] = [];
  const fences: unknown[] = [];
  let stored: SessionSandboxState | undefined;
  let marker: string | null = null;
  const executor = {
    async exec(command: string) {
      const written = /^echo (\S+) > /.exec(command);
      if (written) { marker = written[1]!; return "exit=0\n"; }
      if (command.startsWith("cat ")) return marker === null ? "exit=1\n" : `exit=0\n${marker}\n`;
      log.push(`exec:${command}`);
      return "exit=0\n";
    },
    async setEnvVars() {},
  } as unknown as SessionSandboxExecutor;
  const ports = {
    sandbox: {
      handle: "changes",
      maxLifetimeMs: null,
      async attach() { log.push("attach"); return "gone"; },
      async resume() { return "gone"; },
      async acquire() { log.push("acquire"); return { runtime: {}, handle: { provider: "fake", runtimeId: "r1" } }; },
      async pause() { log.push("pause"); return { provider: "fake", ref: "r1" }; },
      async release() { log.push("release"); },
      async keepAlive() { log.push("keepAlive"); return "alive"; },
    },
    storage: {
      async attach({ fence }: { fence: unknown }) { log.push("storage.attach"); fences.push(fence); },
      async sync({ reason, fence }: { reason: string; fence: unknown }) { log.push(`storage.sync:${reason}`); fences.push(fence); },
      async detach() { log.push("storage.detach"); },
    },
    egress: {
      async attach() { log.push("egress.attach"); },
      async update() {},
      async revoke({ reason }: { reason: string }) { log.push(`egress.revoke:${reason}`); },
    },
  } as unknown as SandboxPorts<object>;
  const sandbox = new PortsSessionSandbox<object>({
    compose: async () => ({ ports }),
    executor: () => executor,
    state: {
      load: async () => stored,
      save: async (state) => { stored = state; },
      clear: async () => { log.push("clear"); stored = undefined; },
    },
    scope: () => scope,
    plan: async ({ stores }) => ({
      from: { image: "img" }, egress: null, stores, outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" }, idleMs: 1, labels: { workspaceId: "ws", sessionId: "sess" },
    }),
    resumeRef: async () => null,
    warn: () => undefined,
    outputDurability: () => null,
    egressRenewMs: null,
    ...(opts.key === undefined ? {} : { egressKey: opts.key }),
  });
  return { sandbox, log, fences, stored: () => stored };
}

describe("Session sandbox runtime today (characterization)", () => {
  it("turn end only syncs storage: no egress revoke and nothing paused or scheduled", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    await h.sandbox.syncStorage("turn_end");
    expect(h.log).toEqual(["storage.sync:turn_end"]);
    // The sandbox stays live: the next call runs on it without reopening.
    await h.sandbox.exec("next");
    expect(h.log).toEqual(["storage.sync:turn_end", "exec:next"]);
  });

  it("storage calls carry the single-writer placeholder fence, not the execution attempt", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    await h.sandbox.syncStorage("turn_end");
    expect(h.fences).toHaveLength(2);
    for (const fence of h.fences) {
      expect(fence).toMatchObject({ ...scope, ownerId: "session-do", generation: 1, token: "session-do" });
    }
  });

  it("destroy detaches storage, revokes egress, releases and forgets the handle", async () => {
    const h = harness();
    await h.sandbox.exec("a");
    h.log.length = 0;
    await h.sandbox.destroy();
    expect(h.log).toEqual(["storage.detach", "egress.revoke:completed", "release", "clear"]);
  });

  it("re-attaches egress at the next exec boundary when the execution key changes", async () => {
    let key = "exec-1";
    const h = harness({ key: () => key });
    await h.sandbox.exec("a");
    await h.sandbox.exec("b");
    expect(h.log.filter((e) => e === "egress.attach")).toHaveLength(1);
    key = "exec-2";
    await h.sandbox.exec("c");
    expect(h.log.slice(-2)).toEqual(["egress.attach", "exec:c"]);
  });

});
