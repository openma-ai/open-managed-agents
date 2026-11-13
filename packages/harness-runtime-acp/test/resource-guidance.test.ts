// Work (inside-sandbox supervisor) resource guidance.
//
// Evidence level, stated honestly: the ACP agent is a DETERMINISTIC MODEL
// FIXTURE (no inference). It knows nothing except the prompt text the real
// supervisor sends it, and acts only on what that prompt says. Its actions are
// REAL local filesystem/process effects: reading SKILL.md, executing the
// bundled relative script with `sh`, writing outputs and reading Memory. The
// sandbox roots `/workspace` and `/mnt` are remapped to temp directories; this
// is not a sandbox, mount, R2 or live-service certification.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import type { AcpRuntime, SessionOptions } from "@open-managed-agents/acp-runtime";
import type { NodeAcpHarnessStateIo } from "../src/node";
import {
  createNodeManagedAcpSupervisorApp as createProductionApp,
  type NodeManagedAcpSupervisorAppOptions,
} from "../src/node-supervisor";
import { configurationWorkHttp } from "./helpers/configuration-work-http.js";
import { workRuntimeModules } from "./helpers/work-runtime-modules.js";

const run = promisify(execFile);
const modules = await workRuntimeModules();

const scope = { workspaceId: "workspace_1", environmentId: "environment_1", sessionId: "session_rg", workId: "work_rg" };
const environment = {
  ANTHROPIC_BASE_URL: "https://api.openma.test",
  ANTHROPIC_ENVIRONMENT_ID: scope.environmentId,
  ANTHROPIC_SESSION_ID: scope.sessionId,
  ANTHROPIC_WORK_ID: scope.workId,
  ANTHROPIC_WORK_SECRET: Buffer.from(JSON.stringify({
    sessions_token: "scoped-session-token", api_base_url: "https://gateway.openma.test",
  })).toString("base64url"),
};

const SKILL_MD = "---\nname: report-builder\ndescription: Build a report\n---\n"
  + "Run `sh ./scripts/emit.sh <title> <destination>` from this skill directory.\n";
// Relative read of ./data/seed.txt proves the script ran with the skill dir as cwd.
const EMIT_SH = "#!/bin/sh\nset -eu\nprintf 'report:%s:%s' \"$1\" \"$(cat ./data/seed.txt)\" > \"$2\"\n";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

interface Sandbox { workspace: string; mnt: string; host(path: string): string }

async function sandboxRoots(roots: string[]): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "openma-resource-guidance-"));
  roots.push(base);
  const workspace = join(base, "workspace");
  const mnt = join(base, "mnt");
  await mkdir(workspace, { recursive: true });
  await mkdir(mnt, { recursive: true });
  return {
    workspace, mnt,
    host(path) {
      if (path === "/workspace" || path.startsWith("/workspace/")) return workspace + path.slice("/workspace".length);
      if (path.startsWith("/mnt/")) return mnt + path.slice("/mnt".length);
      throw new Error(`fixture agent touched a path outside the sandbox roots: ${path}`);
    },
  };
}

interface AgentObservation {
  platform: string;
  skillManifest?: string;
  report?: string;
  memoryRead?: Record<string, string>;
  memoryModes?: Record<string, string>;
}

