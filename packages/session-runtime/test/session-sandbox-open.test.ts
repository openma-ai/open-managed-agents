import { describe, expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox } from "../src/ports-session-sandbox";
import { SessionSandboxFenceLostError } from "../src/session-sandbox-fence";
import type { SessionSandboxExecutor } from "../src/session-sandbox-options";
import { fakeSessionSandbox } from "./fake-session-sandbox-ports";

// Opening the Session's sandbox (research/sandbox-sdk-v2-design.md §0.1
// steps 2-3): the handle record, the fence and the rollback of a failed open.

describe("Session sandbox open under the fence", () => {
  it("\"changes\": a sandbox acquired after the fence was lost is released and its handle never recorded", async () => {
    const h = fakeSessionSandbox();
    h.loseFence();
    await expect(h.sandbox.exec("first")).rejects.toBeInstanceOf(SessionSandboxFenceLostError);
    expect(h.log).toEqual(["acquire", "release:r1"]);
    expect(h.stored()).toBeUndefined();
  });
});

describe("PortsSessionSandbox", () => {
  const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
  const plan = async ({ stores }: { stores: never[] }) => ({
    from: { image: "img" }, egress: null, stores, outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" as const }, idleMs: 1, labels: { workspaceId: "ws", sessionId: "sess" },
  });

  function harness(handle: "fixed" | "changes", failEgress: () => boolean) {
    const log: string[] = [];
    let saved: { handle: { provider: string; runtimeId: string } } | undefined;
    let marker: string | null = null;
    let n = 0;
    const executor: SessionSandboxExecutor = {
      async exec(command) {
        const written = /^echo (\S+) > /.exec(command);
        if (written) marker = written[1]!;
        if (command.startsWith("cat ")) return marker === null ? "exit=1\n" : `exit=0\n${marker}\n`;
        return "exit=0\n";
      },
    } as SessionSandboxExecutor;
    const ports = {
      sandbox: {
        handle,
        async attach() { log.push("attach"); return "gone"; },
        async resume() { return "gone"; },
        async acquire() { n += 1; log.push(`acquire:${n}`); return { runtime: {}, handle: { provider: "p", runtimeId: `r${n}` } }; },
        async release({ handle: h }: { handle: { runtimeId: string } }) { log.push(`release:${h.runtimeId}`); },
        async keepAlive() { return "alive"; },
      },
      storage: { async attach() {}, async sync() {}, async detach() {} },
      egress: {
        async attach() { log.push("egress.attach"); if (failEgress()) throw new Error("egress down"); },
        async update() {},
        async revoke({ reason }: { reason: string }) { log.push(`egress.revoke:${reason}`); },
      },
    } as unknown as SandboxPorts<object>;
    const sandbox = new PortsSessionSandbox<object>({
      compose: async () => ({ ports }),
      executor: () => executor,
      state: {
        load: async () => saved as never,
        save: async (state) => { log.push(`save:${state.handle.runtimeId}`); saved = state; },
        clear: async () => { log.push("clear"); saved = undefined; },
      },
      scope: () => scope,
      plan: plan as never,
      resumeRef: async () => null,
      warn: () => undefined,
      outputDurability: () => null,
    });
    return { sandbox, log, saved: () => saved };
  }

  it("rolls back a failed open, surfaces the error, and the next open starts over", async () => {
    let fail = true;
    const h = harness("changes", () => fail);
    await expect(h.sandbox.exec("true")).rejects.toThrow("egress down");
    // "changes": the new handle is written before use; the failure revokes,
    // releases and forgets it.
    expect(h.log).toEqual(["acquire:1", "save:r1", "egress.attach", "egress.revoke:failed", "release:r1", "clear"]);
    expect(h.saved()).toBeUndefined();
    fail = false;
    expect(await h.sandbox.exec("true")).toBe("exit=0\n");
    expect(h.log.slice(6)).toEqual(["acquire:2", "save:r2", "egress.attach", "save:r2"]);
  });

  it("does not pre-write a fixed handle", async () => {
    const h = harness("fixed", () => false);
    await h.sandbox.prepare();
    expect(h.log).toEqual(["acquire:1", "egress.attach", "save:r1"]);
  });
});
