import { describe, expect, it } from "vitest";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import { attempt, fakeSessionSandbox } from "./fake-session-sandbox-ports";

// Renewals at exec boundaries (research/sandbox-sdk-v2-design.md §0.1 step 5).

describe("Session sandbox exec-boundary renewals", () => {
  it.each([false, true])("confirms duplex loss only from the same provider handle (gone: %s)", async gone => {
    const h = fakeSessionSandbox({keepAliveGone:gone});
    const process = await h.sandbox.spawnDuplexProcess({command:"acp"});
    const before = h.log.length;
    expect(await process.confirmSandboxGone!()).toBe(gone);
    expect(h.log.slice(before)).toEqual(["keepAlive"]);
  });
  it("keeps confirmation bound to durable attempt identity when the host refreshes its fence object", async () => {
    const h=fakeSessionSandbox({keepAliveGone:true});
    const process=await h.sandbox.spawnDuplexProcess({command:"acp"});
    h.setExecution({...attempt});
    expect(await process.confirmSandboxGone!()).toBe(true);
  });

  it("never confirms loss for a newer execution attempt", async () => {
    const h=fakeSessionSandbox({keepAliveGone:true});
    const process=await h.sandbox.spawnDuplexProcess({command:"acp"});
    h.setExecution({...attempt,attemptId:"replacement",generation:4});
    const before=h.log.length;
    expect(await process.confirmSandboxGone!()).toBe(false);
    expect(h.log.slice(before)).toEqual([]);
  });

  it("keepAlive renews the provider lease every keepAliveMs, only at exec boundaries", async () => {
    const h = fakeSessionSandbox({ keepAliveMs: 60_000 });
    await h.sandbox.exec("first");
    expect(h.log).not.toContain("keepAlive");
    h.advance(60_000);
    await h.sandbox.exec("second");
    expect(h.log.slice(-2)).toEqual(["keepAlive", "exec:second"]);
    h.advance(30_000);
    await h.sandbox.exec("third");
    expect(h.log.filter((entry) => entry === "keepAlive")).toHaveLength(1);
  });

  it("a sandbox gone at keepAlive fails the call, then the turn-end sync once", async () => {
    const h = fakeSessionSandbox({ keepAliveMs: 60_000, keepAliveGone: true });
    await h.sandbox.mountSessionOutputs();
    h.advance(60_000);
    await expect(h.sandbox.exec("lost")).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(h.sandbox.syncStorage("turn_end")).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(h.sandbox.syncStorage("turn_end")).resolves.toBeUndefined();
  });
});
