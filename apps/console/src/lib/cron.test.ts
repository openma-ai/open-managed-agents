import { describe, expect, it } from "vitest";

import {
  buildCronExpression,
  formatClockTime,
  isValidTimeZone,
  nextCronRuns,
  parseClockTime,
  parseCron,
  presetFromCron,
  timeZoneLabel,
  type SchedulePreset,
} from "./cron";

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

describe("parseCron", () => {
  it("expands lists, ranges, steps and names", () => {
    const parsed = parseCron("*/15 9-11 1,15 JAN-MAR mon-fri");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...parsed.cron.hours]).toEqual([9, 10, 11]);
    expect([...parsed.cron.daysOfMonth]).toEqual([1, 15]);
    expect([...parsed.cron.months]).toEqual([1, 2, 3]);
    expect([...parsed.cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats 7 as Sunday and supports start/step", () => {
    const parsed = parseCron("5/20 0 * * 7");
    expect(parsed.ok && [...parsed.cron.minutes]).toEqual([5, 25, 45]);
    expect(parsed.ok && [...parsed.cron.daysOfWeek]).toEqual([0]);
  });

  it.each([
    ["", "Expected 5 fields"],
    ["* * * *", "Expected 5 fields"],
    ["60 * * * *", "Invalid minute"],
    ["* 24 * * *", "Invalid hour"],
    ["* * 0 * *", "Invalid day of month"],
    ["* * * 13 *", "Invalid month"],
    ["* * * * 8", "Invalid day of week"],
    ["*/0 * * * *", "Invalid minute step"],
    ["5-1 * * * *", "Invalid minute range"],
    ["a * * * *", "Invalid minute"],
  ])("rejects %j", (expression, error) => {
    const parsed = parseCron(expression);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(error);
  });
});

describe("presets", () => {
  const presets: [SchedulePreset, string][] = [
    [{ frequency: "every_minute", hour: 0, minute: 0, weekday: 1 }, "* * * * *"],
    [{ frequency: "hourly", hour: 0, minute: 30, weekday: 1 }, "30 * * * *"],
    [{ frequency: "daily", hour: 18, minute: 5, weekday: 1 }, "5 18 * * *"],
    [{ frequency: "weekdays", hour: 9, minute: 0, weekday: 1 }, "0 9 * * 1-5"],
    [{ frequency: "weekly", hour: 7, minute: 45, weekday: 0 }, "45 7 * * 0"],
  ];

  it.each(presets)("builds and recognises %j", (preset, expression) => {
    expect(buildCronExpression(preset)).toBe(expression);
    expect(presetFromCron(expression)).toEqual(preset);
  });

  it("leaves expressions without a preset to the custom editor", () => {
    expect(presetFromCron("0 9 1 * *")).toBeNull();
    expect(presetFromCron("*/5 * * * *")).toBeNull();
    expect(presetFromCron("0 9 * * 1,3")).toBeNull();
    expect(presetFromCron("not cron")).toBeNull();
  });
});

describe("nextCronRuns", () => {
  it("lists weekday runs in the schedule's time zone", () => {
    // Tue 2026-11-03 08:00 in Chicago (CST, UTC-6).
    const after = new Date("2026-11-03T14:00:00Z");
    expect(iso(nextCronRuns("0 9 * * 1-5", "America/Chicago", 5, after))).toEqual([
      "2026-11-03T15:00:00.000Z",
      "2026-11-04T15:00:00.000Z",
      "2026-11-05T15:00:00.000Z",
      "2026-11-06T15:00:00.000Z",
      "2026-11-09T15:00:00.000Z",
    ]);
  });

  it("is strictly after the start instant", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    expect(iso(nextCronRuns("0 0 * * *", "UTC", 2, after))).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
    expect(iso(nextCronRuns("* * * * *", "UTC", 2, new Date("2026-01-01T00:00:30Z")))).toEqual([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:02:00.000Z",
    ]);
  });

  it("follows DST: the UTC instant moves while the wall clock stays", () => {
    // US DST ends Sun 2026-11-01.
    const after = new Date("2026-10-30T00:00:00Z");
    expect(iso(nextCronRuns("0 9 * * *", "America/New_York", 4, after))).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  it("skips wall-clock times that a DST jump removes", () => {
    // 02:30 does not exist in New York on 2026-03-08.
    const after = new Date("2026-03-07T12:00:00Z");
    expect(iso(nextCronRuns("30 2 * * *", "America/New_York", 2, after))).toEqual([
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("matches either restricted day field, like cron", () => {
    // The 1st of the month OR any Friday.
    const after = new Date("2026-05-27T00:00:00Z");
    expect(iso(nextCronRuns("0 0 1 * 5", "UTC", 3, after))).toEqual([
      "2026-05-29T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      "2026-06-05T00:00:00.000Z",
    ]);
  });

  it("finds rare dates such as Feb 29", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    expect(iso(nextCronRuns("0 12 29 2 *", "UTC", 1, after))).toEqual([
      "2028-02-29T12:00:00.000Z",
    ]);
  });

  it("returns nothing for invalid input", () => {
    expect(nextCronRuns("bad", "UTC", 5)).toEqual([]);
    expect(nextCronRuns("* * * * *", "Not/AZone", 5)).toEqual([]);
    expect(nextCronRuns("0 0 31 2 *", "UTC", 1)).toEqual([]);
  });
});

describe("clock and zone helpers", () => {
  it("parses and formats 12-hour times", () => {
    expect(parseClockTime("9:00", "AM")).toEqual({ hour: 9, minute: 0 });
    expect(parseClockTime("12:15", "AM")).toEqual({ hour: 0, minute: 15 });
    expect(parseClockTime("12:00", "PM")).toEqual({ hour: 12, minute: 0 });
    expect(parseClockTime("9:05", "PM")).toEqual({ hour: 21, minute: 5 });
    expect(parseClockTime("13:00", "PM")).toBeNull();
    expect(parseClockTime("9:60", "AM")).toBeNull();
    expect(parseClockTime("9", "AM")).toBeNull();
    expect(formatClockTime(0, 15)).toEqual({ text: "12:15", meridiem: "AM" });
    expect(formatClockTime(21, 5)).toEqual({ text: "9:05", meridiem: "PM" });
  });

  it("labels zones with their current offset", () => {
    expect(timeZoneLabel("America/Chicago", new Date("2026-11-03T12:00:00Z"))).toBe(
      "(GMT-06:00) America/Chicago",
    );
    expect(timeZoneLabel("Asia/Kolkata", new Date("2026-11-03T12:00:00Z"))).toBe(
      "(GMT+05:30) Asia/Kolkata",
    );
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
