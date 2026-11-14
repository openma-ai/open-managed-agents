import { describe, expect, it } from "vitest";
import { WorkFinalizationApplication } from "../src/work-finalization/application";
import type {
  WorkFinalizationPersistencePort,
  WorkTerminalReceipt,
  WorkTurnState,
} from "../src/work-finalization/ports";

const claim = {
  workspaceId: "workspace",
  environmentId: "environment",
  sessionId: "session",
  workId: "work",
  generation: 1,
  holder: "holder",
};
const terminal: WorkTerminalReceipt = {
  eventId: "terminal-event",
  turnId: "turn",
  workId: claim.workId,
  generation: claim.generation,
  revision: 3,
  stopReason: { type: "end_turn" },
};

describe("WorkFinalizationApplication", () => {
  it("accepts same-turn revision advances while publishing a terminal", async () => {
    let revision = 3;
    const persistence: WorkFinalizationPersistencePort = {
      async inspect(): Promise<WorkTurnState> {
        return { type: "current", revision, consumed: true, terminal };
      },
      async commit() {
        throw new Error("commit is not used by publish");
      },
    };
    let hostSawCurrent = false;
    const app = new WorkFinalizationApplication({
      persistence,
      host: {
        async prepare() {
          throw new Error("prepare is not used by publish");
        },
        async publish(scope) {
          revision = 4;
          hostSawCurrent = await scope.isCurrent();
          return { type: "published" };
        },
      },
    });

    await expect(app.publish({
      claim,
      turnId: terminal.turnId,
      revision: terminal.revision,
      terminalEventId: terminal.eventId,
    })).resolves.toMatchObject({ type: "published" });
    expect(hostSawCurrent).toBe(true);
  });
});
