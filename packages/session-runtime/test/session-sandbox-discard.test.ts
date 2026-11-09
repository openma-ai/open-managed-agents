import { expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { LiveSessionSandbox } from "../src/session-sandbox-live";
import { initialSandboxState, type SessionSandboxState } from "../src/session-sandbox-state";
import { scope } from "./fake-session-sandbox-ports";

it("persists failed snapshot discards, retries after restart and clears them after derived release", async () => {
  const old = { provider: "fake", ref: "old", kind: "snapshot" as const };
  let saved: SessionSandboxState = { ...initialSandboxState(), phase: "running", handle: { provider: "fake", runtimeId: "derived" }, runStartedAt: 1, latestSnapshot: { status: "taken", ref: old } };
  let derivedAlive = true;
  const discarded: string[] = [];
  const infos: string[] = [];
  const create = () => new LiveSessionSandbox({
    compose: async () => ({ ports: { sandbox: { async discard({ ref }: { ref: { ref: string } }) {
      expect(saved).toMatchObject({ pendingDiscards: expect.arrayContaining([expect.objectContaining({ ref: ref.ref })]) });
      if (derivedAlive) throw new Error("HTTP 400: snapshot in use");
      discarded.push(ref.ref);
    } } } as unknown as SandboxPorts<object> }),
    state: { load: async () => saved, save: async (next, expected) => { if (saved.version !== expected) return false; saved = next; return true; } },
    scope: () => scope, executor: () => ({} as never), plan: async () => ({} as never),
    resumeRef: async () => null, warn: () => undefined, info: (text) => infos.push(text), outputDurability: () => null,
  });
  await create().apply(saved, { type: "publishSnapshot", ref: { ...old, ref: "latest" } });
  expect(saved).toMatchObject({ pendingDiscards: [old] });
  derivedAlive = false;
  await create().apply(saved, { type: "release" });
  expect(discarded).toEqual(["old", "latest"]);
  expect(saved.pendingDiscards ?? []).toEqual([]);
  expect(infos.some((text) => text.includes("pending_count=0"))).toBe(true);
});
