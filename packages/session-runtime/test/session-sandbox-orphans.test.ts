import { describe, expect, it } from "vitest";
import { reclaimOrphanSandboxes } from "../src/session-sandbox-orphans";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function lifecycle(handle: "fixed" | "changes", listed: Array<{ id: string; session: string; minutesAgo: number }>) {
  const released: string[] = [];
  return {
    released,
    port: {
      handle,
      async list() {
        return listed.map((s) => ({ handle: { provider: "fake", runtimeId: s.id }, labels: { workspaceId: "ws", sessionId: s.session }, createdAt: at(s.minutesAgo) }));
      },
      async release({ handle: h }: { handle: { runtimeId: string } }) {
        if (h.runtimeId === "boom") throw new Error("provider 503");
        released.push(h.runtimeId);
      },
    },
  };
}

describe("reclaimOrphanSandboxes", () => {
  it("drains the orphan queue and releases sandboxes of ended Sessions or replaced ones, past the minimum age", async () => {
    const l = lifecycle("changes", [
      { id: "ended", session: "s_ended", minutesAgo: 60 },
      { id: "young", session: "s_ended", minutesAgo: 5 },
      { id: "live", session: "s_live", minutesAgo: 60 },
      { id: "replaced", session: "s_live", minutesAgo: 60 },
      { id: "unrecorded", session: "s_unrecorded", minutesAgo: 60 },
      { id: "foreign", session: "s_unknown", minutesAgo: 60 },
      { id: "boom", session: "s_ended", minutesAgo: 60 },
    ]);
    const warnings: string[] = [];
    const result = await reclaimOrphanSandboxes({
      queue: { runOnce: async ({ limit }) => ({ inspected: limit === 100 ? 2 : 0, resolved: 1 }) },
      lifecycle: l.port as never,
      session: async ({ sessionId }) => ({
        s_ended: { ended: true },
        s_live: { ended: false, handle: { provider: "fake", runtimeId: "live" } },
        s_unrecorded: { ended: false },
      } as Record<string, { ended: boolean }>)[sessionId] ?? null,
      now: () => NOW,
      warn: (message) => { warnings.push(message); },
    });
    expect(l.released).toEqual(["ended", "replaced"]);
    expect(result).toEqual({ queue: { inspected: 2, resolved: 1 }, listed: 7, released: 2 });
    expect(warnings).toEqual(["sandbox_orphan_release_failed runtime=boom error=provider 503"]);
  });

  it("lists nothing for a fixed handle", async () => {
    const l = lifecycle("fixed", [{ id: "x", session: "s", minutesAgo: 60 }]);
    const result = await reclaimOrphanSandboxes({ lifecycle: l.port as never, session: async () => ({ ended: true }), now: () => NOW, warn: () => undefined });
    expect(result.listed).toBe(0);
    expect(l.released).toEqual([]);
  });
});
