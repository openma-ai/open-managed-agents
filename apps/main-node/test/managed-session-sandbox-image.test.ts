import { describe, expect, it } from "vitest";
import {
  parseSandboxImageCatalog,
  withSandboxFactoryCapabilities,
  SandboxImageUnavailableError,
  type SandboxExecutor,
  type SandboxFactoryContext,
} from "@open-managed-agents/sandbox";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import { createManagedSandboxBuilder } from "../../../packages/control-plane-node/src/lib/node-managed-sandbox-builder.js";
import { sandboxFactory as e2bFactory } from "../../../packages/sandbox-adapter-e2b/src/e2b";
import { sandboxFactory as localFactory } from "../../../packages/sandbox/src/adapters/local-subprocess";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const session: Session = {
  id: "session_img",
  agent: {
    id: "agent_img",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Analyst",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-10-23T00:00:00.000Z",
  environmentId: "env_img",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-10-23T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

function environmentWith(sandboxImage?: string): Environment {
  return {
    id: "env_img",
    archivedAt: null,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
      packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    },
    createdAt: "2026-10-23T00:00:00.000Z",
    description: null,
    metadata: {},
    name: "analytics",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...(sandboxImage !== undefined && { openma: { sandboxImage } }),
  };
}

const catalog = parseSandboxImageCatalog(JSON.stringify({
  analytics: { reference: "registry.example/oma/analytics:1", label: "Analytics" },
  web: { reference: "registry.example/oma/web:1" },
}));

/** Runner wired like node-managed: the real builder in front of a recording
 * SandboxFactory (the embedder's `nodeDefaults(config, { sandbox })` hook). */
function runnerWithFactory() {
  const contexts: SandboxFactoryContext[] = [];
  const buildSandbox = createManagedSandboxBuilder({
    images: catalog,
    workdir: (sessionId) => `/sandboxes/${sessionId}`,
    build: async (sessionId, workdir, scope) => {
      contexts.push({ ...scope, sessionId, workdir });
      return { destroy: async () => undefined } as unknown as SandboxExecutor;
    },
  });
  const runner = new DefaultNodeManagedSessionRunner({
    outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
    confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
    buildSandbox,
    buildModel: async () => ({}),
    buildTools: async () => ({}),
    buildHarness: () => ({ run: async () => undefined }),
    buildHarnessContext: async (input: unknown) => input,
    clock: { now: () => new Date("2026-10-23T01:00:00.000Z") },
    ids: { nextEventId: () => "event_img" },
  } as never);
  return { runner, contexts };
}

describe("managed session sandbox image selection", () => {
  it("preserves E2B allocation isolation through prepared-base wrapping and honors an explicit opt-out", async () => {
    const wrapped = withSandboxFactoryCapabilities(e2bFactory, { preparedBase: true });
    let builds = 0;
    const builder = (capabilities: typeof wrapped.capabilities) => createManagedSandboxBuilder({
      capabilities, workdir: () => "/workspace", build: async () => { builds++; return {} as SandboxExecutor; },
    });
    const input = { workspaceId: "workspace", session, environment: environmentWith(), allocationId: "runtime_a" };
    await builder(wrapped.capabilities)(input);
    expect(builds).toBe(1);
    expect(wrapped.capabilities?.preparedBase).toBe(true);
    const disabled = withSandboxFactoryCapabilities(wrapped, { allocationIsolation: false });
    await expect(builder(disabled.capabilities)(input)).rejects.toThrow(/isolat/i);
    expect(builds).toBe(1);
    expect(disabled.capabilities?.preparedBase).toBe(true);
  });

  it("refuses an isolated allocation before calling a factory without the capability", async () => {
    let builds = 0;
    const build = createManagedSandboxBuilder({ workdir: () => "/sandboxes/session", build: async () => { builds++; return {} as SandboxExecutor; } });
    await expect(build({ workspaceId: "workspace", session, environment: environmentWith(), allocationId: "runtime_a" } as never)).rejects.toThrow(/isolat/i);
    expect(builds).toBe(0);
  });

  it("keeps the logical Session ID while isolating allocation context and local workdirs", async () => {
    const contexts: SandboxFactoryContext[] = [];
    const build = createManagedSandboxBuilder({
      capabilities: { allocationIsolation: true }, workdir: () => "/sandboxes/session",
      build: async (sessionId, workdir, scope) => { contexts.push({ ...scope, sessionId, workdir }); return {} as SandboxExecutor; },
    } as Parameters<typeof createManagedSandboxBuilder>[0]);
    for (const allocationId of ["runtime_a", "runtime_b"]) await build({ workspaceId: "workspace", session, environment: environmentWith(), allocationId } as never);
    expect(contexts.map(ctx => ctx.sessionId)).toEqual(["session_img", "session_img"]);
    expect(contexts.map(ctx => (ctx as SandboxFactoryContext & { allocationId: string }).allocationId)).toEqual(["runtime_a", "runtime_b"]);
    expect(contexts[0]!.workdir).not.toBe(contexts[1]!.workdir);
  });

  it("isolates actual local factory files across cold allocation generations", async () => {
    const root = await mkdtemp(resolve(".allocation-test-"));
    const build = createManagedSandboxBuilder({
      capabilities: localFactory.capabilities, workdir: () => root,
      build: (sessionId, workdir, scope) => localFactory({ ...scope, sessionId, workdir }, {}),
    });
    let a: SandboxExecutor | undefined; let b: SandboxExecutor | undefined;
    try {
      const input = { workspaceId: "workspace", session, environment: environmentWith() };
      a = await build({ ...input, allocationId: "runtime_a" });
      await a.writeFile("/workspace/dirty.txt", "old");
      b = await build({ ...input, allocationId: "runtime_b" });
      await b.writeFile("/workspace/canonical.txt", "canonical");
      await a.destroy?.();
      expect(await b.exec("test ! -f dirty.txt && cat canonical.txt")).toBe("canonical");
    } finally { await a?.destroy?.(); await b?.destroy?.(); await rm(root, { recursive: true, force: true }); }
  });

  it("hands the resolved catalog image, workspace, and environment to the sandbox factory", async () => {
    const { runner, contexts } = runnerWithFactory();
    await runner.start({
      workspaceId: "workspace_img",
      sessionId: session.id,
      session,
      environment: environmentWith("analytics"),
      initialEvents: [],
    });
    expect(contexts).toEqual([{
      sessionId: "session_img",
      workdir: "/sandboxes/session_img",
      workspaceId: "workspace_img",
      environmentId: "env_img",
      image: { alias: "analytics", reference: "registry.example/oma/analytics:1" },
    }]);
    await runner.stop({ workspaceId: "workspace_img", sessionId: session.id });
  });

  it("omits image for an Environment on the default image", async () => {
    const { runner, contexts } = runnerWithFactory();
    await runner.start({
      workspaceId: "workspace_img",
      sessionId: session.id,
      session,
      environment: environmentWith(),
      initialEvents: [],
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).not.toHaveProperty("image");
    expect(contexts[0]).toMatchObject({ workspaceId: "workspace_img", environmentId: "env_img" });
    await runner.stop({ workspaceId: "workspace_img", sessionId: session.id });
  });

  it("rebuilds a warm sandbox whenever the Environment switches image, and reuses it otherwise", async () => {
    const { runner, contexts } = runnerWithFactory();
    const start = (sandboxImage?: string) => runner.start({
      workspaceId: "workspace_img",
      sessionId: session.id,
      session,
      environment: environmentWith(sandboxImage),
      initialEvents: [],
    });
    await start("analytics");
    await start("analytics");
    await start("web");
    await start();
    expect(contexts.map((ctx) => ctx.image)).toEqual([
      { alias: "analytics", reference: "registry.example/oma/analytics:1" },
      { alias: "web", reference: "registry.example/oma/web:1" },
      undefined,
    ]);
    await runner.stop({ workspaceId: "workspace_img", sessionId: session.id });
  });

  it("fails the session start when the selected alias left the catalog, without a default fallback", async () => {
    const { runner, contexts } = runnerWithFactory();
    const start = runner.start({
      workspaceId: "workspace_img",
      sessionId: session.id,
      session,
      environment: environmentWith("retired"),
      initialEvents: [],
    });
    await expect(start).rejects.toBeInstanceOf(SandboxImageUnavailableError);
    await expect(start).rejects.toThrow(
      'Sandbox image "retired" selected by environment env_img is not in this deployment\'s SANDBOX_IMAGES catalog',
    );
    expect(contexts).toEqual([]);
    expect(runner.connectedSandbox({ workspaceId: "workspace_img", sessionId: session.id })).toBeNull();
  });
});
