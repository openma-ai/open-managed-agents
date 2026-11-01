import { describe, expect, it } from "vitest";
import { createMonotonicClock } from "@open-managed-agents/shared";

describe("createMonotonicClock", () => {
  it("strictly increases within the same wall-clock ms (interrupt → idle ordering)", () => {
    const clock = createMonotonicClock(() => 1000);
    const interruptAt = clock.nowIso();
    const idleAt = clock.nowIso();
    expect(idleAt > interruptAt).toBe(true);
    expect(Date.parse(idleAt) - Date.parse(interruptAt)).toBe(1);
  });
  it("never goes backwards when the wall clock regresses", () => {
    let t = 5000;
    const clock = createMonotonicClock(() => t);
    const a = clock.nowMs();
    t = 4000;
    expect(clock.nowMs()).toBe(a + 1);
    t = 9000;
    expect(clock.nowMs()).toBe(9000);
  });
});

import { sessionMonotonicClock } from "@open-managed-agents/shared";
describe("sessionMonotonicClock", () => {
  it("returns the same clock per session so separate event-log instances stay ordered", () => {
    const a = sessionMonotonicClock("sess_mono").nowMs();
    const b = sessionMonotonicClock("sess_mono").nowMs();
    expect(b).toBeGreaterThan(a);
  });
});
