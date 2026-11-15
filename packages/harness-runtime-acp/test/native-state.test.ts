import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bindAcpAgentState } from "@open-managed-agents/acp-runtime/native-state";
import {
  createAcpNativeSessionState,
  createNodeAcpHarnessStateIo,
} from "../src/node";

describe("OpenMA-owned ACP native session durability", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([undefined, { id: "codex-acp", version: "1.8.0" }, { id: "codex-acp", version: "1.8.0", digest: "original" }])("restores only the session allowlist with matching harness identity %j", async (harness) => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-native-workspace-"));
    roots.push(workspace);
    const sessionId = `session_native_${Date.now()}`;
    const binding = bindAcpAgentState({
      sessionId,
      agent: { id: "codex-acp", command: "codex-acp" },
    });
    roots.push(join(
      tmpdir(),
      "openma-harness-state/acp",
      encodeURIComponent(sessionId),
    ));
    const makeState = () => createAcpNativeSessionState({
      harness,
      io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
      resolveSession: async () => ({
        agent: { id: "codex-acp", command: "codex-acp" },
        perTurnTimeoutMs: 1234,
      }),
    });
    const first = makeState();
    const start = {
      type: "session.start" as const,
      sessionId,
      agentId: "codex-acp",
      runtime: "cloud" as const,
    };

    await expect(first.beforeStart(start)).resolves.toEqual({ command: start });
    await first.onReady({ type: "session.ready", sessionId, acpSessionId: "acp_native_1" });
    await mkdir(`${binding.nativePath}/sessions/2026/09`, { recursive: true });
    await writeFile(`${binding.nativePath}/sessions/2026/09/turn.jsonl`, "native transcript\n");
    await writeFile(`${binding.nativePath}/config.toml`, "secret = 'must-not-persist'\n");
    await first.checkpoint({ sessionId, turnId: "turn_1" });
    await first.release({ sessionId, reason: "shutdown" });

    await expect(readFile(join(
      workspace,
      ".openma/harness-state/acp",
      encodeURIComponent(sessionId),
      "codex/v1/acp-session.json",
    ), "utf8")).resolves.toBe(
      `${JSON.stringify({
        version: 1,
        ...(harness === undefined ? {} : { harness }),
        adapter_id: "codex",
        acp_session_id: "acp_native_1",
        last_completed_turn_id: "turn_1",
      })}\n`,
    );

    await expect(readFile(
      join(workspace, ".openma/harness-state/acp", encodeURIComponent(sessionId), "codex/v1/native/sessions/2026/09/turn.jsonl"),
      "utf8",
    )).resolves.toBe("native transcript\n");
    await expect(readFile(
      join(workspace, ".openma/harness-state/acp", encodeURIComponent(sessionId), "codex/v1/native/config.toml"),
      "utf8",
    )).rejects.toThrow();

    const second = makeState();
    await expect(second.beforeStart({
      ...start,
      canonicalCompletedTurnId: "turn_1",
    })).resolves.toEqual({
      command: { ...start, acpSessionId: "acp_native_1" },
    });
    await expect(readFile(
      `${binding.nativePath}/sessions/2026/09/turn.jsonl`,
      "utf8",
    )).resolves.toBe("native transcript\n");
    await expect(second.prepare({ ...start, acpSessionId: "acp_native_1" }))
      .resolves.toMatchObject({
        agent: {
          command: "codex-acp",
          env: { CODEX_HOME: binding.nativePath },
        },
        perTurnTimeoutMs: 1234,
        resumeAcpSessionId: "acp_native_1",
      });
    await second.onReady({
      type: "session.ready",
      sessionId,
      acpSessionId: "acp_native_2",
    });
    await second.checkpoint({ sessionId });
    await expect(readFile(join(
      workspace,
      ".openma/harness-state/acp",
      encodeURIComponent(sessionId),
      "codex/v1/acp-session.json",
    ), "utf8")).resolves.toContain(
      '"acp_session_id":"acp_native_2","last_completed_turn_id":"turn_1"',
    );

    const changed = createAcpNativeSessionState({
      harness: { id: "codex-acp", version: "1.9.0" },
      io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
      resolveSession: async () => ({ agent: { id: "codex-acp", command: "codex-acp" } }),
    });
    await expect(changed.beforeStart(start)).rejects.toThrow(/harness version/);
    if (harness?.digest !== undefined) {
      const changedArtifact = createAcpNativeSessionState({
        harness: { ...harness, digest: "different" },
        io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
        resolveSession: async () => ({ agent: { id: "codex-acp", command: "codex-acp" } }),
      });
      await expect(changedArtifact.beforeStart(start)).rejects.toThrow(/harness version/);
    }
    if (harness !== undefined) {
      const legacy = createAcpNativeSessionState({
        io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
        resolveSession: async () => ({ agent: { id: "codex-acp", command: "codex-acp" } }),
      });
      await expect(legacy.beforeStart(start)).rejects.toThrow(/harness version/);
    }

    await second.release({ sessionId, reason: "destroy" });
    await expect(readFile(
      join(workspace, ".openma/harness-state/acp", encodeURIComponent(sessionId), "codex/v1/acp-session.json"),
      "utf8",
    )).rejects.toThrow();
  });

  it("rejects a native checkpoint behind the canonical completed-turn watermark", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-stale-workspace-"));
    roots.push(workspace);
    const sessionId = `session_stale_${Date.now()}`;
    const binding = bindAcpAgentState({
      sessionId,
      agent: { id: "codex-acp", command: "codex-acp" },
    });
    roots.push(join(
      tmpdir(),
      "openma-harness-state/acp",
      encodeURIComponent(sessionId),
    ));
    const io = createNodeAcpHarnessStateIo({ workspacePath: workspace });
    await io.writeFile(binding.checkpointPath, `${JSON.stringify({
      version: 1,
      adapter_id: "codex",
      acp_session_id: "acp_old",
      last_completed_turn_id: "turn_1",
    })}\n`);
    await mkdir(join(
      workspace,
      ".openma/harness-state/acp",
      encodeURIComponent(sessionId),
      "codex/v1/native/sessions",
    ), { recursive: true });
    await writeFile(join(
      workspace,
      ".openma/harness-state/acp",
      encodeURIComponent(sessionId),
      "codex/v1/native/sessions/old.jsonl",
    ), "stale transcript\n");
    const state = createAcpNativeSessionState({
      io,
      resolveSession: async () => ({
        agent: { id: "codex-acp", command: "codex-acp" },
      }),
    });
    const start = {
      type: "session.start" as const,
      sessionId,
      agentId: "codex-acp",
      runtime: "cloud" as const,
    };

    await expect(state.beforeStart({
      ...start,
      canonicalCompletedTurnId: "turn_2",
    })).resolves.toEqual({
      command: start,
      semanticRecoveryReason: "native-state-stale",
    });
    await expect(readFile(
      `${binding.nativePath}/sessions/old.jsonl`,
      "utf8",
    )).rejects.toThrow();
  });

  it("requests semantic recovery instead of using a stale ACP id when native files disappeared", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-missing-workspace-"));
    roots.push(workspace);
    const sessionId = `session_missing_${Date.now()}`;
    const binding = bindAcpAgentState({
      sessionId,
      agent: { id: "pi-acp", command: "pi-acp" },
    });
    roots.push(join(
      tmpdir(),
      "openma-harness-state/acp",
      encodeURIComponent(sessionId),
    ));
    const state = createAcpNativeSessionState({
      io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
      resolveSession: async () => ({ agent: { id: "pi-acp", command: "pi-acp" } }),
    });
    const start = {
      type: "session.start" as const,
      sessionId,
      agentId: "pi-acp",
      runtime: "cloud" as const,
      acpSessionId: "stale_acp",
    };

    await expect(state.beforeStart(start)).resolves.toEqual({
      command: {
        ...start,
        acpSessionId: undefined,
      },
      semanticRecoveryReason: "native-state-missing",
    });
  });

  it("maps protocol workspace paths while leaving unrelated paths untouched", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-state-io-"));
    const external = await mkdtemp(join(tmpdir(), "oma-acp-state-external-"));
    roots.push(workspace, external);
    const io = createNodeAcpHarnessStateIo({ workspacePath: workspace });

    await io.writeFile("/workspace/nested/state.txt", "workspace");
    await io.writeFileBytes("/workspace/nested/asset.bin", Uint8Array.of(0, 255, 1));
    await io.writeFile(join(external, "state.txt"), "external");
    await expect(io.readFile("/workspace/nested/state.txt")).resolves.toBe("workspace");
    await expect(readFile(join(workspace, "nested/asset.bin"))).resolves.toEqual(
      Buffer.from([0, 255, 1]),
    );
    await expect(io.readFile(join(external, "state.txt"))).resolves.toBe("external");
    await expect(io.readFile("/workspace")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(io.exec("pwd")).resolves.toMatch(/oma-acp-state-io-/);

    expect(createNodeAcpHarnessStateIo()).toBeDefined();
  });

  it("passes every optional ACP start option through and supports ACP-only profiles", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-options-workspace-"));
    roots.push(workspace);
    const state = createAcpNativeSessionState({
      io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
      resolveSession: async () => ({
        agent: { id: "aider", command: "aider-acp" },
        restart: { maxAttempts: 3, backoffMs: 10 },
        idleTimeoutMs: 111,
        perTurnTimeoutMs: 222,
        mcpServers: [{ name: "docs", command: "docs-mcp" }],
        additionalDirectories: ["/workspace/shared"],
        sessionRequestMeta: { trace: "trace_1" },
      } as never),
    });
    const start = {
      type: "session.start" as const,
      sessionId: `session_options_${Date.now()}`,
      agentId: "aider",
      runtime: "cloud" as const,
      acpSessionId: "acp_options",
    };

    await expect(state.beforeStart(start)).resolves.toEqual({ command: start });
    await expect(state.prepare(start)).resolves.toMatchObject({
      agent: { command: "aider-acp" },
      restart: { maxAttempts: 3, backoffMs: 10 },
      idleTimeoutMs: 111,
      perTurnTimeoutMs: 222,
      mcpServers: [{ name: "docs", command: "docs-mcp" }],
      additionalDirectories: ["/workspace/shared"],
      sessionRequestMeta: { trace: "trace_1" },
      resumeAcpSessionId: "acp_options",
    });
    await state.release({ sessionId: start.sessionId, reason: "shutdown" });
  });

  it("omits optional ACP start options when they are absent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-empty-options-"));
    roots.push(workspace);
    const state = createAcpNativeSessionState({
      io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
      resolveSession: async () => ({ agent: { id: "aider", command: "aider-acp" } }),
    });
    const start = {
      type: "session.start" as const,
      sessionId: `session_empty_options_${Date.now()}`,
      agentId: "aider",
      runtime: "cloud" as const,
    };

    await state.beforeStart(start);
    await expect(state.prepare(start)).resolves.toEqual({
      agent: expect.objectContaining({ command: "aider-acp" }),
    });
    await state.release({ sessionId: start.sessionId, reason: "shutdown" });
  });

  it.each([
    { version: 2, adapter_id: "codex", acp_session_id: "old" },
    { version: 1, adapter_id: "pi", acp_session_id: "old" },
    { version: 1, adapter_id: "codex", acp_session_id: 123 },
    { version: 1, adapter_id: "codex", acp_session_id: "" },
    {
      version: 1,
      adapter_id: "codex",
      acp_session_id: "old",
      last_completed_turn_id: 123,
    },
    {
      version: 1,
      adapter_id: "codex",
      acp_session_id: "old",
      last_completed_turn_id: "",
    },
  ])("ignores malformed or incompatible native checkpoint %j", async (checkpoint) => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-invalid-checkpoint-"));
    roots.push(workspace);
    const sessionId = `session_invalid_${Date.now()}_${String(checkpoint.acp_session_id)}`;
    const binding = bindAcpAgentState({
      sessionId,
      agent: { id: "codex-acp", command: "codex-acp" },
    });
    const io = createNodeAcpHarnessStateIo({ workspacePath: workspace });
    await io.writeFile(binding.checkpointPath, `${JSON.stringify(checkpoint)}\n`);
    const state = createAcpNativeSessionState({
      io,
      resolveSession: async () => ({ agent: { id: "codex-acp", command: "codex-acp" } }),
    });
    const start = {
      type: "session.start" as const,
      sessionId,
      agentId: "codex-acp",
      runtime: "cloud" as const,
    };

    await expect(state.beforeStart(start)).resolves.toEqual({ command: start });
  });

  it("fails closed when lifecycle methods run without preparation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-acp-unprepared-"));
    roots.push(workspace);
    const state = createAcpNativeSessionState({
      io: createNodeAcpHarnessStateIo({ workspacePath: workspace }),
      resolveSession: async () => ({ agent: { id: "codex-acp", command: "codex-acp" } }),
    });
    const start = {
      type: "session.start" as const,
      sessionId: "session_unprepared",
      agentId: "codex-acp",
      runtime: "cloud" as const,
    };

    await expect(state.prepare(start)).rejects.toThrow("was not prepared before start");
    await expect(state.onReady({
      type: "session.ready",
      sessionId: start.sessionId,
      acpSessionId: "acp_unprepared",
    })).rejects.toThrow("is not active");

    await state.beforeStart(start);
    await expect(state.checkpoint({ sessionId: start.sessionId })).rejects.toThrow(
      "is not ready",
    );
    await state.onReady({
      type: "session.ready",
      sessionId: start.sessionId,
      acpSessionId: "acp_prepared",
    });
    await state.checkpoint({ sessionId: start.sessionId });
    await state.release({ sessionId: start.sessionId, reason: "destroy" });
  });
});

