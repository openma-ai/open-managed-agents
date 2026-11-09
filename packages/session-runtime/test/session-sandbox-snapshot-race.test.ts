import { expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { LiveSessionSandbox } from "../src/session-sandbox-live";
import { takeSnapshot } from "../src/session-sandbox-snapshot";
import { runningRecord, scope } from "./fake-session-sandbox-ports";

it("a checkpoint cannot publish over a sandbox replaced while the vendor was taking it", async () => {
  let saved = runningRecord("old", { version: 3 });
  const discarded: string[] = [];
  const winner = runningRecord("new", { version: 4, latestSnapshot: { status: "taken", ref: { provider: "fake", ref: "new-snapshot", kind: "snapshot" } } });
  const state = new LiveSessionSandbox({
    compose: async () => ({ ports: { sandbox: {
      async checkpoint() { saved = winner; return { provider: "fake", ref: "old-snapshot", kind: "snapshot" }; },
      async discard({ ref }: { ref: { ref: string } }) { discarded.push(ref.ref); },
    } } as unknown as SandboxPorts<object> }),
    state: { load: async () => saved, save: async (next, expected) => { if (saved.version !== expected) return false; saved = next; return true; } },
    scope: () => scope, executor: () => ({} as never), plan: async () => ({} as never),
    resumeRef: async () => null, warn: () => undefined, outputDurability: () => null,
  });
  state.dirty = true;
  expect(await takeSnapshot(state, { runtime: {}, handle: { provider: "fake", runtimeId: "old" } }, undefined)).toBe("conflict");
  expect(saved).toEqual(winner);
  expect(discarded).toEqual(["old-snapshot"]);
});
