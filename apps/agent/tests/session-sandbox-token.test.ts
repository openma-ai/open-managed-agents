import {expect, it} from "vitest";
import {acpSandboxExecutionEnv} from "../src/runtime/session-sandbox-token";

it("channel failure reaches the caller with no agent-side PUBLIC_BASE_URL prerequisite", async () => {
  const failure = new Error("channel authority refused");
  const env = { MAIN_MCP: {
    issueSandboxToken: async () => "token",
    managedAcpExecutionChannels: async () => { throw failure; },
  }};
  await expect(acpSandboxExecutionEnv(env as never, {
    workspaceId: "ws", sessionId: "channel-failure", executionId: "e", attemptId: "a", ownerId: "o", generation: 1,
  }, "acp-sandbox")).rejects.toBe(failure);
});
