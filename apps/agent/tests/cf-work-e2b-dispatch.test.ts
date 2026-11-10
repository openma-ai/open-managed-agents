import { expect, it } from "vitest";
import { createCfWorkRunnerDispatch } from "../src/runtime/cf-work-runner-dispatch";
import { attemptSandboxTokens, generateSandboxToken } from "@open-managed-agents/sandbox-gateway";

const delivery = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work", apiBaseUrl: "https://control.test", workSecret: "poll-secret" };
const inventory = '[{"id":"codex-acp","version":"1.8.0","command":"/opt/oma-harnesses/codex-acp/bin/codex-acp"}]';
function fixture(lostDuringLaunch = false, installedHarnesses = inventory) {
  let current = true; const launches: unknown[] = []; const killed: string[] = [];
  const token = generateSandboxToken();
  const runtime = {
    provider: "e2b" as const,
    runtimeHandle: () => ({ provider: "e2b", runtimeId: "physical" }),
    async startManagedProcess(spec: unknown, identity: unknown) {
      launches.push({ spec, identity }); if (lostDuringLaunch) current = false;
      return { created: true, id: "native", pid: 19, getStatus: async () => "running", kill: async (signal: string) => { killed.push(signal); } };
    },
  };
  const dispatcher = createCfWorkRunnerDispatch({
    command: "/not/the/e2b/command", installedHarnesses, tokens: attemptSandboxTokens(),
    authorize: async () => current ? { generation: 3, environment: { config: { type: "cloud" } }, session: { id: "sess", environmentId: "env", agent: { openma: { harness: "acp-sandbox" } } }, harness: { id: "codex-acp", version: "1.8.0" } } : null,
    issueToken: async () => token, sandbox: async () => runtime,
  });
  return { dispatcher, launches, killed, token };
}
it("E2B Work launches fixed native argv with exact claim identity and no CF outbound dependency", async () => {
  const f = fixture();
  await expect(f.dispatcher.dispatch({ ...delivery, signal: new AbortController().signal })).resolves.toEqual({ created: true });
  expect(f.launches).toEqual([{ spec: {
    command: "/usr/local/bin/node", args: ["/opt/oma-managed/worker/node-e2b-work-item-cli.js"], cwd: "/workspace",
    env: { ANTHROPIC_BASE_URL: "https://control.test", ANTHROPIC_ENVIRONMENT_ID: "env", ANTHROPIC_SESSION_ID: "sess", ANTHROPIC_WORK_ID: "work", ANTHROPIC_WORK_SECRET: "poll-secret", OPENMA_WORKSPACE_ID: "ws", OPENMA_HARNESS_ID: "codex-acp", OPENMA_HARNESS_VERSION: "1.8.0", OPENMA_SANDBOX_TOKEN: f.token, OPENMA_ACP_HARNESSES: inventory },
  }, identity: { workspaceId: "ws", sessionId: "sess", workId: "work", attemptId: "environment-work-claim:3" } }]);
});
it("E2B refuses a non-certified inventory before native launch", async () => {
  const f = fixture(false, '[{"id":"pi-acp","version":"1.0.0","command":"/opt/pi"}]');
  await expect(f.dispatcher.dispatch({ ...delivery, signal: new AbortController().signal })).rejects.toThrow(/inventory/);
  expect(f.launches).toEqual([]);
});
it("claim lost during native launch kills only its returned exact handle and never confirms dispatch", async () => {
  const f = fixture(true);
  await expect(f.dispatcher.dispatch({ ...delivery, signal: new AbortController().signal })).rejects.toThrow("authority was lost");
  expect(f.launches).toHaveLength(1); expect(f.killed).toEqual(["SIGKILL"]);
});