it("resident native validity checks live artifact paths, not only the durable checkpoint copy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oma-resident-native-"));
  const sessionId = `resident-${crypto.randomUUID()}`;
  const agent = {id:"claude-acp", command:"claude-acp"};
  const binding = bindAcpAgentState({sessionId,agent});
  const state = createAcpNativeSessionState({io:createNodeAcpHarnessStateIo({workspacePath:workspace}),resolveSession:async()=>({agent})});
  try {
    await state.beforeStart({type:"session.start",sessionId,agentId:"agent",runtime:"cloud"});
    const artifact = binding.sessionArtifacts.find(item=>item.requiredForResume)!;
    const durable = join(workspace, artifact.path.slice("/workspace/".length));
    await mkdir(durable,{recursive:true});
    await writeFile(join(durable,"retained.json"),"durable checkpoint exists");
    expect(await state.hasRuntimeState(sessionId)).toBe(false);
    await mkdir(artifact.runtimePath,{recursive:true});
    await writeFile(join(artifact.runtimePath,"current.json"),"actual native artifact");
    expect(await state.hasRuntimeState(sessionId)).toBe(true);
    await rm(artifact.runtimePath,{recursive:true,force:true});
    expect(await state.hasRuntimeState(sessionId)).toBe(false);
    expect(await readFile(join(durable,"retained.json"),"utf8")).toBe("durable checkpoint exists");
  } finally {
    await rm(workspace,{recursive:true,force:true});
    await rm(join(tmpdir(),"openma-harness-state/acp",sessionId),{recursive:true,force:true});
  }
});

