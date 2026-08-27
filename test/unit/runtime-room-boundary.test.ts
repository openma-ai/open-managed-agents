import { describe, expect, it } from "vitest";

const sources = import.meta.glob(
  "../../apps/main/src/runtime-room.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

describe("RuntimeRoom protocol boundary", () => {
  it("delegates session relay wire codecs to openma-common", () => {
    const source = Object.values(sources)[0] ?? "";
    expect(source).toContain("@openma/common/session-kernel");
    expect(source).toContain("decodeSessionHostEvent");
    expect(source).toContain("decodeSessionCommand");
    expect(source).toContain("encodeSessionCommand");
    expect(source).not.toContain('parsed.type.startsWith("session.")');
  });

  it("delegates relay authorization and persistence planning to runtime-relay", () => {
    const source = Object.values(sources)[0] ?? "";
    expect(source).toContain("@open-managed-agents/runtime-relay");
    expect(source).toContain("authorizeRuntimeHostEvent");
    expect(source).toContain("planRuntimeHostEventEffects");
    expect(source).toContain("selectRuntimeCommandTenant");
  });
});
