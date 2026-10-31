import { describe, expect, it, vi } from "vitest";
import { applyCapCliPlaceholderEnvironment } from "../../apps/agent/src/runtime/cap-placeholder-env";

function sandbox() {
  return { setEnvVars: vi.fn(async () => {}) };
}

describe("applyCapCliPlaceholderEnvironment", () => {
  it("sets the managed placeholders and skips the legacy path for a managed session", async () => {
    const box = sandbox();
    const legacy = vi.fn(async () => {});
    const result = await applyCapCliPlaceholderEnvironment({
      source: { resolveManagedCapCliEnvironment: async () => ({ type: "found", env: { GITHUB_TOKEN: "__cap_managed__" } }) },
      tenantId: "ws",
      sessionId: "sess",
      sandbox: box,
      legacy,
    });
    expect(result).toBe("managed");
    expect(box.setEnvVars).toHaveBeenCalledWith({ GITHUB_TOKEN: "__cap_managed__" });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("propagates a main-worker failure for managed placeholders (fails warmup)", async () => {
    const legacy = vi.fn(async () => {});
    await expect(applyCapCliPlaceholderEnvironment({
      source: { resolveManagedCapCliEnvironment: async () => { throw new Error("managed store down"); } },
      tenantId: "ws",
      sessionId: "sess",
      sandbox: sandbox(),
      legacy,
    })).rejects.toThrow("managed store down");
    expect(legacy).not.toHaveBeenCalled();
  });

  it("runs only the legacy path for a session the main worker does not know as managed", async () => {
    const box = sandbox();
    const legacy = vi.fn(async () => {});
    expect(await applyCapCliPlaceholderEnvironment({
      source: { resolveManagedCapCliEnvironment: async () => ({ type: "not_found" }) },
      tenantId: "ws",
      sessionId: "sess",
      sandbox: box,
      legacy,
    })).toBe("legacy");
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(box.setEnvVars).not.toHaveBeenCalled();
  });

  it("refuses a managed session's placeholders on a sandbox that cannot set env", async () => {
    await expect(applyCapCliPlaceholderEnvironment({
      source: { resolveManagedCapCliEnvironment: async () => ({ type: "found", env: { GITHUB_TOKEN: "__cap_managed__" } }) },
      tenantId: "ws",
      sessionId: "sess",
      sandbox: {},
      legacy: async () => {},
    })).rejects.toThrow("cannot set the CLI placeholder environment");
  });
});
