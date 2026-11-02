import { describe, expect, it } from "vitest";
import { userDisplayLabel } from "./CliLogin";

describe("userDisplayLabel", () => {
  it("prefers name, then email, then id, treating blank strings as missing", () => {
    expect(userDisplayLabel({ id: "u1", email: "a@b.c", name: "Ada" })).toBe("Ada");
    expect(userDisplayLabel({ id: "u1", email: "a@b.c", name: "" })).toBe("a@b.c");
    expect(userDisplayLabel({ id: "u1", email: "  ", name: null })).toBe("u1");
    expect(userDisplayLabel({ id: "", email: "", name: "" })).toBe("this user");
    expect(userDisplayLabel(null)).toBe("this user");
  });
});
