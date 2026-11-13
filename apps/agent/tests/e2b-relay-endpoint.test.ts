import { describe, expect, it, vi } from "vitest";
import { createE2BSessionSandbox } from "../src/runtime/e2b-session-sandbox";

const observed = vi.hoisted(() => ({ creates: 0, commands: [] as string[], envs: [] as unknown[], tokens: 0 }));
vi.mock("e2b", () => ({ Sandbox: { create: async () => {
  observed.creates++;
  // A trusted-template create returns only after the launcher wrote its ready marker.
  return { sandboxId: "box-1", commands: { run: async (cmd: string, opts: unknown) => { observed.commands.push(cmd); observed.envs.push(opts); return { exitCode: 0, stdout: "ok", stderr: "" }; } }, files: { read: async (path: string) => path === "/run/oma-managed/ready" ? "oma-managed-v2" : "", write: async () => {} }, updateNetwork: async () => {}, kill: async () => {} };
} } }));

const scope = { workspaceId: "ws", sessionId: "sess", environmentId: "env", workId: "exe" };
function sandbox(substitutions: boolean, url?: string) {
  const state = new Map<string, unknown>();
  return createE2BSessionSandbox({
    env: { E2B_API_KEY: "unused", E2B_TEMPLATE: "template", E2B_MAX_LIFETIME_MS: "3600000", MEMORY_BUCKET: {} as never, FILES_BUCKET: {} as never,
      ...(url === undefined ? {} : { PUBLIC_BASE_URL: url }),
      MAIN_MCP: { resolveManagedCapCliEnvironment: async () => ({ type: "found", env: substitutions ? { TOKEN: "oma_vault_placeholder" } : {} }) },
    },
    storage: { kv: { get: (key: string) => state.get(key), put: (key: string, value: unknown) => { state.set(key, value); } } } as never,
    scope: () => scope, networking: async () => undefined,
    fence: () => ({ executionId: "exe", attemptId: "att", ownerId: "owner", generation: 1 }),
    relayToken: async () => { observed.tokens++; return "oma_sbx_test"; },
  });
}
describe("CF E2B relay endpoint admission", () => {
  for (const url of [undefined, "", "not-a-url", "http://control.example", "https://egress-unconfigured.invalid"]) {
    it("rejects substitutions before sandbox/relay side effects with endpoint " + String(url), async () => {
      observed.creates = 0; observed.commands = []; observed.envs = [];
      await expect(sandbox(true, url).exec("true")).rejects.toThrow(/PUBLIC_BASE_URL/);
      expect(observed.creates).toBe(0);
      expect(observed.commands).toEqual([]);
      expect(observed.envs).toEqual([]);
    });
  }
  it("without Vault binds a token and executes without a relay URL", async () => {
    observed.tokens = 0;
    observed.creates = 0; observed.commands = []; observed.envs = [];
    await expect(sandbox(false).exec("true")).resolves.toContain("ok");
    expect(observed.creates).toBe(1);
    expect(observed.tokens).toBe(1);
    expect(observed.commands.some(cmd => cmd.includes("EGRESS_DELIVERED"))).toBe(false);
    expect(observed.commands.some(cmd => cmd.includes("/opt/oma-managed/launcher.py"))).toBe(false);
  });
});
