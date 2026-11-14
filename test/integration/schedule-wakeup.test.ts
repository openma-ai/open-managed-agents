// @ts-nocheck
//
// schedule-wakeup — DO-level integration
//
// Goal: simulate an agent calling the `schedule` tool end-to-end against a
// real SessionDO, then verify the agents-framework alarm fires, the synthetic
// user.message lands in the event log with the right metadata, and cron
// list/cancel works.
//
// Canonical Sessions are created through the public API. The real schedule
// tool and DO alarm own event generation; tests never seed wakeup events.

import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { registerTestHarnesses } from "../harnesses";
import { buildTools } from "../../packages/agent-harness/src/tools";
import { ensureModelCards } from "./_model-cards";
import { createScheduleSession } from "../fixtures/schedule-session";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";

registerTestHarnesses();

const TOOL_EXEC_OPTS = { toolCallId: "tc_test", messages: [], abortSignal: undefined as any };

const AGENT_CFG = {
  id: "agent_sched_test",
  name: "ScheduleTest",
  model: "claude-sonnet-4-6",
  system: "test",
  tools: [{ type: "agent_toolset_20260401" }],
  version: 1,
  created_at: new Date().toISOString(),
};

async function getEvents(stub: DurableObjectStub): Promise<any[]> {
  const ev = await stub.fetch(new Request("http://internal/events"));
  expect(ev.status, await ev.clone().text()).toBe(200);
  const json = await ev.json();
  return (json as { data: any[] }).data;
}

