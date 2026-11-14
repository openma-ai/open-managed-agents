import { describe, expect, it } from "vitest";
import { loadNodeManagedAcpRecoveryHistory } from "../../../packages/control-plane-node/src/lib/node-managed-acp-recovery";

function event(id: string, type: "user.message" | "agent.message") {
  return type === "user.message"
    ? { id, type, content: [{ type: "text" as const, text: id }], processedAt: "2026-11-14T00:00:00.000Z" }
    : { id, type, content: [{ type: "text" as const, text: id }], processedAt: "2026-11-14T00:00:01.000Z" };
}

describe("Node ACP recovery history", () => {
  it("keeps a steered input consumed by the recovering execution when no output followed it", async () => {
    const steer = event("steer", "user.message");
    const unrelated = event("unrelated", "user.message");
    const sql = {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [] }) }),
      }),
    } as never;
    const history = {
      initialEvents: [],
      events: [steer, unrelated],
      orderedEvents: [
        { event: steer, position: { revision: 2, index: 0 }, executionId: "steer-source", consumedByExecutionId: "recovering" },
        { event: unrelated, position: { revision: 3, index: 0 }, executionId: "other", consumedByExecutionId: "other" },
      ],
    };

    const recovered = await loadNodeManagedAcpRecoveryHistory({
      sql,
      history: { load: async () => history },
      fence: {
        workspaceId: "w",
        sessionId: "s",
        executionId: "recovering",
        attemptId: "attempt-2",
        ownerId: "owner",
        generation: 2,
        expiresAt: "2026-11-14T00:10:00.000Z",
      },
      acceptedEvents: [],
    });

    expect(recovered.map((item) => item.id)).toEqual(["steer"]);
  });
});
