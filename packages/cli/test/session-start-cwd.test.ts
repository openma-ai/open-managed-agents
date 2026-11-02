import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