it.each([1024, 2048, 32000])("restarts a missing resident native session once before each new root, preserving identical historical text and bounded recovery (%i characters)", async maximum => {
  const { createRecoverableNativeSession } = await import("../src/node");
  const workspace = await mkdtemp(join(tmpdir(), "oma-recovery-prompt-"));
  const sessionId = crypto.randomUUID();
  const state = createAcpNativeSessionState({io:createNodeAcpHarnessStateIo({workspacePath:workspace}),resolveSession:async()=>({agent:{id:"claude-acp",command:"claude-acp"}})});
  const events: string[] = [];
  const prompts: unknown[] = [];
  let generation = 0;
  const session = () => ({acpSessionId:`native-${generation}`,configOptions:[],async dispose(){events.push(`dispose-${generation}`);},async *prompt(text:unknown){prompts.push(text);yield {type:"done"};}});
  const first = session();
  const native = createRecoverableNativeSession({session:first as never,sessionOptions:{agent:{command:"claude-acp"}},runtime:{async start(options:Record<string,unknown>){expect(options.resumeAcpSessionId).toBeUndefined();events.push(`start-${++generation}`);return session();}} as never,state,sessionId:()=>sessionId,nativeReady:()=>{events.push("ready");},instructions:()=>"Pinned",history:async()=>[...(generation < 2 ? [] : [{type:"agent.message" as const,content:[{type:"text" as const,text:"old-".repeat(maximum)}]}]),{id:"old",type:"user.message",content:[{type:"text",text:"same"}]},{type:"agent.message",content:[{type:"text",text:"completed result"}]}],maxCharacters:maximum});
  try {
    await state.beforeStart({type:"session.start",sessionId,agentId:"agent",runtime:"cloud"});
    await state.onReady({type:"session.ready",sessionId,acpSessionId:"native-0"});
    await native.beforeRootPrompt();
    for await (const _ of native.session.prompt("first")) { /* drain */ }
    expect(prompts).toEqual(["<openma-platform>\nPinned\n</openma-platform>\n\nfirst"]);
    await native.beforeRootPrompt();
    for await (const _ of native.session.prompt("same")) { /* drain */ }
    expect(events).toEqual(["dispose-0","start-1","ready"]);
    expect(String(prompts[1])).toContain("User: same");
    expect(String(prompts[1])).toContain("Assistant: completed result");
    expect(String(prompts[1])).toContain("Current request:\nsame\n</openma-recovery>");
    // A continuation uses the same native process and carries no recovery wrapper.
    for await (const _ of native.session.prompt("continuation")) { /* drain */ }
    expect(prompts[2]).toBe("continuation");
    expect(events).toHaveLength(3);
    await native.beforeRootPrompt();
    for await (const _ of native.session.prompt("head-" + "x".repeat(maximum * 4) + "-tail")) { /* drain */ }
    expect(String(prompts[3]).length).toBeLessThanOrEqual(maximum);
    expect(String(prompts[3])).toContain("Assistant: completed result");
    expect(String(prompts[3])).toContain("earlier history omitted");
    expect(String(prompts[3])).toContain("[current request truncated]");
    expect(String(prompts[3])).toContain("Current request:\nhead-");
    expect(String(prompts[3])).toMatch(/-tail\n<\/openma-recovery>$/);
    expect(events).toEqual(["dispose-0","start-1","ready","dispose-1","start-2","ready"]);
    expect(String(prompts[3])).toContain("</openma-recovery>");
  } finally {
    await rm(workspace,{recursive:true,force:true});
    await rm(join(tmpdir(),"openma-harness-state/acp",sessionId),{recursive:true,force:true});
  }
});
