import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { acpSessionFixture } from "../../managed-agents-runtime/test/acp-fixtures";

const mocks = vi.hoisted(() => ({
  provider: vi.fn(), create: vi.fn(), resume: vi.fn(), acp: vi.fn(), materialize: vi.fn(), cwd: vi.fn(),
}));
vi.mock("@open-managed-agents/managed-runtime-boxlite", () => ({ createBoxLiteProvider: mocks.provider }));
vi.mock("@open-managed-agents/acp-runtime/placement", () => ({ createAcpRuntime: mocks.acp }));
vi.mock("node:child_process", () => ({ spawn: () => {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", 0));
  return child;
} }));
vi.mock("../src/bridge/lib/session-cwd.js", async (original) => ({
  ...await original<typeof import("../src/bridge/lib/session-cwd.js")>(),
  ensureSessionCwd: mocks.cwd, writeBundle: vi.fn(),
}));
vi.mock("../src/bridge/lib/claude-config-dir.js", () => ({ setupClaudeConfigDir: async () => "/host/claude-config" }));
vi.mock("../src/bridge/lib/managed-skills.js", async (original) => ({
  ...await original<typeof import("../src/bridge/lib/managed-skills.js")>(),
  materializeManagedSkills: mocks.materialize, configureManagedSkills: async () => ({}),
}));

import { RuntimeSandboxRegistry, runtimePlacement, runtimeSandboxEnvironment } from "../src/bridge/lib/runtime-placement";
import { createNodeSessionManagerRuntimeDependencies } from "../src/bridge/lib/node-session-runtime";
import { SessionManager } from "../src/bridge/lib/session-manager";

let dir: string;
let sandbox: ReturnType<typeof fakeSandbox>;
function fakeSandbox(runtimeId = "box-1") {
  return {
    runtimeHandle: () => ({ provider: "litebox", runtimeId }),
    runtimeCapabilities: () => ({ lease: true, suspend: [], checkpoint: [] }),
    status: vi.fn(async () => "running"), renewLease: vi.fn(), suspend: vi.fn(), resume: vi.fn(), checkpoint: vi.fn(),
    exec: vi.fn(async () => ""), writeFile: vi.fn(), writeFileBytes: vi.fn(), destroy: vi.fn(),
    spawnDuplexProcess: vi.fn(),
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), "oma-placement-"));
  sandbox = fakeSandbox();
  mocks.cwd.mockResolvedValue(dir);
  mocks.materialize.mockResolvedValue([]);
  mocks.provider.mockReturnValue({ create: mocks.create, resume: mocks.resume });
  mocks.create.mockResolvedValue(sandbox);
  mocks.resume.mockResolvedValue(sandbox);
  mocks.acp.mockImplementation(() => ({ start: async () => acpSessionFixture({ acpSessionId: "acp-1" }) }));
  vi.stubEnv("SANDBOX_PROVIDER", "litebox");
  vi.stubEnv("BOXRUN_URL", "");
  vi.stubEnv("SANDBOX_IMAGE", "node:22-bookworm");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function bundle(placement?: "host" | "sandbox", env = [{ name: "OVERLAY", value: "yes" }]) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    runtime: { runtime_id: "rt_1", ...(placement ? { placement } : {}) },
    files: [{ path: "AGENTS.md", content: "Use skills" }], managed_skills: [],
    env,
  })));
}
function input(cwd?: string) {
  return {
    command: { type: "session.start" as const, runtime: "local" as const, sessionId: "session-1", agentId: "claude-acp", ...(cwd === undefined ? {} : { cwd }) },
    scope: { id: "tenant-1", agentApiKey: "test-pat" },
    environment: { apiUrl: "https://oma.test", runtimeToken: "test-machine" },
  };
}

