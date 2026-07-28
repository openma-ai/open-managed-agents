import { describe, expect, it } from "vitest";
import { formatDuration, formatRelative, pickTickStep, shortenId } from "./format";

describe("formatDuration", () => {
  it("returns em-dash for non-finite or negative input", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
  it("clamps sub-millisecond values", () => {
    expect(formatDuration(0.4)).toBe("<1ms");
  });
  it("rounds milliseconds", () => {
    expect(formatDuration(123.6)).toBe("124ms");
  });
  it("renders seconds with two decimals", () => {
    expect(formatDuration(1_234)).toBe("1.23s");
  });
  it("renders minutes + seconds", () => {
    expect(formatDuration(2 * 60_000 + 17_000)).toBe("2m17s");
  });
});

describe("formatRelative", () => {
  it("handles negative diffs by taking magnitude", () => {
    expect(formatRelative(-15_000)).toBe("15s ago");
  });
  it("crosses minute / hour / day / month / year boundaries", () => {
    expect(formatRelative(59_000)).toBe("59s ago");
    expect(formatRelative(5 * 60_000)).toBe("5m ago");
    expect(formatRelative(3 * 3_600_000)).toBe("3h ago");
    expect(formatRelative(2 * 86_400_000)).toBe("2d ago");
    expect(formatRelative(45 * 86_400_000)).toBe("1mo ago");
    expect(formatRelative(400 * 86_400_000)).toBe("1y ago");
  });
});

describe("shortenId", () => {
  it("returns em-dash when id is missing", () => {
    expect(shortenId(undefined)).toBe("—");
  });
  it("passes through short ids unchanged", () => {
    expect(shortenId("abc")).toBe("abc");
  });
  it("truncates long ids with prefix + ellipsis + suffix", () => {
    expect(shortenId("agt_01ABCDEFGHIJKLMXYZ")).toBe("agt_01AB…XYZ");
  });
});

describe("pickTickStep", () => {
  it("picks the smallest candidate above the target", () => {
    // target = totalMs / 6; first candidate >= target wins
    expect(pickTickStep(600)).toBe(100); // target 100 → 100
    expect(pickTickStep(601)).toBe(250); // target ~100.17 → 250
    expect(pickTickStep(60_000)).toBe(10_000); // target 10_000 → 10_000
  });
  it("falls back to the largest candidate when nothing fits", () => {
    expect(pickTickStep(Number.MAX_SAFE_INTEGER)).toBe(600_000);
  });
});
