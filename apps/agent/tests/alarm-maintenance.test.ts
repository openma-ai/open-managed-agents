import { expect, it } from "vitest";
import { waitForAlarmMaintenance } from "../src/runtime/alarm-maintenance";
it("bounds only maintenance waiting while observing a late rejection", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  await expect(waitForAlarmMaintenance(pending, 20)).rejects.toThrow("Alarm maintenance");
  reject(new Error("late RPC failure"));
  await new Promise(resolve => setTimeout(resolve, 0));
});
it("preserves successful maintenance results", async () => {
  expect(await waitForAlarmMaintenance(Promise.resolve(42), 20)).toBe(42);
});