describe("Runtime sandbox placement (mocked LiteBox; live daemon evidence deferred)", () => {
  it.each(["host", "sandbox"] as const)("filters protected bundle env for %s placement and retains daemon routing and scrub", async (placement) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const blocked = ["PATH", "hOmE", "oMa_PROFILE", "CLAUDE_CONFIG_DIR", "claude_config_dir", "OPENMA_SKILLS_DIR",
      "CLAUDECODE", "claudecode", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];
    bundle(placement, [
      ...blocked.map((name) => ({ name, value: "overlay-secret" })),
      { name: "OVERLAY", value: "environment" }, { name: "OVERLAY", value: "session" },
    ]);
    const deps = createNodeSessionManagerRuntimeDependencies();
    const options = await deps.prepareSession(input());
    expect(options.agent.env).toEqual({
      OVERLAY: "session",
      CLAUDE_CONFIG_DIR: placement === "host" ? "/host/claude-config" : "/workspace/.claude-config",
      CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_CODE_SSE_PORT: undefined,
    });
    const warnings = stderr.mock.calls.filter(([line]) => String(line).includes("custom_env: blocked key skipped"));
    expect(warnings).toEqual(blocked.map((name) => [`  ! custom_env: blocked key skipped key="${name}"\n`]));
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("overlay-secret");
  });

  it.each([undefined, "host"] as const)("uses the local ACP runtime for placement %s", async (placement) => {
    bundle(placement);
    const deps = createNodeSessionManagerRuntimeDependencies();
    const options = await deps.prepareSession(input("/host/project"));
    await deps.acpRuntime.start(options);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.acp).toHaveBeenCalledWith(expect.objectContaining({ type: "local" }));
    expect(options.agent.cwd).toBe("/host/project");
    expect(options.agent.env?.OVERLAY).toBe("yes");
  });

  it("starts sandbox ACP through the actual SessionManager and reports jail bundle_dir", async () => {
    bundle("sandbox");
    const messages: unknown[] = [];
    const deps = createNodeSessionManagerRuntimeDependencies();
    const manager = new SessionManager(message => messages.push(message), deps);
    manager.setTenantKeys([{ id: "tenant-1", agentApiKey: "test-pat" }]);
    manager.setSpawnEnv(input().environment);
    await manager.start({ session_id: "session-1", agent_id: "claude-acp", tenant_id: "tenant-1" });
    expect(mocks.acp).toHaveBeenCalledWith({ type: "sandbox", sandbox });
    expect(mocks.provider).toHaveBeenCalledWith({ providerId: "litebox", image: "node:22-bookworm", connection: { type: "embedded" } });
    expect(mocks.create).toHaveBeenCalledWith({ sessionId: "session-1", workdir: "/workspace" }, {}, expect.objectContaining({
      scope: expect.objectContaining({ workspaceId: "tenant-1", sessionId: "session-1" }),
      environment: { type: "base", identity: "node:22-bookworm", artifact: { type: "image", reference: "node:22-bookworm" } },
      credentialEgress: null,
    }));
    expect(messages).toContainEqual(expect.objectContaining({ type: "session.ready", bundle_dir: "/workspace" }));
    expect(sandbox.writeFile).toHaveBeenCalledWith("/workspace/AGENTS.md", "Use skills");
    await manager.start({ session_id: "session-1", agent_id: "claude-acp", tenant_id: "tenant-1" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await manager.disposeAll();
  });

  it("rejects github local_path cwd before allocation and never falls back to host", async () => {
    bundle("sandbox");
    const deps = createNodeSessionManagerRuntimeDependencies();
    await expect(deps.prepareSession(input("/host/repository"))).rejects.toThrow("GitHub local_path");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.acp).not.toHaveBeenCalled();
    mocks.create.mockRejectedValueOnce(new Error("LiteBox unavailable"));
    await expect(deps.prepareSession(input())).rejects.toThrow("LiteBox unavailable");
    expect(mocks.acp).not.toHaveBeenCalled();
  });

  it("persists ownership and resumes the same LiteBox after daemon recreation", async () => {
    const first = new RuntimeSandboxRegistry();
    await first.acquire("session-1", "rt_1", dir, {}, "tenant-1");
    expect(JSON.parse(await readFile(join(dir, ".oma-runtime-sandbox.json"), "utf8"))).toEqual({
      sessionId: "session-1", runtimeId: "rt_1", handle: { provider: "litebox", runtimeId: "box-1" },
    });
    const next = new RuntimeSandboxRegistry();
    await expect(next.acquire("session-1", "rt_other", dir, {}, "tenant-1")).rejects.toThrow("ownership mismatch");
    await next.acquire("session-1", "rt_1", dir, {}, "tenant-1");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledWith({ provider: "litebox", runtimeId: "box-1" }, { sessionId: "session-1", workdir: "/workspace" }, {}, expect.anything());
    expect(next.owned.get("session-1")?.ownership.runtimeId).toBe("rt_1");
  });

  it("copies selected skill-cache bytes into jail paths and forwards ACP resume", async () => {
    const cachePath = join(dir, "cache", "skill_1");
    await mkdir(join(cachePath, "pkg"), { recursive: true });
    await writeFile(join(cachePath, "pkg", "SKILL.md"), "# Test skill");
    mocks.materialize.mockResolvedValue([{ skill_id: "skill_1", version: "v1", cachePath, linkPath: join(dir, "skills", "skill_1"), manifests: ["pkg/SKILL.md"] }]);
    bundle("sandbox");
    const deps = createNodeSessionManagerRuntimeDependencies();
    const preparation = input();
    const options = await deps.prepareSession({ ...preparation, command: { ...preparation.command, acpSessionId: "acp-resume" } });
    expect(options.resumeAcpSessionId).toBe("acp-resume");
    expect(options.agent.cwd).toBe("/workspace");
    expect(options.agent.env?.CLAUDE_CONFIG_DIR).toBe("/workspace/.claude-config");
    expect(sandbox.writeFileBytes).toHaveBeenCalledWith(expect.stringMatching(/^\/oma\/cache\/skills\/[a-f0-9]+\/pkg\/SKILL.md$/), Buffer.from("# Test skill"));
    expect(sandbox.writeFile).toHaveBeenCalledWith("/workspace/AGENTS.md", expect.stringContaining("/workspace/skills/skill_1/pkg/SKILL.md"));
    expect(JSON.stringify(sandbox.exec.mock.calls)).not.toContain(dir);
  });

  it("isolates sessions and serializes repeated acquisition without sharing handles", async () => {
    const secondDir = join(dir, "session-2");
    await mkdir(secondDir);
    const second = fakeSandbox("box-2");
    mocks.create.mockResolvedValueOnce(sandbox).mockResolvedValueOnce(second);
    const registry = new RuntimeSandboxRegistry();
    const [a, again] = await Promise.all([
      registry.acquire("session-1", "rt_1", dir, {}, "tenant-1"),
      registry.acquire("session-1", "rt_1", dir, {}, "tenant-1"),
    ]);
    const b = await registry.acquire("session-2", "rt_1", secondDir, {}, "tenant-1");
    expect(a).toBe(again);
    expect(b).not.toBe(a);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.provider).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls.map(([context]) => context.sessionId)).toEqual(["session-1", "session-2"]);
    expect(await readFile(join(secondDir, ".oma-runtime-sandbox.json"), "utf8")).not.toContain("session-1");
    await expect(new RuntimeSandboxRegistry().acquire("session-2", "rt_1", dir, {}, "tenant-1")).rejects.toThrow("ownership mismatch");
  });

  it("rejects incompatible retained handles and preserves missing boxes without recreating", async () => {
    const path = join(dir, ".oma-runtime-sandbox.json");
    await writeFile(path, JSON.stringify({ sessionId: "session-1", runtimeId: "rt_1", handle: { provider: "other", runtimeId: "box-1" } }));
    await expect(new RuntimeSandboxRegistry().acquire("session-1", "rt_1", dir, {}, "tenant-1")).rejects.toThrow("ownership mismatch");
    await writeFile(path, JSON.stringify({ sessionId: "session-1", runtimeId: "rt_1", handle: { provider: "litebox", runtimeId: "box-1" } }));
    mocks.resume.mockRejectedValueOnce(new Error("LiteBox runtime not found"));
    await expect(new RuntimeSandboxRegistry().acquire("session-1", "rt_1", dir, {}, "tenant-1")).rejects.toThrow("not found");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toContain("box-1");
  });

  it("fails closed on invalid placement, directories and REST/cloud providers", () => {
    expect(runtimePlacement()).toBe("host");
    expect(() => runtimePlacement({ runtime_id: "rt_1", placement: "invalid" as "host" })).toThrow("Invalid Runtime placement");
    expect(() => runtimePlacement({ runtime_id: "rt_1", placement: "sandbox", directories: [] })).toThrow("directories");
    expect(() => runtimeSandboxEnvironment({ SANDBOX_PROVIDER: "boxrun" })).toThrow("local embedded LiteBox");
    expect(() => runtimeSandboxEnvironment({ SANDBOX_PROVIDER: "e2b" })).toThrow("local embedded LiteBox");
    expect(() => runtimeSandboxEnvironment({ BOXRUN_URL: "https://remote.example" })).toThrow("REST");
    expect(runtimeSandboxEnvironment({})).toEqual({ providerId: "litebox", image: "node:22-bookworm", connection: { type: "embedded" } });
    expect(runtimeSandboxEnvironment({ SANDBOX_IMAGE: "prepared-acp-image" }).image).toBe("prepared-acp-image");
    expect(runtimeSandboxEnvironment({ BOXLITE_HOME: " /tmp/oma-boxlite " })).toEqual({
      providerId: "litebox", image: "node:22-bookworm", connection: { type: "embedded", homeDir: "/tmp/oma-boxlite" },
    });
  });
});
