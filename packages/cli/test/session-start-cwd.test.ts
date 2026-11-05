import { zipSync } from "fflate";
import { access, chmod, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const legacySpawns = vi.hoisted(() => [] as Array<{ agent?: { cwd?: string } }>);

vi.mock("@open-managed-agents/acp-runtime/placement", () => ({
  createAcpRuntime: () => ({
    async start(options: { agent?: { cwd?: string } }) {
      legacySpawns.push(options);
      return { acpSessionId: "legacy-acp" };
    },
  }),
}));

import { acpSessionFixture } from "../../managed-agents-runtime/test/acp-fixtures";
import { createNodeSessionManagerRuntimeDependencies } from "../src/bridge/lib/node-session-runtime";
import { paths } from "../src/bridge/lib/platform";
import { configureManagedSkills } from "../src/bridge/lib/managed-skills";
import { SessionManager } from "../src/bridge/lib/session-manager";

const BUNDLE = {
  files: [
    { path: "AGENTS.md", content: "# from oma\n" },
    { path: ".claude/skills/demo/SKILL.md", content: "skill body\n" },
  ],
};

let restoreFetch: (() => void) | undefined;
let restorePath: (() => void) | undefined;
let profileDir: string | undefined;
const projectDirs: string[] = [];

beforeAll(async () => {
  process.env.OMA_PROFILE = "oma3cwd";
  profileDir = paths().configDir;
  const bin = await mkdtemp(join(tmpdir(), "oma-cwd-bin-"));
  const command = join(bin, "codex-acp");
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o755);
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  restorePath = () => {
    process.env.PATH = previousPath;
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (!url.includes("/agents/runtime/sessions/") || !url.includes("/bundle")) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return new Response(JSON.stringify(BUNDLE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previousFetch;
  };
});

afterAll(async () => {
  restoreFetch?.();
  restorePath?.();
  delete process.env.OMA_PROFILE;
  if (profileDir?.includes(`${join(".oma", "bridge-oma3cwd")}`)) {
    await rm(profileDir, { recursive: true, force: true });
  }
  await Promise.all(projectDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session.start cwd", () => {
  it("filters protected overlays in both host paths, including when task-owned keys are unset", async () => {
    const originalFetch = globalThis.fetch;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const blocked = ["PATH", "Home", "oMa_PROFILE", "CLAUDE_CONFIG_DIR", "OPENMA_SKILLS_DIR",
      "claudecode", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];
    globalThis.fetch = (async () => Response.json({ ...BUNDLE, env: [
      ...blocked.map((name) => ({ name, value: "overlay-secret" })),
      { name: "NORMAL", value: "environment" }, { name: "NORMAL", value: "session" },
    ] })) as typeof fetch;
    try {
      for (const [start, sessionId] of [[startPrepared, "ea11aaaaaa11"], [startLegacy, "eb11bbbbbb11"]] as const) {
        stderr.mockClear();
        const { started } = await start(sessionId);
        expect(started).toHaveLength(1);
        expect(started[0].agent).toMatchObject({ env: {
          NORMAL: "session", CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_CODE_SSE_PORT: undefined,
        } });
        for (const key of blocked.filter((key) => !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"].includes(key))) {
          expect(started[0].agent).not.toHaveProperty(`env.${key}`);
        }
        const warnings = stderr.mock.calls.filter(([line]) => String(line).includes("custom_env: blocked key skipped"));
        expect(warnings).toEqual(blocked.map((name) => [`  ! custom_env: blocked key skipped key="${name}"\n`]));
        expect(JSON.stringify(stderr.mock.calls)).not.toContain("overlay-secret");
      }
    } finally { globalThis.fetch = originalFetch; stderr.mockRestore(); }
  });

  it("prepareNodeSession keeps the ACP cwd in the scratch dir when cwd is absent", async () => {
    const sessionId = "a11aaaaaaa11";
    const { started, messages } = await startPrepared(sessionId);

    const scratch = scratchDir(sessionId);
    expect(started).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ command: "codex-acp", cwd: scratch }),
      }),
    ]);
    await expectBundle(scratch);
    expect(messages).toEqual([
      expect.objectContaining({
        type: "session.ready",
        session_id: sessionId,
        bundle_dir: scratch,
        fresh: true,
      }),
    ]);
  });

  it("prepareNodeSession uses the project path as the ACP cwd and writes the bundle to the scratch dir", async () => {
    const sessionId = "a12aaaaaaa12";
    const project = await projectDir();
    const { started } = await startPrepared(sessionId, project);

    const scratch = scratchDir(sessionId);
    expect(scratch).not.toBe(project);
    expect(started).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ command: "codex-acp", cwd: project }),
      }),
    ]);
    await expectBundle(scratch);
    await expectNoBundle(project);
  });

  it("the legacy spawn keeps the ACP cwd in the scratch dir when cwd is absent", async () => {
    const sessionId = "b11bbbbbbb11";
    const { started, messages } = await startLegacy(sessionId);

    const scratch = scratchDir(sessionId);
    expect(started).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ command: "codex-acp", cwd: scratch }),
      }),
    ]);
    await expectBundle(scratch);
    expect(messages).toEqual([
      expect.objectContaining({
        type: "session.ready",
        session_id: sessionId,
        bundle_dir: scratch,
        fresh: true,
      }),
    ]);
  });

  it("prepares complete managed packages for both daemon paths, pins latest on reapply, and keeps projects untouched", async () => {
    const originalFetch = globalThis.fetch;
    let latest = "v1";
    let downloads = 0;
    const skillId = `skill_cwd_${Date.now()}`;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/bundle")) {
        expect(url).toContain("skill_cache=1");
        return Response.json({ files: [{ path: "AGENTS.md", content: "# from oma\n" }],
          managed_skills: [{ skill_id: skillId, type: "custom" }] });
      }
      expect(new Headers(init?.headers).get("x-api-key")).toBe("oma_fixture_key");
      if (url.endsWith(`/skills/${skillId}`)) return Response.json({ latest_version_id: latest });
      if (url.endsWith("/content")) {
        downloads++;
        return new Response(zipSync({ "demo/SKILL.md": Buffer.from("skill version"),
          "demo/references/data.bin": new Uint8Array([0, 255]) }));
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;
    try {
      const project = await projectDir();
      const a = "ca11aaaaaa11";
      const b = "cb11bbbbbb11";
      const c = "cc11cccccc11";
      const first = await startPrepared(a, project);
      const second = await startLegacy(b, project);
      expect(first.started).toHaveLength(1);
      expect(second.started).toHaveLength(1);
      const link = (id: string) => join(scratchDir(id), "skills", skillId);
      const target = await readlink(link(a));
      expect(await readlink(link(b))).toBe(target);
      expect(downloads).toBe(1);
      const cfg = join(scratchDir(a), ".claude-config");
      await configureManagedSkills(scratchDir(a), "claude-acp", [{
        skill_id: skillId, version: "v1", cachePath: target, linkPath: link(a), manifests: ["demo/SKILL.md"],
      }], cfg);
      expect(await readlink(join(cfg, "skills", skillId))).toBe(join(target, "demo"));
      expect(await readFile(join(cfg, "skills", skillId, "SKILL.md"), "utf8")).toBe("skill version");
      latest = "v2";
      await startPrepared(a, project); // New manager models a daemon restart.
      expect(await readlink(link(a))).toBe(target);
      await startPrepared(c, project);
      expect(await readlink(link(c))).not.toBe(target);
      expect(downloads).toBe(2);
      expect(await readFile(join(link(a), "demo/references/data.bin"))).toEqual(Buffer.from([0, 255]));
      expect(await readFile(join(scratchDir(a), "AGENTS.md"), "utf8")).toContain(`${skillId}@v1`);
      expect(first.started[0].agent).toMatchObject({ env: { OPENMA_SKILLS_DIR: join(scratchDir(a), "skills") } });
      await expectNoBundle(project);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("does not spawn with a missing managed skill or a failed bundle fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    try {
      const prepared = await startPrepared("fa11aaaaaa11");
      const legacy = await startLegacy("fb11bbbbbb11");
      for (const result of [prepared, legacy]) {
        expect(result.started).toEqual([]);
        expect(result.messages).toContainEqual(expect.objectContaining({ type: "session.error" }));
      }
    } finally { globalThis.fetch = originalFetch; }
  });

  it("the legacy spawn uses the project path as the ACP cwd and writes the bundle to the scratch dir", async () => {
    const sessionId = "b12bbbbbbb12";
    const project = await projectDir();
    const { started } = await startLegacy(sessionId, project);

    const scratch = scratchDir(sessionId);
    expect(scratch).not.toBe(project);
    expect(started).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ command: "codex-acp", cwd: project }),
      }),
    ]);
    await expectBundle(scratch);
    await expectNoBundle(project);
  });
});