describe("schedule tool — agent tool-call → alarm → wakeup event", () => {
  beforeAll(() => ensureModelCards(["claude-sonnet-4-6"]));

  it("delay_seconds: tool execute writes a real schedule row + span event", async () => {
    const { stub } = await createScheduleSession("oneshot");

    // Simulate the model emitting a `schedule` tool call. buildTools is
    // exactly what the harness uses; the env closure binds to the live DO
    // instance so .scheduleWakeup() runs the real agents-framework path.
    let scheduleResult: any;
    let listedAfter: any[];
    await runInDurableObject(stub, async (instance) => {
      const sandbox = new TestSandbox();
      const tools = await buildTools(AGENT_CFG, sandbox, {
        scheduleWakeup: (a) => instance.scheduleWakeup(a),
        cancelWakeup: (id) => instance.cancelWakeup(id),
        listWakeups: () => instance.listWakeups(),
      });
      expect(tools.schedule).toBeDefined();

      scheduleResult = await tools.schedule.execute(
        { delay_seconds: 5, prompt: "wake up: ping the user" },
        TOOL_EXEC_OPTS,
      );

      // Verify schedule landed in the agents framework's table by listing it
      // back — same path list_schedules tool uses.
      const listOut = await tools.list_schedules.execute({}, TOOL_EXEC_OPTS);
      listedAfter = (listOut as { schedules: any[] }).schedules;

      // Keep this case about registration; the real alarm is exercised below.
      await tools.cancel_schedule.execute({ id: scheduleResult.id }, TOOL_EXEC_OPTS);
    });

    expect(scheduleResult).toMatchObject({ kind: "one_shot" });
    expect(scheduleResult.id).toMatch(/.+/);
    expect(scheduleResult.fire_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Schedule was visible to list_schedules between schedule + cancel
    const inList = listedAfter.find((s) => s.id === scheduleResult.id);
    expect(inList, "scheduled wakeup must appear in list_schedules").toBeDefined();
    expect(inList.kind).toBe("one_shot");
    expect(inList.prompt).toBe("wake up: ping the user");
    expect(inList.fire_at).toBe(scheduleResult.fire_at);

    // span.wakeup_scheduled trajectory event broadcast at schedule time
    const events = await getEvents(stub);
    const span = events.find((e) => e.type === "span.wakeup_scheduled");
    expect(span, "span.wakeup_scheduled should be in event log").toBeDefined();
    expect(span.data.schedule_id).toBe(scheduleResult.id);
    expect(span.data.kind).toBe("one_shot");
  }, 15000);

  it("onScheduledWakeup writes user.message with metadata.harness=schedule", async () => {
    // Direct test of the agents-framework alarm-dispatch entrypoint. The
    // framework calls this method by name when the alarm fires (we already
    // proved registration in the test above). Here we invoke it directly so
    // we can verify the synthesized event without standing up a full
    // harness/sandbox/agent_snapshot.
    //
    // The canonical Session has a deterministic harness; wakeup admission and
    // its subsequent drain run normally rather than pinning a fake status.
    const { stub } = await createScheduleSession("dispatch");

    const scheduledAt = new Date(Date.now() - 1000).toISOString();
    await runInDurableObject(stub, async (instance) => {
      await instance.onScheduledWakeup({
        prompt: "wake up: ping the user",
        scheduled_at: scheduledAt,
        kind: "one_shot",
      });
    });

    const events = await getEvents(stub);
    const wakeup = events.find(
      (e) =>
        e.type === "user.message" &&
        e.data?.metadata?.harness === "schedule" &&
        e.data?.metadata?.kind === "wakeup",
    );

    expect(
      wakeup,
      `wakeup user.message not found.\nevents seen: ${JSON.stringify(events.map((e) => e.type))}`,
    ).toBeDefined();
    expect(wakeup.data.content[0].text).toBe("wake up: ping the user");
    expect(wakeup.data.metadata.wakeup_kind).toBe("one_shot");
    expect(wakeup.data.metadata.scheduled_at).toBe(scheduledAt);
    expect(typeof wakeup.data.metadata.fired_at).toBe("string");
  }, 10000);

  it("onScheduledWakeup is a no-op on terminated sessions (no resurrection)", async () => {
    const { stub } = await createScheduleSession("terminated");

    let userMsgCount: number;
    await runInDurableObject(stub, async (instance) => {
      instance.setState({ ...instance.state, status: "terminated" });
      await instance.onScheduledWakeup({
        prompt: "should not be appended",
        scheduled_at: new Date().toISOString(),
        kind: "cron",
      });
      const events = (instance as { ctx: { storage: { sql: { exec: Function } } } }).ctx.storage.sql.exec(
        "SELECT COUNT(*) as c FROM events WHERE type = 'user.message'",
      );
      for (const row of events) userMsgCount = row.c as number;
    });

    expect(userMsgCount).toBe(0);
  }, 10000);

  it("cron: registered, listed, cancelled (no wait for fire)", async () => {
    const { stub } = await createScheduleSession("cron");

    let cronResult: any;
    let listed: any[];
    let cancelResult: any;
    let listedAfterCancel: any[];

    await runInDurableObject(stub, async (instance) => {
      const sandbox = new TestSandbox();
      const tools = await buildTools(AGENT_CFG, sandbox, {
        scheduleWakeup: (a) => instance.scheduleWakeup(a),
        cancelWakeup: (id) => instance.cancelWakeup(id),
        listWakeups: () => instance.listWakeups(),
      });

      cronResult = await tools.schedule.execute(
        { cron: "0 9 * * *", prompt: "morning standup" },
        TOOL_EXEC_OPTS,
      );

      const listOut = await tools.list_schedules.execute({}, TOOL_EXEC_OPTS);
      listed = (listOut as { schedules: any[] }).schedules;

      cancelResult = await tools.cancel_schedule.execute({ id: cronResult.id }, TOOL_EXEC_OPTS);

      const listOut2 = await tools.list_schedules.execute({}, TOOL_EXEC_OPTS);
      listedAfterCancel = (listOut2 as { schedules: any[] }).schedules;
    });

    expect(cronResult).toMatchObject({ kind: "cron", cron: "0 9 * * *" });
    expect(cronResult.id).toMatch(/.+/);

    const cronInList = listed.find((s) => s.id === cronResult.id);
    expect(cronInList, "cron schedule should appear in list_schedules").toBeDefined();
    expect(cronInList.cron).toBe("0 9 * * *");
    expect(cronInList.kind).toBe("cron");
    expect(cronInList.prompt).toBe("morning standup");

    expect(cancelResult).toEqual({ cancelled: true });

    expect(
      listedAfterCancel.find((s) => s.id === cronResult.id),
      "cron schedule should be gone after cancel",
    ).toBeUndefined();
  }, 15000);

  it("cancel_schedule refuses non-existent id", async () => {
    const { stub } = await createScheduleSession("guard");

    let result: any;
    await runInDurableObject(stub, async (instance) => {
      const sandbox = new TestSandbox();
      const tools = await buildTools(AGENT_CFG, sandbox, {
        scheduleWakeup: (a) => instance.scheduleWakeup(a),
        cancelWakeup: (id) => instance.cancelWakeup(id),
        listWakeups: () => instance.listWakeups(),
      });

      result = await tools.cancel_schedule.execute({ id: "sched_does_not_exist" }, TOOL_EXEC_OPTS);
    });

    expect(result).toEqual({ cancelled: false });
  }, 10000);

  it("at: ISO timestamp registers a one_shot schedule", async () => {
    const { stub } = await createScheduleSession("at");

    const fireAt = new Date(Date.now() + 30_000).toISOString();
    let result: any;
    let listed: any[];

    await runInDurableObject(stub, async (instance) => {
      const sandbox = new TestSandbox();
      const tools = await buildTools(AGENT_CFG, sandbox, {
        scheduleWakeup: (a) => instance.scheduleWakeup(a),
        cancelWakeup: (id) => instance.cancelWakeup(id),
        listWakeups: () => instance.listWakeups(),
      });

      result = await tools.schedule.execute({ at: fireAt, prompt: "later" }, TOOL_EXEC_OPTS);

      const listOut = await tools.list_schedules.execute({}, TOOL_EXEC_OPTS);
      listed = (listOut as { schedules: any[] }).schedules;

      // Cleanup so the alarm doesn't fire after the test
      await tools.cancel_schedule.execute({ id: result.id }, TOOL_EXEC_OPTS);
    });

    expect(result).toMatchObject({ kind: "one_shot" });
    expect(typeof result.fire_at).toBe("string");
    expect(listed.find((s) => s.id === result.id)).toBeDefined();
    expect(listed.find((s) => s.id === result.id).prompt).toBe("later");
  }, 10000);

  it("REAL alarm fire: framework dispatches onScheduledWakeup → user.message lands", async () => {
    // Closes the loop on the only piece our other tests didn't directly
    // observe: that the agents framework's alarm system actually invokes
    // `onScheduledWakeup` by name when the timer expires (vs us calling it
    // synchronously in the dispatch test above).
    //
    // A real, deterministic harness handles the wakeup after admission.
    const { stub } = await createScheduleSession("alarmfire");

    let scheduleResult: any;
    await runInDurableObject(stub, async (instance) => {
      const sandbox = new TestSandbox();
      const tools = await buildTools(AGENT_CFG, sandbox, {
        scheduleWakeup: (a) => instance.scheduleWakeup(a),
        cancelWakeup: (id) => instance.cancelWakeup(id),
        listWakeups: () => instance.listWakeups(),
      });

      scheduleResult = await tools.schedule.execute(
        { delay_seconds: 5, prompt: "ALARM_FIRED_PROOF_PAYLOAD" },
        TOOL_EXEC_OPTS,
      );
    });

    expect(scheduleResult.id).toMatch(/.+/);

    // Wait for the framework alarm to actually fire. The agents-fw clamps
    // delays — its internal poll loop runs ~1s after fire time. Give a
    // generous ceiling.
    await new Promise((r) => setTimeout(r, 12_000));

    const events = await getEvents(stub);
    const wakeup = events.find(
      (e) =>
        e.type === "user.message" &&
        e.data?.metadata?.harness === "schedule" &&
        e.data?.content?.[0]?.text === "ALARM_FIRED_PROOF_PAYLOAD",
    );

    expect(
      wakeup,
      `framework should have invoked onScheduledWakeup; events:\n${JSON.stringify(
        events.map((e) => ({ type: e.type, h: e.data?.metadata?.harness })),
        null,
        2,
      )}`,
    ).toBeDefined();
    expect(wakeup.data.metadata.kind).toBe("wakeup");
    expect(wakeup.data.metadata.wakeup_kind).toBe("one_shot");
  }, 25_000);

  it("pending wakeup cap: scheduling beyond 20 throws; cancelling frees a slot", async () => {
    // Failsafe vs runaway cron loops. Without the cap, an agent can pile up
    // unbounded schedules and burn token quota on each fire. See
    // session-do.ts:MAX_PENDING_WAKEUPS (20).
    const { stub } = await createScheduleSession("cap");

    let firstId: string;
    let lastIdAtCap: string;
    let capError: unknown;
    let postCancelOk: { id: string };

    await runInDurableObject(stub, async (instance) => {
      // Use far-future absolute timestamps so nothing fires during the test.
      const baseTs = Date.now() + 6 * 60 * 60 * 1000; // +6h
      // Schedule exactly the cap (20)
      let firstResult: any = null;
      let lastResult: any = null;
      for (let i = 0; i < 20; i++) {
        const r = await instance.scheduleWakeup({
          at: new Date(baseTs + i * 60_000).toISOString(),
          prompt: `slot ${i}`,
        });
        if (i === 0) firstResult = r;
        if (i === 19) lastResult = r;
      }
      firstId = firstResult.id;
      lastIdAtCap = lastResult.id;

      // 21st should throw
      try {
        await instance.scheduleWakeup({
          at: new Date(baseTs + 60 * 60_000).toISOString(),
          prompt: "over the cap",
        });
        capError = new Error("expected throw, got success");
      } catch (e) {
        capError = e;
      }

      // Free a slot, then a fresh schedule should succeed
      await instance.cancelWakeup(firstId);
      postCancelOk = await instance.scheduleWakeup({
        at: new Date(baseTs + 61 * 60_000).toISOString(),
        prompt: "after cancel",
      });

      // Cleanup so we don't leave 20 future alarms hanging
      const remaining = instance.listWakeups();
      for (const s of remaining) {
        await instance.cancelWakeup(s.id);
      }
    });

    expect(capError).toBeInstanceOf(Error);
    expect((capError as Error).message).toMatch(/pending wakeup cap reached/);
    expect((capError as Error).message).toMatch(/20\/20/);
    expect(postCancelOk.id).toMatch(/.+/);
  }, 30_000);
});