/** Deterministic ACP agent: acts only on the guidance in its prompt. */
function guidanceDrivenAgent(sandbox: Sandbox, seen: SessionOptions[], prompts: string[], observed: AgentObservation[]): AcpRuntime {
  async function act(prompt: string): Promise<AgentObservation> {
    const platform = /<openma-platform>\n([\s\S]*?)\n<\/openma-platform>/u.exec(prompt)?.[1] ?? "";
    const observation: AgentObservation = { platform };
    const skill = /Skill "report-builder" files are installed at (\/\S+?)\/ \(manifest: (\/\S+?)\)/u.exec(platform);
    if (skill) {
      const [, directory, manifest] = skill;
      observation.skillManifest = await readFile(sandbox.host(manifest!), "utf8");
      const command = /`(sh \.\/scripts\/emit\.sh) <title> <destination>`/u.exec(observation.skillManifest)?.[1];
      const outputs = /Files you write under `(\/\S+?)\/`/u.exec(platform)?.[1];
      if (command && outputs) {
        await mkdir(sandbox.host(outputs), { recursive: true });
        const destination = sandbox.host(`${outputs}/report.txt`);
        await run("sh", ["./scripts/emit.sh", "Q4", destination], { cwd: sandbox.host(directory!) });
        observation.report = await readFile(destination, "utf8");
      }
    }
    for (const match of platform.matchAll(/## Memory store: ([^\n]+)\nMounted at (\/\S+?)\/ \((read-only|read-write)\)/gu)) {
      const [, name, path, mode] = match;
      (observation.memoryModes ??= {})[name!] = mode!;
      (observation.memoryRead ??= {})[name!] = await readFile(sandbox.host(`${path}/notes.md`), "utf8");
    }
    return observation;
  }
  return {
    async start(options) {
      seen.push(options);
      const configOptions = [{ id: "mode", name: "Mode", type: "select" as const, currentValue: "agent-full-access", options: [{ value: "agent-full-access", name: "Full" }] }];
      return {
        id: "internal_rg", acpSessionId: "native_rg", options, authMethods: [], protocolVersion: null,
        agentInfo: null, agentCapabilities: {}, initializeMeta: null, sessionSetupMeta: null, configOptions,
        modes: null, promptCapabilities: {}, supportsSessionFork: false, supportsSessionList: false,
        supportsSessionDelete: false, supportsSessionResume: true, supportsSessionClose: true,
        supportsAdditionalDirectories: false, supportsLogout: false, supportsProviders: false, supportsNes: false,
        nesCapabilities: null, positionEncoding: null, supportsSteering: true,
        async *prompt(text: string | readonly unknown[], dispatch?: { onDispatched?(): Promise<void> }) {
          await dispatch?.onDispatched?.();
          prompts.push(String(text));
          observed.push(await act(String(text)));
          yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } };
          yield { type: "promptComplete", response: {} };
        },
        async steer() { return "promptRequired" as const; },
        async cancelCurrentTurn() {}, drainPendingEvents() { return []; },
        async setConfigOption() { return configOptions; }, async authenticate() {}, async setMode() {},
        async listSessions() { return { sessions: [] }; }, async deleteSession() {}, async logout() {},
        async listProviders() { return { providers: [] }; }, async setProvider() {}, async disableProvider() {},
        async requestExtension() { return {}; }, async notifyExtension() {}, async startNes() { return {}; },
        async suggestNes() { return {}; }, async closeNes() {}, async didOpenDocument() {},
        async didChangeDocument() {}, async didCloseDocument() {}, async didSaveDocument() {},
        async didFocusDocument() {}, async acceptNes() {}, async rejectNes() {},
        isAlive() { return true; }, async dispose() {},
      } as never;
    },
  };
}

function supervisor(options: NodeManagedAcpSupervisorAppOptions) {
  return createProductionApp({
    ...options,
    fetch: configurationWorkHttp(options.fetch ?? globalThis.fetch),
    workClaim: { generation: 1, holder: "fixture" },
    control: {
      ...options.control,
      runtime: {
        createSupervisor: modules.common.createManagedAcpSupervisorHarness,
        createControlChannel: modules.common.createManagedHarnessHttpControlChannel,
        async applyPermissionMode(session) {
          await session.setConfigOption("mode", "agent-full-access");
          return { status: "applied", nativeModeId: "agent-full-access", verification: "session/set_config_option" };
        },
      },
    },
    finalization: { async drainTurn(context) { await context.flush(); } },
  });
}

