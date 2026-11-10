import { describe, expect, it } from "vitest";
import { createNodeEnvironmentWorkWorker } from "../../control-plane-node/src/lib/node-environment-work-worker";

describe("Node Work host recovery tick", () => {
  it("runs bounded discovery on host reconstruction even without a local runner", async () => {
    const pages: unknown[] = [];
    const create = () => createNodeEnvironmentWorkWorker({
      config: { sandbox: { environment: {} }, http: {}, execution: { ownerId: "node" } },
      sql: {}, work: {}, sandboxes: {}, capabilities: {}, application: () => ({}), onError: () => {},
      recovery: { recoverSchedulingPage: async (input: unknown) => { pages.push(input); return { scanned: 0, next: null }; } },
    } as never);
    const first = create(); await first.start(); await first.stop();
    const second = create(); await second.start(); await second.stop();
    expect(pages).toHaveLength(2);
    expect(pages).toMatchObject([{ limit: 20 }, { limit: 20 }]);
  });
});

// The production CF scheduler must expose a bounded recovery factory, rather
// than request-only application wiring or a new timer.
it("CF recovery factory is available to the existing cron", async () => {
  const { cfSessionSchedulingRecovery } = await import("../../../apps/main/src/lib/cf-scheduler-jobs");
  expect(typeof cfSessionSchedulingRecovery).toBe("function");
});
