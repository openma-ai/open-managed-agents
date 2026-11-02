import { describe, expect, it } from "vitest";
import "../test-worker";
import { registerTestHarnesses } from "../harnesses";
import { registerHarness, resolveHarness } from "../../apps/agent/src/harness/registry";

// Import the actual combined worker in workerd, not a copied registration list.
describe("CF shared test harness registration", () => {
  it("can initialize again after the worker without losing ordered messages", async () => {
    registerTestHarnesses();
    registerTestHarnesses();
    const events: unknown[] = [];
    await resolveHarness("multi-msg").run({
      runtime: { broadcast: (event: unknown) => events.push(event) },
    } as never);
    expect(events).toEqual(["msg1", "msg2", "msg3"].map((text) => ({
      type: "agent.message", content: [{ type: "text", text }],
    })));
  });

  it("still rejects duplicate registrations outside the initializer", () => {
    expect(() => registerHarness("multi-msg", () => ({ async run() {} }))).toThrow(/already registered/);
  });

  it("keeps fixed replies distinct from input echoes", async () => {
    for (const [id, text] of [["echo-test", "echo: hello"], ["features-echo-test", "echo reply"]]) {
      const events: unknown[] = [];
      await resolveHarness(id).run({
        userMessage: { content: [{ type: "text", text: "hello" }] },
        runtime: { broadcast: (event: unknown) => events.push(event) },
      } as never);
      expect(events).toEqual([{ type: "agent.message", content: [{ type: "text", text }] }]);
    }
  });
});
