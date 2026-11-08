import { describe, expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox, type SessionSandboxExecution, type SessionSandboxExecutor, type SessionSandboxState } from "@open-managed-agents/session-runtime";

// Characterization (#545 sandbox core move): what the Session sandbox runtime
// does today at the points the core-driven lifecycle (design §0.1 steps 7–9)
// changes. Kept green across the move; deliberate changes are made in their
// own commit with the reason next to each assertion. SessionDO and the E2B
// composition now hand the core the execution attempt (`execution`), and
// turn end calls endExecution.

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };

const attempt = (attemptId: string): SessionSandboxExecution => ({ executionId: "exec_1", attemptId, ownerId: "do", generation: 1 });

function harness(opts: { execution?: () => SessionSandboxExecution | undefined } = {}) {
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
    ...(opts.execution === undefined ? {} : { execution: opts.execution }),
  });
  return { sandbox, log, fences, stored: () => stored };
}

describe("Session sandbox runtime today (characterization)", () => {
  // Deliberate change (design §0.1 step 7): SessionDO's turn end is the
  // execution end. Egress is revoked before the write-back (it was left bound
  // across turns), the handle is recorded; nothing is paused here.
  it("turn end revokes egress, then syncs storage; the next call re-attaches egress on the same sandbox", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    await h.sandbox.endExecution();
    expect(h.log).toEqual(["egress.revoke:completed", "storage.sync:turn_end"]);
    // The sandbox stays live: the next call runs on it without reopening.
    await h.sandbox.exec("next");
    expect(h.log).toEqual(["egress.revoke:completed", "storage.sync:turn_end", "egress.attach", "exec:next"]);
  });

  // Deliberate change (design §0.0 rule 10): Port calls carry the execution
  // attempt SessionDO holds; only without one the single-writer placeholder.
  it("storage calls carry the execution attempt as the fence; between executions the placeholder", async () => {
    let execution: SessionSandboxExecution | undefined = attempt("att_1");
    const h = harness({ execution: () => execution });
    await h.sandbox.mountSessionOutputs();
    await h.sandbox.syncStorage("turn_end");
    expect(h.fences).toHaveLength(2);
    for (const fence of h.fences) {
      expect(fence).toMatchObject({ ...scope, workId: "exec_1", ownerId: "do", generation: 1, token: "att_1" });
    }
    execution = undefined;
    await h.sandbox.syncStorage("turn_end");
    expect(h.fences.at(-1)).toMatchObject({ ...scope, ownerId: "session-do", generation: 1, token: "session-do" });
  });

  it("destroy detaches storage, revokes egress, releases and forgets the handle", async () => {
    const h = harness();
    await h.sandbox.exec("a");
    h.log.length = 0;
    await h.sandbox.destroy();
    expect(h.log).toEqual(["storage.detach", "egress.revoke:completed", "release", "clear"]);
  });

  // Same behaviour, now keyed by the execution attempt itself (the
  // separate egressKey option is gone).
  it("re-attaches egress at the next exec boundary when the execution attempt changes", async () => {
    let execution = attempt("att_1");
    const h = harness({ execution: () => execution });
    await h.sandbox.exec("a");
    await h.sandbox.exec("b");
    expect(h.log.filter((e) => e === "egress.attach")).toHaveLength(1);
    execution = attempt("att_2");
    await h.sandbox.exec("c");
    expect(h.log.slice(-2)).toEqual(["egress.attach", "exec:c"]);
  });

});
