import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { E2BSandboxExecutor } from "../src/e2b";
it("launcher binds actual launch token to immutable process identity without exposing token", () => {
  expect(execFileSync("python3", [new URL("./managed-holder-binding.py", import.meta.url).pathname], { encoding: "utf8" })).toContain("holder binding PASS");
});
function fixture(holderHash: unknown = "a".repeat(64)) {
  const requests: Record<string, unknown>[] = [];
  const identity = { workspaceId: "w", sessionId: "s", workId: "work", attemptId: "environment-work-claim:2" };
  const locator = { sandboxId: "physical", id: "process", epoch: "epoch", pid: 41, identity, status: "running", holderHash };
  let request: Record<string, unknown>;
  const runtime = new E2BSandboxExecutor({ sandboxId: "physical", commands: { run: async () => { throw Error("no shell"); } }, kill: async () => { throw Error("no sandbox kill"); }, files: {
    write: async (path, text) => { if (path.endsWith(".json")) { request = JSON.parse(String(text)); requests.push(request); } },
    read: async path => path.endsWith("/ready") ? "oma-managed-v2" : JSON.stringify(request.op === "inspect-slot" ? { ok: true, locator } : { ok: true, status: "running" }),
  } }, { managedBootstrap: {} });
  return { runtime, requests, locator };
}
it("restored exact handle sends trusted sandbox + holder binding on status and kill", async () => {
  const f = fixture(); const handle = await f.runtime.restoreManagedProcess(await f.runtime.inspectManagedProcessSlot()); await handle.kill("SIGTERM");
  expect(f.requests.at(-1)).toMatchObject({ op: "kill", sandboxId: "physical", holderHash: "a".repeat(64), target: "process", epoch: "epoch" });
});
it("rejects malformed holder binding before restoring a native handle", async () => {
  const f = fixture("not-a-sha"); await expect(f.runtime.inspectManagedProcessSlot()).rejects.toThrow(/holder/i);
});
it("legacy consumers restore old locators without holder assertions", async () => {
  const f = fixture(); delete (f.locator as {holderHash?:unknown}).holderHash;
  const handle = await f.runtime.restoreManagedProcess(await f.runtime.inspectManagedProcessSlot());
  expect(await handle.getStatus()).toBe("running"); expect(f.requests.at(-1)).not.toHaveProperty("holderHash");
});
it("only explicit lease-recovery creation disables traffic auto-resume; old managed consumers keep their default", async () => {
  const { createE2BSandbox } = await import("../src/e2b");
  const lifecycles: unknown[] = [];
  const sdk = { Sandbox: { create: async (_template: string, options: any) => { lifecycles.push(options.lifecycle); return { sandboxId: "p" } as never; }, connect: async () => { throw Error("no connect"); } } };
  await createE2BSandbox({ managedBootstrap: { disableAutoResume: true }, readiness: false }, sdk);
  await createE2BSandbox({ managedBootstrap: {}, readiness: false }, sdk);
  await createE2BSandbox({ readiness: false }, sdk);
  expect(lifecycles).toEqual([{ onTimeout: { action: "pause", keepMemory: true }, autoResume: false }, { onTimeout: { action: "pause", keepMemory: true }, autoResume: true }, { onTimeout: { action: "pause", keepMemory: true }, autoResume: true }]);
});
