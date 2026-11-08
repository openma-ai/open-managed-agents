import { describe, expect, it } from "vitest";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import { fakeSessionSandbox } from "./fake-session-sandbox-ports";

// Renewals at exec boundaries (research/sandbox-sdk-v2-design.md §0.1 step 5).

describe("Session sandbox exec-boundary renewals", () => {
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
