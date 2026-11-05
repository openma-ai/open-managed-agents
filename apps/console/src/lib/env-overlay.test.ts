import { describe, expect, it } from "vitest";
import { formatEnvOverlay, parseEnvOverlay, runtimeAttachmentPatch } from "./env-overlay";

describe("env overlay text", () => {
  it("parses KEY=value lines, skipping blanks and comments", () => {
    expect(parseEnvOverlay("# shared\nNODE_ENV=development\n\n  DATABASE_URL = postgres://h/db?a=b \n")).toEqual({
      env: { NODE_ENV: "development", DATABASE_URL: "postgres://h/db?a=b" },
      errors: [],
    });
    expect(parseEnvOverlay("EMPTY=")).toEqual({ env: { EMPTY: "" }, errors: [] });
  });

  it("reports malformed, invalid and duplicate lines by line number", () => {
    const { errors } = parseEnvOverlay("JUST_A_NAME\n1BAD=x\nA=1\nA=2\nBAD-NAME=y");
    expect(errors).toEqual([
      "Line 1: expected KEY=value",
      'Line 2: invalid variable name "1BAD"',
      "Line 4: duplicate variable A",
      'Line 5: invalid variable name "BAD-NAME"',
    ]);
  });

  it("builds a minimal _oma.runtime patch", () => {
    const stored = { runtime_id: "rt_1", env: { A: "1" } };
    expect(runtimeAttachmentPatch(undefined, "", {})).toBeUndefined();
    expect(runtimeAttachmentPatch(stored, "rt_1", { A: "1" })).toBeUndefined();
    expect(runtimeAttachmentPatch(stored, "", {})).toBeNull();
    expect(runtimeAttachmentPatch(stored, "rt_1", { A: "1" }, "sandbox"))
      .toEqual({ runtime_id: "rt_1", placement: "sandbox", env: { A: "1" } });
    expect(runtimeAttachmentPatch({ ...stored, placement: "sandbox" }, "rt_1", { A: "1" }, "sandbox")).toBeUndefined();
    expect(runtimeAttachmentPatch(stored, "rt_2", { A: "1" })).toEqual({ placement: "host", runtime_id: "rt_2", env: { A: "1" } });
    expect(runtimeAttachmentPatch(stored, "rt_1", {})).toEqual({ placement: "host", runtime_id: "rt_1", env: {} });
    expect(runtimeAttachmentPatch(undefined, "rt_1", {})).toEqual({ placement: "host", runtime_id: "rt_1", env: {} });
  });

  it("round-trips through formatEnvOverlay", () => {
    const env = { A: "1", B: "x=y" };
    expect(parseEnvOverlay(formatEnvOverlay(env)).env).toEqual(env);
    expect(formatEnvOverlay(undefined)).toBe("");
  });
});