function sessionFetch(input: { resources?: unknown; skills?: unknown[]; history?: unknown[] }) {
  let eventPoll = 0;
  return vi.fn(async (raw: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = new Request(raw, init);
    if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) {
      return json({
        id: scope.sessionId, environment_id: scope.environmentId, archived_at: null, status: "running",
        ...(input.resources === undefined ? {} : { resources: input.resources }),
        agent: {
          id: "agent_rg", version: 1, model: { id: "deepseek-chat" }, mcp_servers: [],
          skills: input.skills ?? [], system: "Agent system prompt.", tools: [],
        },
      });
    }
    if (request.url.endsWith("/v1/skills/skill_report/versions/3/content")) {
      return new Response(zipSync({
        "report-builder/SKILL.md": new TextEncoder().encode(SKILL_MD),
        "report-builder/scripts/emit.sh": new TextEncoder().encode(EMIT_SH),
        "report-builder/data/seed.txt": new TextEncoder().encode("seed-7f3a"),
      }), { headers: { "content-type": "application/zip" } });
    }
    if (request.url.includes(`/v1/sessions/${scope.sessionId}/events`)) {
      eventPoll += 1;
      if (eventPoll === 1) {
        return json({
          data: [
            { id: "turn_rg", type: "user.message", processed_at: "2026-11-13T01:00:00.000Z", content: [{ type: "text", text: "build the Q4 report" }] },
            { id: "terminated_rg", type: "session.status_terminated", processed_at: "2026-11-13T01:00:01.000Z" },
          ],
          next_page: null,
        });
      }
      return json({ data: input.history ?? [], next_page: null });
    }
    if (request.url.endsWith(`/v1/oma/sessions/${scope.sessionId}/runtime-events`)) {
      return json({ data: (await request.json() as { events: { id: string }[] }).events.map((event) => ({ id: event.id })) });
    }
    throw new Error(`unexpected request ${request.url}`);
  });
}

async function runOnce(app: ReturnType<typeof supervisor>, outputPath: "/mnt/session/outputs" | null) {
  const harness = await app.resolveHarness({ id: "acp", version: "1" });
  const started = await harness!.start({
    scope, harness: { id: "acp", version: "1" }, workspacePath: "/workspace", outputPath,
    checkpoint: async () => {}, signal: new AbortController().signal,
  });
  await started.completed;
  await started.drain();
}

const MEMORY_RESOURCES = [
  { type: "memory_store", memory_store_id: "memstore_rw", name: "Project Knowledge", mount_path: "/mnt/memory/project-knowledge", access: "read_write", description: "Team notes", instructions: "Check before starting." },
  { type: "memory_store", memory_store_id: "memstore_ro", name: "policies", mount_path: "/mnt/memory/policies", access: "read_only" },
  { type: "file", file_id: "file_1", mount_path: "/workspace/input.csv" },
];

