import { describe, expect, it } from "vitest";
import { createSandboxIdleAlarm } from "../src/runtime/sandbox-idle-alarm";

function scheduler() {
  const rows: Array<{ id: string; callback: string; delaySeconds: number }> = [];
  let next = 0;
  return {
    rows,
    async schedule(delaySeconds: number, callback: string) { rows.push({ id: `s${++next}`, callback, delaySeconds }); },
    getSchedules: () => rows.map(({ id, callback }) => ({ id, callback })),
    async cancelSchedule(id: string) { const i = rows.findIndex((row) => row.id === id); if (i < 0) return false; rows.splice(i, 1); return true; },
  };
}

describe("createSandboxIdleAlarm", () => {
  it("keeps one schedule row for the callback, in whole seconds, and leaves other rows alone", async () => {
    const s = scheduler();
    await s.schedule(5, "recoverEventQueue");
    const alarm = createSandboxIdleAlarm(s, "pauseIdleSandbox");
    await alarm.schedule(300_000);
    await alarm.schedule(1_500);
    expect(s.rows).toEqual([{ id: "s1", callback: "recoverEventQueue", delaySeconds: 5 }, { id: "s3", callback: "pauseIdleSandbox", delaySeconds: 2 }]);
    await alarm.schedule(1);
    expect(s.rows.at(-1)).toMatchObject({ callback: "pauseIdleSandbox", delaySeconds: 1 });
    await alarm.cancel();
    expect(s.rows.map((row) => row.callback)).toEqual(["recoverEventQueue"]);
  });
});
