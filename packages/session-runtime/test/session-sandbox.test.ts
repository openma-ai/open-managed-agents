import { describe, expect, it, vi } from "vitest";
import { SessionSandboxRuntime } from "../src/session-sandbox";
import type { SandboxPort } from "@open-managed-agents/sandbox";

const sandbox = (): SandboxPort => ({ exec: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() });

describe("shared session sandbox lifecycle", () => {
  it("runs none mode without invoking provider allocation, preparation or workspace operations", async () => {
    const create = vi.fn(() => sandbox()), prepare = vi.fn(), reconcile = vi.fn();
    const runtime = new SessionSandboxRuntime({ mode: () => "none", create, prepare });
    const selected = await runtime.acquire();
    await runtime.prepare();
    await runtime.withSandbox(reconcile);
    expect(create).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    await expect(selected.exec("true")).rejects.toThrow("No execution environment");
  });

  it("deduplicates concurrent selection and preparation", async () => {
    const physical = sandbox();
    const mode = vi.fn(async () => "sandbox" as const), create = vi.fn(() => physical), prepare = vi.fn();
    const runtime = new SessionSandboxRuntime({ mode, create, prepare });
    await Promise.all([runtime.prepare(), runtime.prepare(), runtime.acquire()]);
    expect(mode).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(physical);
    const reconcile = vi.fn();
    await runtime.withSandbox(reconcile);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(physical);
  });

  it("retries failed resolution without allocating on failure", async () => {
    const mode = vi.fn().mockRejectedValueOnce(new Error("control plane unavailable")).mockResolvedValue("none");
    const create = vi.fn(() => sandbox());
    const runtime = new SessionSandboxRuntime({ mode, create });
    await expect(runtime.prepare()).rejects.toThrow("control plane unavailable");
    await runtime.prepare();
    expect(create).not.toHaveBeenCalled();
  });

  it("retries preparation and re-prepares recycled provider workspaces without duplicate allocation", async () => {
    const create = vi.fn(() => sandbox());
    const prepare = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValue(undefined);
    const runtime = new SessionSandboxRuntime({ mode: () => "sandbox", create, prepare });
    await expect(runtime.prepare()).rejects.toThrow("temporarily unavailable");
    await runtime.prepare();
    runtime.invalidatePreparation();
    await runtime.prepare();
    expect(create).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(3);
  });
});
