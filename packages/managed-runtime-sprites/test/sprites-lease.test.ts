import { describe, expect, it, vi } from "vitest";
import { sandboxFactory } from "../src/sprites";
import { SpritesClient, spritesFixtureCalls } from "./fixtures/sprites-sdk";

describe("Sprite handle-based keep-alive", () => {
  it("uses the exact running Sprite without readiness, network configuration or allocation", async () => {
    const api = new SpritesClient("test");
    const sprite = await api.createSprite("existing");
    const exec = vi.spyOn(sprite, "execFileHTTP");
    const network = vi.spyOn(sprite, "updateNetworkPolicy");
    const before = spritesFixtureCalls.filter(call => call.type === "create").length;
    const handle = { provider: "sprites", runtimeId: "existing" };
    const input = { ttlMs: 60000, signal: new AbortController().signal };
    await sandboxFactory.runtimeBinding!.renewLease!(handle, input, { SPRITES_TOKEN: "test" });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]![1]!.join(" ")).toContain("/v1/tasks/openma-runtime");
    expect(network).not.toHaveBeenCalled();
    expect(spritesFixtureCalls.filter(call => call.type === "create")).toHaveLength(before);
    vi.spyOn(sprite, "check").mockResolvedValue({ status: "cold" });
    await expect(sandboxFactory.runtimeBinding!.renewLease!(handle, input, { SPRITES_TOKEN: "test" })).rejects.toThrow("not running");
    expect(exec).toHaveBeenCalledOnce();
    await api.deleteSprite("existing");
    await expect(sandboxFactory.runtimeBinding!.renewLease!(handle, input, { SPRITES_TOKEN: "test" })).rejects.toThrow("not found");
    expect(spritesFixtureCalls.filter(call => call.type === "create")).toHaveLength(before);
  });
});