function scratchDir(sessionId: string): string {
  return join(paths().sessionsDir, sessionId);
}

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oma-project-"));
  projectDirs.push(dir);
  return dir;
}

async function startPrepared(sessionId: string, cwd?: string) {
  const started: Array<{ agent?: { cwd?: string; command?: string } }> = [];
  const messages: unknown[] = [];
  const dependencies = createNodeSessionManagerRuntimeDependencies();
  const manager = new SessionManager(
    (message) => messages.push(message),
    {
      acpRuntime: {
        async start(options: { agent?: { cwd?: string; command?: string } }) {
          started.push(options);
          return acpSessionFixture({ acpSessionId: `acp-${sessionId}` });
        },
      },
      prepareSession: dependencies.prepareSession,
    },
  );
  configure(manager);
  await manager.start({
    session_id: sessionId,
    agent_id: "codex-acp",
    tenant_id: "workspace-1",
    ...(cwd ? { cwd } : {}),
  });
  return { started, messages };
}

async function startLegacy(sessionId: string, cwd?: string) {
  legacySpawns.length = 0;
  const messages: unknown[] = [];
  const manager = new SessionManager((message) => messages.push(message));
  configure(manager);
  await manager.start({
    session_id: sessionId,
    agent_id: "codex-acp",
    tenant_id: "workspace-1",
    ...(cwd ? { cwd } : {}),
  });
  return { started: [...legacySpawns], messages };
}

function configure(manager: SessionManager): void {
  manager.setTenantKeys([{ id: "workspace-1", agentApiKey: "oma_fixture_key" }]);
  manager.setSpawnEnv({
    apiUrl: "https://managed.example.test",
    runtimeToken: "sk_machine_fixture",
  });
}

async function expectBundle(scratch: string): Promise<void> {
  expect(await readFile(join(scratch, "AGENTS.md"), "utf8")).toBe("# from oma\n");
  expect(await readFile(join(scratch, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("skill body\n");
}

async function expectNoBundle(project: string): Promise<void> {
  await expect(access(join(project, "AGENTS.md"))).rejects.toThrow();
  await expect(access(join(project, ".claude"))).rejects.toThrow();
}