describe("Work supervisor resource guidance (deterministic agent fixture, real local fs/process)", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("agent follows first-turn guidance: runs the bundled relative Skill script into the collected outputs dir and reads Memory at its materialized mount", async () => {
    const sandbox = await sandboxRoots(roots);
    // Memory as the Work materializer leaves it: at each record's mount_path.
    await mkdir(sandbox.host("/mnt/memory/project-knowledge"), { recursive: true });
    await mkdir(sandbox.host("/mnt/memory/policies"), { recursive: true });
    await writeFile(sandbox.host("/mnt/memory/project-knowledge/notes.md"), "rw-bytesé\n");
    await writeFile(sandbox.host("/mnt/memory/policies/notes.md"), "ro-bytes\n");
    const seen: SessionOptions[] = [];
    const prompts: string[] = [];
    const observed: AgentObservation[] = [];
    const app = supervisor({
      environment, workspacePath: sandbox.workspace,
      acpRuntime: guidanceDrivenAgent(sandbox, seen, prompts, observed),
      fetch: sessionFetch({ resources: MEMORY_RESOURCES, skills: [{ type: "custom", skill_id: "skill_report", version: "3", name: "report-builder" }] }),
      control: { pollIntervalMs: 1, scheduler: { sleep: async () => {} } },
      resolveAgent: async () => ({ id: "codex-acp", command: "codex-acp" }),
    });

    await runOnce(app, "/mnt/session/outputs");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^<openma-platform>\nAgent system prompt\.\n\n<source name="session_workspace">/u);
    expect(prompts[0]).toContain("The session workspace is /workspace/.");
    expect(prompts[0]).toContain('<source name="skill_files:skill_report">');
    expect(prompts[0]!.endsWith("\n</openma-platform>\n\nbuild the Q4 report")).toBe(true);
    const [agent] = observed;
    expect(agent!.skillManifest).toBe(SKILL_MD);
    // Exact bytes produced by the relative script, run from the stated skill dir.
    expect(agent!.report).toBe("report:Q4:seed-7f3a");
    expect(await readFile(sandbox.host("/mnt/session/outputs/report.txt"), "utf8")).toBe("report:Q4:seed-7f3a");
    expect(agent!.memoryModes).toEqual({ "Project Knowledge": "read-write", policies: "read-only" });
    expect(agent!.memoryRead).toEqual({ "Project Knowledge": "rw-bytesé\n", policies: "ro-bytes\n" });
    expect(agent!.platform).toContain("(read-only mount — write attempts to this directory will fail)");
    expect(agent!.platform).toContain("Team notes\nCheck before starting.");
    // A file resource is not a Memory Store and yields no Memory guidance.
    expect(agent!.platform).not.toContain("input.csv");
    // Launch config derives from the same facts; env alone is kept, not relied on.
    expect(seen[0]!.agent.cwd).toBe("/workspace");
    expect(seen[0]!.agent.env?.OUTPUT_PATH).toBe("/mnt/session/outputs");
    expect(seen[0]!.agent.env?.OMA_OUTPUTS_DIR).toBe("/mnt/session/outputs");
    expect(seen[0]!.agent.env?.OMA_MEMORY_PROJECT_KNOWLEDGE).toBe("/mnt/memory/project-knowledge");
    // Materialization is where the guidance points.
    expect(await readFile(join(sandbox.workspace, ".openma/skills/skill_report/3/report-builder/scripts/emit.sh"), "utf8")).toBe(EMIT_SH);
  });

  it("negative control: no outputs dir collected -> no outputs guidance, so the agent writes no artifact", async () => {
    const sandbox = await sandboxRoots(roots);
    const seen: SessionOptions[] = [];
    const prompts: string[] = [];
    const observed: AgentObservation[] = [];
    const app = supervisor({
      environment, workspacePath: sandbox.workspace,
      acpRuntime: guidanceDrivenAgent(sandbox, seen, prompts, observed),
      fetch: sessionFetch({ skills: [{ type: "custom", skill_id: "skill_report", version: "3" }] }),
      control: { pollIntervalMs: 1, scheduler: { sleep: async () => {} } },
      resolveAgent: async () => ({ id: "codex-acp", command: "codex-acp" }),
    });

    await runOnce(app, null);

    expect(observed[0]!.platform).not.toContain("session_outputs");
    expect(observed[0]!.platform).not.toContain("Memory store");
    // Skill without a snapshot name is still discoverable by id.
    expect(observed[0]!.platform).toContain(`<source name="skill_files:skill_report">`);
    expect(observed[0]!.report).toBeUndefined();
    await expect(readFile(sandbox.host("/mnt/session/outputs/report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(seen[0]!.agent.env?.OUTPUT_PATH).toBeUndefined();
  });

  it("recovery: a missing native checkpoint re-sends the same resource guidance with the canonical history", async () => {
    const prompts: string[] = [];
    const seen: SessionOptions[] = [];
    const stateIo: NodeAcpHarnessStateIo = {
      async readFile() { return JSON.stringify({ version: 1, adapter_id: "codex", acp_session_id: "native_missing" }); },
      async writeFile() {}, async writeFileBytes() {},
      async exec(command) { return command.startsWith("if [ -d ") ? "missing" : ""; },
    };
    const sandbox = await sandboxRoots(roots);
    const observed: AgentObservation[] = [];
    const app = supervisor({
      environment, stateIo,
      acpRuntime: guidanceDrivenAgent(sandbox, seen, prompts, observed),
      fetch: sessionFetch({
        resources: [MEMORY_RESOURCES[1]],
        history: [{ id: "history_rg", type: "agent.message", processed_at: "2026-11-13T00:59:00.000Z", content: [{ type: "text", text: "Earlier the report was drafted." }] }],
      }),
      recovery: { maxCharacters: 4_096 },
      lifecycle: { drainDeadlineMs: 100, drainPollIntervalMs: 1, abortGraceMs: 0 },
      control: { pollIntervalMs: 1, retry: { maxAttempts: 1 }, scheduler: { sleep: async () => {} } },
      resolveAgent: async () => ({ id: "codex-acp", command: "codex-acp" }),
    });
    await mkdir(sandbox.host("/mnt/memory/policies"), { recursive: true });
    await writeFile(sandbox.host("/mnt/memory/policies/notes.md"), "ro-bytes\n");

    await runOnce(app, "/mnt/session/outputs");

    expect(seen[0]?.resumeAcpSessionId).toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Earlier the report was drafted.");
    expect(prompts[0]).toContain(`<source name="memory:memstore_ro">\n## Memory store: policies\nMounted at /mnt/memory/policies/ (read-only)`);
    expect(prompts[0]).toContain(`<source name="session_outputs">\nFiles you write under \`/mnt/session/outputs/\``);
    expect(observed[0]!.memoryRead).toEqual({ policies: "ro-bytes\n" });
  });

  it.each([
    ["non-array resources", { not: "an array" }, "Managed Session resources is invalid"],
    ["memory_store without id", [{ type: "memory_store", name: "x", mount_path: "/mnt/memory/x" }], "resources[0].memory_store_id is invalid"],
    ["missing mount_path", [{ type: "memory_store", memory_store_id: "m", name: "x" }], "resources[0].mount_path is invalid"],
    ["relative mount_path", [{ type: "memory_store", memory_store_id: "m", name: "x", mount_path: "mnt/memory/x" }], "absolute path"],
    ["overlapping mounts", [
      { type: "memory_store", memory_store_id: "a", name: "a", mount_path: "/mnt/memory/a" },
      { type: "memory_store", memory_store_id: "b", name: "b", mount_path: "/mnt/memory/a/b" },
    ], "overlap"],
  ])("fails startup closed instead of advertising untrue Memory guidance: %s", async (_label, resources, message) => {
    const sandbox = await sandboxRoots(roots);
    const seen: SessionOptions[] = [];
    const app = supervisor({
      environment, workspacePath: sandbox.workspace,
      acpRuntime: guidanceDrivenAgent(sandbox, seen, [], []),
      fetch: sessionFetch({ resources }),
      control: { pollIntervalMs: 1, scheduler: { sleep: async () => {} } },
      resolveAgent: async () => ({ id: "codex-acp", command: "codex-acp" }),
    });
    const harness = await app.resolveHarness({ id: "acp", version: "1" });
    const started = harness!.start({
      scope, harness: { id: "acp", version: "1" }, workspacePath: "/workspace", outputPath: null,
      checkpoint: async () => {}, signal: new AbortController().signal,
    });
    const failure = await started.then((value) => value.completed).then(() => null, (error: unknown) => error);
    expect(String((failure as { cause?: unknown })?.cause ?? failure)).toContain(message);
    expect(seen).toHaveLength(0);
  });
});
